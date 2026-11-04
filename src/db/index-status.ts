import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveCortexDbPath } from "./resolve-path.js";

/** What a repo's own graph store says about the project indexed into it. */
export type IndexedProject = { name: string; root_path: string; indexed_at: string };

/**
 * Is `repoPath` indexed, according to its OWN store (`<repo>/.cortex/db`)?
 *
 * The one answer both `index_status` surfaces give — the MCP tool and
 * `cortex index status` — so the two cannot disagree about one repo. The CLI
 * used to ask the external indexer instead, by project name and with no DB
 * pinned, which only ever looked in the legacy shared cache
 * (`~/.cache/cortex-indexer/<project>.db`). `cortex index` reaps that cache
 * once it has published to `.cortex/db`, so every repo indexed the current
 * way read "project not found or not indexed" there while `code find` worked
 * in the same directory.
 *
 * Read-only and tolerant: a missing, empty or corrupt store answers `null`
 * rather than throwing, so a caller can fall through to the legacy cache.
 */
export function readIndexedProject(repoPath: string): IndexedProject | null {
  const dbPath = resolveCortexDbPath(repoPath);
  if (!existsSync(dbPath)) return null;
  try {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const exact = probe.prepare(
        "SELECT name, root_path, indexed_at FROM ctx_projects WHERE root_path = ? LIMIT 1",
      ).get(repoPath) as IndexedProject | undefined;
      if (exact) return exact;
      // ctx_projects may store a different root_path than the caller supplied
      // (symlinks, fixtures). If the table has any row at all, this store
      // belongs to *some* project — report it.
      const any = probe.prepare(
        "SELECT name, root_path, indexed_at FROM ctx_projects LIMIT 1",
      ).get() as IndexedProject | undefined;
      return any ?? null;
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

/** The status line both surfaces print for an indexed repo. */
export function renderIndexedProject(p: IndexedProject): string {
  return `Indexed: ${p.name} at ${p.root_path} (last: ${p.indexed_at})`;
}
