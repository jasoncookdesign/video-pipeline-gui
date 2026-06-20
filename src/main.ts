// src/main.ts — composition root (SADD §2.1).
// Single responsibility: wire the modules together. Loads the schema via the IPC
// adapter, builds the left step/task tree with enable toggles, mounts the form +
// command preview + plan + log + previewer + help, subscribes to backend events,
// and handles Run/Cancel + theme + concurrency cap. Holds no business logic of
// its own — every rule lives behind the IPC boundary.

import "./styles.css";
import { ipc, IPC_MODE } from "./ipc";
import type {
  LogLineEvent,
  PlanProgressEvent,
  Schema,
  Step,
  Task,
  TaskStatusEvent,
} from "./types";
import { store } from "./state";
import { initTheme, toggleTheme } from "./theme";
import { renderForm } from "./forms";
import { mountCommandPreview } from "./command";
import { mountLog } from "./log";
import { mountPreviewer } from "./previewer";
import { setupDragDrop } from "./dnd";
import { bindLabelHelp, helpMarkup, type HelpPanel } from "./help";
import { makeSplitter } from "./splitter";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  await store.load();
  initTheme();

  // Reflect the runtime mode in the top bar (helps during dev).
  $("#mode-badge").textContent = IPC_MODE === "tauri" ? "tauri" : "mock";

  let schema: Schema;
  try {
    schema = await ipc.loadSchema();
  } catch (err) {
    $("#center").innerHTML = `<div class="fatal">Failed to load schema: <code>${String(
      err,
    )}</code></div>`;
    return;
  }

  $("#engine-name").textContent = `${schema.engine.name} ${schema.engine.version}`;

  // ---- enable-set: which tasks are turned on (left toggles) ----
  // Non-optional tasks default enabled; optional tasks default disabled.
  const enabled = new Set<string>();
  for (const t of schema.tasks) {
    if (!t.optional) enabled.add(t.id);
  }

  // ---- help panel (driven by form focus) ----
  const helpHost = $("#help-body");
  const help: HelpPanel = {
    show(html: string): void {
      helpHost.innerHTML = html;
    },
    clear(): void {
      helpHost.innerHTML = "";
    },
  };

  // ---- mount the center/right widgets ----
  const cmdPreview = mountCommandPreview($("#cmd-bar"), schema);
  const logView = mountLog($("#log-view"));
  const previewer = mountPreviewer($("#previewer"), schema, help);

  // ---- invalid-selection warning banner (replaces the plan panel) ----
  const banner = $("#banner");
  function planErrorToEnglish(raw: string): string {
    if (/noproducer|no enabled task produces|consumes/i.test(raw)) {
      return (
        "This selection can't run yet: a step needs an input that no enabled step " +
        "produces. Enable the step that creates it — for example, turn on " +
        "“Propose rough cut” before “Render rough cut.”"
      );
    }
    if (/cycle/i.test(raw)) {
      return "This selection can't run: the chosen steps form a dependency loop.";
    }
    return `This selection can't run: ${raw}`;
  }
  async function validateSelection(enabledIds: string[]): Promise<void> {
    try {
      await ipc.buildPlan(enabledIds);
      banner.hidden = true;
      banner.textContent = "";
    } catch (err) {
      banner.textContent = planErrorToEnglish(String(err));
      banner.hidden = false;
    }
  }

  // Top-bar concurrency cap: a help trigger on its label (the stepper itself
  // never showed help on focus).
  bindLabelHelp(
    $("#cap-help"),
    () =>
      helpMarkup(
        "Concurrency cap",
        "Maximum number of independent tasks the scheduler runs at once within a level. Higher uses more CPU and memory; 2 is a sensible default on an M-series Mac.",
      ),
    help,
  );

  let selectedTask: Task | null = null;

  const refreshCommand = () => void cmdPreview.update(selectedTask);
  const refreshPlan = () => void validateSelection([...enabled]);

  // QoL: the earliest Identity control (project.init's) is the "project identity".
  // Choosing it pre-selects the same value on the later Identity controls so the
  // user doesn't re-pick it per step. The controls stay independent — editing a
  // downstream one doesn't propagate back, and these are still separate CLI args.
  const identityTaskIds = schema.tasks
    .filter((t) => t.params.some((p) => p.key === "identity"))
    .map((t) => t.id);
  const projectIdentityKey =
    identityTaskIds.length > 0 ? `${identityTaskIds[0]}.identity` : null;
  const downstreamIdentityKeys = identityTaskIds
    .slice(1)
    .map((id) => `${id}.identity`);

  const onFormChange = (changedKey?: string): void => {
    if (changedKey && changedKey === projectIdentityKey) {
      const val = store.getFormValue(changedKey);
      for (const k of downstreamIdentityKeys) store.setFormValue(k, val);
    }
    refreshCommand();
  };

  // ---- left tree: steps -> tasks with enable toggles ----
  const tree = $("#step-tree");

  function selectTask(task: Task): void {
    selectedTask = task;
    // highlight
    tree
      .querySelectorAll(".tree__task--active")
      .forEach((e) => e.classList.remove("tree__task--active"));
    tree
      .querySelector(`.tree__task[data-task="${CSS.escape(task.id)}"]`)
      ?.classList.add("tree__task--active");

    renderForm($("#form-host"), task, {
      onChange: onFormChange,
      help,
    });
    refreshCommand();
  }

  function buildTree(): void {
    tree.innerHTML = "";
    const steps = [...schema.steps].sort((a, b) => a.order - b.order);
    const tasksByStep = new Map<string, Task[]>();
    for (const t of schema.tasks) {
      if (!tasksByStep.has(t.step)) tasksByStep.set(t.step, []);
      tasksByStep.get(t.step)!.push(t);
    }

    const renderStep = (step: Step) => {
      const group = document.createElement("div");
      group.className = "tree__step";
      const head = document.createElement("div");
      head.className = "tree__stephead";
      head.innerHTML = `<span class="tree__steplabel">${step.label}</span>${
        step.optional ? '<span class="tree__opt">optional</span>' : ""
      }`;
      if (step.hint) head.title = step.hint;
      group.appendChild(head);

      for (const task of tasksByStep.get(step.id) ?? []) {
        const row = document.createElement("div");
        row.className = "tree__task";
        row.dataset.task = task.id;

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "tree__toggle";
        toggle.checked = enabled.has(task.id);
        toggle.disabled = !task.optional; // required tasks can't be disabled
        toggle.title = task.optional
          ? "Enable/disable this task"
          : "Required — always runs";
        toggle.addEventListener("change", () => {
          if (toggle.checked) enabled.add(task.id);
          else enabled.delete(task.id);
          refreshPlan();
        });

        const label = document.createElement("button");
        label.type = "button";
        label.className = "tree__tasklabel";
        label.textContent = task.label;
        if (task.hint) label.title = task.hint;
        label.addEventListener("click", () => selectTask(task));

        row.append(toggle, label);
        group.appendChild(row);
      }
      tree.appendChild(group);
    };

    steps.forEach(renderStep);

    // Tasks whose step isn't declared (defensive) get a catch-all group.
    const declared = new Set(steps.map((s) => s.id));
    const orphanSteps = [...tasksByStep.keys()].filter((s) => !declared.has(s));
    for (const sid of orphanSteps) {
      renderStep({ id: sid, label: sid, order: 9999, optional: true });
    }
  }

  buildTree();

  // Select the first task by default.
  if (schema.tasks.length > 0) selectTask(schema.tasks[0]);

  // Initial plan + previewer pass.
  refreshPlan();
  void previewer.refresh(store.activeProjectRoot());

  // Native file/folder drag-drop onto path pickers (no-op outside Tauri).
  void setupDragDrop();

  // ---- resizable / collapsible panels ----
  setupPanels();

  // ---- backend event subscriptions ----
  await ipc.listen<LogLineEvent>("log-line", (p) => logView.push(p));
  await ipc.listen<TaskStatusEvent>("task-status", (p) => {
    // Run status colours the pipeline tree rows (the plan chips were removed).
    const row = tree.querySelector<HTMLElement>(
      `.tree__task[data-task="${CSS.escape(p.taskId)}"]`,
    );
    if (row) row.dataset.state = p.state;
    if (p.state === "Succeeded") {
      // A produced artifact may now exist — refresh available preview layers.
      void previewer.refresh(store.activeProjectRoot());
    }
  });
  await ipc.listen<PlanProgressEvent>("plan-progress", (p) => {
    $("#run-progress").textContent =
      `L${p.level + 1}: ${p.done}/${p.total}`;
  });

  // ---- top-bar controls ----
  const themeBtn = $("#theme-toggle");
  themeBtn.addEventListener("click", () => {
    const t = toggleTheme();
    themeBtn.textContent = t === "dark" ? "◑ Dark" : "◐ Light";
  });
  themeBtn.textContent = store.getTheme() === "dark" ? "◑ Dark" : "◐ Light";

  const capInput = $<HTMLInputElement>("#cap-input");
  // Persisted cap isn't part of the kv model; keep it local with a sane default.
  capInput.value = "2";

  const runBtn = $<HTMLButtonElement>("#run-btn");
  const cancelBtn = $<HTMLButtonElement>("#cancel-btn");

  runBtn.addEventListener("click", () => {
    const cap = Math.max(1, Number(capInput.value) || 1);
    const root = store.activeProjectRoot() ?? "<project-root>";
    void store.flush();
    void ipc
      .runPlan({
        enabled: [...enabled],
        formValues: store.session().formValues,
        projectRoot: root,
        cap,
      })
      .then((runId) => {
        $("#run-progress").textContent = `run ${runId}`;
        cancelBtn.disabled = false;
      })
      .catch((err) => {
        $("#run-progress").textContent = `error: ${String(err)}`;
      });
  });

  cancelBtn.addEventListener("click", () => {
    // Cancel the currently selected task (per-task cancel is the IPC surface).
    if (selectedTask) void ipc.cancelTask(selectedTask.id);
  });
  cancelBtn.disabled = true;

  // ---- resizable + collapsible panel wiring ----
  function setupPanels(): void {
    const grid = $("#grid");
    const center = $("#center");
    const right = $("#right");
    const mark = (btn: HTMLElement, c: boolean) =>
      (btn.dataset.collapsed = String(c));

    // center | right — resizes the whole right panel; collapse hides it.
    makeSplitter({
      handle: $("#right-split"),
      axis: "x",
      min: 260,
      max: 620,
      collapseAt: 150,
      initial: 340,
      apply: (px) => grid.style.setProperty("--right-w", `${px}px`),
      onCollapsedChange: (c) => grid.classList.toggle("right-collapsed", c),
    });

    // preview | help (inside right) — preview keeps the remainder; help collapses.
    const helpSplit = makeSplitter({
      handle: $("#right-help-split"),
      axis: "y",
      min: 90,
      max: 460,
      collapseAt: 56,
      initial: 220,
      apply: (px) => right.style.setProperty("--help-h", `${px}px`),
      onCollapsedChange: (c) => {
        right.classList.toggle("help-collapsed", c);
        mark($("#help-collapse"), c);
      },
    });
    $("#help-collapse").addEventListener("click", () => helpSplit.toggle());

    // resolved command stays docked; this handle sizes/collapses the run output.
    const logSplit = makeSplitter({
      handle: $("#log-split"),
      axis: "y",
      min: 80,
      max: 520,
      collapseAt: 52,
      initial: 200,
      apply: (px) => center.style.setProperty("--log-h", `${px}px`),
      onCollapsedChange: (c) => {
        center.classList.toggle("log-collapsed", c);
        mark($("#log-collapse"), c);
      },
    });
    $("#log-collapse").addEventListener("click", () => logSplit.toggle());
  }
}

void boot();
