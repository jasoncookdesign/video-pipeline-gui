// src/dnd.ts — drag-and-drop onto path pickers (SADD §3.4, nice-to-have).
// Single responsibility: accept a native file/folder drop onto a picker control,
// validate it against that picker's PathSpec, and write the path in. Compatible
// drop zones highlight while a drag is in flight.
//
// File *paths* are only available through Tauri's drag-drop events (the HTML5
// drop event in a webview yields no real filesystem path), so this is a no-op in
// a plain browser — Browse still works there via the prompt fallback.

import { tauriAvailable } from "./dialog";

const PICKER_SEL = ".field__pickerrow";

/** Does this dropped path satisfy the picker's declared kind/extensions? */
function rowAccepts(row: HTMLElement, path: string): boolean {
  const kind = row.dataset.pathKind ?? "file";
  // Directories: we can't tell file-vs-folder from the string alone, so accept
  // any drop and let the CLI validate. (Extension masking is the file case.)
  if (kind === "directory") return true;
  const exts = (row.dataset.pathExt ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (exts.length === 0) return true; // unfiltered file picker
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m !== null && exts.includes(m[1]);
}

/** Write a dropped path into the picker's text input and notify the form. */
function applyDrop(row: HTMLElement, path: string): void {
  const input = row.querySelector<HTMLInputElement>("input");
  if (!input) return;
  input.value = path;
  // Reuse the form's own change wiring (persist + re-resolve preview).
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function clearHighlights(): void {
  document
    .querySelectorAll(`${PICKER_SEL}.dnd-eligible, ${PICKER_SEL}.dnd-over`)
    .forEach((el) => el.classList.remove("dnd-eligible", "dnd-over"));
}

/** Map a Tauri physical drop position to the picker row under the cursor. */
function rowAtPosition(x: number, y: number): HTMLElement | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / dpr, y / dpr);
  return (el?.closest(PICKER_SEL) as HTMLElement) ?? null;
}

function paintHighlights(
  position: { x: number; y: number } | undefined,
  path: string | undefined,
): void {
  clearHighlights();
  if (!path) return;
  const rows = document.querySelectorAll<HTMLElement>(PICKER_SEL);
  rows.forEach((row) => {
    if (rowAccepts(row, path)) row.classList.add("dnd-eligible");
  });
  if (position) {
    const hit = rowAtPosition(position.x, position.y);
    if (hit && rowAccepts(hit, path)) hit.classList.add("dnd-over");
  }
}

/**
 * Subscribe to the webview's drag-drop events. Safe to call once at boot; a
 * no-op outside Tauri. Returns an unlisten fn (unused at the app root).
 */
export async function setupDragDrop(): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");

  // `over` carries no paths in Tauri v2 — remember what `enter` reported.
  let lastPath: string | undefined;

  const unlisten = await getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload as {
      type: "enter" | "over" | "drop" | "leave";
      paths?: string[];
      position?: { x: number; y: number };
    };

    if (p.type === "enter") {
      lastPath = p.paths?.[0];
      paintHighlights(p.position, lastPath);
    } else if (p.type === "over") {
      paintHighlights(p.position, lastPath);
    } else if (p.type === "leave") {
      lastPath = undefined;
      clearHighlights();
    } else if (p.type === "drop") {
      const path = p.paths?.[0];
      const pos = p.position;
      clearHighlights();
      lastPath = undefined;
      if (!path || !pos) return;
      const row = rowAtPosition(pos.x, pos.y);
      if (row && rowAccepts(row, path)) applyDrop(row, path);
    }
  });

  return unlisten;
}
