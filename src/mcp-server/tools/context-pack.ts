import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNodeById, tracePath, IndexerNode } from "../../graph/code-queries.js";
import { resolveInput, type ResolvedSymbol } from "../../shared/resolve-input.js";
import { denormalize } from "../qualified-name.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { symbolMissHint } from "./search-format.js";
import { DecisionSearch } from "../../decisions/search.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { projectFromCtx, readSnippet, ambiguousInputMessage } from "./code-tools-shared.js";
import { RepoPathField } from "./shared-fields.js";

const execFileAsync = promisify(execFile);

const CAP_CALLERS = 10;
const CAP_CALLEES = 10;
const CAP_DECISIONS = 5;
const CAP_COMMITS = 5;

const contextPackShape = {
  repo_path: RepoPathField,
  qualified_name: z.string().min(1, "qualified_name must not be empty"),
} as const;
const contextPackSchema = z.object(contextPackShape);

type ResolveResult =
  | { kind: "single"; node: IndexerNode }
  | { kind: "none" }
  | { kind: "multi"; candidates: ResolvedSymbol[]; total: number };

function resolveNode(ctx: RepoContext, project: string, qualified_name: string): ResolveResult {
  const resolved = resolveInput(qualified_name, project, ctx.graphDbPath);
  if (resolved.kind === "none") return { kind: "none" };
  if (resolved.kind === "multi") {
    return { kind: "multi", candidates: resolved.candidates, total: resolved.total };
  }
  const node = getNodeById(ctx.store, project, resolved.symbol.id);
  return node ? { kind: "single", node } : { kind: "none" };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function recentCommits(repoPath: string, filePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-n", String(CAP_COMMITS), "--format=%h %s (%ad)", "--date=short", "--", filePath],
      { cwd: repoPath, timeout: 5000 },
    );
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export function sectionHeader(label: string, shown: number, total: number): string {
  return total > shown ? `## ${label} (showing ${shown} of ${total})` : `## ${label} (${total})`;
}

export async function buildContextPack(ctx: RepoContext, qualified_name: string) {
  const project = projectFromCtx(ctx);
  if (!project) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }

  const resolved = resolveNode(ctx, project, qualified_name);
  if (resolved.kind === "none") return empty(`context_pack(${qualified_name})`, symbolMissHint());
  if (resolved.kind === "multi") {
    return errorResponse("ambiguous_input", ambiguousInputMessage(qualified_name, resolved));
  }

  const node = resolved.node;

  const snippetRes = await readSnippet(ctx, project, node);
  const snippetText = snippetRes.isError ? "(unavailable)" : snippetRes.content[0]?.text ?? "(unavailable)";

  // Callers and callees of THIS node, by id. Deriving a bare name from its qn
  // and tracing that once handed back a same-named sibling's edges — another
  // app's caller, three callees the symbol never calls.
  const callers = safe(
    () => tracePath(ctx.store, project, { node_id: node.id, mode: "callers", max_depth: 1 }),
    [] as Array<{ node: IndexerNode; depth: number }>,
  );
  const callees = safe(
    () => tracePath(ctx.store, project, { node_id: node.id, mode: "calls", max_depth: 1 }),
    [] as Array<{ node: IndexerNode; depth: number }>,
  );

  const decisions = safe(
    () => new DecisionSearch(ctx.decisionsRepo, ctx.decisionLinksRepo).findGoverning(node.file_path || node.qualified_name),
    [] as Array<{ id: string; title: string }>,
  );

  const commits = await recentCommits(ctx.repoPath, node.file_path);

  const fmtNode = (r: { node: IndexerNode }) =>
    `- ${denormalize(r.node.qualified_name, r.node.file_path)}  (${r.node.file_path}:${r.node.start_line})`;

  const sections: string[] = [];
  sections.push(`## SNIPPET\n${snippetText}`);

  const callersShown = callers.slice(0, CAP_CALLERS);
  sections.push(
    `${sectionHeader("CALLERS", callersShown.length, callers.length)}\n${callersShown.map(fmtNode).join("\n") || "- (none)"}`,
  );

  const calleesShown = callees.slice(0, CAP_CALLEES);
  sections.push(
    `${sectionHeader("CALLEES", calleesShown.length, callees.length)}\n${calleesShown.map(fmtNode).join("\n") || "- (none)"}`,
  );

  const decShown = decisions.slice(0, CAP_DECISIONS);
  sections.push(
    `${sectionHeader("GOVERNING DECISIONS", decShown.length, decisions.length)}\n${decShown.map((d) => `- ${d.id}: ${d.title}`).join("\n") || "- (none)"}`,
  );

  if (commits === null) {
    sections.push("## RECENT COMMITS\n(unavailable)");
  } else {
    const commitsShown = commits.slice(0, CAP_COMMITS);
    sections.push(
      `${sectionHeader("RECENT COMMITS", commitsShown.length, commits.length)}\n${commitsShown.map((c) => `- ${c}`).join("\n") || "- (none)"}`,
    );
  }

  return ok(sections.join("\n\n"));
}

export function registerContextPackTool(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "context_pack",
    "Get a full context bundle for a symbol in ONE call: source snippet, direct callers, direct callees, governing decisions, and recent commits. Composes get_code_snippet + trace_path + why_was_this_built. Input accepts the path::Name form other tools print, a qualified name, file path, dotted suffix, or bare name; returns ambiguous_input with candidates if multiple symbols match.",
    contextPackShape,
    registerTool(
      "context_pack",
      contextPackSchema,
      async (ctx, args) => buildContextPack(ctx, args.qualified_name),
      { resolver, freshnessAware: true },
    ),
  );
}
