import type { BaseRef, BaseRefSource } from "../git/worktree-state.js";

export type SourceDriftState = "current" | "behind" | "unknown";

/**
 * Checkout-vs-base verdict — the second staleness axis.
 *
 * Sibling to {@link Freshness}, deliberately never merged with it: freshness
 * measures index↔checkout, this measures checkout↔base ref. A perfectly fresh
 * index over a worktree 170 commits behind `origin/main` is green on the first
 * axis and rotten on this one, which is the whole reason this type exists.
 *
 * NOTE `commits_behind` here means "behind the BASE REF", which is NOT what the
 * same-named field on `Freshness` means ("commits since the INDEX"). The two
 * live in separate nested objects precisely so the collision cannot bite.
 */
export interface SourceDrift {
  state: SourceDriftState;
  base_ref?: string;
  base_source?: BaseRefSource;
  commits_behind?: number;
  fork_age_days?: number;
  base_ref_age_days?: number;
  note?: string;
}

export interface ClassifySourceDriftInput {
  isGit: boolean;
  base: BaseRef | null;
  commitsBehind: number | null;
  forkAgeDays: number | null;
  baseRefAgeDays: number | null;
  commitsThreshold: number;
  daysThreshold: number;
}

/**
 * Pure source-drift classifier — no I/O.
 *
 * Every path git cannot answer returns `unknown`, and `unknown` is SILENT. The
 * signal has exactly two things it can say: "you are demonstrably behind" or
 * nothing. It must never report `current` on the strength of a git call that
 * failed — that would re-create, one level down, the exact green-but-wrong
 * failure this signal exists to kill.
 */
export function classifySourceDrift(i: ClassifySourceDriftInput): SourceDrift {
  if (!i.isGit) return { state: "unknown", note: "not a git repository" };
  if (!i.base) return { state: "unknown", note: "no base ref resolvable (no upstream, no origin/HEAD, no origin/main|master)" };
  if (i.commitsBehind == null) return { state: "unknown", note: `cannot count commits against ${i.base.ref}` };
  if (i.forkAgeDays == null) return { state: "unknown", note: `fork point against ${i.base.ref} is unresolvable` };

  const d: SourceDrift = {
    state: "current",
    base_ref: i.base.ref,
    base_source: i.base.source,
    commits_behind: i.commitsBehind,
    fork_age_days: i.forkAgeDays,
  };
  if (i.baseRefAgeDays != null) d.base_ref_age_days = i.baseRefAgeDays;

  // Two thresholds, OR'd: either alone calibrates to a single repo's commit
  // rate. A fast repo drifts 50 commits in two days; a slow one drifts 5 over
  // three weeks. Count-only misses the second, age-only misses the first.
  const byCount = i.commitsBehind >= i.commitsThreshold;
  const byAge = i.forkAgeDays >= i.daysThreshold;
  if (byCount || byAge) {
    d.state = "behind";
    d.note = noteFor(d, i.daysThreshold);
  }
  return d;
}

function noteFor(d: SourceDrift, daysThreshold: number): string {
  let s = `${d.commits_behind} commit(s) behind ${d.base_ref} — forked ${d.fork_age_days}d ago`;
  // The base ref only moves on fetch, so an old one makes the count a FLOOR,
  // not a measurement. Reuses the fork-age threshold rather than introducing a
  // third constant to tune.
  if (d.base_ref_age_days != null && d.base_ref_age_days >= daysThreshold) {
    s += `; ${d.base_ref} last fetched ${d.base_ref_age_days}d ago (count may understate; git fetch to confirm)`;
  }
  return s;
}
