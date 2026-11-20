import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Which Cortex CLI do the hooks run? (T-085p)
//
// Mesh exports CORTEX_BIN pointing at its bundled sidecar CLI, and its plugin
// root (the sidecar tarball) ships no bin/cortex. check-index.sh and
// post-commit-refresh.sh used to ignore CORTEX_BIN and fall back to the open
// repo's ./bin/cortex — so inside a Cortex checkout a Mesh session ran that
// checkout's code against the graph, and everywhere else it ran nothing at all
// while the banner read a clean "indexed". A crashing CLI read the same way.

const CHECK_INDEX = join(process.cwd(), "hooks/check-index.sh");
const POST_COMMIT = join(process.cwd(), "hooks/post-commit-refresh.sh");

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

/** Indexed-looking real git repo (non-empty .cortex/db). */
function indexedRepo(): string {
  const root = tmp("cortex-cli-res-repo-");
  execFileSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "non-empty");
  return root;
}

/** A stub CLI at `path` that appends `<label> <args>` to `log` on every call,
 *  answers `freshness` with "fresh", and otherwise prints nothing. */
function stubCli(path: string, label: string, log: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `echo "${label} $*" >> "${log}"`,
    'case "$1" in freshness) echo fresh ;; decision) echo 1 ;; esac',
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

/** A stub CLI that crashes like the plugin cache copy missing its
 *  better-sqlite3 binding: Node's file:line preamble, then the Error. */
function crashingCli(path: string, log: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `echo "crash $*" >> "${log}"`,
    "echo '/x/node_modules/bindings/bindings.js:121' >&2",
    "echo '        throw err;' >&2",
    "echo 'Error: Could not locate the bindings file. Tried:' >&2",
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

/** Hook env with every resolution input scrubbed, PATH reduced to system
 *  dirs (so no `cortex` on PATH), and the slow side paths switched off. */
function env(extra: Record<string, string>): Record<string, string> {
  const e = { ...(process.env as Record<string, string>) };
  for (const k of ["CORTEX_BIN", "CLAUDE_PLUGIN_ROOT", "CORTEX_DB"]) delete e[k];
  e.PATH = "/usr/bin:/bin";
  e.CORTEX_AUTO_INDEX = "0";
  e.CORTEX_GC = "0";
  return { ...e, ...extra };
}

function runCheckIndex(repo: string, extra: Record<string, string>): string {
  return execFileSync("bash", [CHECK_INDEX], {
    cwd: repo, encoding: "utf-8", env: env(extra),
    input: JSON.stringify({ session_id: "s1", source: "startup", cwd: repo }),
  });
}

function calls(log: string): string {
  return existsSync(log) ? readFileSync(log, "utf-8") : "";
}

describe("check-index.sh — CLI resolution", () => {
  it("prefers an exported CORTEX_BIN over the plugin's own bin/cortex", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const host = stubCli(join(dir, "host", "cortex"), "host", log);
    const plugin = join(dir, "plugin");
    stubCli(join(plugin, "bin", "cortex"), "plugin", log);

    runCheckIndex(repo, { CORTEX_BIN: host, CLAUDE_PLUGIN_ROOT: plugin });

    expect(calls(log)).toMatch(/^host freshness/m);
    expect(calls(log)).not.toMatch(/^plugin /m);
  });

  it("never runs the open repo's own ./bin/cortex", () => {
    const repo = indexedRepo();
    const log = join(repo, "calls.log");
    stubCli(join(repo, "bin", "cortex"), "repo", log);
    const emptyPlugin = tmp("cortex-cli-res-plugin-"); // like the Mesh sidecar: no bin/cortex

    const out = runCheckIndex(repo, { CLAUDE_PLUGIN_ROOT: emptyPlugin });

    expect(calls(log)).toBe("");
    expect(out).toMatch(/⚠ cortex CLI unavailable: no cortex CLI found/);
    expect(out).toMatch(/Index state: indexed \(unverified/);
  });

  it("treats a set-but-missing CORTEX_BIN as broken instead of falling through", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const plugin = join(dir, "plugin");
    stubCli(join(plugin, "bin", "cortex"), "plugin", log);

    const out = runCheckIndex(repo, { CORTEX_BIN: join(dir, "gone", "cortex"), CLAUDE_PLUGIN_ROOT: plugin });

    expect(calls(log)).toBe("");
    expect(out).toMatch(/⚠ cortex CLI unavailable: CORTEX_BIN is set but not executable/);
  });

  it("reports a crashing CLI loudly and stops calling it", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const bin = crashingCli(join(dir, "cortex"), log);

    const out = runCheckIndex(repo, { CORTEX_BIN: bin });

    expect(out).toMatch(/⚠ cortex CLI broken: Error: Could not locate the bindings file/);
    expect(out).toMatch(/Index state: indexed \(unverified/);
    // Probed once; no refresh, briefing, headline or count calls after that.
    expect(calls(log).trim().split("\n")).toEqual(["crash freshness"]);
  });

  it("resolves a relative CORTEX_BIN against where the hook started, not where it later cd's", () => {
    const repo = indexedRepo();
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    const log = join(repo, "calls.log");
    stubCli(join(sub, "tools", "cortex"), "rel", log);

    // cwd = <repo>/pkg; the hook cd's to the checkout root before calling.
    const out = execFileSync("bash", [CHECK_INDEX], {
      cwd: sub, encoding: "utf-8", env: env({ CORTEX_BIN: "tools/cortex" }),
      input: JSON.stringify({ session_id: "s1", source: "startup", cwd: sub }),
    });

    expect(calls(log)).toMatch(/^rel freshness/m);
    expect(out).not.toMatch(/cortex CLI (broken|unavailable)/);
  });

  it("surfaces a failed background index on a still-unindexed checkout", () => {
    const repo = tmp("cortex-cli-res-bare-");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    mkdirSync(join(repo, ".cortex"));
    writeFileSync(join(repo, ".cortex", "auto-index.log"), [
      // Chromium/Electron log noise Mesh's Electron-as-node CLI prints — not a failure.
      "[1119/105206.365849:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)",
      "/x/node_modules/bindings/bindings.js:121",
      "Error: Could not locate the bindings file. Tried:",
      "",
    ].join("\n"));
    const dir = tmp("cortex-cli-res-bins-");
    const bin = stubCli(join(dir, "cortex"), "ok", join(dir, "calls.log"));

    const out = runCheckIndex(repo, { CORTEX_BIN: bin });

    expect(out).toMatch(/Index state: not-indexed/);
    expect(out).toMatch(/⚠ cortex background index failed: Error: Could not locate the bindings file/);
  });

  it("does not flag a background index log that only carries Electron noise", () => {
    const repo = tmp("cortex-cli-res-bare-");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    mkdirSync(join(repo, ".cortex"));
    writeFileSync(join(repo, ".cortex", "auto-index.log"),
      "[1119/105206.365849:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)\n" +
      "... indexing some-project…\n");
    const dir = tmp("cortex-cli-res-bins-");
    const bin = stubCli(join(dir, "cortex"), "ok", join(dir, "calls.log"));

    expect(runCheckIndex(repo, { CORTEX_BIN: bin })).not.toMatch(/background index failed/);
  });

  it("stays quiet about the CLI when it works", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const bin = stubCli(join(dir, "cortex"), "ok", join(dir, "calls.log"));

    const out = runCheckIndex(repo, { CORTEX_BIN: bin });

    expect(out).not.toMatch(/cortex CLI (broken|unavailable)/);
    expect(out).toMatch(/Index state: indexed\n/);
  });
});

function runPostCommit(cwd: string, extra: Record<string, string>): string {
  return execFileSync("bash", [POST_COMMIT], { cwd, encoding: "utf-8", env: env(extra), input: "{}" });
}

function context(out: string): string {
  return out.trim() === "" ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;
}

describe("post-commit-refresh.sh — CLI resolution and failure reporting", () => {
  it("refreshes through an exported CORTEX_BIN, silently on success", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const host = stubCli(join(dir, "host", "cortex"), "host", log);
    const plugin = join(dir, "plugin");
    stubCli(join(plugin, "bin", "cortex"), "plugin", log);

    const out = runPostCommit(repo, { CORTEX_BIN: host, CLAUDE_PLUGIN_ROOT: plugin });

    expect(calls(log)).toBe("host index\n");
    expect(out).toBe("");
  });

  it("never runs the open repo's ./bin/cortex, and says the refresh was skipped", () => {
    const repo = indexedRepo();
    const log = join(repo, "calls.log");
    stubCli(join(repo, "bin", "cortex"), "repo", log);

    const out = runPostCommit(repo, { CLAUDE_PLUGIN_ROOT: tmp("cortex-cli-res-plugin-") });

    expect(calls(log)).toBe("");
    const ctx = context(out);
    expect(ctx).toMatch(/post-commit refresh skipped/);
    expect(ctx).toMatch(/index_repository/);
  });

  it("surfaces a failed refresh with the CLI's error line", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const bin = crashingCli(join(dir, "cortex"), join(dir, "calls.log"));

    const ctx = context(runPostCommit(repo, { CORTEX_BIN: bin }));

    expect(ctx).toMatch(/post-commit refresh failed \(exit 1\): Error: Could not locate the bindings file/);
  });

  it("leaves a repo Cortex never indexed alone — no index, no message", () => {
    const repo = tmp("cortex-cli-res-bare-");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const bin = stubCli(join(dir, "cortex"), "host", log);

    expect(runPostCommit(repo, { CORTEX_BIN: bin })).toBe("");
    expect(calls(log)).toBe("");
  });

  it("refreshes from the checkout root when committing from a subdirectory", () => {
    const repo = indexedRepo();
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    const dir = tmp("cortex-cli-res-bins-");
    const log = join(dir, "calls.log");
    const bin = join(dir, "cortex");
    writeFileSync(bin, `#!/usr/bin/env bash\necho "$PWD" >> "${log}"\necho 'Error: boom' >&2\nexit 1\n`);
    chmodSync(bin, 0o755);

    const ctx = context(runPostCommit(sub, { CORTEX_BIN: bin }));

    const root = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    expect(calls(log).trim()).toBe(root);
    expect(ctx).toContain(`index_repository(repo_path="${root}")`);
  });

  it("stays silent when the refresh lost the index lock to another index", () => {
    const repo = indexedRepo();
    const dir = tmp("cortex-cli-res-bins-");
    const bin = join(dir, "cortex");
    writeFileSync(bin, "#!/usr/bin/env bash\necho 'SqliteError: database is locked' >&2\nexit 1\n");
    chmodSync(bin, 0o755);

    expect(runPostCommit(repo, { CORTEX_BIN: bin })).toBe("");
  });

  it("does nothing when CORTEX_AUTO_REFRESH=0", () => {
    const repo = indexedRepo();
    const out = runPostCommit(repo, { CORTEX_AUTO_REFRESH: "0" });
    expect(out).toBe("");
  });
});
