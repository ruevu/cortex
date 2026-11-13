import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQualityCommand } from "../../src/cli/commands/quality.js";
import { writeQualityReport } from "../../src/quality/report-store.js";
import type { QualityReport } from "../../src/quality/types.js";

const ADVICE = "treat callers/callees as hints; confirm with search_code";

/** A git repo with one commit — `git worktree add` needs a commit to check out. */
function gitRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-quality-")));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", [
    "-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", "init",
  ]);
  return root;
}

function capture(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out += String(c); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return out;
}

const OK: QualityReport = {
  version: 1, computed_at: "2026-11-12T10:00:00.000Z", repo_path: "/x", indexed_commit: "0123456789abcdef",
  calls: { total: 4097, resolved: 3500, likely: 300, name_guess: 297, unscored: 0, hub_edges: 0 },
  guess_share: 297 / 4097, hub_share: 0, hub_count: 0, suspect_hubs: [],
  verdict: { level: "ok", judged: true, reasons: [], advice: null, note: null },
};

const POOR: QualityReport = {
  ...OK,
  calls: { total: 4097, resolved: 1200, likely: 97, name_guess: 2800, unscored: 0, hub_edges: 0 },
  guess_share: 2800 / 4097,
  verdict: { level: "poor", judged: true, reasons: ["68.3% of call edges are name guesses"], advice: ADVICE, note: null },
};

const HEADLINE = `⚠ cortex quality: poor — 68.3% of call edges are name guesses (${ADVICE})`;

beforeEach(() => {
  vi.stubEnv("CORTEX_QUALITY", "");
  vi.stubEnv("CORTEX_PROG_NAME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cortex quality", () => {
  it("--headline prints the line for a poor report", () => {
    const root = gitRepo();
    writeQualityReport(root, POOR);
    expect(capture(() => runQualityCommand({ headline: true }, root))).toBe(HEADLINE + "\n");
  });

  it("--headline is silent for ok and for no report", () => {
    const root = gitRepo();
    expect(capture(() => runQualityCommand({ headline: true }, root))).toBe("");
    writeQualityReport(root, OK);
    expect(capture(() => runQualityCommand({ headline: true }, root))).toBe("");
  });

  it("--json prints the report, or null", () => {
    const root = gitRepo();
    expect(JSON.parse(capture(() => runQualityCommand({ json: true }, root)))).toBeNull();
    writeQualityReport(root, POOR);
    expect(JSON.parse(capture(() => runQualityCommand({ json: true }, root)))).toEqual(POOR);
  });

  it("default prints the summary", () => {
    const root = gitRepo();
    writeQualityReport(root, OK);
    expect(capture(() => runQualityCommand({}, root))).toContain("graph quality: ok — judged on 4,097 call edges");
  });

  it("no report prints the index hint", () => {
    const root = gitRepo();
    expect(capture(() => runQualityCommand({}, root))).toBe("no quality report for this checkout — run: cortex index\n");
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(capture(() => runQualityCommand({}, root))).toBe("no quality report for this checkout — run: mesh ctx index\n");
  });

  it("CORTEX_QUALITY=0 is silent in every mode", () => {
    const root = gitRepo();
    writeQualityReport(root, POOR);
    vi.stubEnv("CORTEX_QUALITY", "0");
    for (const flags of [{}, { json: true }, { headline: true }]) {
      expect(capture(() => runQualityCommand(flags, root))).toBe("");
    }
    // …and with no report, where the default mode would otherwise print the hint.
    expect(capture(() => runQualityCommand({}, gitRepo()))).toBe("");
  });

  it("linked worktree reads its own report", () => {
    const root = gitRepo();
    const linked = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-quality-linked-")));
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", linked]);
    writeQualityReport(root, POOR);
    expect(capture(() => runQualityCommand({ headline: true }, linked))).toBe("");
    writeQualityReport(linked, POOR);
    expect(capture(() => runQualityCommand({ headline: true }, linked))).toBe(HEADLINE + "\n");
  });
});
