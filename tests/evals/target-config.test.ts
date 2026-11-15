import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { baselinePath, loadTargets, mergeTargets, privateEvalsDir } from "../../evals/src/target-config.js";
import type { Targets } from "../../evals/src/assertions/types.js";

const pub: Targets = {
  targets: [{ name: "cortex", repo_url: "https://example.test/cortex.git", sha: "abc", packs: ["universal"], suites: ["self"] }],
};
const priv: Targets = {
  targets: [{ name: "mesh", repo_url: "file:///somewhere/mesh", sha: "def", packs: ["universal"], suites: ["self"] }],
};

describe("mergeTargets", () => {
  it("mergeTargets marks private targets", () => {
    const merged = mergeTargets(pub, priv);
    expect(merged.map((t) => [t.name, t.private])).toEqual([["cortex", undefined], ["mesh", true]]);
  });

  it("mergeTargets rejects a duplicate name", () => {
    const clash: Targets = { targets: [{ ...priv.targets[0]!, name: "cortex" }] };
    expect(() => mergeTargets(pub, clash)).toThrow(/"cortex"/);
  });

  it("mergeTargets with no private file returns the public list unchanged", () => {
    expect(mergeTargets(pub, null)).toEqual(pub.targets);
  });
});

describe("baselinePath", () => {
  it("keeps public baselines in the committed directory", () => {
    expect(baselinePath({ name: "cortex" })).toBe(resolve("evals/baselines/cortex.json"));
    expect(baselinePath({ name: "cortex" }, "/e", "/p")).toBe(join("/e", "baselines", "cortex.json"));
  });

  it("keeps private baselines in the private evals dir, outside every working tree", () => {
    expect(baselinePath({ name: "mesh", private: true }, "/e", "/p")).toBe(join("/p", "baselines", "mesh.json"));
  });

  it("refuses a private baseline when the repository has no private evals dir", () => {
    expect(() => baselinePath({ name: "mesh", private: true }, "/e", null)).toThrow(/"mesh"/);
  });
});

describe("loadTargets", () => {
  let dir: string;
  let privDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-targets-"));
    privDir = mkdtempSync(join(tmpdir(), "cortex-private-evals-"));
    writeFileSync(join(dir, "targets.json"), JSON.stringify(pub));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    rmSync(privDir, { recursive: true, force: true });
  });

  it("says so when the private targets file is absent, rather than gating fewer targets silently", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir, privDir).map((t) => t.name)).toEqual(["cortex"]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      `note: no private targets file at ${join(privDir, "targets.private.json")} — private targets (mesh) are not in this run`,
    );
  });

  it("reads the private targets from the private evals dir, without the note", () => {
    writeFileSync(join(privDir, "targets.private.json"), JSON.stringify(priv));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir, privDir).map((t) => [t.name, t.private])).toEqual([["cortex", undefined], ["mesh", true]]);
    expect(err).not.toHaveBeenCalled();
  });

  it("never reads a private targets file from the checkout", () => {
    writeFileSync(join(dir, "targets.private.json"), JSON.stringify(priv));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir, privDir).map((t) => t.name)).toEqual(["cortex"]);
  });

  it("says so when the repository has no id to find its private evals dir by", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir, null).map((t) => t.name)).toEqual(["cortex"]);
    expect(err).toHaveBeenCalledWith(
      "note: no repository id in cortex.json — private targets (mesh) are not in this run",
    );
  });
});

describe("privateEvalsDir", () => {
  const savedHome = process.env.CORTEX_HOME;
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-private-dir-")));
    process.env.CORTEX_HOME = join(base, "home");
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  });

  /** A repository with one commit, carrying a committed repo id or not. */
  function repo(withId: boolean): string {
    const dir = join(base, "repo");
    execFileSync("git", ["init", "-q", dir]);
    if (withId) writeFileSync(join(dir, "cortex.json"), JSON.stringify({ repoId: "rid-evals-test" }));
    writeFileSync(join(dir, "a.txt"), "a\n");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", [
      "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false",
      "commit", "-qm", "init",
    ]);
    return dir;
  }

  it("is one directory for the main checkout and every linked worktree, in the repository's store", () => {
    const main = repo(true);
    const wt = join(base, "wt");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", wt]);
    const expected = join(base, "home", ".cortex", "rid-evals-test", "evals");
    expect(privateEvalsDir(main)).toBe(expected);
    expect(privateEvalsDir(wt)).toBe(expected);
  });

  it("is null, and mints no id, where the repository has none", () => {
    const main = repo(false);
    expect(privateEvalsDir(main)).toBeNull();
    expect(existsSync(join(main, "cortex.json"))).toBe(false);
  });
});
