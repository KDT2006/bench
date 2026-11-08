import { API_BASE_URL } from "./config";
import type { Example, ExecuteRequest, ExecuteResponse, Lane, Machine, ProxyHealth, Run, ScaffoldResponse } from "./types";
import { liveRuns, machineFromHealth } from "./live";
import { exampleFixtures } from "../model/examples";
import { sourceIssue } from "../model/assembly";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let detail: { message?: string; error?: string } | null = null;
    try { detail = JSON.parse(text); } catch { /* An upstream error may be plain text. */ }
    throw new Error(detail?.message || detail?.error || text || `Request failed (${response.status}). Try again.`);
  }
  return response.json() as Promise<T>;
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const generateScaffold = (body: { dsl: string; language: Lane["language"]; arch: Lane["arch"] }, signal?: AbortSignal) =>
  request<ScaffoldResponse>("/api/scaffold", post(body, signal));

export const getMachines = async (signal?: AbortSignal): Promise<Machine[]> => {
  const health = await request<ProxyHealth>(`${API_BASE_URL}/health`, { signal });
  if (health.unavailable.length) throw new Error(health.unavailable.map(({ language, message }) => `${language}: ${message}`).join("; "));
  return health.machines.map(machineFromHealth);
};

export const getExamples = async (signal?: AbortSignal): Promise<Example[]> => {
  const machines = await getMachines(signal);
  return exampleFixtures.map((example) => ({
    ...example,
    workspace: { ...example.workspace, lanes: example.workspace.lanes.flatMap((lane) => {
      const machine = machines.find((machine) => machine.languages?.includes(lane.language));
      return machine ? [{ ...lane, arch: machine.arch }] : [];
    }) },
  })).filter((example) => example.workspace.lanes.length > 0);
};

export const execute = (body: ExecuteRequest, signal: AbortSignal) => {
  const issue = sourceIssue(body.code, "code") ?? sourceIssue(body.assembly ?? "", "assembly");
  if (issue) throw new Error(issue);
  return request<ExecuteResponse>(`${API_BASE_URL}/execute`, post(body, signal));
};

export const getRun = async (id: string): Promise<Run> => {
  const run = liveRuns.get(id);
  if (!run) throw new Error("This live result is unavailable. Results are kept only in the current tab; run the benchmark again.");
  return run;
};
