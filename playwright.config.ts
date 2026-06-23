// playwright.config.ts — headless UI harness for the control-tower frontend.
// SANDBOX-ONLY: runs the app in browser mock-IPC mode (no Tauri) under headless
// Chromium so the previewer / crop-box geometry can be driven + screenshotted
// without the macOS webview. INI-091 Phase 4 autonomous UI proof.
//
// Run (from the Linux dev sandbox):
//   PLAYWRIGHT_BROWSERS_PATH=<cache> LD_LIBRARY_PATH=<xstubs> npx playwright test
// The macOS app is verified separately via `tauri dev` (system WebKit).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/ui",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "off",
    screenshot: "off",
    launchOptions: { args: ["--no-sandbox"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
