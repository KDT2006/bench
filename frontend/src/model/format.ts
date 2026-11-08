import type { Lane, ResultRow, Run, Stat } from "../api/types";
export const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const ratioNumber = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });
export function formatRatio(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${ratioNumber.format(value)}×`;
}
export const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const laneColors = { A: "#E6A23C", B: "#5DB7EA", C: "#D486B2", D: "#2FBF94" };
export const laneVar = (lane: Lane["label"]) => `var(--lane-${lane.toLowerCase()})`;
export const languages = { go: "Go", python: "Python" };
export const harness = (language: Lane["language"]) => language === "go" ? "harness.go" : "harness.py";
export const metricNames = { timeNs: "Time", cycles: "Timer ticks", pageFaults: "Page faults", cacheMisses: "L1 data-cache misses", branchMisses: "Branch-prediction misses", throughput: "Throughput" };
export type Metric = keyof typeof metricNames;
export type Statistic = keyof Stat;

export function bytes(value: number) {
  const units = [[1024 ** 3, "GiB"], [1024 ** 2, "MiB"], [1024, "KiB"], [1, "B"]] as const;
  const [factor, unit] = units.find(([factor]) => value >= factor) ?? units[3];
  return `${num.format(value / factor)} ${unit}`;
}

export function param(key: string, value: string | number) {
  return typeof value === "number" ? key === "N" && value >= 1024 ? bytes(value) : num.format(value) : value;
}

export const params = (values: ResultRow["params"]) => Object.entries(values).map(([key, value]) => `${key} = ${param(key, value)}`).join(" · ") || "Default";
export const paramsKey = (values: ResultRow["params"]) => JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
export function duration(from: string, to?: string) {
  return to ? `${num.format((Date.parse(to) - Date.parse(from)) / 1000)} s` : "In progress";
}

/** Nanoseconds in the largest unit that keeps the value at or above 1. */
export function time(ns: number) {
  const [scale, unit] = ([[1e9, "s"], [1e6, "ms"], [1e3, "µs"], [1, "ns"]] as const).find(([scale]) => Math.abs(ns) >= scale) ?? [1, "ns"];
  return `${num.format(ns / scale)} ${unit}`;
}

export function formatMetric(metric: Metric, value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return metric === "timeNs" ? time(value) : metric === "throughput" ? `${num.format(value)} GiB/s` : num.format(value);
}

/** Line number from a Go compiler (`harness.go:12:5:`) or Python (`line 12`) diagnostic. */
export function buildErrorLine(log: string) {
  const match = /\.(?:go|py):(\d+):|\bline (\d+)\b/.exec(log);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

const statusLabels: Record<Run["status"], string> = {
  queued: "Starting…", building: "Translating…", running: "Running", done: "Finished", failed: "Failed", cancelled: "Cancelled",
};
export function statusLabel(status: Run["status"], progress?: { index: number; total: number }) {
  return status === "running" && progress ? `Running ${num.format(progress.index)} of ${num.format(progress.total)}` : statusLabels[status];
}
