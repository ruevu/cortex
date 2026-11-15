import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  qualityReportPath, readQualityReport, removeQualityReport, writeQualityReport,
} from "../../src/quality/report-store.js";
import type { QualityReport } from "../../src/quality/types.js";

function sample(repo: string, indexed_commit = "abc123"): QualityReport {
  return {
    version: 1, computed_at: "2026-11-13T00:00:00.000Z", repo_path: repo, indexed_commit,
    calls: { total: 200, resolved: 100, likely: 0, name_guess: 100, unscored: 0, hub_edges: 0 },
    guess_share: 0.5, hub_share: 0, hub_count: 0, suspect_hubs: [],
    verdict: {
      level: "poor", judged: true, reasons: ["50.0% of call edges are name guesses"],
      advice: "treat callers/callees as hints; confirm with search_code", note: null,
    },
  };
}

describe("quality report store", () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "cortex-quality-store-")); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("the path is checkout-scoped .cortex/quality.json", () => {
    expect(qualityReportPath(repo)).toBe(join(repo, ".cortex", "quality.json"));
  });

  it("round-trips a report", () => {
    writeQualityReport(repo, sample(repo));
    expect(readQualityReport(repo)).toEqual(sample(repo));
  });

  it("reads null when absent", () => {
    expect(readQualityReport(repo)).toBeNull();
  });

  it("a different version is invisible", () => {
    mkdirSync(join(repo, ".cortex"), { recursive: true });
    writeFileSync(qualityReportPath(repo), JSON.stringify({ ...sample(repo), version: 2 }));
    expect(readQualityReport(repo)).toBeNull();
  });

  it("a malformed file reads null", () => {
    mkdirSync(join(repo, ".cortex"), { recursive: true });
    writeFileSync(qualityReportPath(repo), '{"version": 1, "calls": ');
    expect(readQualityReport(repo)).toBeNull();
  });

  it("remove deletes it", () => {
    writeQualityReport(repo, sample(repo));
    removeQualityReport(repo);
    expect(existsSync(qualityReportPath(repo))).toBe(false);
  });

  it("a failed write removes the report it could not replace", () => {
    // The report describes the graph that was just built. If the new one
    // cannot be written, the old one describes an older graph: gone beats wrong.
    writeQualityReport(repo, sample(repo));
    mkdirSync(`${qualityReportPath(repo)}.${process.pid}.tmp`); // the write's temp path, blocked
    writeQualityReport(repo, sample(repo, "def456"));
    expect(readQualityReport(repo)).toBeNull();
  });
});
