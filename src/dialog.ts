// src/dialog.ts — native file/folder picking (SADD §3.4).
// Single responsibility: turn a param's PathSpec into a native OS chooser and
// return the selected path(s). Uses the Tauri dialog plugin when running inside
// the webview; falls back to a prompt in a plain browser so dev still works.
//
// This is deliberately decoupled from the IPC adapter (ipc.ts): the dialog is a
// frontend-invoked plugin call and works whenever the Tauri runtime is present,
// independent of whether the rest of the app is talking to the real backend.

import type { PathSpec } from "./types";

/** True when running inside the Tauri webview (v2 always injects this global). */
export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface PickResult {
  paths: string[];
}

/**
 * Open a native chooser for a path param. Returns the chosen paths, or null if
 * the user cancelled. `extensions` masks file choosers; directories ignore it.
 */
export async function pickPath(
  spec: PathSpec,
  opts: { title?: string; defaultPath?: string } = {},
): Promise<string[] | null> {
  const kind = spec.kind ?? "file";
  const multiple = Boolean(spec.multiple);

  if (tauriAvailable()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filters =
      kind === "file" && spec.extensions && spec.extensions.length > 0
        ? [
            {
              name: spec.extensions.map((e) => e.toUpperCase()).join(" / "),
              extensions: spec.extensions,
            },
          ]
        : undefined;
    const res = await open({
      directory: kind === "directory",
      multiple,
      title: opts.title,
      defaultPath: opts.defaultPath || undefined,
      filters,
    });
    if (res == null) return null;
    return Array.isArray(res) ? res : [res];
  }

  // Plain-browser dev fallback — no native chooser available.
  const label =
    kind === "directory" ? "folder path" : "file path";
  const hint =
    spec.extensions && spec.extensions.length
      ? ` (${spec.extensions.join(", ")})`
      : "";
  const typed = window.prompt(`${opts.title ?? `Enter a ${label}`}${hint}`, opts.defaultPath ?? "");
  return typed ? [typed] : null;
}
