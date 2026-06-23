// src/main.ts — composition root (SADD §2.1).
// Single responsibility: wire the modules together. Loads the schema via the IPC
// adapter, builds the left step/task tree with enable toggles, mounts the form +
// command preview + plan + log + previewer + help, subscribes to backend events,
// and handles Run/Cancel + theme + concurrency cap. Holds no business logic of
// its own — every rule lives behind the IPC boundary.

import "./styles.css";
import { ipc } from "./ipc";
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
import { renderForm, setControlValue } from "./forms";
import { mountCommandPreview, artifactPathsFor } from "./command";
import { mountLog } from "./log";
import { mountPreviewer } from "./previewer";
import {
  mountReframeBinding,
  isReframeModelKey,
  isReframeTargetKey,
  type ReframeBinding,
} from "./reframeBinding";
import type { FramingModel } from "./reframeBox";
import { setupDragDrop } from "./dnd";
import { confirmDialog, pickPath, tauriAvailable } from "./dialog";
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

  // Completed = the task's output is up-to-date on disk (shown with a checkmark,
  // config disabled). Reopened = the user clicked "Edit task" — those re-run on the
  // next batch (the force set) and drop out of completed.
  const completed = new Set<string>();
  const reopened = new Set<string>();

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
  let lastPlanValid = true;
  async function validateSelection(enabledIds: string[]): Promise<void> {
    try {
      await ipc.buildPlan(enabledIds);
      banner.hidden = true;
      banner.textContent = "";
      lastPlanValid = true;
    } catch (err) {
      banner.textContent = planErrorToEnglish(String(err));
      banner.hidden = false;
      lastPlanValid = false;
    }
    updateRunEnabled();
  }

  // A run can complete only if the selection is a valid graph AND every enabled
  // task's required inputs have a value (or a default).
  function requiredInputsSatisfied(enabledIds: string[]): boolean {
    const set = new Set(enabledIds);
    for (const t of schema.tasks) {
      if (!set.has(t.id)) continue;
      for (const p of t.params) {
        if (!p.required) continue;
        const v = store.getFormValue(`${t.id}.${p.key}`);
        const provided = v !== undefined && v !== null && v !== "";
        const hasDefault =
          p.default !== undefined && p.default !== null && p.default !== "";
        if (!provided && !hasDefault) return false;
      }
    }
    return true;
  }
  // Run lifecycle: `running` gates the Run button; `pendingTasks` is the set of
  // enabled tasks we're still waiting on (cleared by terminal task-status events).
  // Pending/Running are transient; only these end a task.
  const TERMINAL_STATES = new Set([
    "Succeeded",
    "Failed",
    "Blocked",
    "Skipped",
    "Reused",
  ]);
  let running = false;
  let pendingTasks = new Set<string>();

  function updateRunEnabled(): void {
    // A real run also needs the pipeline executable set (in the Tauri app).
    const pipelineOk = !tauriAvailable() || !!store.getPipelinePath();
    const ok =
      lastPlanValid && requiredInputsSatisfied([...enabled]) && pipelineOk;
    $<HTMLButtonElement>("#run-btn").disabled = running || !ok;
  }

  // Top-bar concurrency cap: a help trigger on its label (the stepper itself
  // never showed help on focus).
  bindLabelHelp(
    $("#cap-help"),
    () =>
      helpMarkup(
        "Parallel tasks",
        "How many independent tasks the scheduler runs at once within a level. Higher uses more CPU and memory; 2 is a sensible default on an M-series Mac.",
      ),
    help,
  );

  let selectedTask: Task | null = null;

  // ---- reframe crop mode (INI-091): the draggable box <-> reframe.propose knobs ----
  const REFRAME_TASK = "reframe.propose";
  let reframeBinding: ReframeBinding | null = null;

  const refreshCommand = () => void cmdPreview.update(selectedTask);
  const refreshPlan = () => void validateSelection([...enabled]);

  // Push a box-driven model change onto the visible scale/pan inputs (if shown).
  function updateReframeKnobDisplay(model: FramingModel): void {
    const formHost = $("#form-host");
    setControlValue(formHost, REFRAME_TASK, "scale", model.scale);
    setControlValue(formHost, REFRAME_TASK, "pan_x", model.pan_x);
    setControlValue(formHost, REFRAME_TASK, "pan_y", model.pan_y);
    refreshCommand();
    updateRunEnabled();
  }

  function enterReframeCropMode(): void {
    const base = artifactPathsFor(schema, store.projectRoot())["base"];
    let binding: ReframeBinding | null = null;
    const ctrl = previewer.enterCropMode({
      src: base, // may be undefined before a project exists — overlay still mounts
      onSourceDims: (w, h) => {
        binding?.setSourceDims(w, h);
        binding?.captureProposalFromForm();
      },
      onResetProposal: () => ctrl?.resetToProposal(),
    });
    if (!ctrl) return;
    binding = mountReframeBinding({
      crop: ctrl,
      bridge: store,
      taskId: REFRAME_TASK,
      onModelWritten: updateReframeKnobDisplay,
    });
    reframeBinding = binding;
  }

  function exitReframeCropMode(): void {
    if (!reframeBinding) return;
    reframeBinding.destroy();
    reframeBinding = null;
    previewer.exitCropMode();
  }

  function syncReframeCropMode(task: Task): void {
    if (task.id === REFRAME_TASK) {
      if (!reframeBinding) enterReframeCropMode();
    } else {
      exitReframeCropMode();
    }
  }

  // QoL: a project-wide control (the earliest task that carries it — project.init)
  // pre-fills the same value on the later steps' copies of that control, so the
  // user sets it once. The controls stay independent (editing a downstream one
  // doesn't propagate back) and remain separate CLI args.
  const sharedProps = ["identity", "profile"]
    .map((key) => {
      const taskIds = schema.tasks
        .filter((t) => t.params.some((p) => p.key === key))
        .map((t) => t.id);
      return {
        key,
        sourceKey: taskIds.length > 0 ? `${taskIds[0]}.${key}` : null,
        downstreamKeys: taskIds.slice(1).map((id) => `${id}.${key}`),
      };
    })
    .filter((s): s is { key: string; sourceKey: string; downstreamKeys: string[] } => s.sourceKey !== null);

  const onFormChange = (changedKey?: string): void => {
    for (const s of sharedProps) {
      if (changedKey && changedKey === s.sourceKey) {
        const val = store.getFormValue(changedKey);
        for (const k of s.downstreamKeys) store.setFormValue(k, val);
        if (s.key === "profile") previewer.setProfile(String(val ?? ""));
      }
    }
    // Knob edits flow the other way: form -> crop box (no-op outside crop mode).
    if (reframeBinding && changedKey) {
      if (isReframeModelKey(REFRAME_TASK, changedKey)) reframeBinding.syncModelFromForm();
      else if (isReframeTargetKey(REFRAME_TASK, changedKey)) reframeBinding.syncTargetFromForm();
    }
    refreshCommand();
    updateRunEnabled();
    refreshConflicts();
  };

  // Mark pipeline-tree rows whose shared fields conflict with the first step, so a
  // restored-session conflict is visible at launch without opening each step.
  function refreshConflicts(): void {
    const treeEl = document.getElementById("step-tree");
    if (!treeEl) return;
    for (const t of schema.tasks) {
      const conflict = t.params.some((p) => conflictMessage(t.id, p.key) !== null);
      const row = treeEl.querySelector<HTMLElement>(
        `.tree__task[data-task="${CSS.escape(t.id)}"]`,
      );
      if (!row) continue;
      row.classList.toggle("tree__task--conflict", conflict);
      if (conflict) {
        row.title = "A setting in this step conflicts with the project settings.";
      } else {
        row.removeAttribute("title");
      }
    }
  }

  // Soft conflict: a downstream shared control (Identity/Profile) whose value
  // differs from the project's (first-step) value — likely a mistake.
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  function conflictMessage(taskId: string, paramKey: string): string | null {
    for (const s of sharedProps) {
      if (s.key !== paramKey) continue;
      const myKey = `${taskId}.${paramKey}`;
      if (myKey === s.sourceKey || !s.downstreamKeys.includes(myKey)) continue;
      const src = store.getFormValue(s.sourceKey);
      const mine = store.getFormValue(myKey);
      const has = (v: unknown) => v != null && String(v) !== "";
      if (has(src) && has(mine) && String(src) !== String(mine)) {
        return (
          `Differs from the project ${titleCase(s.key)} ("${String(src)}") set ` +
          `in Initialize project — may produce unexpected results.`
        );
      }
    }
    return null;
  }

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

    const isCompleted = completed.has(task.id);
    renderForm($("#form-host"), task, {
      onChange: onFormChange,
      help,
      conflict: (k) => conflictMessage(task.id, k),
      readOnly: isCompleted,
    });
    if (isCompleted) appendEditTask($("#form-host"), task);
    // Reframe gets the source-aspect crop overlay; every other task gets layer preview.
    syncReframeCropMode(task);
    refreshCommand();
  }

  // The "Edit task" affordance shown under a completed task's (disabled) form.
  function appendEditTask(host: HTMLElement, task: Task): void {
    const box = document.createElement("div");
    box.className = "form__editbox";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--ghost form__edit";
    btn.textContent = "Edit task";
    btn.addEventListener("click", () => editTask(task));
    const note = document.createElement("p");
    note.className = "form__editnote";
    const n = downstreamTaskIds(task.id).filter((d) => completed.has(d)).length;
    note.textContent =
      n > 0
        ? `Editing this reopens ${n} completed downstream task${n === 1 ? "" : "s"} too, so your change flows through on the next run.`
        : "This will re-run this task on the next run; upstream completed tasks are reused.";
    box.append(btn, note);
    host.appendChild(box);
  }

  // Reopen a completed task + its completed downstream dependents for editing;
  // they leave the completed set and join the force set (re-run next batch).
  function editTask(task: Task): void {
    reopened.add(task.id);
    completed.delete(task.id);
    for (const d of downstreamTaskIds(task.id)) {
      if (completed.has(d)) {
        completed.delete(d);
        reopened.add(d);
      }
    }
    applyCompleted();
    selectTask(task); // re-render now-editable
  }

  // Tasks transitively downstream of `taskId` (consumers of what it/they produce).
  function downstreamTaskIds(taskId: string): string[] {
    const out = new Set<string>();
    const queue = [taskId];
    while (queue.length) {
      const cur = queue.shift()!;
      const curTask = schema.tasks.find((t) => t.id === cur);
      if (!curTask) continue;
      for (const ch of curTask.produces) {
        for (const t of schema.tasks) {
          if (t.id !== cur && t.consumes.includes(ch) && !out.has(t.id)) {
            out.add(t.id);
            queue.push(t.id);
          }
        }
      }
    }
    return [...out];
  }

  // Reflect the completed set onto the tree rows (checkmark + disabled-config cue).
  function applyCompleted(): void {
    for (const t of schema.tasks) {
      const row = tree.querySelector<HTMLElement>(
        `.tree__task[data-task="${CSS.escape(t.id)}"]`,
      );
      if (row) row.dataset.completed = completed.has(t.id) ? "true" : "";
    }
  }

  // Ask the backend which tasks are up-to-date for the current project, minus any
  // the user has reopened, and reflect it on the tree + the open form.
  async function refreshCompleted(): Promise<void> {
    const root = store.projectRoot();
    let utd: string[] = [];
    if (root) {
      try {
        utd = await ipc.upToDateTasks(root);
      } catch {
        utd = [];
      }
    }
    completed.clear();
    for (const id of utd) if (!reopened.has(id)) completed.add(id);
    applyCompleted();
    if (selectedTask) selectTask(selectedTask);
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

        // Completed marker: a checkmark shown (via CSS) in place of the checkbox
        // when the task's output is up-to-date.
        const check = document.createElement("span");
        check.className = "tree__check";
        check.textContent = "✓";
        check.title = "Completed — output is up-to-date";

        const label = document.createElement("button");
        label.type = "button";
        label.className = "tree__tasklabel";
        label.textContent = task.label;
        if (task.hint) label.title = task.hint;
        label.addEventListener("click", () => selectTask(task));

        row.append(toggle, check, label);
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

  // Launch-time validation: a restored session may carry a downstream value that
  // conflicts with the project's. Surface it on the tree now, without waiting for
  // the user to open that step or change a value.
  refreshConflicts();
  // Reflect any already-produced (Completed) steps for the restored project.
  void refreshCompleted();

  // The project lives at <Projects root>/<Project name> (project-init creates it
  // there). Artifact paths + the run's working dir resolve against this. Single
  // shared derivation in the store so the command preview, previewer, and run all
  // agree (see store.projectRoot()).
  const projectRoot = (): string | undefined => store.projectRoot();

  // Initial plan + previewer pass.
  refreshPlan();
  void previewer.refresh(projectRoot());

  // Lock the preview aspect to the project profile (stored value or schema default).
  const profileProp = sharedProps.find((s) => s.key === "profile");
  if (profileProp) {
    const stored = store.getFormValue(profileProp.sourceKey);
    const def = schema.tasks
      .flatMap((t) => t.params)
      .find((p) => p.key === "profile")?.default;
    previewer.setProfile(String(stored ?? def ?? "reels-9x16"));
  }

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
      void previewer.refresh(projectRoot());
    }
    // A *terminal* state clears the task from the pending set; when the set empties
    // the run is over (covers failures/blocks, which `done==total` would miss).
    // NB: Pending + Running are NOT terminal — the run starts by emitting Pending
    // for every scheduled task, which must not be mistaken for completion.
    if (TERMINAL_STATES.has(p.state)) {
      pendingTasks.delete(p.taskId);
      if (running && pendingTasks.size === 0) {
        setRunning(false);
        reopened.clear(); // edits have been applied; recompute completion
        void refreshCompleted();
      }
    }
  });
  await ipc.listen<PlanProgressEvent>("plan-progress", (p) => {
    $("#run-progress").textContent =
      `L${p.level + 1}: ${p.done}/${p.total}`;
  });

  // ---- top-bar controls ----
  const SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const themeBtn = $("#theme-toggle");
  // Show the icon of the mode you'll switch TO: a sun while dark, a moon while light.
  const setThemeIcon = (t: "light" | "dark") =>
    (themeBtn.innerHTML = t === "dark" ? SUN_ICON : MOON_ICON);
  themeBtn.addEventListener("click", () => setThemeIcon(toggleTheme()));
  setThemeIcon(store.getTheme());

  const capInput = $<HTMLSelectElement>("#cap-input");
  // Persisted cap isn't part of the kv model; keep it local with a sane default.
  capInput.value = "2";

  const runBtn = $<HTMLButtonElement>("#run-btn");
  const cancelBtn = $<HTMLButtonElement>("#cancel-btn");

  // Toggle the running state: Run shows a spinner + "Running" and is disabled;
  // Cancel is enabled only while a run is in flight.
  function setRunning(on: boolean): void {
    running = on;
    cancelBtn.disabled = !on;
    if (on) {
      runBtn.disabled = true;
      runBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Running`;
    } else {
      runBtn.innerHTML = "▶ Run";
      updateRunEnabled(); // restore the validity-gated enabled state
    }
  }

  runBtn.addEventListener("click", () => {
    void (async () => {
      const cap = Math.max(1, Number(capInput.value) || 1);
      const root = projectRoot() ?? "<project-root>";

      // Overwrite confirmation: re-running creates project-init over an existing
      // folder, which refreshes the project and overwrites the enabled steps'
      // outputs. Confirm first.
      if (enabled.has("project.init") && root !== "<project-root>") {
        let exists = false;
        try {
          exists = await ipc.pathExists(root);
        } catch {
          exists = false;
        }
        if (exists) {
          const ok = await confirmDialog(
            `A project already exists at:\n${root}\n\nRunning will overwrite the ` +
              `outputs of the enabled steps. Continue?`,
            "Overwrite project?",
          );
          if (!ok) return;
        }
      }

      void store.flush();
      // Persist the configuration into the project folder so reopening it later
      // restores the values that produced its artifacts.
      if (root !== "<project-root>") {
        void ipc.writeProjectState(
          root,
          JSON.stringify({
            formValues: store.session().formValues,
            enabled: [...enabled],
          }),
        );
      }
      // Mark running BEFORE awaiting the run: a fast run (e.g. every task reused)
      // can emit its terminal task-status events before this continuation resumes,
      // and they must find a populated pending set — otherwise it never empties and
      // the button stays stuck on "Running". Revert if the run fails to start.
      pendingTasks = new Set([...enabled]);
      setRunning(true);
      try {
        const runId = await ipc.runPlan({
          enabled: [...enabled],
          formValues: store.session().formValues,
          projectRoot: root,
          cap,
          pipelineCmd: store.getPipelinePath(),
          force: [...reopened],
        });
        $("#run-progress").textContent = `run ${runId}`;
      } catch (err) {
        $("#run-progress").textContent = `error: ${String(err)}`;
        setRunning(false);
      }
    })();
  });

  cancelBtn.addEventListener("click", () => {
    // Cancel the whole run: request cancellation of every task still pending.
    for (const id of pendingTasks) void ipc.cancelTask(id);
  });
  cancelBtn.disabled = true;

  // Pipeline location: point the app at the video-pipeline executable so runs work
  // regardless of how the app was launched (else it relies on PATH).
  const pipelineBtn = $<HTMLButtonElement>("#pipeline-btn");
  const reflectPipeline = () => {
    const p = store.getPipelinePath();
    pipelineBtn.textContent = p ? "Change pipeline" : "Set pipeline";
    pipelineBtn.classList.toggle("btn--attention", !p); // draw the eye when unset
    pipelineBtn.title = p
      ? `Pipeline executable:\n${p}\n\nClick to change.`
      : "Set the video-pipeline executable to run (required before a run).";
  };
  reflectPipeline();
  pipelineBtn.addEventListener("click", () => {
    void (async () => {
      const picked = await pickPath(
        { kind: "file" },
        {
          title: "Locate the video-pipeline executable",
          defaultPath: store.getPipelinePath(),
        },
      );
      if (picked && picked.length > 0) {
        store.setPipelinePath(picked[0]);
        await store.flush();
        reflectPipeline();
        updateRunEnabled();
      }
    })();
  });

  // Reset everything to defaults (confirmed), then reload to rebuild from scratch.
  const resetBtn = $<HTMLButtonElement>("#reset-btn");
  resetBtn.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        "Reset all fields, panel sizes, and theme to their defaults? This clears your saved values and reloads the app.",
        "Reset to defaults",
      );
      if (!ok) return;
      await store.reset();
      location.reload();
    })();
  });

  // Rebuild the tree + center/preview after the config changes wholesale
  // (New/Open project). Keeps UI preferences; only the configuration changes.
  function reloadProjectView(): void {
    buildTree();
    applyCompleted();
    if (schema.tasks.length > 0) selectTask(schema.tasks[0]);
    void validateSelection([...enabled]);
    refreshConflicts();
    void previewer.refresh(projectRoot());
  }

  // New project: reset configuration to defaults (UI preferences untouched).
  $<HTMLButtonElement>("#new-project").addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        "Start a new project? This resets all settings to defaults. Your UI preferences (theme, panel sizes, pipeline location) are kept.",
        "New project",
      );
      if (!ok) return;
      store.resetConfig();
      enabled.clear();
      for (const t of schema.tasks) if (!t.optional) enabled.add(t.id);
      completed.clear();
      reopened.clear();
      reloadProjectView();
    })();
  });

  // Open project: pick a folder, validate it's a pipeline project, restore its
  // saved configuration, and reflect which steps are already completed.
  $<HTMLButtonElement>("#open-project").addEventListener("click", () => {
    void (async () => {
      const picked = await pickPath(
        { kind: "directory" },
        { title: "Open a project folder" },
      );
      if (!picked || picked.length === 0) return;
      const folder = picked[0];
      if (!(await ipc.pathExists(`${folder}/project.yml`))) {
        await confirmDialog(
          `That folder isn't a video-pipeline project (no project.yml found):\n${folder}`,
          "Not a project folder",
        );
        return;
      }
      let restored = false;
      try {
        const raw = await ipc.readProjectState(folder);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            formValues?: Record<string, unknown>;
            enabled?: string[];
          };
          if (parsed.formValues) {
            store.replaceFormValues(parsed.formValues);
            restored = true;
          }
          if (parsed.enabled) {
            enabled.clear();
            for (const id of parsed.enabled) enabled.add(id);
          }
        }
      } catch {
        /* a malformed sidecar shouldn't block opening the folder */
      }
      if (!restored) {
        // No saved config — seed the project root from the folder path.
        const slash = Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\"));
        store.setFormValue("project.init.root", slash >= 0 ? folder.slice(0, slash) : folder);
        store.setFormValue("project.init.name", slash >= 0 ? folder.slice(slash + 1) : folder);
      }
      reopened.clear();
      completed.clear();
      reloadProjectView();
      await refreshCompleted();
    })();
  });

  // ---- resizable + collapsible panel wiring (restored from saved state) ----
  function setupPanels(): void {
    const grid = $("#grid");
    const center = $("#center");
    const right = $("#right");
    const saved = store.getPanels();
    const mark = (btn: HTMLElement, c: boolean) =>
      (btn.dataset.collapsed = String(c));

    // center | right — resizes the whole right panel; collapse hides it.
    makeSplitter({
      handle: $("#right-split"),
      axis: "x",
      min: 260,
      max: 620,
      collapseAt: 150,
      initialSize: saved.rightWidth ?? 340,
      initialCollapsed: saved.rightCollapsed,
      onChange: (px, c) => {
        grid.style.setProperty("--right-w", `${c ? 0 : px}px`);
        grid.classList.toggle("right-collapsed", c);
        store.setPanels({ rightWidth: px, rightCollapsed: c });
      },
    });

    // preview | help (inside right) — preview keeps the remainder; help collapses.
    const helpSplit = makeSplitter({
      handle: $("#right-help-split"),
      axis: "y",
      min: 90,
      max: 460,
      collapseAt: 56,
      initialSize: saved.helpHeight ?? 220,
      initialCollapsed: saved.helpCollapsed,
      onChange: (px, c) => {
        right.style.setProperty("--help-h", `${c ? 0 : px}px`);
        right.classList.toggle("help-collapsed", c);
        mark($("#help-collapse"), c);
        store.setPanels({ helpHeight: px, helpCollapsed: c });
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
      initialSize: saved.logHeight ?? 200,
      initialCollapsed: saved.logCollapsed,
      onChange: (px, c) => {
        center.style.setProperty("--log-h", `${c ? 0 : px}px`);
        center.classList.toggle("log-collapsed", c);
        mark($("#log-collapse"), c);
        store.setPanels({ logHeight: px, logCollapsed: c });
      },
    });
    $("#log-collapse").addEventListener("click", () => logSplit.toggle());
  }
}

void boot();
