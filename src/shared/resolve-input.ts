import { GraphStore } from "../graph/store.js";

/**
 * A symbol the resolver settled on.
 *
 * `id` is the node's primary key — the only identifier that is unique by
 * construction — so it is what every consumer must start a graph walk or a
 * snippet read from. `qn`/`file_path`/`kind` are for display and
 * disambiguation. Re-resolving from them, above all from the bare name, can
 * land on a different node that merely shares the name: a monorepo defines
 * `useApp` once per app.
 */
export type ResolvedSymbol = { id: string; qn: string; file_path: string; kind: string };

export type ResolveResult =
  | { kind: "single"; symbol: ResolvedSymbol }
  /** `candidates` is capped at {@link MAX_CANDIDATES}; `total` is the true count. */
  | { kind: "multi"; candidates: ResolvedSymbol[]; total: number; input: string }
  | { kind: "none"; input: string };

/**
 * How many candidates an ambiguous result carries. The cap used to be 5, which
 * hid most of a monorepo's same-named definitions — the one the caller wanted
 * was often not on the list it was told to pick from.
 */
export const MAX_CANDIDATES = 25;

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLS = "id, qualified_name AS qn, file_path, kind";
/** Not code symbols — mirrors CODE_KIND_FILTER in graph/code-queries.ts. */
const SYMBOL_KINDS = "kind NOT IN ('decision', 'pr', 'todo')";
/** Nodes that carry a file's path without being a definition inside it. */
const DEFINITION_KINDS = "kind NOT IN ('project', 'folder', 'file', 'module')";

type Found = { rows: ResolvedSymbol[]; total: number };

function find(store: GraphStore, where: string, params: unknown[], orderBy: string): Found {
  const rows = store.queryRaw<ResolvedSymbol>(
    `SELECT ${COLS} FROM nodes WHERE ${where} ORDER BY ${orderBy} LIMIT ${MAX_CANDIDATES}`,
    params,
  );
  if (rows.length < MAX_CANDIDATES) return { rows, total: rows.length };
  const [count] = store.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`, params);
  return { rows, total: count?.n ?? rows.length };
}

/**
 * SQL predicate: `col` ends with `value`, compared exactly. LIKE would treat
 * `_` — common in identifiers and paths — as a wildcard, and fold ASCII case.
 * The length is counted in code points, as SQLite's substr() counts them.
 */
function endsWith(col: string, value: string): { sql: string; params: unknown[] } {
  return { sql: `substr(${col}, -?) = ?`, params: [[...value].length, value] };
}

function stripLastExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 ? path.slice(0, dot) : path;
}

/**
 * The display form `path/to/file.ts::Symbol` — what search_graph, trace_path,
 * context_pack and get_code_snippet print for every JS/TS symbol (see
 * `denormalize` in mcp-server/qualified-name.ts), so it must resolve back.
 *
 * Tried exactly first: the indexer names a definition `<module qn>.<symbol>`,
 * where the module qn is the project plus the dotted path minus its
 * extension, so this is the precise inverse of the display form. The fallback
 * covers an abbreviated path (`use-app.ts::useApp`), a symbol written without
 * its enclosing class, and a project name the caller derived differently.
 * It excludes structural kinds, or `Button.tsx::Button` would hit the module
 * `…src.Button` (which also ends in `.Button`) instead of the component.
 */
function lookupByDisplayForm(
  store: GraphStore,
  project: string,
  filePart: string,
  symbol: string,
): Found {
  const exactQn = `${project}.${stripLastExt(filePart).split("/").join(".")}.${symbol}`;
  const exact = find(store, `qualified_name = ? AND ${SYMBOL_KINDS}`, [exactQn], "id");
  if (exact.rows.length > 0) return exact;

  const fileTail = endsWith("file_path", `/${filePart}`);
  const qnTail = endsWith("qualified_name", `.${symbol}`);
  const rows = store.queryRaw<ResolvedSymbol>(
    `SELECT ${COLS} FROM nodes
     WHERE (file_path = ? OR ${fileTail.sql}) AND ${qnTail.sql} AND ${SYMBOL_KINDS} AND ${DEFINITION_KINDS}
     ORDER BY file_path, length(qualified_name), qualified_name
     LIMIT ${MAX_CANDIDATES * 8}`,
    [filePart, ...fileTail.params, ...qnTail.params],
  );
  // One definition per file: the shortest qn is the one directly under the
  // module, which is what the display form names. A longer qn with the same
  // tail is nested (`Widget.render` when the input says `render`).
  const perFile = new Map<string, ResolvedSymbol>();
  for (const r of rows) if (!perFile.has(r.file_path)) perFile.set(r.file_path, r);
  const all = [...perFile.values()];
  return { rows: all.slice(0, MAX_CANDIDATES), total: all.length };
}

function splitFileSymbol(input: string): { filePath: string; symbol: string } | null {
  // editor-jump style: `path/to/file.ext:identifier`
  const colonIdx = input.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx >= input.length - 1) return null;
  const filePath = input.slice(0, colonIdx);
  const symbol = input.slice(colonIdx + 1);
  if (!SOURCE_EXTS.test(filePath)) return null;
  if (!IDENTIFIER.test(symbol)) return null;
  return { filePath, symbol };
}

function resolveWith(store: GraphStore, input: string, project: string): Found {
  // 0. Display form `path::Symbol`. Explicit about its file, so a miss here is
  //    final — no later step could match a string containing `::`.
  const sep = input.indexOf("::");
  if (sep > 0 && sep < input.length - 2) {
    return lookupByDisplayForm(store, project, input.slice(0, sep), input.slice(sep + 2));
  }

  // 0b. file:symbol form (editor-jump style, e.g. apps/foo/bar.ts:Baz)
  const split = splitFileSymbol(input);
  if (split) {
    const found = find(
      store,
      `(file_path = ? OR file_path LIKE ('%' || ?)) AND name = ? AND ${SYMBOL_KINDS}`,
      [split.filePath, split.filePath, split.symbol],
      "file_path, qualified_name",
    );
    if (found.rows.length > 0) return found;
  }

  // 1. File path (contains '/' or ends in a source extension)
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    const found = find(
      store,
      `(file_path = ? OR file_path LIKE ('%' || ?)) AND ${SYMBOL_KINDS}`,
      [input, input],
      "file_path, qualified_name",
    );
    if (found.rows.length > 0) return found;
  }

  // 2. Canonical qn (starts with project prefix)
  if (input.startsWith(`${project}.`)) {
    const found = find(store, `qualified_name = ? AND ${SYMBOL_KINDS}`, [input], "id");
    if (found.rows.length > 0) return found;
  }

  // 3. Dotted suffix (e.g. components.foo)
  if (input.includes(".") && !input.includes("/")) {
    const exact = find(store, `qualified_name = ? AND ${SYMBOL_KINDS}`, [input], "id");
    if (exact.rows.length > 0) return exact;
    const suffix = find(
      store,
      `qualified_name LIKE ('%' || ?) AND ${SYMBOL_KINDS}`,
      [input],
      "qualified_name",
    );
    if (suffix.rows.length > 0) return suffix;
  }

  // 4. Bare name — exact matches first, so `useInject` is not made ambiguous
  //    by `useInjectFoo`; substring matches only when nothing is named exactly.
  const exact = find(store, `name = ? AND ${SYMBOL_KINDS}`, [input], "file_path, qualified_name");
  if (exact.rows.length > 0) return exact;
  return find(store, `name LIKE ? AND ${SYMBOL_KINDS}`, [`%${input}%`], "file_path, qualified_name");
}

export function resolveInput(input: string, project: string, dbPath: string): ResolveResult {
  const store = new GraphStore(dbPath);
  try {
    const found = resolveWith(store, input, project);
    if (found.rows.length === 0) return { kind: "none", input };
    if (found.total === 1) return { kind: "single", symbol: found.rows[0] };
    return { kind: "multi", candidates: found.rows, total: found.total, input };
  } finally {
    store.close();
  }
}
