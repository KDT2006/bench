export type Lang = "go" | "python";
export type Arch = "x86_64" | "arm64";
export type Mode = "scaffold" | "ejected";
export type FileName = "benchmark.perf" | "harness.go" | "harness.py";

export interface Workspace {
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
  };
  build: BuildOptions;
  runner: RunnerOptions;
  execution?: { byteCount: number; fenced: boolean };
}

export interface BuildOptions {
  toolchainVersion: string;  // "go1.23", "cpython3.13"
  flags: string[];           // validated server-side
  env: Record<string, string>;
}

export interface RunnerOptions {
  maxReps?: number;
  minTimeMs?: number;
  warmup?: number;
  core?: number;
  memLimitMb?: number;
  counters: ("cycles" | "time" | "pageFaults" | "cacheMisses" | "branchMisses" | "throughput")[];
}

export interface SweepParam {
  name: string;
  values: number[];
}

export interface Run {
  id: string;
  workspaceSnapshot: Workspace;
  machine: MachineSnapshot;
  machines?: MachineSnapshot[];
  status: "queued" | "building" | "running" | "done" | "failed" | "cancelled";
  sweep: SweepParam[];
  rows: ResultRow[];
  startedAt: string;
  finishedAt?: string;
}

export interface Stat { min?: number; max?: number; mean?: number; fastest?: number; slowest?: number; }

export interface ResultRow {
  laneId: string;
  params: Record<string, number | string>;  // { N: 65536, stride: 8 }
  reps: number;
  metrics: Partial<Record<"cycles" | "timeNs" | "pageFaults" | "cacheMisses" | "branchMisses" | "throughput", Stat>>;
  profiler?: ExecuteResult;
}

export interface MachineSnapshot {
  id: string;                // server hostname
  arch: Arch;
  threads: number;
  os?: string;
  languages?: Lang[];
  hardware?: MachineHardware;
}

export interface MachineHardware {
  cpuModel?: string;
  physicalCores?: number;
  memoryBytes?: number;
  kernel?: string;
  governor?: string;
  caches?: { level: string; type: string; sizeBytes: number; sharedCpus?: string }[];
}

export interface ExecutorHealth {
  status: string; hostname: string; os: string; arch: string; cpus: number; languages: string[];
  hardware?: MachineHardware;
}

export interface ProxyHealth {
  status: string;
  machines: ExecutorHealth[];
  unavailable: { language: string; message: string }[];
}
export interface ExecuteRequest {
  name: string; byteCount: number; fenced: boolean; code: string; language: Lang; arch: string;
}
export interface CounterAvailability { l1DataMisses: boolean; branchMisses: boolean; }
export interface ExecuteResult {
  name: string; byteCount: number; fenced: boolean; timerFrequency: number;
  runWindowNanos: number; runWindowMillis: number; iterations: number; totalPageFaults: number;
  counterAvailability: CounterAvailability;
  timeMs: { min: number; max: number; avg: number; total: number };
  measurements: {
    numIterations: number; totalPageFaults: number;
    MinTime: number; MaxTime: number; TotalTime: number; AvgTime: number;
    GigabytesPerSecondMin: number; GigabytesPerSecondMax: number; GigabytesPerSecondAvg: number;
    MajorPageFaultCountMin: number; MinorPageFaultCountMin: number;
    MajorPageFaultCountMax: number; MinorPageFaultCountMax: number; PageFaultCountAvg: number;
    L1DataMissMin: number; L1DataMissMax: number; BranchMisssMin: number; BranchMissMax: number;
  };
}
export interface ExecuteResponse { results: ExecuteResult[]; }

export interface Machine extends MachineSnapshot {
  status: "ready";
}

export interface ParseResponse {
  sweep: SweepParam[];
  errors: string[];
}

export interface ScaffoldResponse {
  code: string;
  warnings: string[];
  model: string;
}

export interface Example {
  id: string;
  category: string;
  description: string;
  workspace: Workspace;
}

export type RunEvent =
  | { type: "queued" }
  | { type: "build_start"; laneId: string; translating?: boolean }
  | { type: "build_done"; laneId: string; ok: boolean; log: string }
  | { type: "perm_start"; laneId: string; index: number; total: number; params: ResultRow["params"] }
  | { type: "result"; laneId: string; row: ResultRow }
  | { type: "done" }
  | { type: "error"; message: string; laneId?: string };
