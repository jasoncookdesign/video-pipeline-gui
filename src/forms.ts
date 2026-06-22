// src/forms.ts — the schema-driven dynamic form engine + docked help (SADD §3.4/§3.6).
// Single responsibility: render a task's params as controls, mapping type+ui to a
// concrete control, sectioning by ui.group, applying ui.depends_on visibility, and
// — critically — TEACHING the CLI: focusing any control writes its `help`, its
// `flag`, and an example invocation into the docked help panel. Values persist
// keyed "taskId.paramKey" via the store. No assembly logic lives here (that's
// command.ts); this module only collects values and notifies on change.

import type { Param, Task, ControlKind, Compose, ComposePart, RowField } from "./types";
import { store } from "./state";
import { pickPath } from "./dialog";
import type { HelpPanel } from "./help";

export type { HelpPanel };

export interface FormHooks {
  /** Called on any value change; receives the changed "taskId.paramKey" so the
   *  app can react to specific fields (e.g. propagating the project identity). */
  onChange: (changedKey?: string) => void;
  help: HelpPanel;
  /** Soft validation: a warning to show under the given param, or null. Used to
   *  flag a downstream value that conflicts with an earlier stage. */
  conflict?: (paramKey: string) => string | null;
  /** Render every control disabled (a Completed task shows the values it used). */
  readOnly?: boolean;
}

/** Decide the concrete control: ui.control overrides; else derive from type. */
export function controlFor(param: Param): ControlKind {
  if (param.ui.control) return param.ui.control;
  switch (param.type) {
    case "bool":
      return "toggle";
    case "number":
      // bounded => slider; unbounded => stepper
      return param.min !== undefined && param.max !== undefined
        ? "slider"
        : "stepper";
    case "enum":
      return "dropdown";
    case "path":
      return "picker";
    case "string":
    default:
      return "field";
  }
}

function stateKey(task: Task, param: Param): string {
  return `${task.id}.${param.key}`;
}

/** Current value: persisted form value, else the param default. */
function currentValue(task: Task, param: Param): unknown {
  const k = stateKey(task, param);
  const v = store.getFormValue(k);
  if (v !== undefined) return v;
  return param.default;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the help-panel HTML for a focused param (help + flag + example). */
function helpHtmlFor(task: Task, param: Param): string {
  const parts: string[] = [];
  parts.push(`<h3 class="help__title">${escapeHtml(param.ui.label)}</h3>`);
  if (param.help) {
    parts.push(`<p class="help__body">${escapeHtml(param.help)}</p>`);
  } else if (param.hint) {
    parts.push(`<p class="help__body">${escapeHtml(param.hint)}</p>`);
  }
  const meta: string[] = [];
  if (param.flag) {
    meta.push(
      `<div class="help__row"><span class="help__k">flag</span><code>${escapeHtml(
        param.flag,
      )}</code></div>`,
    );
  } else if (param.arity === "positional") {
    meta.push(
      `<div class="help__row"><span class="help__k">arg</span><code>positional</code></div>`,
    );
  }
  meta.push(
    `<div class="help__row"><span class="help__k">type</span><code>${param.type}</code></div>`,
  );
  if (param.options) {
    meta.push(
      `<div class="help__row"><span class="help__k">options</span><code>${escapeHtml(
        param.options.map(String).join(" | "),
      )}</code></div>`,
    );
  }
  parts.push(`<div class="help__meta">${meta.join("")}</div>`);

  // Example invocation: prefer the param's own example, else synthesize one.
  let example = param.example;
  if (!example) {
    if (param.arity === "switch" && param.flag) {
      example = param.flag;
    } else if (param.flag) {
      const v =
        param.default !== undefined
          ? String(param.default)
          : param.type === "path"
            ? "<path>"
            : `<${param.key}>`;
      example = `${param.flag} ${v}`;
    } else if (param.arity === "positional") {
      example =
        param.type === "path" ? "<path>" : `<${param.key}>`;
    }
  }
  if (example) {
    parts.push(
      `<div class="help__example"><span class="help__k">example</span><code>${escapeHtml(
        `${task.subcommand} … ${example}`,
      )}</code></div>`,
    );
  }
  return parts.join("");
}

interface ControlBuild {
  /** The labelled wrapper element to mount. */
  wrapper: HTMLElement;
  /** Re-evaluate depends_on visibility against current sibling values. */
  refreshVisibility: () => void;
}

/**
 * Build a composed value from labelled sub-fields (SADD §3.4). Each part persists
 * under "<param>.<part>"; the assembled value (via the template) is the param's
 * value — set only when every part is filled, so an incomplete value reads as
 * missing (keeps the run gated). The structure guarantees the result matches the
 * convention, so the user never has to format the string by hand.
 */
function buildComposite(
  task: Task,
  param: Param,
  compose: Compose,
  notifyChanged: (changedKey?: string) => void,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "compose";
  const partKey = (p: ComposePart) => `${stateKey(task, param)}.${p.key}`;
  const today = () => new Date().toISOString().slice(0, 10);

  const partValue = (p: ComposePart): string => {
    const v = store.getFormValue(partKey(p));
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
    if (p.default === "today" && p.control === "date") return today();
    return p.default != null ? String(p.default) : "";
  };

  const assemble = (): void => {
    let allFilled = true;
    let name = compose.template;
    for (const p of compose.parts) {
      const v = partValue(p);
      if (v === "") allFilled = false;
      name = name.split(`{${p.key}}`).join(v);
    }
    store.setFormValue(stateKey(task, param), allFilled ? name : null);
    notifyChanged(stateKey(task, param));
  };

  for (const p of compose.parts) {
    const cell = document.createElement("label");
    cell.className = "compose__part";
    if (p.hint) cell.title = p.hint;
    const lab = document.createElement("span");
    lab.className = "compose__label";
    lab.textContent = p.label;

    let el: HTMLInputElement | HTMLSelectElement;
    if (p.control === "dropdown") {
      const sel = document.createElement("select");
      sel.className = "field__select compose__input";
      for (const opt of p.options ?? []) {
        const o = document.createElement("option");
        o.value = String(opt);
        o.textContent = String(opt);
        sel.appendChild(o);
      }
      sel.value = partValue(p);
      sel.addEventListener("change", () => {
        store.setFormValue(partKey(p), sel.value || null);
        assemble();
      });
      el = sel;
    } else {
      const inp = document.createElement("input");
      inp.type = p.control === "date" ? "date" : "text";
      inp.className = "field__field compose__input";
      if (p.placeholder) inp.placeholder = p.placeholder;
      inp.value = partValue(p);
      inp.addEventListener("input", () => {
        store.setFormValue(partKey(p), inp.value === "" ? null : inp.value);
        assemble();
      });
      el = inp;
    }
    cell.append(lab, el);
    container.appendChild(cell);
  }

  // Persist part defaults (date=today, token default) so they survive a reload.
  for (const p of compose.parts) {
    if (store.getFormValue(partKey(p)) == null) {
      const dv = partValue(p);
      if (dv) store.setFormValue(partKey(p), dv);
    }
  }
  assemble();
  return container;
}

/**
 * Build a repeatable rows control (arity="rows"). The value persisted under the
 * param key is an array of row objects ({fieldKey: value}); argv assembly emits
 * one `flag key=value;…` per non-empty row (see ipc.ts/command.rs). Each row is a
 * line of per-column inputs with a Remove button; an "Add" button appends a row
 * pre-seeded with its dropdown defaults.
 */
function buildRows(
  task: Task,
  param: Param,
  notifyChanged: (changedKey?: string) => void,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "rows";
  const key = stateKey(task, param);
  const fields: RowField[] = param.row ?? [];

  const stored = store.getFormValue(key);
  const rows: Record<string, string>[] = Array.isArray(stored)
    ? (stored as Record<string, string>[]).map((r) => ({ ...r }))
    : [];

  const persist = (): void => {
    store.setFormValue(key, rows.length ? rows : null);
    notifyChanged(key);
  };

  const list = document.createElement("div");
  list.className = "rows__list";

  const buildCell = (row: Record<string, string>, rf: RowField): HTMLElement => {
    const cell = document.createElement("label");
    cell.className = "rows__cell";
    if (rf.hint) cell.title = rf.hint;
    const lab = document.createElement("span");
    lab.className = "rows__label";
    lab.textContent = rf.label;

    let el: HTMLInputElement | HTMLSelectElement;
    if (rf.control === "dropdown") {
      const sel = document.createElement("select");
      sel.className = "field__select rows__input";
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "—";
      sel.appendChild(blank);
      for (const opt of rf.options ?? []) {
        const o = document.createElement("option");
        o.value = String(opt);
        o.textContent = String(opt);
        sel.appendChild(o);
      }
      sel.value = row[rf.key] ?? (rf.default != null ? String(rf.default) : "");
      sel.addEventListener("change", () => {
        if (sel.value) row[rf.key] = sel.value;
        else delete row[rf.key];
        persist();
      });
      el = sel;
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "field__field rows__input";
      if (rf.placeholder) inp.placeholder = rf.placeholder;
      inp.value = row[rf.key] ?? "";
      inp.addEventListener("input", () => {
        if (inp.value) row[rf.key] = inp.value;
        else delete row[rf.key];
        persist();
      });
      el = inp;
    }
    cell.append(lab, el);
    return cell;
  };

  const redraw = (): void => {
    list.innerHTML = "";
    rows.forEach((row, idx) => {
      const r = document.createElement("div");
      r.className = "rows__row";
      for (const rf of fields) r.appendChild(buildCell(row, rf));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "rows__del";
      del.textContent = "Remove";
      del.title = "Remove this overlay";
      del.addEventListener("click", () => {
        rows.splice(idx, 1);
        persist();
        redraw();
      });
      r.appendChild(del);
      list.appendChild(r);
    });
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "rows__empty";
      empty.textContent = "No overlays yet — add one below.";
      list.appendChild(empty);
    }
  };

  const newRow = (): Record<string, string> => {
    const row: Record<string, string> = {};
    for (const rf of fields) {
      if (rf.control === "dropdown" && rf.default != null) {
        row[rf.key] = String(rf.default);
      }
    }
    return row;
  };

  const add = document.createElement("button");
  add.type = "button";
  add.className = "rows__add";
  add.textContent = "+ Add overlay";
  add.addEventListener("click", () => {
    rows.push(newRow());
    persist();
    redraw();
  });

  container.append(list, add);
  redraw();
  return container;
}

/** Build a single labelled control for a param. */
function buildControl(
  task: Task,
  param: Param,
  hooks: FormHooks,
  notifyChanged: (changedKey?: string) => void,
): ControlBuild {
  const kind = controlFor(param);
  const wrapper = document.createElement("div");
  wrapper.className = `field field--${kind}`;
  wrapper.dataset.paramKey = param.key;

  const id = `ctl-${task.id}-${param.key}`.replace(/[^a-zA-Z0-9_-]/g, "_");

  const label = document.createElement("label");
  label.className = "field__label help-label";
  label.htmlFor = id;
  label.textContent = param.ui.label;
  if (param.required) {
    const req = document.createElement("span");
    req.className = "field__req";
    req.textContent = "*";
    req.title = "required";
    label.appendChild(req);
  }
  if (param.hint) label.title = param.hint; // tooltip from hint

  const set = (value: unknown) => {
    store.setFormValue(stateKey(task, param), value);
    notifyChanged(stateKey(task, param));
  };
  const focusHelp = () => hooks.help.show(helpHtmlFor(task, param));

  // Clicking the label shows help without activating the control — so help is
  // reachable for every control, including ones that can't take focus.
  label.addEventListener("click", (e) => {
    e.preventDefault();
    focusHelp();
  });

  const cur = currentValue(task, param);
  let input: HTMLElement;

  if (param.compose) {
    input = buildComposite(task, param, param.compose, notifyChanged);
    input.classList.add("field__input");
    wrapper.append(label, input);
    return {
      wrapper,
      refreshVisibility: () => {
        wrapper.hidden = false;
      },
    };
  }

  // Repeatable structured rows (arity="rows"): a table of overlays, each row one
  // --add entry. Spans the form width rather than sitting in the label/input grid.
  if (param.arity === "rows" && param.row) {
    wrapper.classList.add("field--rows");
    input = buildRows(task, param, notifyChanged);
    input.classList.add("field__input");
    wrapper.append(label, input);
    return {
      wrapper,
      refreshVisibility: () => {
        wrapper.hidden = false;
      },
    };
  }

  switch (kind) {
    case "toggle": {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.id = id;
      el.className = "field__toggle";
      el.checked = Boolean(cur);
      el.addEventListener("change", () => set(el.checked));
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "slider": {
      const row = document.createElement("div");
      row.className = "field__sliderrow";
      const el = document.createElement("input");
      el.type = "range";
      el.id = id;
      el.className = "field__slider";
      if (param.min !== undefined) el.min = String(param.min);
      if (param.max !== undefined) el.max = String(param.max);
      if (param.step !== undefined) el.step = String(param.step);
      el.value = cur !== undefined && cur !== null ? String(cur) : el.min || "0";
      const out = document.createElement("output");
      out.className = "field__sliderval";
      out.textContent = el.value;
      el.addEventListener("input", () => {
        out.textContent = el.value;
        set(Number(el.value));
      });
      el.addEventListener("focus", focusHelp);
      row.append(el, out);
      input = row;
      break;
    }
    case "stepper": {
      const el = document.createElement("input");
      el.type = "number";
      el.id = id;
      el.className = "field__stepper";
      if (param.min !== undefined) el.min = String(param.min);
      if (param.max !== undefined) el.max = String(param.max);
      if (param.step !== undefined) el.step = String(param.step);
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () =>
        set(el.value === "" ? null : Number(el.value)),
      );
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "dropdown": {
      const el = document.createElement("select");
      el.id = id;
      el.className = "field__select";
      if (!param.required) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "(default)";
        el.appendChild(none);
      }
      for (const opt of param.options ?? []) {
        const o = document.createElement("option");
        o.value = String(opt);
        o.textContent = String(opt);
        el.appendChild(o);
      }
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("change", () =>
        set(el.value === "" ? null : el.value),
      );
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "picker": {
      // A path picker: a text field + a Browse button that opens the native
      // chooser, plus a drag-drop target (dnd.ts). The PathSpec (file/dir +
      // extensions) drives both the chooser's filters and drop validation.
      const spec = param.path ?? { kind: "file" as const };
      const row = document.createElement("div");
      row.className = "field__pickerrow";
      // Data attributes let dnd.ts validate a dropped path against this picker.
      row.dataset.pathKind = spec.kind ?? "file";
      if (spec.extensions && spec.extensions.length) {
        row.dataset.pathExt = spec.extensions.join(",");
      }

      const el = document.createElement("input");
      el.type = "text";
      el.id = id;
      el.className = "field__field";
      el.placeholder =
        spec.kind === "directory" ? "folder…" : param.example ?? "path…";
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () => set(el.value === "" ? null : el.value));
      el.addEventListener("focus", focusHelp);

      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "field__browse";
      browse.textContent = "Browse…";
      browse.title =
        spec.kind === "directory" ? "Choose a folder" : "Choose a file";
      browse.addEventListener("click", async () => {
        focusHelp();
        try {
          const picked = await pickPath(spec, {
            title: `Select ${param.ui.label}`,
            defaultPath: el.value || undefined,
          });
          if (picked && picked.length > 0) {
            const value = spec.multiple ? picked.join(", ") : picked[0];
            el.value = value;
            set(value);
          }
        } catch {
          // Dialog unavailable (e.g. plain browser) — leave the field for typing.
          el.focus();
        }
      });
      row.append(el, browse);
      input = row;
      break;
    }
    case "field":
    default: {
      const el = document.createElement("input");
      el.type = "text";
      el.id = id;
      el.className = "field__field";
      if (param.example) el.placeholder = param.example;
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () => set(el.value === "" ? null : el.value));
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
  }

  input.classList.add("field__input");
  wrapper.append(label, input);

  // Soft conflict warning under the field (e.g. a downstream Profile/Identity that
  // differs from the first step). Re-checked on input/change of this field.
  if (hooks.conflict) {
    const warn = document.createElement("div");
    warn.className = "field__warn";
    const checkConflict = () => {
      const msg = hooks.conflict?.(param.key) ?? null;
      warn.textContent = msg ?? "";
      warn.hidden = !msg;
    };
    wrapper.appendChild(warn);
    wrapper.addEventListener("input", checkConflict);
    wrapper.addEventListener("change", checkConflict);
    checkConflict();
  }

  const refreshVisibility = () => {
    const dep = param.ui.depends_on;
    if (!dep) {
      wrapper.hidden = false;
      return;
    }
    // depends_on resolves against a SIBLING param in the same task.
    const sibling = task.params.find((p) => p.key === dep.key);
    let siblingValue: unknown = undefined;
    if (sibling) {
      const v = store.getFormValue(stateKey(task, sibling));
      siblingValue = v !== undefined ? v : sibling.default;
    } else {
      // dep.key may reference a bare key already stored under this task.
      siblingValue = store.getFormValue(`${task.id}.${dep.key}`);
    }
    const visible =
      "equals" in dep ? siblingValue === dep.equals : Boolean(siblingValue);
    wrapper.hidden = !visible;
  };

  return { wrapper, refreshVisibility };
}

export interface RenderedForm {
  el: HTMLElement;
  task: Task;
}

/**
 * Render a task's full form into `host`. Groups params by ui.group, wires
 * depends_on cross-refresh, and persists every change. Returns the mounted root.
 */
export function renderForm(
  host: HTMLElement,
  task: Task,
  hooks: FormHooks,
): RenderedForm {
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "form";

  const header = document.createElement("div");
  header.className = "form__header";
  header.innerHTML = `
    <h2 class="form__title">${escapeHtml(task.label)}</h2>
    <code class="form__subcommand">${escapeHtml(task.subcommand)}</code>
  `;
  if (task.hint) {
    const hint = document.createElement("p");
    hint.className = "form__hint";
    hint.textContent = task.hint;
    header.appendChild(hint);
  }
  root.appendChild(header);

  const builds: ControlBuild[] = [];
  const refreshAll = () => builds.forEach((b) => b.refreshVisibility());

  // depends_on changes must re-evaluate visibility across the whole form.
  const notifyChanged = (changedKey?: string) => {
    refreshAll();
    hooks.onChange(changedKey);
  };

  // Group params by ui.group (preserving first-seen order), sort within by order.
  const groups = new Map<string, Param[]>();
  for (const p of task.params) {
    const g = p.ui.group ?? "Options";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }

  for (const [groupName, params] of groups) {
    const section = document.createElement("section");
    section.className = "form__group";
    const legend = document.createElement("h4");
    legend.className = "form__grouptitle";
    legend.textContent = groupName;
    section.appendChild(legend);

    const sorted = [...params].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    for (const p of sorted) {
      const build = buildControl(task, p, hooks, notifyChanged);
      builds.push(build);
      section.appendChild(build.wrapper);
    }
    root.appendChild(section);
  }

  if (task.params.length === 0) {
    const none = document.createElement("p");
    none.className = "form__empty";
    none.textContent = "This task takes no parameters.";
    root.appendChild(none);
  }

  host.appendChild(root);
  refreshAll(); // initial depends_on pass

  // Completed task: show the values it used, disabled (Edit task re-enables it).
  if (hooks.readOnly) {
    root.classList.add("form--readonly");
    root
      .querySelectorAll<HTMLInputElement>("input, select, textarea")
      .forEach((el) => {
        el.disabled = true;
      });
  }

  // Seed the help panel with the task's own help if present.
  if (task.help) {
    hooks.help.show(
      `<h3 class="help__title">${escapeHtml(task.label)}</h3>` +
        `<p class="help__body">${escapeHtml(task.help)}</p>` +
        `<div class="help__example"><span class="help__k">subcommand</span><code>${escapeHtml(
          task.subcommand,
        )}</code></div>`,
    );
  }

  return { el: root, task };
}
