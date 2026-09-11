import { sourceDriftForContext } from "../../mcp-server/source-drift.js";
import { worktreeRoot } from "../../db/git-root.js";

/**
 * `cortex source-drift` — print the checkout-vs-base verdict for the cwd repo.
 *
 * SILENT (exit 0) on `current`, on `unknown`, and when the gate is off: the
 * SessionStart hook pipes this straight into its banner, so "nothing to say"
 * must produce no bytes at all rather than a reassuring line. A channel that
 * cries wolf once is ignored permanently.
 *
 * Anchored to the CHECKOUT root (D-d5k3's checkout axis) — a linked worktree is
 * judged on its own HEAD, never the main checkout's. Needs no graph DB, so it
 * answers on an unindexed repo where `cortex freshness` cannot.
 */
export function runSourceDriftCommand(startDir: string = process.cwd()): void {
  const d = sourceDriftForContext(worktreeRoot(startDir));
  if (!d || d.state !== "behind") return;
  process.stdout.write(`⚠ cortex source drift: ${d.note}\n`);
}
