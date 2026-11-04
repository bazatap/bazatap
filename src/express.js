import { createRecorder } from "./recorder.js";

export { operationFor, failureFor, parseAgent } from "./recorder.js";

/**
 * Express/Connect middleware. Mount it after the body parser so `req.body` can
 * be recorded, and before the routes:
 *
 *   app.use(express.json());
 *   app.use(bazatap({ logPath: ".bazatap/events.jsonl" }));
 *
 * It never blocks or rewrites the request, and a broken log cannot break the
 * response.
 *
 * @param {{
 *   logPath?: string,
 *   bodies?: boolean,
 *   maxBodyBytes?: number,
 * }} [options]
 */
export function bazatap(options = {}) {
  const recorder = createRecorder(options);
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;

  /** @type {any} */
  const middleware = (req, res, next) => {
    const started = process.hrtime.bigint();
    let resBody = "";
    let recorded = false;

    const capture = (chunk) => {
      if (options.bodies === false || chunk === undefined) return;
      if (resBody.length >= maxBodyBytes) return;
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      resBody += text.slice(0, maxBodyBytes - resBody.length);
    };

    const write = res.write.bind(res);
    const end = res.end.bind(res);

    res.write = (chunk, ...rest) => {
      capture(chunk);
      return write(chunk, ...rest);
    };

    res.end = (chunk, ...rest) => {
      if (typeof chunk !== "function") capture(chunk);
      if (!recorded) {
        recorded = true;
        recorder.record({
          method: req.method ?? "GET",
          path: (req.originalUrl ?? req.url ?? "/").split("?")[0],
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          headers: req.headers,
          reqBody: requestBody(req, options.bodies !== false),
          resBody,
        });
      }
      return end(chunk, ...rest);
    };

    next();
  };

  middleware.summary = () => recorder.summary();
  middleware.close = () => recorder.close();
  return middleware;
}

/** @param {any} req @param {boolean} enabled */
function requestBody(req, enabled) {
  if (!enabled || req.body === undefined) return "";
  if (typeof req.body === "string") return req.body;
  try {
    return JSON.stringify(req.body);
  } catch {
    return "";
  }
}

export default bazatap;
