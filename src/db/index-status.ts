import Database from "better-sqlite3";
import { worktreeRoot } from "./git-root.js";
import { cacheSlug } from "./store-paths.js";

/** What a graph store says about the project indexed into it. */
export type IndexStatus = {
  name: string;
  root_path: string;
  indexed_at: string;
  nodes: number;
  edges: number;
  /** The identity this checkout's own index carries (`ctx_projects.name`). */
  expected: string;
  /**
   * False when the store declares another checkout's identity — a store
   * copied in, served from a cache keyed too loosely, or left behind by a
   * checkout that has since moved. Cortex's own reads still answer from it
   * (they take the store's name), but under that other checkout's name and
   * root, so snippets resolve against its files and any client querying by
   * this checkout's name (Mesh's canvas) finds nothing.
   */
  own: boolean;
};

/**
 * Is the checkout containing `repoPath` indexed, according to the graph store
 * at `dbPath`? The one answer both `index_status` surfaces give — the MCP tool
 * and `cortex index status` — so the two cannot disagree about one repo.
 *
 * Callers pass the store `resolveGraphDbForRead` picks (`.cortex/db`, else the
 * legacy `.cortex/graph.db` or shared slug cache), the same one every other
 * read uses. The CLI used to ask the external indexer by project name with no
 * DB pinned, which only ever looked in the shared cache — reaped by
 * `cortex index` once it has published `.cortex/db` — so every repo indexed
 * the current way read "project not found or not indexed" while `code find`
 * worked in the same directory.
 *
 * Identity is checked, not assumed. The expected name is derived from the
 * checkout root (`worktreeRoot`, which also collapses subdirectories and
 * resolves symlinks), the same name `cortex index` writes. A store holding
 * only some other name comes back with `own: false`, and both surfaces say
 * so instead of passing it off as this checkout's index (observed 2026-08-30:
 * a worktree's store replaced wholesale by a sibling's — see
 * `computeCacheKey`).
 *
 * Read-only and tolerant: a missing, empty or corrupt store, or one with no
 * `ctx_projects` row, answers `null` rather than throwing.
 */
export function readIndexStatus(dbPath: string, repoPath: string): IndexStatus | null {
  const expected = cacheSlug(worktreeRoot(repoPath));
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const cols = "SELECT name, root_path, indexed_at FROM ctx_projects";
    const row = (db.prepare(`${cols} WHERE name = ?`).get(expected)
      ?? db.prepare(`${cols} ORDER BY indexed_at DESC LIMIT 1`).get()) as
      { name: string; root_path: string; indexed_at: string } | undefined;
    if (!row) return null;
    return {
      ...row,
      nodes: count(db, "nodes", row.name),
      edges: count(db, "edges", row.name),
      expected,
      own: row.name === expected,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Rows of `table` belonging to `project`. A store from before the `project`
 *  column existed held one project only, so its whole table is the count. */
function count(db: Database.Database, table: "nodes" | "edges", project: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`).get(project) as { n: number }).n;
  } catch {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
}

/**
 * What both surfaces print: the status line, plus a warning line when the
 * store carries another checkout's identity. Kept on one `Indexed:` line
 * first so a reader keyed on that prefix still finds it.
 */
export function renderIndexStatus(s: IndexStatus): string {
  const line = `Indexed: ${s.name} at ${s.root_path} (${s.nodes} nodes, ${s.edges} edges, last: ${s.indexed_at})`;
  if (s.own) return line;
  return `${line}\nWarning: this store carries ${s.name}'s identity, not ${s.expected}'s — results and snippets resolve against ${s.root_path}. Re-index this checkout to rebuild it.`;
}
