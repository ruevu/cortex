import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { release } from "node:os";
import { CORTEX_INDEXER_VERSION, indexerAssetName, prebuiltNeedsNewerMacOS } from "./version.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const execFileAsync = promisify(execFile);

/** Bundled location written by the fetcher / legacy build: <repo>/bin/cortex-indexer. */
export const LOCAL_INDEXER = join(__dirname, "..", "..", "bin", "cortex-indexer");

/**
 * Resolve the indexer binary path. `CORTEX_INDEXER_PATH` is the sole override
 * (dev workflow: point at a locally built binary). No legacy alias is consulted.
 */
export function resolveIndexerBinary(): string {
  return process.env.CORTEX_INDEXER_PATH || LOCAL_INDEXER;
}

/**
 * What a missing binary means on this platform: a prebuilt one was expected,
 * none is published, or the Mac is older than the macOS 14 the prebuilt
 * binaries need (the fetcher skips the download there).
 */
export function indexerPlatformNote(platform: string, arch: string, osRelease: string): string {
  if (!indexerAssetName(platform, arch)) {
    return `No prebuilt binary is published for ${platform}-${arch}; build cortex-indexer from source.`;
  }
  if (prebuiltNeedsNewerMacOS(platform, osRelease)) {
    return `The prebuilt binary needs macOS 14 or later; build cortex-indexer from source.`;
  }
  return `Expected a prebuilt binary for ${platform}-${arch}.`;
}

/**
 * The error for a binary that exists but fails to run `--version`. Below
 * macOS 14 that is the deployment target, not corruption, and reinstalling
 * would fetch the same binary again, so the message names the requirement.
 */
export function indexerRunFailureMessage(
  detail: string,
  platform: string = process.platform,
  osRelease: string = release(),
): string {
  if (prebuiltNeedsNewerMacOS(platform, osRelease)) {
    return (
      `cortex-indexer --version failed (${detail}). The prebuilt cortex-indexer needs ` +
      `macOS 14 or later; build it from source and set CORTEX_INDEXER_PATH to the binary.`
    );
  }
  return (
    `cortex-indexer --version failed (${detail}). The binary may be corrupt; ` +
    `run \`npm run fetch-indexer\` to reinstall the pinned version.`
  );
}

export class IndexerNotInstalledError extends Error {
  constructor(binaryPath: string) {
    const platformNote = indexerPlatformNote(process.platform, process.arch, release());
    super(
      `cortex-indexer not found at ${binaryPath}. ${platformNote} ` +
      `Run \`npm run fetch-indexer\`, or build it from the cortex-indexer repo and set CORTEX_INDEXER_PATH to the binary.`,
    );
    this.name = "IndexerNotInstalledError";
  }
}

export class IndexerVersionMismatchError extends Error {
  constructor(found: string, expected: string) {
    super(
      `cortex-indexer version mismatch: binary reports ${found}, cortex expects ${expected}. ` +
      `Run \`npm run fetch-indexer\` to install the pinned version, then reindex.`,
    );
    this.name = "IndexerVersionMismatchError";
  }
}

type EnsureOpts = {
  /** Bypass the resolve+verify cache (tests). */
  noCache?: boolean;
  /** Explicit binary path, bypassing resolveIndexerBinary (tests). */
  binaryPath?: string;
  /** Force the version assertion even without an env override (tests). */
  assertVersion?: boolean;
};

let cachedPath: string | undefined;

/**
 * Resolve, verify presence, and (unless overridden) assert the version of the
 * indexer binary. Lazy + cached: the `--version` exec runs at most once per
 * process. When CORTEX_INDEXER_PATH is set the version assertion is skipped so
 * local dev can run a freshly built binary.
 */
export async function ensureIndexer(opts: EnsureOpts = {}): Promise<string> {
  if (!opts.noCache && cachedPath) return cachedPath;

  const usingOverride = !!process.env.CORTEX_INDEXER_PATH && !opts.binaryPath;
  const binary = opts.binaryPath ?? resolveIndexerBinary();

  try {
    accessSync(binary, fsConstants.X_OK);
  } catch {
    throw new IndexerNotInstalledError(binary);
  }

  const shouldAssert = opts.assertVersion || !usingOverride;
  if (shouldAssert) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 }));
    } catch (e) {
      // The binary exists (accessSync passed) but failed to RUN --version:
      // spawn error, non-zero exit, or timeout. That's a broken binary, not a
      // legacy one — surface it rather than silently tolerating.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(indexerRunFailureMessage(msg));
    }
    let reported: string | undefined;
    try {
      reported = (JSON.parse(stdout) as { version?: string }).version;
    } catch {
      reported = undefined; // non-JSON --version: a legacy/plaintext binary — tolerated.
    }
    if (reported && reported !== CORTEX_INDEXER_VERSION) {
      throw new IndexerVersionMismatchError(reported, CORTEX_INDEXER_VERSION);
    }
  }

  if (!opts.noCache) cachedPath = binary;
  return binary;
}
