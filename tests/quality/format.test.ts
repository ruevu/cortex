import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatQualityIndexLines, formatQualityHeadline, formatQualitySummary } from "../../src/quality/format.js";
import type { GraphQuality, QualityReport } from "../../src/quality/types.js";

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

  it("names the launcher's command in the details pointer", () => {
    process.env.CORTEX_PROG_NAME = "mesh ctx";
    const out = formatQualityIndexLines(quality({
      level: "poor", judged: true, reasons: ["55.0% of call edges are name guesses"], advice: ADVICE, note: null,
    }));
    expect(out?.split("\n").at(-1)).toBe(`  ${ADVICE} — details: mesh ctx quality`);
  });
});

const POOR: GraphQuality["verdict"] = {
  level: "poor", judged: true, advice: ADVICE, note: null,
  reasons: ["55.0% of call edges are name guesses", "12.0% of call edges run through suspect hubs (map, push, filter)"],
};

describe("formatQualityHeadline", () => {
  it("headline is one line for poor", () => {
    const line = formatQualityHeadline(quality(POOR));
    expect(line).not.toContain("\n");
    expect(line.startsWith("⚠ cortex quality: poor — ")).toBe(true);
    expect(line.endsWith(`(${ADVICE})`)).toBe(true);
    expect(line).toBe(
      "⚠ cortex quality: poor — 55.0% of call edges are name guesses; " +
      `12.0% of call edges run through suspect hubs (map, push, filter) (${ADVICE})`,
    );
  });

  it("headline is empty for ok", () => {
    expect(formatQualityHeadline(quality({ level: "ok", judged: true, reasons: [], advice: null, note: null }))).toBe("");
    expect(formatQualityHeadline(quality({
      level: "ok", judged: false, reasons: [], advice: null, note: "too few call edges to judge (12 < 200)",
    }))).toBe("");
  });
});

function report(q: GraphQuality, extra: Partial<QualityReport> = {}): QualityReport {
  return {
    version: 1, computed_at: "2026-11-12T10:00:00.000Z", repo_path: "/x",
    indexed_commit: "0123456789abcdef0123456789abcdef01234567", ...q, ...extra,
  };
}

describe("formatQualitySummary", () => {
  it("summary reports not judged", () => {
    const out = formatQualitySummary(report({
      ...quality({ level: "ok", judged: false, reasons: [], advice: null, note: "too few call edges to judge (12 < 200)" }),
      calls: { total: 12, resolved: 10, likely: 0, name_guess: 2, unscored: 0, hub_edges: 0 },
    }));
    expect(out.split("\n")[0]).toBe("graph quality: ok — not judged: too few call edges to judge (12 < 200)");
  });

  it("summary lists the label counts, every listed hub, the reasons and the commit", () => {
    const out = formatQualitySummary(report({
      ...quality(POOR),
      calls: { total: 4097, resolved: 1200, likely: 97, name_guess: 2800, unscored: 0, hub_edges: 492 },
      hub_count: 3,
      suspect_hubs: [
        { name: "map", file: "src/util.ts", calls: 300, receivers: 41 },
        { name: "push", file: null, calls: 120, receivers: 12 },
      ],
    }));
    const lines = out.split("\n");
    expect(lines[0]).toBe("graph quality: poor — judged on 4,097 call edges");
    expect(lines).toContain("  call edges: resolved 1,200 · likely 97 · name guess 2,800 · unscored 0");
    expect(lines).toContain("  name guesses: 68.3% of call edges (degraded at 40%, poor at 50%)");
    expect(lines).toContain("  suspect hubs: 3, carrying 12.0% of call edges (degraded at 10%)");
    expect(lines).toContain("    map (src/util.ts) — 300 calls from 41 receivers");
    expect(lines).toContain("    push (file unknown) — 120 calls from 12 receivers");
    expect(lines).toContain("    …and 1 more");
    expect(lines).toContain("  why: 55.0% of call edges are name guesses");
    expect(lines).toContain(`  advice: ${ADVICE}`);
    expect(lines.at(-1)).toBe("  computed 2026-11-12T10:00:00.000Z · indexed at 0123456");
  });

  it("an ok summary carries no reasons or advice, and a report outside git no commit", () => {
    const out = formatQualitySummary(report(
      quality({ level: "ok", judged: true, reasons: [], advice: null, note: null }),
      { indexed_commit: null },
    ));
    expect(out).not.toContain("why:");
    expect(out).not.toContain("advice:");
    expect(out.split("\n").at(-1)).toBe("  computed 2026-11-12T10:00:00.000Z");
  });
});
