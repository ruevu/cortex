import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baselinePath, loadTargets, mergeTargets } from "../../evals/src/target-config.js";
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
  it("baselinePath routes private baselines under private/", () => {
    expect(baselinePath({ name: "mesh", private: true })).toBe(resolve("evals/baselines/private/mesh.json"));
    expect(baselinePath({ name: "cortex" })).toBe(resolve("evals/baselines/cortex.json"));
  });
});

describe("loadTargets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-targets-"));
    writeFileSync(join(dir, "targets.json"), JSON.stringify(pub));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("says so when the private targets file is absent, rather than gating fewer targets silently", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir).map((t) => t.name)).toEqual(["cortex"]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      "note: no evals/targets.private.json — private targets (mesh) are not in this run",
    );
  });

  it("merges the private targets file when present, without the note", () => {
    writeFileSync(join(dir, "targets.private.json"), JSON.stringify(priv));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTargets(dir).map((t) => [t.name, t.private])).toEqual([["cortex", undefined], ["mesh", true]]);
    expect(err).not.toHaveBeenCalled();
  });
});
