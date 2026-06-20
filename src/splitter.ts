// src/splitter.ts — reusable drag-to-resize splitter with collapse (SADD §2.1).
// Single responsibility: turn a thin handle element into a pointer-drag resizer
// for a panel that sits AFTER the handle (to its right for a vertical handle,
// below it for a horizontal one). Resizing is clamped to [min, max]. Dragging the
// panel below `collapseAt` collapses it; dragging a collapsed panel back out past
// the threshold re-expands it mid-drag (no need to release). On every change it
// reports (sizePx, collapsed) via `onChange` — the caller applies the layout and
// persists it. `initialSize`/`initialCollapsed` restore a saved arrangement.

export interface SplitController {
  setCollapsed(collapsed: boolean): void;
  toggle(): void;
}

export interface SplitterOptions {
  handle: HTMLElement;
  axis: "x" | "y";
  min: number;
  max: number;
  /** Collapse when a drag would shrink the panel below this many px. */
  collapseAt: number;
  /** Expanded size in px to start from (restored from saved state). */
  initialSize: number;
  /** Whether the panel starts collapsed (restored from saved state). */
  initialCollapsed?: boolean;
  /** Called on init and on every change; `size` is the last expanded size. */
  onChange: (sizePx: number, collapsed: boolean) => void;
}

export function makeSplitter(o: SplitterOptions): SplitController {
  let size = o.initialSize;
  let collapsed = o.initialCollapsed ?? false;

  const emit = (): void => o.onChange(size, collapsed);

  const setCollapsed = (c: boolean): void => {
    if (collapsed === c) return;
    collapsed = c;
    emit();
  };

  let dragging = false;
  let startCoord = 0;
  let startSize = 0;
  const coordOf = (e: PointerEvent): number =>
    o.axis === "x" ? e.clientX : e.clientY;

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    // The panel grows as the handle moves toward it (left / up), so size
    // increases as the pointer coordinate decreases relative to the start.
    const next = startSize - (coordOf(e) - startCoord);
    if (next < o.collapseAt) {
      collapsed = true;
      emit();
      return;
    }
    collapsed = false;
    size = Math.max(o.min, Math.min(o.max, next));
    emit();
  };

  const onUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("cursor");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    try {
      o.handle.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may not be held */
    }
  };

  o.handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startCoord = coordOf(e);
    startSize = collapsed ? 0 : size;
    document.body.style.userSelect = "none";
    document.body.style.cursor = o.axis === "x" ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    try {
      o.handle.setPointerCapture(e.pointerId);
    } catch {
      /* not fatal */
    }
    e.preventDefault();
  });

  emit(); // apply the initial / restored arrangement
  return { setCollapsed, toggle: () => setCollapsed(!collapsed) };
}
