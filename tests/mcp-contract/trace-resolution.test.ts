import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

/**
 * Same-named definitions across a monorepo — the shape that broke trace_path
 * and context_pack on a real repo with eleven `useApp` hooks.
 *
 * Two regressions are pinned here:
 *  1. The `path::Name` display form search_graph prints must be accepted back
 *     by trace_path (it used to return "No results" for every symbol).
 *  2. Once resolved, a trace must start from THAT node. It used to re-look-up
 *     the bare name with `LIMIT 1`, so academy's `useApp` reported studio's
 *     caller and studio's callees. Studio is inserted first below so that a
 *     name lookup would land on it.
 */
describe("trace_path / context_pack resolve to the exact symbol", () => {
  let h: HarnessContext;
  const ACADEMY = "apps/academy/src/use-app.ts::useApp";
  const STUDIO = "apps/studio/src/use-app.ts::useApp";

  beforeAll(async () => {
    h = await createHarness();
    const db = new Database(join(h.repoPath, ".cortex", "db"));
    const now = new Date().toISOString();
    const node = db.prepare(
      `INSERT INTO nodes (id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at, start_line, end_line, project)
       VALUES (?, 'function', ?, ?, ?, '{}', 'personal', ?, ?, 1, 5, ?)`,
    );
    const calls = db.prepare(
      `INSERT INTO edges (id, source_id, target_id, relation, data, created_at, project)
       VALUES (?, ?, ?, 'CALLS', '{}', ?, ?)`,
    );
    const fn = (id: string, file: string, name: string) => {
      const qn = `${h.project}.${file.replace(/\.tsx?$/, "").split("/").join(".")}.${name}`;
      node.run(id, name, qn, file, now, now, h.project);
    };
    db.transaction(() => {
      fn("tr-studio-useapp", "apps/studio/src/use-app.ts", "useApp");
      fn("tr-academy-useapp", "apps/academy/src/use-app.ts", "useApp");
      fn("tr-studio-inner", "apps/studio/src/app-inner.tsx", "StudioInner");
      fn("tr-academy-inner", "apps/academy/src/app-inner.tsx", "AcademyInner");
      fn("tr-use-features", "libs/features/src/use-features.ts", "useFeatures");
      fn("tr-use-inject", "packages/service/src/use-inject.ts", "useInject");
      calls.run("tr-e1", "tr-studio-inner", "tr-studio-useapp", now, h.project);
      calls.run("tr-e2", "tr-academy-inner", "tr-academy-useapp", now, h.project);
      calls.run("tr-e3", "tr-studio-useapp", "tr-use-features", now, h.project);
      calls.run("tr-e4", "tr-academy-useapp", "tr-use-inject", now, h.project);
    })();
    db.close();
  });
  afterAll(async () => { await h.close(); });

  it("trace_path accepts the display form and traces that node's callers", async () => {
    const res = await callTool(h, "trace_path", { function_name: ACADEMY, mode: "callers", max_depth: 1 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("AcademyInner");
    expect(res.content[0].text).not.toContain("StudioInner");
  });

  it("trace_path traces that node's callees, not a same-named sibling's", async () => {
    const res = await callTool(h, "trace_path", { function_name: ACADEMY, mode: "calls", max_depth: 1 });
    expect(res.content[0].text).toContain("useInject");
    expect(res.content[0].text).not.toContain("useFeatures");

    const studio = await callTool(h, "trace_path", { function_name: STUDIO, mode: "calls", max_depth: 1 });
    expect(studio.content[0].text).toContain("useFeatures");
    expect(studio.content[0].text).not.toContain("useInject");
  });

  it("an id printed by search_graph round-trips into trace_path", async () => {
    const search = await callTool(h, "search_graph", { name_pattern: "useApp" });
    const ids = [...search.content[0].text.matchAll(/^\S+ (\S+::useApp) /gm)].map((m) => m[1]);
    expect(ids).toEqual(expect.arrayContaining([ACADEMY, STUDIO]));
    for (const id of ids) {
      const res = await callTool(h, "trace_path", { function_name: id, mode: "callers", max_depth: 1 });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).not.toMatch(/^No results/);
    }
  });

  it("context_pack lists the resolved node's own callers and callees", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: ACADEMY });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    const section = (name: string) => text.split(`## ${name}`)[1]?.split("\n## ")[0] ?? "";
    expect(section("CALLERS")).toContain("AcademyInner");
    expect(section("CALLERS")).not.toContain("StudioInner");
    expect(section("CALLEES")).toContain("useInject");
    expect(section("CALLEES")).not.toContain("useFeatures");
  });

  it("a bare ambiguous name lists every definition in the display form", async () => {
    const res = await callTool(h, "trace_path", { function_name: "useApp", mode: "callers" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
    expect(res.content[0].text).toContain(ACADEMY);
    expect(res.content[0].text).toContain(STUDIO);
  });

  it("get_code_snippet resolves the display form to the same node", async () => {
    const res = await callTool(h, "get_code_snippet", { qualified_name: ACADEMY });
    // The synthetic file is not on disk, so the read itself fails — but it
    // must fail READING the academy file, proving that node was resolved. (A
    // resolver miss would answer "No results", echoing the input path.)
    expect(res.content[0].text).toMatch(/ERROR reason=fs_error\b.*apps\/academy\/src\/use-app\.ts/);
    expect(res.content[0].text).not.toContain("apps/studio");
  });
});
