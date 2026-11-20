import { describe, it, expect } from "vitest";
import { classifyFreshness } from "../../src/mcp-server/freshness.js";

const base = {
  canonical: true,
  nodeCount: 100,
  meta: { indexed_commit: "AAA", indexed_dirty_sig: "sig", indexed_at: "2026-06-07T00:00:00Z" },
  isGit: true,
  curHead: "AAA",
  curDirtySig: "sig",
  commitsBehind: 0,
};

describe("classifyFreshness", () => {
  it("fresh when head + dirty-sig match the baseline", () => {
    expect(classifyFreshness(base).state).toBe("fresh");
  });
  it("stale:dirty when only the working tree changed", () => {
    expect(classifyFreshness({ ...base, curDirtySig: "other" }).state).toBe("stale:dirty");
  });
  it("stale:commits (with count) when HEAD moved", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: 3 });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBe(3);
  });
  it("stale:both when head and dirty-sig differ", () => {
    expect(classifyFreshness({ ...base, curHead: "BBB", curDirtySig: "other" }).state).toBe("stale:both");
  });
  it("empty when not canonical (fallback DB)", () => {
    expect(classifyFreshness({ ...base, canonical: false }).state).toBe("empty");
  });
  it("empty when node count is zero", () => {
    expect(classifyFreshness({ ...base, nodeCount: 0 }).state).toBe("empty");
  });
  it("unknown when no baseline meta", () => {
    expect(classifyFreshness({ ...base, meta: null }).state).toBe("unknown");
  });
  it("unknown when not a git repo", () => {
    expect(classifyFreshness({ ...base, isGit: false }).state).toBe("unknown");
  });
  it("omits commits_behind when uncomputable after a rebase", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: null });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBeUndefined();
  });

  // An index built on an unborn branch (`git init`, no commit yet) records a
  // baseline with indexed_commit = null. That is a TRACKED baseline, not a
  // pre-tracking index: reading it as "unknown — indexed before freshness
  // tracking" made check-index.sh rebuild on every session, forever, and never
  // notice when the first commits landed.
  describe("index built before the first commit", () => {
    const unborn = { ...base, meta: { ...base.meta, indexed_commit: null }, commitsBehind: null };

    it("fresh while there is still no commit and the tree is unchanged", () => {
      expect(classifyFreshness({ ...unborn, curHead: null }).state).toBe("fresh");
    });
    it("stale:dirty while there is still no commit but the tree changed", () => {
      expect(classifyFreshness({ ...unborn, curHead: null, curDirtySig: "other" }).state).toBe("stale:dirty");
    });
    it("stale:commits once the first commit lands", () => {
      const f = classifyFreshness({ ...unborn, curHead: "AAA" });
      expect(f.state).toBe("stale:commits");
      expect(f.note).toMatch(/HEAD moved since index/);
    });
  });
});
