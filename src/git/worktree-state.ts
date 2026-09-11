import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** True when `repo` is inside a git work tree. */
export function isGitRepo(repo: string): boolean {
  return git(repo, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** Current HEAD commit SHA, or null when unavailable (non-git / no commits). */
export function gitHead(repo: string): string | null {
  const out = git(repo, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

/** sha1 of `git status --porcelain` — a stable signature of the working-tree
 *  state (tracked modifications + non-ignored untracked). null outside git.
 *  Empty/clean tree still yields a (constant) hash of the empty string. */
export function gitDirtySig(repo: string): string | null {
  const out = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (out === null) return null;
  return createHash("sha1").update(out).digest("hex");
}

/** Number of commits on HEAD since `base`, or null if uncomputable (e.g. base
 *  was rebased away). */
export function gitCommitsBehind(repo: string, base: string): number | null {
  const out = git(repo, ["rev-list", "--count", `${base}..HEAD`]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Where a base ref came from — recorded so a reader can judge the number. */
export type BaseRefSource = "upstream" | "origin_head" | "probe";
export interface BaseRef { ref: string; source: BaseRefSource; }

/**
 * The ref this checkout should be judged against, or null when git cannot say.
 *
 * Order:
 *   1. `@{upstream}`, but ONLY when it names something other than this branch's
 *      own namesake (see below).
 *   2. `origin/HEAD` — the integration branch.
 *   3. A VERIFIED probe of `origin/main` then `origin/master`.
 *
 * WHY UPSTREAM IS NOT SIMPLY PREFERRED. `git push -u` — which this repo's own
 * workflow prescribes for every release — sets `feature/x`'s upstream to
 * `origin/feature/x`. That ref is a PUBLISHING target, not an integration base:
 * measuring against it reports 0 behind no matter how far `origin/main` has
 * moved. Verified: a branch 40 commits behind main read `current` under the
 * naive ordering, silencing the signal on exactly the case it exists to catch.
 * So a self-named upstream is skipped, while a genuinely different one
 * (`feature/x` tracking `origin/develop`) is honoured as the more specific
 * statement of intent it actually is.
 *
 * The probe is a probe, not a guess: `origin/HEAD` is only set by `git clone`
 * or an explicit `git remote set-head`, so a repo created locally and later
 * given a remote legitimately lacks it. We ask git whether the ref exists and
 * use it only if it resolves. Null means UNKNOWABLE — callers must stay silent
 * rather than assume a default branch name we never confirmed.
 */
export function resolveBaseRef(repo: string): BaseRef | null {
  const up = git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"])?.trim();
  if (up && !isOwnNamesake(repo, up)) return { ref: up, source: "upstream" };

  const head = git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (head) return { ref: head, source: "origin_head" };

  for (const cand of ["origin/main", "origin/master"]) {
    if (git(repo, ["rev-parse", "--verify", "-q", cand]) !== null) {
      return { ref: cand, source: "probe" };
    }
  }
  return null;
}

/** True when `upstreamRef` ("origin/feature/x") is just this branch's own
 *  published copy — i.e. a push target rather than something to measure against. */
function isOwnNamesake(repo: string, upstreamRef: string): boolean {
  const branch = gitBranch(repo);
  if (!branch) return false;
  const slash = upstreamRef.indexOf("/");
  if (slash < 0) return upstreamRef === branch;
  return upstreamRef.slice(slash + 1) === branch;
}

/**
 * When this repo last fetched, in unix SECONDS, from `FETCH_HEAD`'s mtime —
 * or null when it has never fetched.
 *
 * NOT the base ref's commit time. A slow-moving repo fetched a minute ago has a
 * month-old tip commit, and reporting that as "last fetched a month ago" is a
 * fabrication of exactly the kind this signal exists to prevent. `--git-path`
 * resolves through a linked worktree to the common git dir, where FETCH_HEAD
 * actually lives.
 */
export function gitLastFetchTime(repo: string): number | null {
  // FETCH_HEAD is PER-WORKTREE: a fetch run from the main checkout writes the
  // common dir's copy and leaves a linked worktree's absent. Checking only one
  // makes the answer depend on which checkout happened to run `git fetch`, so
  // take the newer of both — that is "when did this repo last ask the remote",
  // which is the question regardless of where it was asked from.
  const candidates = [
    git(repo, ["rev-parse", "--git-path", "FETCH_HEAD"])?.trim(),
    (() => {
      const common = git(repo, ["rev-parse", "--git-common-dir"])?.trim();
      return common ? `${common}/FETCH_HEAD` : undefined;
    })(),
  ];

  let newest: number | null = null;
  for (const p of candidates) {
    if (!p) continue;
    const abs = p.startsWith("/") ? p : `${repo}/${p}`;
    try {
      const t = Math.floor(statSync(abs).mtimeMs / 1000);
      if (newest == null || t > newest) newest = t;
    } catch { /* absent — this checkout never fetched */ }
  }
  // null = never fetched anywhere. Unknowable, NOT "long ago": the caller must
  // omit the caveat rather than invent a duration.
  return newest;
}

/** Commits on `ref` that HEAD does not have — how far BEHIND the checkout is.
 *  (Contrast {@link gitCommitsBehind}, which counts the other direction, against
 *  the index baseline.) null when git cannot resolve the ref. */
export function gitCommitsBehindRef(repo: string, ref: string): number | null {
  const out = git(repo, ["rev-list", "--count", `HEAD..${ref}`]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Fork point of two revs, or null when they share no history. */
export function gitMergeBase(repo: string, a: string, b: string): string | null {
  const out = git(repo, ["merge-base", a, b]);
  return out?.trim() || null;
}

/** Commit time of `rev` in unix SECONDS, or null when unresolvable. */
export function gitCommitTime(repo: string, rev: string): number | null {
  const out = git(repo, ["log", "-1", "--format=%ct", rev]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Current branch name, or null when detached / not a git repo. */
export function gitBranch(repoPath: string): string | null {
  const out = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!out) return null;
  const name = out.trim();
  return name && name !== "HEAD" ? name : null;
}

/**
 * Repo-relative paths that changed since `sinceCommit`, union everything dirty
 * in the working tree right now.
 *
 * Returns `null` when git cannot answer — outside a repo, or when
 * `sinceCommit` no longer exists (rebased or squashed away). null means
 * **unknown**, and a caller must treat it as "cannot scope", NEVER as "nothing
 * changed": the latter would silently itemize nothing forever after a rebase.
 *
 * Rename entries in porcelain v1 read "R  old -> new"; only the destination is
 * recorded. Paths containing characters git quotes (`core.quotePath`) are
 * recorded in their quoted form and will simply fail to match a governed ref —
 * an under-report, which costs an itemization, never a false one.
 */
export function gitChangedFiles(repo: string, sinceCommit: string | null): Set<string> | null {
  const out = new Set<string>();
  if (sinceCommit) {
    const diff = git(repo, ["diff", "--name-only", `${sinceCommit}..HEAD`]);
    if (diff === null) return null; // unknown base — cannot scope
    for (const line of diff.split("\n")) {
      const p = line.trim();
      if (p) out.add(p);
    }
  }
  // `--untracked-files=all`, not `normal`: `normal` collapses an untracked
  // DIRECTORY to a single "newdir/" entry, so a governed ref "newdir/x.ts"
  // would never match. Under-reporting only costs an itemization, but the
  // cost of `all` is one extra readdir walk on an already-dirty tree.
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === null) return sinceCommit ? out : null;
  for (const line of status.split("\n")) {
    const p = line.slice(3).trim(); // "XY <path>"
    if (!p) continue;
    const arrow = p.indexOf(" -> ");
    out.add(arrow >= 0 ? p.slice(arrow + 4) : p);
  }
  return out;
}

/**
 * Every branch name git still knows: local heads plus remote-tracking branches
 * with their remote prefix stripped (`origin/foo` → `foo`), since that is the
 * form `origin_branch` stores. `origin/HEAD` is dropped — a symbolic pointer,
 * not a branch anyone authored on.
 *
 * Returns `null` outside a git repo. The C4 set difference treats null as "no
 * conclusion possible" rather than "every branch is gone".
 */
export function gitKnownBranches(repo: string): Set<string> | null {
  const out = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  if (out === null) return null;

  // Strip the LONGEST configured remote name, not everything before the first
  // "/". Git accepts a remote whose name contains a slash (`git remote add
  // a/b …`), and branch names routinely contain slashes too, so a naive
  // indexOf("/") turns refs/remotes/upstream/mirror/feature/x into
  // "mirror/feature/x" — and a live `feature/x` then reads as a concluded
  // branch, the one thing C4 must not do. Remotes are sorted longest-first so
  // "origin/sub" wins over "origin" when both exist.
  const remotes = (git(repo, ["remote"]) ?? "")
    .split("\n").map((r) => r.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const names = new Set<string>();
  for (const raw of out.split("\n")) {
    const ref = raw.trim();
    if (ref.startsWith("refs/heads/")) {
      names.add(ref.slice("refs/heads/".length));
      continue;
    }
    if (!ref.startsWith("refs/remotes/")) continue;
    const rest = ref.slice("refs/remotes/".length); // "<remote>/<branch…>"
    const remote = remotes.find((r) => rest.startsWith(r + "/"));
    // Fall back to the first segment when no configured remote matches (a
    // leftover remote-tracking ref for a deleted remote); better a slightly
    // wrong name than dropping the ref and calling a live branch concluded.
    const branch = remote != null
      ? rest.slice(remote.length + 1)
      : rest.slice(rest.indexOf("/") + 1);
    if (branch && branch !== "HEAD" && !rest.startsWith("/")) names.add(branch);
  }
  return names;
}
