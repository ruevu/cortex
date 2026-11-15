import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QualityReport } from "./types.js";

/**
 * `<checkout>/.cortex/quality.json`.
 *
 * Checkout-scoped, like the graph store and the staleness report beside it:
 * the report describes the graph built for this tree, and `.cortex/` is
 * gitignored and disposable. Never the canonical root — a linked worktree
 * has its own graph, so it must have its own report.
 *
 * See docs/architecture/graph-quality.md.
 */
export function qualityReportPath(repoPath: string): string {
  return join(repoPath, ".cortex", "quality.json");
}

/**
 * Write the report via a temp sibling + rename, so a concurrent reader never
 * sees half a file. The temp name carries the pid, so two indexes finishing
 * at once cannot interleave their bytes in one temp file.
 *
 * Best-effort — a failed write never fails an index — but never STALE: if
 * the new report cannot be written, the previous one is removed rather than
 * left to describe an older graph. No report reads as "not computed"; an old
 * one reads as a verdict on a graph that no longer exists.
 */
export function writeQualityReport(repoPath: string, report: QualityReport): void {
  const p = qualityReportPath(repoPath);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, p);
  } catch {
    removeQualityReport(repoPath);
  }
}

/** The report, or null when absent, unreadable, or of another `version`.
 *  Version-gating makes a report from another release INVISIBLE rather than
 *  misparsed: a shape mismatch would surface as a wrong number, not an error. */
export function readQualityReport(repoPath: string): QualityReport | null {
  try {
    const parsed = JSON.parse(readFileSync(qualityReportPath(repoPath), "utf8")) as QualityReport | null;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Delete the report. Best-effort: absent is already the goal. */
export function removeQualityReport(repoPath: string): void {
  try {
    rmSync(qualityReportPath(repoPath), { force: true });
  } catch {
    /* best-effort */
  }
}
