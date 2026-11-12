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

/**
 * Nesting depth of a qualified name: its scope separators, `.` and the `::`
 * C++ names carry (`…simplecpp::TokenList::Stream.readChar`).
 */
const DEPTH =
  "(length(qualified_name) - length(replace(qualified_name, '.', '')))" +
  " + (length(qualified_name) - length(replace(qualified_name, '::', ''))) / 2";

type Found = { rows: ResolvedSymbol[]; total: number };
type Predicate = { sql: string; params: unknown[] };

/**
 * Up to {@link MAX_CANDIDATES} rows of `select` — any query yielding `id, qn,
 * file_path, kind` — ordered by `orderBy` (those column names), and the true
 * count, from one pass: the window count is taken before the LIMIT.
 */
function findIn(store: GraphStore, select: string, params: unknown[], orderBy: string): Found {
  const rows = store.queryRaw<ResolvedSymbol & { total: number }>(
    `SELECT id, qn, file_path, kind, COUNT(*) OVER () AS total FROM (${select})
     ORDER BY ${orderBy} LIMIT ${MAX_CANDIDATES}`,
    params,
  );
  return { rows: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 };
}

function find(store: GraphStore, where: string, params: unknown[], orderBy: string): Found {
  return findIn(store, `SELECT ${COLS} FROM nodes WHERE ${where}`, params, orderBy);
}

/** ASCII-only lowercasing — what SQLite's lower() does, so both sides fold alike. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * SQL predicate: `col` ends with `value`, compared exactly, or with `fold`
 * ignoring ASCII case. LIKE would also treat `_` — common in identifiers and
 * paths — as a wildcard. The length is counted in code points, as SQLite's
 * substr() counts them.
 */
function endsWith(col: string, value: string, fold = false): Predicate {
  const v = fold ? asciiLower(value) : value;
  return { sql: `substr(${fold ? `lower(${col})` : col}, -?) = ?`, params: [[...v].length, v] };
}

/**
 * SQL predicate: `file_path` is `path`, or ends with it from a `/` — so
 * `Card.vue` is `apps/Card.vue`, never `apps/IdCard.vue`. Callers try it
 * exactly and then with `fold`: a case-insensitive filesystem lets
 * `src/upper.ts` name `src/Upper.ts`, but an exact match always wins.
 */
function pathIs(path: string, fold: boolean): Predicate {
  const col = fold ? "lower(file_path)" : "file_path";
  const tail = endsWith("file_path", `/${path}`, fold);
  return { sql: `(${col} = ? OR ${tail.sql})`, params: [fold ? asciiLower(path) : path, ...tail.params] };
}

/**
 * SQL predicate: `qualified_name` ends with `tail` from a scope boundary — a
 * `.`, or the `::` of a C++ name — so `a.render` is never `…data.render`.
 */
function qnEndsWith(tail: string): Predicate {
  const dot = endsWith("qualified_name", `.${tail}`);
  const scope = endsWith("qualified_name", `::${tail}`);
  return { sql: `(${dot.sql} OR ${scope.sql})`, params: [...dot.params, ...scope.params] };
}

/** A path as typed, minus a leading `/` or `./` — file_path is repo-relative. */
function trimPath(path: string): string {
  return path.replace(/^(\.?\/)+/, "");
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
 * its enclosing class, and a project name the caller derived differently
 * (decision `why` derives it from the repo path). It excludes structural
 * kinds, or `Button.tsx::Button` would hit the module `…src.Button` (which
 * also ends in `.Button`) instead of the component.
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

  // Per file, keep only the least-nested matches — every row from one file
  // shares its module prefix, so a depth difference is pure nesting. One
  // shallowest match is the definition the display form names (`render`, not
  // `Widget.render`). Several are siblings nested equally deep (`Foo.render`,
  // `Bar.render`) and stay ambiguous: the resolver reports, it does not guess.
  // Done in SQL so `total` counts every file.
  const qnTail = qnEndsWith(symbol);
  for (const fold of [false, true]) {
    const file = pathIs(filePart, fold);
    const shallowest = `SELECT id, qn, file_path, kind FROM (
        SELECT ${COLS}, ${DEPTH} AS depth, MIN(${DEPTH}) OVER (PARTITION BY file_path) AS least
        FROM nodes
        WHERE ${file.sql} AND ${qnTail.sql} AND ${SYMBOL_KINDS} AND ${DEFINITION_KINDS}
      ) WHERE depth = least`;
    const found = findIn(store, shallowest, [...file.params, ...qnTail.params], "file_path, qn");
    if (found.rows.length > 0) return found;
  }
  return { rows: [], total: 0 };
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
  // Suffix matching below starts at a boundary — a `/` in a path, a `.` or
  // `::` in a qn — so `Card.vue` is never `IdCard.vue` and `a.render` never
  // `data.render`. A suffix that only happened to match was a silent wrong
  // answer whenever it was the sole match.

  // 0. Display form `path::Symbol`, split at the FIRST `::`: a file path never
  //    contains one, but a symbol can (C++ `ns::Class.method`). Only a first
  //    part that could be a path — one with a `/` or an extension — is looked
  //    up, and a miss falls through: a canonical qn or a plain name can
  //    contain `::` too (`…simplecpp::TokenList::Stream.readChar`, a JSON key
  //    `Fn::Join`). No step below matches a real display form, so that is safe.
  const sep = input.indexOf("::");
  if (sep > 0 && sep < input.length - 2) {
    const filePart = trimPath(input.slice(0, sep));
    if (!input.startsWith(`${project}.`) && /[/.]/.test(filePart)) {
      const found = lookupByDisplayForm(store, project, filePart, input.slice(sep + 2));
      if (found.rows.length > 0) return found;
    }
  }

  // 0b. file:symbol form (editor-jump style, e.g. apps/foo/bar.ts:Baz)
  const split = splitFileSymbol(input);
  if (split) {
    for (const fold of [false, true]) {
      const file = pathIs(trimPath(split.filePath), fold);
      const found = find(
        store,
        `${file.sql} AND name = ? AND ${SYMBOL_KINDS}`,
        [...file.params, split.symbol],
        "file_path, qn",
      );
      if (found.rows.length > 0) return found;
    }
  }

  // 1. File path (contains '/' or ends in a source extension) — the whole
  //    path or a trailing part of it.
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    for (const fold of [false, true]) {
      const file = pathIs(trimPath(input), fold);
      const found = find(store, `${file.sql} AND ${SYMBOL_KINDS}`, file.params, "file_path, qn");
      if (found.rows.length > 0) return found;
    }
  }

  // 2. Canonical qn (starts with project prefix)
  if (input.startsWith(`${project}.`)) {
    const found = find(store, `qualified_name = ? AND ${SYMBOL_KINDS}`, [input], "id");
    if (found.rows.length > 0) return found;
  }

  // 3. Dotted suffix (e.g. components.foo) — the whole qn or a trailing part.
  if (input.includes(".") && !input.includes("/")) {
    const exact = find(store, `qualified_name = ? AND ${SYMBOL_KINDS}`, [input], "id");
    if (exact.rows.length > 0) return exact;
    const tail = qnEndsWith(input);
    const suffix = find(store, `${tail.sql} AND ${SYMBOL_KINDS}`, tail.params, "qn");
    if (suffix.rows.length > 0) return suffix;
  }

  // 4. Bare name — exact matches first, so `useInject` is not made ambiguous
  //    by `useInjectFoo`. Substring matches only when nothing is named exactly,
  //    and only for an input with no `/` or `.`: such an input names a path or
  //    a qn, and passing `IdCard.vue` off as `Card.vue` here would undo the
  //    boundary matching above. (`TokenList::Stream` may still find
  //    `simplecpp::TokenList::Stream`.)
  const exact = find(store, `name = ? AND ${SYMBOL_KINDS}`, [input], "file_path, qn");
  if (exact.rows.length > 0 || /[/.]/.test(input)) return exact;
  return find(store, `name LIKE ? AND ${SYMBOL_KINDS}`, [`%${input}%`], "file_path, qn");
}

/**
 * Rows that all carry one qualified name are one symbol as far as any caller
 * can tell: listing them would ask it to choose between identical IDs, and
 * the ID it sent back would resolve to the same list again. The indexer keeps
 * qualified names unique, so this is defensive; the first row is taken.
 */
function isOneSymbol(found: Found): boolean {
  return found.rows.length === found.total && found.rows.every((r) => r.qn === found.rows[0].qn);
}

export function resolveInput(input: string, project: string, dbPath: string): ResolveResult {
  const store = new GraphStore(dbPath);
  try {
    const found = resolveWith(store, input, project);
    if (found.rows.length === 0) return { kind: "none", input };
    if (found.total === 1 || isOneSymbol(found)) return { kind: "single", symbol: found.rows[0] };
    return { kind: "multi", candidates: found.rows, total: found.total, input };
  } finally {
    store.close();
  }
}
