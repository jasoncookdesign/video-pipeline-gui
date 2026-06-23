/**
 * cropBox.ts — the draggable crop-box overlay (INI-091 Phase 4).
 *
 * DOM layer over the pure geometry in `reframeBox.ts`. It draws the SOURCE at its
 * natural aspect inside a host element and overlays an aspect-locked crop rectangle
 * that the user can MOVE (drag the body) or ZOOM (drag a corner). Every interaction
 * is funnelled back through the canonical geometry (`boxToModel` /
 * `previewRectToModel`) so the box can never disagree with what the renderer will
 * produce — the model `{scale, pan_x, pan_y}` is the single source of truth and the
 * box is always re-rendered FROM the model after each constrained update.
 *
 * The module is presentation-only and side-effect free apart from its host DOM and
 * the `onChange` callback — the composition root wires that callback to the
 * `reframe.propose` form knobs (scale/pan_x/pan_y) for the two-way binding, and
 * pushes knob edits back in via `setModel`.
 *
 * No Tauri, no npm deps; drivable under headless Chromium for the autonomous UI
 * proof (see tests/ui/crop-box.spec.ts).
 */

import {
  type FramingModel,
  type CropGeometry,
  type ResolutionReadout,
  type ZoomClamp,
  type PreviewLayout,
  type RotationDeg,
  Rotation,
  makeModel,
  modelToWindow,
  boxToModel,
  previewRectToModel,
  previewLayout,
  sourceToPreview,
  previewToSource,
  resolutionReadout,
} from "./reframeBox";

export interface CropBoxSource {
  /** Stored (coded) source dimensions. */
  srcW: number;
  srcH: number;
  rotation?: RotationDeg;
}

export interface CropBoxTarget {
  aspectW: number;
  aspectH: number;
  outW: number;
  outH: number;
  allowUpscale?: boolean;
}

export interface CropChangeInfo {
  zoom: ZoomClamp;
  readout: ResolutionReadout;
}

export interface CropBoxController {
  /** Define / clear the source. Clearing hides the overlay. */
  setSource(source: CropBoxSource | null): void;
  /** Set the output target (aspect + resolution + upscale policy). */
  setTarget(target: CropBoxTarget): void;
  /** Knob -> box: set the model and re-render the box. */
  setModel(model: FramingModel): void;
  /** Current constrained model. */
  getModel(): FramingModel;
  /** Remember the proposal (the engine's suggestion) so it can be restored. */
  setProposal(model: FramingModel): void;
  /** Restore the remembered proposal (no-op if none). */
  resetToProposal(): void;
  /** Box -> knob: fired after every constrained model change. */
  onChange(cb: (model: FramingModel, info: CropChangeInfo) => void): void;
  /** Re-fit after the host resizes. */
  relayout(): void;
  /** Tear down listeners + DOM. */
  destroy(): void;
}

const HANDLES = ["nw", "ne", "se", "sw"] as const;
type Handle = (typeof HANDLES)[number];

export function mountCropBox(host: HTMLElement): CropBoxController {
  host.classList.add("cropbox");
  host.innerHTML = `
    <div class="cropbox__frame" hidden>
      <div class="cropbox__mask cropbox__mask--top"></div>
      <div class="cropbox__mask cropbox__mask--bottom"></div>
      <div class="cropbox__mask cropbox__mask--left"></div>
      <div class="cropbox__mask cropbox__mask--right"></div>
      <div class="cropbox__rect" tabindex="0" role="group" aria-label="Crop region">
        <div class="cropbox__thirds" aria-hidden="true"></div>
        ${HANDLES.map((h) => `<div class="cropbox__handle cropbox__handle--${h}" data-handle="${h}"></div>`).join("")}
      </div>
      <div class="cropbox__readout" aria-live="polite"></div>
    </div>
  `;

  const frame = host.querySelector<HTMLElement>(".cropbox__frame")!;
  const rect = host.querySelector<HTMLElement>(".cropbox__rect")!;
  const readout = host.querySelector<HTMLElement>(".cropbox__readout")!;
  const maskTop = host.querySelector<HTMLElement>(".cropbox__mask--top")!;
  const maskBottom = host.querySelector<HTMLElement>(".cropbox__mask--bottom")!;
  const maskLeft = host.querySelector<HTMLElement>(".cropbox__mask--left")!;
  const maskRight = host.querySelector<HTMLElement>(".cropbox__mask--right")!;

  let source: CropBoxSource | null = null;
  let target: CropBoxTarget = { aspectW: 9, aspectH: 16, outW: 1080, outH: 1920, allowUpscale: false };
  let model: FramingModel = makeModel();
  let proposal: FramingModel | null = null;
  let changeCb: ((m: FramingModel, info: CropChangeInfo) => void) | null = null;
  let layout: PreviewLayout | null = null;

  // ── layout: contain-fit the source inside the host ─────────────────────────────
  function computeLayout(): PreviewLayout | null {
    if (!source) return null;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w <= 0 || h <= 0) return null;
    return previewLayout(source.srcW, source.srcH, source.rotation ?? Rotation.R0, w, h);
  }

  /** Source-px crop window -> preview-px {left,top,w,h} via the rotation layer. */
  function geomToPreviewRect(geom: CropGeometry, lay: PreviewLayout): {
    left: number; top: number; w: number; h: number;
  } {
    // Map all four corners (rotation may swap/flip axes) and take the AABB.
    const corners: Array<[number, number]> = [
      [geom.x, geom.y],
      [geom.x + geom.w, geom.y],
      [geom.x + geom.w, geom.y + geom.h],
      [geom.x, geom.y + geom.h],
    ];
    const pts = corners.map(([sx, sy]) => sourceToPreview(sx, sy, lay));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return { left, top, w: right - left, h: bottom - top };
  }

  function renderReadout(): void {
    const r = resolutionReadout(
      model.scale, target.outW && source ? source.srcW : 0, source ? source.srcH : 0,
      target.aspectW, target.aspectH, target.outW, target.outH,
    );
    const warn = r.withinTolerance ? "" : ` · upscaling ${r.upscaleFactor.toFixed(2)}×`;
    readout.textContent = `${r.cropNativeW}×${r.cropNativeH} src → ${r.outW}×${r.outH} out${warn}`;
    readout.classList.toggle("cropbox__readout--warn", !r.withinTolerance);
  }

  /** Re-draw the box + masks from the current model. Pure render (no emit). */
  function render(): void {
    layout = computeLayout();
    if (!source || !layout) {
      frame.hidden = true;
      return;
    }
    frame.hidden = false;
    // Position the drawn-source frame inside the host (letterbox padding).
    frame.style.left = `${layout.offsetX}px`;
    frame.style.top = `${layout.offsetY}px`;
    frame.style.width = `${layout.drawnW}px`;
    frame.style.height = `${layout.drawnH}px`;

    const geom = modelToWindow(model, source.srcW, source.srcH, target.aspectW, target.aspectH);
    const pr = geomToPreviewRect(geom, layout);
    // Box position is relative to the frame, not the host.
    const bx = pr.left - layout.offsetX;
    const by = pr.top - layout.offsetY;
    rect.style.left = `${bx}px`;
    rect.style.top = `${by}px`;
    rect.style.width = `${pr.w}px`;
    rect.style.height = `${pr.h}px`;

    // Masks dim everything outside the box (relative to the frame).
    const fw = layout.drawnW;
    const fh = layout.drawnH;
    maskTop.style.cssText = `left:0;top:0;width:${fw}px;height:${Math.max(0, by)}px`;
    maskBottom.style.cssText = `left:0;top:${by + pr.h}px;width:${fw}px;height:${Math.max(0, fh - by - pr.h)}px`;
    maskLeft.style.cssText = `left:0;top:${by}px;width:${Math.max(0, bx)}px;height:${pr.h}px`;
    maskRight.style.cssText = `left:${bx + pr.w}px;top:${by}px;width:${Math.max(0, fw - bx - pr.w)}px;height:${pr.h}px`;

    renderReadout();
  }

  /** Apply a constrained model from a geometry result, re-render, and emit. */
  function commit(result: { model: FramingModel; zoom: ZoomClamp }): void {
    model = result.model;
    render();
    if (changeCb) {
      const readoutInfo = resolutionReadout(
        model.scale, source!.srcW, source!.srcH,
        target.aspectW, target.aspectH, target.outW, target.outH,
      );
      changeCb(model, { zoom: result.zoom, readout: readoutInfo });
    }
  }

  // ── pointer interaction ────────────────────────────────────────────────────────
  // All preview-space math is in HOST coordinates; we convert the host-relative
  // pointer to the absolute preview space the geometry layer expects by adding back
  // the frame offset (the geometry's previewToSource subtracts it again).
  type Drag =
    | { kind: "move"; grabDX: number; grabDY: number; boxW: number; boxH: number }
    | { kind: "resize"; handle: Handle; anchorPX: number; anchorPY: number };
  let drag: Drag | null = null;

  function hostPoint(ev: PointerEvent): [number, number] {
    const r = host.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!source || !layout) return;
    const targetEl = ev.target as HTMLElement;
    const handle = targetEl.dataset.handle as Handle | undefined;
    const [hx, hy] = hostPoint(ev);
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();

    if (handle) {
      // The anchor is the corner diagonally opposite the grabbed one (host px).
      const bx = layout.offsetX + parseFloat(rect.style.left);
      const by = layout.offsetY + parseFloat(rect.style.top);
      const bw = parseFloat(rect.style.width);
      const bh = parseFloat(rect.style.height);
      const anchors: Record<Handle, [number, number]> = {
        nw: [bx + bw, by + bh],
        ne: [bx, by + bh],
        se: [bx, by],
        sw: [bx + bw, by],
      };
      const [ax, ay] = anchors[handle];
      drag = { kind: "resize", handle, anchorPX: ax, anchorPY: ay };
    } else {
      const bx = layout.offsetX + parseFloat(rect.style.left);
      const by = layout.offsetY + parseFloat(rect.style.top);
      drag = {
        kind: "move",
        grabDX: hx - bx,
        grabDY: hy - by,
        boxW: parseFloat(rect.style.width),
        boxH: parseFloat(rect.style.height),
      };
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!drag || !source || !layout) return;
    const [hx, hy] = hostPoint(ev);

    if (drag.kind === "move") {
      // New box centre in host preview px, kept the same size; map to source.
      const cx = hx - drag.grabDX + drag.boxW / 2;
      const cy = hy - drag.grabDY + drag.boxH / 2;
      // Current geom gives the source-space box size to preserve.
      const geom = modelToWindow(model, source.srcW, source.srcH, target.aspectW, target.aspectH);
      const [scx, scy] = previewToSource(cx, cy, layout);
      const result = boxToModel(
        { cx: scx, cy: scy, w: geom.w, h: geom.h },
        source.srcW, source.srcH, target.aspectW, target.aspectH,
        target.outW, target.outH, target.allowUpscale ?? false,
      );
      commit(result);
    } else {
      // Resize: rect from the fixed anchor corner to the pointer (host px).
      const result = previewRectToModel(
        { x0: drag.anchorPX, y0: drag.anchorPY, x1: hx, y1: hy },
        layout, target.aspectW, target.aspectH, target.outW, target.outH,
        target.allowUpscale ?? false,
      );
      commit(result);
    }
  }

  function onPointerUp(): void {
    drag = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }

  // NB: hostPoint() returns host-relative px, which IS the absolute preview space the
  // geometry layer measures offsetX/Y from — so previewToSource(px, py, layout) maps
  // a host pointer straight to stored-source px.

  rect.addEventListener("pointerdown", onPointerDown);

  const ro = new ResizeObserver(() => render());
  ro.observe(host);

  return {
    setSource(s) {
      source = s;
      render();
    },
    setTarget(t) {
      target = { allowUpscale: false, ...t };
      render();
    },
    setModel(m) {
      model = makeModel(m.scale, m.pan_x, m.pan_y);
      render();
    },
    getModel() {
      return model;
    },
    setProposal(m) {
      proposal = makeModel(m.scale, m.pan_x, m.pan_y);
    },
    resetToProposal() {
      if (!proposal || !source) return;
      const geom = modelToWindow(proposal, source.srcW, source.srcH, target.aspectW, target.aspectH);
      const result = boxToModel(
        { cx: geom.x + geom.w / 2, cy: geom.y + geom.h / 2, w: geom.w, h: geom.h },
        source.srcW, source.srcH, target.aspectW, target.aspectH,
        target.outW, target.outH, target.allowUpscale ?? false,
      );
      commit(result);
    },
    onChange(cb) {
      changeCb = cb;
    },
    relayout() {
      render();
    },
    destroy() {
      ro.disconnect();
      rect.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      host.innerHTML = "";
      host.classList.remove("cropbox");
    },
  };
}
