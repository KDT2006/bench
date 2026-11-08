import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { execute, generateScaffold, getMachines } from "../api/client";
import type { Lane, Run, RunEvent } from "../api/types";
import { usePreferences } from "../shell/preferences";
import { liveRuns, resultRow } from "../api/live";
import { assembleSections, parseSections, SCAFFOLD_FORMAT_VERSION } from "./sections";
import { parseSweep, serializeSweep, sweepMatrix, unionSweep } from "./sweep";
import { diagnostics } from "./dsl";
import { buildErrorLine, harness, languages, num } from "./format";
import { saveDraft, useBench } from "./state";

const state = useBench.getState;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed. Try again.";
const sourceOf = (lane: Lane) => lane.files["benchmark.perf"] ?? "";

export function scaffoldKey(lane: Lane) {
  const source = JSON.stringify([SCAFFOLD_FORMAT_VERSION, sourceOf(lane), lane.language, lane.arch]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function isStale(lane: Lane) {
  return lane.mode === "scaffold" && (!lane.files[harness(lane.language)] || scaffoldKey(lane) !== lane.scaffold?.dslHash);
}

/** Translates a lane. `applied` is false when the DSL changed during translation and the result was discarded. */
async function generate(lane: Lane, reportFailure: boolean, signal?: AbortSignal): Promise<{ lane: Lane; applied: boolean }> {
  if (state().generating.includes(lane.id)) throw new Error(`Lane ${lane.label} is already generating code.`);
  useBench.setState((previous) => ({ generating: [...previous.generating, lane.id] }));
  try {
    const result = await generateScaffold({ dsl: sourceOf(lane), language: lane.language, arch: lane.arch }, signal);
    const file = harness(lane.language);
    const next = { ...lane, files: { ...lane.files, [file]: result.code }, scaffold: {
      dslHash: scaffoldKey(lane), model: result.model, warnings: result.warnings,
    } };
    const current = state().workspace.lanes.find((entry) => entry.id === lane.id);
    const applied = current?.mode === "scaffold" && scaffoldKey(current) === scaffoldKey(lane);
    if (applied) state().changeLane(lane.id, (entry) => ({ ...entry, files: { ...entry.files, [file]: result.code }, scaffold: next.scaffold }));
    return { lane: next, applied };
  } catch (error) {
    if (reportFailure) state().notify({ text: `Lane ${lane.label}: ${message(error)}`, error: true });
    throw error;
  } finally {
    useBench.setState((previous) => ({ generating: previous.generating.filter((id) => id !== lane.id) }));
  }
}

export async function generateLane(lane: Lane) {
  if (state().pending) return state().notify({ text: "Wait for the current run before generating code.", error: true });
  const errors = diagnostics(sourceOf(lane));
  if (errors.length) return state().notify({ text: `Lane ${lane.label}: ${errors[0].message}`, error: true });
  try {
    const { applied } = await generate(lane, true);
    state().notify(applied ? { text: `${languages[lane.language]} code generated.` }
      : { text: `Lane ${lane.label}: the DSL changed during translation. Translate again.`, error: true });
  } catch { /* the notice above reports the failure */ }
}

let liveController: AbortController | undefined;

export async function runBench(query: QueryClient) {
  const current = state();
  if (current.pending || liveController) return;
  if (current.generating.length) return current.notify({ text: "Wait for code generation to finish.", error: true });
  const snapshot = structuredClone(current.workspace);
  snapshot.title = snapshot.title.trim() || "Untitled bench";
  for (const lane of snapshot.lanes) {
    const dsl = sourceOf(lane);
    const issues = lane.mode === "scaffold" ? diagnostics(dsl) : [...parseSections(dsl).errors,
      ...parseSweep(dsl).errors.map((message) => ({ message }))];
    if (issues.length) return current.notify({ text: `Lane ${lane.label}: ${issues[0].message}`, error: true });
  }
  const controller = new AbortController();
  liveController = controller;
  const id = crypto.randomUUID();
  const events: { event: RunEvent; at: number }[] = [];
  let run: Run | undefined;
  let executingLane: Lane | undefined;
  useBench.setState({ pending: true, lastRun: null, notice: null, active: { id, snapshot, rows: [], events, status: "queued" } });
  current.setLayout({ panel: "live", collapsed: false });
  const publish = (event: RunEvent) => {
    events.push({ event, at: Date.now() });
    if (!run) return;
    liveRuns.set(id, run);
    query.setQueryData(["run", id], run);
    useBench.setState({ active: { id, snapshot: run.workspaceSnapshot, rows: run.rows, status: run.status, events: [...events] } });
  };
  try {
    const machines = (await getMachines(controller.signal)).filter((target) =>
      snapshot.lanes.some((lane) => target.languages?.includes(lane.language)));
    const machine = machines[0];
    if (!machine) throw new Error("No execution targets are available.");
    controller.signal.throwIfAborted();
    for (const lane of snapshot.lanes) {
      const target = machines.find((machine) => machine.languages?.includes(lane.language) && machine.arch === lane.arch);
      if (!target) throw new Error(`Lane ${lane.label}: no ${languages[lane.language]} executor is available for ${lane.arch}.`);
    }
    run = { id, workspaceSnapshot: snapshot, machine, machines, status: "building", sweep: unionSweep(snapshot.lanes), rows: [], startedAt: new Date().toISOString() };
    publish({ type: "queued" });
    for (let laneIndex = 0; laneIndex < snapshot.lanes.length; laneIndex++) {
      controller.signal.throwIfAborted();
      let lane = snapshot.lanes[laneIndex];
      const target = machines.find((machine) => machine.languages?.includes(lane.language) && machine.arch === lane.arch)!;
      executingLane = lane;
      run = { ...run, status: "building" };
      const translating = isStale(lane);
      publish({ type: "build_start", laneId: lane.id, translating });
      if (translating) lane = (await generate(lane, false, controller.signal)).lane;
      controller.signal.throwIfAborted();
      snapshot.lanes[laneIndex] = lane;
      const document = parseSections(lane.files[harness(lane.language)] ?? "");
      if (document.errors.length) throw new Error(document.errors[0].message);
      const permutations = sweepMatrix(parseSweep(sourceOf(lane)).sweep);
      for (const [index, params] of permutations.entries()) {
        controller.signal.throwIfAborted();
        run = { ...run, status: "running" };
        publish({ type: "perm_start", laneId: lane.id, index: index + 1, total: permutations.length, params });
        const response = await execute({
          name: `${snapshot.title} · Lane ${lane.label}`, byteCount: lane.execution?.byteCount ?? 0, fenced: lane.execution?.fenced ?? true,
          language: lane.language, arch: `${target.os}/${target.arch === "x86_64" ? "amd64" : "arm64"}`,
          code: assembleSections({ ...document.sections, sweep: serializeSweep(Object.entries(params).map(([name, value]) => ({ name, values: [value] }))) }),
        }, controller.signal);
        controller.signal.throwIfAborted();
        const row = resultRow(response.results[0], lane.id, params);
        run = { ...run, rows: [...run.rows, row] };
        publish({ type: "result", laneId: lane.id, row });
      }
      publish({ type: "build_done", laneId: lane.id, ok: true, log: "Execution completed." });
    }
    run = { ...run, status: "done", finishedAt: new Date().toISOString() };
    publish({ type: "done" });
    state().notify({ text: `Run finished. ${num.format(run.rows.length)} results.`, href: `/results/${id}` });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const detail = message(error);
    const text = cancelled ? `Run cancelled. ${run?.rows.length ?? 0} results kept.` : `${executingLane ? `Lane ${executingLane.label}: ` : ""}${detail}`;
    if (run) {
      run = { ...run, status: cancelled ? "cancelled" : "failed", finishedAt: new Date().toISOString() };
      // Only compiler diagnostics count as a build failure; anything else (proxy down, Gemini quota, executor 502) is an infrastructure error.
      if (!cancelled && executingLane && buildErrorLine(detail) !== undefined) publish({ type: "build_done", laneId: executingLane.id, ok: false, log: detail });
      publish(cancelled ? { type: "done" } : { type: "error", message: text, laneId: executingLane?.id });
    } else useBench.setState({ active: null });
    if (!cancelled) state().setLayout({ panel: "build" });
    state().notify({ text, error: !cancelled, href: run ? `/results/${id}` : undefined });
  } finally {
    if (run) useBench.setState({ lastRun: run });
    liveController = undefined;
    useBench.setState({ pending: false });
    void query.invalidateQueries({ queryKey: ["machines"] });
  }
}

export function stopBench() {
  liveController?.abort();
}

export function useDraftPersistence() {
  const workspace = useBench((s) => s.workspace);
  const dirty = useBench((s) => s.dirty);
  const autosave = usePreferences((s) => s.autosave);
  useEffect(() => {
    if (!autosave) return;
    const timer = window.setTimeout(() => saveDraft(workspace), 1000);
    return () => window.clearTimeout(timer);
  }, [autosave, workspace]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (autosave) { saveDraft(state().workspace); return; }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [autosave, dirty]);
}
