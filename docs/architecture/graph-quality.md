# Graph quality

How much of the call graph is a guess. After every index, Cortex labels each
`CALLS` edge from what the graph already stores, judges the whole graph `ok`,
`degraded` or `poor`, and writes that down in `<checkout>/.cortex/quality.json`.
Every surface reads that one report. None of them recomputes it.

The reason it exists: cortex-indexer resolves each call through a chain of
strategies, and when nothing better applies it binds the call by name. On some
codebases most call edges are such guesses, yet `trace_path` and `context_pack`
present a guessed caller exactly like a resolved one. A weak graph then reads as
a broken tool. The verdict says, once and quietly, when the callers and callees
of this graph should be treated as hints.

Code: [`src/quality/`](../../src/quality/). Decisions: `D-w4eg` (vocabulary),
`D-kn9w` (verdict, thresholds, the eval gate), `D-b1gd` (no per-edge
confidence is ever published), `D-3t5z` (the report precedes the index
baseline).

## The four labels

Each `CALLS` edge gets exactly one label. The order of the rules *is* the
definition:

| # | rule | label |
|---|---|---|
| 1 | a member call (the callee contains `.`) into a [suspect hub](#suspect-hubs) | `name guess` |
| 2 | no numeric `confidence` on the edge (absent, non-numeric, or malformed edge JSON) | `unscored` |
| 3 | `confidence` ≥ 0.70 (the indexer's high band) | `resolved` |
| 4 | `confidence` ≥ 0.45 (the medium band) | `likely` |
| 5 | any other number | `name guess` |

The JSON key for `name guess` is `name_guess`. The vocabulary is closed: no
confidence number and no resolver strategy name appears on any surface, so
renaming or adding a resolver never changes what a consumer sees.

Every read of `edges.data` goes through `CASE WHEN json_valid(..) THEN
json_extract(..) END`. SQLite does not promise the evaluation order of `WHERE
json_valid(..) AND json_extract(..)`, so a single malformed row would otherwise
fail the whole computation. A malformed edge is simply `unscored`.

## Suspect hubs

A suspect hub is a **free function** (`kind = 'function'`; a method is never a
hub) reached by **member-call syntax** through **10 or more distinct
receivers**. The receiver is the callee minus `.` and the target's name, so
`items.map` has the receiver `items`.

Every hub inspected so far was a built-in method bound by name to a same-named
function in the repo: a project's own `map` helper collects every `xs.map(…)`
in the codebase. The indexer can score such an edge high, which is why the
score alone misses them. A namespace import (`utils.format`) has one receiver,
so it never qualifies, whereas values have many.

Only member calls into a hub are demoted. A bare `map(xs)` into the same
function keeps its band. Hub edges count as name guesses, and they are also
counted separately as `hub_edges`.

## Shares and the verdict

- `guess_share` = name guesses (hub edges included) / all `CALLS` edges.
- `hub_share` = hub edges / all `CALLS` edges.

A graph is **judged** only with at least 200 `CALLS` edges and at most half of
them unscored. Below that a share is noise, or the confidence signal is absent.
An unjudged graph reads `ok`, with `judged: false` and a `note` saying why.

| level | when |
|---|---|
| `poor` | `guess_share` ≥ 50% |
| `degraded` | `guess_share` ≥ 40%, or `hub_share` ≥ 10% |
| `ok` | otherwise |

Shares are printed floored to one decimal, computed from the integer counts
(`pct()`), so a share just under a threshold never prints as the threshold.

When the level is not `ok`, the advice is fixed: **treat callers/callees as
hints; confirm with `search_code`**. It is never "reindex". The same tree
indexed by the same indexer yields the same graph, so this signal is about the
codebase and the resolver, not about staleness.

### Calibration

The thresholds were calibrated across seven repositories (`D-kn9w`) to flag
outliers and leave typical TypeScript repositories, which run at about 30%
guesses, alone. Two public ones, measured on 2026-11-13 with cortex-indexer
0.3.2 and the shipped definitions:

| repository | call edges | name guesses | through suspect hubs | verdict |
|---|---|---|---|---|
| cortex (v2.4.10, the self suite's pin) | 4,272 | 33.2% | 9.9% (5 hubs, led by `push`: 209 calls from 112 receivers) | `ok` |
| open-pencil | 54,015 | 38.4% | 15.3% (57 hubs, led by `map`: 2,037 calls from 1,392 receivers) | `degraded` |

open-pencil shows why the hub rule exists. Its guess share alone would pass,
but more than one call edge in seven runs through a function that a built-in
method happens to share a name with.

## Where it shows

The verdict is **silent unless abnormal**. When the level is `ok`, judged or
not, nothing prints anywhere. A line printed on every index would read as
decoration and stop carrying information.

| surface | what |
|---|---|
| `cortex index` / `index_repository` | 3–4 lines: `⚠ graph quality: <level>`, at most two reasons, and the advice with a pointer to `cortex quality`. The CLI prints them after its staleness line; the MCP tool appends them to its response |
| `.cortex/quality.json` | the report itself (`QualityReport`, version 1), written after every index |
| `cortex quality` | the summary: label counts, shares against their thresholds, the listed hubs, reasons, `computed_at` and the indexed commit |
| `cortex quality --json` | the report, or `null` |
| `cortex quality --headline` | one line, or nothing; the SessionStart hook prints it verbatim |
| SessionStart (`hooks/check-index.sh`) | `⚠ cortex quality: <level> — <reasons> (<advice>)` |
| `GET /api/quality?project=<name>` | `{ version, report }`; see [`docs/api/README.md`](../api/README.md) |

The report is **checkout-scoped**, like the graph store and the staleness
report beside it. A linked worktree has its own graph, so it gets its own
report and never reads the main checkout's.

Under a launcher that sets `CORTEX_PROG_NAME` (Mesh runs this CLI as
`mesh ctx`), the lines that name a command to type are branded
(`details: mesh ctx quality`). The SessionStart headline names the signal,
like `⚠ cortex freshness`, and is not branded.

**Gate:** `CORTEX_QUALITY=0` turns off the whole surface. No index writes a
report or prints lines, `cortex quality` is silent in every mode, the
SessionStart line is gone, and `/api/quality` serves `report: null`. It does
not affect the eval metrics, which compute the same numbers on their own.

## The ordering contract

At every index site (`cortex index`, and `index_repository` on both its
cache-hit and its normal path) the order is:

1. the staleness sweep;
2. the quality report (`runQualityReport`);
3. `captureIndexMeta`, which moves the index baseline.

`GET /api/quality` serves the report under the **index-baseline ETag**, the
same cache identity as every data endpoint. If the report were written after
the baseline moved, a request landing between the two would cache the
*previous* report under the *new* ETag. Every later poll would then get
`304 Not Modified` for it until the next reindex, with no error anywhere, just
a consumer showing the old graph's verdict. Written first, the worst a request
can see is the new report under the old ETag, which the baseline change then
invalidates. `tests/quality/index-wiring.test.ts` enforces the order at all
three sites (`D-3t5z`).

A consumer driven by events gets the same guarantee. Over MCP,
`index_repository` emits its `index: completed` signal as its last step,
after the baseline has moved and the registry entry exists. A consumer that
refetches on that signal (Mesh does) therefore reads the new report under the
new ETag. Emitted at the publish instead, which is where it used to be, the
signal arrived ahead of all three. A refetch then read the previous report,
the previous freshness verdict, and after a first index no project at all.
`tests/mcp-server/index-signal-emit.test.ts` pins it. `cortex index` emits no
signal, and the background auto-index signals when its child process exits,
after everything.

Two smaller rules follow from where it runs:

- `indexed_commit` comes from git, not from `cortex_index_meta`, which at that
  point still holds the previous baseline.
- The two queries run inside one read transaction, so they see one snapshot
  even if another index publishes meanwhile.

## Never throws, never stale

A quality report is metadata about an index, not the index, so it never fails
an index. It is also never left describing an older graph:

- Any failure, whether opening the graph, computing or writing, **removes** the
  previous report. No report reads as "not computed", whereas an old one would
  read as a verdict on a graph that no longer exists.
- The write goes to a temp sibling named with the process id, then a rename. A
  reader never sees half a file, and two indexes finishing at once never
  interleave their bytes.
- Readers ignore any report whose `version` is not `1`. A report from another
  release is invisible rather than misread, because a shape mismatch would
  surface as a wrong number, not an error. `/api/quality` also validates the
  report against its wire schema, so a damaged file reads as `report: null`.

## The eval gate

The four quality numbers are universal metrics in the eval harness
([eval-harness.md](eval-harness.md)), computed by the same `compute.ts`:

| metric | unit | direction | tolerance |
|---|---|---|---|
| `guess_share` | percent | lower is better | 0.5 points |
| `suspect_hub_share` | percent | lower is better | 0.5 points |
| `unscored_share` | percent | lower is better | 0.5 points |
| `quality_level` | 0 `ok` / 1 `degraded` / 2 `poor` | lower is better | exact |

All four are `null` (not measured) when the verdict is not judged, so a graph
too small or too unscored to judge can never ratchet a share as an improvement.
`unscored_share` exists because losing confidence scores would otherwise
*lower* the guess share and read as a gain.

`npm run eval:gate` runs the **self suite** under `--strict`. That is cortex at
a pinned SHA, plus any private targets in the gitignored
`evals/targets.private.json`, whose baselines live in the gitignored
`evals/baselines/private/`. It exits non-zero on any regression, on a metric
the baseline has but the run could not measure or compare, and on a target
that failed or judged nothing. It is the release gate for every change to
these definitions and for every indexer bump. The gate rules and the
indexer-aware graph cache are described in
[eval-harness.md § Gating](eval-harness.md#gating).

At its pin, cortex reads `ok` by **4 edges**: 424 of its 4,272 call edges run
through suspect hubs, and 428 would make it `degraded`. Five hubs carry those
edges:
- `push` and `pop` in the viewer's drawer stack;
- `run` in a test helper;
- `find` and `endsWith` in `src/shared/resolve-input.ts`, both new in v2.4.10.
  Between them they hold 106 edges (2.4 points), because built-in `Array.find`
  and `String.endsWith` calls bind to them by name.

Each is the shape the hub rule exists to catch, so the next helper named after
a built-in method will trip the gate.

## Not here yet

- **Per-answer labels and footers.** Grouping `trace_path`/`context_pack` rows
  under `resolved` / `likely` / `name guess`, plus a once-per-session `⚠`
  footer when the verdict is `poor`, ship together with contract fixtures so
  that Mesh's graph cards keep rendering Cortex output (`D-w4eg`, todo
  `T-aayg`).
- **Exclusions.** The report has no coverage section yet. Vendored and bundled
  code is excluded by default, and the choices recorded in `cortex.json`, in a
  later phase (`D-ykv9`).
- **Eval clones are indexed.** `evals/cache/` is gitignored, but cortex-indexer
  does not honour that rule. A checkout that has run the eval therefore indexes
  the cloned targets into its own graph, and its verdict and answers describe
  them too. Remove `evals/cache/` and `evals/reports/` and reindex
  (todo `T-a9kr`).
