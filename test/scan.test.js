import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveProfileUrl, scan } from "../src/scan.js";
import { grade } from "../src/grade.js";

const PROFILE = {
  ucp: {
    version: "2026-08-25",
    services: {
      "dev.ucp.shopping": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/overview/",
          transport: "rest",
          schema: "https://ucp.dev/2026-08-25/services/shopping/rest.openapi.json",
          endpoint: "https://shop.example.com/ucp",
        },
      ],
    },
    capabilities: {
      "dev.ucp.shopping.checkout": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/shopping/checkout/",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json",
        },
      ],
    },
    payment_handlers: {},
  },
  keys: [{ kty: "EC", crv: "P-256", x: "abc", y: "def", alg: "ES256" }],
};

/** @param {(req: any, res: any) => void} handler */
async function withServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("resolveProfileUrl appends the well-known path to a bare domain", () => {
  assert.equal(resolveProfileUrl("allbirds.com"), "https://allbirds.com/.well-known/ucp");
  assert.equal(
    resolveProfileUrl("https://shop.example.com/.well-known/ucp"),
    "https://shop.example.com/.well-known/ucp",
  );
  assert.equal(resolveProfileUrl("example.com/"), "https://example.com/.well-known/ucp");
});

test("scan reads a local profile and grades it", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PROFILE));
  });
  try {
    const result = await scan(`${server.url}/.well-known/ucp`, { fetchSchemas: false });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.summary.capabilities, 1);
    assert.equal(result.grade, "A");
    assert.ok(result.findings.every((f) => f.severity !== "error"));
    assert.ok(result.findings.some((f) => f.code === "INSECURE_PROFILE"));
  } finally {
    await server.close();
  }
});

test("scan reports a non-200 profile as fatal", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(404).end("nope");
  });
  try {
    const result = await scan(`${server.url}/.well-known/ucp`, { fetchSchemas: false });
    assert.equal(result.grade, "F");
    assert.equal(result.findings[0].code, "PROFILE_STATUS");
  } finally {
    await server.close();
  }
});

test("scan reports a redirect as fatal", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(307, { location: "https://example.com/.well-known/ucp" }).end();
  });
  try {
    const result = await scan(`${server.url}/.well-known/ucp`, { fetchSchemas: false });
    assert.equal(result.findings[0].code, "PROFILE_REDIRECT");
    assert.equal(result.grade, "F");
  } finally {
    await server.close();
  }
});

test("scan reports non-JSON as fatal", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>hi</h1>");
  });
  try {
    const result = await scan(`${server.url}/.well-known/ucp`, { fetchSchemas: false });
    assert.equal(result.findings[0].code, "PROFILE_NOT_JSON");
  } finally {
    await server.close();
  }
});

test("scan reports an unreachable host without throwing", async () => {
  const result = await scan("http://127.0.0.1:1/.well-known/ucp", {
    fetchSchemas: false,
    timeout: 1000,
  });
  assert.equal(result.findings[0].code, "PROFILE_UNREACHABLE");
  assert.equal(result.grade, "F");
});

test("grade collapses to F on a fatal finding", () => {
  const { score, grade: letter } = grade([
    { code: "X", severity: "fatal", message: "" },
  ]);
  assert.equal(score, 0);
  assert.equal(letter, "F");
});

test("grade deducts for errors and warnings", () => {
  const { grade: letter } = grade([
    { code: "X", severity: "error", message: "" },
    { code: "Y", severity: "warn", message: "" },
  ]);
  assert.equal(letter, "B");
});
