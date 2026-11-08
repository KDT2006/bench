import type { Lane, RunnerOptions } from "../api/types";
import { languages } from "../model/format";
import { useBench } from "../model/state";
import { Overlay } from "../shell/Overlay";
import CompilerOptions from "./CompilerOptions";
import { formatCompilerOptions } from "../model/compilerOptions";

const counters: { value: RunnerOptions["counters"][number]; label: string }[] = [
  { value: "cycles", label: "Cycles" }, { value: "time", label: "Time" }, { value: "pageFaults", label: "Page faults" },
  { value: "cacheMisses", label: "L1 data-cache misses" }, { value: "branchMisses", label: "Branch-prediction misses" }, { value: "throughput", label: "Throughput" },
];
const SERVER_DEFAULT = "Server default";

export default function LaneOptions({ lane, close }: { lane: Lane; close: () => void }) {
  const change = useBench((s) => s.changeLane);
  const build = (patch: Partial<Lane["build"]>) => change(lane.id, (current) => ({ ...current, build: { ...current.build, ...patch, ...(patch.flags ? { compilerOptions: formatCompilerOptions(patch.flags) } : {}) } }));
  const runner = (patch: Partial<RunnerOptions>) => change(lane.id, (current) => ({ ...current, runner: { ...current.runner, ...patch } }));
  const execution = (patch: Partial<NonNullable<Lane["execution"]>>) => change(lane.id, (current) => ({
    ...current, execution: { byteCount: current.execution?.byteCount ?? 0, fenced: current.execution?.fenced ?? true, ...patch },
  }));
  const env = (key: string, value: string) => build({ env: { ...lane.build.env, [key]: value } });
  const go = lane.language === "go";
  const selected = lane.build.flags.find((flag) => flag.startsWith("-gcflags=")) ?? "";
  const toolchains = [...new Set([SERVER_DEFAULT, lane.build.toolchainVersion].filter(Boolean))];
  const byteCount = lane.execution?.byteCount ?? 0;
  const fields = [
    { key: "maxReps", label: "Maximum repetitions", min: 1 }, { key: "minTimeMs", label: "Minimum time (ms)", min: 1 },
    { key: "warmup", label: "Warmup repetitions", min: 0 }, { key: "core", label: "Pinned core", min: 0 },
    { key: "memLimitMb", label: "Memory limit (MiB)", min: 1 },
  ] as const;

  return <Overlay title={`Lane ${lane.label} options`} drawer onClose={close}>
    <div className="overlay-body lane-options">
      <section>
        <h3>Execution</h3>
        <label>Bytes per iteration<input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} placeholder="0" value={byteCount || ""} onChange={(e) => {
          if (e.target.value === "") execution({ byteCount: 0 });
          else if (e.target.validity.valid && Number.isSafeInteger(e.target.valueAsNumber)) execution({ byteCount: e.target.valueAsNumber });
        }} /></label>
        <label className="check-setting"><input type="checkbox" checked={lane.execution?.fenced ?? true} onChange={(e) => execution({ fenced: e.target.checked })} /> Fenced timer reads</label>
        <p className="help-text">A byte count of zero leaves throughput unavailable. Timing and fault counts are always measured. L1 data-cache misses and branch-prediction misses are collected when supported.</p>
      </section>
      <section>
        <h3>Build</h3>
        <p className="help-text">Compiler options are applied to each run. Toolchain selection, environment overrides and runner controls are saved with the bench but are not applied yet.</p>
        <label>{languages[lane.language]} toolchain<select value={lane.build.toolchainVersion || toolchains[0]} onChange={(e) => build({ toolchainVersion: e.target.value })}>{toolchains.map((version) => <option key={version}>{version}</option>)}</select></label>
        {go ? <>
          <div className="segmented" aria-label="Compiler preset">
            {([["", "Default"], ["-gcflags=-N -l", "No optimizations"], ["-gcflags=-m", "Escape analysis"]] as const).map(([flag, label]) =>
              <button type="button" key={label} className="control" aria-pressed={selected === flag} onClick={() => build({ flags: [...lane.build.flags.filter((f) => !f.startsWith("-gcflags=")), ...(flag ? [flag] : [])] })}>{label}</button>)}
          </div>
          {["GOGC", "GOMAXPROCS", lane.arch === "arm64" ? "GOARM64" : "GOAMD64"].map((key) => <label key={key}>{key}<input value={lane.build.env[key] ?? ""} onChange={(e) => env(key, e.target.value)} spellCheck={false} /></label>)}
        </> : <>
          <label className="check-setting"><input type="checkbox" checked={lane.build.flags.includes("-O")} onChange={(e) => build({ flags: e.target.checked ? [...lane.build.flags, "-O"] : lane.build.flags.filter((flag) => flag !== "-O") })} /> Optimize bytecode (-O)</label>
          <label>PYTHONHASHSEED<input inputMode="numeric" value={lane.build.env.PYTHONHASHSEED ?? ""} onChange={(e) => env("PYTHONHASHSEED", e.target.value)} spellCheck={false} /></label>
        </>}
        <CompilerOptions lane={lane} />
      </section>
      <section>
        <h3>Runner</h3>
        <div className="field-grid">
          {fields.map(({ key, label, min }) => <label key={key}>{label}<input type="number" min={min} step={1} value={lane.runner[key] ?? ""} onChange={(e) => {
            if (e.target.value === "") runner({ [key]: undefined });
            else if (e.target.validity.valid) runner({ [key]: e.target.valueAsNumber });
          }} /></label>)}
        </div>
        <fieldset><legend>Counters</legend>{counters.map(({ value, label }) => <label key={value} className="check-setting"><input type="checkbox" checked={lane.runner.counters.includes(value)} onChange={(e) =>
          runner({ counters: e.target.checked ? [...lane.runner.counters, value] : lane.runner.counters.filter((counter) => counter !== value) })} />{label}</label>)}</fieldset>
      </section>
      <div className="dialog-actions"><button type="button" className="control" onClick={() => {
        useBench.getState().edit((workspace) => ({ ...workspace, lanes: workspace.lanes.map((item) => ({ ...item, runner: structuredClone(lane.runner) })) }));
        useBench.getState().notify({ text: "Runner options applied to all lanes." });
      }}>Apply to all lanes</button><button type="button" className="control primary" onClick={close}>Done</button></div>
    </div>
  </Overlay>;
}
