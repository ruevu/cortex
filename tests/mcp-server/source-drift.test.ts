import { describe, it, expect } from "vitest";
import { classifySourceDrift } from "../../src/mcp-server/source-drift.js";

const base = {
  isGit: true,
  base: { ref: "origin/main", source: "origin_head" as const },
  commitsBehind: 0,
  forkAgeDays: 0,
  baseRefAgeDays: 0,
  commitsThreshold: 25,
  daysThreshold: 7,
};

describe("classifySourceDrift", () => {
  it("current when level with the base", () => {
    const d = classifySourceDrift(base);
    expect(d.state).toBe("current");
    expect(d.note).toBeUndefined();
  });

  it("current but still carrying the raw numbers below both thresholds", () => {
    const d = classifySourceDrift({ ...base, commitsBehind: 5, forkAgeDays: 2 });
    expect(d.state).toBe("current");
    expect(d.commits_behind).toBe(5);
    expect(d.fork_age_days).toBe(2);
  });

  it("behind on the commit axis alone", () => {
    const d = classifySourceDrift({ ...base, commitsBehind: 25, forkAgeDays: 1 });
    expect(d.state).toBe("behind");
    expect(d.note).toContain("25 commit(s) behind origin/main");
  });

  it("behind on the age axis alone", () => {
    const d = classifySourceDrift({ ...base, commitsBehind: 18, forkAgeDays: 12 });
    expect(d.state).toBe("behind");
    expect(d.note).toContain("forked 12d ago");
  });

  it("adds the fetch-age caveat only when the base ref is itself stale", () => {
    const stale = classifySourceDrift({ ...base, commitsBehind: 30, baseRefAgeDays: 10 });
    expect(stale.note).toContain("last fetched 10d ago");
    expect(stale.note).toContain("count may understate");
    const fresh = classifySourceDrift({ ...base, commitsBehind: 30, baseRefAgeDays: 1 });
    expect(fresh.note).not.toContain("last fetched");
  });

  it("unknown and SILENT when not a git repo", () => {
    const d = classifySourceDrift({ ...base, isGit: false });
    expect(d.state).toBe("unknown");
    expect(d.commits_behind).toBeUndefined();
  });

  it("unknown when no base ref resolves", () => {
    expect(classifySourceDrift({ ...base, base: null }).state).toBe("unknown");
  });

  it("unknown when the count is uncomputable", () => {
    expect(classifySourceDrift({ ...base, commitsBehind: null }).state).toBe("unknown");
  });

  it("unknown when the fork point was rebased away", () => {
    expect(classifySourceDrift({ ...base, forkAgeDays: null }).state).toBe("unknown");
  });

  it("NEVER reports current off a failed git call", () => {
    for (const bad of [
      { ...base, isGit: false },
      { ...base, base: null },
      { ...base, commitsBehind: null },
      { ...base, forkAgeDays: null },
    ]) {
      expect(classifySourceDrift(bad).state).not.toBe("current");
    }
  });

  it("respects raised thresholds", () => {
    const d = classifySourceDrift({
      ...base, commitsBehind: 30, forkAgeDays: 10,
      commitsThreshold: 100, daysThreshold: 90,
    });
    expect(d.state).toBe("current");
  });

  it("records where the base ref came from", () => {
    const d = classifySourceDrift({ ...base, base: { ref: "origin/feat", source: "upstream" } });
    expect(d.base_ref).toBe("origin/feat");
    expect(d.base_source).toBe("upstream");
  });
});
