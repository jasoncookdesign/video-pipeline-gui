// src/splitter.ts — reusable drag-to-resize splitter with collapse (SADD §2.1).
// Single responsibility: turn a thin handle element into a pointer-drag resizer
// for a panel that sits AFTER the handle (to its right for a vertical handle,
// below it for a horizontal one). Resizing is clamped to [min, max]. Dragging the
// panel below `collapseAt` collapses it; dragging a collapsed panel back out past
// the threshold re-expands it mid-drag (no need to release). The actual layout
// write is delegated via `apply` so callers stay in control of the CSS.

export interface SplitController {
  setCollapsed(collapsed: boolean): void;
  toggle(): void;
  collapsed(): boolean;
}

export interface SplitterOptions {
  handle: HTMLElement;
  axis: "x" | "y";
  min: number;
  max: number;
  /** Collapse when a drag would shrink the panel below this many px. */
  collapseAt: number;
  /** Initial expanded size in px. */
  initial: number;
  /** Apply the panel size in px to the layout (0 ⇒ collapsed). */
  apply: (sizePx: number) => void;
  /** Notified whenever the collapsed state flips (for class toggles / icons). */
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function makeSplitter(o: SplitterOptions): SplitController {
  let size = o.initial;
  let collapsed = false;

  const applyState = (): void => {
    o.apply(collapsed ? 0 : size);
    o.onCollapsedChange?.(collapsed);
  };

  const setCollapsed = (c: boolean): void => {
    if (collapsed === c) return;
    collapsed = c;
    applyState();
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
      applyState();
      return;
    }
    collapsed = false;
    size = Math.max(o.min, Math.min(o.max, next));
    applyState();
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

  applyState();
  return { setCollapsed, toggle: () => setCollapsed(!collapsed), collapsed: () => collapsed };
}
