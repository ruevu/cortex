import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Target, Targets } from "./assertions/types.js";
import { mainWorktreeRoot } from "../../src/db/git-root.js";
import { readRepoId } from "../../src/db/repo-id.js";
import { durableStoreRoot } from "../../src/db/resolve-path.js";

/**
 * Where eval targets come from. Two files, in two places:
 *
 * - `evals/targets.json`: committed and public. Every target anyone can run.
 * - `targets.private.json` in this repository's private evals directory,
 *   `~/.cortex/<repoId>/evals/` (see `privateEvalsDir`): optional, and in no
 *   working tree. It holds targets whose source must not be published, such
 *   as a private repository pinned as a `file://` URL on one machine. Their
 *   baselines are private too, and live beside it under `baselines/`, because
 *   a baseline holds the repo's measured numbers.
 *
 * The `self` suite gates Cortex's own changes on both kinds; see
 * docs/architecture/eval-harness.md.
 */

const PRIVATE_TARGETS_FILE = "targets.private.json";

/**
 * This repository's private evals directory: `evals/` in its durable store,
 * `~/.cortex/<repoId>/` (or `$CORTEX_HOME/.cortex/<repoId>/`), beside its
 * decisions. Null when the repository has no id in `cortex.json`.
 *
 * It is deliberately not in the checkout. A gitignored file lives only in the
 * checkout that made it. No other worktree has it, a new worktree starts
 * without it, and `git worktree remove` deletes it without a word. The private
 * targets, and the baselines captured for them before any change, have to
 * outlive the worktree they were made in. So they sit on the
 * repository-identity axis, keyed by the committed repo id as decisions are,
 * and every checkout of the repository finds the same files. Being in no
 * working tree, they can never be committed with one either.
 *
 * It reads the id and never mints one: running an eval must not write
 * `cortex.json`.
 */
export function privateEvalsDir(startDir: string = process.cwd()): string | null {
  const root = mainWorktreeRoot(startDir);
  const repoId = root ? readRepoId(root) : null;
  return repoId ? join(durableStoreRoot(), repoId, "evals") : null;
}

/** The public targets followed by the private ones, each private entry marked
 *  `private: true`. That mark is the loader's alone to set — it decides where
 *  the target's baseline is written. A name defined in both files throws:
 *  two targets sharing a name would share one baseline, and each run would
 *  grade one repository against the other's numbers. */
export function mergeTargets(pub: Targets, priv: Targets | null): Target[] {
  if (!priv) return pub.targets;
  const names = new Set(pub.targets.map((t) => t.name));
  const merged: Target[] = [...pub.targets];
  for (const t of priv.targets) {
    if (names.has(t.name)) {
      throw new Error(
        `${PRIVATE_TARGETS_FILE} defines target "${t.name}", which is already defined — ` +
          `target names must be unique across both targets files, since a name picks the baseline file`,
      );
    }
    names.add(t.name);
    merged.push({ ...t, private: true });
  }
  return merged;
}

/** Why a run has no private targets, or null when it has them.
 *
 *  It is printed when the targets load, and again on the strict gate's
 *  verdict line. A gate run without them checks fewer targets than the same
 *  command checks elsewhere, and that must never pass silently as the full
 *  gate. */
export function privateTargetsNote(privateDir: string | null): string | null {
  if (privateDir === null) return "no repository id in cortex.json — private targets (mesh) are not in this run";
  const p = join(privateDir, PRIVATE_TARGETS_FILE);
  return existsSync(p) ? null : `no private targets file at ${p} — private targets (mesh) are not in this run`;
}

/** Read the public targets from `evalsDir` (default: `evals/` under the
 *  working directory, like the rest of the harness), and the private ones from
 *  `privateDir` (default: `privateEvalsDir()`).
 *
 *  A missing private file is normal: it exists only where its repos do. But it
 *  is announced on stderr every time (see `privateTargetsNote`). A
 *  `targets.private.json` left in a checkout is never read. */
export function loadTargets(
  evalsDir: string = resolve("evals"),
  privateDir: string | null = privateEvalsDir(),
): Target[] {
  const pub = JSON.parse(readFileSync(join(evalsDir, "targets.json"), "utf-8")) as Targets;
  const note = privateTargetsNote(privateDir);
  if (note !== null) {
    console.error(`note: ${note}`);
    return mergeTargets(pub, null);
  }
  return mergeTargets(pub, JSON.parse(readFileSync(join(privateDir!, PRIVATE_TARGETS_FILE), "utf-8")) as Targets);
}

/** The baseline file for a target: `evals/baselines/<name>.json` for a public
 *  one, and `<privateEvalsDir>/baselines/<name>.json` for a private one.
 *
 *  Every read and write of a baseline goes through here, so a private target's
 *  numbers can never land in the committed directory, or in any working tree. */
export function baselinePath(
  t: Pick<Target, "name" | "private">,
  evalsDir: string = resolve("evals"),
  privateDir: string | null = privateEvalsDir(),
): string {
  if (!t.private) return join(evalsDir, "baselines", `${t.name}.json`);
  if (privateDir === null) {
    throw new Error(
      `private target "${t.name}" has nowhere to keep its baseline: this repository has no id in cortex.json`,
    );
  }
  return join(privateDir, "baselines", `${t.name}.json`);
}
