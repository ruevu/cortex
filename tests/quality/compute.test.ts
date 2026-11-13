import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { computeGraphQuality, pct } from "../../src/quality/compute.js";

/**
 * The calibrated definitions (decision D-kn9w): every CALLS edge gets one
 * label, member calls into a suspect hub are demoted to a name guess
 * whatever their confidence, and the verdict is judged on the shares.
 * Expected values here are hand-derived literals, never the module's own
 * constants — a test that reads the threshold it checks cannot catch a
 * wrong threshold.
 */
describe("computeGraphQuality", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-quality-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const quality = () => computeGraphQuality(store.queryRaw.bind(store));

  function fn(name: string, file = "src/a.ts", kind = "function") {
    return store.createNode({ kind, name, qualified_name: `p.${file}.${name}`, file_path: file });
  }

  /** A CALLS edge as the indexer writes it; `confidence` undefined = no score. */
  function call(src: { id: string }, tgt: { id: string }, callee: string, confidence?: number) {
    return store.createEdge({
      source_id: src.id,
      target_id: tgt.id,
      relation: "CALLS",
      data: confidence === undefined ? {} : { callee, strategy: "unique_name", confidence },
    });
  }

  /** `receivers` member calls `r0.<name>` … into `target`, all at 0.95. */
  function memberCalls(src: { id: string }, target: { id: string }, name: string, receivers: number) {
    for (let i = 0; i < receivers; i++) call(src, target, `r${i}.${name}`, 0.95);
  }

  /** Bare calls between two functions: resolved at 0.95, guess at 0.30, unscored with no data. */
  function seed(counts: { resolved?: number; guess?: number; unscored?: number }) {
    const src = fn("caller");
    const tgt = fn("target", "src/b.ts");
    for (let i = 0; i < (counts.resolved ?? 0); i++) call(src, tgt, "target", 0.95);
    for (let i = 0; i < (counts.guess ?? 0); i++) call(src, tgt, "target", 0.3);
    for (let i = 0; i < (counts.unscored ?? 0); i++) call(src, tgt, "target");
  }

  it("partitions CALLS edges by confidence band", () => {
    const src = fn("caller");
    const tgt = fn("target", "src/b.ts");
    for (const c of [0.95, 0.7, 0.55, 0.45, 0.4499, 0.1]) call(src, tgt, "target", c);
    call(src, tgt, "target"); // no confidence at all
    store.createEdge({ source_id: src.id, target_id: tgt.id, relation: "IMPORTS" });

    expect(quality().calls).toEqual({
      total: 7, resolved: 2, likely: 2, name_guess: 2, unscored: 1, hub_edges: 0,
    });
  });

  it("demotes member calls into a suspect hub regardless of confidence", () => {
    const map = fn("map", "src/helpers.test.ts");
    memberCalls(fn("caller"), map, "map", 10);

    const q = quality();
    expect(q.calls).toMatchObject({ hub_edges: 10, name_guess: 10, resolved: 0 });
    expect(q.suspect_hubs).toEqual([{ name: "map", file: "src/helpers.test.ts", calls: 10, receivers: 10 }]);
    expect(q.hub_count).toBe(1);
  });

  it("nine receivers is not a hub", () => {
    memberCalls(fn("caller"), fn("map", "src/helpers.test.ts"), "map", 9);

    const q = quality();
    expect(q.calls).toMatchObject({ hub_edges: 0, resolved: 9 });
    expect(q.hub_count).toBe(0);
  });

  it("a bare call into a hub keeps its band", () => {
    const caller = fn("caller");
    const map = fn("map", "src/helpers.test.ts");
    memberCalls(caller, map, "map", 10);
    call(caller, map, "map", 0.95);

    const q = quality();
    expect(q.calls).toMatchObject({ resolved: 1, hub_edges: 10 });
    expect(q.suspect_hubs[0]?.calls).toBe(10);
  });

  it("a method target is never a hub", () => {
    memberCalls(fn("caller"), fn("map", "src/list.ts", "method"), "map", 10);

    const q = quality();
    expect(q.hub_count).toBe(0);
    expect(q.calls).toMatchObject({ hub_edges: 0, resolved: 10 });
  });

  it("malformed edge JSON is unscored and never throws", () => {
    const edge = call(fn("caller"), fn("target", "src/b.ts"), "target", 0.95);
    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE edges SET data = ? WHERE id = ?").run('{"callee":"a\nb', edge.id);
    } finally {
      raw.close();
    }

    let q: ReturnType<typeof quality> | undefined;
    expect(() => { q = quality(); }).not.toThrow();
    expect(q?.calls).toMatchObject({ total: 1, unscored: 1, resolved: 0 });
  });

  it("empty graph: zero shares, ok, not judged", () => {
    expect(quality()).toEqual({
      calls: { total: 0, resolved: 0, likely: 0, name_guess: 0, unscored: 0, hub_edges: 0 },
      guess_share: 0,
      hub_share: 0,
      hub_count: 0,
      suspect_hubs: [],
      verdict: {
        level: "ok", judged: false, reasons: [], advice: null,
        note: "too few call edges to judge (0 < 200)",
      },
    });
  });

  describe("verdict thresholds", () => {
    const ADVICE = "treat callers/callees as hints; confirm with search_code";

    it.each([
      { name: "50% guesses is poor", counts: { resolved: 100, guess: 100 },
        verdict: { level: "poor", judged: true, reasons: ["50.0% of call edges are name guesses"], advice: ADVICE, note: null } },
      { name: "40% guesses is degraded", counts: { resolved: 120, guess: 80 },
        verdict: { level: "degraded", judged: true, reasons: ["40.0% of call edges are name guesses"], advice: ADVICE, note: null } },
      { name: "39.5% guesses is ok", counts: { resolved: 121, guess: 79 },
        verdict: { level: "ok", judged: true, reasons: [], advice: null, note: null } },
      { name: "199 edges are too few to judge", counts: { guess: 199 },
        verdict: { level: "ok", judged: false, reasons: [], advice: null, note: "too few call edges to judge (199 < 200)" } },
      { name: "mostly unscored is not judged", counts: { unscored: 101, guess: 99 },
        verdict: { level: "ok", judged: false, reasons: [], advice: null, note: "most call edges carry no confidence score (101 of 200)" } },
      { name: "exactly half unscored is still judged", counts: { unscored: 100, guess: 100 },
        verdict: { level: "poor", judged: true, reasons: ["50.0% of call edges are name guesses"], advice: ADVICE, note: null } },
    ])("$name", ({ counts, verdict }) => {
      seed(counts);
      expect(quality().verdict).toEqual(verdict);
    });

    it("hub share alone degrades", () => {
      const caller = fn("caller");
      memberCalls(caller, fn("map", "src/helpers.test.ts"), "map", 20);
      const other = fn("other", "src/b.ts");
      for (let i = 0; i < 180; i++) call(caller, other, "other", 0.95);

      expect(quality().verdict).toEqual({
        level: "degraded", judged: true,
        reasons: ["10.0% of call edges run through suspect hubs (map)"],
        advice: ADVICE, note: null,
      });
    });

    it("hub share just under a tenth stays ok", () => {
      // Pins the 10% hub threshold from below; "hub share alone degrades"
      // pins it from above.
      const caller = fn("caller");
      memberCalls(caller, fn("map", "src/helpers.test.ts"), "map", 19);
      const other = fn("other", "src/b.ts");
      for (let i = 0; i < 181; i++) call(caller, other, "other", 0.95);

      expect(quality().verdict).toEqual({ level: "ok", judged: true, reasons: [], advice: null, note: null });
    });

    it("hub list is capped and ordered", () => {
      const caller = fn("caller");
      for (let i = 0; i < 12; i++) {
        const name = `h${String(i).padStart(2, "0")}`;
        memberCalls(caller, fn(name, `src/${name}.ts`), name, 10 + i);
      }
      const other = fn("other", "src/b.ts");
      for (let i = 0; i < 14; i++) call(caller, other, "other", 0.95);

      const q = quality();
      expect(q.hub_count).toBe(12);
      expect(q.suspect_hubs).toHaveLength(10);
      expect(q.suspect_hubs[0]).toEqual({ name: "h11", file: "src/h11.ts", calls: 21, receivers: 21 });
      expect(q.verdict.reasons).toEqual([
        "93.0% of call edges are name guesses",
        "93.0% of call edges run through suspect hubs (h11, h10, h09, …)",
      ]);
    });
  });

  it("pct floors from integer counts", () => {
    expect(pct(57, 100)).toBe("57.0%"); // 0.57 * 100 is 56.99999999999999 in float
    expect(pct(4999, 10000)).toBe("49.9%");
    expect(pct(1, 3)).toBe("33.3%");
    expect(pct(0, 0)).toBe("0.0%");
  });
});
