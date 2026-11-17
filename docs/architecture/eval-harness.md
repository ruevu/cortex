# Eval Harness Architecture

> Audience: anyone touching `evals/` or the killer-query list. The
> [field assessment](../field-reports/field-assessment-nuxt-monorepo.md) is the
> driving motivation.

## What this harness is for

There are **two** eval surfaces in this repo. Don't confuse them:

| Harness | Location | What it scores | npm script |
|---|---|---|---|
| **Tool-surface eval** (this doc) | `evals/` | Cortex's MCP tool answers against real-world target repos | `npm run eval` |
| **Frame-extraction eval** | `scripts/frame-extraction/eval*.ts` | Cluster quality of one clustering algorithm on one repo | `npm run eval:phase2` |

This document covers the **tool-surface** harness. Its purpose is to
catch regressions and progress on the kind of questions Cortex falls
short on for Vue/Nuxt monorepos (per the field assessment). The
frame-extraction eval scores cluster outputs and is documented
inline in [`frame-extraction.md`](frame-extraction.md).

## Inputs

```
evals/targets.json   — list of target repos (cloneable or local_path)
evals/src/queries.ts — fixed list of "killer queries" (Cypher illustrative + SQL concrete)
```

Default targets are Nuxt UI, NuxtHub starter, `elk`, and `open-pencil` — the
first three Nuxt, the fourth a large Vue 3 + Tauri desktop app that stands in
for a real-world application and therefore runs the universal pack only. A
further seventeen multi-language repositories form the **corpus suite**, which
is opt-in — see [Assertion packs and suites](#assertion-packs-and-suites)
below. The killer
queries cover:

- `functions_high_degree` — does the indexer extract enough function
  bodies that fan-in/-out queries return non-empty?
- `http_calls_with_api_path` — does the indexer extract
  `$fetch`/`useFetch` as `HTTP_CALLS` edges?
- `route_nodes_named` — are `route` nodes legitimate URLs (not
  pnpm-lock tarball strings)?
- `composables_called` — Vue convention: identifiers starting with
  `use`. Catches whether SFC + composable extraction lands.
- `vue_function_count` — function nodes in `.vue` files at all.
- `nitro_handlers` — function bodies inside `server/api/**/*.ts`.
- `decisions_present` — was anything promoted to `Decision` for this
  target?

Each query has a `baseline_expected: "pass" | "fail"` so the harness
can flag surprises in either direction (a query that was failing and
now passes is just as important as a regression).

## Outputs

The harness produces a `Scorecard` per target — see
`evals/src/assertions/types.ts`:

```ts
{
  target: "nuxt-ui",
  indexer_seconds: 12.4,            // null when reusing existing index
  nodes_by_label: { function: 1667, … },
  edges_by_type:  { CALLS: 3402, IMPORTS: 214, … },
  killer_queries: [{ name, cypher, row_count, sample_rows }, …]
}
```

`Baseline`s (committed under `evals/baselines/`) capture a previous
scorecard so the next run can diff against it. The harness reports
*surprises*: assertions whose baseline_expected disagrees with the
observed result.

## Assertion runner

`evals/src/assertions/runner.ts` runs a single `Assertion` against an
already-indexed DB. The supported query shapes are:

| Query kind | Backed by |
|---|---|
| `count_label` | `SELECT COUNT(*) FROM nodes WHERE kind = ?` |
| `count_edge` | `SELECT COUNT(*) FROM edges WHERE relation = ?` |
| `sql` | Raw SQL — returns count or stringified first column depending on predicate |
| `tool_call` | Routes through `assertions/tool-runner.ts`, which calls the real MCP tool. Needs an `evals/fixtures/<target>.json`; targets without one skip these. |

Predicates are `gt`/`gte`/`eq`/`matches`/`no_match`/`tool_text_nonempty`/`tool_text_contains`.

## Status

The harness runs end to end: `evals/src/cli.ts` acquires each target (clone or
`local_path`), indexes it, computes the scorecard, runs the assertions its packs
select, ratchets the universal ones against the committed baseline, and writes a
report to `evals/reports/<timestamp>/`. That flow is informed by the
[field assessment](../field-reports/field-assessment-nuxt-monorepo.md).

    npm run eval                                   # default suite
    npm run eval -- --target=elk                   # one target
    npm run eval -- --suite=corpus                 # the 17-repo corpus
    npm run eval -- --capture-baseline=<target>    # record a new reference
    npm run eval -- --accept-improvements          # adopt confirmed gains
    npm run eval -- --determinism                  # index twice, compare shape

Baselines are committed for all four default targets — `nuxt-ui`,
`nuxthub-starter`, `elk` and `open-pencil` — plus `trpc` and `vueuse`, all
captured on indexer 0.3.5, as is `cortex`. Recapture them with every indexer
pin bump, so a baseline never grades one indexer against another's numbers.
The remaining seventeen corpus targets have none yet: they report
`(no baseline)` until someone captures one, which is the honest state rather
than a failure. A corpus run takes hours (clone + full index each),
so the corpus is opt-in and its baselines are captured deliberately rather than
on every run.

## Why the killer queries look the way they do

Each one mirrors a concrete failure observed during the field
assessment of a Nuxt monorepo (`anthill-cloud`, 5,010 nodes /
5,746 edges, 2026-05-20). Two examples:

- **`functions_high_degree` returns zero rows** on a 410-module Nuxt
  monorepo because the indexer doesn't extract functions from Vue
  SFC `<script setup>`, Nitro handler bodies, Pinia store setup
  blocks, or `app/composables/*.ts` arrow functions. That's ~90%
  of the meaningful symbols in the repo.
- **`route_nodes_named`** returns pnpm-lock tarball URLs (e.g.
  `tarball: https://…codeartifact…/@esbuild/win32-x64/…`)
  classified as routes. The indexer regex treats YAML `tarball:`
  fields as URL-like.

These are the questions a real user asks when they expect a code
graph to be useful. The harness exists so we know whether they're
answered well.

## Assertion packs and suites

The harness scores two different kinds of thing, and they must not be confused:

| kind | `scope` | verdict comes from | applies to |
|---|---|---|---|
| ecosystem-specific | `nuxt` | a fixed `predicate` | Nuxt targets only |
| language-agnostic | `universal` | a **ratchet** against that repo's own baseline | any repository |

A `nuxt` assertion can be judged absolutely: `nitro_handlers` should be greater
than zero, full stop. A universal metric cannot. 40% call attribution may be
terrible for one language and entirely expected for another, so "is this number
good?" has no answer — only "did it move the wrong way against this repo's own
baseline?" does.

**That is why universal metrics carry no `predicate` at all.** Do not add one to
satisfy a type: an assertion that always passes reads as a check and is not one.
`AssertionResult.passed` is `boolean | null`, where `null` means *not judged* —
either the metric has no baseline yet, or it had nothing to measure.

Each target declares `packs` (which assertion scopes run against it) and
`suites` (which named runs it belongs to). Both have defaults, and the defaults
matter: `packs` defaults to `["universal"]`, so a new target gets the portable
checks and none of the ecosystem-specific ones; `suites` defaults to `["nuxt"]`.
Selection lives in `selectAssertions` (registry) and `selectTargets` (cli).

    npm run eval                     # default suite (`nuxt`), unchanged
    npm run eval -- --suite=corpus   # the multi-language corpus: 18 targets (nuxt-ui is in both suites)
    npm run eval -- --suite=all
    npm run eval:gate                # the self suite under --strict; see Gating below

## The universal metrics

Ten: nine in `evals/src/assertions/universal.ts`, plus the `--determinism` check.

| metric | direction | what a bad number means |
|---|---|---|
| `file_sourced_calls` | lower | calls the indexer could not attribute to their enclosing callable, so they hang off the file node |
| `call_attribution_rate` | higher | the same defect as a proportion |
| `qn_collisions` | lower | two source files folding to one identity |
| `orphan_definition_rate` | lower | definitions extracted with no edges at all |
| `per_language_function_density` | higher | callables per file, **per language** — catches one language falling out of extraction while the repo-wide averages stay respectable |
| `guess_share` | lower | the percentage of call edges that are name guesses, suspect-hub edges included ([graph-quality.md](graph-quality.md)) |
| `suspect_hub_share` | lower | the percentage of call edges that are member calls into a suspect hub: a repo function that built-in methods bind to by name |
| `unscored_share` | lower | the percentage of call edges with no confidence score. It guards `guess_share`: losing scores would lower the guess share and read as a gain |
| `quality_level` | lower | the graph-quality verdict as 0 `ok` / 1 `degraded` / 2 `poor`, compared exactly |
| determinism (`--determinism`) | — | indexing the same tree twice yields a different graph |

The four quality metrics are `null` (not measured) whenever the verdict is not
judged, meaning fewer than 200 call edges or more than half of them unscored.
A share over an unjudgeable graph is noise, and a noisy low share would
otherwise ratchet in as an improvement.

### "Nothing to measure" is not zero

A rate over zero rows yields SQL `NULL`. The runner surfaces that as
`observed: null` and the ratchet as `not_measured`; it is never coerced to a
number. This is load-bearing rather than fussy: `orphan_definition_rate` is
lower-is-better, so a bogus low value reads as an *excellent* score. A total
extraction failure could then be scored an improvement and adopted into the
baseline as a deliberate gain.

## The ratchet

`ratchet()` (`assertions/ratchet.ts`) is pure: it compares an observed value to
a baseline given a direction and an epsilon. `applyRatchet` (`verdicts.ts`) is
the **single place** a universal metric's verdict is decided; the report and the
baseline merger both read the outcome it stores and never recompute it. Two
sites deciding independently whether a metric regressed is how a report and its
exit code come to disagree.

Epsilon is per-metric-kind:

- **percentage metrics** — 0.5 percentage points (`call_attribution_rate`,
  `orphan_definition_rate` and the three quality shares, the members of
  `RATE_METRICS` in `verdicts.ts`).
- **counts**, and the `quality_level` ordinal — exact.
- **per-language density** — **proportional: 10% of that language's own
  baseline.** Density is callables-per-file, typically near 1, so a fixed 0.5
  would let a language lose most of its extraction — or vanish from the repo
  entirely — and still pass.

Map-valued metrics are judged per key; any regressed language fails the metric,
and a language present at baseline but absent now is treated as a collapse to
zero, not as a missing comparison.

> **Discriminate on the assertion, never on the value's shape.** Density map
> keys are file extensions harvested from arbitrary repositories, so a repo
> containing `x.status` or `x.text` can forge any shape test you write. All
> three modules key on `assertion.query.kind === "language_density"`. A shape
> sniff here once crashed the whole run's report rendering.

## Baselines

`evals/baselines/<target>.json` records each metric's value plus the
`source_sha` it was measured at. Targets track a moving branch, so without that
sha a baseline drifts against upstream silently.

**A normal run never rewrites a baseline.** An improvement beyond epsilon is
reported as `IMPROVED — baseline stale` and adopted only by an explicit
`npm run eval -- --accept-improvements`, which writes only the metrics the
ratchet confirmed as improved and never absorbs a regression. Adoption is
deliberate so that the resulting git diff is the review record — a metric can
rise for bad reasons, since counting garbage raises a count as surely as fixing
extraction does.

## Gating

`--strict` turns a run into a pass/fail gate. It exits 1, with one line per
problem naming the target and metric, when a selected target:

- **failed**: its clone, index or run threw;
- has **no baseline**, so capture one first
  (`npm run eval -- --capture-baseline=<target>`), and the other checks are
  skipped;
- has a metric that **REGRESSED** beyond its tolerance;
- has a metric **NOT MEASURED** this run that the baseline has a value for, for
  example a graph that became too small or too unscored to judge;
- has a metric **UNCOMPARABLE** with its baseline value;
- has a baseline metric **MISSING** from the run, i.e. renamed or dropped;
- **judged nothing** at all.

A metric that is new since the baseline is not a failure. `strictGate`
(`evals/src/gate.ts`) reads the outcomes `applyRatchet` stored and never
re-decides a verdict, the same single-decider rule as the report.
`--determinism` runs outside the gate: `--strict` does not check it.

### The self suite

`npm run eval:gate` is `--suite=self --strict`. It is the no-regression gate
for graph quality (decision `D-kn9w`, [graph-quality.md](graph-quality.md)):
run it before any release that bumps the indexer pin, changes a quality
definition, or could otherwise move call edges. Its targets:

- **`cortex`**, a public target in `evals/targets.json` pinned at a SHA, so its
  baseline describes a fixed tree and only the indexer or the definitions can
  move it;
- **private targets** from `targets.private.json` in the repository's private
  evals directory, `~/.cortex/<repoId>/evals/` (or
  `$CORTEX_HOME/.cortex/<repoId>/`), beside the decisions store. `<repoId>` is
  the id in the committed `cortex.json`. The file has the same shape as a public
  entry (a `file://` `repo_url` works for a local repo), and the baselines for
  its targets live beside it in `baselines/`.

  It is in no working tree, on purpose. A gitignored file in a checkout exists
  only there: a new worktree starts without it, and `git worktree remove`
  deletes it without a word. The gate would then quietly shrink to the public
  targets, and the baselines captured before the first change would be gone.

  A run without the file says so on stderr, and again on the verdict line, for
  example `strict gate: PASS — gated: cortex (no private targets file at …)`.
  A target name may appear in only one of the two files.

### The graph cache knows which indexer built it

A target's cached graph (`evals/.cache/<target>/graph.db`) is reused only when
it is at least as new as the workdir's `.git/HEAD` **and** was built by the
current indexer. `evals/.cache/<target>/indexer-identity` records the binary
`resolveIndexerBinary()` returns (which honours `CORTEX_INDEXER_PATH`) as its
realpath, size and mtime. The stamp is removed before a rebuild and written
only after the indexer exits 0, so a failed build never passes for a good one.

Every rebuild deletes `graph.db` and its `-wal`/`-shm` first. cortex-indexer is
incremental: it keeps per-file hashes inside the graph and does nothing over an
unchanged tree. Without the delete, a new indexer would be graded on the old
indexer's graph.

## Gotchas

- **`evals/.cache/` holds whole repositories.** They carry their own test
  suites; `vitest.config.ts` excludes the directory, or `npm test` picks up
  hundreds of foreign tests that fail for want of their own dependencies.
- **…which is why every scratch path is under a directory named `.cache`.**
  That covers the clones, their graphs, and the run reports in
  `evals/.cache/reports/` (`evals/src/paths.ts`).
  - cortex-indexer skips directories by name, at any depth: `.cache`, `.tmp`,
    `tmp`, `dist`, `vendor`, `coverage` and `node_modules`.
  - A leading dot alone hides nothing: `evals/.reports/` would be indexed.
  - A linked worktree's index does not read the root `.gitignore`. The
    indexer loads that file only when `.git` is a directory (cortex-indexer
    todo `T-0fy2`).
    So before 2.4.11, a worktree that ran the eval indexed every clone in
    `evals/cache/` into its own graph, and its answers and quality verdict
    described them (`T-a9kr`).
  - `tests/evals/paths.test.ts` pins this against the real indexer.

  Delete any `evals/cache/` and `evals/reports/` left from before.
- **`evals/` is not typechecked by `npm test`.** The root `tsconfig.json`
  includes only `src`, and vitest transpiles without typechecking. The gate is
  `npx tsc --noEmit -p evals/tsconfig.json 2>&1 | grep -v '^src/viewer/'`, which
  must print nothing (the filtered errors are pre-existing vite-built viewer
  sources that the eval config drags in by overriding the root `exclude`).
- **A forced reindex must really be forced.** `maybeReindex` skips indexing when
  the cached graph is at least as new as the workdir's `.git/HEAD` and was built
  by the current indexer. The determinism check deletes the graph DB precisely
  to defeat that; without it the second pass re-scores the first pass's graph
  and the check can never fail.
