#!/usr/bin/env node
import { scan } from "../src/scan.js";
import { formatJson, formatResult } from "../src/report.js";
import { startTap } from "../src/tap.js";

const USAGE = `bazatap — see why AI agents fail to buy

Usage:
  bazatap scan <domain|url> [options]
  bazatap tap --upstream=URL [options]

scan options:
  --json          machine-readable output
  --no-schemas    skip fetching and checking schema URLs
  --probe         also check service endpoints respond
  --timeout=MS    per-request timeout (default 10000)

tap options:
  --upstream=URL  origin to proxy to (required)
  --port=N        local port (default 6060)
  --host=ADDR     local bind address (default 127.0.0.1)
  --log=PATH      JSONL event log (default .bazatap/events.jsonl)
  --no-bodies     record request metadata only, never bodies

  -h, --help      show this help
  -v, --version   show the version

Examples:
  bazatap scan allbirds.com
  bazatap scan shop.example.com --json
  bazatap tap --upstream http://localhost:3000

Exit codes:
  0  no errors (warnings are fine)
  1  at least one error or fatal finding
  2  bad usage`;

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}
if (args.includes("-v") || args.includes("--version")) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
  console.log(JSON.parse(readFileSync(pkg, "utf8")).version);
  process.exit(0);
}

const [command, ...rest] = args;
const VALUE_OPTIONS = new Set(["--upstream", "--port", "--host", "--log", "--timeout"]);
const { positionals, flags, options } = parseArgs(rest);

if (command === "scan") {
  await runScan();
} else if (command === "tap") {
  await runTap();
} else {
  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  process.exit(2);
}

async function runScan() {
  if (positionals.length !== 1) {
    console.error(`Expected exactly one target.\n\n${USAGE}`);
    process.exit(2);
  }
  const timeout = numberOption("--timeout", 10_000);
  const result = await scan(positionals[0], {
    timeout,
    fetchSchemas: !flags.has("--no-schemas"),
    probe: flags.has("--probe"),
  });

  if (flags.has("--json")) {
    console.log(formatJson(result));
  } else {
    console.log(
      formatResult(result, {
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
      }),
    );
  }

  const failed = result.findings.some(
    (finding) => finding.severity === "fatal" || finding.severity === "error",
  );
  process.exit(failed ? 1 : 0);
}

async function runTap() {
  const upstream = options.get("--upstream");
  if (!upstream) {
    console.error(`tap needs --upstream=URL.\n\n${USAGE}`);
    process.exit(2);
  }
  if (positionals.length > 0) {
    console.error(`tap takes no positional arguments (got "${positionals[0]}").`);
    process.exit(2);
  }

  const tap = await startTap({
    upstream,
    port: numberOption("--port", 6060),
    host: options.get("--host") ?? "127.0.0.1",
    logPath: options.get("--log") ?? ".bazatap/events.jsonl",
    bodies: !flags.has("--no-bodies"),
  });

  console.log(`bazatap tap  ${tap.url}`);
  console.log(`  upstream   ${tap.upstream}`);
  console.log(`  dashboard  ${tap.url}/__bazatap`);
  if (tap.logPath) console.log(`  log        ${tap.logPath}`);
  if (flags.has("--no-bodies")) console.log("  bodies     not recorded");
  console.log("\nWaiting for traffic. Ctrl+C to stop.");

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const summary = tap.summary();
    const acr =
      summary.checkout.completionRate === null
        ? "no attempts"
        : `${summary.checkout.completions}/${summary.checkout.attempts} (${Math.round(
            summary.checkout.completionRate * 100,
          )}%)`;
    console.log(
      `\nStopped after ${summary.requests} requests · ${summary.ucpRequests} agent requests · checkout ${acr}`,
    );
    await tap.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** @param {string} name @param {number} fallback */
function numberOption(name, fallback) {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number.`);
    process.exit(2);
  }
  return value;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Set<string>} */
  const flags = new Set();
  /** @type {Map<string,string>} */
  const pairs = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const index = arg.indexOf("=");
      pairs.set(arg.slice(0, index), arg.slice(index + 1));
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        console.error(`${arg} needs a value (${arg}=VALUE).`);
        process.exit(2);
      }
      pairs.set(arg, value);
      i += 1;
    } else if (arg.startsWith("-")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, options: pairs };
}
