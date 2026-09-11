import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerTool, RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { invalidateSourceDrift } from "../../src/mcp-server/source-drift.js";

/**
 * An indexed-looking repo whose HEAD sits `n` commits behind origin/main.
 * `.cortex/db` is what the resolver keys on; its contents do not matter here
 * because freshness degrades to `empty` on an unreadable DB and this test is
 * about the OTHER axis.
 */
function repoBehindBy(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-rt-sd-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "");
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
  // ctx.repoPath is realpath-normalized, and that is the memo key.
  invalidateSourceDrift(realpathSync(root));
  return root;
}

function readTool(resolver: RepoContextResolver) {
  return registerTool(
    "fake_read",
    z.object({ repo_path: z.string() }),
    async () => ({ content: [{ type: "text", text: "payload" }] }),
    { resolver, freshnessAware: true },
  );
}

type Attached = { content: Array<{ text: string }>; source_drift?: { state: string; commits_behind?: number } };

afterEach(() => { delete process.env.CORTEX_SOURCE_DRIFT; });

describe("registerTool — source drift attachment", () => {
  it("attaches source_drift and a ⚠ line on a behind checkout", async () => {
    const repo = repoBehindBy(30);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    const out = await readTool(resolver)({ repo_path: repo }) as Attached;
    expect(out.source_drift?.state).toBe("behind");
    expect(out.source_drift?.commits_behind).toBe(30);
    expect(out.content[0].text).toContain("⚠ cortex source drift:");
  });

  it("attaches the data but NO line on a current checkout", async () => {
    const repo = repoBehindBy(1);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    const out = await readTool(resolver)({ repo_path: repo }) as Attached;
    expect(out.source_drift?.state).toBe("current");
    expect(out.content[0].text).not.toContain("source drift");
  });

  it("attaches nothing at all when CORTEX_SOURCE_DRIFT=0", async () => {
    const repo = repoBehindBy(30);
    process.env.CORTEX_SOURCE_DRIFT = "0";
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    const out = await readTool(resolver)({ repo_path: repo }) as Attached;
    expect(out.source_drift).toBeUndefined();
    expect(out.content[0].text).not.toContain("source drift");
  });

  it("leaves the payload itself intact ahead of both signal lines", async () => {
    const repo = repoBehindBy(30);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    const out = await readTool(resolver)({ repo_path: repo }) as Attached;
    expect(out.content[0].text.startsWith("payload")).toBe(true);
  });
});
