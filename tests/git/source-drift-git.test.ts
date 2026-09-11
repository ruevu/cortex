import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBaseRef, gitCommitsBehindRef, gitMergeBase, gitCommitTime, gitLastFetchTime,
} from "../../src/git/worktree-state.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-srcdrift-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  writeFileSync(join(root, "a.txt"), "1\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "seed"]);
  return root;
}

/** Point refs/remotes/origin/<name> at the current HEAD. */
function fakeRemoteBranch(root: string, name: string): void {
  execFileSync("git", ["-C", root, "update-ref", `refs/remotes/origin/${name}`, "HEAD"]);
}

/**
 * Configure the current branch to track origin/<name>.
 *
 * `withFetchRefspec` is the difference between a working upstream and the
 * half-configured one git rejects: without `remote.origin.fetch`, git cannot
 * map refs/heads/<name> onto refs/remotes/origin/<name> and `@{upstream}` fails
 * with "not stored as a remote-tracking branch".
 */
function setUpstream(root: string, name: string, opts: { withFetchRefspec: boolean }): void {
  const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", root, "config", `branch.${branch}.remote`, "origin"]);
  execFileSync("git", ["-C", root, "config", `branch.${branch}.merge`, `refs/heads/${name}`]);
  if (opts.withFetchRefspec) {
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "."]);
    execFileSync("git", ["-C", root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
}

describe("resolveBaseRef", () => {
  it("returns null when there is no upstream, no origin/HEAD and no probe hit", () => {
    expect(resolveBaseRef(repo())).toBeNull();
  });

  it("resolves origin/HEAD when it is set", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/main", source: "origin_head" });
  });

  it("falls back to a VERIFIED origin/main probe when origin/HEAD is unset", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/main", source: "probe" });
  });

  it("probes origin/master when origin/main does not exist", () => {
    const root = repo();
    fakeRemoteBranch(root, "master");
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/master", source: "probe" });
  });

  it("prefers a configured upstream over origin/HEAD", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    fakeRemoteBranch(root, "feat");
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    setUpstream(root, "feat", { withFetchRefspec: true });
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/feat", source: "upstream" });
  });

  // Real shape, observed on a live worktree: branch.<b>.merge is configured but
  // the remote-tracking ref is not reachable through a fetch refspec, so git
  // fails @{upstream} with "not stored as a remote-tracking branch". Falling
  // through to origin/HEAD is the whole point of the ladder — a half-configured
  // upstream must not strand the signal.
  it("falls through to origin/HEAD when the upstream is configured but unresolvable", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    setUpstream(root, "feat", { withFetchRefspec: false });
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/main", source: "origin_head" });
  });

  it("returns null outside a git repo", () => {
    expect(resolveBaseRef(mkdtempSync(join(tmpdir(), "cortex-nogit-")))).toBeNull();
  });

  // `git push -u` — which this repo's own workflow prescribes for every release
  // — makes feature/x track origin/feature/x. That is a PUBLISHING target, not
  // an integration base: measuring against it reports 0 behind however far main
  // has moved. Caught live: a branch 40 commits behind main read `current`.
  it("SKIPS an upstream that is just this branch's own published copy", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    execFileSync("git", ["-C", root, "checkout", "-q", "-b", "feature/x"]);
    fakeRemoteBranch(root, "feature/x");
    setUpstream(root, "feature/x", { withFetchRefspec: true });
    // Sanity: git itself resolves the upstream — we are choosing to ignore it.
    expect(execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim())
      .toBe("origin/feature/x");
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/main", source: "origin_head" });
  });

  it("still honours an upstream that names a DIFFERENT branch", () => {
    const root = repo();
    fakeRemoteBranch(root, "main");
    fakeRemoteBranch(root, "develop");
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    execFileSync("git", ["-C", root, "checkout", "-q", "-b", "feature/y"]);
    setUpstream(root, "develop", { withFetchRefspec: true });
    expect(resolveBaseRef(root)).toEqual({ ref: "origin/develop", source: "upstream" });
  });
});

describe("gitLastFetchTime", () => {
  it("returns null when the repo has never fetched", () => {
    expect(gitLastFetchTime(repo())).toBeNull();
  });

  it("reports the FETCH_HEAD mtime, NOT the base ref's commit age", () => {
    const root = repo();
    // A tip commit backdated 30 days, then a fetch that happens right now.
    const old = Math.floor(Date.now() / 1000) - 30 * 86_400;
    writeFileSync(join(root, "b.txt"), "2\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "old"], {
      env: { ...process.env, GIT_AUTHOR_DATE: `${old} +0000`, GIT_COMMITTER_DATE: `${old} +0000` },
    });
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "."]);
    execFileSync("git", ["-C", root, "fetch", "-q", "origin"]);

    const fetched = gitLastFetchTime(root)!;
    expect(fetched).toBeGreaterThan(Math.floor(Date.now() / 1000) - 120);
    // The distinction the old implementation collapsed: the tip is a month old,
    // the fetch is seconds old, and only the latter is "how current is my view
    // of the remote".
    expect(fetched - gitCommitTime(root, "HEAD")!).toBeGreaterThan(29 * 86_400);
  });

  it("returns null outside a git repo", () => {
    expect(gitLastFetchTime(mkdtempSync(join(tmpdir(), "cortex-nofetch-")))).toBeNull();
  });

  // FETCH_HEAD is per-worktree, so a fetch run from the MAIN checkout leaves a
  // linked worktree's copy absent. Reading only the worktree's own would make
  // the answer depend on which checkout ran `git fetch` — and in Mesh, where
  // worktrees are manufactured per thread and rarely fetch themselves, that is
  // the common case.
  it("sees a fetch performed in the main checkout from a linked worktree", () => {
    const root = repo();
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "."]);
    execFileSync("git", ["-C", root, "fetch", "-q", "origin"]);
    const wt = mkdtempSync(join(tmpdir(), "cortex-linked-")) + "/wt";
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "side", wt]);

    // The worktree itself has never fetched...
    const own = execFileSync("git", ["-C", wt, "rev-parse", "--git-path", "FETCH_HEAD"], { encoding: "utf8" }).trim();
    expect(existsSync(own.startsWith("/") ? own : join(wt, own))).toBe(false);
    // ...but the repo has, and that is what the question means.
    expect(gitLastFetchTime(wt)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 120);
  });
});

describe("gitCommitsBehindRef", () => {
  it("counts commits on the base that HEAD does not have", () => {
    const root = repo();
    const start = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "b.txt"), "2\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "second"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    execFileSync("git", ["-C", root, "reset", "-q", "--hard", start]);
    expect(gitCommitsBehindRef(root, "origin/main")).toBe(1);
  });

  it("returns 0 when HEAD is level with the base", () => {
    const root = repo();
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(gitCommitsBehindRef(root, "origin/main")).toBe(0);
  });

  it("returns null for a ref git cannot resolve", () => {
    expect(gitCommitsBehindRef(repo(), "origin/nope")).toBeNull();
  });
});

describe("gitMergeBase + gitCommitTime", () => {
  it("finds the fork point and reads its commit time in unix seconds", () => {
    const root = repo();
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    const mb = gitMergeBase(root, "HEAD", "origin/main");
    expect(mb).toMatch(/^[0-9a-f]{40}$/);
    const t = gitCommitTime(root, mb!);
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(1_600_000_000);
  });

  it("returns null when the two revs share no history", () => {
    const root = repo();
    const original = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", root, "checkout", "-q", "--orphan", "other"]);
    writeFileSync(join(root, "c.txt"), "3\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "orphan"]);
    expect(gitMergeBase(root, "HEAD", original)).toBeNull();
  });

  it("returns null for an unknown rev", () => {
    expect(gitCommitTime(repo(), "0".repeat(40))).toBeNull();
  });
});
