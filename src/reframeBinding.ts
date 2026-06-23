/**
 * reframeBinding.ts — the two-way binding between the draggable crop box and the
 * `reframe.propose` form knobs (INI-091 Phase 4 integration).
 *
 * The framing model `{scale, pan_x, pan_y}` is the single source of truth (see
 * reframeBox.ts). This module keeps the two *editors* of that model in lockstep:
 *
 *   - **box -> form:** every constrained change the user makes by dragging the box
 *     (`crop.onChange`) is written to the form values `reframe.propose.{scale,pan_x,
 *     pan_y}` and surfaced to the host via `onModelWritten` so it can refresh the
 *     visible inputs.
 *   - **form -> box:** when the host detects a knob edit it calls `syncModelFromForm`,
 *     which reads the three knobs and pushes them into the box (`crop.setModel`).
 *     `crop.setModel` re-renders WITHOUT emitting, so this can never feed back into a
 *     loop.
 *
 * The target (`aspect`/`resolution`/`allow_upscale`) is built from the form via
 * `targetFormat.buildCropTarget`, resolved against the source dims the previewer
 * acquires. Resolution/aspect edits call `syncTargetFromForm`.
 *
 * Pure wiring over an injected form bridge — no direct `store` import — so the logic is
 * driven headlessly with a synthetic source + an in-memory bridge (see
 * tests/ui/reframe-binding*).
 */

import type { CropBoxController } from "./cropBox";
import { type FramingModel, makeModel, modelToDict } from "./reframeBox";
import { buildCropTarget, DEFAULT_ASPECT } from "./targetFormat";

/** The slice of the state store this module needs. `store` satisfies it directly. */
export interface FormBridge {
  getFormValue(key: string): unknown;
  setFormValue(key: string, value: unknown): void;
}

export interface ReframeBindingOptions {
  crop: CropBoxController;
  bridge: FormBridge;
  /** Defaults to "reframe.propose". */
  taskId?: string;
  /** Called after the box writes the knobs, so the host can refresh the inputs. */
  onModelWritten?: (model: FramingModel) => void;
}

export interface ReframeBinding {
  /** Record the source's stored dims and rebuild the target (needed for Auto). */
  setSourceDims(srcW: number, srcH: number): void;
  /** Rebuild + apply the target from aspect/resolution/allow_upscale form values. */
  syncTargetFromForm(): void;
  /** Push the form's scale/pan knobs into the box (no emit). */
  syncModelFromForm(): void;
  /** Seed the box + proposal from the form's current model (centred native default). */
  captureProposalFromForm(): void;
  /** Drop the change subscription (box teardown is the controller's own job). */
  destroy(): void;
}

const KNOBS = ["scale", "pan_x", "pan_y"] as const;
const TARGET_KEYS = ["aspect", "resolution", "allow_upscale"] as const;

/** True if a changed "taskId.param" key is one this binding reacts to. */
export function isReframeModelKey(taskId: string, changedKey: string): boolean {
  return KNOBS.some((k) => changedKey === `${taskId}.${k}`);
}
export function isReframeTargetKey(taskId: string, changedKey: string): boolean {
  return TARGET_KEYS.some((k) => changedKey === `${taskId}.${k}`);
}

export function mountReframeBinding(opts: ReframeBindingOptions): ReframeBinding {
  const taskId = opts.taskId ?? "reframe.propose";
  const key = (param: string) => `${taskId}.${param}`;
  let srcW = 0;
  let srcH = 0;
  let live = true;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  function readModelFromForm(): FramingModel {
    // Unset knobs (schema default null) mean a centred native crop.
    return makeModel(
      num(opts.bridge.getFormValue(key("scale")), 1.0),
      num(opts.bridge.getFormValue(key("pan_x")), 0.5),
      num(opts.bridge.getFormValue(key("pan_y")), 0.5),
    );
  }

  function writeModelToForm(model: FramingModel): void {
    const d = modelToDict(model); // rounded to 6dp, matching the engine's reframe.def
    opts.bridge.setFormValue(key("scale"), d.scale);
    opts.bridge.setFormValue(key("pan_x"), d.pan_x);
    opts.bridge.setFormValue(key("pan_y"), d.pan_y);
  }

  function buildTarget() {
    const aspect = String(opts.bridge.getFormValue(key("aspect")) ?? DEFAULT_ASPECT);
    const resolution = String(opts.bridge.getFormValue(key("resolution")) ?? "auto");
    const allowUpscale = Boolean(opts.bridge.getFormValue(key("allow_upscale")));
    return buildCropTarget(aspect, resolution, srcW, srcH, allowUpscale);
  }

  // box -> form. setModel/setTarget never emit, so only genuine drags land here.
  opts.crop.onChange((model) => {
    if (!live) return;
    writeModelToForm(model);
    opts.onModelWritten?.(model);
  });

  return {
    setSourceDims(w, h) {
      srcW = w;
      srcH = h;
      opts.crop.setTarget(buildTarget());
    },
    syncTargetFromForm() {
      opts.crop.setTarget(buildTarget());
    },
    syncModelFromForm() {
      opts.crop.setModel(readModelFromForm());
    },
    captureProposalFromForm() {
      const m = readModelFromForm();
      opts.crop.setProposal(m);
      opts.crop.setModel(m);
    },
    destroy() {
      live = false;
    },
  };
}
