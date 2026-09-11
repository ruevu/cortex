import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBaseRef, gitCommitsBehindRef, gitMergeBase, gitCommitTime,
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
