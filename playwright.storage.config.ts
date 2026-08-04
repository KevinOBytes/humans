import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "output/playwright/storage-upload",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 30_000,
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
});
