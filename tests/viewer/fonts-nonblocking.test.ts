import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activateFontStylesheets } from "../../src/viewer/app/fonts.ts";

// Guards against a regression of the fix for: the viewer's Google Fonts
// stylesheet was loaded as a render-blocking <link rel="stylesheet">, so
// first paint hung for tens of seconds whenever fonts.googleapis.com was
// unreachable (broken DNS/network). The viewer must never render-block on
// an external host — see docs/architecture (fonts load async, print-media
// swap trick, noscript fallback).
const indexHtmlPath = join(__dirname, "../../src/viewer/index.html");
const mainTsxPath = join(__dirname, "../../src/viewer/app/main.tsx");

describe("viewer index.html: non-blocking Google Fonts load", () => {
  const html = readFileSync(indexHtmlPath, "utf8");

  it("does not render-block on the fonts.googleapis.com stylesheet", () => {
    // Only the <head>-level link needs to be non-blocking; the <noscript>
    // fallback is intentionally exempt (it only loads when JS is off).
    const [headHtml] = html.split(/<noscript>/);
    const blockingLinkPattern =
      /<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]*rel="stylesheet"[^>]*>/g;
    const blockingMatches = headHtml.match(blockingLinkPattern) ?? [];
    // At least one such (now-async) stylesheet link must be present.
    expect(blockingMatches.length).toBeGreaterThan(0);
    for (const tag of blockingMatches) {
      expect(tag).toMatch(/media="print"/);
      // The swap is marked for the bundle to find, not done inline.
      expect(tag).toMatch(/data-font-stylesheet/);
    }
  });

  // T-aap4: the media swap used to be an inline onload attribute, which the
  // server's `script-src 'self'` CSP blocks. The handler never ran, so the
  // sheet stayed media="print" and the viewer rendered in fallback fonts on
  // every single load — silently, with only a console CSP error to show for
  // it. No inline event handler may come back onto this page.
  it("carries no inline event handler anywhere in the document", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("swaps the font stylesheet media from the bundle instead", () => {
    const main = readFileSync(mainTsxPath, "utf8");
    expect(main).toMatch(/activateFontStylesheets/);
    expect(main).toMatch(/FONT_LINK_SELECTOR/);
  });

  it("provides a <noscript> fallback that still loads the stylesheet", () => {
    const noscriptMatch = html.match(/<noscript>[\s\S]*?<\/noscript>/);
    expect(noscriptMatch).not.toBeNull();
    expect(noscriptMatch![0]).toMatch(
      /<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]+rel="stylesheet"/,
    );
  });

  it("keeps the preconnect hints for fonts.googleapis.com and fonts.gstatic.com", () => {
    expect(html).toMatch(
      /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/,
    );
    expect(html).toMatch(
      /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/,
    );
  });
});

describe("activateFontStylesheets", () => {
  const fakeLink = (sheet: unknown) => {
    const listeners: Array<() => void> = [];
    return {
      media: "print",
      sheet,
      addEventListener: (_t: "load", cb: () => void) => { listeners.push(cb); },
      fire: () => listeners.forEach((cb) => cb()),
      get listenerCount() { return listeners.length; },
    };
  };

  it("promotes an already-loaded sheet immediately", () => {
    const link = fakeLink({});
    activateFontStylesheets([link]);
    expect(link.media).toBe("all");
    // No listener needed — a load event would never fire again.
    expect(link.listenerCount).toBe(0);
  });

  it("defers an in-flight sheet to its load event", () => {
    const link = fakeLink(null);
    activateFontStylesheets([link]);
    // Still non-blocking until the stylesheet actually arrives.
    expect(link.media).toBe("print");
    link.fire();
    expect(link.media).toBe("all");
  });

  it("handles several links, and none at all", () => {
    const loaded = fakeLink({});
    const pending = fakeLink(null);
    activateFontStylesheets([loaded, pending]);
    expect(loaded.media).toBe("all");
    expect(pending.media).toBe("print");
    expect(() => activateFontStylesheets([])).not.toThrow();
  });
});
