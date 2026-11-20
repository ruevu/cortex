import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["./tests/mcp-contract/globalSetup.ts"],
    env: {
      // Indexing provisions the frames venv on demand (ensureVenv). A test
      // suite must not spend minutes and a network doing that, and on a
      // machine without a venv it turned every index-path test into a
      // timeout. Tests that exercise provisioning delete this themselves.
      CORTEX_FRAMES_SETUP: "0",
      // Mesh exports CORTEX_BIN (its bundled sidecar CLI) into every agent
      // shell, and the hooks honour it ahead of everything else
      // (hooks/lib/resolve-cortex-bin.sh). Inherited, it would route every
      // hook test that spreads process.env into the real sidecar instead of
      // the test's stub. Empty reads as unset; tests that need it set it.
      CORTEX_BIN: "",
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Survey corpus checkouts under .tmp/frame-extraction/corpus/ carry
      // their own test suites which vitest must not pick up.
      "**/.tmp/**",
      // Same hazard, second location: the eval harness clones its corpus
      // targets into evals/.cache/<target>/src/ (evals/src/paths.ts). Those
      // are whole third-party repos — elk, vueuse, trpc — carrying hundreds of
      // their own tests that fail here for want of their own dependencies.
      // Without this, `npm test` breaks for anyone who has ever run the
      // corpus, and the breakage looks like 400 failing files rather than a
      // missing exclusion. evals/cache/ is where clones lived before 2.4.11;
      // checkouts that ran the eval then still have them.
      "**/evals/.cache/**",
      "**/evals/cache/**",
    ],
  },
});
