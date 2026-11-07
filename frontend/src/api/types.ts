export type Lang = "go" | "python";
export type Arch = "x86_64" | "arm64";
export type Mode = "scaffold" | "ejected";
export type FileName = "benchmark.perf" | "harness.go" | "harness.py" | "kernel.S";

export interface Workspace {
  id?: string;               // set once saved
  title: string;
  linkDsl: boolean;          // scaffold lanes share one benchmark.perf
  lanes: Lane[];             // 1..4
  createdAt: string;
  updatedAt: string;
}

export interface Lane {
  id: string;
  label: "A" | "B" | "C" | "D";
  name?: string;             // "AoS", "SoA"
  color: string;
  language: Lang;
  arch: Arch;
  mode: Mode;
  files: Partial<Record<FileName, string>>;
  scaffold?: {
    dslHash: string;         // hash of DSL used for last generate
    model: string;
    warnings: string[];
    cached: boolean;
  };
  build: BuildOptions;
  runner: RunnerOptions;
}

export interface BuildOptions {
  toolchainVersion: string;  // "go1.23", "cpython3.13"
  flags: string[];           // validated server-side
  env: Record<string, string>;
  asmFlags?: string[];
}

export interface RunnerOptions {
  maxReps?: number;
  minTimeMs?: number;
  warmup: number;
  core?: number;
  memLimitMb?: number;
  counters: ("cycles" | "time" | "pageFaults" | "cacheMisses" | "throughput")[];
}

export interface SweepParam {
  name: string;
  values: (number | string)[];
}

export interface Run {
  id: string;
  workspaceSnapshot: Workspace;
  machine: MachineSnapshot;
  status: "queued" | "building" | "running" | "done" | "failed" | "cancelled";
  sweep: SweepParam[];
  rows: ResultRow[];
  startedAt: string;
  finishedAt?: string;
}

export interface Stat { min: number; median: number; mean: number; p95: number; stddev: number; }

export interface ResultRow {
  laneId: string;
  params: Record<string, number | string>;  // { N: 65536, stride: 8 }
  reps: number;
  metrics: Partial<Record<"cycles" | "timeNs" | "pageFaults" | "cacheMisses" | "throughput", Stat>>;
  samples?: number[];        // optional raw cycles per rep, for distribution charts
}

export interface MachineSnapshot {
  id: string;
  arch: Arch;
  cpuModel: string;
  cores: number; threads: number; smt: boolean;
  baseMhz: number; boostMhz: number; governor: string; turbo: boolean;
  caches: { level: "L1d" | "L1i" | "L2" | "L3"; sizeBytes: number; lineSize: number; assoc?: number }[];
  ramBytes: number; pageSize: number;
  kernel: string; isolatedCores: number[]; perfCounters: boolean;
  toolchains: Record<string, string>;
}

export interface Machine extends MachineSnapshot {
  status: "idle" | "busy" | "offline";
  queueLength: number;
}

export interface ParseResponse {
  sweep: SweepParam[];
  permutations: number;
  errors: string[];
}

export interface ScaffoldResponse {
  code: string;
  warnings: string[];
  cached: boolean;
  model: string;
}

export interface ShareSnapshot {
  workspace: Workspace;
  runId?: string;
}

export interface Example {
  id: string;
  category: string;
  description: string;
  workspace: Workspace;
  runId?: string;
}

export type RunEvent =
  | { type: "queued"; position: number }
  | { type: "build_start"; laneId: string }
  | { type: "build_done"; laneId: string; ok: boolean; log: string }
  | { type: "perm_start"; laneId: string; index: number; total: number; params: ResultRow["params"] }
  | { type: "result"; laneId: string; row: ResultRow }
  | { type: "stderr"; laneId: string; text: string }
  | { type: "done" }
  | { type: "error"; message: string; laneId?: string };
