import test from "node:test";
import assert from "node:assert/strict";
import { compareRows, detectPlatform, summarize } from "../src/report-data.js";

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

test("compareRows reports no changes for identical rows", () => {
  const rowsA = [
    {
      domain: "x.example",
      hasProfile: true,
      httpStatus: 200,
      version: "2026-08-25",
      keys: 0,
      findings: [{ code: "NO_KEYS" }],
      capabilityNames: ["a"],
    },
  ];
  const diff = compareRows(rowsA, structuredClone(rowsA));
  assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 0 });
});

test("compareRows reports version, key, finding and capability changes", () => {
  const before = {
    domain: "x.example",
    hasProfile: true,
    httpStatus: 200,
    version: "2026-08-25",
    keys: 0,
    findings: [{ code: "NO_KEYS" }],
    capabilityNames: ["a", "b"],
  };
  const after = {
    domain: "x.example",
    hasProfile: true,
    httpStatus: 200,
    version: "2026-11-12",
    keys: 2,
    findings: [{ code: "NO_KEYS" }, { code: "SCHEMA_STATUS" }],
    capabilityNames: ["a", "c"],
  };
  const diff = compareRows([before], [after]);
  assert.equal(diff.changed.length, 1);
  const fields = diff.changed[0].fields;
  assert.deepEqual(fields.version, ["2026-08-25", "2026-11-12"]);
  assert.deepEqual(fields.keys, [0, 2]);
  assert.deepEqual(fields.findings, { added: ["SCHEMA_STATUS"], removed: [] });
  assert.deepEqual(fields.capabilities, { added: ["c"], removed: ["b"] });
});

test("compareRows reports added, removed and lost profiles", () => {
  const before = [
    { domain: "gone.example", hasProfile: true, httpStatus: 200 },
    { domain: "lost.example", hasProfile: true, httpStatus: 200 },
  ];
  const after = [
    { domain: "lost.example", hasProfile: false, httpStatus: 404 },
    { domain: "new.example", hasProfile: true, httpStatus: 200 },
  ];
  const diff = compareRows(before, after);
  assert.deepEqual(diff.added, ["new.example"]);
  assert.deepEqual(diff.removed, ["gone.example"]);
  assert.deepEqual(diff.changed[0].domain, "lost.example");
  assert.deepEqual(diff.changed[0].fields.hasProfile, [true, false]);
});

test("compareRows ignores status flips between non-serving responses", () => {
  const before = [
    { domain: "waf.example", hasProfile: false, httpStatus: 429 },
    { domain: "gone.example", hasProfile: true, httpStatus: 200 },
  ];
  const after = [
    { domain: "waf.example", hasProfile: false, httpStatus: 404 },
    { domain: "gone.example", hasProfile: false, httpStatus: 404 },
  ];
  const diff = compareRows(before, after);
  assert.deepEqual(diff.changed.map((entry) => entry.domain), ["gone.example"]);
  assert.deepEqual(diff.changed[0].fields.hasProfile, [true, false]);
});
