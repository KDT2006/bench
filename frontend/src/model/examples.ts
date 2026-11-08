import type { Example, Lane, Run, Workspace } from "../api/types";
import raw from "./sampleRun.json";
import { laneColors } from "./format";
export const sampleRun = raw as Run;

const scenarios = [
  ["branch-prediction", "Branch prediction", "Branches", "Compare a conditional over sorted and random data.", "Predictable branches can make the same loop easier for a CPU to execute.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576]\n\n#setup\narr = random_array(N, 0, 255)\n\n#bench\ns = 0\nfor i in 0..N:\n  if arr[i] > 127: s += arr[i]\nsink(s)\n\n#cleanup\n"],
  ["data-layout", "Data layout", "Data structures and algorithms", "Read contiguous values, then change the stride to model a different layout.", "Contiguous and strided reads make different use of each cache line.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576]\nstride: [1, 8, 64]\n\n#setup\narr = random_array(N, 0, 255)\n\n#bench\ns = 0\nfor i in 0..N: s += arr[(i * stride) % N]\nsink(s)\n\n#cleanup\n"],
  ["page-faults", "Page faults", "Memory and caches", "Allocate a buffer and touch its pages during the benchmark.", "First touches can fault pages into memory.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576, 67108864]\n\n#setup\narr = allocate(N)\n\n#bench\narr[0] = 1\nsink(arr)\n\n#cleanup\nfree(arr)\n"],
  ["dependency-chain", "Dependency chains", "CPU basics", "Follow a chain of dependent arithmetic operations.", "Each operation in the chain waits for the preceding result.", "#imports\n\n#globals\n\n#sweep\nN: [16, 64, 256]\n\n#setup\n\n#bench\ns = 1\nfor i in 0..N: s = s * 3 + 1\nsink(s)\n\n#cleanup\n"],
] as const;

export const expectations: Record<string, string> = {
  [sampleRun.id]: "Compare time per element as the array grows.",
  ...Object.fromEntries(scenarios.map(([id, , , , expectation]) => [id, expectation])),
};

export const exampleFixtures: Example[] = [{
  id: sampleRun.id,
  category: "Memory and caches",
  description: "Sum an array in Go and Python as its size grows.",
  workspace: sampleRun.workspaceSnapshot,
}, ...scenarios.map(([id, title, category, description, , dsl]) => ({
  id, category, description, workspace: {
    ...sampleRun.workspaceSnapshot, title, linkDsl: id !== "branch-prediction", lanes: sampleRun.workspaceSnapshot.lanes.map((lane) => ({
      ...lane,
      ...(id === "branch-prediction" ? { name: lane.label === "A" ? "Sorted" : "Random", language: "go" as const } : {}),
      files: { "benchmark.perf": id === "branch-prediction" && lane.label === "A" ? dsl.replace("\n\n#bench", "\nsort(arr)\n\n#bench") : dsl },
    })),
  },
}))];

export const starterDsl = "#imports\n\n#globals\n\n#sweep\nN: [1024,4096]\n\n#setup\narr = random_array(N,0,255)\n\n#bench\ns = 0\nfor i in 0..N: s += arr[i]\nsink(s)\n\n#cleanup\n";

/** A lane with server-default build and runner settings. */
export function starterLane(arch: Lane["arch"] = "x86_64", language: Lane["language"] = "go"): Lane {
  return {
    id: crypto.randomUUID(), label: "A", color: laneColors.A, language, arch, mode: "scaffold",
    files: { "benchmark.perf": starterDsl },
    build: { toolchainVersion: "", flags: [], env: {} },
    runner: { counters: ["cycles", "time"] },
    execution: { byteCount: 0, fenced: true },
  };
}

export function starterWorkspace(arch?: Lane["arch"]): Workspace {
  const now = new Date().toISOString();
  return { title: "Untitled bench", linkDsl: true, lanes: [starterLane(arch)], createdAt: now, updatedAt: now };
}
