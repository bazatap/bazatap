const COLORS = {
  fatal: "\x1b[31m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[2m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  reset: "\x1b[0m",
};

/**
 * @param {any} result
 * @param {{ color?: boolean }} [options]
 */
export function formatResult(result, options = {}) {
  const color = options.color ?? false;
  const paint = (style, text) =>
    color ? `${COLORS[style] ?? ""}${text}${COLORS.reset}` : text;

  const lines = [];
  lines.push("");
  lines.push(`${paint("bold", "bazatap")} ${result.url ?? result.target}`);
  lines.push(
    paint(
      "dim",
      [
        result.httpStatus ? `HTTP ${result.httpStatus}` : "no response",
        result.summary.version ? `version ${result.summary.version}` : "no version",
        `${result.summary.capabilities ?? 0} capabilities`,
        `${result.summary.services ?? 0} services`,
        `${result.summary.keys ?? 0} keys`,
      ].join(" · "),
    ),
  );

  if (result.findings.length === 0) {
    lines.push("");
    lines.push(paint("green", "No findings. This profile is clean."));
  } else {
    lines.push("");
    lines.push(
      `${paint("bold", "Findings")} ${paint("dim", `(${result.findings.length})`)}`,
    );
    const width = Math.max(...result.findings.map((f) => f.code.length));
    for (const finding of result.findings) {
      const label = paint(finding.severity, finding.severity.padEnd(5));
      const code = paint("dim", finding.code.padEnd(width));
      lines.push(`  ${label} ${code}  ${finding.message}`);
    }
  }

  lines.push("");
  const gradeColor =
    result.grade === "A" || result.grade === "B"
      ? "green"
      : result.grade === "C" || result.grade === "D"
        ? "warn"
        : "fatal";
  lines.push(
    `${paint("bold", `Score ${result.score}/100`)}   ${paint(gradeColor, `Grade ${result.grade}`)}`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {any} result
 */
export function formatJson(result) {
  return JSON.stringify(
    {
      target: result.target,
      url: result.url,
      httpStatus: result.httpStatus,
      fetchedAt: result.fetchedAt,
      score: result.score,
      grade: result.grade,
      summary: result.summary,
      findings: result.findings,
    },
    null,
    2,
  );
}
