import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Target, Targets } from "./assertions/types.js";

/**
 * Where eval targets come from. Two files:
 *
 * - `evals/targets.json` — committed, public. Every target anyone can run.
 * - `evals/targets.private.json` — gitignored, optional. Targets whose
 *   source must not be published, such as a private repository pinned as a
 *   `file://` URL on one machine. Their baselines are private too: they live
 *   under `evals/baselines/private/`, which is also gitignored, because a
 *   baseline holds the repo's measured numbers.
 *
 * The `self` suite gates Cortex's own changes on both kinds; see
 * docs/architecture/eval-harness.md.
 */

const PRIVATE_TARGETS_FILE = "targets.private.json";

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
        `evals/${PRIVATE_TARGETS_FILE} defines target "${t.name}", which is already defined — ` +
          `target names must be unique across both targets files, since a name picks the baseline file`,
      );
    }
    names.add(t.name);
    merged.push({ ...t, private: true });
  }
  return merged;
}

/** Read both targets files from `evalsDir` (default: `evals/` under the
 *  working directory, like the rest of the harness).
 *
 *  A missing private file is normal — it exists only where its repos do — but
 *  it is announced on stderr every time. A gate run without it checks fewer
 *  targets than the same command checks elsewhere, and that must never pass
 *  silently as the full gate. */
export function loadTargets(evalsDir: string = resolve("evals")): Target[] {
  const pub = JSON.parse(readFileSync(join(evalsDir, "targets.json"), "utf-8")) as Targets;
  const privPath = join(evalsDir, PRIVATE_TARGETS_FILE);
  if (!existsSync(privPath)) {
    console.error(`note: no evals/${PRIVATE_TARGETS_FILE} — private targets (mesh) are not in this run`);
    return mergeTargets(pub, null);
  }
  return mergeTargets(pub, JSON.parse(readFileSync(privPath, "utf-8")) as Targets);
}

/** The baseline file for a target: `evals/baselines/<name>.json`, or
 *  `evals/baselines/private/<name>.json` for a private target. Every read and
 *  write of a baseline goes through here, so a private target's numbers can
 *  never land in the committed directory. */
export function baselinePath(t: Pick<Target, "name" | "private">, evalsDir: string = resolve("evals")): string {
  return t.private
    ? join(evalsDir, "baselines", "private", `${t.name}.json`)
    : join(evalsDir, "baselines", `${t.name}.json`);
}
