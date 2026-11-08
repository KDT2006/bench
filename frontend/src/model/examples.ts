import type { Example, Run, Workspace } from "../api/types";
import raw from "../../mock/fixtures/run.json";
import { harness } from "./format";
export const sampleRun = raw as Run;

const scenarios = [
  ["branch-prediction", "Branch prediction", "Branches", "Compare a conditional over sorted and random data.", "Predictable branches can make the same loop easier for a CPU to execute.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576]\n\n#setup\narr = random_array(N, 0, 255)\n\n#bench\ns = 0\nfor i in 0..N:\n  if arr[i] > 127: s += arr[i]\nsink(s)\n\n#cleanup\n"],
  ["data-layout", "Data layout", "Data structures and algorithms", "Read contiguous values, then change the stride to model a different layout.", "Contiguous and strided reads make different use of each cache line.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576]\nstride: [1, 8, 64]\n\n#setup\narr = random_array(N, 0, 255)\n\n#bench\ns = 0\nfor i in 0..N: s += arr[(i * stride) % N]\nsink(s)\n\n#cleanup\n"],
  ["ffi-overhead", "FFI overhead", "Math and FFI", "Use this bench to compare a local operation with an assembly call.", "For short operations, the call boundary can dominate the work.", "#imports\n\n#globals\n\n#sweep\nN: [1, 8, 64]\n\n#setup\n\n#bench\nsink(N)\n\n#cleanup\n"],
  ["page-faults", "Page faults", "Memory and caches", "Allocate a buffer and touch its pages during the benchmark.", "First touches can fault pages into memory.", "#imports\n\n#globals\n\n#sweep\nN: [65536, 1048576, 67108864]\n\n#setup\narr = allocate(N)\n\n#bench\narr[0] = 1\nsink(arr)\n\n#cleanup\nfree(arr)\n"],
  ["dependency-chain", "Dependency chains", "CPU basics", "Follow a chain of dependent arithmetic operations.", "Each operation in the chain waits for the preceding result.", "#imports\n\n#globals\n\n#sweep\nN: [16, 64, 256]\n\n#setup\n\n#bench\ns = 1\nfor i in 0..N: s = s * 3 + 1\nsink(s)\n\n#cleanup\n"],
] as const;

export const expectations: Record<string, string> = {
  [sampleRun.id]: "Compare cycles per element as the array grows beyond each cache.",
  ...Object.fromEntries(scenarios.map(([id, , , , expectation]) => [id, expectation])),
};

export const exampleFixtures: Example[] = [{
  id: sampleRun.id,
  category: "Memory and caches",
  description: "Sum an array in Go and Python as its size grows.",
  workspace: sampleRun.workspaceSnapshot,
  runId: sampleRun.id,
}, ...scenarios.map(([id, title, category, description, , dsl]) => ({
  id, category, description, workspace: {
    ...sampleRun.workspaceSnapshot, title, linkDsl: id !== "branch-prediction", lanes: sampleRun.workspaceSnapshot.lanes.map((lane) => ({
      ...lane,
      ...(id === "branch-prediction" ? { name: lane.label === "A" ? "Sorted" : "Random", language: "go" as const, build: sampleRun.workspaceSnapshot.lanes[0].build } : {}),
      files: id === "ffi-overhead" ? {
        "benchmark.perf": dsl,
        ...(lane.label === "A" ? { "harness.go": "#imports\n\n#globals\nvar result int\n\n#sweep\nN: [1,8,64]\n\n#setup\n\n#bench\nresult = N\n\n#cleanup\n" }
          : { "harness.go": '#imports\n/*\n#include <stdint.h>\nuint64_t kernel(uint64_t n);\n*/\n"C"\n\n#globals\nvar result uint64\n\n#sweep\nN: [1,8,64]\n\n#setup\n\n#bench\nresult = uint64(C.kernel(C.uint64_t(N)))\n\n#cleanup\n',
            "kernel.S": ".text\n.globl kernel\nkernel:\n    mov %rdi, %rax\n    ret\n" }),
      } : { "benchmark.perf": id === "branch-prediction" && lane.label === "A" ? dsl.replace("\n\n#bench", "\nsort(arr)\n\n#bench") : dsl },
      ...(id === "ffi-overhead" ? { language: "go" as const, mode: "ejected" as const, build: sampleRun.workspaceSnapshot.lanes[0].build, name: lane.label === "A" ? "Local operation" : "Assembly call" } : {}),
    })),
  },
}))];

export function starterWorkspace(): Workspace {
  const now = new Date().toISOString();
  const lane = structuredClone(sampleRun.workspaceSnapshot.lanes[0]);
  lane.files["benchmark.perf"] = "#imports\n\n#globals\n\n#sweep\nN: [1024,4096]\n\n#setup\narr = random_array(N,0,255)\n\n#bench\ns = 0\nfor i in 0..N: s += arr[i]\nsink(s)\n\n#cleanup\n";
  lane.execution = { byteCount: 0, fenced: true };
  delete lane.files[harness(lane.language)];
  return { title: "Untitled bench", linkDsl: true, lanes: [lane], createdAt: now, updatedAt: now };
}
