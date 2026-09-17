/**
 * Font stylesheets load with `media="print"` so an unreachable font host can
 * never stall first paint, then swap to `media="all"` once they arrive.
 *
 * That swap used to be an inline `onload="this.media='all'"` attribute, which
 * the server's `script-src 'self'` CSP blocks — so the swap never ran and the
 * viewer silently rendered in fallback fonts on every load (T-aap4). Doing it
 * from the bundle keeps the non-blocking behaviour without an inline handler.
 */

/** The slice of HTMLLinkElement this needs — keeps it testable without a DOM. */
export interface SwappableFontLink {
  media: string;
  /** Non-null once the stylesheet has loaded and parsed, whatever its media. */
  sheet: unknown;
  addEventListener(
    type: "load",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
}

/**
 * Promote each print-media font stylesheet to `all` — immediately if it has
 * already loaded (the listener would never fire), otherwise on its load event.
 */
export function activateFontStylesheets(links: Iterable<SwappableFontLink>): void {
  for (const link of links) {
    if (link.sheet) {
      link.media = "all";
      continue;
    }
    link.addEventListener("load", () => { link.media = "all"; }, { once: true });
  }
}

/** Selector for the links index.html marks as deferred font stylesheets. */
export const FONT_LINK_SELECTOR = "link[data-font-stylesheet]";
