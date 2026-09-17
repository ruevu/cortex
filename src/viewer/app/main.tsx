import { createRoot } from "react-dom/client";
import { App } from "./App";
import { activateFontStylesheets, FONT_LINK_SELECTOR } from "./fonts";
import "../style.css";

// Must run from the bundle, not an inline onload attribute — see fonts.ts.
activateFontStylesheets(
  document.querySelectorAll<HTMLLinkElement>(FONT_LINK_SELECTOR),
);

createRoot(document.getElementById("root")!).render(<App />);
