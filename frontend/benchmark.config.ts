import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./bench",
  workers: 1,
  timeout: 240_000,
  use: { browserName: "chromium" },
  reporter: "list",
});
