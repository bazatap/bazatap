/**
 * Aggregation for crawl results. Pure functions so the report is reproducible
 * from a JSONL file without re-crawling.
 */

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {any[]} rows */
export function summarize(rows) {
  const categories = {};
  for (const row of rows) {
    const category = row.category || "uncategorised";
    categories[category] ??= emptyBucket();
    addTo(categories[category], row);
  }

  const overall = emptyBucket();
  for (const row of rows) addTo(overall, row);

  return {
    total: rows.length,
    served: overall.served,
    signed: overall.signed,
    signedPct: overall.served ? overall.signed / overall.served : 0,
    medianScore: median(overall.scores),
    grades: overall.grades,
    versions: sortCounts(overall.versions),
    platforms: sortCounts(overall.platforms),
    capabilities: sortCounts(overall.capabilities),
    findings: sortCounts(overall.findings),
    statuses: sortCounts(overall.statuses),
    categories: Object.fromEntries(
      Object.entries(categories).map(([name, bucket]) => [
        name,
        {
          total: bucket.total,
          served: bucket.served,
          signed: bucket.signed,
          signedPct: bucket.served ? bucket.signed / bucket.served : 0,
          medianScore: median(bucket.scores),
          topFinding: topKey(bucket.findings),
        },
      ]),
    ),
  };
}

function emptyBucket() {
  return {
    total: 0,
    served: 0,
    signed: 0,
    scores: /** @type {number[]} */ ([]),
    grades: /** @type {Record<string, number>} */ ({}),
    versions: /** @type {Record<string, number>} */ ({}),
    platforms: /** @type {Record<string, number>} */ ({}),
    capabilities: /** @type {Record<string, number>} */ ({}),
    findings: /** @type {Record<string, number>} */ ({}),
    statuses: /** @type {Record<string, number>} */ ({}),
  };
}

/** @param {any} bucket @param {any} row */
function addTo(bucket, row) {
  bucket.total += 1;
  const status = row.httpStatus ?? 0;
  bucket.statuses[String(status)] = (bucket.statuses[String(status)] ?? 0) + 1;

  for (const finding of row.findings ?? []) {
    bucket.findings[finding.code] = (bucket.findings[finding.code] ?? 0) + 1;
  }

  const served = row.hasProfile ?? (status === 200 && Boolean(row.version));
  if (!served) return;
  bucket.served += 1;
  bucket.scores.push(row.score);
  bucket.grades[row.grade] = (bucket.grades[row.grade] ?? 0) + 1;

  if (row.keys > 0) bucket.signed += 1;
  if (row.version) {
    bucket.versions[row.version] = (bucket.versions[row.version] ?? 0) + 1;
  }
  const platform = detectPlatform(row);
  bucket.platforms[platform] = (bucket.platforms[platform] ?? 0) + 1;
  for (const name of row.capabilityNames ?? []) {
    bucket.capabilities[name] = (bucket.capabilities[name] ?? 0) + 1;
  }
}

/**
 * Shopify and BigCommerce stamp their vendor namespace into the profile, which
 * is a far more reliable signal than the response headers we do not keep.
 * @param {any} row
 */
export function detectPlatform(row) {
  const capabilities = row.capabilityNames ?? [];
  if (capabilities.some((name) => String(name).startsWith("dev.shopify."))) {
    return "shopify";
  }
  if (capabilities.some((name) => String(name).startsWith("dev.bigcommerce."))) {
    return "bigcommerce";
  }
  if ((row.transports ?? []).length === 0) return "unknown";
  return "other";
}

/** @param {Record<string, number>} counts */
function sortCounts(counts) {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** @param {Record<string, number>} counts */
function topKey(counts) {
  const entries = sortCounts(counts);
  return entries[0]?.name ?? null;
}
