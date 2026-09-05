import { defineConfig } from "vitest/config";

// Builds the viewer straight into the plugin's resources so it ships inside the jar.
// `base: "./"` keeps asset URLs relative, which is required when JCEF loads the page from a
// custom resource scheme rather than an http origin.
export default defineConfig({
  base: "./",
  // The engine runs in a module worker (src/diff.worker.ts); bundle it as ESM rather than the
  // default IIFE so `new Worker(..., { type: "module" })` gets what it asks for.
  worker: { format: "es" },
  build: {
    outDir: "../src/main/resources/web",
    emptyOutDir: true,
    target: "chrome120", // JCEF ships a recent Chromium; safe to target modern JS.
    sourcemap: true,
  },
  test: {
    setupFiles: ["./src/test-worker.ts"],
    // diff.ts needs DOMParser; happy-dom provides it headlessly (JCEF's real Chromium at runtime).
    environment: "happy-dom",
    // Unit tests only — e2e/ holds Playwright specs (`pnpm run test:e2e`), which vitest's default
    // glob would otherwise try (and fail) to run.
    include: ["src/**/*.test.ts"],
    // The shell sets `frame.src` in several fallback states; happy-dom would otherwise really
    // fetch those `http://localhost:3000/doc/…` URLs and print an AbortError/NetworkError stack
    // per test as the document is torn down. The tests only assert on the src value.
    //
    // `disableChildFrameNavigation` makes the frame set its URL without fetching, which keeps the
    // frame's window (and therefore `contentDocument`, which the redline is written into) alive —
    // `disableIframePageLoading` would refuse to create the child window at all.
    // The corpus documents `<link>` a stylesheet that only exists next to them on disk; happy-dom
    // would fetch that too. Treating the disabled load as success keeps it quiet (nothing here
    // asserts on applied CSS — layout-dependent behaviour is the Playwright suite's job).
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: { disableChildFrameNavigation: true },
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
