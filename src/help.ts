// src/help.ts — the docked help panel contract + shared helpers (SADD §3.6).
// Single responsibility: define how anything drives the help panel, and provide
// the uniform "click a label to read its help" affordance used across every
// control — including ones that can't take focus (disabled selects, the topbar
// stepper) where focus-driven help never fires.

export interface HelpPanel {
  show(html: string): void;
  clear(): void;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal help markup for chrome controls that have no schema metadata. */
export function helpMarkup(title: string, body: string): string {
  return (
    `<h3 class="help__title">${esc(title)}</h3>` +
    `<p class="help__body">${esc(body)}</p>`
  );
}

/**
 * Turn an element into a help trigger: clicking it shows help (without activating
 * any control it labels) and it gets a hover affordance. Bind it to the label's
 * *text* element — for labels that wrap their control, that's a child span so the
 * control itself stays directly usable.
 */
export function bindLabelHelp(
  el: HTMLElement,
  provide: () => string,
  help: HelpPanel,
): void {
  el.classList.add("help-label");
  el.addEventListener("click", (e) => {
    e.preventDefault();
    help.show(provide());
  });
}
