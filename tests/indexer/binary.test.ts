import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  resolveIndexerBinary,
  ensureIndexer,
  indexerRunFailureMessage,
  indexerPlatformNote,
  IndexerNotInstalledError,
  IndexerVersionMismatchError,
} from "../../src/indexer/binary.js";
import { CORTEX_INDEXER_VERSION } from "../../src/indexer/version.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG = process.env.CORTEX_INDEXER_PATH;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CORTEX_INDEXER_PATH;
  else process.env.CORTEX_INDEXER_PATH = ORIG;
});

const tmpDirs: string[] = [];
/** mkdtemp that records the dir for afterAll cleanup. */
function trackedTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

describe("resolveIndexerBinary", () => {
  it("honors CORTEX_INDEXER_PATH override", () => {
    process.env.CORTEX_INDEXER_PATH = "/custom/indexer";
    expect(resolveIndexerBinary()).toBe("/custom/indexer");
  });

  it("falls back to the bundled bin/cortex-indexer path", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    expect(resolveIndexerBinary()).toMatch(/[/\\]bin[/\\]cortex-indexer$/);
  });

  it("ignores env vars other than CORTEX_INDEXER_PATH and falls back to bundled path", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    process.env.SOME_UNRELATED_INDEXER_PATH = "/should/be/ignored";
    try {
      const resolved = resolveIndexerBinary();
      expect(resolved).not.toBe("/should/be/ignored");
      expect(resolved).toMatch(/[/\\]bin[/\\]cortex-indexer$/);
    } finally {
      delete process.env.SOME_UNRELATED_INDEXER_PATH;
    }
  });
});

/** Write a fake indexer that prints the given JSON for `--version`. */
function fakeIndexer(versionJson: object): string {
  const dir = trackedTmp("fake-indexer-");
  const bin = join(dir, "cortex-indexer");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo '${JSON.stringify(versionJson)}'; fi\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Write a fake indexer that prints non-JSON garbage for `--version`. */
function fakeLegacyIndexer(): string {
  const dir = trackedTmp("fake-legacy-");
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo 'legacy-indexer version 0.5 (plaintext, not JSON)'; fi\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Write a fake indexer that crashes (exit 1) on `--version`. */
function fakeBrokenIndexer(): string {
  const dir = trackedTmp("fake-broken-");
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "boom" >&2; exit 1; fi\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("ensureIndexer", () => {
  afterEach(() => { delete process.env.CORTEX_INDEXER_PATH; });

  it("returns the path when version matches the pin", async () => {
    const bin = fakeIndexer({ version: CORTEX_INDEXER_VERSION, schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });

  it("throws IndexerNotInstalledError when the binary is absent", async () => {
    process.env.CORTEX_INDEXER_PATH = "/nonexistent/cortex-indexer";
    await expect(ensureIndexer({ noCache: true })).rejects.toBeInstanceOf(IndexerNotInstalledError);
  });

  it("throws IndexerVersionMismatchError on a version mismatch (default path)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true }))
      .rejects.toBeInstanceOf(IndexerVersionMismatchError);
  });

  it("skips the version assertion when CORTEX_INDEXER_PATH is set (dev override)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });

  it("treats a non-JSON --version as a legacy binary and does not throw", async () => {
    const bin = fakeLegacyIndexer();
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true })).resolves.toBe(bin);
  });

  it("surfaces an error when --version fails to run (non-zero exit), not treated as legacy", async () => {
    const bin = fakeBrokenIndexer();
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true })).rejects.toThrow();
  });

  it("throws IndexerNotInstalledError when the binary exists but is not executable", async () => {
    const dir = trackedTmp("noexec-");
    const bin = join(dir, "cortex-indexer");
    writeFileSync(bin, "not executable\n");
    chmodSync(bin, 0o644);
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true }))
      .rejects.toBeInstanceOf(IndexerNotInstalledError);
  });

  it("returns the cached path on the second call without re-checking (cache hit)", async () => {
    const bin = fakeIndexer({ version: CORTEX_INDEXER_VERSION, schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    // First call (caching enabled) populates the module cache.
    const first = await ensureIndexer();
    expect(first).toBe(bin);
    // Point the env elsewhere; a cache HIT must ignore it and return the cached path.
    process.env.CORTEX_INDEXER_PATH = "/nonexistent/changed-indexer";
    const second = await ensureIndexer();
    expect(second).toBe(bin);
  });
});

describe("indexerRunFailureMessage", () => {
  // A binary built for macOS 14 cannot start on 13; "reinstall" fetches the
  // same binary again, so the message must name the real requirement.
  it("names the macOS 14 requirement below Darwin 23, not corruption", () => {
    const msg = indexerRunFailureMessage("spawn Unknown system error -86", "darwin", "22.6.0");
    expect(msg).toMatch(/macOS 14 or later/);
    expect(msg).toMatch(/CORTEX_INDEXER_PATH/);
    expect(msg).not.toMatch(/corrupt/);
  });

  it("keeps the reinstall advice where the prebuilt binary is supported", () => {
    for (const [platform, release] of [["darwin", "25.6.0"], ["linux", "6.1.0"]]) {
      const msg = indexerRunFailureMessage("exit 1", platform, release);
      expect(msg).toMatch(/may be corrupt/);
      expect(msg).toMatch(/npm run fetch-indexer/);
    }
  });
});

describe("indexerPlatformNote", () => {
  it("says the prebuilt binary needs macOS 14 when the fetcher refused an older Mac", () => {
    expect(indexerPlatformNote("darwin", "x64", "22.6.0")).toMatch(/needs macOS 14 or later/);
  });

  it("expects the prebuilt binary on a supported platform", () => {
    expect(indexerPlatformNote("darwin", "x64", "24.0.0")).toMatch(/Expected a prebuilt binary for darwin-x64/);
  });

  it("points at a source build where nothing is published", () => {
    expect(indexerPlatformNote("win32", "x64", "10.0.22631")).toMatch(/No prebuilt binary is published for win32-x64/);
  });
});
