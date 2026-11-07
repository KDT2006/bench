import { create } from "zustand";
import type { FileName, Lane, Run, RunEvent, Workspace } from "../api/types";
import { starterWorkspace } from "./examples";
import { laneColors } from "./format";

export type Panel = "live" | "sweep" | "build" | "log";
export interface ActiveRun {
  id: string;
  status: Run["status"];
  snapshot: Workspace;
  rows: Run["rows"];
  events: { event: RunEvent; at: number }[];
  disconnected?: boolean;
}
export interface Notice { text: string; error?: boolean; href?: string }
export interface HistoryEntry { id: string; title: string; status: Run["status"]; machine: string; start: string; finish?: string }

const draftKey = "benchscope-workspace-v1";
export function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; }
  catch { return fallback; }
}
export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be disabled */ }
}
export const saveDraft = (workspace: Workspace) => writeLocal(draftKey, workspace);
export function validWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const data = value as Workspace;
  return typeof data.title === "string" && typeof data.linkDsl === "boolean" &&
    typeof data.createdAt === "string" && typeof data.updatedAt === "string" &&
    Array.isArray(data.lanes) && data.lanes.length > 0 && data.lanes.length <= 4 &&
    new Set(data.lanes.map((lane) => lane?.id)).size === data.lanes.length &&
    new Set(data.lanes.map((lane) => lane?.label)).size === data.lanes.length &&
    data.lanes.every((lane) => lane && typeof lane.id === "string" && Object.hasOwn(laneColors, lane.label) &&
      ["go", "python"].includes(lane.language) && ["x86_64", "arm64"].includes(lane.arch) &&
      ["scaffold", "ejected"].includes(lane.mode) && lane.files && Object.values(lane.files).every((text) => typeof text === "string") &&
      lane.build && typeof lane.build.toolchainVersion === "string" && Array.isArray(lane.build.flags) && lane.build.env &&
      lane.runner && Array.isArray(lane.runner.counters));
}
const draft = readLocal<unknown>(draftKey, null);
const layoutKey = "benchscope-layout-v1";
interface Layout { panel: Panel; collapsed: boolean; grid: boolean; height: number; widths: Record<string, number> }

interface BenchState {
  workspace: Workspace;
  dirty: boolean;
  active: ActiveRun | null;
  lastRun: Run | null;
  history: HistoryEntry[];
  pending: boolean;
  cancelPending: boolean;
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
  dirty: false, active: null, lastRun: null, pending: false, cancelPending: false,
  generating: [], notice: null,
  history: readLocal<HistoryEntry[]>("benchscope-history-v1", []),
  layout: { panel: "sweep", collapsed: false, grid: false, height: 360, widths: {}, ...readLocal<Partial<Layout>>(layoutKey, {}) },
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
  return { ...copy, id: undefined, createdAt: now, updatedAt: now };
}

export function replaceWorkspace(workspace: Workspace, dirty = true) {
  const state = useBench.getState();
  if (state.dirty && !window.confirm("Replace the current workbench? Save it first to keep your changes.")) return false;
  state.setWorkspace(workspace, dirty);
  useBench.setState({ lastRun: null, ...(state.active && ["done", "failed", "cancelled"].includes(state.active.status) ? { active: null } : {}) });
  return true;
}
