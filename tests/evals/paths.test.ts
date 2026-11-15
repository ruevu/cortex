import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { EVAL_CACHE_ROOT, EVAL_REPORTS_ROOT } from "../../evals/src/paths.js";
import { resolveIndexerBinary } from "../../src/indexer/binary.js";
import { evalIndexerEnv } from "../../src/cli/commands/eval.js";

/**
 * The eval writes whole repositories, private ones included, and their
 * measured numbers inside the checkout that runs it. That checkout gets
 * indexed: by hand, after every commit, at session start. Its scratch has to
 * be invisible to that index in a LINKED worktree too, because that is where
 * the release gate runs and where cortex-indexer does not read the root
 * .gitignore (cortex-indexer todo T-0fy2). There a cloned target becomes part of the checkout's
 * own graph, search results and quality verdict (T-a9kr).
 *
 * This runs the real indexer, because the guarantee is the indexer's.
 */
describe("eval scratch is invisible to the checkout's own index", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a linked worktree's index reads neither the eval cache nor the reports", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-eval-scratch-")));
    temps.push(base);
    const cacheRel = relative(process.cwd(), EVAL_CACHE_ROOT);
    const reportsRel = relative(process.cwd(), EVAL_REPORTS_ROOT);

    const main = join(base, "repo");
    execFileSync("git", ["init", "-q", main]);
    mkdirSync(join(main, "src"));
    writeFileSync(join(main, "src", "a.ts"), "export function alpha(): number { return 1; }\n");
    // As in the real repository, the scratch is gitignored: a linked
    // worktree's index ignores that.
    writeFileSync(join(main, ".gitignore"), `/${cacheRel}/\n/${reportsRel}/\n`);
    execFileSync("git", ["-C", main, "add", "."]);
    execFileSync("git", [
      "-C", main, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false",
      "commit", "-qm", "init",
    ]);
    const wt = join(base, "wt");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", wt]);

    // What a gate run leaves behind: a cloned target, and a run's reports.
    mkdirSync(join(wt, cacheRel, "clone", "src"), { recursive: true });
    writeFileSync(join(wt, cacheRel, "clone", "src", "x.ts"), "export function clonedFn(): number { return 2; }\n");
    mkdirSync(join(wt, reportsRel, "run"), { recursive: true });
    writeFileSync(join(wt, reportsRel, "run", "summary.md"), "# Eval summary\n\n## mesh\n");
    writeFileSync(join(wt, reportsRel, "run", "y.ts"), "export function reportedFn(): number { return 3; }\n");

    const dbPath = join(base, "graph.db");
    execFileSync(resolveIndexerBinary(), ["cli", "index_repository", JSON.stringify({ repo_path: wt })], {
      env: { ...process.env, CORTEX_DB: dbPath, ...evalIndexerEnv(join(base, "scratch")) },
      stdio: "pipe",
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const files = (
        db.prepare("SELECT DISTINCT file_path FROM nodes WHERE file_path IS NOT NULL").all() as Array<{ file_path: string }>
      ).map((r) => r.file_path);
      expect(files).toContain("src/a.ts"); // the index did run over the worktree
      expect(files.filter((f) => f.startsWith(`${cacheRel}/`) || f.startsWith(`${reportsRel}/`))).toEqual([]);
    } finally {
      db.close();
    }
  }, 60_000);
});
