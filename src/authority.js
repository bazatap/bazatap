/**
 * Namespace authority binding, per UCP "Authority Binding":
 * a declared schema URL's host, label-reversed, must equal the entity name
 * or be a label-aligned prefix of it. This proves provenance only.
 */

/**
 * @param {string} host
 * @returns {string}
 */
export function authorityPrefix(host) {
  return host.toLowerCase().replace(/\.$/, "").split(".").reverse().join(".");
}

/**
 * @param {string} name  reverse-domain entity name, e.g. dev.ucp.shopping.checkout
 * @param {string} schemaUrl
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkAuthority(name, schemaUrl) {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "entity name is missing" };
  }
  if (typeof schemaUrl !== "string" || schemaUrl.length === 0) {
    return { ok: false, reason: "schema URL is missing" };
  }

  let url;
  try {
    url = new URL(schemaUrl);
  } catch {
    return { ok: false, reason: "schema URL is not a valid URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "schema URL must use https" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "schema URL must not contain userinfo" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // URL parsing keeps IPv6 literals in brackets and IPv4 in dotted form.
  if (host.startsWith("[") || isIpv4(host)) {
    return { ok: false, reason: "IP-literal hosts are not a valid authority" };
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: "single-label hosts are not a valid authority" };
  }

  const prefix = authorityPrefix(host);
  if (name === prefix || name.startsWith(prefix + ".")) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `schema host "${host}" does not own namespace "${name}"`,
  };
}

/** @param {string} host */
function isIpv4(host) {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}
