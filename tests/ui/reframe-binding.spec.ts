// tests/ui/reframe-binding.spec.ts — drives the INI-091 Phase 4 previewer crop-mode
// + two-way form binding headless. Mounts the real previewer in crop mode over an
// injected synthetic source and the real binding over the real store, then verifies:
//   (1) the overlay appears as soon as the (injected) source is defined, and the live
//       readout reflects the target resolved from the form's aspect/resolution;
//   (2) dragging the box writes the reframe.propose.{scale,pan_x,pan_y} knobs and
//       fires the form-refresh hook (box -> form);
//   (3) editing a knob + syncing pushes it into the box (form -> box);
//   (4) the reset-to-proposal control restores the centred proposal.
import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    __crop: {
      getModel(): { scale: number; pan_x: number; pan_y: number };
      setModel(m: { scale: number; pan_x: number; pan_y: number }): void;
    };
    __binding: { syncModelFromForm(): void };
    __store: { getFormValue(k: string): unknown; setFormValue(k: string, v: unknown): void };
    __written: { scale: number; pan_x: number; pan_y: number }[];
    __knob: (k: string) => unknown;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui/reframe-binding-harness.html");
  await page.waitForFunction(() => !!window.__crop);
  await expect(page.locator(".cropbox__rect")).toBeVisible();
});

test("overlay appears and the readout reflects the form-resolved target", async ({ page }) => {
  // 4K source, full-portrait + Auto -> native crop 1216×2160, Auto picks 1080×1920.
  await expect(page.locator(".previewer")).toHaveClass(/previewer--cropmode/);
  await expect(page.locator(".cropbox__readout")).toContainText("1080×1920");
  await page.screenshot({ path: "test-results/reframe-binding-initial.png" });
});

test("dragging the box writes the form knobs and fires the refresh hook", async ({ page }) => {
  const box = await page.locator(".cropbox__rect").boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 50, cy, { steps: 8 });
  await page.mouse.up();

  // box -> form: the store knobs now hold the dragged model (pan_x moved left).
  const panX = await page.evaluate(() => Number(window.__knob("pan_x")));
  const scale = await page.evaluate(() => Number(window.__knob("scale")));
  expect(panX).toBeLessThan(0.5);
  expect(scale).toBeCloseTo(1.0, 5);
  // the form-refresh hook fired (onModelWritten recorded at least one model).
  expect(await page.evaluate(() => window.__written.length)).toBeGreaterThan(0);
  // and the recorded knob matches what the box reports.
  const model = await page.evaluate(() => window.__crop.getModel());
  expect(model.pan_x).toBeCloseTo(panX, 6);
});

test("editing a knob pushes it into the box (form -> box)", async ({ page }) => {
  await page.evaluate(() => {
    window.__store.setFormValue("reframe.propose.pan_x", 0.2);
    window.__binding.syncModelFromForm();
  });
  const model = await page.evaluate(() => window.__crop.getModel());
  expect(model.pan_x).toBeCloseTo(0.2, 2);
});

test("reset-to-proposal restores the centred model", async ({ page }) => {
  // Move first.
  const box = await page.locator(".cropbox__rect").boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy - 20, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => Number(window.__knob("pan_x")))).not.toBeCloseTo(0.5, 2);

  // Click the previewer's reset control (wired through to crop.resetToProposal()).
  await page.locator(".previewer__resetcrop").click();
  const model = await page.evaluate(() => window.__crop.getModel());
  expect(model.scale).toBeCloseTo(1.0, 5);
  expect(model.pan_x).toBeCloseTo(0.5, 2);
  expect(model.pan_y).toBeCloseTo(0.5, 2);
  // box -> form propagated the reset back to the knobs too.
  expect(await page.evaluate(() => Number(window.__knob("pan_x")))).toBeCloseTo(0.5, 2);
});
