import type { ExecuteResult, Machine, ProxyHealth, ResultRow, Run } from "./types";

// Live results belong to this tab; the proxy does not persist run resources.
export const liveRuns = new Map<string, Run>();

export function machineFromHealth(health: ProxyHealth): Machine {
  if (health.arch !== "amd64" && health.arch !== "arm64") throw new Error(`Unsupported server architecture: ${health.arch}.`);
  if (health.status !== "ok") throw new Error("The execution proxy is unavailable.");
  return {
    id: health.hostname, os: health.os, arch: health.arch === "amd64" ? "x86_64" : "arm64",
    cpuModel: "CPU model unavailable", threads: health.cpus, caches: [], isolatedCores: [], toolchains: {},
    languages: health.languages.filter((language): language is "go" | "python" => language === "go" || language === "python"),
    status: "ready",
  };
}

export function resultRow(result: ExecuteResult, laneId: string, params: ResultRow["params"]): ResultRow {
  if (!result || !result.counterAvailability || typeof result.counterAvailability.l1DataMisses !== "boolean" || typeof result.counterAvailability.branchMisses !== "boolean") throw new Error("The executor response is missing counter availability.");
  const m = result.measurements;
  if (!m || !result.timeMs || result.iterations <= 0 || !Number.isFinite(result.iterations)) throw new Error("The executor returned no valid measurements.");
  const finite = (values: unknown[]) => values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (!finite([m.MinTime, m.MaxTime, m.AvgTime, m.TotalTime, result.timeMs.min, result.timeMs.max, result.timeMs.avg, result.timerFrequency, result.totalPageFaults, m.PageFaultCountAvg, m.MajorPageFaultCountMin, m.MinorPageFaultCountMin, m.MajorPageFaultCountMax, m.MinorPageFaultCountMax, m.GigabytesPerSecondMin, m.GigabytesPerSecondMax, m.GigabytesPerSecondAvg])) throw new Error("The executor returned invalid measurement values.");
  const metrics: ResultRow["metrics"] = {
    cycles: { min: m.MinTime, max: m.MaxTime, mean: m.AvgTime },
    pageFaults: { mean: m.PageFaultCountAvg,
      fastest: m.MajorPageFaultCountMin + m.MinorPageFaultCountMin,
      slowest: m.MajorPageFaultCountMax + m.MinorPageFaultCountMax },
  };
  if (result.timerFrequency > 0) metrics.timeNs = { min: result.timeMs.min * 1e6, max: result.timeMs.max * 1e6, mean: result.timeMs.avg * 1e6 };
  if (result.byteCount > 0 && result.timerFrequency > 0 && m.MinTime > 0 && m.MaxTime > 0 && m.AvgTime > 0) {
    metrics.throughput = { min: m.GigabytesPerSecondMax, max: m.GigabytesPerSecondMin, mean: m.GigabytesPerSecondAvg };
  }
  if (result.counterAvailability?.l1DataMisses) {
    if (!finite([m.L1DataMissMin, m.L1DataMissMax])) throw new Error("Invalid L1 data-cache miss counts.");
    metrics.cacheMisses = { fastest: m.L1DataMissMin, slowest: m.L1DataMissMax };
  }
  if (result.counterAvailability?.branchMisses) {
    if (!finite([m.BranchMisssMin, m.BranchMissMax])) throw new Error("Invalid branch-prediction miss counts.");
    metrics.branchMisses = { fastest: m.BranchMisssMin, slowest: m.BranchMissMax };
  }
  return { laneId, params, reps: result.iterations, metrics, profiler: result };
}
