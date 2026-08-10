import { defineConfig } from "@playwright/test";

/**
 * Real-Chromium sandbox-enforcement suite (`pnpm run test:e2e`) — NOT part of the gradle build
 * (needs a downloaded browser: `pnpm exec playwright install chromium`). Everything is served via
 * route interception, so the suite runs fully offline; see e2e/sandbox.spec.ts.
 *
 * Build the viewer first (`pnpm run build`): the specs load the bundled shell from
 * ../src/main/resources/web, the same artifact the plugin ships.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: {
    browserName: "chromium",
  },
});
