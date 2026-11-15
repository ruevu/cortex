import { describe, it, expect } from "vitest";
import { gateHeadline, strictGate } from "../../evals/src/gate.js";
import type { TargetReport } from "../../evals/src/report.js";
import type { Assertion, AssertionResult, Baseline, Scorecard } from "../../evals/src/assertions/types.js";

/**
 * The strict gate is the eval's exit code. Every fixture here carries the
 * outcome applyRatchet would have stored; the gate must read those outcomes
 * and never re-derive a verdict of its own — two deciders is how a report and
 * its exit code come to disagree.
 */

const card = (target: string): Scorecard => ({
  target, indexer_seconds: null, nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
});

const universal = (name: string): Assertion => ({
  fix_id: "universal", name, description: "stub",
  query: { kind: "sql", sql: "SELECT 1" },
  baseline_expected: "pass", scope: "universal", direction: "lower_is_better",
});

const passing = (name: string, value = 30): AssertionResult => ({
  assertion: universal(name), observed: value, passed: true, surprised: false,
  ratchet: { status: "pass", observed: value, baseline: value, delta: 0, improved: false },
});

const regressed = (name: string, observed: number, baseline: number): AssertionResult => ({
  assertion: universal(name), observed, passed: false, surprised: true,
  ratchet: { status: "fail", observed, baseline, delta: observed - baseline, improved: false },
});

const notMeasured = (name: string): AssertionResult => ({
  assertion: universal(name), observed: null, passed: null, surprised: false,
  ratchet: { status: "not_measured", observed: null },
});

const unjudged = (name: string, value = 30): AssertionResult => ({
  assertion: universal(name), observed: value, passed: null, surprised: false,
  ratchet: { status: "no_baseline", observed: value },
});

const baseline = (target: string, perAssertion: Baseline["per_assertion"]): Baseline => ({
  target, captured_at: "2026-11-13T00:00:00.000Z",
  nodes_by_label: {}, edges_by_type: {}, per_assertion: perAssertion,
});

const report = (target: string, results: AssertionResult[], base: Baseline | null): TargetReport => ({
  target, scorecard: card(target), results, baseline: base,
});

describe("strictGate", () => {
  it("passes when every judged result passed", () => {
    const r = report("cortex", [passing("guess_share"), passing("quality_level", 0)],
      baseline("cortex", { guess_share: 30, quality_level: 0 }));
    expect(strictGate([r], [])).toEqual({ ok: true, lines: [] });
  });

  it("fails on a regression", () => {
    const r = report("cortex", [passing("quality_level", 0), regressed("guess_share", 33, 30)],
      baseline("cortex", { guess_share: 30, quality_level: 0 }));
    expect(strictGate([r], [])).toEqual({ ok: false, lines: ["[cortex] REGRESSED guess_share"] });
  });

  it("an expected failure that still fails is not a regression", () => {
    const knownGap: AssertionResult = {
      assertion: {
        fix_id: 2, name: "http_calls_edge_count_nonzero", description: "stub",
        query: { kind: "count_edge", type: "HTTP_CALLS" }, predicate: { op: "gt", value: 0 },
        baseline_expected: "fail", scope: "nuxt",
      },
      observed: 0, passed: false, surprised: false,
    };
    const r = report("nuxt-ui", [knownGap], baseline("nuxt-ui", {}));
    expect(strictGate([r], [])).toEqual({ ok: true, lines: [] });
  });

  it("fails on a target that threw", () => {
    expect(strictGate([], [{ target: "mesh", error: "clone failed" }])).toEqual({
      ok: false, lines: ["[mesh] failed: clone failed"],
    });
  });

  it("fails on a missing baseline, and says so once", () => {
    const r = report("cortex", [unjudged("guess_share")], null);
    expect(strictGate([r], [])).toEqual({
      ok: false,
      lines: ["[cortex] no baseline — run: npm run eval -- --capture-baseline=cortex"],
    });
  });

  it("fails when a measured metric now measures nothing", () => {
    const r = report("cortex", [passing("guess_share"), notMeasured("call_attribution_rate")],
      baseline("cortex", { guess_share: 30, call_attribution_rate: 95.2 }));
    expect(strictGate([r], [])).toEqual({
      ok: false,
      lines: ["[cortex] NOT MEASURED call_attribution_rate (baseline had a value)"],
    });
  });

  it("a metric the baseline never measured is not flagged when it still measures nothing", () => {
    const r = report("cortex", [passing("guess_share"), notMeasured("orphan_definition_rate")],
      baseline("cortex", { guess_share: 30 }));
    expect(strictGate([r], [])).toEqual({ ok: true, lines: [] });
  });

  it("fails when a baseline metric is missing from the run", () => {
    // A renamed or dropped metric must not leave the gate silently.
    const r = report("cortex", [passing("guess_share")], baseline("cortex", { guess_share: 30, hub_share: 7.7 }));
    expect(strictGate([r], [])).toEqual({
      ok: false,
      lines: ["[cortex] MISSING hub_share (in the baseline, not in this run)"],
    });
  });

  it("fails when a baseline value cannot be compared", () => {
    // applyRatchet reads a non-number baseline value as "no baseline", which
    // leaves the metric unjudged — e.g. a hand-edited "33.26" string.
    const r = report("cortex", [passing("quality_level", 0), unjudged("guess_share")],
      baseline("cortex", { quality_level: 0, guess_share: "33.26" }));
    expect(strictGate([r], [])).toEqual({
      ok: false,
      lines: ["[cortex] UNCOMPARABLE guess_share (baseline value is not comparable)"],
    });
  });

  it("a metric new since the baseline is not a failure", () => {
    const r = report("cortex", [passing("guess_share"), unjudged("unscored_share")],
      baseline("cortex", { guess_share: 30 }));
    expect(strictGate([r], [])).toEqual({ ok: true, lines: [] });
  });

  it("fails when nothing was judged", () => {
    const r = report("cortex", [unjudged("guess_share"), notMeasured("quality_level")], baseline("cortex", {}));
    expect(strictGate([r], [])).toEqual({ ok: false, lines: ["[cortex] judged nothing"] });
  });

  it("a density map keyed 'status' is not mistaken for a scalar outcome", () => {
    // Map keys are file extensions from arbitrary repos, so a file named
    // `*.status` puts a `status` key on the per-language outcome map.
    const density: AssertionResult = {
      assertion: { ...universal("per_language_function_density"), query: { kind: "language_density" }, direction: "higher_is_better" },
      observed: { status: 1.5, ts: 2 },
      passed: true, surprised: false,
      ratchet: {
        status: { status: "pass", observed: 1.5, baseline: 1.5, delta: 0, improved: false },
        ts: { status: "pass", observed: 2, baseline: 2, delta: 0, improved: false },
      },
    };
    const r = report("cortex", [density], baseline("cortex", { per_language_function_density: { status: 1.5, ts: 2 } }));
    expect(strictGate([r], [])).toEqual({ ok: true, lines: [] });
  });

  it("reports every target, failed ones first", () => {
    const good = report("cortex", [passing("guess_share")], baseline("cortex", { guess_share: 30 }));
    const bad = report("other", [regressed("guess_share", 40, 30)], baseline("other", { guess_share: 30 }));
    expect(strictGate([good, bad], [{ target: "mesh", error: "clone failed" }]).lines).toEqual([
      "[mesh] failed: clone failed",
      "[other] REGRESSED guess_share",
    ]);
  });
});

describe("gateHeadline", () => {
  // The verdict line is what a release reads. A gate that checked fewer
  // targets than the same command checks elsewhere must say so there, not
  // only in a note scrolled away above minutes of indexer output.
  it("names every target the gate covered", () => {
    expect(gateHeadline(true, ["cortex", "mesh"], null)).toBe("strict gate: PASS — gated: cortex, mesh");
  });

  it("says on the verdict line when the private targets were not in the run", () => {
    const note = "no private targets file at /p/targets.private.json — private targets (mesh) are not in this run";
    expect(gateHeadline(true, ["cortex"], note)).toBe(`strict gate: PASS — gated: cortex (${note})`);
  });

  it("reads FAIL for a failed gate", () => {
    expect(gateHeadline(false, ["cortex", "mesh"], null)).toBe("strict gate: FAIL — gated: cortex, mesh");
  });
});
