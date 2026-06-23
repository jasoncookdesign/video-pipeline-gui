// src/previewer.ts — the single-<video> layer previewer (SADD §6).
// Single responsibility: present ONE <video> element whose src swaps between
// previewable artifacts that also exist on disk, while preserving the viewer's
// sense of place. Key behaviours mandated by the SADD:
//   (a) Playhead/play-state preservation: capture currentTime + paused BEFORE a
//       src swap and restore on 'loadeddata' (re-seek; resume if it was playing).
//   (b) A global 0.0–1.0 volume coefficient slider that sets video.volume.
//   (c) A checkerboard/black backdrop behind the <video> — a defensive fallback;
//       transparent layers are not played directly (see the note below).
// Layers are sorted by z_order.
//
// NOTE (transparent layers): the previewer only ever plays OPAQUE h264 sources.
// The pipeline bakes each transparent layer (the HEVC-alpha caption overlay) over
// a checkerboard into an h264 proxy (the `proxy` step → `*.preview.mp4`, e.g.
// `caption.preview`; overlays preview via the h264 `overlay-composite`), and the
// alpha `.mov` layers are marked non-previewable. So this module never depends on
// the webview decoding alpha — the earlier WKWebView alpha spike is superseded
// (see docs/alpha-spike.md).

import { ipc } from "./ipc";
import type { Artifact, Schema } from "./types";
import { store } from "./state";
import { artifactPathsFor } from "./command";
import { bindLabelHelp, helpMarkup, type HelpPanel } from "./help";
import { tauriAvailable } from "./dialog";
import { mountCropBox, type CropBoxController } from "./cropBox";
import { Rotation, type RotationDeg } from "./reframeBox";

// In the Tauri webview a <video> can't load a raw filesystem path — it needs an
// asset-protocol URL. `convertFileSrc` produces one (identity in browser/mock).
// Without this the element never loads, so transport never enables and the
// duration stays 0:00. The asset scope + CSP already allow $HOME media.
let toAssetUrl: (p: string) => string = (p) => p;
const assetReady: Promise<void> = tauriAvailable()
  ? import("@tauri-apps/api/core").then((m) => {
      toAssetUrl = m.convertFileSrc;
    })
  : Promise.resolve();

const PLAY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';

/** mm:ss for the transport readout (NaN/∞ render as 0:00 during load). */
function clock(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Friendly layer name from an artifact id: "caption.preview" -> "Caption (preview)". */
function layerName(a: Artifact): string {
  const isPreview = a.id.endsWith(".preview");
  const stem = a.id.replace(/\.preview$/, "").replace(/[._]/g, " ");
  const title = stem.replace(/\b\w/g, (c) => c.toUpperCase());
  return isPreview ? `${title} (preview)` : title;
}

/** What the previewer needs to enter reframe crop mode. */
export interface CropModeSource {
  /** The source clip to show (asset path); optional when dims are injected. */
  src?: string;
  /** Stored source dims — supply directly to skip `loadedmetadata` (tests/known). */
  srcW?: number;
  srcH?: number;
  rotation?: RotationDeg;
  /** Fired once the source's stored dims are known (real video: on metadata). */
  onSourceDims?: (srcW: number, srcH: number, rotation: RotationDeg) => void;
  /** Wired to the crop box's reset-to-proposal control. */
  onResetProposal?: () => void;
}

export interface Previewer {
  /** Recompute which layers are available (present ∩ previewable) and rebuild. */
  refresh(projectRoot: string | undefined): Promise<void>;
  /** Lock the stage aspect ratio to the output profile (e.g. "feed-square-1x1"). */
  setProfile(profile: string): void;
  /**
   * Enter the reframe crop mode: show the source at its NATURAL aspect (not the
   * locked output aspect) and overlay the draggable crop box. Returns the box
   * controller for two-way binding, or null if the overlay can't mount. The overlay
   * appears as soon as the source dims are known (immediately when injected).
   */
  enterCropMode(source: CropModeSource): CropBoxController | null;
  /** Leave crop mode and restore normal layer preview. */
  exitCropMode(): void;
}

export function mountPreviewer(
  host: HTMLElement,
  schema: Schema,
  help: HelpPanel,
): Previewer {
  host.classList.add("previewer");
  host.innerHTML = `
    <div class="previewer__stagewrap">
      <div class="previewer__stage">
        <div class="previewer__backdrop" aria-hidden="true"></div>
        <video class="previewer__video" playsinline preload="auto"></video>
        <div class="previewer__empty empty-state"><span></span></div>
        <div class="previewer__overlay" hidden></div>
      </div>
    </div>
    <div class="previewer__transport">
      <button class="previewer__play" type="button" title="Play / pause" disabled>${PLAY_ICON}</button>
      <input class="previewer__seek" type="range" min="0" max="0" step="0.01" value="0" disabled />
      <span class="previewer__time">0:00&nbsp;/&nbsp;0:00</span>
    </div>
    <div class="previewer__controls">
      <label class="previewer__layerlabel"><span data-help="layer">Layer</span>
        <select class="previewer__layers"></select>
      </label>
      <label class="previewer__vollabel"><span data-help="vol">Vol</span>
        <input class="previewer__vol" type="range" min="0" max="1" step="0.01" value="1" />
        <output class="previewer__volval">1.00</output>
      </label>
      <button class="previewer__resetcrop" type="button" hidden>Reset to proposal</button>
      <span class="previewer__status"></span>
    </div>
  `;

  // Help triggers on the control labels (reachable even when the select is
  // disabled because nothing is on disk yet).
  bindLabelHelp(
    host.querySelector<HTMLElement>('[data-help="layer"]')!,
    () =>
      helpMarkup(
        "Preview layer",
        "Choose which produced layer to preview — base video, caption overlay, etc. A layer becomes selectable once a run has written it to disk; absent layers are disabled.",
      ),
    help,
  );
  bindLabelHelp(
    host.querySelector<HTMLElement>('[data-help="vol"]')!,
    () =>
      helpMarkup(
        "Preview volume",
        "Playback volume for the preview only (0.00–1.00). It does not affect the rendered output.",
      ),
    help,
  );

  const stageWrap = host.querySelector<HTMLElement>(".previewer__stagewrap")!;
  const stage = host.querySelector<HTMLElement>(".previewer__stage")!;
  const video = host.querySelector<HTMLVideoElement>(".previewer__video")!;
  const select = host.querySelector<HTMLSelectElement>(".previewer__layers")!;
  const vol = host.querySelector<HTMLInputElement>(".previewer__vol")!;
  const volVal = host.querySelector<HTMLOutputElement>(".previewer__volval")!;
  const status = host.querySelector<HTMLElement>(".previewer__status")!;
  const playBtn = host.querySelector<HTMLButtonElement>(".previewer__play")!;
  const seek = host.querySelector<HTMLInputElement>(".previewer__seek")!;
  const timeEl = host.querySelector<HTMLElement>(".previewer__time")!;
  const emptyEl = host.querySelector<HTMLElement>(".previewer__empty > span")!;
  const emptyBox = host.querySelector<HTMLElement>(".previewer__empty")!;
  const overlay = host.querySelector<HTMLElement>(".previewer__overlay")!;
  const layerLabel = host.querySelector<HTMLElement>(".previewer__layerlabel")!;
  const resetCropBtn = host.querySelector<HTMLButtonElement>(".previewer__resetcrop")!;

  const showEmpty = (text: string) => {
    emptyEl.textContent = text;
    emptyBox.hidden = false;
  };
  const hideEmpty = () => {
    emptyBox.hidden = true;
  };

  // Stage sizing: the aspect ratio is locked to the output profile; the size is
  // free — fit the largest box of that ratio inside the available area. In crop mode
  // the stage instead takes the SOURCE's natural aspect so the box maps to real pixels.
  let aspect = 9 / 16; // default (reels) until setProfile runs
  let cropMode = false;
  let cropAspect = 9 / 16; // source display aspect while in crop mode
  let crop: CropBoxController | null = null;
  function fitStage(): void {
    const availW = stageWrap.clientWidth;
    const availH = stageWrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;
    const ar = cropMode ? cropAspect : aspect;
    let w = availW;
    let h = availW / ar;
    if (h > availH) {
      h = availH;
      w = availH * ar;
    }
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(h)}px`;
    crop?.relayout();
  }
  new ResizeObserver(() => fitStage()).observe(stageWrap);

  function setProfile(profile: string): void {
    const m = /(\d+)x(\d+)/.exec(profile);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0 && h > 0) aspect = w / h;
    }
    fitStage();
  }

  // --- global volume coefficient (b) ---
  const applyVolume = () => {
    const v = Number(vol.value);
    video.volume = Math.max(0, Math.min(1, v));
    volVal.textContent = video.volume.toFixed(2);
  };
  vol.addEventListener("input", applyVolume);
  applyVolume();

  // --- transport: play/pause + scrub + clock ---
  let scrubbing = false;
  const setPlayIcon = () => {
    playBtn.innerHTML = video.paused || video.ended ? PLAY_ICON : PAUSE_ICON;
  };
  const enableTransport = (on: boolean) => {
    playBtn.disabled = !on;
    seek.disabled = !on;
    if (!on) {
      seek.value = "0";
      timeEl.innerHTML = "0:00&nbsp;/&nbsp;0:00";
      setPlayIcon();
    }
  };
  const renderTime = () => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    timeEl.innerHTML = `${clock(video.currentTime)}&nbsp;/&nbsp;${clock(dur)}`;
  };

  playBtn.addEventListener("click", () => {
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener("play", setPlayIcon);
  video.addEventListener("pause", setPlayIcon);
  video.addEventListener("ended", setPlayIcon);
  video.addEventListener("loadedmetadata", () => {
    seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
    renderTime();
  });
  video.addEventListener("timeupdate", () => {
    if (!scrubbing) seek.value = String(video.currentTime);
    renderTime();
  });
  // Scrub: seek live while dragging; timeupdate stops fighting the thumb.
  seek.addEventListener("input", () => {
    scrubbing = true;
    video.currentTime = Number(seek.value);
    renderTime();
  });
  seek.addEventListener("change", () => {
    scrubbing = false;
  });

  // Previewable layers from the schema, sorted by z_order (low → high).
  const previewable = (schema.artifacts as Artifact[])
    .filter((a) => a.previewable)
    .sort((a, b) => (a.z_order ?? 0) - (b.z_order ?? 0));

  /**
   * Swap the video src while preserving playhead + play-state (a).
   * Captures BEFORE the swap; restores after 'loadeddata'.
   */
  function swapSource(src: string, artifact: Artifact): void {
    hideEmpty();
    const wasTime = video.currentTime;
    const wasPlaying = !video.paused && !video.ended;

    const onLoaded = () => {
      video.removeEventListener("loadeddata", onLoaded);
      // Re-seek to the captured playhead (clamp to the new duration).
      const target = Number.isFinite(video.duration)
        ? Math.min(wasTime, video.duration)
        : wasTime;
      try {
        video.currentTime = target;
      } catch {
        /* some sources disallow seeking before play; ignore */
      }
      if (wasPlaying) {
        void video.play().catch(() => {
          /* autoplay policy may block resume; leave paused */
        });
      }
      enableTransport(true);
      setPlayIcon();
      status.textContent = layerName(artifact);
    };

    video.addEventListener("loadeddata", onLoaded);
    video.src = toAssetUrl(src);
    // Mark alpha layers so the backdrop reads through (checkerboard).
    host.classList.toggle(
      "previewer--alpha",
      Boolean(artifact.codec_hint?.includes("alpha")),
    );
    video.load();
  }

  function selectLayer(id: string, presentIds: Set<string>): void {
    const artifact = previewable.find((a) => a.id === id);
    if (!artifact) return;
    const paths = artifactPathsFor(schema, store.projectRoot());
    const src = paths[artifact.id];
    store.setPreviewLayer(id);
    if (!presentIds.has(id) || !src) {
      enableTransport(false);
      video.removeAttribute("src");
      video.load();
      status.textContent = `${layerName(artifact)} · not on disk yet`;
      showEmpty(`The “${layerName(artifact)}” layer hasn't been rendered yet — run the step that produces it to preview it here.`);
      return;
    }
    swapSource(src, artifact);
  }

  let lastRoot: string | undefined;

  async function refresh(projectRoot: string | undefined): Promise<void> {
      lastRoot = projectRoot;
      // Crop mode owns the <video>/overlay; layer refresh resumes on exit.
      if (cropMode) return;
      await assetReady; // ensure convertFileSrc is loaded before any src swap
      const root = projectRoot ?? store.activeProjectRoot() ?? "";
      let present: string[] = [];
      try {
        present = await ipc.listPresentArtifacts(root);
      } catch {
        present = [];
      }
      const presentIds = new Set(present);

      // Rebuild the layer selector: all previewable layers, marking absent ones.
      select.innerHTML = "";
      for (const a of previewable) {
        const opt = document.createElement("option");
        opt.value = a.id;
        const here = presentIds.has(a.id);
        opt.textContent = here ? layerName(a) : `${layerName(a)} (absent)`;
        opt.disabled = !here;
        select.appendChild(opt);
      }

      // Restore persisted layer if still valid+present, else first present.
      const persisted = store.getPreviewLayer();
      const firstPresent = previewable.find((a) => presentIds.has(a.id))?.id;
      const chosen =
        persisted && presentIds.has(persisted) ? persisted : firstPresent;

      select.onchange = () => selectLayer(select.value, presentIds);

      if (chosen) {
        select.value = chosen;
        selectLayer(chosen, presentIds);
      } else {
        // Nothing to show (e.g. New project) — unload the previous video so its
        // last frame doesn't linger behind the empty-state watermark.
        video.removeAttribute("src");
        video.load();
        enableTransport(false);
        status.textContent = "";
        showEmpty(
          "Layer preview. Once a step renders a layer (base video, caption overlay…), pick it here to play it back.",
        );
      }
  }

  // ── reframe crop mode ──────────────────────────────────────────────────────────
  // Toggle the chrome between layer-preview and crop-edit. Crop mode hides the layer
  // selector + empty watermark and reveals the reset-to-proposal control.
  function setCropChrome(on: boolean): void {
    host.classList.toggle("previewer--cropmode", on);
    layerLabel.hidden = on;
    resetCropBtn.hidden = !on;
    overlay.hidden = !on;
    if (on) hideEmpty();
  }

  let onCropReset: (() => void) | null = null;
  resetCropBtn.addEventListener("click", () => onCropReset?.());

  // Apply the source's stored dims: set the stage to its display aspect, mount/define
  // the overlay source, and notify the caller (for the two-way binding's target).
  function applyCropSource(
    srcW: number,
    srcH: number,
    rotation: RotationDeg,
    notify?: (w: number, h: number, r: RotationDeg) => void,
  ): void {
    if (srcW <= 0 || srcH <= 0) return;
    // videoWidth/Height are already display dims in the browser, so the display
    // aspect is the stored ratio for R0 and swaps for 90/270.
    const swap = rotation === Rotation.R90 || rotation === Rotation.R270;
    cropAspect = swap ? srcH / srcW : srcW / srcH;
    fitStage();
    crop?.setSource({ srcW, srcH, rotation });
    // Defer the dims notification one microtask so the caller's binding (created from
    // the controller AFTER enterCropMode returns) is in place before it fires — true
    // for injected dims (synchronous) and harmless for the metadata path.
    if (notify) queueMicrotask(() => notify(srcW, srcH, rotation));
  }

  function enterCropMode(source: CropModeSource): CropBoxController | null {
    cropMode = true;
    setCropChrome(true);
    onCropReset = source.onResetProposal ?? null;
    if (!crop) crop = mountCropBox(overlay);

    // Show the source clip itself (visual is the CEO's WKWebView pass; the overlay
    // geometry is authoritative headlessly even over a black stage).
    if (source.src) {
      void assetReady.then(() => {
        video.src = toAssetUrl(source.src!);
        video.load();
      });
    }

    const rotation = source.rotation ?? Rotation.R0;
    if (source.srcW && source.srcH) {
      // Injected/known dims — overlay appears immediately.
      applyCropSource(source.srcW, source.srcH, rotation, source.onSourceDims);
    } else {
      // Real video — dims arrive with the metadata; the overlay appears then.
      const onMeta = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        applyCropSource(video.videoWidth, video.videoHeight, rotation, source.onSourceDims);
      };
      video.addEventListener("loadedmetadata", onMeta);
    }
    return crop;
  }

  function exitCropMode(): void {
    if (!cropMode) return;
    cropMode = false;
    onCropReset = null;
    crop?.destroy();
    crop = null;
    setCropChrome(false);
    fitStage();
    void refresh(lastRoot); // restore the normal layer preview
  }

  return {
    refresh,
    setProfile,
    enterCropMode,
    exitCropMode,
  };
}
