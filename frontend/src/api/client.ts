import { API_BASE_URL, USE_MOCK_API } from "./config";
import type { ExecuteRequest, ExecuteResponse, Lane, Machine, ProxyHealth, Run, RunEvent, ScaffoldResponse, Workspace } from "./types";

import { liveRuns, machineFromHealth } from "./live";
import { exampleFixtures } from "../model/examples";

async function requestUrl<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let detail: { message?: string; error?: string } | null = null;
    try { detail = JSON.parse(text); } catch { /* An upstream error may be plain text. */ }
    throw new Error(detail?.message || detail?.error || text || `Request failed (${response.status}). Try again.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function request<T>(path: string, options?: RequestInit) {
  if (!USE_MOCK_API && !["/health", "/execute"].includes(path)) return Promise.reject<T>(new Error("This feature is unavailable with the execution proxy."));
  return requestUrl<T>(`${API_BASE_URL}${path}`, options);
}

export const generateScaffold = (body: { dsl: string; language: Lane["language"]; arch: Lane["arch"] }, signal?: AbortSignal) =>
  requestUrl<ScaffoldResponse>("/api/scaffold", {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const getMachines = async (signal?: AbortSignal): Promise<Machine[]> => USE_MOCK_API
  ? request<Machine[]>("/machines", { signal })
  : [machineFromHealth(await request<ProxyHealth>("/health", { signal }))];
export const getExamples = async (signal?: AbortSignal): Promise<typeof exampleFixtures> => {
  if (USE_MOCK_API) return request<typeof exampleFixtures>("/examples", { signal });
  const [machine] = await getMachines(signal);
  return exampleFixtures.filter((example) => example.id !== "ffi-overhead").map((example) => ({
    ...example, runId: undefined,
    workspace: { ...example.workspace, lanes: example.workspace.lanes.filter((lane) => machine.languages?.includes(lane.language)).map((lane) => ({ ...lane, arch: machine.arch })) },
  })).filter((example) => example.workspace.lanes.length > 0);
};
export const execute = (body: ExecuteRequest, signal: AbortSignal) => request<ExecuteResponse>("/execute", {
  method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
export const getRun = async (id: string, signal?: AbortSignal): Promise<Run> => {
  if (USE_MOCK_API) return request<Run>(`/runs/${encodeURIComponent(id)}`, { signal });
  const run = liveRuns.get(id);
  if (!run) throw new Error("This live result is unavailable. Results are kept only in the current tab; run the benchmark again.");
  return run;
};
export const startRun = (workspace: Workspace) => request<{ runId: string }>("/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspace }),
});
export const cancelRun = (id: string) => request<void>(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

export function subscribeToRun(id: string, onEvent: (event: RunEvent) => void, onDisconnect: () => void) {
  const stream = new EventSource(`${API_BASE_URL}/runs/${encodeURIComponent(id)}/events`);
  stream.onmessage = ({ data }) => {
    const event = JSON.parse(data) as RunEvent;
    if (event.type === "done" || event.type === "error") stream.close();
    onEvent(event);
  };
  stream.onerror = onDisconnect;
  return () => stream.close();
}

export function send<T>(path: string, body: unknown, method = "POST") {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
