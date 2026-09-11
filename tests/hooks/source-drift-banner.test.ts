import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/check-index.sh");
const LINE = "⚠ cortex source drift: 170 commit(s) behind origin/main — forked 9d ago";

/** `indexed` controls whether a non-empty .cortex/db exists — the hook's own
 *  test for index state, and the branch selector we care about here. */
function repo(indexed: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-sd-banner-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  if (indexed) {
    mkdirSync(join(root, ".cortex"), { recursive: true });
    writeFileSync(join(root, ".cortex", "db"), "not-really-a-db-but-non-empty");
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  return root;
}

function fakeCortex(root: string, sourceDriftOut: string): void {
  const bin = join(root, "bin", "cortex");
  writeFileSync(bin,
    `#!/bin/sh\n` +
    `case "$1" in\n` +
    `  source-drift) printf '%s\\n' ${JSON.stringify(sourceDriftOut)} ;;\n` +
    `  staleness) : ;;\n` +
    `  reconcile) printf '56\\n' ;;\n` +
    `  freshness) printf 'fresh\\n' ;;\n` +
    `  decision) printf '1\\n' ;;\n` +
    `  *) : ;;\n` +
    `esac\n`);
  chmodSync(bin, 0o755);
}

function runHook(root: string): string {
  const env = { ...(process.env as Record<string, string>) };
  for (const k of ["CORTEX_BIN", "CLAUDE_PLUGIN_ROOT", "CORTEX_STALENESS"]) delete env[k];
  env.CORTEX_AUTO_INDEX = "0";
  env.CORTEX_AUTO_REFRESH = "0";
  env.CORTEX_BRIEF = "0";
  env.CORTEX_GC = "0";
  return execFileSync("bash", [HOOK], {
    cwd: root, env, encoding: "utf8",
    input: JSON.stringify({ session_id: "s1", source: "startup", cwd: root }),
  });
}

describe("check-index.sh source-drift banner", () => {
  it("prints the line on an INDEXED repo whose checkout is behind", () => {
    const root = repo(true);
    fakeCortex(root, LINE);
    expect(runHook(root)).toContain("170 commit(s) behind origin/main");
  });

  // The unindexed checkout is the likeliest dead tree of all — freshly created,
  // often on a branch that merged weeks ago — and source drift is pure git, so
  // it is the one staleness signal that can still answer there.
  it("prints the line on an UNINDEXED repo too", () => {
    const root = repo(false);
    fakeCortex(root, LINE);
    expect(runHook(root)).toContain("170 commit(s) behind origin/main");
  });

  it("prints nothing when the command is silent", () => {
    const root = repo(true);
    fakeCortex(root, "");
    expect(runHook(root)).not.toContain("source drift");
  });

  it("degrades safely when the CLI does not know the command", () => {
    const root = repo(true);
    const bin = join(root, "bin", "cortex");
    writeFileSync(bin, `#!/bin/sh\nexit 1\n`);
    chmodSync(bin, 0o755);
    expect(() => runHook(root)).not.toThrow();
  });
});
