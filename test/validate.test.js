import test from "node:test";
import assert from "node:assert/strict";
import { validateProfile } from "../src/validate.js";

/** @param {any} overrides */
function profile(overrides = {}) {
  return {
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
      ...overrides.ucp,
    },
    keys: [{ kty: "EC", crv: "P-256", x: "abc", y: "def", alg: "ES256" }],
    ...overrides,
  };
}

const codes = (findings) => findings.map((f) => f.code);

test("valid profile has no findings", () => {
  const { findings, summary } = validateProfile(profile());
  assert.deepEqual(findings, []);
  assert.equal(summary.version, "2026-08-25");
  assert.equal(summary.capabilities, 1);
  assert.equal(summary.keys, 1);
});

test("missing ucp is fatal", () => {
  const { findings } = validateProfile({ keys: [] });
  assert.equal(findings[0].severity, "fatal");
  assert.equal(findings[0].code, "NO_UCP");
});

test("non-object profile is fatal", () => {
  const { findings } = validateProfile("nope");
  assert.equal(findings[0].code, "PROFILE_NOT_OBJECT");
});

test("bad version is fatal", () => {
  const { findings } = validateProfile(profile({ ucp: { version: "v1" } }));
  assert.ok(codes(findings).includes("BAD_VERSION"));
  assert.equal(findings[0].severity, "fatal");
});

test("missing payment_handlers is an error", () => {
  const { findings } = validateProfile(profile({ ucp: { payment_handlers: undefined } }));
  assert.ok(codes(findings).includes("NO_HANDLERS"));
});

test("unknown transport is an error", () => {
  const { findings } = validateProfile(
    profile({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            { version: "2026-08-25", spec: "https://ucp.dev/x", transport: "grpc" },
          ],
        },
      },
    }),
  );
  assert.ok(codes(findings).includes("BAD_TRANSPORT"));
});

test("rest service without schema is an error", () => {
  const { findings } = validateProfile(
    profile({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            { version: "2026-08-25", spec: "https://ucp.dev/x", transport: "rest" },
          ],
        },
      },
    }),
  );
  assert.ok(codes(findings).includes("NO_SERVICE_SCHEMA"));
});

test("extension with an undeclared parent warns", () => {
  const { findings } = validateProfile(
    profile({
      ucp: {
        capabilities: {
          "dev.ucp.shopping.checkout": [
            {
              version: "2026-08-25",
              spec: "https://ucp.dev/x",
              schema: "https://ucp.dev/s.json",
            },
          ],
          "dev.ucp.shopping.fulfillment": [
            {
              version: "2026-08-25",
              spec: "https://ucp.dev/y",
              schema: "https://ucp.dev/f.json",
              extends: "dev.ucp.shopping.cart",
            },
          ],
        },
      },
    }),
  );
  assert.ok(codes(findings).includes("ORPHAN_EXTENSION"));
});

test("missing keys warns but does not error", () => {
  const { findings } = validateProfile(profile({ keys: undefined }));
  const finding = findings.find((f) => f.code === "NO_KEYS");
  assert.equal(finding?.severity, "warn");
});

test("key without kty is an error", () => {
  const { findings } = validateProfile(profile({ keys: [{ alg: "ES256" }] }));
  assert.ok(codes(findings).includes("BAD_KEY"));
});

test("non-https endpoint is an error", () => {
  const { findings } = validateProfile(
    profile({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            {
              version: "2026-08-25",
              spec: "https://ucp.dev/x",
              transport: "rest",
              schema: "https://ucp.dev/s.json",
              endpoint: "http://shop.example.com/ucp",
            },
          ],
        },
      },
    }),
  );
  assert.ok(codes(findings).includes("INSECURE_ENDPOINT"));
});
