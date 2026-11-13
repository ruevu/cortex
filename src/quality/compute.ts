/**
 * Call-graph quality, computed from what the graph already stores.
 *
 * cortex-indexer resolves each call through a strategy chain and records the
 * result's `confidence` and `callee` on the edge (`edges.data`). This module
 * turns those into one label per CALLS edge, finds the suspect hubs the score
 * misses, and judges the whole graph `ok` / `degraded` / `poor`.
 *
 * The definitions are the CALIBRATED ones (decision D-kn9w, measured across
 * seven repos on 2026-11-12). Change them only together with the eval
 * baselines that track them (`guess_share`, `suspect_hub_share`,
 * `unscored_share`, `quality_level` in evals/src/assertions/universal.ts).
 *
 * PURE: no I/O beyond the injected query. The eval harness imports this file
 * directly, so it must stay free of server dependencies.
 *
 * See docs/architecture/graph-quality.md.
 */
import type { GraphQuality, QualityLevel, SuspectHub } from "./types.js";

/** Row reader. `GraphStore.queryRaw.bind(store)` satisfies it; for a raw
 *  better-sqlite3 handle use
 *  `<T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[]`. */
export type QueryRows = <T>(sql: string, params?: unknown[]) => T[];

/** Confidence at or above which an edge is `resolved` (the indexer's `high` band). */
export const HIGH_MIN = 0.7;
/** Confidence at or above which an edge is `likely` (the `medium` band). Below: a name guess. */
export const MEDIUM_MIN = 0.45;
/** Distinct receivers that make a member-called free function a suspect hub. */
export const HUB_MIN_RECEIVERS = 10;
export const POOR_GUESS_SHARE = 0.5;
export const DEGRADED_GUESS_SHARE = 0.4;
export const DEGRADED_HUB_SHARE = 0.1;
/** Below this many CALLS edges a share is noise, so the graph is not judged. */
export const MIN_JUDGED_CALLS = 200;
/** Above this unscored share the confidence signal is absent, so the graph is not judged. */
export const MAX_UNSCORED_SHARE = 0.5;
export const MAX_REPORTED_HUBS = 10;
export const HUB_NAMES_IN_REASON = 3;

/** Fixed by the spec; shown wherever a verdict is not `ok`. */
export const QUALITY_ADVICE = "treat callers/callees as hints; confirm with search_code";

/** Ordinal for the eval's `quality_level` metric: lower is better. */
export const LEVEL_RANK: Record<QualityLevel, number> = { ok: 0, degraded: 1, poor: 2 };

/**
 * Shared CTE. Every read of `edges.data` goes through
 * `CASE WHEN json_valid(..) THEN json_extract(..) END`: SQLite does not
 * promise the evaluation order of `WHERE json_valid(..) AND json_extract(..)`,
 * and a single malformed row (open-pencil ships 94, indexer bug T-d273) would
 * otherwise fail the whole query. CASE evaluates only the branch it takes.
 *
 * `receiver` is the callee minus "." and the target's name: `items.map` → `items`.
 * A namespace import (`utils.format`) has one receiver; values have many.
 */
const CTE = `
  WITH calls AS (
    SELECT e.target_id AS tid,
           CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.confidence') END AS conf,
           CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.callee') END AS callee
    FROM edges e
    WHERE e.relation = 'CALLS'
  ),
  member AS (
    SELECT c.tid, t.name, t.file_path,
           substr(c.callee, 1, length(c.callee) - length(t.name) - 1) AS receiver
    FROM calls c
    JOIN nodes t ON t.id = c.tid
    WHERE t.kind = 'function' AND instr(c.callee, '.') > 0
  ),
  hubs AS (
    SELECT tid, name, file_path, COUNT(*) AS calls, COUNT(DISTINCT receiver) AS receivers
    FROM member
    GROUP BY tid
    HAVING COUNT(DISTINCT receiver) >= ${HUB_MIN_RECEIVERS}
  )`;

const HUBS_SQL = `${CTE}
  SELECT name, file_path AS file, calls, receivers
  FROM hubs
  ORDER BY calls DESC, name ASC, file ASC`;

/** The label order is the definition: hub demotion first, then the bands. */
const LABELS_SQL = `${CTE}
  SELECT CASE
           WHEN c.tid IN (SELECT tid FROM hubs) AND instr(c.callee, '.') > 0 THEN 'hub'
           WHEN typeof(c.conf) NOT IN ('integer', 'real') THEN 'unscored'
           WHEN c.conf >= ${HIGH_MIN} THEN 'resolved'
           WHEN c.conf >= ${MEDIUM_MIN} THEN 'likely'
           ELSE 'name_guess'
         END AS label,
         COUNT(*) AS n
  FROM calls c
  GROUP BY label`;

/**
 * `n / total` as a percentage floored to one decimal, from the integer counts.
 * Never from the float share: `0.57 * 100` is `56.99999999999999`, which
 * would floor a true 57.0% to 56.9%. Flooring (not rounding) keeps a share
 * just under a threshold from printing as the threshold.
 */
export function pct(n: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${(Math.floor((n * 1000) / total) / 10).toFixed(1)}%`;
}

export function computeGraphQuality(query: QueryRows): GraphQuality {
  const labels = query<{ label: string; n: number }>(LABELS_SQL);
  const count = (label: string) => labels.find((r) => r.label === label)?.n ?? 0;
  const hubEdges = count("hub");
  const calls: GraphQuality["calls"] = {
    total: labels.reduce((sum, r) => sum + r.n, 0),
    resolved: count("resolved"),
    likely: count("likely"),
    name_guess: count("name_guess") + hubEdges,
    unscored: count("unscored"),
    hub_edges: hubEdges,
  };
  const hubs = query<SuspectHub>(HUBS_SQL);
  const guess_share = calls.total === 0 ? 0 : calls.name_guess / calls.total;
  const hub_share = calls.total === 0 ? 0 : calls.hub_edges / calls.total;

  return {
    calls,
    guess_share,
    hub_share,
    hub_count: hubs.length,
    suspect_hubs: hubs.slice(0, MAX_REPORTED_HUBS),
    verdict: judge(calls, guess_share, hub_share, hubs),
  };
}

function judge(
  calls: GraphQuality["calls"],
  guess_share: number,
  hub_share: number,
  hubs: SuspectHub[],
): GraphQuality["verdict"] {
  if (calls.total < MIN_JUDGED_CALLS) {
    return notJudged(`too few call edges to judge (${calls.total} < ${MIN_JUDGED_CALLS})`);
  }
  if (calls.unscored / calls.total > MAX_UNSCORED_SHARE) {
    return notJudged(`most call edges carry no confidence score (${calls.unscored} of ${calls.total})`);
  }

  const level: QualityLevel =
    guess_share >= POOR_GUESS_SHARE ? "poor"
    : guess_share >= DEGRADED_GUESS_SHARE || hub_share >= DEGRADED_HUB_SHARE ? "degraded"
    : "ok";
  if (level === "ok") return { level, judged: true, reasons: [], advice: null, note: null };

  const reasons: string[] = [];
  if (guess_share >= DEGRADED_GUESS_SHARE) {
    reasons.push(`${pct(calls.name_guess, calls.total)} of call edges are name guesses`);
  }
  if (hub_share >= DEGRADED_HUB_SHARE) {
    const names = hubs.slice(0, HUB_NAMES_IN_REASON).map((h) => h.name).join(", ");
    const more = hubs.length > HUB_NAMES_IN_REASON ? ", …" : "";
    reasons.push(`${pct(calls.hub_edges, calls.total)} of call edges run through suspect hubs (${names}${more})`);
  }
  return { level, judged: true, reasons, advice: QUALITY_ADVICE, note: null };
}

function notJudged(note: string): GraphQuality["verdict"] {
  return { level: "ok", judged: false, reasons: [], advice: null, note };
}
