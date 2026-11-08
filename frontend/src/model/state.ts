import { create } from "zustand";
import type { FileName, Lane, Run, RunEvent, Workspace } from "../api/types";
import { starterWorkspace } from "./examples";

export type Panel = "live" | "sweep" | "build" | "log";
export interface ActiveRun {
  id: string;
  status: Run["status"];
  snapshot: Workspace;
  rows: Run["rows"];
  events: { event: RunEvent; at: number }[];
}
export interface Notice { text: string; error?: boolean; href?: string }

const draftKey = "benchscope-workspace-v1";
export function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; }
  catch { return fallback; }
}
export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be disabled */ }
}
export const saveDraft = (workspace: Workspace) => writeLocal(draftKey, workspace);
/** Minimal shape check so a draft from an older schema can't crash the app on load. */
export function validWorkspace(value: unknown): value is Workspace {
  const lanes = (value as Workspace | null)?.lanes;
  return Array.isArray(lanes) && lanes.length > 0 && lanes.every((lane) => lane && typeof lane.files === "object" && lane.files !== null);
}
const draft = readLocal<unknown>(draftKey, null);
const layoutKey = "benchscope-layout-v1";
interface Layout { panel: Panel; collapsed: boolean; height: number; widths: Record<string, number> }

interface BenchState {
  workspace: Workspace;
  dirty: boolean;
  active: ActiveRun | null;
  lastRun: Run | null;
  pending: boolean;
  generating: string[];
  notice: Notice | null;
  layout: Layout;
  setWorkspace: (workspace: Workspace, dirty?: boolean) => void;
  edit: (change: (workspace: Workspace) => Workspace) => void;
  changeLane: (id: string, change: (lane: Lane) => Lane) => void;
  editFile: (id: string, file: FileName, value: string) => void;
  setLayout: (patch: Partial<Layout>) => void;
  notify: (notice: Notice | null) => void;
}
export const useBench = create<BenchState>((set) => ({
  workspace: validWorkspace(draft) ? draft : starterWorkspace(),
  dirty: false, active: null, lastRun: null, pending: false,
  generating: [], notice: null,
  layout: { panel: "sweep", collapsed: false, height: 360, widths: {}, ...readLocal<Partial<Layout>>(layoutKey, {}) },
  setWorkspace: (workspace, dirty = false) => set({ workspace, dirty }),
  edit: (change) => set((state) => ({
    workspace: { ...change(state.workspace), updatedAt: new Date().toISOString() }, dirty: true,
  })),
  changeLane: (id, change) => useBench.getState().edit((workspace) => ({
    ...workspace, lanes: workspace.lanes.map((lane) => lane.id === id ? change(lane) : lane),
  })),
  editFile: (id, file, value) => useBench.getState().edit((workspace) => {
    const lane = workspace.lanes.find((entry) => entry.id === id);
    const linked = file === "benchmark.perf" && workspace.linkDsl && lane?.mode === "scaffold";
    return { ...workspace, lanes: workspace.lanes.map((entry) =>
      entry.id === id || (linked && entry.mode === "scaffold") ? { ...entry, files: { ...entry.files, [file]: value } } : entry) };
  }),
  setLayout: (patch) => set((state) => {
    const layout = { ...state.layout, ...patch };
    writeLocal(layoutKey, layout);
    return { layout };
  }),
  notify: (notice) => set({ notice }),
}));

export function freshWorkspace(workspace: Workspace) {
  const copy = structuredClone(workspace);
  const now = new Date().toISOString();
  return { ...copy, createdAt: now, updatedAt: now };
}

/** Swap in another workspace. Asks first only when the current one has edits made since it was loaded. */
export function replaceWorkspace(workspace: Workspace) {
  const state = useBench.getState();
  if (state.dirty && !window.confirm("Replace the current workbench? Your edits will be lost. Use Export bench first to keep a copy.")) return false;
  state.setWorkspace(workspace);
  useBench.setState({ lastRun: null, ...(state.active && ["done", "failed", "cancelled"].includes(state.active.status) ? { active: null } : {}) });
  return true;
}
