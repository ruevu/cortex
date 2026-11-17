/**
 * The exact cortex-indexer release this build of cortex is pinned to.
 * Single source of truth for the fetcher and the runtime version check.
 * Bumping the indexer is an explicit, reviewable cortex commit.
 *
 * NOTE: mirror any change in scripts/fetch-indexer.mjs (drift-guard test in
 * tests/indexer/fetch-indexer.test.ts enforces equality).
 */
export const CORTEX_INDEXER_VERSION = "0.3.5";

/**
 * Supported (platform, arch) targets → release asset basename, else null.
 *
 * Every entry must have a published asset in the pinned release, or that
 * platform downloads a 404 instead of taking the "build from source" path.
 * darwin-x64 is published again from 0.3.4 (built on macos-15-intel); both
 * macOS binaries require macOS 14.0 or later.
 */
const SUPPORTED = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
]);

export function indexerAssetName(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${CORTEX_INDEXER_VERSION}-${key}.tar.gz`;
}

/**
 * Darwin's major version for macOS 14 (Sonoma). Both macOS binaries are built
 * with MACOSX_DEPLOYMENT_TARGET 14.0, so neither can start on anything older.
 *
 * NOTE: mirrored as MIN_DARWIN_MAJOR in scripts/fetch-indexer.mjs (drift-guard
 * test in tests/indexer/fetch-indexer.test.ts).
 */
export const MIN_DARWIN_MAJOR = 23;

/**
 * True on a Mac older than macOS 14, where the prebuilt binary cannot run.
 * `osRelease` is `os.release()` (the Darwin version). A release string that
 * doesn't parse reads as false, so an odd kernel string never blocks a Mac
 * that may well be able to run the binary.
 */
export function prebuiltNeedsNewerMacOS(platform: string, osRelease: string): boolean {
  if (platform !== "darwin") return false;
  const major = Number.parseInt(osRelease, 10);
  return Number.isFinite(major) && major < MIN_DARWIN_MAJOR;
}
