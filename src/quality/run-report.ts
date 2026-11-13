import Database from "better-sqlite3";
import { gitHead } from "../git/worktree-state.js";
import { computeGraphQuality, type QueryRows } from "./compute.js";
import { formatQualityIndexLines } from "./format.js";
import { removeQualityReport, writeQualityReport } from "./report-store.js";
import type { QualityReport } from "./types.js";

/**
 * Index-time graph-quality report. Computes the quality of the graph just
 * published at `dbPath`, writes `<repoPath>/.cortex/quality.json`, and
 * returns the lines for the index's output — or null when there is nothing
 * to say (`ok`), when `CORTEX_QUALITY=0`, or on any failure.
 *
 * ORDERING — MUST be called BEFORE `captureIndexMeta`, at every index site.
 * `GET /api/quality` serves this file under an ETag derived from the index
 * baseline that `captureIndexMeta` writes. Written after the baseline moves,
 * a poll landing between the two caches the PREVIOUS report under the NEW
 * ETag, and every later poll gets 304 Not Modified for it until the next
 * reindex: no error anywhere, just a viewer showing the old graph's verdict.
 * Written first, the worst a poll can see is the new report under the old
 * ETag, which the baseline change then invalidates. It runs after the
 * staleness sweep, which has its own reason to precede captureIndexMeta
 * (see src/staleness/run-sweep.ts). tests/quality/index-wiring.test.ts
 * enforces the order.
 *
 * `indexed_commit` is read from git, not from `cortex_index_meta`: at this
 * point that table still holds the PREVIOUS index's baseline.
 *
 * The graph is read inside one read transaction, so the two queries
 * computeGraphQuality makes see one snapshot even if another index publishes
 * meanwhile.
 *
 * NEVER THROWS, and never leaves a stale report: any failure removes the
 * previous report, because a verdict on an older graph is worse than none.
 * A quality report is metadata about an index, not the index.
 *
 * See docs/architecture/graph-quality.md (ordering contract: decision D-3t5z).
 */
export function runQualityReport(
  repoPath: string,
  dbPath: string,
  now: () => Date = () => new Date(),
): string | null {
  if (process.env.CORTEX_QUALITY === "0") return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let quality;
    try {
      const query: QueryRows = <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[];
      quality = db.transaction(() => computeGraphQuality(query))();
    } finally {
      db.close();
    }
    const report: QualityReport = {
      version: 1,
      computed_at: now().toISOString(),
      repo_path: repoPath,
      indexed_commit: gitHead(repoPath),
      ...quality,
    };
    writeQualityReport(repoPath, report);
    return formatQualityIndexLines(quality);
  } catch {
    removeQualityReport(repoPath);
    return null; // never fail an index over its quality report
  }
}
