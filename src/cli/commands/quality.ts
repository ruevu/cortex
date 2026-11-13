import { readQualityReport } from "../../quality/report-store.js";
import { formatQualityHeadline, formatQualitySummary } from "../../quality/format.js";
import { worktreeRoot } from "../../db/git-root.js";
import { brand } from "../prog.js";

/**
 * `cortex quality [--json|--headline]` — read back the graph-quality report
 * the last index wrote (src/quality/run-report.ts). It never computes one:
 * the report describes the graph as it was published, and recomputing here
 * would answer for a graph nobody indexed.
 *
 * - plain: the summary, or a hint to index when there is no report.
 * - `--json`: the report, or `null`.
 * - `--headline`: one line when the level is degraded or poor, otherwise
 *   NOTHING. The SessionStart hook prints this verbatim, so "nothing to say"
 *   must produce no bytes at all.
 *
 * `CORTEX_QUALITY=0` silences every mode. Exits 0 in every case, so an older
 * report or none at all never breaks the hook.
 *
 * Anchored to the CHECKOUT root, matching where the index wrote the report:
 * a linked worktree reads its own, never the main checkout's.
 */
export function runQualityCommand(
  flags: Record<string, string | boolean>,
  startDir: string = process.cwd(),
): void {
  if (process.env.CORTEX_QUALITY === "0") return;
  const report = readQualityReport(worktreeRoot(startDir));
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(report ?? null, null, 2) + "\n");
    return;
  }
  if (flags.headline === true) {
    const headline = report ? formatQualityHeadline(report) : "";
    if (headline) process.stdout.write(headline + "\n");
    return;
  }
  process.stdout.write(
    (report ? formatQualitySummary(report) : brand("no quality report for this checkout — run: cortex index")) + "\n",
  );
}
