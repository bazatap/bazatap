import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared recording and classification used by the proxy and the middleware.
 * One recorder owns one state bucket and, optionally, one JSONL log.
 */

/**
 * @param {{ logPath?: string, bodies?: boolean, maxBodyBytes?: number }} [options]
 */
export function createRecorder(options = {}) {
  const bodies = options.bodies !== false;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const state = createState();
  const log = openLog(options.logPath);

  return {
    /**
     * @param {{
     *   method: string,
     *   path: string,
     *   status: number,
     *   durationMs: number,
     *   headers?: Record<string, unknown>,
     *   reqBody?: string,
     *   resBody?: string,
     *   upstream?: string,
     *   transportError?: string,
     * }} entry
     */
    record(entry) {
      const resBody = bodies ? (entry.resBody ?? "") : "";
      const reqBody = bodies ? (entry.reqBody ?? "") : "";
      const parsed = parseJson(resBody);
      const parsedRequest = parseJson(reqBody);
      const agent = parseAgent(header(entry.headers, "ucp-agent"));
      const path = entry.path;
      const operation = operationFor(entry.method, path);
      const ucp =
        Boolean(header(entry.headers, "ucp-agent")) ||
        path.startsWith("/.well-known/ucp") ||
        path.includes("/ucp/") ||
        hasUcpMarker(parsed);

      const failure =
        entry.transportError !== undefined
          ? "upstream_unreachable"
          : failureFor(entry.status, resBody);

      state.requests += 1;
      if (ucp) state.ucpRequests += 1;
      state.operations[operation] = (state.operations[operation] ?? 0) + 1;
      if (agent) state.agents[agent] = (state.agents[agent] ?? 0) + 1;
      if (failure) state.failures[failure] = (state.failures[failure] ?? 0) + 1;
      if (operation === "checkout.create") state.attempts += 1;
      if (operation === "checkout.create" && entry.status >= 200 && entry.status < 300) {
        state.created += 1;
      }
      if (operation === "checkout.complete" && entry.status >= 200 && entry.status < 300) {
        state.completions += 1;
      }

      const row = {
        ts: new Date().toISOString(),
        method: entry.method,
        path,
        status: entry.status,
        durationMs: Math.round(entry.durationMs * 100) / 100,
        agent,
        ucp,
        operation,
        failure,
        errorCode: errorCodeOf(parsed),
        checkoutId: checkoutIdFor(path, parsed, parsedRequest),
        requestBytes: reqBody.length,
        responseBytes: resBody.length,
      };
      state.recent.unshift(row);
      if (state.recent.length > 50) state.recent.pop();

      if (log) {
        try {
          log.write(
            `${JSON.stringify({
              ...row,
              upstream: entry.upstream,
              requestBody: truncate(reqBody, maxBodyBytes),
              responseBody: truncate(resBody, maxBodyBytes),
            })}\n`,
          );
        } catch {
          // A broken log must never break the request.
        }
      }
    },

    summary: () => summarize(state),

    close() {
      log?.end();
    },
  };
}

export function createState() {
  return {
    startedAt: new Date().toISOString(),
    requests: 0,
    ucpRequests: 0,
    operations: /** @type {Record<string, number>} */ ({}),
    failures: /** @type {Record<string, number>} */ ({}),
    agents: /** @type {Record<string, number>} */ ({}),
    attempts: 0,
    created: 0,
    completions: 0,
    recent: /** @type {any[]} */ ([]),
  };
}

/** @param {any} state */
export function summarize(state) {
  return {
    startedAt: state.startedAt,
    requests: state.requests,
    ucpRequests: state.ucpRequests,
    operations: state.operations,
    checkout: {
      attempts: state.attempts,
      created: state.created,
      completions: state.completions,
      completionRate: state.created ? state.completions / state.created : null,
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

/** @param {string|undefined} value */
export function parseAgent(value) {
  if (!value) return undefined;
  const match = /profile="([^"]+)"/.exec(value);
  const url = match?.[1] ?? value;
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

/** @param {Record<string, unknown>|undefined} headers @param {string} name */
function header(headers, name) {
  if (!headers) return undefined;
  const value = headers[name];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

/** @param {string|undefined} logPath */
function openLog(logPath) {
  if (!logPath) return null;
  mkdirSync(dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: "a" });
}

/** @param {string} value @param {number} limit */
function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** @param {any} body */
function hasUcpMarker(body) {
  return typeof body === "object" && body !== null && "ucp" in body;
}

/** @param {any} body */
function errorCodeOf(body) {
  if (typeof body !== "object" || body === null) return undefined;
  const value =
    body.error?.code ?? body.error?.type ?? body.code ?? body.type ?? body.error;
  return typeof value === "string" ? value.slice(0, 120) : undefined;
}

/** @param {string} path @param {any} response @param {any} request */
function checkoutIdFor(path, response, request) {
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
