#!/usr/bin/env node
/**
 * Crawl a list of domains and write one JSONL row per domain.
 * Usage: node scripts/crawl.mjs [seeds.txt] [--out=DIR] [--limit=N]
 *        [--concurrency=N] [--timeout=MS] [--schemas]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "../src/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-") && !a.includes("=")));
const options = new Map(
  args
    .filter((a) => a.startsWith("-") && a.includes("="))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i), a.slice(i + 1)];
    }),
);
const positional = args.filter((a) => !a.startsWith("-"));

const seedsPath = positional[0] ?? join(here, "seeds.txt");
const date = localDate();
const outDir = options.get("--out") ?? join(here, "..", "out", date);
const limit = Number(options.get("--limit") ?? Infinity);
const concurrency = Number(options.get("--concurrency") ?? 6);
const timeout = Number(options.get("--timeout") ?? 10_000);
const schemas = flags.has("--schemas");
const follow = flags.has("--follow");

// Profiles share schema URLs, so cache the bytes and dedupe in-flight fetches.
// Responses are buffered: a schema is a few KB, and this keeps clones and
// aborted requests out of the picture.
const responseCache = new Map();
const inFlight = new Map();

async function cachedFetch(url, init) {
  const key = typeof url === "string" ? url : url.url;
  if (!responseCache.has(key)) {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url, init);
        const body = await response.text();
        responseCache.set(key, {
          status: response.status,
          headers: [...response.headers],
          body,
        });
      })();
      inFlight.set(key, pending);
      pending.finally(() => inFlight.delete(key)).catch(() => {});
    }
    await pending;
  }
  const hit = responseCache.get(key);
  return new Response(hit.body, { status: hit.status, headers: hit.headers });
}

const seeds = readFileSync(seedsPath, "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean)
  .map((line) => {
    const [domain, category] = line.split(/[\s,]+/);
    return { domain, category: category ?? "uncategorised" };
  })
  .slice(0, limit);

if (seeds.length === 0) {
  console.error(`No seeds in ${seedsPath}`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const resultsPath = join(outDir, "results.jsonl");
const metaPath = join(outDir, "meta.json");
console.log(
  `crawling ${seeds.length} domains (concurrency ${concurrency}, schemas ${schemas ? "on" : "off"})`,
);

const rows = [];
let cursor = 0;
let done = 0;
const workers = Array.from({ length: Math.min(concurrency, seeds.length) }, async () => {
  while (cursor < seeds.length) {
    const seed = seeds[cursor++];
    const row = await crawlOne(seed);
    rows.push(row);
    done += 1;
    if (done % 10 === 0) console.log(`  ${done}/${seeds.length}`);
  }
});

await Promise.all(workers);

rows.sort((a, b) => a.domain.localeCompare(b.domain));
writeFileSync(resultsPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      crawledAt: new Date().toISOString(),
      crawledOn: date,
      seeds: seedsPath,
      count: rows.length,
      schemas,
      follow,
      timeout,
      tool: "bazatap",
    },
    null,
    2,
  ) + "\n",
);

const served = rows.filter((row) => row.hasProfile).length;
console.log(`\n${served}/${rows.length} served a profile`);
console.log(`results: ${resultsPath}`);
console.log(`report:  node scripts/report.mjs --from=${resultsPath}`);

/** Local calendar date, so a run at 09:00 local does not land on yesterday's folder. */
function localDate() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/** @param {{domain: string, category: string}} seed */
async function crawlOne(seed) {
  let result = await scan(seed.domain, {
    timeout,
    fetchSchemas: schemas,
    fetchImpl: cachedFetch,
  });
  let redirectedFrom;

  if (follow && result.httpStatus >= 300 && result.httpStatus < 400) {
    const finalUrl = await resolveFinalUrl(result.url);
    if (finalUrl && finalUrl !== result.url) {
      redirectedFrom = result.url;
      result = await scan(finalUrl, {
        timeout,
        fetchSchemas: schemas,
        fetchImpl: cachedFetch,
      });
    }
  }

  return {
    domain: seed.domain,
    category: seed.category,
    url: result.url,
    redirectedFrom,
    httpStatus: result.httpStatus ?? 0,
    hasProfile: result.httpStatus === 200 && Boolean(result.summary?.version),
    grade: result.grade,
    score: result.score,
    version: result.summary?.version ?? null,
    keys: result.summary?.keys ?? 0,
    capabilityNames: result.summary?.capabilityNames ?? [],
    transports: result.summary?.transports ?? [],
    findings: result.findings.map(({ code, severity }) => ({ code, severity })),
    fatal: result.findings.find((f) => f.severity === "fatal")?.code ?? null,
  };
}

/** Follow redirects to learn the canonical profile URL. @param {string} url */
async function resolveFinalUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { accept: "application/json", "user-agent": "bazatap/0.2.0" },
      signal: AbortSignal.timeout(timeout),
    });
    return response.url || null;
  } catch {
    return null;
  }
}
