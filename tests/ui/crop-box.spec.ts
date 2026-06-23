// tests/ui/crop-box.spec.ts — drives the Phase 4 crop box headless (INI-091).
// Mounts the overlay over a synthetic landscape source with a portrait target and
// verifies: (1) a centred native crop is drawn, (2) dragging the body MOVES the
// crop (pan changes, scale fixed), (3) dragging a corner ZOOMS it (scale > 1),
// (4) reset-to-proposal restores the centred model.
import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    __crop: {
      getModel(): { scale: number; pan_x: number; pan_y: number };
      resetToProposal(): void;
    };
    __lastModel: { scale: number; pan_x: number; pan_y: number };
    __changes: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui/cropbox-harness.html");
  await page.waitForFunction(() => !!window.__crop);
  await expect(page.locator(".cropbox__rect")).toBeVisible();
});

test("draws a centred native crop", async ({ page }) => {
  const m = await page.evaluate(() => window.__crop.getModel());
  expect(m.scale).toBeCloseTo(1.0, 5);
  expect(m.pan_x).toBeCloseTo(0.5, 2);
  expect(m.pan_y).toBeCloseTo(0.5, 2);
  await page.screenshot({ path: "test-results/crop-box-initial.png" });
});

test("dragging the body moves the crop (pan changes, scale fixed)", async ({ page }) => {
  const box = await page.locator(".cropbox__rect").boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy, { steps: 8 });
  await page.mouse.up();

  const m = await page.evaluate(() => window.__lastModel);
  expect(await page.evaluate(() => window.__changes)).toBeGreaterThan(0);
  // Moving left in display space reduces pan_x; scale stays at the native 1.0.
  expect(m.pan_x).toBeLessThan(0.5);
  expect(m.scale).toBeCloseTo(1.0, 5);
  await page.screenshot({ path: "test-results/crop-box-moved.png" });
});

test("dragging a corner inward zooms in (scale > 1)", async ({ page }) => {
  const handle = page.locator(".cropbox__handle--se");
  const hb = await handle.boundingBox();
  expect(hb).not.toBeNull();
  const hx = hb!.x + hb!.width / 2;
  const hy = hb!.y + hb!.height / 2;

  await page.mouse.move(hx, hy);
  await page.mouse.down();
  // Drag the SE corner toward the centre → smaller crop → punch-in.
  await page.mouse.move(hx - 80, hy - 80, { steps: 10 });
  await page.mouse.up();

  const m = await page.evaluate(() => window.__lastModel);
  expect(m.scale).toBeGreaterThan(1.0);
  await page.screenshot({ path: "test-results/crop-box-zoomed.png" });
});

test("reset-to-proposal restores the centred model", async ({ page }) => {
  // Move first.
  const box = await page.locator(".cropbox__rect").boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 50, cy - 30, { steps: 6 });
  await page.mouse.up();
  expect((await page.evaluate(() => window.__lastModel)).pan_x).not.toBeCloseTo(0.5, 2);

  await page.evaluate(() => window.__crop.resetToProposal());
  const m = await page.evaluate(() => window.__lastModel);
  expect(m.scale).toBeCloseTo(1.0, 5);
  expect(m.pan_x).toBeCloseTo(0.5, 2);
  expect(m.pan_y).toBeCloseTo(0.5, 2);
});
