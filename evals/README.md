# Evals

### Adopting improvements

An eval run never rewrites a baseline. When a universal metric improves, the
summary marks it `IMPROVED — baseline stale`; adopt it deliberately with:

    npm run eval -- --target=<name> --accept-improvements

Only metrics the ratchet confirmed as improved are written; regressions and
steady metrics are left untouched. Commit the resulting baseline diff.

### Gating a release

    npm run eval:gate

This runs the `self` suite under `--strict`. It exits 1 on any regression, on a
baseline metric the run could not measure, compare or find, and on a target
that failed or judged nothing. Run it before a release that bumps the indexer
pin, changes a graph-quality definition, or could otherwise move call edges.

The suite is `cortex`, pinned at a SHA in `targets.json`, plus any private
targets in `~/.cortex/<repoId>/evals/targets.private.json`, where `<repoId>` is
the id in the committed `cortex.json`. That file has the same shape, and
`file://` URLs work. Their baselines go to `baselines/` beside it. Every
worktree of the repository therefore gates the same targets, and none of them
can commit the files. Capture a baseline with
`npm run eval -- --capture-baseline=<name>`. The verdict line lists the gated
targets, and says when the private file was not found.

Clones, their graphs and the run reports go to `.cache/`, a directory name
cortex-indexer never reads, so running the eval leaves the checkout's own graph
alone. Delete any `cache/` and `reports/` left from before 2.4.11, because a
linked worktree's index reads them (todo T-a9kr).

Details: [eval-harness.md § Gating](../docs/architecture/eval-harness.md#gating).
