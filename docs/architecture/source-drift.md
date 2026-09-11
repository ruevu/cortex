# Source drift — checkout vs base ref

Cortex measures staleness on three independent axes. Naming them is
load-bearing: each is silent about the others, so a green signal on one says
nothing at all about the rest.

| axis | what moved | signal |
|---|---|---|
| **freshness** | index ↔ checkout | `⚠ cortex freshness` |
| **knowledge drift** | decisions/todos ↔ their governed source | `↻ cortex staleness`, `⚠ basis moved` |
| **source drift** | checkout ↔ base ref | `⚠ cortex source drift` |

("Knowledge drift" is the prose name for the second axis. The `reconcile`
verdict enum value `drift` is a live wire contract and is *not* renamed.)

## Why it exists

A `search_code` ran against a worktree 170 commits behind `origin/main` while
the question being asked was about current `main`. It returned hits, annotated
them with their enclosing symbols, and emitted no warning — **correctly**, by
Cortex's own terms, because the index was perfectly fresh for that checkout's
HEAD. The checkout was the stale thing. The result was reported to the user as
current state. Every indicator was green.

Mesh manufactures one worktree per thread, most of them on branches already
merged or abandoned, so a tree that is behind is the common case rather than the
exception — and the probability rises with every day a thread lives.

## How it is computed

Base ref, first hit wins:

1. `rev-parse --abbrev-ref @{upstream}` — a configured upstream is the most
   specific statement of intent.
2. `symbolic-ref -q --short refs/remotes/origin/HEAD`.
3. A **verified** probe: `rev-parse --verify -q origin/main`, then
   `origin/master`, used only if the ref actually resolves.

Then `rev-list --count HEAD..<base>`, the age of `merge-base(HEAD, <base>)`, and
the age of the `<base>` tip (a last-fetch proxy). All local plumbing, **no fetch
on a read path**.

Step 3 is the only step approaching inference, and it is deliberately a probe
rather than a guess: `origin/HEAD` is set only by `git clone` or an explicit
`git remote set-head`, so a repo created locally and later given a remote
legitimately lacks it. We ask git whether the ref exists; we never assume a
default branch name we have not confirmed.

Note that `@{upstream}` can fail even when `branch.<b>.merge` is configured, if
no fetch refspec maps it to a remote-tracking ref (`"not stored as a
remote-tracking branch"`). That is a real, observed state — the ladder falls
through to `origin/HEAD` rather than stranding the signal.

## Thresholds

Fires when `commits_behind >= CORTEX_SOURCE_DRIFT_COMMITS` (default 25) **or**
`fork_age_days >= CORTEX_SOURCE_DRIFT_DAYS` (default 7).

Two thresholds, OR'd, because either alone calibrates to one repo's commit rate:
a fast repo drifts 50 commits in two days, a slow one drifts 5 over three weeks,
and a single threshold misses one of those. The fetch-age caveat reuses the same
day threshold rather than adding a third constant.

Day counts **floor** rather than round, so they can read one lower than
`git log --format=%cr` for the same commit. That direction is deliberate:
flooring makes the signal fire slightly less readily.

## The silence invariant

The signal says *"you are demonstrably behind"* or it says **nothing**. Every
state git cannot determine is `unknown`, and `unknown` is silent — never
rendered as a clean bill of health. NULL is unknowable, not unchanged.

Reporting `current` off a failed git call would re-create, one level down, the
exact green-but-wrong failure this signal exists to kill. **An absent line is
therefore not a clean bill of health.**

The *line* is thresholded; the *data* is not. The structured `source_drift`
field is attached for every state, so a programmatic consumer can apply its own
policy without re-shelling git.

## Surfaces

| surface | behaviour |
|---|---|
| MCP read tools | the eight `freshnessAware` tools get a `source_drift` field plus a ⚠ line when behind |
| `cortex source-drift` | prints the line when behind, nothing otherwise; exit 0 always |
| SessionStart hook | shells the above, in **both** the indexed and not-indexed branches |
| `/api/freshness` | optional `source_drift` object, additive (no `CONTRACT_VERSION` bump) |

It needs no graph DB, which is why the hook can emit it on an **unindexed**
checkout where freshness and knowledge drift cannot speak at all — and a fresh
worktree is the likeliest dead tree of all.

Anchored on the **checkout axis** (`ctx.repoPath` / `worktreeRoot()`) per
[D-d5k3](graph-storage.md#two-axes): a linked worktree is judged on its own HEAD,
never the main checkout's.

Gate: `CORTEX_SOURCE_DRIFT=0`.

## Files

| file | role |
|---|---|
| [`src/git/worktree-state.ts`](../../src/git/worktree-state.ts) | `resolveBaseRef`, `gitCommitsBehindRef`, `gitMergeBase`, `gitCommitTime` |
| [`src/mcp-server/source-drift.ts`](../../src/mcp-server/source-drift.ts) | classifier + memoized resolver + `attachSourceDrift` |
| [`src/cli/commands/source-drift.ts`](../../src/cli/commands/source-drift.ts) | `cortex source-drift` |
| [`hooks/check-index.sh`](../../hooks/check-index.sh) | SessionStart banner, both branches |
