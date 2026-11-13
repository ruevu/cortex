import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireTarget, indexerIdentity, needsReindex, type ReindexState } from "../../evals/src/target.js";

/** A cached graph newer than HEAD, built by the indexer that is current now. */
const fresh: ReindexState = {
  graphExists: true, graphMtimeMs: 2_000, headMtimeMs: 1_000,
  storedIdentity: "/bin/cortex-indexer:100:5", currentIdentity: "/bin/cortex-indexer:100:5",
};

describe("needsReindex", () => {
  it("keeps a graph at least as new as HEAD, built by the same indexer", () => {
    expect(needsReindex(fresh)).toBe(false);
    expect(needsReindex({ ...fresh, graphMtimeMs: 1_000 })).toBe(false);
  });

  it.each<[string, Partial<ReindexState>]>([
    ["there is no graph", { graphExists: false, graphMtimeMs: null }],
    ["the indexer changed", { currentIdentity: "/bin/cortex-indexer:100:6" }],
    ["the cache predates identity stamps", { storedIdentity: null }],
    ["the source has no git HEAD", { headMtimeMs: null }],
    ["the graph is older than HEAD", { graphMtimeMs: 999 }],
  ])("rebuilds when %s", (_why, patch) => {
    expect(needsReindex({ ...fresh, ...patch })).toBe(true);
  });
});

describe("indexerIdentity", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-identity-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("changes when the binary is replaced in place", () => {
    const bin = join(dir, "cortex-indexer");
    writeFileSync(bin, "v1");
    const before = indexerIdentity(bin);
    const later = statSync(bin).mtimeMs / 1000 + 60;
    utimesSync(bin, later, later);
    expect(indexerIdentity(bin)).not.toBe(before);
  });

  it("is the same for a symlink and its target", () => {
    const bin = join(dir, "cortex-indexer");
    writeFileSync(bin, "v1");
    const link = join(dir, "linked-indexer");
    symlinkSync(bin, link);
    expect(indexerIdentity(link)).toBe(indexerIdentity(bin));
  });
});

/**
 * The wiring, end to end, with a fake indexer: a shell script that logs each
 * run and writes FAKE_INDEXER_BUILD into the graph file it is pointed at.
 * Like the real cortex-indexer it is INCREMENTAL — the real one keeps per-file
 * hashes inside graph.db, so over an unchanged tree an existing graph is a
 * no-op that exits 0 — and a fake that always rewrote the file could not tell
 * a rebuild from a restamp. FAKE_INDEXER_FAIL makes it write the file and
 * then exit non-zero: a build that died part-way.
 */
describe("acquireTarget's graph cache", () => {
  const saved = { ...process.env };
  let dir: string;
  let fake: string;
  let log: string;
  let source: string;
  let name: string;

  const runs = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").length : 0);
  const cacheDir = () => resolve(process.cwd(), "evals/cache", name);
  const target = () => ({ name, local_path: source });
  const age = (path: string, secondsAgo: number) => {
    const t = Date.now() / 1000 - secondsAgo;
    utimesSync(path, t, t);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-eval-cache-"));
    name = `__cache-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    log = join(dir, "runs.log");
    fake = join(dir, "fake-indexer");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'echo run >> "$FAKE_INDEXER_LOG"',
        'if [ -f "$CORTEX_DB" ]; then exit 0; fi',
        'printf "%s" "$FAKE_INDEXER_BUILD" > "$CORTEX_DB"',
        'if [ -n "$FAKE_INDEXER_FAIL" ]; then exit 1; fi',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    source = join(dir, "src");
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git/HEAD"), "ref: refs/heads/main\n");
    age(join(source, ".git/HEAD"), 3_600);
    process.env.CORTEX_INDEXER_PATH = fake;
    process.env.FAKE_INDEXER_LOG = log;
    process.env.FAKE_INDEXER_BUILD = "build-1";
    delete process.env.FAKE_INDEXER_FAIL;
  });

  afterEach(() => {
    process.env = { ...saved };
    rmSync(cacheDir(), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses the graph when neither the source nor the indexer changed", () => {
    expect(acquireTarget(target()).indexer_seconds).not.toBeNull();
    expect(acquireTarget(target()).indexer_seconds).toBeNull();
    expect(runs()).toBe(1);
  });

  it("rebuilds from scratch when the indexer binary changes", () => {
    acquireTarget(target());
    process.env.FAKE_INDEXER_BUILD = "build-2";
    const later = Date.now() / 1000 + 60;
    utimesSync(fake, later, later);

    expect(acquireTarget(target()).indexer_seconds).not.toBeNull();
    expect(runs()).toBe(2);
    // The new binary's graph — not the old graph, restamped. Over an
    // unchanged tree the incremental indexer leaves an existing graph alone.
    expect(readFileSync(join(cacheDir(), "graph.db"), "utf-8")).toBe("build-2");
  });

  it("never reuses a graph from a build that failed", () => {
    acquireTarget(target());
    // HEAD moves, so the next run rebuilds — and that build dies after
    // writing a graph file newer than HEAD.
    age(join(cacheDir(), "graph.db"), 7_200);
    age(join(source, ".git/HEAD"), 1_800);
    process.env.FAKE_INDEXER_FAIL = "1";
    expect(() => acquireTarget(target())).toThrow();
    delete process.env.FAKE_INDEXER_FAIL;

    expect(acquireTarget(target()).indexer_seconds).not.toBeNull();
    expect(runs()).toBe(3);
  });
});
