// src/log.ts — run-output view (SADD §5).
// Single responsibility: append log-line events as wrapping monospace rows into a
// bounded list (~5000 rows; oldest evicted), autoscroll when pinned to the
// bottom, and show a watermark while empty. Rows wrap rather than truncate, so a
// long resolved-argv line or stack trace stays readable. It prints the resolved
// argv at task start (the runner emits that as a stdout line). "Open full log" is
// a stub affordance (the full log lives backend-side).

import type { LogLineEvent } from "./types";

const MAX_LINES = 5000;

export interface LogView {
  push(e: LogLineEvent): void;
  clear(): void;
}

export function mountLog(host: HTMLElement): LogView {
  host.classList.add("log");
  host.innerHTML = `
    <div class="log__toolbar">
      <span class="log__count">0 lines</span>
      <span class="log__spacer"></span>
      <button class="log__full" type="button" title="Open the full log (backend)">Open full log…</button>
      <button class="log__clear" type="button" title="Clear the view">Clear</button>
    </div>
    <div class="log__scroll" tabindex="0">
      <div class="log__window"></div>
      <div class="log__empty empty-state"><span>Run output appears here. Set up the steps, then press Run to start the pipeline.</span></div>
    </div>
  `;
  const scrollEl = host.querySelector<HTMLElement>(".log__scroll")!;
  const windowEl = host.querySelector<HTMLElement>(".log__window")!;
  const emptyEl = host.querySelector<HTMLElement>(".log__empty")!;
  const countEl = host.querySelector<HTMLElement>(".log__count")!;
  const fullBtn = host.querySelector<HTMLButtonElement>(".log__full")!;
  const clearBtn = host.querySelector<HTMLButtonElement>(".log__clear")!;

  let dropped = 0;
  let pinnedToBottom = true;

  function refreshMeta(): void {
    const n = windowEl.childElementCount;
    const dropNote = dropped > 0 ? ` (+${dropped} dropped)` : "";
    countEl.textContent = `${n} lines${dropNote}`;
    emptyEl.hidden = n > 0; // watermark only while empty
  }

  function append(e: LogLineEvent): void {
    const div = document.createElement("div");
    div.className = `log__line log__line--${e.stream}`;
    const tag = document.createElement("span");
    tag.className = "log__tag";
    tag.textContent = e.taskId;
    const txt = document.createElement("span");
    txt.className = "log__text";
    txt.textContent = e.line;
    div.append(tag, txt);
    windowEl.appendChild(div);
    while (windowEl.childElementCount > MAX_LINES && windowEl.firstElementChild) {
      windowEl.removeChild(windowEl.firstElementChild);
      dropped += 1;
    }
  }

  scrollEl.addEventListener("scroll", () => {
    pinnedToBottom =
      scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
  });

  fullBtn.addEventListener("click", () => {
    fullBtn.textContent = "Full log → backend (stub)";
    setTimeout(() => (fullBtn.textContent = "Open full log…"), 1500);
  });
  clearBtn.addEventListener("click", () => {
    windowEl.replaceChildren();
    dropped = 0;
    refreshMeta();
  });

  refreshMeta(); // initial: show the watermark

  return {
    push(e: LogLineEvent): void {
      const wasPinned = pinnedToBottom;
      append(e);
      refreshMeta();
      if (wasPinned) scrollEl.scrollTop = scrollEl.scrollHeight;
    },
    clear(): void {
      windowEl.replaceChildren();
      dropped = 0;
      refreshMeta();
    },
  };
}
