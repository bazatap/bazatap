import test from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, summarize } from "../src/report-data.js";

const rows = [
  {
    domain: "a.example",
    category: "retail",
    httpStatus: 200,
    hasProfile: true,
    grade: "A",
    score: 95,
    version: "2026-08-25",
    keys: 2,
    capabilityNames: ["dev.ucp.shopping.checkout", "dev.shopify.shopping.declared_fields"],
    transports: ["mcp"],
    findings: [{ code: "NO_KEYS", severity: "warn" }],
  },
  {
    domain: "b.example",
    category: "retail",
    httpStatus: 200,
    hasProfile: true,
    grade: "B",
    score: 80,
    version: "2026-08-25",
    keys: 0,
    capabilityNames: ["dev.ucp.shopping.checkout"],
    transports: ["rest"],
    findings: [{ code: "NO_KEYS", severity: "warn" }],
  },
  {
    domain: "c.example",
    category: "hospitality",
    httpStatus: 404,
    hasProfile: false,
    grade: "F",
    score: 0,
    version: null,
    keys: 0,
    capabilityNames: [],
    transports: [],
    findings: [{ code: "PROFILE_STATUS", severity: "fatal" }],
  },
];

test("summarize counts served, signed and platform mix", () => {
  const summary = summarize(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.served, 2);
  assert.equal(summary.signed, 1);
  assert.equal(summary.signedPct, 0.5);
  assert.equal(summary.medianScore, 87.5);
  assert.deepEqual(summary.platforms, [
    { name: "other", count: 1 },
    { name: "shopify", count: 1 },
  ]);
  assert.deepEqual(summary.grades, { A: 1, B: 1 });
});

test("summarize segments by category", () => {
  const summary = summarize(rows);
  assert.equal(summary.categories.retail.served, 2);
  assert.equal(summary.categories.retail.signedPct, 0.5);
  assert.equal(summary.categories.hospitality.served, 0);
  assert.equal(summary.categories.hospitality.topFinding, "PROFILE_STATUS");
});

test("summarize counts findings across all rows", () => {
  const summary = summarize(rows);
  assert.deepEqual(summary.findings, [
    { name: "NO_KEYS", count: 2 },
    { name: "PROFILE_STATUS", count: 1 },
  ]);
  assert.deepEqual(summary.statuses, [
    { name: "200", count: 2 },
    { name: "404", count: 1 },
  ]);
});

test("detectPlatform reads the vendor namespace", () => {
  assert.equal(
    detectPlatform({ capabilityNames: ["dev.bigcommerce.catalog"] }),
    "bigcommerce",
  );
  assert.equal(
    detectPlatform({ capabilityNames: ["dev.ucp.shopping.checkout"], transports: ["rest"] }),
    "other",
  );
  assert.equal(detectPlatform({ capabilityNames: [], transports: [] }), "unknown");
});
