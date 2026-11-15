import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runQualityReport } from "../../src/quality/run-report.js";
import { qualityReportPath, readQualityReport } from "../../src/quality/report-store.js";

const NOW = () => new Date("2026-11-13T00:00:00.000Z");

describe("runQualityReport", () => {
  const saved = process.env.CORTEX_QUALITY;
  let repo: string;
  let dbPath: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-quality-run-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", [
      "-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T",
      "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "init",
    ]);
    mkdirSync(join(repo, ".cortex"), { recursive: true });
    dbPath = join(repo, ".cortex", "db");
    delete process.env.CORTEX_QUALITY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CORTEX_QUALITY;
    else process.env.CORTEX_QUALITY = saved;
    rmSync(repo, { recursive: true, force: true });
  });

  /** CALLS edges between two functions: resolved at 0.95, guesses at 0.30. */
  function seed(counts: { resolved?: number; guess?: number }) {
    const store = new GraphStore(dbPath);
    try {
      const src = store.createNode({ kind: "function", name: "caller", qualified_name: "p.a.caller", file_path: "a.ts" });
      const tgt = store.createNode({ kind: "function", name: "target", qualified_name: "p.b.target", file_path: "b.ts" });
      const call = (confidence: number) => store.createEdge({
        source_id: src.id, target_id: tgt.id, relation: "CALLS",
        data: { callee: "target", strategy: "unique_name", confidence },
      });
      for (let i = 0; i < (counts.resolved ?? 0); i++) call(0.95);
      for (let i = 0; i < (counts.guess ?? 0); i++) call(0.3);
    } finally {
      store.close();
    }
  }

  it("writes the report for an ok graph and prints nothing", () => {
    seed({ resolved: 210 });
    expect(runQualityReport(repo, dbPath, NOW)).toBeNull();

    const report = readQualityReport(repo);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(report).toMatchObject({
      version: 1, computed_at: "2026-11-13T00:00:00.000Z", repo_path: repo, indexed_commit: head,
      calls: { total: 210, resolved: 210 },
      verdict: { level: "ok", judged: true },
    });
  });

  it("returns the index lines for a poor graph", () => {
    seed({ resolved: 100, guess: 100 });
    expect(runQualityReport(repo, dbPath, NOW)).toMatch(/^⚠ graph quality: poor\n/);
    expect(readQualityReport(repo)?.verdict.level).toBe("poor");
  });

  it("removes a stale report when the compute fails", () => {
    seed({ resolved: 210 });
    runQualityReport(repo, dbPath, NOW);
    expect(readQualityReport(repo)).not.toBeNull();

    expect(runQualityReport(repo, join(repo, ".cortex", "no-such-db"), NOW)).toBeNull();
    expect(readQualityReport(repo)).toBeNull();
  });

  it("never throws on a non-sqlite file", () => {
    writeFileSync(dbPath, "this is not a database\n");
    expect(() => runQualityReport(repo, dbPath, NOW)).not.toThrow();
    expect(runQualityReport(repo, dbPath, NOW)).toBeNull();
    expect(readQualityReport(repo)).toBeNull();
  });

  it("CORTEX_QUALITY=0 writes nothing", () => {
    seed({ resolved: 100, guess: 100 });
    process.env.CORTEX_QUALITY = "0";
    expect(runQualityReport(repo, dbPath, NOW)).toBeNull();
    expect(existsSync(qualityReportPath(repo))).toBe(false);
  });
});
