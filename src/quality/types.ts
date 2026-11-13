/**
 * Graph-quality types — how much of the CALLS graph is a guess.
 *
 * The published vocabulary is closed (decision D-w4eg): `resolved`, `likely`,
 * `name guess` (JSON key `name_guess`) and `unscored`. Internal confidence
 * bands and resolver strategy names never appear here, so renaming a resolver
 * never changes what a consumer sees. Graph-wide shares are published; a
 * per-edge confidence number never is (D-b1gd).
 *
 * See docs/architecture/graph-quality.md.
 */

export type QualityLevel = "ok" | "degraded" | "poor";

/** A free function reached by member-call syntax through many distinct
 *  receivers — in every case inspected, a built-in method (`Array.map`,
 *  `Iterator.collect`) bound by name to a same-named repo function. */
export interface SuspectHub {
  name: string;
  file: string | null;
  /** Member-call edges into the hub — the demoted ones. */
  calls: number;
  /** Distinct receiver expressions across those calls. */
  receivers: number;
}

export interface GraphQuality {
  /** Every CALLS edge, partitioned. `name_guess` includes `hub_edges`. */
  calls: {
    total: number;
    resolved: number;
    likely: number;
    name_guess: number;
    unscored: number;
    hub_edges: number;
  };
  /** `name_guess / total`, 0..1, unrounded; 0 when there are no CALLS edges. */
  guess_share: number;
  /** `hub_edges / total`, 0..1, unrounded; 0 when there are no CALLS edges. */
  hub_share: number;
  /** Every suspect hub, not just the listed ones. */
  hub_count: number;
  /** The largest hubs by calls, then name, then file — at most MAX_REPORTED_HUBS. */
  suspect_hubs: SuspectHub[];
  verdict: {
    level: QualityLevel;
    /** False when the graph is too small, or too unscored, to judge; the level is then `ok`. */
    judged: boolean;
    /** Why the level is not `ok`; empty when it is. */
    reasons: string[];
    /** What to do about it; null when the level is `ok`. */
    advice: string | null;
    /** Why the graph was not judged; null when it was. */
    note: string | null;
  };
}
