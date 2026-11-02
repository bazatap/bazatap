import { checkAuthority } from "./authority.js";
import { grade } from "./grade.js";
import { asArray, isObject, validateProfile } from "./validate.js";

const PROFILE_PATH = "/.well-known/ucp";
const USER_AGENT = "bazatap/0.1.0";

/**
 * Turn a user target into the profile URL. A bare domain gets
 * `/.well-known/ucp`; an explicit URL is used as given.
 * @param {string} target
 */
export function resolveProfileUrl(target) {
  const trimmed = target.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported scheme: ${url.protocol}`);
  }
  const isSiteRoot = url.pathname === "/" && !url.search && !url.hash;
  if (isSiteRoot) url.pathname = PROFILE_PATH;
  return url.toString();
}

/**
 * @param {string} target
 * @param {{ timeout?: number, fetchSchemas?: boolean, probe?: boolean, fetchImpl?: typeof fetch }} [options]
 */
export async function scan(target, options = {}) {
  const {
    timeout = 10_000,
    fetchSchemas = true,
    probe = false,
    fetchImpl = fetch,
  } = options;

  /** @type {import("./grade.js").Finding[]} */
  const findings = [];
  const result = {
    target,
    url: /** @type {string|undefined} */ (undefined),
    httpStatus: /** @type {number|undefined} */ (undefined),
    fetchedAt: new Date().toISOString(),
    score: 0,
    grade: "F",
    summary: /** @type {any} */ ({}),
    findings,
  };

  let profileUrl;
  try {
    profileUrl = resolveProfileUrl(target);
  } catch (err) {
    findings.push(fatal("BAD_TARGET", `Cannot read target "${target}": ${message(err)}`));
    return finish(result);
  }
  result.url = profileUrl;
  if (profileUrl.startsWith("http://")) {
    findings.push(
      warn("INSECURE_PROFILE", "Profile is being read over http; UCP requires https."),
    );
  }

  const response = await request(fetchImpl, profileUrl, timeout).catch((err) => {
    findings.push(
      fatal(
        "PROFILE_UNREACHABLE",
        `Could not fetch ${profileUrl}: ${message(err)}`,
      ),
    );
    return undefined;
  });
  if (!response) return finish(result);
  result.httpStatus = response.status;

  if (response.status >= 300 && response.status < 400) {
    findings.push(
      fatal(
        "PROFILE_REDIRECT",
        `Profile redirects (HTTP ${response.status}${
          response.headers.get("location")
            ? ` to ${response.headers.get("location")}`
            : ""
        }). It must be served at /.well-known/ucp without redirects.`,
      ),
    );
    return finish(result);
  }
  if (response.status !== 200) {
    findings.push(
      fatal(
        "PROFILE_STATUS",
        `Profile returned HTTP ${response.status}, not 200.`,
      ),
    );
    return finish(result);
  }

  const body = await response.text().catch(() => "");
  let profile;
  try {
    profile = JSON.parse(body);
  } catch {
    findings.push(
      fatal(
        "PROFILE_NOT_JSON",
        `Profile is not JSON (received ${body.trim().slice(0, 60) || "an empty body"}).`,
      ),
    );
    return finish(result);
  }

  const validated = validateProfile(profile);
  findings.push(...validated.findings);
  result.summary = validated.summary;

  if (findings.some((f) => f.severity === "fatal")) {
    return finish(result);
  }

  const schemaUrls = new Map(); // url -> entity label

  for (const { kind, name, entry } of validated.entities) {
    if (!isObject(entry)) continue;

    const urls = schemaUrlsFor(kind, entry);
    for (const schemaUrl of urls) {
      if (typeof schemaUrl !== "string") continue;
      const check = checkAuthority(name, schemaUrl);
      if (!check.ok) {
        findings.push(
          error(
            "AUTHORITY_BINDING",
            `\`${name}\` declares ${schemaUrl}: ${check.reason}.`,
          ),
        );
      } else {
        schemaUrls.set(schemaUrl, name);
      }
    }

    if (kind === "capability" && isObject(entry.requires)) {
      checkRequires(findings, name, entry.requires, validated.summary.version);
    }
  }

  if (fetchSchemas) {
    const entries = [...schemaUrls.entries()];
    await mapLimit(entries, 6, async ([url, name]) => {
      const schemaFindings = await checkSchema(fetchImpl, url, name, timeout);
      findings.push(...schemaFindings.findings);
      if (schemaFindings.schema) {
        checkRequires(
          findings,
          name,
          schemaFindings.schema.requires,
          validated.summary.version,
        );
      }
    });
  }

  if (probe) {
    const endpoints = validated.entities
      .filter((e) => e.kind === "service" && isObject(e.entry))
      .map((e) => e.entry.endpoint)
      .filter((e) => typeof e === "string");
    await mapLimit([...new Set(endpoints)], 4, async (endpoint) => {
      const finding = await probeEndpoint(fetchImpl, endpoint, timeout);
      if (finding) findings.push(finding);
    });
  }

  return finish(result);
}

/** @param {any} result */
function finish(result) {
  result.findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  const { score, grade: letter } = grade(result.findings);
  result.score = score;
  result.grade = letter;
  return result;
}

/** @param {string} severity */
function rank(severity) {
  return { fatal: 0, error: 1, warn: 2, info: 3 }[severity] ?? 4;
}

/**
 * @param {"service"|"capability"|"handler"} kind
 * @param {any} entry
 * @returns {string[]}
 */
function schemaUrlsFor(kind, entry) {
  if (kind === "handler") {
    return [
      entry.schema,
      entry.config_schema,
      ...asArray(entry.instrument_schemas),
    ].filter(Boolean);
  }
  return [entry.schema].filter(Boolean);
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} name
 * @param {number} timeout
 */
async function checkSchema(fetchImpl, url, name, timeout) {
  /** @type {import("./grade.js").Finding[]} */
  const findings = [];
  let response;
  try {
    response = await request(fetchImpl, url, timeout);
  } catch (err) {
    findings.push(
      error("SCHEMA_UNREACHABLE", `Schema for \`${name}\` is unreachable: ${message(err)}`),
    );
    return { findings };
  }
  if (response.status >= 300 && response.status < 400) {
    findings.push(
      error("SCHEMA_REDIRECT", `Schema for \`${name}\` redirects; platforms must not follow it.`),
    );
    return { findings };
  }
  if (response.status !== 200) {
    findings.push(
      error("SCHEMA_STATUS", `Schema for \`${name}\` returned HTTP ${response.status}.`),
    );
    return { findings };
  }
  const text = await response.text().catch(() => "");
  try {
    return { findings, schema: JSON.parse(text) };
  } catch {
    findings.push(
      error("SCHEMA_NOT_JSON", `Schema for \`${name}\` is not JSON.`),
    );
    return { findings };
  }
}

/**
 * `requires` constrains already-selected versions; it never selects them.
 * @param {import("./grade.js").Finding[]} findings
 * @param {string} name
 * @param {any} requires
 * @param {string|undefined} protocolVersion
 */
function checkRequires(findings, name, requires, protocolVersion) {
  if (!isObject(requires)) return;
  if (isObject(requires.protocol) && protocolVersion) {
    const { min, max } = requires.protocol;
    if (typeof min === "string" && protocolVersion < min) {
      findings.push(
        warn("REQUIRES_PROTOCOL", `\`${name}\` needs protocol >= ${min}, but the profile serves ${protocolVersion}.`),
      );
    }
    if (typeof max === "string" && protocolVersion > max) {
      findings.push(
        warn("REQUIRES_PROTOCOL", `\`${name}\` needs protocol <= ${max}, but the profile serves ${protocolVersion}.`),
      );
    }
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} endpoint
 * @param {number} timeout
 */
async function probeEndpoint(fetchImpl, endpoint, timeout) {
  try {
    const response = await fetchImpl(endpoint, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(Math.min(timeout, 5_000)),
    });
    return {
      code: "ENDPOINT_REACHABLE",
      severity: /** @type {const} */ ("info"),
      message: `Endpoint ${endpoint} answered HTTP ${response.status}.`,
    };
  } catch (err) {
    return {
      code: "ENDPOINT_UNREACHABLE",
      severity: /** @type {const} */ ("warn"),
      message: `Endpoint ${endpoint} did not respond: ${message(err)}`,
    };
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {number} timeout
 */
function request(fetchImpl, url, timeout) {
  return fetchImpl(url, {
    redirect: "manual",
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeout),
  });
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

function fatal(code, message) {
  return { code, severity: /** @type {const} */ ("fatal"), message };
}
function error(code, message) {
  return { code, severity: /** @type {const} */ ("error"), message };
}
function warn(code, message) {
  return { code, severity: /** @type {const} */ ("warn"), message };
}
