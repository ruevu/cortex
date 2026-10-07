import { describe, it, expect, vi, afterEach } from "vitest";
import { brand, progName } from "../../src/cli/prog.js";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "../../src/cli/help.js";
import { renderTopic } from "../../src/cli/commands/help.js";
import { renderTour } from "../../src/cli/tour.js";
import { renderError, UsageError, DomainError } from "../../src/cli/errors.js";
import { writeRows } from "../../src/cli/format.js";
import { makeStyler } from "../../src/cli/style.js";

// A launcher that embeds the CLI under another command (Mesh's `mesh ctx`)
// sets CORTEX_PROG_NAME so the commands the CLI tells you to run are ones
// you can actually type.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const stderrOf = (fn: () => void): string => {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fn();
  return spy.mock.calls.map((c) => String(c[0])).join("");
};

describe("progName", () => {
  it("defaults to cortex", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "");
    expect(progName()).toBe("cortex");
  });

  it("reads CORTEX_PROG_NAME, ignoring surrounding whitespace", () => {
    vi.stubEnv("CORTEX_PROG_NAME", " mesh ctx ");
    expect(progName()).toBe("mesh ctx");
  });
});

describe("brand", () => {
  it("is the identity when no prog name is set", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "");
    const text = "Run: cortex code find foo\nUsage: cortex <namespace>";
    expect(brand(text)).toBe(text);
  });

  it("rewrites every command-shaped cortex", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(brand("Run: cortex code find foo")).toBe("Run: mesh ctx code find foo");
    expect(brand("`cortex todo propose`, then `cortex --help`")).toBe("`mesh ctx todo propose`, then `mesh ctx --help`");
    expect(brand("  cortex <namespace> <command>")).toBe("  mesh ctx <namespace> <command>");
    expect(brand("'cortex setup frames'")).toBe("'mesh ctx setup frames'");
    expect(brand("cortex source-drift")).toBe("mesh ctx source-drift");
  });

  it("leaves the product name in prose alone", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    for (const text of [
      "Hi — cortex indexes your codebase",
      "cortex — knowledge graph for your codebase",
      "add cortex to PATH",
      "cortex 2.4.2",
      "cortex gc: 3 removed",
      "mesh-cortex code",
      "Users-x-cortex.src.cli.code",
    ]) {
      expect(brand(text)).toBe(text);
    }
  });

  it("survives ANSI styling around the command", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(brand("\u001b[32mcortex code find\u001b[39m")).toBe("\u001b[32mmesh ctx code find\u001b[39m");
  });
});

describe("rendered output under a prog name", () => {
  it("help renderers name the prog, not cortex", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    const top = renderTopLevelHelp(makeStyler({ isTTY: false }));
    expect(top).toContain("mesh ctx <namespace> <command>");
    expect(top).toContain("mesh ctx code find <name>");
    expect(top).not.toMatch(/(?<![\w-])cortex (code|decision|eval|tour|help) /);
    expect(renderNamespaceHelp("code")).toContain("Run `mesh ctx code <command> --help`");
    expect(renderCommandHelp("code", "search")).toContain("mesh ctx code search ribbon");
  });

  // `cortex install` links bin/cortex onto PATH — meaningless for a launcher
  // that renamed the program, which is itself the thing on PATH.
  it("top-level help drops `install` under a prog name, and keeps it without one", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(renderTopLevelHelp()).not.toContain("install");
    vi.stubEnv("CORTEX_PROG_NAME", "");
    expect(renderTopLevelHelp()).toContain("cortex install");
  });

  it("help topics and the tour are branded", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(renderTopic("eval")).toContain("mesh ctx eval report");
    let thrown: unknown;
    try { renderTopic("nope"); } catch (e) { thrown = e; }
    expect(stderrOf(() => renderError(thrown))).toContain("Try: mesh ctx help qualified-names");
    const tour = renderTour({ state: "no-project" } as Parameters<typeof renderTour>[0]);
    expect(tour).toContain("mesh ctx index list");
    expect(tour).toContain("Hi — cortex indexes");
  });

  it("error messages and hints are branded", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    const usage = stderrOf(() => renderError(new UsageError("unknown command 'cortex code nope'", "Run: cortex code --help")));
    expect(usage).toContain("unknown command 'mesh ctx code nope'");
    expect(usage).toContain("Run: mesh ctx code --help");
    expect(stderrOf(() => renderError(new DomainError("no todo", "Try: cortex todo list")))).toContain("Try: mesh ctx todo list");
  });

  it("an empty listing's hint is branded", () => {
    vi.stubEnv("CORTEX_PROG_NAME", "mesh ctx");
    expect(stderrOf(() => writeRows([], "table", "no todos yet — try `cortex todo propose`"))).toBe(
      "no todos yet — try `mesh ctx todo propose`\n",
    );
  });
});
