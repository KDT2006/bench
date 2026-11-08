import type { ExecuteResult, Machine, ExecutorHealth, ResultRow, Run } from "./types";

// Live results belong to this tab; the proxy does not persist run resources.
export const liveRuns = new Map<string, Run>();

export function machineFromHealth(health: ExecutorHealth): Machine {
  if (health.arch !== "amd64" && health.arch !== "arm64") throw new Error(`Unsupported server architecture: ${health.arch}.`);
  return {
    id: health.hostname, os: health.os, arch: health.arch === "amd64" ? "x86_64" : "arm64", threads: health.cpus,
    languages: health.languages.filter((language): language is "go" | "python" => language === "go" || language === "python"),
    hardware: health.hardware, status: "ready",
  };
}

export function resultRow(result: ExecuteResult, laneId: string, params: ResultRow["params"]): ResultRow {
  const m = result.measurements;
  const metrics: ResultRow["metrics"] = {
    cycles: { min: m.MinTime, max: m.MaxTime, mean: m.AvgTime },
    pageFaults: { mean: m.PageFaultCountAvg,
      fastest: m.MajorPageFaultCountMin + m.MinorPageFaultCountMin,
      slowest: m.MajorPageFaultCountMax + m.MinorPageFaultCountMax },
  };
  if (result.timerFrequency > 0) metrics.timeNs = { min: result.timeMs.min * 1e6, max: result.timeMs.max * 1e6, mean: result.timeMs.avg * 1e6 };
  if (result.byteCount > 0 && result.timerFrequency > 0 && m.MinTime > 0 && m.MaxTime > 0 && m.AvgTime > 0) {
    // Not a typo: the proxy's GigabytesPerSecondMin comes from the fastest iteration, so it is the highest throughput.
    metrics.throughput = { min: m.GigabytesPerSecondMax, max: m.GigabytesPerSecondMin, mean: m.GigabytesPerSecondAvg };
  }
  if (result.counterAvailability.l1DataMisses) metrics.cacheMisses = { fastest: m.L1DataMissMin, slowest: m.L1DataMissMax };
  // BranchMisssMin (three s) matches the profiler's wire format.
  if (result.counterAvailability.branchMisses) metrics.branchMisses = { fastest: m.BranchMisssMin, slowest: m.BranchMissMax };
  return { laneId, params, reps: result.iterations, metrics, profiler: result };
}
