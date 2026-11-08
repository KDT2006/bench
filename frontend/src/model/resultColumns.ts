import type { ResultRow, Run } from "../api/types";
import { laneRatio, type ChartSettings } from "../chart/config";
import { metricNames } from "./format";

export interface ResultColumn {
  id: string;
  label: string;
  kind: "lane" | "param" | "number" | "time" | "ratio";
  unit?: string;
  value: (row: ResultRow) => string | number | undefined;
}

// Share the table's measurements, order and derived values with CSV export.
export function resultColumns(run: Run, settings: ChartSettings): ResultColumn[] {
  const lanes = run.workspaceSnapshot.lanes;
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const numeric = (id: string, label: string, value: ResultColumn["value"], unit?: string): ResultColumn => ({ id, label, value, unit, kind: "number" });
  const timed = (id: string, label: string, value: ResultColumn["value"]): ResultColumn => ({ id, label, value, unit: "ns", kind: "time" });
  const names = [...new Set([...run.sweep.map(({ name }) => name), ...run.rows.flatMap((row) => Object.keys(row.params))])];
  return [
    { id: "lane", label: "Lane", kind: "lane", value: (row) => byId.get(row.laneId)?.label ?? row.laneId },
    ...names.map((name): ResultColumn => ({ id: `param-${name}`, label: name, kind: "param", value: (row) => row.params[name] })),
    timed("time", "Min time", (row) => row.metrics.timeNs?.min),
    timed("timeMax", "Max time", (row) => row.metrics.timeNs?.max),
    timed("timeAvg", "Mean time", (row) => row.metrics.timeNs?.mean),
    ...(settings.size ? [timed("perSize", `Min time per ${settings.normalize === "byte" ? "byte" : "element"}`, (row) => {
      const size = row.params[settings.size];
      return typeof size === "number" && size > 0 && row.metrics.timeNs?.min !== undefined ? row.metrics.timeNs.min / size : undefined;
    })] : []),
    ...(["min", "max", "mean"] as const).map((key) => numeric(`ticks${key[0].toUpperCase() + key.slice(1)}`, `${key[0].toUpperCase() + key.slice(1)} timer ticks`, (row) => row.metrics.cycles?.[key])),
    numeric("reps", "Reps", (row) => row.reps),
    numeric("pageFaults", "Mean page faults", (row) => row.metrics.pageFaults?.mean),
    numeric("pageFaults-fastest", "Page faults · fastest timed iteration", (row) => row.metrics.pageFaults?.fastest),
    numeric("pageFaults-slowest", "Page faults · slowest timed iteration", (row) => row.metrics.pageFaults?.slowest),
    numeric("totalPageFaults", "Total page faults", (row) => row.profiler?.totalPageFaults),
    numeric("throughput", "Min throughput", (row) => row.metrics.throughput?.min, "GiB/s"),
    ...(["cacheMisses", "branchMisses"] as const).flatMap((metric) => (["fastest", "slowest"] as const).map((stat) =>
      numeric(`${metric}-${stat}`, `${metricNames[metric]} · ${stat} timed iteration`, (row) => row.metrics[metric]?.[stat]))),
    ...(lanes.length > 1 ? [{ id: "ratio", label: `Ratio to ${lanes[0].label}`, kind: "ratio" as const, value: laneRatio(run.rows, lanes, settings.metric, settings.stat) }] : []),
  ];
}
