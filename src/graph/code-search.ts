import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { accessSync, constants as fsConstants } from "node:fs";
import type { GraphStore } from "./store.js";
import type { IndexerNode } from "./code-queries.js";

const execFileAsync = promisify(execFile);

export const RG_MAX_BUFFER = 64 * 1024 * 1024;

export function buildRgArgs(pattern: string): string[] {
  return [
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count", "200",
    // `--` before the pattern: without it a pattern that begins with a dash
    // (`--max-count`, `-rf`) is parsed as a FLAG. rg then exits 2 with a usage
    // error, which `classifySearchExec` reads as a search error with no output
    // and reports as `empty` — a silent false negative rather than a failure.
    // Mesh's palette search learned this first; see its search-args.ts.
    "--",
    pattern,
    ".",
  ];
}

export function buildGrepFallbackArgs(pattern: string): string[] {
  return [
    "-rn",
    "-I", // skip binary files (sqlite DBs, compiled objects)
    "-m", "200", // cap matches per file, mirroring rg's --max-count
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.cache",
    "--exclude-dir=vendored",
    // Derived / scratch trees. Unlike rg (which honors .gitignore), grep
    // recurses everything — these total ~1.7 GB in this repo and caused the
    // fallback to time out or exit 2 on an unreadable file.
    "--exclude-dir=.tmp",
    "--exclude-dir=.cortex",
    "--exclude-dir=.venv",
    "--", // same leading-dash guard as buildRgArgs
    pattern,
    ".",
  ];
}

const localRequire = createRequire(import.meta.url);
let cachedRgBinary: string | null | undefined;

/**
 * Resolve the ripgrep binary to invoke for `search_code`.
 *
 * Order of preference:
 *  1. `CORTEX_RG_PATH` env override — escape hatch for custom installs.
 *  2. The `@vscode/ripgrep` bundled binary (absolute path, platform-specific).
 *     This is the load-bearing fix: the MCP server is often spawned with a
 *     stripped PATH (e.g. a plugin host), so a system `rg` on the user's PATH
 *     is invisible. Bundling guarantees rg is present for every install.
 *  3. Bare `"rg"` (PATH lookup) if the bundled package is somehow unavailable.
 *
 * The bundled path is cached after the first successful resolve; the env
 * override is re-read each call so tests and operators can flip it at runtime.
 */
export function resolveRgBinary(): string {
  const override = process.env.CORTEX_RG_PATH;
  if (override) return override;
  if (cachedRgBinary === undefined) {
    try {
      const { rgPath } = localRequire("@vscode/ripgrep") as { rgPath: string };
      accessSync(rgPath, fsConstants.X_OK);
      cachedRgBinary = rgPath;
    } catch {
      cachedRgBinary = null;
    }
  }
  return cachedRgBinary ?? "rg";
}

// ---------------------------------------------------------------------------
// search_code subprocess error classification.
//
// rg/grep failures arrive as rejected exec errors with a grab-bag of shapes
// (numeric exit code, string Node error code, POSIX signal, partial stdout).
// Before this classifier, the primary rg path mapped *every* non-ENOENT,
// non-exit-1, no-stdout error to an opaque `internal_error` — so an invalid
// regex (exit 2) and a timed-out search (SIGTERM) both surfaced as crashes,
// hiding the actionable "your pattern is bad" signal and masking incomplete
// searches. The grep-fallback branch already degraded gracefully; this lifts
// that handling into one pure, tested function used by BOTH binaries.
//
// Outcomes:
//  - output            → use this stdout (full result, or partial from an
//                        interrupted/over-buffered run — better than nothing)
//  - empty             → no matches, OR an incomplete search (timeout / read
//                        error) that produced nothing. Not a crash.
//  - missing           → binary absent (ENOENT); caller falls back.
//  - invalid_pattern   → the regex engine rejected the pattern (exit 2 +
//                        a parse-error stderr). Actionable: fix the pattern.
//  - error             → genuinely unexpected; only the true-unknown bucket.
export type SearchExecError = {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
};

export type SearchExecOutcome =
  | { kind: "output"; stdout: string }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

// Strong, low-false-positive signals that a non-zero exit was a *pattern*
// rejection rather than a filesystem/read error. Anchored to phrases the regex
// engines actually emit, NOT bare words like "unmatched"/"unbalanced" that also
// appear in read-error paths (`rg: ./unmatched: Permission denied`):
//   - rg always prefixes pattern errors with "regex parse error:".
//   - GNU grep: "Invalid regular expression", "brackets ([ ]) not balanced",
//     "Unmatched ( or \(", "Trailing backslash", "Invalid content of \{\}".
//   - BSD grep (macOS /usr/bin/grep): "repetition-operator operand invalid",
//     "parentheses not balanced", "trailing backslash (\)".
// "unmatched" is matched only when an actual bracket char follows, so a file
// literally named "unmatched" in a read-error message can't trip it.
const REGEX_ERROR_RE =
  /regex parse error|error parsing regex|regular expression|not balanced|trailing backslash|unclosed|invalid repetition|repetition[- ]operator|unmatched\s*[[\](){}]/i;

export function classifySearchExec(err: SearchExecError): SearchExecOutcome {
  // Binary not on PATH — the caller decides whether to fall back.
  if (err.code === "ENOENT") return { kind: "missing" };

  const stdout = typeof err.stdout === "string" ? err.stdout : "";
  const stderr = typeof err.stderr === "string" ? err.stderr : "";
  const hasOutput = stdout.trim().length > 0;

  // Exit 1 = no matches (rg + grep convention). Normally stdout is empty, but
  // honor any buffered output if present.
  if (err.code === 1) return hasOutput ? { kind: "output", stdout } : { kind: "empty" };

  // Exit 2 = a search error. A regex parse error is actionable — surface it so
  // the agent can fix the pattern. Other exit-2 causes (unreadable file, etc.)
  // are incomplete searches: prefer partial output, else report empty.
  if (err.code === 2) {
    if (!hasOutput && REGEX_ERROR_RE.test(stderr)) {
      return { kind: "invalid_pattern", detail: stderr.trim() };
    }
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }

  // Killed by our timeout (SIGTERM) or over the stdout maxBuffer cap. Both mean
  // an incomplete search — keep whatever completed, else report empty rather
  // than masquerading as a crash.
  if (err.killed || err.signal === "SIGTERM" || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }

  // Any other error that still produced usable output: use it.
  if (hasOutput) return { kind: "output", stdout };

  // Genuinely unexpected and empty — the only true-error bucket.
  return { kind: "error", detail: err.message ?? String(err) };
}

export type SearchHit = {
  file: string;
  line: number;
  text: string;
  enclosing?: { kind: string; qualified_name: string; file_path: string };
  /** Set on the LAST emitted hit of a file whose remaining matches were dropped
   *  by `perFileCap`, so the caller can say how many it is not being shown. */
  moreInFile?: number;
};

export type SearchOutcome =
  /** `total` counts every matching line the search produced, not the ranked
   *  window — `truncated` is `hits.length < total`. Both exist so a partial
   *  result can never be rendered as a complete one, which is the defect this
   *  file shipped: 50 hits in arbitrary order, with nothing saying so. */
  | { kind: "hits"; hits: SearchHit[]; total: number; truncated: boolean }
  | { kind: "empty" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

const HIT_LINE_RE = /^\.\/(.+?):(\d+):(.*)$/;

/**
 * How many hit lines are parsed into objects before the ranker sees them.
 *
 * Ranking is only honest if it ranks EVERYTHING — a cap applied before the sort
 * is exactly the defect this rewrite removes. This ceiling is therefore far
 * above any budget a caller asks for (50 for MCP, 500 for the CLI): it bounds
 * memory on a pathological pattern without participating in ordinary searches.
 * `total` counts the real number of matches either way, so a search that does
 * reach it still reports its denominator honestly.
 */
const COLLECT_CAP = 5000;

/** Tiers, best first. A file lands in exactly one; every hit in it inherits it. */
export const TIER = { definition: 0, source: 1, test: 2, docs: 3, fixture: 4 } as const;

// Checked in this order — a `__snapshots__` directory usually sits INSIDE a test
// tree, and a fixture is worth less than the test that reads it.
const FIXTURE_RE = /(^|\/)(__snapshots__|__fixtures__|fixtures?|testdata|golden)(\/|$)|\.snap$/i;
const DOC_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const TEST_RE = /(^|\/)(tests?|e2e|specs?)\/|[.\-_](test|spec)\.[a-z0-9]+$/i;

/**
 * Which tier a file's hits belong to.
 *
 * Path-shaped rather than graph-shaped on purpose. The previous ranker scored a
 * hit by its enclosing symbol's KIND_WEIGHT, which reads as "is this code" — but
 * a vitest `it()` callback is a `function` node, so all 52 matches in one test
 * file tied with the line that DEFINES the symbol, and an alphabetical tiebreak
 * decided which survived. Tests and docs are not low-value because of the kind
 * of node that encloses them; they are low-value because of what they ARE.
 */
export function fileTier(file: string, defFiles: ReadonlySet<string>): number {
  if (defFiles.has(file)) return TIER.definition;
  if (FIXTURE_RE.test(file)) return TIER.fixture;
  if (DOC_RE.test(file)) return TIER.docs;
  if (TEST_RE.test(file)) return TIER.test;
  return TIER.source;
}

/**
 * Order hits by file tier, then path, then line — taking at most `perFileCap`
 * from any one file.
 *
 * Grouped by FILE rather than sorted hit-by-hit: a reader scans results by file,
 * and interleaving thirty files by a per-hit score is harder to read than the
 * arbitrary order it replaces. The per-file cap is the other half of the fix —
 * at any budget, one chatty file (52 of 150 matches, measured) otherwise crowds
 * out every other file that matched.
 *
 * Pure: never mutates the input array or the hits in it.
 */
export function rankHits(
  all: readonly SearchHit[],
  opts: { defFiles?: ReadonlySet<string>; maxHits: number; perFileCap?: number },
): SearchHit[] {
  const defFiles = opts.defFiles ?? new Set<string>();
  const byFile = new Map<string, SearchHit[]>();
  for (const h of all) {
    const arr = byFile.get(h.file);
    if (arr) arr.push(h);
    else byFile.set(h.file, [h]);
  }
  const files = [...byFile.keys()].sort(
    (a, b) => fileTier(a, defFiles) - fileTier(b, defFiles) || a.localeCompare(b),
  );

  const out: SearchHit[] = [];
  for (const file of files) {
    if (out.length >= opts.maxHits) break;
    const lines = [...byFile.get(file)!].sort((x, y) => x.line - y.line);
    const room = opts.maxHits - out.length;
    const take = lines.slice(0, Math.min(opts.perFileCap ?? lines.length, room));
    const hidden = lines.length - take.length;
    // Copied, not mutated: `moreInFile` is a property of THIS rendering of the
    // hit, and the caller's array must come back untouched.
    if (hidden > 0 && take.length > 0) {
      take[take.length - 1] = { ...take[take.length - 1]!, moreInFile: hidden };
    }
    out.push(...take);
  }
  return out;
}

/** A bare identifier can name a symbol; `foo\s*\(` cannot, and an equality
 *  match on it would find nothing anyway. Only then is the query worth a trip. */
const BARE_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Kinds that can DEFINE a name. Deliberately excludes `module` / `section` /
 *  `file` / `folder`: a Markdown heading reading `parseClaudeLine` is a mention,
 *  and promoting the doc that mentions a symbol to tier 0 would inupend the fix. */
const DEF_KINDS = ["function", "class", "method", "interface", "type", "variable", "route", "channel"];

/** Files the graph says DEFINE `pattern`. Empty when the pattern is not a bare
 *  identifier, or when the caller passed no store (every unit test, and any
 *  unindexed repo) — tiering then starts at `source`, which still works. */
function definitionFiles(pattern: string, store?: GraphStore, project?: string): Set<string> {
  if (!store || !project || !BARE_IDENT_RE.test(pattern)) return new Set();
  try {
    const rows = store.queryRaw<{ file_path: string }>(
      `SELECT DISTINCT file_path FROM nodes
        WHERE project = ? AND name = ?
          AND kind IN (${DEF_KINDS.map(() => "?").join(", ")})`,
      [project, pattern, ...DEF_KINDS],
    );
    return new Set(rows.map((r) => r.file_path).filter(Boolean));
  } catch {
    // A ranking refinement must never be able to fail a search.
    return new Set();
  }
}

/** Annotate each hit with its innermost enclosing symbol. Runs AFTER ranking, on
 *  the ranked window only, so its cost stays proportional to what is shown. */
function annotate(hits: SearchHit[], store?: GraphStore, project?: string): void {
  if (!store || !project) return;
  for (const hit of hits) {
    const enclosing = store.queryRaw<IndexerNode>(
      `SELECT * FROM nodes
       WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
         AND kind NOT IN ('decision', 'pr', 'todo')
       ORDER BY (end_line - start_line) ASC LIMIT 1`,
      [project, hit.file, hit.line, hit.line],
    );
    if (enclosing.length > 0) {
      hit.enclosing = {
        kind: enclosing[0]!.kind,
        qualified_name: enclosing[0]!.qualified_name,
        file_path: enclosing[0]!.file_path,
      };
    }
  }
}

export async function runCodeSearch(opts: {
  pattern: string;
  repoRoot: string;
  store?: GraphStore;
  project?: string;
  maxHits?: number;
  /** Most hits to take from any ONE file. Unset = no cap (the CLI, which
   *  paginates and must be able to reach every match). */
  perFileCap?: number;
}): Promise<SearchOutcome> {
  const maxHits = opts.maxHits ?? 50;
  const execOpts = { timeout: 10_000, maxBuffer: RG_MAX_BUFFER, cwd: opts.repoRoot };

  let stdout = "";
  try {
    const r = await execFileAsync(resolveRgBinary(), buildRgArgs(opts.pattern), execOpts);
    stdout = r.stdout;
  } catch (rgErr) {
    const outcome = classifySearchExec(rgErr as SearchExecError);
    if (outcome.kind === "output") stdout = outcome.stdout;
    else if (outcome.kind === "empty") return { kind: "empty" };
    else if (outcome.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: outcome.detail };
    else if (outcome.kind === "missing") {
      try {
        const r2 = await execFileAsync("grep", buildGrepFallbackArgs(opts.pattern), execOpts);
        stdout = r2.stdout;
      } catch (fallbackErr) {
        const o2 = classifySearchExec(fallbackErr as SearchExecError);
        if (o2.kind === "output") stdout = o2.stdout;
        else if (o2.kind === "empty") return { kind: "empty" };
        else if (o2.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: o2.detail };
        else if (o2.kind === "missing") return { kind: "error", detail: "Neither rg nor grep available on PATH." };
        else return { kind: "error", detail: o2.detail };
      }
    } else return { kind: "error", detail: outcome.detail };
  }

  if (!stdout.trim()) return { kind: "empty" };

  // Parse EVERY match line before ranking. `total` counts them all, even past
  // COLLECT_CAP, so the footer's denominator is the true number of matches.
  const all: SearchHit[] = [];
  let total = 0;
  for (const line of stdout.split("\n")) {
    const m = line.match(HIT_LINE_RE);
    if (!m) continue;
    total++;
    if (all.length < COLLECT_CAP) {
      all.push({ file: m[1]!, line: parseInt(m[2]!, 10), text: m[3]!.replace(/\r$/, "") });
    }
  }
  if (all.length === 0) return { kind: "empty" };

  const hits = rankHits(all, {
    defFiles: definitionFiles(opts.pattern, opts.store, opts.project),
    maxHits,
    perFileCap: opts.perFileCap,
  });
  annotate(hits, opts.store, opts.project);
  return { kind: "hits", hits, total, truncated: hits.length < total };
}
