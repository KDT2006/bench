import { API_BASE_URL } from "./config";
import type { Machine, Run, RunEvent, Workspace } from "./types";

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(detail?.message || `Request failed (${response.status}). Try again.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const getMachines = (signal?: AbortSignal) => request<Machine[]>("/machines", { signal });
export const getRun = (id: string, signal?: AbortSignal) => request<Run>(`/runs/${encodeURIComponent(id)}`, { signal });
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
