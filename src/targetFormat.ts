/**
 * targetFormat.ts — the aspect-preset + resolution-tier tables and the Auto resolver
 * (INI-091 / INI-090), ported faithfully from `video_pipeline/target_format.py`.
 *
 * The crop box needs a concrete `{aspectW, aspectH, outW, outH}` target to drive its
 * aspect-lock, max-zoom and resolution readout. The user picks an *aspect preset* (a
 * shape) and a *resolution selection* (a tier, or Auto) on the reframe form; this
 * module turns that pair — plus the source's native crop size — into the concrete
 * pixel target the renderer will use, mirroring the engine exactly so the GUI box and
 * the Mac-side render never disagree.
 *
 * Pure data + arithmetic: no DOM, no Tauri, no npm deps. The geometry primitive
 * `nativeCropDims` (and `UPSCALE_TOLERANCE`) are imported from `reframeBox.ts`, which
 * already ports the matching `reframe/model.py` math, so the two ports share one
 * source of the tolerance constant rather than drifting.
 */

import { UPSCALE_TOLERANCE, nativeCropDims } from "./reframeBox";
import type { CropBoxTarget } from "./cropBox";

// ── data types (mirror target_format.AspectPreset / ResolutionTarget) ───────────────

/** A named target shape; `w:h` is the reduced integer aspect ratio. */
export interface AspectPreset {
  key: string;
  label: string;
  w: number;
  h: number;
}

/** A concrete render size; `tier` is a ladder key or "exact-fit". */
export interface ResolutionTarget {
  tier: string;
  width: number;
  height: number;
}

// ── canonical tables (CEO-locked spec 2026-06-22, INI-090) ──────────────────────────

/** Resolution ladder, ordered HIGH → LOW so the first tier that fits is the highest. */
export const TIERS: readonly string[] = ["4k", "1440p", "1080p", "720p"];

export const DEFAULT_ASPECT = "full-portrait";
export const DEFAULT_TIER = "1080p";

export const ASPECT_PRESETS: Record<string, AspectPreset> = {
  cinematic: { key: "cinematic", label: "Cinematic widescreen", w: 7, h: 3 },
  widescreen: { key: "widescreen", label: "Widescreen", w: 16, h: 9 },
  "full-portrait": { key: "full-portrait", label: "Full portrait", w: 9, h: 16 },
  portrait: { key: "portrait", label: "Portrait", w: 2, h: 3 },
  "wide-portrait": { key: "wide-portrait", label: "Wide portrait", w: 4, h: 5 },
  square: { key: "square", label: "Square", w: 1, h: 1 },
  "classic-tv": { key: "classic-tv", label: "Classic television", w: 4, h: 3 },
};

/** Per aspect: tier key -> [width, height]. Exact-ratio, even dimensions. */
export const RESOLUTION_MATRIX: Record<string, Record<string, [number, number]>> = {
  cinematic: { "4k": [5040, 2160], "1440p": [3360, 1440], "1080p": [2520, 1080], "720p": [1680, 720] },
  widescreen: { "4k": [3840, 2160], "1440p": [2560, 1440], "1080p": [1920, 1080], "720p": [1280, 720] },
  "full-portrait": { "4k": [2160, 3840], "1440p": [1440, 2560], "1080p": [1080, 1920], "720p": [720, 1280] },
  portrait: { "4k": [1440, 2160], "1440p": [1200, 1800], "1080p": [1000, 1500], "720p": [720, 1080] },
  "wide-portrait": { "4k": [1728, 2160], "1440p": [1152, 1440], "1080p": [1080, 1350], "720p": [576, 720] },
  square: { "4k": [2160, 2160], "1440p": [1440, 1440], "1080p": [1080, 1080], "720p": [720, 720] },
  "classic-tv": { "4k": [2880, 2160], "1440p": [1920, 1440], "1080p": [1440, 1080], "720p": [960, 720] },
};

/** "auto" or a tier key. */
export const RESOLUTION_SELECTIONS: readonly string[] = ["auto", ...TIERS];

// ── accessors (mirror aspect_preset / resolution_target) ────────────────────────────

export function aspectPreset(aspectKey: string): AspectPreset {
  const p = ASPECT_PRESETS[aspectKey];
  if (!p) return ASPECT_PRESETS[DEFAULT_ASPECT];
  return p;
}

export function resolutionTarget(aspectKey: string, tier: string): ResolutionTarget {
  const tiers = RESOLUTION_MATRIX[aspectKey] ?? RESOLUTION_MATRIX[DEFAULT_ASPECT];
  const dims = tiers[tier];
  if (!dims) {
    const fallback = tiers[DEFAULT_TIER];
    return { tier: DEFAULT_TIER, width: fallback[0], height: fallback[1] };
  }
  return { tier, width: dims[0], height: dims[1] };
}

// ── geometry: largest exact-ratio fit (mirror largest_exact_fit) ────────────────────

/** Largest exact-aspect, even-dimensioned box that fits inside crop_w × crop_h. */
export function largestExactFit(
  aspectKey: string,
  cropW: number,
  cropH: number,
): [number, number] {
  const p = aspectPreset(aspectKey);
  let m = Math.min(Math.floor(cropW / p.w), Math.floor(cropH / p.h));
  // w = p.w * m, h = p.h * m is exact ratio for any m; shrink m until both even.
  while (m > 0 && (((p.w * m) % 2) || ((p.h * m) % 2))) m -= 1;
  return [p.w * Math.max(0, m), p.h * Math.max(0, m)];
}

// ── resolver (mirror resolve_auto / resolve) ────────────────────────────────────────

/** Auto: highest tier whose canonical target fits the crop within tolerance upscale. */
export function resolveAuto(
  aspectKey: string,
  cropW: number,
  cropH: number,
  tolerance: number = UPSCALE_TOLERANCE,
): ResolutionTarget {
  const maxW = cropW * (1.0 + tolerance);
  const maxH = cropH * (1.0 + tolerance);
  for (const tier of TIERS) {
    const t = resolutionTarget(aspectKey, tier);
    if (t.width <= maxW && t.height <= maxH) return t;
  }
  const [w, h] = largestExactFit(aspectKey, cropW, cropH);
  return { tier: "exact-fit", width: w, height: h };
}

/** Resolve a user selection ("auto" or a tier key) to a concrete pixel target. */
export function resolve(
  aspectKey: string,
  selection: string,
  cropW: number,
  cropH: number,
  tolerance: number = UPSCALE_TOLERANCE,
): ResolutionTarget {
  if (selection === "auto") return resolveAuto(aspectKey, cropW, cropH, tolerance);
  return resolutionTarget(aspectKey, selection);
}

// ── the GUI helper: form selections + source dims -> a CropBoxTarget ─────────────────

/**
 * Build the concrete `CropBoxTarget` the overlay consumes from the reframe form's
 * aspect/resolution/allow-upscale selections and the source's stored dims. The output
 * pixel size is resolved against the source's NATIVE (scale=1) crop for the chosen
 * aspect — the same crop the engine measures Auto against — so the box's max-zoom and
 * readout match the render. Unknown selections fall back to the spec defaults.
 */
export function buildCropTarget(
  aspectKey: string,
  resolutionSel: string,
  srcW: number,
  srcH: number,
  allowUpscale: boolean,
): CropBoxTarget {
  const preset = aspectPreset(aspectKey);
  const [nativeW, nativeH] = nativeCropDims(srcW, srcH, preset.w, preset.h);
  const rt = resolve(aspectKey, resolutionSel, nativeW, nativeH);
  return {
    aspectW: preset.w,
    aspectH: preset.h,
    outW: rt.width,
    outH: rt.height,
    allowUpscale,
  };
}
