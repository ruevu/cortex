import { readQualityReport } from "../quality/report-store.js";
import { QualityReportWireSchema, type QualityReportWire } from "./api-schemas.js";

/**
 * The body of `GET /api/quality?project=<name>`: the project's index-time
 * quality report in its wire shape, or null when there is nothing to serve —
 * `CORTEX_QUALITY=0`, an unregistered project, or a checkout with no readable
 * report of the current version.
 *
 * It reads what the last index wrote and never computes: the report must
 * describe the graph that was published, and the route serves it under the
 * index-baseline ETag (`freshCtx()`). That pairing is sound only because every
 * index writes the report BEFORE moving the baseline — see
 * src/quality/run-report.ts — so a client revalidating with `If-None-Match`
 * gets a 304 exactly while the report is unchanged.
 *
 * The report is parsed against the wire schema rather than passed through, for
 * two reasons. A damaged file that still says `version: 1` reads as "no
 * report" instead of an invalid body (a 500 under the strict posture). And
 * parsing drops the file-level `version` and `repo_path`, which describe the
 * file, not the graph.
 *
 * See docs/architecture/graph-quality.md and docs/api/README.md (decision D-3t5z).
 */
export function httpQualityFor(
  project: string | null,
  registry: { findByName(name: string): { root_path: string } | null },
): QualityReportWire | null {
  if (process.env.CORTEX_QUALITY === "0") return null;
  const rootPath = project ? registry.findByName(project)?.root_path ?? null : null;
  if (!rootPath) return null;
  const parsed = QualityReportWireSchema.safeParse(readQualityReport(rootPath));
  return parsed.success ? parsed.data : null;
}
