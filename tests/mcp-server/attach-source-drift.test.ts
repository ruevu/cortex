import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachSourceDrift, sourceDriftForContext, invalidateSourceDrift,
  type SourceDrift,
} from "../../src/mcp-server/source-drift.js";

const behind: SourceDrift = {
  state: "behind", base_ref: "origin/main", base_source: "origin_head",
  commits_behind: 18, fork_age_days: 12,
  note: "18 commit(s) behind origin/main — forked 12d ago",
};
const current: SourceDrift = {
  state: "current", base_ref: "origin/main", base_source: "origin_head",
  commits_behind: 2, fork_age_days: 1,
};
const unknown: SourceDrift = { state: "unknown", note: "not a git repository" };

afterEach(() => {
  delete process.env.CORTEX_SOURCE_DRIFT;
  delete process.env.CORTEX_SOURCE_DRIFT_COMMITS;
});

describe("attachSourceDrift", () => {
  it("appends a warning line when behind", () => {
    const r = { content: [{ type: "text", text: "hits" }] };
    const out = attachSourceDrift(r, behind) as typeof r & { source_drift?: SourceDrift };
    expect(out.content[0].text).toContain("hits");
    expect(out.content[0].text).toContain("⚠ cortex source drift: 18 commit(s) behind origin/main");
    expect(out.source_drift).toEqual(behind);
  });

  it("attaches the DATA but no line when current", () => {
    const r = { content: [{ type: "text", text: "hits" }] };
    const out = attachSourceDrift(r, current) as typeof r & { source_drift?: SourceDrift };
    expect(out.content[0].text).toBe("hits");
    expect(out.source_drift).toEqual(current);
  });

  it("stays SILENT on unknown — never a reassurance", () => {
    const r = { content: [{ type: "text", text: "hits" }] };
    const out = attachSourceDrift(r, unknown) as typeof r & { source_drift?: SourceDrift };
    expect(out.content[0].text).toBe("hits");
    expect(out.content[0].text).not.toContain("source drift");
  });

  it("leaves a result with no text content structurally valid", () => {
    const r = { content: [] as Array<{ type: string; text: string }> };
    const out = attachSourceDrift(r, behind) as typeof r & { source_drift?: SourceDrift };
    expect(out.source_drift).toEqual(behind);
  });
});

/** A repo whose HEAD sits `n` commits behind origin/main. */
function repoBehindBy(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-sd-ctx-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  writeFileSync(join(root, "a.txt"), "0\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "seed"]);
  const start = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (let k = 0; k < n; k++) {
    writeFileSync(join(root, `f${k}.txt`), `${k}\n`);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", `c${k}`]);
  }
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  execFileSync("git", ["-C", root, "reset", "-q", "--hard", start]);
  return root;
}

describe("sourceDriftForContext", () => {
  it("reports behind against a real repo past the commit threshold", () => {
    const root = repoBehindBy(30);
    const d = sourceDriftForContext(root)!;
    expect(d.state).toBe("behind");
    expect(d.commits_behind).toBe(30);
    expect(d.base_ref).toBe("origin/main");
  });

  it("reports current when under both thresholds", () => {
    const d = sourceDriftForContext(repoBehindBy(2))!;
    expect(d.state).toBe("current");
    expect(d.commits_behind).toBe(2);
  });

  it("returns unknown (not a crash) outside a git repo", () => {
    const d = sourceDriftForContext(mkdtempSync(join(tmpdir(), "cortex-sd-nogit-")))!;
    expect(d.state).toBe("unknown");
  });

  it("returns null when CORTEX_SOURCE_DRIFT=0 so nothing is attached", () => {
    const root = repoBehindBy(30);
    invalidateSourceDrift(root);
    process.env.CORTEX_SOURCE_DRIFT = "0";
    expect(sourceDriftForContext(root)).toBeNull();
  });

  it("honours a raised commit threshold from the environment", () => {
    const root = repoBehindBy(30);
    invalidateSourceDrift(root);
    process.env.CORTEX_SOURCE_DRIFT_COMMITS = "100";
    expect(sourceDriftForContext(root)!.state).toBe("current");
  });

  it("memoizes per repo path within the TTL", () => {
    const root = repoBehindBy(30);
    invalidateSourceDrift(root);
    const first = sourceDriftForContext(root)!;
    // Same clock => same memo window => identical object identity.
    expect(sourceDriftForContext(root)).toBe(first);
  });
});
