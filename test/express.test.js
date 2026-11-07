import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bazatap } from "../src/express.js";

async function withMiddleware(options, handler) {
  const middleware = bazatap(options);
  const server = createServer((req, res) => {
    middleware(req, res, () =>
      handler(req, res, () => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    middleware,
    close: () =>
      new Promise((resolve) => {
        middleware.close();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

test("middleware records the checkout lifecycle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bazatap-mw-"));
  const logPath = join(dir, "events.jsonl");
  const app = await withMiddleware(
    { logPath, bodies: true },
    (req, res, notFound) => {
      if (req.url === "/.well-known/ucp") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ucp: { version: "2026-08-25" } }));
      }
      if (req.method === "POST" && req.url === "/checkout-sessions") {
        req.body = { line_items: [] };
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ucp: {}, id: "chk_1" }));
      }
      if (req.url === "/checkout-sessions/chk_1/complete") {
        res.writeHead(422, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ucp: {}, error: { code: "invalid_request" } }));
      }
      return notFound();
    },
  );

  try {
    const agent = { "UCP-Agent": 'profile="https://gemini.google.com/p.json"' };
    await (await fetch(`${app.url}/.well-known/ucp`, { headers: agent })).json();
    await (
      await fetch(`${app.url}/checkout-sessions`, {
        method: "POST",
        headers: { ...agent, "content-type": "application/json" },
        body: JSON.stringify({ line_items: [] }),
      })
    ).json();
    const failed = await fetch(`${app.url}/checkout-sessions/chk_1/complete`, {
      method: "POST",
      headers: agent,
    });
    assert.equal(failed.status, 422);
    await failed.json();

    const summary = app.middleware.summary();
    assert.equal(summary.requests, 3);
    assert.equal(summary.ucpRequests, 3);
    assert.equal(summary.operations["checkout.create"], 1);
    assert.equal(summary.operations["checkout.complete"], 1);
    assert.deepEqual(summary.checkout, {
      attempts: 1,
      created: 1,
      completions: 0,
      completionRate: 0,
    });
    assert.equal(summary.failures[0].reason, "invalid_request");
    assert.equal(summary.agents[0].agent, "gemini.google.com");

    await app.middleware.flush();
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const checkout = JSON.parse(lines[1]);
    assert.equal(checkout.operation, "checkout.create");
    assert.match(checkout.requestBody, /line_items/);
    assert.equal(checkout.checkoutId, "chk_1");
  } finally {
    await app.close();
  }
});

test("middleware leaves bodies empty with bodies=false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bazatap-mw-"));
  const logPath = join(dir, "events.jsonl");
  const app = await withMiddleware({ logPath, bodies: false }, (req, res) => {
    req.body = { secret: "do-not-record" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ucp: {} }));
  });

  try {
    await (await fetch(`${app.url}/checkout-sessions`)).json();
    await app.middleware.flush();
    const row = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(row.requestBody, "");
    assert.equal(row.responseBody, "");
  } finally {
    await app.close();
  }
});

test("middleware passes unhandled routes through", async () => {
  const app = await withMiddleware({ bodies: false }, (req, res, notFound) =>
    notFound(),
  );
  try {
    const response = await fetch(`${app.url}/nope`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  } finally {
    await app.close();
  }
});
