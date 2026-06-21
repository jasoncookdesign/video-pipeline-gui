// src/command.ts — the resolved-command preview bar (SADD §3.6 / §2.1).
// Single responsibility: given the selected task + current form values, produce
// the EXACT argv the backend would run and render it as a copyable monospace
// string. In Tauri mode it asks the backend (`resolve_argv`) — the backend is
// the source of truth; in mock mode it uses the local JS port. The preview is
// glass-box: the operator always sees the precise command before running.

import { ipc, IPC_MODE, assembleArgv } from "./ipc";
import type { Schema, Task, Artifact } from "./types";
import { store } from "./state";

/** Build the artifactPaths map the backend expects: artifact id -> resolved path. */
export function artifactPathsFor(
  schema: Schema,
  projectRoot: string | undefined,
): Record<string, string> {
  const root = projectRoot ?? "<project-root>";
  const out: Record<string, string> = {};
  for (const a of schema.artifacts as Artifact[]) {
    out[a.id] = `${root}/${a.path}`;
  }
  return out;
}

/**
 * Resolve the argv for a task. Uses the backend in Tauri mode, the local port
 * otherwise. `formValues` is the full keyed-by-"taskId.paramKey" map.
 */
export async function resolveArgv(
  schema: Schema,
  task: Task,
  formValues: Record<string, unknown>,
  projectRoot: string | undefined,
): Promise<string[]> {
  const artifactPaths = artifactPathsFor(schema, projectRoot);
  if (IPC_MODE === "tauri") {
    return await ipc.resolveArgv({ taskId: task.id, formValues, artifactPaths });
  }
  return assembleArgv(schema, { taskId: task.id, formValues, artifactPaths });
}

/** Quote a single argv token for display/copy (light shell-ish quoting). */
export function quoteToken(a: string): string {
  return /[\s"'$]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Render an argv as a single shell-ish copyable line. */
export function argvToString(argv: string[]): string {
  return argv.map(quoteToken).join(" ");
}

export interface CommandPreview {
  /** Mount the preview bar into `host`; returns an updater for the selected task. */
  update(task: Task | null): Promise<void>;
}

/**
 * Mount the live-updating command preview bar. Reads form values from the store
 * on each update so it tracks edits without its own state.
 */
export function mountCommandPreview(
  host: HTMLElement,
  schema: Schema,
): CommandPreview {
  host.classList.add("cmd-preview");
  host.innerHTML = `
    <span class="cmd-preview__label">resolved command</span>
    <code class="cmd-preview__code" aria-live="polite">—</code>
    <button class="cmd-preview__copy" type="button" title="Copy command">Copy</button>
  `;
  const codeEl = host.querySelector<HTMLElement>(".cmd-preview__code")!;
  const copyBtn = host.querySelector<HTMLButtonElement>(".cmd-preview__copy")!;

  let lastText = "";
  let prevTokens: string[] | null = null; // for change highlighting (null = no diff)
  let prevTaskId: string | null = null;

  copyBtn.disabled = true;
  copyBtn.addEventListener("click", () => {
    if (!lastText) return;
    void navigator.clipboard?.writeText(lastText).then(
      () => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      },
      () => {
        /* clipboard may be unavailable in some webviews; ignore */
      },
    );
  });

  // Plain-English placeholder — the command isn't runnable yet; copy is disabled.
  function showHint(text: string): void {
    codeEl.classList.add("cmd-preview__code--hint");
    codeEl.textContent = text;
    prevTokens = null;
    lastText = "";
    copyBtn.disabled = true;
  }

  // Render the argv as per-token elements; tokens that changed since the last
  // render of THIS task flash (the diff is suppressed across task switches).
  function showCommand(argv: string[]): void {
    codeEl.classList.remove("cmd-preview__code--hint");
    const tokens = argv.map(quoteToken);
    lastText = tokens.join(" ");
    const prev = prevTokens;
    codeEl.replaceChildren(
      ...tokens.map((tok, i) => {
        const span = document.createElement("span");
        span.className = "cmd-tok";
        span.textContent = tok;
        if (prev && (i >= prev.length || prev[i] !== tok)) {
          span.classList.add("cmd-tok--changed");
        }
        return span;
      }),
    );
    prevTokens = tokens;
    copyBtn.disabled = false;
  }

  return {
    async update(task: Task | null): Promise<void> {
      if (!task) {
        prevTaskId = null;
        showHint("Select a step to see the command it runs.");
        return;
      }
      // A new task is a fresh command — don't flash the whole thing as "changed".
      if (task.id !== prevTaskId) {
        prevTokens = null;
        prevTaskId = task.id;
      }
      const root = store.projectRoot();
      try {
        const argv = await resolveArgv(
          schema,
          task,
          store.session().formValues,
          root,
        );
        showCommand(argv);
      } catch (err) {
        showHint(
          /required/i.test(String(err))
            ? "Fill in the required fields (marked *) to build the command."
            : "Complete the form to see the command that will run.",
        );
      }
    },
  };
}
