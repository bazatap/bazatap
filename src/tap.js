import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderDashboard } from "./ui.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const RESERVED = "/__bazatap";

/**
 * @param {{
 *   upstream: string,
 *   port?: number,
 *   host?: string,
 *   logPath?: string,
 *   bodies?: boolean,
 *   maxBodyBytes?: number,
 * }} options
 */
export async function startTap(options) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("--upstream must be an http(s) URL");
  }
  const port = options.port ?? 6060;
  const host = options.host ?? "127.0.0.1";
  const bodies = options.bodies ?? true;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const sendRequest =
    upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const basePath = upstream.pathname.replace(/\/$/, "");

  const state = createState();
  const log = openLog(options.logPath);

  const server = createServer((req, res) => {
    if (req.url === undefined) {
      res.writeHead(400).end();
      return;
    }
    if (req.url === RESERVED) {
      res.writeHead(302, { location: `${RESERVED}/` }).end();
      return;
    }
    if (req.url === `${RESERVED}/`) {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderDashboard());
      return;
    }
    if (req.url === `${RESERVED}/api/summary`) {
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(summarize(state)));
      return;
    }

    const started = process.hrtime.bigint();
    const reqChunks = [];
    let reqCaptured = 0;

    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = upstream.host;

    const target = new URL(basePath + req.url, upstream.origin);
    const proxyReq = sendRequest(
      target,
      { method: req.method, headers },
      (proxyRes) => {
        const resChunks = [];
        let resCaptured = 0;
        const resHeaders = { ...proxyRes.headers };
        for (const name of HOP_BY_HOP) delete resHeaders[name];
        res.writeHead(proxyRes.statusCode ?? 502, resHeaders);

        proxyRes.on("data", (chunk) => {
          res.write(chunk);
          if (bodies && resCaptured < maxBodyBytes) {
            resChunks.push(chunk);
            resCaptured += chunk.length;
          }
        });
        proxyRes.on("end", () => {
          record({
            state,
            log,
            req,
            status: proxyRes.statusCode ?? 502,
            durationMs: Number(process.hrtime.bigint() - started) / 1e6,
            reqBody: bodies ? Buffer.concat(reqChunks).toString("utf8") : "",
            resBody: bodies ? Buffer.concat(resChunks).toString("utf8") : "",
            upstream: target.toString(),
          });
          res.end();
        });
      },
    );

    proxyReq.on("error", (err) => {
      record({
        state,
        log,
        req,
        status: 502,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        reqBody: bodies ? Buffer.concat(reqChunks).toString("utf8") : "",
        resBody: "",
        upstream: target.toString(),
        transportError: err.message,
      });
      if (!res.headersSent) {
        res
          .writeHead(502, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "upstream_unreachable", message: err.message }));
      } else {
        res.end();
      }
    });

    req.on("data", (chunk) => {
      proxyReq.write(chunk);
      if (bodies && reqCaptured < maxBodyBytes) {
        reqChunks.push(chunk);
        reqCaptured += chunk.length;
      }
    });
    req.on("end", () => proxyReq.end());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const url = `http://${host}:${address.port}`;

  return {
    url,
    port: address.port,
    upstream:
      upstream.origin + (upstream.pathname === "/" ? "" : upstream.pathname),
    logPath: options.logPath,
    summary: () => summarize(state),
    close: () =>
      new Promise((resolve) => {
        log?.end();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function createState() {
  return {
    startedAt: new Date().toISOString(),
    requests: 0,
    ucpRequests: 0,
    operations: /** @type {Record<string, number>} */ ({}),
    failures: /** @type {Record<string, number>} */ ({}),
    agents: /** @type {Record<string, number>} */ ({}),
    attempts: 0,
    completions: 0,
    recent: /** @type {any[]} */ ([]),
  };
}

/** @param {any} state */
function summarize(state) {
  return {
    startedAt: state.startedAt,
    requests: state.requests,
    ucpRequests: state.ucpRequests,
    operations: state.operations,
    checkout: {
      attempts: state.attempts,
      completions: state.completions,
      completionRate: state.attempts ? state.completions / state.attempts : null,
    },
    failures: Object.entries(state.failures)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    agents: Object.entries(state.agents)
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count),
    recent: state.recent,
  };
}

/**
 * @param {{
 *   state: any,
 *   log: import("node:fs").WriteStream | null,
 *   req: import("node:http").IncomingMessage,
 *   status: number,
 *   durationMs: number,
 *   reqBody: string,
 *   resBody: string,
 *   upstream: string,
 *   transportError?: string,
 * }} record
 */
function record(input) {
  const { state, req, status } = input;
  const body = parseJson(input.resBody);
  const requestBody = parseJson(input.reqBody);
  const agent = parseAgent(req.headers["ucp-agent"]);
  const path = (req.url ?? "/").split("?")[0];
  const operation = operationFor(req.method ?? "GET", path);
  const ucp =
    Boolean(req.headers["ucp-agent"]) ||
    path.startsWith("/.well-known/ucp") ||
    path.includes("/ucp/") ||
    hasUcpMarker(body);

  const failure =
    input.transportError !== undefined
      ? "upstream_unreachable"
      : failureFor(status, input.resBody);

  state.requests += 1;
  if (ucp) state.ucpRequests += 1;
  state.operations[operation] = (state.operations[operation] ?? 0) + 1;
  if (agent) state.agents[agent] = (state.agents[agent] ?? 0) + 1;
  if (failure) state.failures[failure] = (state.failures[failure] ?? 0) + 1;
  if (operation === "checkout.create") state.attempts += 1;
  if (operation === "checkout.complete" && status >= 200 && status < 300) {
    state.completions += 1;
  }

  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    path,
    status,
    durationMs: Math.round(input.durationMs * 100) / 100,
    agent,
    ucp,
    operation,
    failure,
    errorCode: errorCodeOf(body),
    checkoutId: checkoutIdFor(operation, path, body, requestBody),
    requestBytes: input.reqBody.length,
    responseBytes: input.resBody.length,
  };
  state.recent.unshift(entry);
  if (state.recent.length > 50) state.recent.pop();

  if (input.log) {
    try {
      input.log.write(
        `${JSON.stringify({
          ...entry,
          upstream: input.upstream,
          requestBody: truncate(input.reqBody),
          responseBody: truncate(input.resBody),
        })}\n`,
      );
    } catch {
      // A broken log must never break the proxy.
    }
  }
}

/**
 * @param {string|undefined} logPath
 */
function openLog(logPath) {
  if (!logPath) return null;
  mkdirSync(dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: "a" });
}

/** @param {string} value */
function truncate(value) {
  const limit = 8 * 1024;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * @param {string} method
 * @param {string} path
 */
export function operationFor(method, path) {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/.well-known/ucp" || clean.startsWith("/.well-known/ucp/")) {
    return "discovery";
  }
  if (/\/checkout-sessions\/[^/]+\/complete$/.test(clean)) return "checkout.complete";
  if (/\/checkout-sessions\/[^/]+$/.test(clean)) {
    return method === "GET" ? "checkout.read" : "checkout.update";
  }
  if (clean.endsWith("/checkout-sessions")) return "checkout.create";
  if (clean.includes("/carts")) return "cart";
  if (clean.includes("/orders")) return "order";
  if (clean.includes("/catalog")) return "catalog";
  return "unknown";
}

/**
 * @param {number} status
 * @param {string} body
 */
export function failureFor(status, body) {
  if (status < 400) return null;
  const haystack = body.toLowerCase();
  if (status === 402) return "payment_declined";
  if (status === 409 && haystack.includes("idempot")) return "idempotency_conflict";
  if (status === 409 && /stock|inventory|sold out/.test(haystack)) return "out_of_stock";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "server_error";
  return `http_${status}`;
}

/** @param {string|undefined} header */
export function parseAgent(header) {
  if (!header) return undefined;
  const match = /profile="([^"]+)"/.exec(header);
  const url = match?.[1] ?? header;
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

/** @param {any} body */
function hasUcpMarker(body) {
  return typeof body === "object" && body !== null && "ucp" in body;
}

/** @param {any} body */
function errorCodeOf(body) {
  if (typeof body !== "object" || body === null) return undefined;
  const value =
    body.error?.code ??
    body.error?.type ??
    body.code ??
    body.type ??
    body.error;
  return typeof value === "string" ? value.slice(0, 120) : undefined;
}

/**
 * @param {string} _operation
 * @param {string} path
 * @param {any} response
 * @param {any} request
 */
function checkoutIdFor(_operation, path, response, request) {
  const fromPath = /\/checkout-sessions\/([^/]+)/.exec(path)?.[1];
  if (fromPath) return fromPath;
  const value = response?.id ?? response?.checkout_id ?? request?.id;
  return typeof value === "string" ? value : undefined;
}

/** @param {string} value */
function parseJson(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
