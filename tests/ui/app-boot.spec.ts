// tests/ui/app-boot.spec.ts — baseline UI proof for the headless sandbox loop.
// Confirms the control tower boots in mock-IPC mode (no Tauri), loads the schema
// fixture, and mounts the previewer pane. INI-091 Phase 4.
import { test, expect } from "@playwright/test";

test("app boots in mock mode and mounts the previewer", async ({ page }) => {
  await page.goto("/");

  // Schema loaded via MockIpc → the engine name fills in (placeholder is "—").
  const engine = page.locator("#engine-name");
  await expect(engine).not.toHaveText("—", { timeout: 15_000 });

  // The three-pane shell is present.
  await expect(page.locator(".previewer")).toBeVisible();
  await expect(page.locator("#run-btn")).toBeVisible();

  await page.screenshot({ path: "test-results/app-boot.png", fullPage: false });
});
