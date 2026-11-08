import { startTransition, useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { cancelRun, execute, generateScaffold, getMachines, getRun, send, startRun, subscribeToRun } from "../api/client";
import type { Lane, Run, RunEvent, Workspace } from "../api/types";
import { usePreferences } from "../shell/preferences";
import { USE_MOCK_API } from "../api/config";
import { liveRuns, resultRow } from "../api/live";
import { assembleSections, parseSections, SCAFFOLD_FORMAT_VERSION } from "./sections";
import { parseSweep, serializeSweep, sweepMatrix } from "./sweep";
import { diagnostics } from "./dsl";
import { MAX_SCAFFOLD_CHARACTERS, scaffoldLength, scaffoldLimitMessage } from "./scaffoldLimits";
import { harness, languages, num } from "./format";
import { saveDraft, useBench, writeLocal } from "./state";

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

async function generate(lane: Lane, reportFailure: boolean, signal?: AbortSignal): Promise<Lane> {
  if (state().generating.includes(lane.id)) throw new Error(`Lane ${lane.label} is already generating code.`);
  useBench.setState((previous) => ({ generating: [...previous.generating, lane.id] }));
  try {
    const result = await generateScaffold({ dsl: sourceOf(lane), language: lane.language, arch: lane.arch }, signal);
    const file = harness(lane.language);
    const next = { ...lane, files: { ...lane.files, [file]: result.code }, scaffold: {
      dslHash: scaffoldKey(lane), model: result.model, cached: result.cached, warnings: result.warnings,
    } };
    const current = state().workspace.lanes.find((entry) => entry.id === lane.id);
    if (current?.mode === "scaffold" && scaffoldKey(current) === scaffoldKey(lane)) {
      state().changeLane(lane.id, (entry) => ({ ...entry, files: { ...entry.files, [file]: result.code }, scaffold: next.scaffold }));
    }
    return next;
  } catch (error) {
    if (reportFailure) state().notify({ text: `Lane ${lane.label}: ${message(error)}`, error: true });
    throw error;
  } finally {
    useBench.setState((previous) => ({ generating: previous.generating.filter((id) => id !== lane.id) }));
  }
}

export async function generateLane(lane: Lane) {
  if (state().pending) return state().notify({ text: "Wait for the current run before generating code.", error: true });
  const dsl = sourceOf(lane);
  if (scaffoldLength(dsl) > MAX_SCAFFOLD_CHARACTERS) return state().notify({ text: scaffoldLimitMessage, error: true });
  const errors = diagnostics(dsl);
  if (errors.length) return state().notify({ text: `Lane ${lane.label}: ${errors[0].message}`, error: true });
  try {
    await generate(lane, true);
    state().notify({ text: `${languages[lane.language]} code generated.` });
  } catch { /* the notice above reports the failure */ }
}

let unsubscribe: (() => void) | undefined;
let pendingEvents: { event: RunEvent; at: number }[] = [];
let frame: number | undefined;
let settling: string | undefined;
const isFinished = (status: Run["status"]) => ["done", "failed", "cancelled"].includes(status);

function flush() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  const batch = pendingEvents;
  pendingEvents = [];
  const active = state().active;
  if (!active || !batch.length) return;
  const rows = batch.flatMap(({ event }) => event.type === "result" ? [event.row] : []);
  const phase = batch.findLast(({ event }) => ["queued", "build_start", "perm_start"].includes(event.type))?.event.type;
  useBench.setState({
    active: {
      ...active, rows: [...active.rows, ...rows], events: [...active.events, ...batch], disconnected: false,
      status: phase === "perm_start" ? "running" : phase === "build_start" ? "building" : active.status,
    },
  });
}

function record(run: Run) {
  const history = [{ id: run.id, title: run.workspaceSnapshot.title, status: run.status, machine: run.machine.cpuModel, start: run.startedAt, finish: run.finishedAt },
    ...state().history.filter((entry) => entry.id !== run.id)];
  writeLocal("benchscope-history-v1", history);
  return history;
}

async function settle(id: string, query: QueryClient, error?: string) {
  if (state().active?.id !== id || settling === id) return;
  settling = id;
  flush();
  unsubscribe?.();
  unsubscribe = undefined;
  try {
    const run = await getRun(id);
    query.setQueryData(["run", id], run);
    const active = state().active;
    if (!active || active.id !== id) return;
    useBench.setState({ active: { ...active, status: run.status, rows: run.rows }, lastRun: run, history: record(run) });
    if (run.status === "failed") state().setLayout({ panel: "build" });
    const total = active.events.find(({ event }) => event.type === "perm_start")?.event;
    const count = num.format(run.rows.length);
    state().notify({
      text: run.status === "cancelled" ? `Run cancelled. ${count}${total?.type === "perm_start" ? ` of ${num.format(total.total * run.workspaceSnapshot.lanes.length)}` : ""} results kept.`
        : run.status === "failed" ? error ?? "The run failed. Open Build output to inspect the logs."
          : `Run finished. ${count} results.`,
      error: run.status === "failed",
      href: `/results/${id}`,
    });
  } catch (cause) {
    const active = state().active;
    if (active?.id === id) useBench.setState({ active: { ...active, status: "failed" } });
    state().notify({ text: message(cause), error: true, href: `/results/${id}` });
  } finally {
    if (settling === id) settling = undefined;
    void query.invalidateQueries({ queryKey: ["machines"] });
  }
}

let liveController: AbortController | undefined;

async function runLive(query: QueryClient) {
  const current = state();
  if (current.pending || liveController || (current.active && !isFinished(current.active.status))) return;
  if (current.generating.length) return current.notify({ text: "Wait for code generation to finish.", error: true });
  const snapshot = structuredClone(current.workspace);
  snapshot.title = snapshot.title.trim() || "Untitled bench";
  for (const lane of snapshot.lanes) {
    const dsl = sourceOf(lane);
    const issues = lane.mode === "scaffold" ? diagnostics(dsl) : [...parseSections(dsl).errors,
      ...parseSweep(dsl).errors.map((message) => ({ message }))];
    if (issues.length) return current.notify({ text: `Lane ${lane.label}: ${issues[0].message}`, error: true });
    if (isStale(lane) && scaffoldLength(dsl) > MAX_SCAFFOLD_CHARACTERS) return current.notify({ text: `Lane ${lane.label}: ${scaffoldLimitMessage}`, error: true });
    if (lane.files["kernel.S"]) return current.notify({ text: `Lane ${lane.label}: the execution proxy does not accept assembly files.`, error: true });
    if (lane.execution && (!Number.isSafeInteger(lane.execution.byteCount) || lane.execution.byteCount < 0 || typeof lane.execution.fenced !== "boolean")) return current.notify({ text: `Lane ${lane.label}: invalid execution options.`, error: true });
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
    const [machine] = await getMachines(controller.signal);
    controller.signal.throwIfAborted();
    for (const lane of snapshot.lanes) {
      if (lane.arch !== machine.arch) throw new Error(`Lane ${lane.label}: select the server architecture (${machine.arch}).`);
      if (!machine.languages?.includes(lane.language)) throw new Error(`Lane ${lane.label}: no ${languages[lane.language]} executor is configured.`);
    }
    const sweep = [...new Set(snapshot.lanes.flatMap((lane) => parseSweep(sourceOf(lane)).sweep.map(({ name }) => name)))].map((name) => ({
      name, values: [...new Set(snapshot.lanes.flatMap((lane) => parseSweep(sourceOf(lane)).sweep.find((entry) => entry.name === name)?.values ?? []))],
    }));
    run = { id, workspaceSnapshot: snapshot, machine, status: "building", sweep, rows: [], startedAt: new Date().toISOString(), source: "live" };
    publish({ type: "queued", position: 0 });
    for (let laneIndex = 0; laneIndex < snapshot.lanes.length; laneIndex++) {
      controller.signal.throwIfAborted();
      let lane = snapshot.lanes[laneIndex];
      executingLane = lane;
      run = { ...run, status: "building" };
      publish({ type: "build_start", laneId: lane.id });
      if (isStale(lane)) lane = await generate(lane, false, controller.signal);
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
          language: lane.language, arch: `${machine.os}/${machine.arch === "x86_64" ? "amd64" : "arm64"}`,
          code: assembleSections({ ...document.sections, sweep: serializeSweep(Object.entries(params).map(([name, value]) => ({ name, values: [value] }))) }),
        }, controller.signal);
        controller.signal.throwIfAborted();
        if (!Array.isArray(response.results) || response.results.length !== 1) throw new Error("Expected one result for the submitted sweep combination.");
        const row = resultRow(response.results[0], lane.id, params);
        run = { ...run, rows: [...run.rows, row] };
        publish({ type: "result", laneId: lane.id, row });
      }
      publish({ type: "build_done", laneId: lane.id, ok: true, log: "Generation and execution completed." });
    }
    run = { ...run, status: "done", finishedAt: new Date().toISOString() };
    publish({ type: "done" });
    state().notify({ text: `Run finished. ${num.format(run.rows.length)} results.`, href: `/results/${id}` });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const text = cancelled ? `Run cancelled. ${run?.rows.length ?? 0} results kept.` : `${executingLane ? `Lane ${executingLane.label}: ` : ""}${message(error)}`;
    if (run) {
      run = { ...run, status: cancelled ? "cancelled" : "failed", finishedAt: new Date().toISOString() };
      if (!cancelled && executingLane) publish({ type: "build_done", laneId: executingLane.id, ok: false, log: text });
      publish(cancelled ? { type: "done" } : { type: "error", message: text });
    } else useBench.setState({ active: null });
    if (!cancelled) state().setLayout({ panel: "build" });
    state().notify({ text, error: !cancelled, href: run ? `/results/${id}` : undefined });
  } finally {
    if (run) useBench.setState({ lastRun: run });
    liveController = undefined;
    useBench.setState({ pending: false, cancelPending: false });
    void query.invalidateQueries({ queryKey: ["machines"] });
  }
}

export async function runBench(query: QueryClient) {
  if (!USE_MOCK_API) return runLive(query);
  const { workspace, pending, active, generating } = state();
  if (pending || (active && !isFinished(active.status))) return;
  const invalid = workspace.lanes.flatMap((lane) => {
    const dsl = sourceOf(lane);
    const issues = lane.mode === "scaffold" ? diagnostics(dsl).map(({ message }) => message) : parseSweep(dsl).errors;
    return issues.map((issue) => `Lane ${lane.label}: ${issue}`);
  });
  if (invalid.length) return state().notify({ text: invalid[0], error: true });
  const tooLong = workspace.lanes.find((lane) => isStale(lane) && scaffoldLength(sourceOf(lane)) > MAX_SCAFFOLD_CHARACTERS);
  if (tooLong) return state().notify({ text: `Lane ${tooLong.label}. ${scaffoldLimitMessage}`, error: true });
  if (generating.length) return state().notify({ text: "Wait for code generation to finish, then run again.", error: true });
  useBench.setState({ pending: true, active: null, lastRun: null, notice: null });
  state().setLayout({ panel: "live", collapsed: false });
  try {
    const snapshot = structuredClone(workspace);
    snapshot.title = snapshot.title.trim() || "Untitled bench";
    snapshot.lanes = await Promise.all(snapshot.lanes.map((lane) => isStale(lane) ? generate(lane, false) : lane));
    const { runId } = await startRun(snapshot);
    useBench.setState({ active: { id: runId, snapshot, status: "queued", rows: [], events: [] } });
    void query.invalidateQueries({ queryKey: ["machines"] });
    unsubscribe = subscribeToRun(runId, (event) => {
      if (state().active?.id !== runId) return;
      pendingEvents.push({ event, at: Date.now() });
      if (event.type === "done" || event.type === "error") void settle(runId, query, event.type === "error" ? event.message : undefined);
      else if (frame === undefined) frame = requestAnimationFrame(() => startTransition(flush));
    }, () => {
      const active = state().active;
      if (active?.id !== runId || isFinished(active.status)) return;
      useBench.setState({ active: { ...active, disconnected: true } });
      void getRun(runId).then((run) => { if (isFinished(run.status)) void settle(runId, query); }).catch(() => {});
    });
  } catch (error) {
    state().notify({ text: message(error), error: true });
  } finally {
    useBench.setState({ pending: false });
  }
}

export async function stopBench(query: QueryClient) {
  if (!USE_MOCK_API) { liveController?.abort(); return; }
  const { active, cancelPending } = state();
  if (!active || cancelPending || isFinished(active.status)) return;
  useBench.setState({ cancelPending: true });
  try {
    await cancelRun(active.id);
    const run = await getRun(active.id);
    if (isFinished(run.status)) await settle(active.id, query);
  } catch (error) {
    state().notify({ text: message(error), error: true });
  } finally {
    useBench.setState({ cancelPending: false });
  }
}

export async function saveBench(query: QueryClient) {
  if (!USE_MOCK_API) return state().notify({ text: "Saving benches is unavailable with the execution proxy.", error: true });
  const { workspace } = state();
  try {
    const snapshot: Workspace = { ...workspace, title: workspace.title.trim() || "Untitled bench" };
    const saved = workspace.id ? await send<Workspace>(`/benches/${encodeURIComponent(workspace.id)}`, snapshot, "PUT")
      : await send<Workspace>("/benches", snapshot);
    if (state().workspace === workspace) state().setWorkspace(saved);
    else if (state().workspace.createdAt === workspace.createdAt) {
      state().setWorkspace({ ...state().workspace, id: saved.id }, true);
    }
    void query.invalidateQueries({ queryKey: ["benches"] });
    state().notify({ text: "Saved." });
  } catch (error) {
    state().notify({ text: message(error), error: true });
  }
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
