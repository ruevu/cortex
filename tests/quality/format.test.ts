import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatQualityIndexLines } from "../../src/quality/format.js";
import type { GraphQuality } from "../../src/quality/types.js";

const ADVICE = "treat callers/callees as hints; confirm with search_code";

/** The formatter renders the stored verdict; it never re-judges, so the
 *  counts here only need to be plausible. */
function quality(verdict: GraphQuality["verdict"]): GraphQuality {
  return {
    calls: { total: 1000, resolved: 400, likely: 50, name_guess: 550, unscored: 0, hub_edges: 120 },
    guess_share: 0.55, hub_share: 0.12, hub_count: 2, suspect_hubs: [],
    verdict,
  };
}

describe("formatQualityIndexLines", () => {
  const saved = process.env.CORTEX_PROG_NAME;
  beforeEach(() => { delete process.env.CORTEX_PROG_NAME; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CORTEX_PROG_NAME;
    else process.env.CORTEX_PROG_NAME = saved;
  });

  it("ok is silent, judged or not", () => {
    expect(formatQualityIndexLines(quality({ level: "ok", judged: true, reasons: [], advice: null, note: null }))).toBeNull();
    expect(formatQualityIndexLines(quality({
      level: "ok", judged: false, reasons: [], advice: null, note: "too few call edges to judge (12 < 200)",
    }))).toBeNull();
  });

  it("poor with one reason is three lines", () => {
    const out = formatQualityIndexLines(quality({
      level: "poor", judged: true, reasons: ["55.0% of call edges are name guesses"], advice: ADVICE, note: null,
    }));
    expect(out?.split("\n")).toEqual([
      "⚠ graph quality: poor",
      "  55.0% of call edges are name guesses",
      `  ${ADVICE} — details: cortex quality`,
    ]);
  });

  it("degraded with both reasons is four lines", () => {
    const out = formatQualityIndexLines(quality({
      level: "degraded", judged: true, advice: ADVICE, note: null,
      reasons: ["40.0% of call edges are name guesses", "12.0% of call edges run through suspect hubs (map, push)"],
    }));
    const lines = out?.split("\n") ?? [];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("⚠ graph quality: degraded");
    expect(lines[2]).toBe("  12.0% of call edges run through suspect hubs (map, push)");
    expect(lines[3]).toMatch(/— details: cortex quality$/);
  });

  it("is never more than four lines", () => {
    const out = formatQualityIndexLines(quality({
      level: "poor", judged: true, advice: ADVICE, note: null,
      reasons: ["first", "second", "third"],
    }));
    expect(out?.split("\n")).toHaveLength(4);
  });
});
