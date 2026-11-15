import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The ordering contract, enforced rather than merely documented.
 *
 * GET /api/quality serves `.cortex/quality.json` under an ETag derived from
 * the index baseline that `captureIndexMeta` writes. If the report were
 * written AFTER the baseline moved, a poll landing between the two would
 * cache the OLD report under the NEW ETag — and every later poll would get
 * 304 Not Modified for it until the next reindex. Nothing errors; the viewer
 * just keeps showing the previous graph's verdict.
 *
 * The report also follows the staleness sweep, which must itself run before
 * captureIndexMeta (tests/staleness/index-wiring.test.ts) — so the order at
 * every site is: sweep, quality, captureIndexMeta.
 */
describe("quality report before captureIndexMeta", () => {
  it("is honoured at every index call site in src/", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    })("src");

    const sites: Array<{ file: string; sweep: number; quality: number; capture: number }> = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Calls only — skip the declaration in graph/capture-index-meta.ts.
        if (!line.includes("captureIndexMeta(dbPath")) return;
        if (line.includes("export function")) return;
        let sweep = -1;
        let quality = -1;
        for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
          if (quality < 0 && lines[j]!.includes("runQualityReport(")) quality = j;
          if (sweep < 0 && lines[j]!.includes("runStalenessSweep(")) sweep = j;
        }
        sites.push({ file: f, sweep, quality, capture: i });
      });
    }

    // Guard against a vacuous pass: renaming the call sites away must fail
    // loudly, not assert over an empty list.
    expect(sites.length).toBe(3);
    for (const s of sites) {
      const where = `${s.file}:${s.capture + 1}`;
      expect(s.quality, `${where}: runQualityReport must precede captureIndexMeta`).toBeGreaterThanOrEqual(0);
      expect(s.sweep, `${where}: runStalenessSweep must precede captureIndexMeta`).toBeGreaterThanOrEqual(0);
      expect(s.quality, `${where}: runQualityReport must follow runStalenessSweep`).toBeGreaterThan(s.sweep);
    }
  });
});
