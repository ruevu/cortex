import {
  isGitRepo, resolveBaseRef, gitCommitsBehindRef, gitMergeBase, gitCommitTime,
  type BaseRef, type BaseRefSource,
} from "../git/worktree-state.js";

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

// ── Memoized per-repo wrapper ────────────────────────────────────────────────

const DEFAULT_COMMITS = 25;
const DEFAULT_DAYS = 7;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Whole days between a unix-SECONDS timestamp and `now` (ms). */
function daysSince(unixSeconds: number | null, now: number): number | null {
  if (unixSeconds == null) return null;
  return Math.max(0, Math.floor((now / 1000 - unixSeconds) / 86_400));
}

interface MemoEntry { value: SourceDrift; expiresAt: number; }
const memo = new Map<string, MemoEntry>();
const TTL_MS = 2000;

/** Drop the memoized verdict for a repo (tests; post-fetch recomputation). */
export function invalidateSourceDrift(repoPath: string): void {
  memo.delete(repoPath);
}

/**
 * Gather git state and classify, memoized 2s per repo path.
 *
 * Returns **null** when `CORTEX_SOURCE_DRIFT=0` — distinct from an `unknown`
 * verdict. Null means "the gate is off, attach nothing"; `unknown` means "the
 * gate is on and git declined to answer". Callers must not conflate them.
 *
 * Needs no graph DB: this is pure git, so unlike freshness it answers on a repo
 * that has never been indexed — which is the checkout most likely to be sitting
 * on a dead branch.
 */
export function sourceDriftForContext(repoPath: string, now: number = Date.now()): SourceDrift | null {
  if (process.env.CORTEX_SOURCE_DRIFT === "0") return null;

  const hit = memo.get(repoPath);
  if (hit && hit.expiresAt > now) return hit.value;

  const isGit = isGitRepo(repoPath);
  const base = isGit ? resolveBaseRef(repoPath) : null;
  const commitsBehind = base ? gitCommitsBehindRef(repoPath, base.ref) : null;
  const forkPoint = base ? gitMergeBase(repoPath, "HEAD", base.ref) : null;

  const value = classifySourceDrift({
    isGit,
    base,
    commitsBehind,
    forkAgeDays: daysSince(forkPoint ? gitCommitTime(repoPath, forkPoint) : null, now),
    baseRefAgeDays: daysSince(base ? gitCommitTime(repoPath, base.ref) : null, now),
    commitsThreshold: envInt("CORTEX_SOURCE_DRIFT_COMMITS", DEFAULT_COMMITS),
    daysThreshold: envInt("CORTEX_SOURCE_DRIFT_DAYS", DEFAULT_DAYS),
  });
  memo.set(repoPath, { value, expiresAt: now + TTL_MS });
  return value;
}

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

/**
 * Attach a source-drift verdict to an MCP text result.
 *
 * The structured `source_drift` field is attached for EVERY state, so a
 * programmatic consumer can apply its own policy without re-shelling git. The
 * human-visible ⚠ line is appended only for `behind`: `current` and `unknown`
 * are both silent, and neither is ever rendered as a clean bill of health.
 *
 * (Contrast {@link attachFreshness}, which returns the result untouched when
 * fresh. This one always records its data — the line is thresholded, the data
 * is not.)
 */
export function attachSourceDrift<T extends TextResult>(result: T, d: SourceDrift): T {
  (result as TextResult).source_drift = d;
  if (d.state !== "behind") return result;
  const line = `\n\n⚠ cortex source drift: ${d.note}`;
  const first = result.content?.find((c) => c.type === "text");
  if (first) first.text += line;
  return result;
}
