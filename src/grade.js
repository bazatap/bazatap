/**
 * Scoring: start at 100, deduct per finding. Fatal findings collapse to 0.
 * The weights are deliberately blunt; tune once real profiles disagree.
 */

/** @typedef {{ code: string, severity: "fatal"|"error"|"warn"|"info", message: string, path?: string }} Finding */

const DEDUCTION = { error: 15, warn: 5, info: 0 };

/**
 * @param {Finding[]} findings
 * @returns {{ score: number, grade: string }}
 */
export function grade(findings) {
  if (findings.some((f) => f.severity === "fatal")) {
    return { score: 0, grade: "F" };
  }
  const penalty = findings.reduce(
    (sum, f) => sum + (DEDUCTION[f.severity] ?? 0),
    0,
  );
  const score = Math.max(0, 100 - penalty);
  return { score, grade: letter(score) };
}

/** @param {number} score */
function letter(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}
