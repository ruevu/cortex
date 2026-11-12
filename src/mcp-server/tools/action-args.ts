import type { z } from "zod";
import { error as errorResponse } from "../response.js";

/**
 * Per-action argument check for the consolidated, action-dispatched MCP tools
 * (`decision`, `pr`).
 *
 * A dispatcher registers ONE superset shape with the MCP SDK, in which every
 * field except `action` is optional — it has to be, since no single field is
 * required by all actions. That superset parse therefore enforces types but
 * never any action's own required fields. Before this check existed (T-0a40),
 * the dispatchers forwarded the superset-parsed args straight to each
 * `*Action` function, whose `z.infer<…>` parameter type was a compile-time
 * promise nothing kept at runtime: `create` without `description`, `get`
 * without `id`, `merge` without `pr_number` all ran with `undefined`s.
 *
 * Validation only — the caller forwards its ORIGINAL args on success, not the
 * parsed result. The per-action schemas strip unknown keys, and several
 * actions consume fields their own shape does not list (e.g. `create` passes
 * `author`/`provenance` through to the service). Forwarding the parsed result
 * would silently drop those; forwarding the original keeps every well-formed
 * call behaving exactly as it did, and only refuses malformed ones.
 *
 * @param tool    tool name for the message (`"decision"`, `"pr"`)
 * @param action  the dispatched action, named in the message
 * @param schema  that action's own Zod schema
 * @param args    the superset-parsed args
 * @returns `null` when the args satisfy the schema, otherwise a
 *          `malformed_input` error response naming every offending field
 */
export function checkActionArgs(
  tool: string,
  action: string,
  schema: z.ZodTypeAny,
  args: unknown,
) {
  const parsed = schema.safeParse(args);
  if (parsed.success) return null;
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(args)"}: ${issue.message}`)
    .join("; ");
  return errorResponse("malformed_input", `${tool} action '${action}': ${problems}`);
}
