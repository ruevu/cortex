import { brand } from "../cli/prog.js";
import { DEGRADED_GUESS_SHARE, DEGRADED_HUB_SHARE, POOR_GUESS_SHARE, QUALITY_ADVICE, pct } from "./compute.js";
import type { GraphQuality, QualityReport } from "./types.js";

/** The verdict holds at most two reasons today (guesses, hubs); the cap makes
 *  "never more than four lines" a property of this function, not of compute. */
const MAX_REASONS = 2;

/**
 * The lines `cortex index` prints after a graph is built, or null when there
 * is nothing to say.
 *
 * Silent unless abnormal: `ok` prints NOTHING, judged or not. A line printed
 * on every index is read as decoration and stops carrying information, which
 * is the one thing this warning cannot afford. When the graph is degraded or
 * poor it is 3–4 lines:
 *
 * ```
 * ⚠ graph quality: poor
 *   <reason>
 *   <second reason, when there is one>
 *   treat callers/callees as hints; confirm with search_code — details: cortex quality
 * ```
 *
 * The last line names a command, so it goes through `brand()`: under Mesh it
 * reads `mesh ctx quality`.
 */
export function formatQualityIndexLines(q: GraphQuality): string | null {
  const { level, reasons, advice } = q.verdict;
  if (level === "ok") return null;
  return [
    `⚠ graph quality: ${level}`,
    ...reasons.slice(0, MAX_REASONS).map((r) => `  ${r}`),
    brand(`  ${advice ?? QUALITY_ADVICE} — details: cortex quality`),
  ].join("\n");
}

/**
 * The one SessionStart line (`cortex quality --headline`), or "" when the
 * level is `ok` — judged or not — so the hook prints nothing.
 *
 * ```
 * ⚠ cortex quality: poor — 68.3% of call edges are name guesses (treat callers/callees as hints; confirm with search_code)
 * ```
 *
 * `cortex quality` here names the signal, like `⚠ cortex freshness`, not a
 * command to type, so it is not branded.
 */
export function formatQualityHeadline(q: GraphQuality): string {
  const { level, reasons } = q.verdict;
  if (level === "ok") return "";
  return `⚠ cortex quality: ${level} — ${reasons.join("; ")} (${QUALITY_ADVICE})`;
}

/** A threshold share (0.4) as the percentage people read (`40%`). */
function threshold(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The plain `cortex quality` output: the verdict, then the numbers behind it.
 * Always non-empty.
 *
 * The counts and shares print whether or not the graph was judged. When a
 * graph is not judged, the first line says why, and the numbers below it are
 * what the user needs to see that for themselves. Shares go through `pct`, the
 * same floor-to-a-tenth the verdict's reasons use, so the two never disagree
 * by a rounding.
 */
export function formatQualitySummary(r: QualityReport): string {
  const { calls, verdict } = r;
  const lines = [
    verdict.judged
      ? `graph quality: ${verdict.level} — judged on ${count(calls.total)} call edges`
      : `graph quality: ${verdict.level} — not judged: ${verdict.note ?? "no reason recorded"}`,
    `  call edges: resolved ${count(calls.resolved)} · likely ${count(calls.likely)} · ` +
      `name guess ${count(calls.name_guess)} · unscored ${count(calls.unscored)}`,
    `  name guesses: ${pct(calls.name_guess, calls.total)} of call edges ` +
      `(degraded at ${threshold(DEGRADED_GUESS_SHARE)}, poor at ${threshold(POOR_GUESS_SHARE)})`,
    `  suspect hubs: ${count(r.hub_count)}, carrying ${pct(calls.hub_edges, calls.total)} of call edges ` +
      `(degraded at ${threshold(DEGRADED_HUB_SHARE)})`,
    ...r.suspect_hubs.map((h) =>
      `    ${h.name} (${h.file ?? "file unknown"}) — ${count(h.calls)} calls from ${count(h.receivers)} receivers`),
  ];
  const unlisted = r.hub_count - r.suspect_hubs.length;
  if (unlisted > 0) lines.push(`    …and ${count(unlisted)} more`);
  if (verdict.level !== "ok") {
    lines.push(...verdict.reasons.map((reason) => `  why: ${reason}`));
    lines.push(`  advice: ${verdict.advice ?? QUALITY_ADVICE}`);
  }
  const commit = r.indexed_commit ? ` · indexed at ${r.indexed_commit.slice(0, 7)}` : "";
  lines.push(`  computed ${r.computed_at}${commit}`);
  return lines.join("\n");
}
