import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Scorecard, Target } from "./assertions/types.js";
import { evalIndexerEnv } from "../../src/cli/commands/eval.js";
import { resolveIndexerBinary } from "../../src/indexer/binary.js";

export type AcquiredTarget = {
  name: string;
  workdir: string;             // absolute path to the source tree
  graphDbPath: string;         // absolute path to the graph.db this harness writes (under evals/cache/<name>/)
  source_sha?: string;
  indexer_seconds: number | null;
};

const CACHE_ROOT = resolve(process.cwd(), "evals/cache");

/** Beside each cached graph.db: the identity of the indexer that built it. */
const IDENTITY_FILE = "indexer-identity";

/**
 * Which indexer binary this is, as `${realpath}:${size}:${mtimeMs}`.
 *
 * A cached graph is only evidence about the binary that built it. Without
 * this, swapping in a different indexer (`npm run fetch-indexer`, or a dev
 * build via CORTEX_INDEXER_PATH) leaves the cache looking fresh, and the eval
 * grades the old binary's graph as the new one's — exactly wrong for a gate
 * whose job is judging indexer changes. The realpath makes a symlink and its
 * target one identity; size and mtime change whenever the file is replaced.
 */
export function indexerIdentity(binPath: string): string {
  const real = realpathSync(binPath);
  const { size, mtimeMs } = statSync(real);
  return `${real}:${size}:${mtimeMs}`;
}

/** Everything the cache decision depends on, gathered so the decision itself
 *  is a pure function. Null mtimes mean the file does not exist. */
export type ReindexState = {
  graphExists: boolean;
  graphMtimeMs: number | null;
  headMtimeMs: number | null;
  /** Null for a cache written before identities were recorded. */
  storedIdentity: string | null;
  currentIdentity: string;
};

/**
 * Whether the cached graph must be rebuilt. It is reused only when it exists,
 * is at least as new as the source's git HEAD, and was built by the indexer
 * that is current now. Anything unknown rebuilds: a source with no `.git` (a
 * plain directory has no HEAD to compare against) and a cache with no recorded
 * identity both read as stale, because reusing them would be a guess.
 */
export function needsReindex(s: ReindexState): boolean {
  if (!s.graphExists || s.graphMtimeMs === null) return true;
  if (s.storedIdentity === null || s.storedIdentity !== s.currentIdentity) return true;
  if (s.headMtimeMs === null) return true;
  return s.graphMtimeMs < s.headMtimeMs;
}

export function acquireTarget(target: Target, pathOverride?: string): AcquiredTarget {
  const graphDbPath = join(CACHE_ROOT, target.name, "graph.db");

  if (target.local_path || pathOverride) {
    const workdir = resolve(pathOverride ?? target.local_path!);
    if (!existsSync(workdir)) {
      throw new Error(`Target ${target.name}: local path does not exist: ${workdir}`);
    }
    return {
      name: target.name,
      workdir,
      graphDbPath,
      indexer_seconds: maybeReindex(workdir, graphDbPath),
    };
  }

  if (!target.repo_url || !target.sha) {
    throw new Error(`Target ${target.name}: requires either local_path or repo_url+sha`);
  }

  const workdir = join(CACHE_ROOT, target.name, "src");
  if (!existsSync(workdir)) {
    mkdirSync(dirname(workdir), { recursive: true });
    execFileSync("git", ["clone", "--depth", "50", target.repo_url, workdir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", workdir, "fetch", "--depth", "50", "origin", target.sha], { stdio: "inherit" });
  execFileSync("git", ["-C", workdir, "checkout", "--detach", target.sha], { stdio: "inherit" });
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  return {
    name: target.name,
    workdir,
    graphDbPath,
    source_sha: head,
    indexer_seconds: maybeReindex(workdir, graphDbPath),
  };
}

/** Rebuild the target's graph unless needsReindex says the cache is still
 *  good. Returns the build's wall time in seconds, or null when the cached
 *  graph was reused. The binary is resolveIndexerBinary(), so a dev build set
 *  through CORTEX_INDEXER_PATH is what gets evaluated. */
function maybeReindex(workdir: string, graphDbPath: string): number | null {
  const bin = resolveIndexerBinary();
  const identityPath = join(dirname(graphDbPath), IDENTITY_FILE);
  const headFile = join(workdir, ".git/HEAD");
  const graphExists = existsSync(graphDbPath);
  const state: ReindexState = {
    graphExists,
    graphMtimeMs: graphExists ? statSync(graphDbPath).mtimeMs : null,
    headMtimeMs: existsSync(headFile) ? statSync(headFile).mtimeMs : null,
    storedIdentity: existsSync(identityPath) ? readFileSync(identityPath, "utf-8").trim() : null,
    currentIdentity: indexerIdentity(bin),
  };
  if (!needsReindex(state)) return null;

  mkdirSync(dirname(graphDbPath), { recursive: true });
  // Drop the stamp before building. A build that dies part-way can still
  // leave a graph.db newer than HEAD; if the previous stamp survived, the
  // next run would find "fresh graph, same indexer" and grade the wreckage.
  rmSync(identityPath, { force: true });
  // Then the graph itself: every rebuild starts from nothing. cortex-indexer
  // is incremental — it keeps per-file hashes inside graph.db, and over an
  // unchanged tree (a pinned target never changes) it exits 0 having rebuilt
  // nothing. Pointed at the old graph, a new binary would leave the old
  // binary's edges in place, and the stamp below would certify them as the
  // new one's: the gate would grade every indexer change on its predecessor.
  removeGraph(graphDbPath);
  const start = Date.now();
  execFileSync(
    bin,
    ["cli", "index_repository", JSON.stringify({ repo_path: workdir })],
    {
      stdio: "inherit",
      // Redirect the indexer's slug cache + durable home into evals/cache
      // (already gitignored eval scratch space) so corpus-target indexing
      // never leaks entries into the real ~/.cache/cortex-indexer or
      // ~/.cortex.
      env: { ...process.env, CORTEX_DB: graphDbPath, ...evalIndexerEnv(CACHE_ROOT) },
    },
  );
  // Only now, after a zero exit (execFileSync throws otherwise): the stamp
  // says this graph is a complete build by this binary.
  writeFileSync(identityPath, state.currentIdentity);
  return (Date.now() - start) / 1000;
}

/** Edge types excluded from the determinism comparison because they are known
 *  to vary across identical runs (todo T-48qt: SEMANTICALLY_RELATED measured
 *  at 146/145/148 on an unchanged repo). Everything else is expected to be
 *  bit-stable, so any difference is a real defect. */
const NONDETERMINISTIC_EDGE_TYPES = new Set(["SEMANTICALLY_RELATED"]);

export function compareGraphShape(
  a: Scorecard,
  b: Scorecard,
): { stable: boolean; differences: string[] } {
  const differences: string[] = [];

  for (const key of new Set([...Object.keys(a.nodes_by_label), ...Object.keys(b.nodes_by_label)])) {
    const x = a.nodes_by_label[key] ?? 0;
    const y = b.nodes_by_label[key] ?? 0;
    if (x !== y) differences.push(`nodes.${key}: ${x} vs ${y}`);
  }

  for (const key of new Set([...Object.keys(a.edges_by_type), ...Object.keys(b.edges_by_type)])) {
    if (NONDETERMINISTIC_EDGE_TYPES.has(key)) continue;
    const x = a.edges_by_type[key] ?? 0;
    const y = b.edges_by_type[key] ?? 0;
    if (x !== y) differences.push(`edges.${key}: ${x} vs ${y}`);
  }

  return { stable: differences.length === 0, differences };
}

/** The graph file and its SQLite WAL siblings. A stale -wal left beside a new
 *  graph.db would be replayed into it on open. */
function removeGraph(graphDbPath: string): void {
  rmSync(graphDbPath, { force: true });
  rmSync(`${graphDbPath}-shm`, { force: true });
  rmSync(`${graphDbPath}-wal`, { force: true });
}

/** Index unconditionally. maybeReindex skips when the cached graph.db is newer
 *  than the workdir's .git/HEAD, which would make a determinism run compare a
 *  graph against itself and always report stable. */
export function forceReindex(workdir: string, graphDbPath: string): number {
  removeGraph(graphDbPath);
  const seconds = maybeReindex(workdir, graphDbPath);
  return seconds ?? 0;
}
