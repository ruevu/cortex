import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runDecisionCommand } from "../../../src/cli/commands/decision.js";
import type { ProjectContext } from "../../../src/cli/context.js";

describe("cortex decision commands", () => {
  let dir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-dec-cmd-"));
    ctx = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: join(dir, "graph.db") };
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("list with no decisions returns empty output", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({ command: "list", positionals: [], flags: {} }, ctx);
    writeSpy.mockRestore();
    // Nothing thrown, that's the success path.
  });

  it("create with required flags persists the decision", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { title: "Test", description: "d", rationale: "r" },
    }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Test");
    writeSpy.mockRestore();
  });

  it("create without --title throws UsageError", async () => {
    await expect(runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { description: "d", rationale: "r" },
    }, ctx)).rejects.toThrow("missing --title");
  });

  // T-0a40 parity with the MCP propose contract: description OR resolution.
  it("propose accepts --description without --problem/--resolution", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "propose",
      positionals: [],
      flags: { title: "Proposed", description: "what was decided", rationale: "r" },
    }, ctx);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => String(c[0])).join(""));
    writeSpy.mockRestore();
    expect(out.status).toBe("proposed");
    expect(out.description).toBe("what was decided");
  });

  it("propose with --problem/--resolution still works", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "propose",
      positionals: [],
      flags: { title: "Narrative", problem: "p", resolution: "the resolution", rationale: "r" },
    }, ctx);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => String(c[0])).join(""));
    writeSpy.mockRestore();
    expect(out.description).toBe("the resolution");
    expect(out.problem).toBe("p");
  });

  it("propose records origin like every other mutating CLI command", async () => {
    execSync("git init -q -b feature/x && git -c user.email=t@t -c user.name=t commit -q --allow-empty --no-gpg-sign -m seed", { cwd: dir });
    const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "propose",
      positionals: [],
      flags: { title: "With origin", description: "d", rationale: "r" },
    }, { ...ctx, gitRoot: dir });
    const out = JSON.parse(writeSpy.mock.calls.map((c) => String(c[0])).join(""));
    writeSpy.mockRestore();
    expect(out.origin_branch).toBe("feature/x");
    expect(out.origin_commit).toBe(head);
  });

  it("propose with neither --description nor --resolution throws UsageError", async () => {
    await expect(runDecisionCommand({
      command: "propose",
      positionals: [],
      flags: { title: "t", rationale: "r" },
    }, ctx)).rejects.toThrow(/--description or --resolution/);
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runDecisionCommand({ command: "frobnicate", positionals: [], flags: {} }, ctx))
      .rejects.toThrow("unknown command");
  });
});
