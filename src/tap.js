import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRecorder } from "./recorder.js";
import { renderDashboard } from "./ui.js";

export { operationFor, failureFor, parseAgent } from "./recorder.js";

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

  const recorder = createRecorder({
    logPath: options.logPath,
    bodies,
    maxBodyBytes,
  });

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
        .end(JSON.stringify(recorder.summary()));
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
          recorder.record({
            method: req.method ?? "GET",
            path: (req.url ?? "/").split("?")[0],
            status: proxyRes.statusCode ?? 502,
            durationMs: Number(process.hrtime.bigint() - started) / 1e6,
            headers: req.headers,
            reqBody: bodies ? Buffer.concat(reqChunks).toString("utf8") : "",
            resBody: bodies ? Buffer.concat(resChunks).toString("utf8") : "",
            upstream: target.toString(),
          });
          res.end();
        });
      },
    );

    proxyReq.on("error", (err) => {
      recorder.record({
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0],
        status: 502,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        headers: req.headers,
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
    summary: () => recorder.summary(),
    close: () =>
      new Promise((resolve) => {
        recorder.close();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
