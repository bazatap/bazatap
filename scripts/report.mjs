#!/usr/bin/env node
/**
 * Render a crawl into a markdown report.
 * Usage: node scripts/report.mjs --from=out/2026-11-04/results.jsonl
 *        node scripts/report.mjs out/2026-11-04
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { summarize } from "../src/report-data.js";

const args = process.argv.slice(2);
const options = new Map(
  args
    .filter((a) => a.startsWith("-") && a.includes("="))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i), a.slice(i + 1)];
    }),
);
const positional = args.filter((a) => !a.startsWith("-"));

const fromArg = options.get("--from") ?? positional[0];
if (!fromArg) {
  console.error("Usage: node scripts/report.mjs --from=results.jsonl");
  process.exit(2);
}
const resultsPath = resolve(
  fromArg.endsWith(".jsonl") ? fromArg : join(fromArg, "results.jsonl"),
);
if (!existsSync(resultsPath)) {
  console.error(`No results at ${resultsPath}`);
  process.exit(2);
}

const rows = readFileSync(resultsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const metaPath = join(dirname(resultsPath), "meta.json");
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
const summary = summarize(rows);
const date = meta.crawledOn ?? (meta.crawledAt ?? new Date().toISOString()).slice(0, 10);
const outPath = options.get("--out") ?? join(dirname(resultsPath), "report.md");

writeFileSync(outPath, render(summary, date, rows));
console.log(`report: ${outPath}`);

function render(summary, date, rows) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  const lines = [];
  lines.push(`# State of Agent Commerce — ${date}`);
  lines.push("");
  lines.push(
    `Crawled ${summary.total} domains. Method: ${meta.follow ? "resolve one redirect to the canonical host, then " : ""}fetch \`https://<domain>/.well-known/ucp\` without following redirects, ${meta.schemas ? "with every declared schema fetched and validated" : "profile structure only"}.`,
  );
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(
    `- **${summary.served} of ${summary.total}** domains served a valid UCP profile (${pct(summary.served, summary.total)}).`,
  );
  lines.push(
    `- **${summary.signed} of ${summary.served}** served one with signing keys (${pct(summary.signed, summary.served)}).`,
  );
  lines.push(`- Median score among served profiles: **${summary.medianScore ?? "—"}**/100.`);
  const grades = Object.entries(summary.grades)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([grade, count]) => `${grade} ${count}`)
    .join(", ");
  lines.push(`- Grades: ${grades || "—"}.`);
  const platform = summary.platforms
    .map((p) => `${p.name} ${p.count}`)
    .join(", ");
  lines.push(`- Platform mix: ${platform || "—"}.`);
  lines.push("");

  lines.push("## By category");
  lines.push("");
  lines.push("| Category | Crawled | Served | Signed | Median score | Top finding |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const [name, bucket] of Object.entries(summary.categories).sort()) {
    lines.push(
      `| ${name} | ${bucket.total} | ${bucket.served} | ${bucket.signed} (${pct(bucket.signed, bucket.served)}) | ${bucket.medianScore ?? "—"} | ${bucket.topFinding ?? "—"} |`,
    );
  }
  lines.push("");

  lines.push("## Versions");
  lines.push("");
  lines.push("| Version | Domains |");
  lines.push("| --- | --- |");
  for (const version of summary.versions) {
    lines.push(`| ${version.name} | ${version.count} |`);
  }
  lines.push("");

  lines.push("## Failure modes");
  lines.push("");
  lines.push("| Finding | Domains |");
  lines.push("| --- | --- |");
  for (const finding of summary.findings) {
    lines.push(`| ${finding.name} | ${finding.count} |`);
  }
  lines.push("");

  lines.push("## Capabilities seen");
  lines.push("");
  lines.push("| Capability | Domains |");
  lines.push("| --- | --- |");
  for (const capability of summary.capabilities.slice(0, 15)) {
    lines.push(`| \`${capability.name}\` | ${capability.count} |`);
  }
  lines.push("");

  const notServed = rows.filter((row) => row.httpStatus !== 200);
  if (notServed.length > 0) {
    lines.push("## Domains without a profile");
    lines.push("");
    lines.push("| Domain | Status | Reason |");
    lines.push("| --- | --- | --- |");
    for (const row of notServed) {
      lines.push(
        `| ${row.domain} | ${row.httpStatus || "no response"} | ${row.fatal ?? "no version"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Method");
  lines.push("");
  lines.push(
    meta.follow
      ? "- The profile is fetched without following redirects, as the spec requires; a 3xx is then resolved once to find the canonical host and re-scanned."
      : "- The `.well-known/ucp` document is fetched once, without following redirects, as the spec requires.",
  );
  lines.push(
    "- A domain counts as *served* only on HTTP 200 with a parseable profile that declares `ucp.version`.",
  );
  lines.push(
    "- *Signed* means the profile publishes at least one entry in `keys[]`.",
  );
  lines.push(
    "- Categories come from the seed list, not from the site itself.",
  );
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  lines.push(
    "- This is a hand-picked slice, not a census. Seed bias drives every number.",
  );
  lines.push(
    "- Retail seeds were drawn from a public UCP directory, so the retail serve rate is not a population estimate.",
  );
  lines.push(
    "- A 403 or 404 at the apex may hide a profile served elsewhere; corporate domains are not storefronts.",
  );
  lines.push(
    "- A profile is not a working checkout. Nothing here verifies that an agent can complete a purchase.",
  );
  lines.push("");
  return lines.join("\n");
}
