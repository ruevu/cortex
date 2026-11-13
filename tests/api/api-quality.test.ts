import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpQualityFor } from "../../src/mcp-server/api-quality.js";
import { QualityReportWireSchema, QualityResponseSchema } from "../../src/mcp-server/api-schemas.js";
import { qualityReportPath, writeQualityReport } from "../../src/quality/report-store.js";
import { Registry } from "../../src/db/registry.js";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { QualityReport } from "../../src/quality/types.js";

const REPORT: QualityReport = {
  version: 1, computed_at: "2026-11-12T10:00:00.000Z", repo_path: "/somewhere/else", indexed_commit: "0123456789abcdef",
  calls: { total: 4097, resolved: 1200, likely: 97, name_guess: 2800, unscored: 0, hub_edges: 300 },
  guess_share: 2800 / 4097, hub_share: 300 / 4097, hub_count: 1,
  suspect_hubs: [{ name: "map", file: "src/util.ts", calls: 300, receivers: 41 }],
  verdict: {
    level: "poor", judged: true, note: null,
    reasons: ["68.3% of call edges are name guesses"],
    advice: "treat callers/callees as hints; confirm with search_code",
  },
};

const tmps: string[] = [];
function repo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cortex-api-quality-")));
  tmps.push(d);
  return d;
}
const registryFor = (root: string) => ({ findByName: (n: string) => (n === "p" ? { root_path: root } : null) });

afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

describe("httpQualityFor", () => {
  beforeEach(() => { vi.stubEnv("CORTEX_QUALITY", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("returns the wire report for a registered project", () => {
    const root = repo();
    writeQualityReport(root, REPORT);
    const wire = httpQualityFor("p", registryFor(root));
    expect(wire).not.toBeNull();
    expect(wire).not.toHaveProperty("version");
    expect(wire).not.toHaveProperty("repo_path");
    expect(QualityReportWireSchema.safeParse(wire).success).toBe(true);
    expect(wire?.verdict.level).toBe("poor");
    expect(wire?.suspect_hubs).toEqual(REPORT.suspect_hubs);
  });

  it("null for an unregistered project", () => {
    const root = repo();
    writeQualityReport(root, REPORT);
    expect(httpQualityFor("other", registryFor(root))).toBeNull();
    expect(httpQualityFor(null, registryFor(root))).toBeNull();
  });

  it("null without a report", () => {
    expect(httpQualityFor("p", registryFor(repo()))).toBeNull();
  });

  it("null when CORTEX_QUALITY=0", () => {
    const root = repo();
    writeQualityReport(root, REPORT);
    vi.stubEnv("CORTEX_QUALITY", "0");
    expect(httpQualityFor("p", registryFor(root))).toBeNull();
  });

  it("null for a report of another version", () => {
    const root = repo();
    mkdirSync(join(root, ".cortex"), { recursive: true });
    writeFileSync(qualityReportPath(root), JSON.stringify({ ...REPORT, version: 2 }));
    expect(httpQualityFor("p", registryFor(root))).toBeNull();
  });

  it("null for a damaged report, never an invalid body", () => {
    const root = repo();
    mkdirSync(join(root, ".cortex"), { recursive: true });
    writeFileSync(qualityReportPath(root), JSON.stringify({ version: 1, calls: "nope" }));
    expect(httpQualityFor("p", registryFor(root))).toBeNull();
  });
});

describe("GET /api/quality", () => {
  let handle: ViewerServerHandle;
  let base: string;
  let store: GraphStore;

  beforeAll(async () => {
    process.env.CORTEX_VIEWER_PORT = "0";
    const dir = repo();
    // Isolate the registry: startViewerServer opens defaultRegistryPath(),
    // which would otherwise be the developer's real one (todo T-zkfx).
    process.env.CORTEX_REGISTRY_DB = join(dir, "registry.db");
    const root = join(dir, "checkout");
    mkdirSync(root);
    writeQualityReport(root, REPORT);
    const reg = new Registry(process.env.CORTEX_REGISTRY_DB);
    reg.register("p", root, "t");
    reg.close();
    store = new GraphStore(join(dir, "db"));
    handle = await startViewerServer(store, null);
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(() => {
    handle?.close();
    store?.close();
    delete process.env.CORTEX_REGISTRY_DB;
  });

  it("serves a registered project's report, without the file-level fields", async () => {
    const r = await fetch(`${base}/api/quality?project=p`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(QualityResponseSchema.safeParse(body).success).toBe(true);
    expect(body.version).toBe(1);
    expect(body.report.verdict.level).toBe("poor");
    expect(body.report).not.toHaveProperty("repo_path");
  });

  it("serves report: null for an unknown project", async () => {
    const body = await (await fetch(`${base}/api/quality?project=nope`)).json();
    expect(body).toEqual({ version: 1, report: null });
  });

  it("revalidates on the index-baseline ETag", async () => {
    const first = await fetch(`${base}/api/quality?project=p`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await fetch(`${base}/api/quality?project=p`, { headers: { "If-None-Match": etag! } });
    expect(again.status).toBe(304);
  });
});
