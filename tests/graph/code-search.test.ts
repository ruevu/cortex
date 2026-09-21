import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { runCodeSearch, rankHits, fileTier, TIER } from "../../src/graph/code-search.js";
import type { SearchHit } from "../../src/graph/code-search.js";

describe("runCodeSearch", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-search-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "tests"));
    mkdirSync(join(dir, "__snapshots__"));
    // The file that DEFINES the symbol. One mention only — the point of the
    // ranker is that it still comes first against files that mention it more.
    writeFileSync(join(dir, "src", "a.ts"), "export function extractThing() {\n  return 1;\n}\n");
    writeFileSync(join(dir, "src", "b.ts"), "import { extractThing } from './a.js';\nextractThing();\n");
    // Five mentions, the way a test file for one function actually looks.
    writeFileSync(
      join(dir, "tests", "a.test.ts"),
      Array.from({ length: 5 }, (_, i) => `it('case ${i}', () => extractThing());`).join("\n") + "\n",
    );
    writeFileSync(join(dir, "notes.md"), "# Doc\nthis mentions extractThing in prose\n");
    writeFileSync(join(dir, "__snapshots__", "x.snap"), "exports[`extractThing 1`] = `x`;\n");

    const dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
    const fn = store.createNode({ kind: "function", name: "extractThing", qualified_name: "p.src.a.extractThing", file_path: "src/a.ts" });
    const db = new Database(dbPath);
    db.prepare("UPDATE nodes SET project = ?, start_line = 1, end_line = 3 WHERE id = ?").run("p", fn.id);
    db.close();
  });
  afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns hits with file/line/text parsed from rg output", async () => {
    const out = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, maxHits: 50 });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    const files = out.hits.map((h) => h.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("notes.md");
    const aHit = out.hits.find((h) => h.file === "src/a.ts")!;
    expect(aHit.line).toBeGreaterThan(0);
    expect(aHit.text).toContain("extractThing");
  });

  it("annotates the enclosing symbol when store + project are given", async () => {
    const out = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, store, project: "p", maxHits: 50 });
    if (out.kind !== "hits") throw new Error("expected hits");
    const aHit = out.hits.find((h) => h.file === "src/a.ts" && h.enclosing)!;
    expect(aHit.enclosing!.kind).toBe("function");
    expect(aHit.enclosing!.qualified_name).toBe("p.src.a.extractThing");
    const mdHit = out.hits.find((h) => h.file === "notes.md")!;
    expect(mdHit.enclosing).toBeUndefined();
  });

  /**
   * The bug this file is the regression test for. `search_code` collected the
   * first N lines ripgrep happened to emit and stopped — and ripgrep's parallel
   * walker emits in nondeterministic order, so the surviving N were an arbitrary
   * sample. Measured on Mesh: `parseClaudeLine`, 150 matches, and the file that
   * DEFINES it landed at emission index 68–137 across five identical runs. It
   * never once made the first 50.
   */
  it("ranks the defining file first, whatever order rg emitted", async () => {
    const out = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, store, project: "p", maxHits: 50 });
    if (out.kind !== "hits") throw new Error("expected hits");
    expect(out.hits[0]!.file).toBe("src/a.ts");
  });

  it("orders whole files by tier: definition, source, test, docs, fixture", async () => {
    const out = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, store, project: "p", maxHits: 50 });
    if (out.kind !== "hits") throw new Error("expected hits");
    // First appearance of each file, in output order.
    const order = [...new Set(out.hits.map((h) => h.file))];
    expect(order).toEqual(["src/a.ts", "src/b.ts", "tests/a.test.ts", "notes.md", "__snapshots__/x.snap"]);
  });

  it("reports the true total, and truncated when the window is smaller", async () => {
    const all = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, maxHits: 50 });
    if (all.kind !== "hits") throw new Error("expected hits");
    expect(all.total).toBe(10); // 1 + 2 + 5 + 1 + 1
    expect(all.truncated).toBe(false);

    const capped = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, maxHits: 3 });
    if (capped.kind !== "hits") throw new Error("expected hits");
    expect(capped.hits.length).toBe(3);
    // The denominator is every match, NOT the window — that is the whole point.
    expect(capped.total).toBe(10);
    expect(capped.truncated).toBe(true);
  });

  it("caps hits per file and says how many it withheld", async () => {
    const out = await runCodeSearch({ pattern: "extractThing", repoRoot: dir, store, project: "p", maxHits: 50, perFileCap: 2 });
    if (out.kind !== "hits") throw new Error("expected hits");
    const fromTest = out.hits.filter((h) => h.file === "tests/a.test.ts");
    expect(fromTest.length).toBe(2);
    expect(fromTest[1]!.moreInFile).toBe(3);
    // Capping one file must not cost the others their place.
    expect(out.hits.map((h) => h.file)).toContain("__snapshots__/x.snap");
  });

  it("returns empty for a pattern with no matches", async () => {
    const out = await runCodeSearch({ pattern: "zzznomatchzzz", repoRoot: dir });
    expect(out.kind).toBe("empty");
  });

  it("returns invalid_pattern for a bad regex", async () => {
    const out = await runCodeSearch({ pattern: "(", repoRoot: dir });
    expect(out.kind).toBe("invalid_pattern");
  });

  /**
   * Without `--`, ripgrep parses a leading-dash pattern as a FLAG, exits 2 with
   * a usage error, and `classifySearchExec` — finding no output and no regex
   * parse error — reports `empty`. A false negative that reads exactly like a
   * genuine "no matches", which is the worst shape a search failure can take.
   */
  it("searches for a pattern that begins with a dash rather than reading it as a flag", async () => {
    writeFileSync(join(dir, "src", "flags.ts"), "const a = '--max-count';\n");
    const out = await runCodeSearch({ pattern: "--max-count", repoRoot: dir, maxHits: 50 });
    if (out.kind !== "hits") throw new Error(`expected hits, got ${out.kind}`);
    expect(out.hits.map((h) => h.file)).toContain("src/flags.ts");
  });
});

describe("fileTier", () => {
  const none = new Set<string>();

  it("puts a file the graph says defines the symbol above everything", () => {
    expect(fileTier("src/a.ts", new Set(["src/a.ts"]))).toBe(TIER.definition);
    expect(fileTier("src/a.ts", none)).toBe(TIER.source);
  });

  it("classifies tests by directory or by filename", () => {
    expect(fileTier("tests/a.test.ts", none)).toBe(TIER.test);
    expect(fileTier("test/a.ts", none)).toBe(TIER.test);
    expect(fileTier("e2e/shell.spec.ts", none)).toBe(TIER.test);
    expect(fileTier("packages/core/src/git/search.test.ts", none)).toBe(TIER.test);
    expect(fileTier("src/a.ts", none)).toBe(TIER.source);
  });

  it("classifies docs by extension", () => {
    expect(fileTier("docs/architecture/overview.md", none)).toBe(TIER.docs);
    expect(fileTier("README.md", none)).toBe(TIER.docs);
    expect(fileTier("notes.txt", none)).toBe(TIER.docs);
  });

  // Checked before the test rule: a snapshot dir sits INSIDE a test tree, and a
  // recorded fixture is worth less than the test that reads it. Measured case:
  // one `css-baseline.json` snapshot took all 50 slots of a real search.
  it("sinks fixtures and snapshots below the tests that own them", () => {
    expect(fileTier("e2e/__snapshots__/css-baseline.json", none)).toBe(TIER.fixture);
    expect(fileTier("tests/fixtures/run.ndjson", none)).toBe(TIER.fixture);
    expect(fileTier("src/__snapshots__/a.test.ts.snap", none)).toBe(TIER.fixture);
  });

  it("treats anything else as source", () => {
    expect(fileTier("packages/core/src/agents/ndjson.ts", none)).toBe(TIER.source);
    expect(fileTier("Makefile", none)).toBe(TIER.source);
  });
});

describe("rankHits", () => {
  const hit = (file: string, line = 1): SearchHit => ({ file, line, text: "t" });

  it("orders by tier, then path, then line", () => {
    const ranked = rankHits(
      [hit("z.md"), hit("b.ts", 2), hit("b.ts", 1), hit("a.ts"), hit("t/x.test.ts")],
      { maxHits: 50 },
    );
    expect(ranked.map((h) => `${h.file}:${h.line}`)).toEqual([
      "a.ts:1", "b.ts:1", "b.ts:2", "t/x.test.ts:1", "z.md:1",
    ]);
  });

  it("keeps a file's hits together rather than interleaving files", () => {
    const ranked = rankHits([hit("a.ts", 9), hit("b.ts", 1), hit("a.ts", 1)], { maxHits: 50 });
    expect(ranked.map((h) => h.file)).toEqual(["a.ts", "a.ts", "b.ts"]);
  });

  it("stops at maxHits", () => {
    const ranked = rankHits([hit("a.ts", 1), hit("a.ts", 2), hit("b.ts")], { maxHits: 2 });
    expect(ranked.length).toBe(2);
  });

  it("caps per file and marks the overflow on the last kept hit", () => {
    const many = [1, 2, 3, 4, 5].map((n) => hit("a.ts", n));
    const ranked = rankHits([...many, hit("b.ts")], { maxHits: 50, perFileCap: 2 });
    expect(ranked.map((h) => `${h.file}:${h.line}`)).toEqual(["a.ts:1", "a.ts:2", "b.ts:1"]);
    expect(ranked[1]!.moreInFile).toBe(3);
    expect(ranked[0]!.moreInFile).toBeUndefined();
    expect(ranked[2]!.moreInFile).toBeUndefined();
  });

  it("does not mutate the input array or its hits", () => {
    const hits = [hit("b.ts", 2), hit("b.ts", 1), hit("a.ts")];
    const before = hits.map((h) => `${h.file}:${h.line}`);
    rankHits(hits, { maxHits: 50, perFileCap: 1 });
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(before);
    expect(hits.every((h) => h.moreInFile === undefined)).toBe(true);
  });
});
