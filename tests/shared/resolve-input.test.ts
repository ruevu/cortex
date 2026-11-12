import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInput, MAX_CANDIDATES } from "../../src/shared/resolve-input.js";

describe("shared resolveInput", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  const project = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-shared-resolve-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("single match by file path → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("apps/Card.vue", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.apps.Card");
  });

  it("single match by canonical qn → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("test-project.apps.Card", project, dbPath);
    expect(r.kind).toBe("single");
  });

  it("single match by bare name → kind: 'single'", () => {
    store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const r = resolveInput("handleRequest", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.src.handler.handleRequest");
  });

  it("multiple matches → kind: 'multi' with candidates", () => {
    store.createNode({ kind: "function", name: "render", file_path: "a.ts", qualified_name: "test-project.a.render" });
    store.createNode({ kind: "function", name: "render", file_path: "b.ts", qualified_name: "test-project.b.render" });
    const r = resolveInput("render", project, dbPath);
    expect(r.kind).toBe("multi");
    if (r.kind === "multi") expect(r.candidates.length).toBe(2);
  });

  it("no matches → kind: 'none'", () => {
    const r = resolveInput("apps/missing.vue", project, dbPath);
    expect(r.kind).toBe("none");
  });

  it("a single result carries the node's id — what callers must trace from", () => {
    const node = store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const r = resolveInput("handleRequest", project, dbPath);
    expect(r.kind === "single" && r.symbol.id).toBe(node.id);
  });

  describe("the path::Symbol display form every tool prints", () => {
    const fn = (file: string, qnTail: string, kind = "function") =>
      store.createNode({
        kind,
        name: qnTail.split(".").pop()!,
        file_path: file,
        qualified_name: `test-project.${qnTail}`,
      });

    it("resolves back to the node it was printed for", () => {
      const node = fn("packages/service/src/use-inject.ts", "packages.service.src.use-inject.useInject");
      const r = resolveInput("packages/service/src/use-inject.ts::useInject", project, dbPath);
      expect(r.kind).toBe("single");
      if (r.kind === "single") expect(r.symbol.id).toBe(node.id);
    });

    it("resolves a nested Class.method", () => {
      fn("src/widget.ts", "src.widget.render");
      const method = fn("src/widget.ts", "src.widget.Widget.render", "method");
      const r = resolveInput("src/widget.ts::Widget.render", project, dbPath);
      expect(r.kind === "single" && r.symbol.id).toBe(method.id);
    });

    it("prefers the top-level definition over a nested one with the same tail", () => {
      const top = fn("src/widget.ts", "src.widget.render");
      fn("src/widget.ts", "src.widget.Widget.render", "method");
      // A project name the caller derived differently forces the fallback path.
      const r = resolveInput("src/widget.ts::render", "some-other-name", dbPath);
      expect(r.kind === "single" && r.symbol.id).toBe(top.id);
    });

    it("picks the component, not the module, in a file named after it", () => {
      // The module qn `…src.Button` also ends in `.Button`.
      fn("src/Button.tsx", "src.Button", "module");
      const component = fn("src/Button.tsx", "src.Button.Button");
      expect(resolveInput("src/Button.tsx::Button", project, dbPath)).toMatchObject({
        kind: "single", symbol: { id: component.id },
      });
      expect(resolveInput("src/Button.tsx::Button", "some-other-name", dbPath)).toMatchObject({
        kind: "single", symbol: { id: component.id },
      });
    });

    it("works for a non-JS extension", () => {
      const model = fn("app/models.py", "app.models.Model", "class");
      const r = resolveInput("app/models.py::Model", project, dbPath);
      expect(r.kind === "single" && r.symbol.id).toBe(model.id);
    });

    it("an abbreviated path matching several files is ambiguous, one candidate per file", () => {
      fn("apps/academy/src/use-app.ts", "apps.academy.src.use-app.useApp");
      fn("apps/studio/src/use-app.ts", "apps.studio.src.use-app.useApp");
      const r = resolveInput("use-app.ts::useApp", project, dbPath);
      expect(r.kind).toBe("multi");
      if (r.kind === "multi") {
        expect(r.total).toBe(2);
        expect(r.candidates.map((c) => c.file_path).sort()).toEqual([
          "apps/academy/src/use-app.ts",
          "apps/studio/src/use-app.ts",
        ]);
      }
    });

    it("matches names exactly — `_` is not a wildcard, case is not folded", () => {
      fn("src/x.ts", "src.x.aXb");
      fn("src/x.ts", "src.x.Lower");
      expect(resolveInput("src/x.ts::a_b", "some-other-name", dbPath).kind).toBe("none");
      expect(resolveInput("src/x.ts::lower", "some-other-name", dbPath).kind).toBe("none");
    });

    it("a miss does not fall back to matching the bare symbol name", () => {
      fn("src/a.ts", "src.a.useApp");
      expect(resolveInput("src/elsewhere.ts::useApp", project, dbPath).kind).toBe("none");
    });

    it("lists equally nested same-named definitions instead of picking one", () => {
      const foo = fn("src/widget.ts", "src.widget.Foo.render", "method");
      const bar = fn("src/widget.ts", "src.widget.Bar.render", "method");
      const r = resolveInput("src/widget.ts::render", project, dbPath);
      expect(r.kind).toBe("multi");
      if (r.kind === "multi") {
        expect(r.total).toBe(2);
        expect(r.candidates.map((c) => c.id).sort()).toEqual([foo.id, bar.id].sort());
      }
    });

    it("counts every matching file, not a capped window of rows", () => {
      // Each file holds one top-level `main` and eight nested ones — enough
      // rows that a row-capped query would run out before the last files.
      const files = MAX_CANDIDATES + 5;
      for (let i = 0; i < files; i++) {
        fn(`pkg${i}/index.ts`, `pkg${i}.index.main`);
        for (let j = 0; j < 8; j++) fn(`pkg${i}/index.ts`, `pkg${i}.index.C${j}.main`, "method");
      }
      const r = resolveInput("index.ts::main", project, dbPath);
      expect(r.kind).toBe("multi");
      if (r.kind === "multi") {
        expect(r.total).toBe(files);
        expect(r.candidates).toHaveLength(MAX_CANDIDATES);
        expect(r.candidates.every((c) => c.kind === "function")).toBe(true);
      }
    });

    it("a `::` inside a name or a qn still resolves (C++ classes, JSON keys)", () => {
      const cls = store.createNode({
        kind: "class", name: "simplecpp::TokenList::Stream", file_path: "vendored/simplecpp.cpp",
        qualified_name: "test-project.vendored.simplecpp.simplecpp::TokenList::Stream",
      });
      const method = store.createNode({
        kind: "method", name: "readChar", file_path: "vendored/simplecpp.cpp",
        qualified_name: "test-project.vendored.simplecpp.simplecpp::TokenList::Stream.readChar",
      });
      expect(resolveInput("simplecpp::TokenList::Stream", project, dbPath)).toMatchObject({
        kind: "single", symbol: { id: cls.id },
      });
      expect(resolveInput(method.qualified_name!, project, dbPath)).toMatchObject({
        kind: "single", symbol: { id: method.id },
      });
      // The display form splits at the first `::`, so the symbol keeps its own.
      expect(
        resolveInput("vendored/simplecpp.cpp::simplecpp::TokenList::Stream.readChar", project, dbPath),
      ).toMatchObject({ kind: "single", symbol: { id: method.id } });
    });
  });

  describe("suffixes match from a boundary, exactly", () => {
    it("a file name does not match a longer file name ending in it", () => {
      const card = store.createNode({ kind: "module", name: "Card.vue", file_path: "apps/Card.vue", qualified_name: "test-project.apps.Card" });
      store.createNode({ kind: "module", name: "IdCard.vue", file_path: "apps/IdCard.vue", qualified_name: "test-project.apps.IdCard" });
      expect(resolveInput("Card.vue", project, dbPath)).toMatchObject({ kind: "single", symbol: { id: card.id } });
    });

    it("a lone near-miss does not resolve either", () => {
      store.createNode({ kind: "module", name: "IdCard.vue", file_path: "apps/IdCard.vue", qualified_name: "test-project.apps.IdCard" });
      store.createNode({ kind: "function", name: "mount", file_path: "apps/IdCard.vue", qualified_name: "test-project.apps.IdCard.mount" });
      store.createNode({ kind: "function", name: "render", file_path: "src/data.ts", qualified_name: "test-project.src.data.render" });
      expect(resolveInput("Card.vue", project, dbPath).kind).toBe("none");
      expect(resolveInput("Card.vue:mount", project, dbPath).kind).toBe("none");
      expect(resolveInput("a.render", project, dbPath).kind).toBe("none");
    });

    it("a dotted suffix ending at a segment boundary still resolves", () => {
      const node = store.createNode({ kind: "function", name: "render", file_path: "src/data.ts", qualified_name: "test-project.src.data.render" });
      expect(resolveInput("data.render", project, dbPath)).toMatchObject({ kind: "single", symbol: { id: node.id } });
    });
  });

  describe("bare names", () => {
    it("an exact name wins over names that merely contain it", () => {
      const exact = store.createNode({ kind: "function", name: "useInject", file_path: "a.ts", qualified_name: "test-project.a.useInject" });
      store.createNode({ kind: "function", name: "useInjectAll", file_path: "b.ts", qualified_name: "test-project.b.useInjectAll" });
      const r = resolveInput("useInject", project, dbPath);
      expect(r.kind === "single" && r.symbol.id).toBe(exact.id);
    });

    it("falls back to a substring match when nothing is named exactly", () => {
      const only = store.createNode({ kind: "function", name: "useInjectAll", file_path: "b.ts", qualified_name: "test-project.b.useInjectAll" });
      const r = resolveInput("InjectAll", project, dbPath);
      expect(r.kind === "single" && r.symbol.id).toBe(only.id);
    });

    it("lists every same-named definition, not just the first five", () => {
      for (let i = 0; i < 11; i++) {
        store.createNode({ kind: "function", name: "useApp", file_path: `apps/a${i}/use-app.ts`, qualified_name: `test-project.apps.a${i}.use-app.useApp` });
      }
      const r = resolveInput("useApp", project, dbPath);
      expect(r.kind).toBe("multi");
      if (r.kind === "multi") {
        expect(r.candidates).toHaveLength(11);
        expect(r.total).toBe(11);
      }
    });

    it("caps the candidate list but reports the true total", () => {
      for (let i = 0; i < MAX_CANDIDATES + 5; i++) {
        store.createNode({ kind: "function", name: "render", file_path: `c${i}.ts`, qualified_name: `test-project.c${i}.render` });
      }
      const r = resolveInput("render", project, dbPath);
      expect(r.kind).toBe("multi");
      if (r.kind === "multi") {
        expect(r.candidates).toHaveLength(MAX_CANDIDATES);
        expect(r.total).toBe(MAX_CANDIDATES + 5);
      }
    });
  });
});
