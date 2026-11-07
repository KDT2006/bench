import type { Lane, ResultRow } from "../api/types";
import { laneVar, paramsKey, type Metric, type Statistic } from "../model/format";

export const chartTypes = ["line", "ratio", "bars", "distribution", "heatmap", "scatter"] as const;
export type ChartType = typeof chartTypes[number];
export type Normalize = "raw" | "element" | "byte";
export interface ChartSettings {
  type: ChartType; metric: Metric; stat: Statistic; x: string; logX: boolean; logY: boolean;
  normalize: Normalize; size: string; caches: boolean; group: string; compareMetric: Metric; heatLane: string;
}
export const defaultChart: ChartSettings = { type: "line", metric: "cycles", stat: "min", x: "N", logX: true, logY: false, normalize: "element", size: "N", caches: true, group: "", compareMetric: "timeNs", heatLane: "" };
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

export function laneRatio(rows: ResultRow[], lanes: Lane[], metric: Metric, stat: Statistic) {
  const anchor = lanes[0];
  const base = new Map(rows.filter((row) => row.laneId === anchor?.id).map((row) => [paramsKey(row.params), row.metrics[metric]?.[stat]]));
  return (row: ResultRow) => {
    const value = row.metrics[metric]?.[stat];
    const reference = base.get(paramsKey(row.params));
    return value === undefined || !reference ? undefined : value / reference;
  };
}
