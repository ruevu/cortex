import { describe, expect, it } from "vitest";
import {
  CORTEX_INDEXER_VERSION,
  indexerAssetName,
  prebuiltNeedsNewerMacOS,
} from "../../src/indexer/version.js";

describe("indexerAssetName", () => {
  it("maps the four supported targets to tarball names", () => {
    const v = CORTEX_INDEXER_VERSION;
    expect(indexerAssetName("darwin", "arm64")).toBe(`cortex-indexer-${v}-darwin-arm64.tar.gz`);
    expect(indexerAssetName("darwin", "x64")).toBe(`cortex-indexer-${v}-darwin-x64.tar.gz`);
    expect(indexerAssetName("linux", "x64")).toBe(`cortex-indexer-${v}-linux-x64.tar.gz`);
    expect(indexerAssetName("linux", "arm64")).toBe(`cortex-indexer-${v}-linux-arm64.tar.gz`);
  });

  it("returns null for unsupported platform/arch", () => {
    expect(indexerAssetName("win32", "x64")).toBeNull();
    expect(indexerAssetName("linux", "ia32")).toBeNull();
    expect(indexerAssetName("darwin", "ppc64")).toBeNull();
  });

  it("pins an exact semver string", () => {
    expect(CORTEX_INDEXER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("prebuiltNeedsNewerMacOS", () => {
  // Darwin 23 is macOS 14; both macOS binaries are built for 14.0 or later.
  it("is true below macOS 14 (Darwin 23)", () => {
    expect(prebuiltNeedsNewerMacOS("darwin", "22.6.0")).toBe(true);
  });

  it("is false on macOS 14 and later", () => {
    expect(prebuiltNeedsNewerMacOS("darwin", "23.0.0")).toBe(false);
    expect(prebuiltNeedsNewerMacOS("darwin", "25.6.0")).toBe(false);
  });

  it("is false off macOS, and for a release string it cannot read", () => {
    expect(prebuiltNeedsNewerMacOS("linux", "5.15.0")).toBe(false);
    expect(prebuiltNeedsNewerMacOS("darwin", "")).toBe(false);
  });
});
