import { join, resolve } from "node:path";

/**
 * The eval's scratch space: everything under one directory named `.cache`.
 *
 * The harness clones whole repositories, including private ones whose source
 * must never reach a public repository's graph. It also writes reports
 * holding every target's measured numbers. All of it sits inside the checkout
 * that runs the eval, and that checkout gets indexed: by hand, after every
 * commit, and at session start.
 *
 * cortex-indexer skips directories by name, at any depth, in main checkouts
 * and linked worktrees alike. `.cache` is one of the names, along with `.tmp`,
 * `tmp`, `dist`, `vendor`, `coverage` and `node_modules`. A leading dot alone
 * hides nothing: `evals/.reports/` is indexed. The name holds where the
 * gitignore does not. A linked worktree's index does not read the root
 * `.gitignore` (cortex-indexer todo T-0fy2: it loads that file only when
 * `.git` is a directory), so the old `evals/cache/` and `evals/reports/` were
 * indexed there, clones and all. That is the worktree the release gate runs
 * in, and its graph, search results and quality verdict then described the
 * clones (T-a9kr). tests/evals/paths.test.ts pins this against the real
 * indexer.
 *
 * Every scratch path the harness writes comes from here. Beside the target
 * directories (`<name>/`) sit the indexer's scratch `cache/` and `home/`
 * (evalIndexerEnv) and the run reports in `reports/`.
 */

/** Cloned targets and their graphs, one directory per target name. */
export const EVAL_CACHE_ROOT = resolve(process.cwd(), "evals/.cache");

/** Each run's summary and per-target reports. */
export const EVAL_REPORTS_ROOT = join(EVAL_CACHE_ROOT, "reports");
