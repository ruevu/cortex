import { brand } from "../cli/prog.js";
import { QUALITY_ADVICE } from "./compute.js";
import type { GraphQuality } from "./types.js";

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
