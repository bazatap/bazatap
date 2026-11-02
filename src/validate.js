/**
 * Structural checks for a UCP profile. Network-free: this module never fetches.
 */

export const TRANSPORTS = new Set(["rest", "mcp", "a2a", "embedded"]);
const VERSION = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {import("./grade.js").Finding} Finding
 * @typedef {{ kind: "service"|"capability"|"handler", name: string, entry: any }} Entity
 */

/**
 * @param {unknown} profile
 * @returns {{
 *   findings: Finding[],
 *   entities: Entity[],
 *   version?: string,
 *   summary: {
 *     version?: string,
 *     supportedVersions: string[],
 *     services: number,
 *     transports: string[],
 *     capabilities: number,
 *     vendorCapabilities: number,
 *     handlers: number,
 *     keys: number,
 *   }
 * }}
 */
export function validateProfile(profile) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Entity[]} */
  const entities = [];
  const summary = {
    version: undefined,
    supportedVersions: [],
    services: 0,
    transports: [],
    capabilities: 0,
    vendorCapabilities: 0,
    handlers: 0,
    keys: 0,
  };

  if (!isObject(profile)) {
    findings.push(fatal("PROFILE_NOT_OBJECT", "Profile is not a JSON object."));
    return { findings, entities, summary };
  }

  const ucp = profile.ucp;
  if (!isObject(ucp)) {
    findings.push(
      fatal("NO_UCP", "Profile has no `ucp` member, so it is not a UCP profile."),
    );
    return { findings, entities, summary };
  }

  if (typeof ucp.version !== "string") {
    findings.push(fatal("NO_VERSION", "`ucp.version` is missing."));
  } else if (!VERSION.test(ucp.version)) {
    findings.push(
      fatal(
        "BAD_VERSION",
        `\`ucp.version\` is "${ucp.version}", not a YYYY-MM-DD release date.`,
      ),
    );
  } else {
    summary.version = ucp.version;
  }

  if (ucp.supported_versions !== undefined) {
    if (!isObject(ucp.supported_versions)) {
      findings.push(
        warn("BAD_SUPPORTED_VERSIONS", "`ucp.supported_versions` is not an object."),
      );
    } else {
      summary.supportedVersions = Object.keys(ucp.supported_versions);
    }
  }

  // Services and payment_handlers MUST be present even when empty.
  if (!isObject(ucp.services)) {
    findings.push(
      error("NO_SERVICES", "`ucp.services` is missing; it must be present even when empty."),
    );
  } else {
    for (const [name, entries] of Object.entries(ucp.services)) {
      if (!Array.isArray(entries) || entries.length === 0) {
        findings.push(
          error(
            "EMPTY_SERVICE",
            `Service \`${name}\` has no transport bindings.`,
            `ucp.services.${name}`,
          ),
        );
        continue;
      }
      for (const entry of entries) {
        summary.services += 1;
        entities.push({ kind: "service", name, entry });
        if (!isObject(entry)) {
          findings.push(
            error("BAD_SERVICE", `Service \`${name}\` has a non-object entry.`, `ucp.services.${name}`),
          );
          continue;
        }
        if (typeof entry.version !== "string" || !VERSION.test(entry.version)) {
          findings.push(
            error("BAD_SERVICE_VERSION", `Service \`${name}\` has no valid \`version\`.`),
          );
        }
        if (typeof entry.spec !== "string") {
          findings.push(
            error("NO_SERVICE_SPEC", `Service \`${name}\` has no \`spec\` URL.`),
          );
        }
        if (!TRANSPORTS.has(entry.transport)) {
          findings.push(
            error(
              "BAD_TRANSPORT",
              `Service \`${name}\` declares transport "${entry.transport}"; expected rest, mcp, a2a or embedded.`,
            ),
          );
        } else if (!summary.transports.includes(entry.transport)) {
          summary.transports.push(entry.transport);
        }
        if (
          entry.transport !== "a2a" &&
          typeof entry.schema !== "string"
        ) {
          findings.push(
            error(
              "NO_SERVICE_SCHEMA",
              `Service \`${name}\` (${entry.transport}) has no \`schema\` URL.`,
            ),
          );
        }
        if (entry.transport === "a2a" && typeof entry.endpoint !== "string") {
          findings.push(
            error("NO_A2A_ENDPOINT", `Service \`${name}\` (a2a) has no \`endpoint\`.`),
          );
        }
        checkEndpoint(findings, name, entry.endpoint);
      }
    }
  }

  if (!isObject(ucp.payment_handlers)) {
    findings.push(
      error(
        "NO_HANDLERS",
        "`ucp.payment_handlers` is missing; it must be present even when empty.",
      ),
    );
  } else {
    for (const [name, entries] of Object.entries(ucp.payment_handlers)) {
      if (!Array.isArray(entries)) {
        findings.push(
          error("BAD_HANDLER", `Payment handler \`${name}\` is not an array.`),
        );
        continue;
      }
      for (const entry of entries) {
        summary.handlers += 1;
        entities.push({ kind: "handler", name, entry });
        if (!isObject(entry) || typeof entry.version !== "string") {
          findings.push(
            error("BAD_HANDLER_VERSION", `Payment handler \`${name}\` has no valid \`version\`.`),
          );
        }
      }
    }
  }

  if (ucp.capabilities === undefined) {
    findings.push(
      warn("NO_CAPABILITIES", "No capabilities declared, so agents have nothing to negotiate."),
    );
  } else if (!isObject(ucp.capabilities)) {
    findings.push(warn("BAD_CAPABILITIES", "`ucp.capabilities` is not an object."));
  } else {
    for (const [name, entries] of Object.entries(ucp.capabilities)) {
      if (!Array.isArray(entries) || entries.length === 0) {
        findings.push(
          error("EMPTY_CAPABILITY", `Capability \`${name}\` has no version entries.`),
        );
        continue;
      }
      summary.capabilities += 1;
      if (!name.startsWith("dev.ucp.")) summary.vendorCapabilities += 1;
      for (const entry of entries) {
        entities.push({ kind: "capability", name, entry });
        if (!isObject(entry)) {
          findings.push(
            error("BAD_CAPABILITY", `Capability \`${name}\` has a non-object entry.`),
          );
          continue;
        }
        if (typeof entry.version !== "string" || !VERSION.test(entry.version)) {
          findings.push(
            error("BAD_CAPABILITY_VERSION", `Capability \`${name}\` has no valid \`version\`.`),
          );
        }
        if (typeof entry.spec !== "string") {
          findings.push(
            error("NO_CAPABILITY_SPEC", `Capability \`${name}\` has no \`spec\` URL.`),
          );
        }
        if (typeof entry.schema !== "string") {
          findings.push(
            error("NO_CAPABILITY_SCHEMA", `Capability \`${name}\` has no \`schema\` URL.`),
          );
        }
      }
    }

    // Extensions whose parent is not declared will be pruned during negotiation.
    const declared = new Set(Object.keys(ucp.capabilities));
    for (const [name, entries] of Object.entries(ucp.capabilities)) {
      for (const entry of entries) {
        if (!isObject(entry) || entry.extends === undefined) continue;
        for (const parent of asArray(entry.extends)) {
          if (!declared.has(parent)) {
            findings.push(
              warn(
                "ORPHAN_EXTENSION",
                `\`${name}\` extends \`${parent}\`, which this profile does not declare, so it will be pruned.`,
              ),
            );
          }
        }
      }
    }
  }

  if (profile.keys === undefined) {
    findings.push(
      warn(
        "NO_KEYS",
        "No signing keys. Discovery works, but signed requests and webhooks cannot be verified.",
      ),
    );
  } else if (!Array.isArray(profile.keys) || profile.keys.length === 0) {
    findings.push(
      warn(
        "EMPTY_KEYS",
        "`keys` is empty or not an array, so signatures cannot be verified.",
      ),
    );
  } else {
    summary.keys = profile.keys.length;
    profile.keys.forEach((key, i) => {
      if (!isObject(key) || typeof key.kty !== "string") {
        findings.push(
          error("BAD_KEY", `Key #${i} has no \`kty\`, so it is not a usable JWK.`),
        );
      }
    });
  }

  return { findings, entities, version: summary.version, summary };
}

/**
 * @param {Finding[]} findings
 * @param {string} name
 * @param {unknown} endpoint
 */
function checkEndpoint(findings, name, endpoint) {
  if (typeof endpoint !== "string") return;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    findings.push(
      error("BAD_ENDPOINT", `Service \`${name}\` has an endpoint that is not a URL.`),
    );
    return;
  }
  if (url.protocol !== "https:") {
    findings.push(
      error("INSECURE_ENDPOINT", `Service \`${name}\` endpoint does not use https.`),
    );
  }
  if (url.pathname.endsWith("/") && url.pathname !== "/") {
    findings.push(
      warn(
        "TRAILING_SLASH",
        `Service \`${name}\` endpoint ends with "/"; OpenAPI paths are appended directly.`,
      ),
    );
  }
}

/** @param {unknown} value */
export function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** @param {unknown} value */
export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fatal(code, message, path) {
  return { code, severity: /** @type {const} */ ("fatal"), message, path };
}
export function error(code, message, path) {
  return { code, severity: /** @type {const} */ ("error"), message, path };
}
export function warn(code, message, path) {
  return { code, severity: /** @type {const} */ ("warn"), message, path };
}
