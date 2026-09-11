import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSourceDriftCommand } from "../../src/cli/commands/source-drift.js";
import { invalidateSourceDrift } from "../../src/mcp-server/source-drift.js";

/** A repo whose HEAD sits `n` commits behind origin/main. Never indexed —
 *  source drift is pure git and must answer without a graph DB. */
function repoBehindBy(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-cli-sd-"));
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
  invalidateSourceDrift(realpathSync(root));
  return root;
}

function capture(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out += String(c); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return out;
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.CORTEX_SOURCE_DRIFT; });

describe("cortex source-drift", () => {
  it("prints the line when the checkout is behind", () => {
    const out = capture(() => runSourceDriftCommand(repoBehindBy(30)));
    expect(out).toContain("⚠ cortex source drift:");
    expect(out).toContain("30 commit(s) behind origin/main");
  });

  it("prints NOTHING when the checkout is current", () => {
    expect(capture(() => runSourceDriftCommand(repoBehindBy(1)))).toBe("");
  });

  it("prints NOTHING when no base ref resolves", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-sd-bare-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", root, "config", "user.name", "T"]);
    writeFileSync(join(root, "a.txt"), "0\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "seed"]);
    invalidateSourceDrift(realpathSync(root));
    expect(capture(() => runSourceDriftCommand(root))).toBe("");
  });

  it("prints NOTHING when CORTEX_SOURCE_DRIFT=0", () => {
    const root = repoBehindBy(30);
    process.env.CORTEX_SOURCE_DRIFT = "0";
    expect(capture(() => runSourceDriftCommand(root))).toBe("");
  });

  it("answers on a repo that was never indexed (no .cortex/db)", () => {
    expect(capture(() => runSourceDriftCommand(repoBehindBy(30)))).toContain("source drift");
  });
});
