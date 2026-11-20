/**
 * bin/cortex's native-binding self-heal.
 *
 * Claude Code's directory-marketplace cache copies (and some git-installed
 * plugin copies) arrive without better-sqlite3's compiled `.node`, so every
 * CLI command a hook runs died on "Could not locate the bindings file" — the
 * MCP launcher (bin/cortex-mcp.sh) already healed this, the CLI launcher did
 * not. These tests run the real launcher against a fake plugin root whose
 * `dist/cli/main.js` is a stub, with a fake `npm` first on PATH.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER = resolve(__dirname, "../../bin/cortex");
const BINDING = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/**
 * A plugin root with the real launcher, a stub CLI that prints `ran <args>`,
 * and a better-sqlite3 package dir (binding present or not). `npm` is a fake
 * that logs its argv and, per `npmMode`, creates the binding or fails.
 */
function setup(opts: { binding: boolean; npmMode: "heal" | "fail" | "fail-rebuild" | "blocked" }) {
  // realpath'd: the launcher resolves its root with `cd -P`, so on macOS npm
  // runs under /private/var, not the /var symlink tmpdir() hands back.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-launcher-")));
  const root = join(dir, "plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(LAUNCHER, join(root, "bin", "cortex"));
  chmodSync(join(root, "bin", "cortex"), 0o755);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(join(root, "dist", "cli", "main.js"), 'console.log("ran " + process.argv.slice(2).join(" "));\n');
  mkdirSync(join(root, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  if (opts.binding) writeFileSync(join(root, BINDING), "");

  const fakeBin = join(dir, "fakebin");
  mkdirSync(fakeBin);
  const npmLog = join(dir, "npm.log");
  const heal = `mkdir -p "$PWD/node_modules/better-sqlite3/build/Release" && : > "$PWD/${BINDING}"`;
  const body =
    opts.npmMode === "heal" ? `${heal}; echo "npm stdout noise"; exit 0`
    : opts.npmMode === "fail" ? "exit 1"
    // npm 12 with no allowScripts entry: skips the install script, exits 0.
    : opts.npmMode === "blocked" ? 'echo "npm warn rebuild 1 packages had install scripts blocked" >&2; exit 0'
    : `case "$1" in rebuild) exit 1;; *) ${heal}; exit 0;; esac`;
  writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\necho "$PWD :: $*" >> "${npmLog}"\n${body}\n`);
  chmodSync(join(fakeBin, "npm"), 0o755);

  const run = (...args: string[]) =>
    spawnSync("bash", [join(root, "bin", "cortex"), ...args], {
      cwd: dir, // NOT the plugin root: the heal must cd there itself
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : []);
  return { root, run, npmCalls };
}

describe("bin/cortex native-binding self-heal", () => {
  it("binding present: never touches npm", () => {
    const { run, npmCalls } = setup({ binding: true, npmMode: "fail" });
    const r = run("freshness");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ran freshness\n");
    expect(npmCalls()).toEqual([]);
  });

  it("binding missing: rebuilds it in the plugin root, then runs the command", () => {
    const { root, run, npmCalls } = setup({ binding: false, npmMode: "heal" });
    const r = run("index");
    expect(r.status).toBe(0);
    expect(npmCalls()).toEqual([`${root} :: rebuild better-sqlite3`]);
    expect(existsSync(join(root, BINDING))).toBe(true);
    expect(r.stderr).toContain("better-sqlite3 native binding missing");
  });

  // Hooks capture `cortex freshness` stdout and parse it; npm's chatter there
  // would corrupt the verdict.
  it("keeps stdout clean while healing — only the command's own output", () => {
    const { run } = setup({ binding: false, npmMode: "heal" });
    expect(run("freshness").stdout).toBe("ran freshness\n");
  });

  it("falls back to reinstalling just better-sqlite3 when rebuild fails", () => {
    const { root, run, npmCalls } = setup({ binding: false, npmMode: "fail-rebuild" });
    const r = run("index");
    expect(r.status).toBe(0);
    expect(npmCalls()).toEqual([
      `${root} :: rebuild better-sqlite3`,
      `${root} :: install better-sqlite3 --no-save --omit=dev`,
    ]);
  });

  it("a heal that fails still runs the command, so its real error surfaces", () => {
    const { run } = setup({ binding: false, npmMode: "fail" });
    const r = run("index");
    expect(r.stdout).toBe("ran index\n");
    expect(r.stderr).toContain("could not rebuild");
  });

  // npm 12 blocks dependency install scripts unless package.json allowScripts
  // covers them, and still exits 0 — "rebuilt dependencies successfully" with
  // no binding built. Trusting the exit code would report nothing at all.
  it("judges the heal by the binding, not npm's exit code", () => {
    const { run } = setup({ binding: false, npmMode: "blocked" });
    const r = run("index");
    expect(r.stdout).toBe("ran index\n");
    expect(r.stderr).toContain("could not rebuild");
  });

  it("heals once: the next invocation finds the binding and skips npm", () => {
    const { run, npmCalls } = setup({ binding: false, npmMode: "heal" });
    run("index");
    run("freshness");
    expect(npmCalls()).toHaveLength(1);
  });

  // SessionStart's freshness probe, the background auto-index and an edit
  // briefing can all start at once on a fresh copy.
  it("another heal in flight: skips rather than running a second npm on the same tree", () => {
    const { root, run, npmCalls } = setup({ binding: false, npmMode: "heal" });
    mkdirSync(join(root, "node_modules", ".cortex-binding-heal.lock"));
    const r = run("freshness");
    expect(r.stdout).toBe("ran freshness\n");
    expect(npmCalls()).toEqual([]);
  });

  it("releases its lock, so a failed heal is retried by the next invocation", () => {
    const { root, run, npmCalls } = setup({ binding: false, npmMode: "fail" });
    run("index");
    expect(existsSync(join(root, "node_modules", ".cortex-binding-heal.lock"))).toBe(false);
    run("index");
    expect(npmCalls().length).toBeGreaterThan(1);
  });

  // No better-sqlite3 dir at all is not this launcher's problem to fix with a
  // network install on every call — but the package-dir-present, binding-absent
  // case is the cache-copy shape and the one it owns.
  it("no node_modules at all: does not attempt a heal", () => {
    const { root, run, npmCalls } = setup({ binding: true, npmMode: "heal" });
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const r = run("freshness");
    expect(r.stdout).toBe("ran freshness\n");
    expect(npmCalls()).toEqual([]);
  });
});
