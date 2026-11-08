import type { Lane, ResultRow } from "../api/types";
import { laneVar, paramsKey, type Metric, type Statistic } from "../model/format";

export const chartTypes = ["line", "ratio", "bars", "heatmap", "scatter"] as const;
export type ChartType = typeof chartTypes[number];
export type Normalize = "raw" | "element" | "byte";
export type YScale = "auto" | "linear" | "log";
export interface ChartSettings {
  type: ChartType; metric: Metric; stat: Statistic; x: string; logX: boolean; yScale: YScale;
  normalize: Normalize; size: string; group: string; compareMetric: Metric; heatLane: string;
}
export const defaultChart: ChartSettings = { type: "line", metric: "timeNs", stat: "min", x: "N", logX: true, yScale: "auto", normalize: "element", size: "N", group: "", compareMetric: "cycles", heatLane: "" };
export const shapes = { A: "circle", B: "rect", C: "triangle", D: "diamond" };

export function LaneBadge({ lane }: { lane: Lane }) {
  return <span className="lane-badge" style={{ "--channel": laneVar(lane.label) } as React.CSSProperties} aria-label={`Lane ${lane.label}`}>{lane.label}</span>;
}

export function measurement(row: ResultRow, settings: ChartSettings) {
  const value = row.metrics[settings.metric]?.[settings.stat];
  const size = row.params[settings.size];
  if (value === undefined) return undefined;
  if (settings.normalize === "raw") return value;
  return typeof size === "number" && size > 0 ? value / size : undefined;
}

export function shouldUseLogYAxis(rows: ResultRow[], lanes: Lane[], settings: ChartSettings) {
  if (settings.type === "heatmap") return false;
  if (settings.yScale !== "auto") return settings.yScale === "log";
  if (settings.type !== "line" || lanes.length < 2) return false;

  const laneIds = new Set(lanes.map((lane) => lane.id));
  const byParams = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!laneIds.has(row.laneId)) continue;
    const value = measurement(row, settings);
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) return false;
    const key = paramsKey(row.params);
    const group = byParams.get(key) ?? new Map<string, number>();
    group.set(row.laneId, value);
    byParams.set(key, group);
  }
  return Array.from(byParams.values()).some((group) => {
    const values = [...group.values()];
    return values.length > 1 && Math.max(...values) / Math.min(...values) > 10;
  });
}

export function laneRatio(rows: ResultRow[], lanes: Lane[], metric: Metric, stat: Statistic) {
  const anchor = lanes[0];
  const base = new Map(rows.filter((row) => row.laneId === anchor?.id).map((row) => [paramsKey(row.params), row.metrics[metric]?.[stat]]));
  return (row: ResultRow) => {
    const value = row.metrics[metric]?.[stat];
    const reference = base.get(paramsKey(row.params));
    return value === undefined || !reference ? undefined : value / reference;
  };
}
