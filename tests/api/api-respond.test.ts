import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { respond, type RespondCtx } from "../../src/mcp-server/api-respond.js";

// Minimal ServerResponse fake.
function fakeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    writeHead(code: number, h?: Record<string, string>) { this.statusCode = code; Object.assign(this.headers, h ?? {}); return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
    end(chunk?: string) { if (chunk) this.body += chunk; this.ended = true; },
  };
}
const Schema = z.object({ version: z.literal(1), ok: z.literal(true) });
const baseCtx = (over: Partial<RespondCtx> = {}): RespondCtx => ({
  req: { headers: {} } as any,
  freshness: { state: "fresh" },
  etag: '"1:cortex:abc"',
  ...over,
});

describe("respond", () => {
  it("writes 200 with body + version/etag/freshness headers", () => {
    const res = fakeRes();
    respond(res as any, Schema, { version: 1, ok: true }, baseCtx());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ version: 1, ok: true });
    expect(res.headers["X-Cortex-API-Version"]).toBe("1");
    expect(res.headers["X-Cortex-Freshness"]).toBe("fresh");
    expect(res.headers["ETag"]).toBe('"1:cortex:abc"');
    expect(res.headers["Content-Type"]).toBe("application/json");
  });

  // The ETag is the INDEX baseline, so a cached consumer gets a bodiless 304
  // and would never observe drift changing — drift moves on a `git fetch`,
  // which republishes nothing. Freshness escapes that via its header; source
  // drift needs the same escape or the response field is unreachable in
  // exactly the polling case Mesh uses.
  it("stamps X-Cortex-Source-Drift, and it SURVIVES a 304", () => {
    const drift = { state: "behind" as const, base_ref: "origin/main", commits_behind: 18 };

    const ok = fakeRes();
    respond(ok as any, Schema, { version: 1, ok: true }, baseCtx({ sourceDrift: drift }));
    expect(ok.headers["X-Cortex-Source-Drift"]).toBe("behind");

    const notModified = fakeRes();
    respond(notModified as any, Schema, { version: 1, ok: true }, baseCtx({
      sourceDrift: drift,
      req: { headers: { "if-none-match": '"1:cortex:abc"' } } as any,
    }));
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers["X-Cortex-Source-Drift"]).toBe("behind");
  });

  it("omits the source-drift header entirely when there is no verdict", () => {
    const res = fakeRes();
    respond(res as any, Schema, { version: 1, ok: true }, baseCtx());
    expect(res.headers["X-Cortex-Source-Drift"]).toBeUndefined();
  });

  it("emits 304 with no body when If-None-Match matches the ETag", () => {
    const res = fakeRes();
    const ctx = baseCtx({ req: { headers: { "if-none-match": '"1:cortex:abc"' } } as any });
    respond(res as any, Schema, { version: 1, ok: true }, ctx);
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
    expect(res.headers["ETag"]).toBe('"1:cortex:abc"');
  });

  it("throws on a schema mismatch under test (strict)", () => {
    const res = fakeRes();
    expect(() => respond(res as any, Schema, { version: 2, ok: true } as any, baseCtx())).toThrow();
  });

  it("logs + sends on mismatch when not strict", () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond(res as any, Schema, { version: 2, ok: true } as any, baseCtx({ strict: false }));
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("sends NO body for a HEAD request but still stamps headers", () => {
    const res = fakeRes();
    const ctx = baseCtx({ req: { method: "HEAD", headers: {} } as any });
    respond(res as any, Schema, { version: 1, ok: true }, ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["ETag"]).toBe('"1:cortex:abc"');
    expect(res.headers["Content-Type"]).toBe("application/json");
  });
});
