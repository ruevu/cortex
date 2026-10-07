/**
 * The name the CLI tells you to type.
 *
 * Every hint, usage line and example is written as `cortex …`. That is right
 * for the `cortex` on PATH and wrong for a launcher that embeds this CLI under
 * another command — Mesh ships it as `mesh ctx`, where `cortex` is not a
 * command at all. Such a launcher exports CORTEX_PROG_NAME, and {@link brand}
 * rewrites the commands in what the CLI prints to that name.
 *
 * Applied at the sinks — the help/tour/topic renderers, `renderError`, and the
 * handful of direct writes that name a command — rather than at each of the
 * ~300 string literals, so new text written as `cortex …` is covered for free.
 */

export const NAMESPACES = ["code", "decision", "graph", "index", "eval", "todo"];
export const META_COMMANDS = [
  "tour", "help", "install", "setup", "freshness", "reconcile", "staleness", "source-drift", "brief", "doctor",
];

export function progName(): string {
  return process.env.CORTEX_PROG_NAME?.trim() || "cortex";
}

/**
 * `cortex` only where it begins a command: followed by a subcommand the router
 * knows, a flag, or a `<placeholder>`. Prose that names the product — "cortex
 * indexes your codebase", "cortex 2.4.2", "cortex gc: …" — reads the same under
 * any launcher and is left alone, as is `cortex` inside an identifier
 * (`mesh-cortex`, a qualified name). A styled example starts right after an
 * SGR escape, whose trailing `m` would otherwise read as part of a word.
 */
const COMMAND_SHAPED = new RegExp(
  `(?<=^|[^\\w.-]|\\u001b\\[[\\d;]*m)cortex(?= (?:(?:${[...NAMESPACES, ...META_COMMANDS].join("|")})(?![\\w-])|--|<))`,
  "g",
);

export function brand(text: string): string {
  const name = progName();
  return name === "cortex" ? text : text.replace(COMMAND_SHAPED, name);
}
