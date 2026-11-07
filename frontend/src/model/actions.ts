import { startTransition, useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { cancelRun, generateScaffold, getRun, send, startRun, subscribeToRun } from "../api/client";
import type { Lane, Run, RunEvent, Workspace } from "../api/types";
import { usePreferences } from "../shell/preferences";
import { diagnostics } from "./dsl";
import { MAX_SCAFFOLD_CHARACTERS, scaffoldLength, scaffoldLimitMessage } from "./scaffoldLimits";
import { harness, languages, num } from "./format";
import { saveDraft, useBench, writeLocal } from "./state";

const state = useBench.getState;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed. Try again.";
const sourceOf = (lane: Lane) => lane.files["benchmark.perf"] ?? "";

export function scaffoldKey(lane: Lane) {
  const source = JSON.stringify([sourceOf(lane), lane.language, lane.arch]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function isStale(lane: Lane) {
  return lane.mode === "scaffold" && (!lane.files[harness(lane.language)] || scaffoldKey(lane) !== lane.scaffold?.dslHash);
}

async function generate(lane: Lane, reportFailure: boolean): Promise<Lane> {
  if (state().generating.includes(lane.id)) throw new Error(`Lane ${lane.label} is already generating code.`);
  useBench.setState((previous) => ({ generating: [...previous.generating, lane.id] }));
  try {
    const result = await generateScaffold({ dsl: sourceOf(lane), language: lane.language, arch: lane.arch });
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

export async function runBench(query: QueryClient) {
  const { workspace, pending, active, generating } = state();
  if (pending || (active && !isFinished(active.status))) return;
  const invalid = workspace.lanes.flatMap((lane) => lane.mode === "scaffold" ? diagnostics(sourceOf(lane)).map(({ message }) => `Lane ${lane.label}: ${message}`) : []);
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
