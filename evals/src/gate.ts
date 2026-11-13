import type { TargetReport } from "./report.js";
import type { RatchetOutcome } from "./assertions/types.js";

/** A target whose run threw before it produced a report — a failed clone, a
 *  crashed indexer, an unreadable graph. It has no results, so without its
 *  own entry it would simply be absent from the gate, and absent reads as
 *  passing. */
export type FailedTarget = { target: string; error: string };

/** `lines` holds failures only: an empty list is exactly a pass. */
export type GateResult = { ok: boolean; lines: string[] };

/**
 * The verdict behind `npm run eval -- --strict`, and so behind the eval's
 * exit code.
 *
 * It reads only the outcomes applyRatchet already stored on each result
 * (`passed`, `surprised`, `ratchet`) and never recomputes one: the summary
 * report renders those same outcomes, and a second decider is how a report
 * and its exit code come to disagree (docs/architecture/eval-harness.md).
 *
 * What it adds is the cases a per-metric verdict cannot see, each of which
 * would otherwise let a broken run exit 0:
 *
 * 1. `[t] failed: …` — the target threw, so it has no results at all.
 * 2. `[t] no baseline — …` — nothing to compare against, so every universal
 *    metric is unjudged. Reported once; checks 3–5 are skipped, because each
 *    would only restate this one.
 * 3. `[t] REGRESSED <name>` — a result that was expected to pass and did not.
 *    An expected failure that still fails (`baseline_expected: "fail"`) is a
 *    known gap, not a regression.
 * 4. `[t] NOT MEASURED <name> (baseline had a value)` — a metric that measured
 *    something when the baseline was captured now measures nothing. The
 *    ratchet leaves it unjudged, which is correct for a single metric and
 *    wrong for a gate: a whole extraction collapsing would otherwise pass.
 * 5. `[t] judged nothing` — no result carried a verdict, e.g. a baseline file
 *    with no values in it.
 *
 * Failed targets come first, then each report in the order given.
 */
export function strictGate(reports: TargetReport[], failed: FailedTarget[]): GateResult {
  const lines: string[] = failed.map((f) => `[${f.target}] failed: ${f.error}`);

  for (const r of reports) {
    const t = r.target;
    if (!r.baseline) {
      lines.push(`[${t}] no baseline — run: npm run eval -- --capture-baseline=${t}`);
      continue;
    }
    const measuredBefore = r.baseline.per_assertion;

    for (const result of r.results) {
      if (result.surprised && result.passed === false) {
        lines.push(`[${t}] REGRESSED ${result.assertion.name}`);
      }
    }
    for (const result of r.results) {
      // A per-language map's keys are file extensions, so `.status` on a map
      // can be a key (a file named `*.status`). Its value is then an outcome
      // object, never the string compared here, so a map can't match.
      const status = (result.ratchet as RatchetOutcome | undefined)?.status;
      const name = result.assertion.name;
      if (status === "not_measured" && Object.hasOwn(measuredBefore, name)) {
        lines.push(`[${t}] NOT MEASURED ${name} (baseline had a value)`);
      }
    }
    if (!r.results.some((result) => result.passed !== null)) {
      lines.push(`[${t}] judged nothing`);
    }
  }

  return { ok: lines.length === 0, lines };
}
