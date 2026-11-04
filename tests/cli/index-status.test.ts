import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { runIndexCommand } from "../../src/cli/commands/index.js";
import { readIndexedProject } from "../../src/db/index-status.js";
import type { ProjectContext } from "../../src/cli/context.js";
import { UsageError } from "../../src/cli/errors.js";

/**
 * `cortex index status` must answer from the repo's own `.cortex/db`.
 *
 * It used to ask the external indexer by project name with no DB pinned,
 * which only looked in the legacy shared cache — reaped by `cortex index`
 * after it publishes — so every repo indexed the current way read "project
 * not found or not indexed" while `code find` worked in the same directory.
 */

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "index-status-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A repo whose `.cortex/db` holds one ctx_projects row — what `cortex index` leaves behind. */
function indexedRepo(rootPathInDb?: string): string {
  const root = join(tmp, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const db = new BetterSqlite3(join(root, ".cortex", "db"));
  db.exec("CREATE TABLE ctx_projects (name TEXT, root_path TEXT, indexed_at TEXT)");
  db.prepare("INSERT INTO ctx_projects VALUES (?, ?, ?)").run("tmp-repo", rootPathInDb ?? root, "2026-11-04T10:00:00Z");
  db.close();
  return root;
}

const ctxFor = (gitRoot: string | null): ProjectContext => ({
  state: gitRoot ? "indexed" : "no-project",
  cwd: gitRoot ?? tmp,
  gitRoot,
  projectName: gitRoot ? "tmp-repo" : null,
  graphDbPath: gitRoot ? join(gitRoot, ".cortex", "db") : null,
});

describe("readIndexedProject", () => {
  it("reads the project row from the repo's own .cortex/db", () => {
    const root = indexedRepo();
    expect(readIndexedProject(root)).toEqual({ name: "tmp-repo", root_path: root, indexed_at: "2026-11-04T10:00:00Z" });
  });

  it("reports the store's project even when its root_path differs (symlinks, moved checkouts)", () => {
    const root = indexedRepo("/somewhere/else");
    expect(readIndexedProject(root)?.name).toBe("tmp-repo");
  });

  it("answers null for no store, and for one that is not a graph DB", () => {
    const bare = join(tmp, "bare");
    mkdirSync(join(bare, ".git"), { recursive: true });
    expect(readIndexedProject(bare)).toBeNull();
    mkdirSync(join(bare, ".cortex"));
    writeFileSync(join(bare, ".cortex", "db"), "not sqlite");
    expect(readIndexedProject(bare)).toBeNull();
  });
});

describe("cortex index status", () => {
  it("says an indexed repo is indexed, without asking the indexer", async () => {
    const root = indexedRepo();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runIndexCommand({ command: "status", positionals: [], flags: {} }, ctxFor(root));
      expect(out).toHaveBeenCalledWith(`Indexed: tmp-repo at ${root} (last: 2026-11-04T10:00:00Z)\n`);
    } finally {
      out.mockRestore();
    }
  });

  it("outside a git repo, says so instead of asking about a nameless project", async () => {
    await expect(runIndexCommand({ command: "status", positionals: [], flags: {} }, ctxFor(null))).rejects.toBeInstanceOf(UsageError);
  });
});
