import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { runIndexCommand } from "../../src/cli/commands/index.js";
import { readIndexStatus } from "../../src/db/index-status.js";
import { cacheSlug } from "../../src/db/store-paths.js";
import { loadContext } from "../../src/cli/context.js";
import { DomainError, UsageError } from "../../src/cli/errors.js";

/**
 * `cortex index status` must answer from the store every other command reads.
 *
 * It used to ask the external indexer by project name with no DB pinned,
 * which only looked in the legacy shared cache — reaped by `cortex index`
 * after it publishes — so every repo indexed the current way read "project
 * not found or not indexed" while `code find` worked in the same directory.
 */

let tmp: string;
beforeEach(() => {
  // realpath: macOS's tmpdir is a symlink, and identity is derived from the
  // resolved checkout root — the same root `cortex index` names a project by.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "index-status-")));
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

/** A real git checkout (a fake `.git` dir would let git walk up out of tmp). */
function repo(name = "repo"): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

type StoreOpts = { file?: "db" | "graph.db"; project?: string; rootPath?: string; noProjectColumn?: boolean };

/** Write the store `cortex index` leaves behind: a ctx_projects row plus nodes/edges. */
function writeStore(root: string, opts: StoreOpts = {}): string {
  const project = opts.project ?? cacheSlug(root);
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const path = join(root, ".cortex", opts.file ?? "db");
  const db = new BetterSqlite3(path);
  const col = opts.noProjectColumn ? "" : ", project TEXT";
  db.exec(`
    CREATE TABLE ctx_projects (name TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, root_path TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY${col});
    CREATE TABLE edges (id TEXT PRIMARY KEY${col});
  `);
  db.prepare("INSERT INTO ctx_projects VALUES (?, ?, ?)").run(project, "2026-11-04T10:00:00Z", opts.rootPath ?? root);
  const ins = (t: string, id: string, p: string) =>
    opts.noProjectColumn
      ? db.prepare(`INSERT INTO ${t} VALUES (?)`).run(id)
      : db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).run(id, p);
  for (const id of ["n1", "n2", "n3"]) ins("nodes", id, project);
  ins("nodes", "x1", "someone-else"); // another project's rows must not be counted
  for (const id of ["e1", "e2"]) ins("edges", id, project);
  db.close();
  return path;
}

async function status(cwd: string): Promise<string> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runIndexCommand({ command: "status", positionals: [], flags: {} }, loadContext(cwd));
    return out.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    out.mockRestore();
  }
}

describe("readIndexStatus", () => {
  it("reads this checkout's identity and its own node/edge counts", () => {
    const root = repo();
    const db = writeStore(root);
    expect(readIndexStatus(db, root)).toEqual({
      name: cacheSlug(root), root_path: root, indexed_at: "2026-11-04T10:00:00Z",
      nodes: 3, edges: 2, expected: cacheSlug(root), own: true,
    });
  });

  it("answers for the enclosing checkout when asked from a subdirectory", () => {
    const root = repo();
    const db = writeStore(root);
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(readIndexStatus(db, sub)).toMatchObject({ name: cacheSlug(root), own: true });
  });

  it("flags a store that carries another checkout's identity", () => {
    const root = repo();
    const db = writeStore(root, { project: "Users-x-other", rootPath: "/Users/x/other" });
    expect(readIndexStatus(db, root)).toMatchObject({ name: "Users-x-other", expected: cacheSlug(root), own: false });
  });

  it("counts a whole table in a store from before the project column", () => {
    const root = repo();
    const db = writeStore(root, { noProjectColumn: true });
    expect(readIndexStatus(db, root)).toMatchObject({ nodes: 4, edges: 2 });
  });

  it("answers null for a missing store, a non-SQLite one, and one with no project row", () => {
    const root = repo();
    const path = join(root, ".cortex", "db");
    expect(readIndexStatus(path, root)).toBeNull();
    mkdirSync(join(root, ".cortex"));
    writeFileSync(path, "not sqlite");
    expect(readIndexStatus(path, root)).toBeNull();
    rmSync(path);
    const db = new BetterSqlite3(path);
    db.exec("CREATE TABLE ctx_projects (name TEXT, indexed_at TEXT, root_path TEXT)");
    db.close();
    expect(readIndexStatus(path, root)).toBeNull();
  });
});

describe("cortex index status", () => {
  it("says an indexed repo is indexed, with its counts, without asking the indexer", async () => {
    const root = repo();
    writeStore(root);
    expect(await status(root)).toBe(`Indexed: ${cacheSlug(root)} at ${root} (3 nodes, 2 edges, last: 2026-11-04T10:00:00Z)\n`);
  });

  it("finds a repo indexed into the legacy .cortex/graph.db, as every other command does", async () => {
    const root = repo();
    writeStore(root, { file: "graph.db" });
    expect(await status(root)).toMatch(/^Indexed: .* \(3 nodes, 2 edges, /);
  });

  it("gives a linked worktree its own answer, never its main checkout's", async () => {
    const main = repo("main");
    writeStore(main);
    const wt = join(tmp, "wt");
    git(main, "worktree", "add", "-q", wt);

    // Strict reads: an unindexed worktree is unindexed, however good main's index is.
    await expect(status(wt)).rejects.toBeInstanceOf(DomainError);

    writeStore(wt);
    expect(await status(wt)).toMatch(new RegExp(`^Indexed: ${cacheSlug(wt)} at ${wt} `));
  });

  it("warns when the store carries another checkout's identity", async () => {
    const root = repo();
    writeStore(root, { project: "Users-x-other", rootPath: "/Users/x/other" });
    const out = await status(root);
    expect(out).toMatch(/^Indexed: Users-x-other at \/Users\/x\/other /);
    expect(out).toContain(`Warning: this store carries Users-x-other's identity, not ${cacheSlug(root)}'s`);
  });

  it("says an unindexed repo is not indexed (exit 3), and an empty store too", async () => {
    const root = repo();
    await expect(status(root)).rejects.toThrow(/not indexed$/);
    mkdirSync(join(root, ".cortex"));
    new BetterSqlite3(join(root, ".cortex", "db")).close();
    await expect(status(root)).rejects.toThrow(/holds no index/);
    await expect(status(root)).rejects.toBeInstanceOf(DomainError);
  });

  it("outside a git repo, says so instead of asking about a nameless project", async () => {
    await expect(status(tmp)).rejects.toBeInstanceOf(UsageError);
  });
});
