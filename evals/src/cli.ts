#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireTarget, compareGraphShape, forceReindex } from "./target.js";
import { baselinePath, loadTargets, privateEvalsDir, privateTargetsNote } from "./target-config.js";
import { computeScorecard } from "./scorecard.js";
import { runAssertion } from "./assertions/runner.js";
import { runToolAssertion } from "./assertions/tool-runner.js";
import { ALL_ASSERTIONS, selectAssertions } from "./assertions/registry.js";
import { applyRatchet } from "./assertions/verdicts.js";
import { mergeImprovements } from "./baselines.js";
import { writeReportArtifacts, type TargetReport } from "./report.js";
import { gateHeadline, strictGate, type FailedTarget } from "./gate.js";
import { EVAL_CACHE_ROOT, EVAL_REPORTS_ROOT } from "./paths.js";
import type {
  Target,
  AssertionResult,
  Baseline,
} from "./assertions/types.js";

type Args = {
  target?: string;
  path?: string;
  captureBaseline?: string;
  suite?: string;
  determinism?: boolean;
  acceptImprovements?: boolean;
  /** Exit non-zero when the run regressed or could not be judged — see
   *  strictGate. Without it the eval only reports, and always exits 0. */
  strict?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--target=")) args.target = a.slice("--target=".length);
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a.startsWith("--capture-baseline=")) args.captureBaseline = a.slice("--capture-baseline=".length);
    else if (a.startsWith("--suite=")) args.suite = a.slice("--suite=".length);
    else if (a === "--determinism") args.determinism = true;
    else if (a === "--accept-improvements") args.acceptImprovements = true;
    else if (a === "--strict") args.strict = true;
  }
  return args;
}

function loadBaseline(target: Target): Baseline | null {
  const p = baselinePath(target);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Baseline;
}

function loadFixture(target: string): { vue_file_path: string; vue_component_name: string } | null {
  const p = resolve("evals/fixtures", `${target}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function runTarget(
  target: Target,
  pathOverride?: string,
  opts: { determinism?: boolean } = {},
): TargetReport {
  const acquired = acquireTarget(target, pathOverride);
  const scorecard = computeScorecard(acquired.graphDbPath, acquired.name);
  scorecard.indexer_seconds = acquired.indexer_seconds;

  const fixture = loadFixture(acquired.name);
  const decisionsDbPath = join(EVAL_CACHE_ROOT, acquired.name, "decisions.db");

  const results: AssertionResult[] = [];
  const packs = target.packs ?? ["universal"];
  for (const a of selectAssertions(ALL_ASSERTIONS, packs)) {
    if (a.query.kind === "tool_call") {
      if (!fixture) {
        // Skip tool-behavior assertions when no fixture file exists for the target.
        continue;
      }
      results.push(runToolAssertion(a, {
        dbPath: acquired.graphDbPath,
        fixture,
        project: acquired.name,
        decisionsDbPath,
      }));
    } else {
      results.push(runAssertion(a, { dbPath: acquired.graphDbPath }));
    }
  }

  // Determinism runs LAST, and deliberately so: each forced pass replaces
  // graph.db, so running it earlier would leave the assertions above reading a
  // different index build than the scorecard describes — one report describing
  // two builds, which is the very inconsistency this metric exists to detect.
  // Wrapped so an indexer failure here cannot discard assertions that already
  // succeeded.
  if (opts.determinism) {
    try {
      // Both passes must be fresh builds from the SAME binary. Reusing whatever
      // graph.db happens to be cached would compare an unknown earlier build —
      // possibly from a different indexer version — against this one, and report
      // a version difference as nondeterminism.
      forceReindex(acquired.workdir, acquired.graphDbPath);
      const first = computeScorecard(acquired.graphDbPath, acquired.name);
      forceReindex(acquired.workdir, acquired.graphDbPath);
      const second = computeScorecard(acquired.graphDbPath, acquired.name);
      const cmp = compareGraphShape(first, second);
      if (!cmp.stable) {
        console.error(`[${acquired.name}] NONDETERMINISTIC: ${cmp.differences.join("; ")}`);
      } else {
        console.log(`[${acquired.name}] determinism: stable`);
      }
    } catch (e) {
      console.error(`[${acquired.name}] determinism check failed:`, e instanceof Error ? e.message : e);
    }
  }

  const baseline = loadBaseline(target);
  return {
    target: acquired.name,
    scorecard,
    results: applyRatchet(results, baseline),
    baseline,
    source_sha: acquired.source_sha,
  };
}

function captureBaseline(target: Target, pathOverride?: string): void {
  const report = runTarget(target, pathOverride);
  const baseline: Baseline = {
    target: target.name,
    captured_at: new Date().toISOString(),
    source_sha: report.source_sha,
    nodes_by_label: report.scorecard.nodes_by_label,
    edges_by_type: report.scorecard.edges_by_type,
    per_assertion: Object.fromEntries(
      report.results
        // A metric that measured nothing has no value to record. Writing null
        // would seed the baseline with a non-comparable entry; omitting the key
        // makes the next run read it as "no baseline", which is the truth.
        .filter((r) => r.observed !== null)
        .map((r) => {
          const obs =
            typeof r.observed === "object" && r.observed !== null && "text" in r.observed
              ? (r.observed as { text: string }).text
              : (r.observed as number | string[] | Record<string, number>);
          return [r.assertion.name, obs];
        }),
    ),
  };
  const path = baselinePath(target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  console.log(`Baseline captured for ${target.name}.`);
}

/** Targets in a suite. A target with no `suites` defaults to ["nuxt"], so the
 *  pre-existing targets keep their current behaviour without edits. */
export function selectTargets(targets: Target[], suite: string): Target[] {
  if (suite === "all") return targets;
  return targets.filter((t) => (t.suites ?? ["nuxt"]).includes(suite));
}

function main(): void {
  const args = parseArgs(process.argv);
  const targets = loadTargets();

  if (args.captureBaseline) {
    const t = targets.find((x) => x.name === args.captureBaseline);
    if (!t) {
      console.error(`Unknown target: ${args.captureBaseline}`);
      process.exit(1);
    }
    captureBaseline(t, args.path);
    return;
  }

  const selected = args.target
    ? targets.filter((x) => x.name === args.target)
    : selectTargets(targets, args.suite ?? "nuxt");
  if (selected.length === 0) {
    console.error(`No matching targets`);
    process.exit(1);
  }

  const reports: TargetReport[] = [];
  const failed: FailedTarget[] = [];
  for (const t of selected) {
    try {
      reports.push(runTarget(t, args.path, { determinism: args.determinism }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${t.name}] failed:`, message);
      // The full message is printed above; the gate line keeps its first line
      // (execFileSync errors carry the whole command and stderr after it).
      failed.push({ target: t.name, error: message.split("\n")[0] ?? message });
    }
  }

  if (args.acceptImprovements) {
    for (const r of reports) {
      if (!r.baseline) {
        console.log(`[${r.target}] no baseline to update — run --capture-baseline=${r.target} first.`);
        continue;
      }
      const { baseline, adopted } = mergeImprovements(r.baseline, r.results);
      if (adopted.length === 0) {
        console.log(`[${r.target}] no improvements to adopt.`);
        continue;
      }
      // Every report came from a target in `selected`; looking it up by name
      // carries its private flag, so an adopted baseline stays where it was.
      const target = selected.find((t) => t.name === r.target)!;
      writeFileSync(baselinePath(target), JSON.stringify(baseline, null, 2));
      console.log(`[${r.target}] adopted ${adopted.length}: ${adopted.join(", ")}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 16);
  const reportsDir = join(EVAL_REPORTS_ROOT, stamp);
  const { summaryPath } = writeReportArtifacts(reportsDir, reports);
  console.log(`Eval complete. Summary: ${summaryPath}`);

  // After the artifacts, never before: a failing gate still leaves the
  // report that explains it. exitCode rather than process.exit(), so
  // nothing pending is cut off.
  if (args.strict) {
    const gate = strictGate(reports, failed);
    const headline = gateHeadline(gate.ok, selected.map((t) => t.name), privateTargetsNote(privateEvalsDir()));
    if (gate.ok) {
      console.log(headline);
    } else {
      console.error(headline);
      for (const line of gate.lines) console.error(`  ${line}`);
      process.exitCode = 1;
    }
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("cli.ts");
if (isDirect) main();
