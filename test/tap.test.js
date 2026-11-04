import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTap, operationFor, parseAgent, failureFor } from "../src/tap.js";

const PROFILE = { ucp: { version: "2026-08-25", services: {}, capabilities: {}, payment_handlers: {} } };

async function upstreamServer() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/.well-known/ucp") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(PROFILE));
    }
    if (req.method === "POST" && req.url === "/checkout-sessions") {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "chk_1", echoed: body }));
    }
    if (req.method === "POST" && req.url === "/checkout-sessions/chk_1/complete") {
      res.writeHead(409, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "idempotency_conflict" } }));
    }
    if (req.url === "/orders/1") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "order_1" }));
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {any} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test("operationFor classifies the checkout lifecycle", () => {
  assert.equal(operationFor("GET", "/.well-known/ucp"), "discovery");
  assert.equal(operationFor("POST", "/checkout-sessions"), "checkout.create");
  assert.equal(operationFor("GET", "/checkout-sessions/chk_1"), "checkout.read");
  assert.equal(operationFor("PATCH", "/checkout-sessions/chk_1"), "checkout.update");
  assert.equal(operationFor("POST", "/checkout-sessions/chk_1/complete"), "checkout.complete");
  assert.equal(operationFor("POST", "/carts/c1/items"), "cart");
  assert.equal(operationFor("GET", "/orders/1"), "order");
  assert.equal(operationFor("GET", "/products"), "unknown");
  assert.equal(operationFor("POST", "/checkout-sessions/"), "checkout.create");
});

test("parseAgent extracts the profile host", () => {
  assert.equal(parseAgent('profile="https://agent.example/profile.json"'), "agent.example");
  assert.equal(parseAgent("https://gemini.google.com/profile.json"), "gemini.google.com");
  assert.equal(parseAgent(undefined), undefined);
  assert.equal(parseAgent("not a url"), "not a url");
});

test("failureFor maps status codes to agent-facing reasons", () => {
  assert.equal(failureFor(200, ""), null);
  assert.equal(failureFor(409, '{"error":{"code":"idempotency_conflict"}}'), "idempotency_conflict");
  assert.equal(failureFor(409, '{"error":"out of stock"}'), "out_of_stock");
  assert.equal(failureFor(402, ""), "payment_declined");
  assert.equal(failureFor(401, ""), "auth_rejected");
  assert.equal(failureFor(404, ""), "not_found");
  assert.equal(failureFor(422, ""), "invalid_request");
  assert.equal(failureFor(500, ""), "server_error");
  assert.equal(failureFor(418, ""), "http_418");
});

test("tap proxies traffic, records it and exposes a summary", async () => {
  const upstream = await upstreamServer();
  const dir = mkdtempSync(join(tmpdir(), "bazatap-"));
  const logPath = join(dir, "events.jsonl");
  const tap = await startTap({ upstream: upstream.url, port: 0, logPath, bodies: true });

  try {
    const agent = { "UCP-Agent": 'profile="https://agent.example/profile.json"' };

    const discovery = await fetch(`${tap.url}/.well-known/ucp`, { headers: agent });
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).ucp.version, "2026-08-25");

    const created = await fetch(`${tap.url}/checkout-sessions`, {
      method: "POST",
      headers: { ...agent, "content-type": "application/json" },
      body: JSON.stringify({ line_items: [] }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).id, "chk_1");

    const completed = await fetch(`${tap.url}/checkout-sessions/chk_1/complete`, {
      method: "POST",
      headers: { ...agent, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(completed.status, 409);

    const order = await fetch(`${tap.url}/orders/1`);
    assert.equal(order.status, 200);
    await order.json();

    const summary = tap.summary();
    assert.equal(summary.requests, 4);
    assert.equal(summary.ucpRequests, 3);
    assert.equal(summary.operations["checkout.create"], 1);
    assert.equal(summary.operations["checkout.complete"], 1);
    assert.deepEqual(summary.checkout, { attempts: 1, completions: 0, completionRate: 0 });
    assert.equal(summary.failures[0].reason, "idempotency_conflict");
    assert.equal(summary.agents[0].agent, "agent.example");

    const api = await fetch(`${tap.url}/__bazatap/api/summary`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).requests, 4);

    const dashboard = await fetch(`${tap.url}/__bazatap/`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /bazatap/);

    assert.ok(existsSync(logPath));
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const first = JSON.parse(lines[0]);
    assert.equal(first.operation, "discovery");
    assert.equal(first.checkoutId, undefined);
  } finally {
    await tap.close();
    await upstream.close();
  }
});

test("tap does not record bodies with bodies=false", async () => {
  const upstream = await upstreamServer();
  const dir = mkdtempSync(join(tmpdir(), "bazatap-"));
  const logPath = join(dir, "events.jsonl");
  const tap = await startTap({ upstream: upstream.url, port: 0, logPath, bodies: false });
  try {
    const res = await fetch(`${tap.url}/checkout-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "do-not-record-me" }),
    });
    await res.json();
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(entry.requestBody, "");
    assert.equal(entry.responseBody, "");
  } finally {
    await tap.close();
    await upstream.close();
  }
});

test("tap returns 502 when the upstream is down", async () => {
  const tap = await startTap({ upstream: "http://127.0.0.1:1", port: 0, bodies: false });
  try {
    const res = await fetch(`${tap.url}/.well-known/ucp`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "upstream_unreachable");
  } finally {
    await tap.close();
  }
});
