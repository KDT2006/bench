import { USE_MOCK_API } from "../api/config";
import type { Lane, Machine, RunnerOptions } from "../api/types";
import { languages } from "../model/format";
import { useBench } from "../model/state";
import { Overlay } from "../shell/Overlay";

const counters: { value: RunnerOptions["counters"][number]; label: string }[] = [
  { value: "cycles", label: "Cycles" }, { value: "time", label: "Time" }, { value: "pageFaults", label: "Page faults" },
  { value: "cacheMisses", label: "L1 data-cache misses" }, { value: "branchMisses", label: "Branch-prediction misses" }, { value: "throughput", label: "Throughput" },
];

export default function LaneOptions({ lane, machine, close }: { lane: Lane; machine?: Machine; close: () => void }) {
  const change = useBench((s) => s.changeLane);
  const build = (patch: Partial<Lane["build"]>) => change(lane.id, (current) => ({ ...current, build: { ...current.build, ...patch } }));
  const runner = (patch: Partial<RunnerOptions>) => change(lane.id, (current) => ({ ...current, runner: { ...current.runner, ...patch } }));
  const env = (key: string, value: string) => build({ env: { ...lane.build.env, [key]: value } });
  const go = lane.language === "go";
  const selected = lane.build.flags.find((flag) => flag.startsWith("-gcflags=")) ?? "";
  const toolchains = [...new Set([lane.build.toolchainVersion, machine?.toolchains[lane.language]].filter(Boolean))];
  const fields = [
    { key: "maxReps", label: "Maximum repetitions", min: 1 }, { key: "minTimeMs", label: "Minimum time (ms)", min: 1 },
    { key: "warmup", label: "Warmup repetitions", min: 0 }, { key: "core", label: "Pinned core", min: 0 },
    { key: "memLimitMb", label: "Memory limit (MiB)", min: 1 },
  ] as const;

  if (!USE_MOCK_API) return <Overlay title={`Lane ${lane.label} options`} drawer onClose={close}>
    <div className="overlay-body lane-options">
      <section><h3>Execution</h3>
        <label>Bytes per iteration<input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={lane.execution?.byteCount ?? 0} onChange={(event) => {
          if (event.target.validity.valid && Number.isSafeInteger(event.target.valueAsNumber)) change(lane.id, (current) => ({ ...current, execution: { byteCount: event.target.valueAsNumber, fenced: current.execution?.fenced ?? true } }));
        }} /></label>
        <label className="check-setting"><input type="checkbox" checked={lane.execution?.fenced ?? true} onChange={(event) => change(lane.id, (current) => ({ ...current, execution: { byteCount: current.execution?.byteCount ?? 0, fenced: event.target.checked } }))} /> Fenced timer reads</label>
        <p className="help-text">A byte count of zero leaves throughput unavailable. Timing and fault counts are always measured. L1 data-cache misses and branch-prediction misses are collected when supported.</p>
      </section>
      <fieldset disabled><legend>Server-managed settings</legend><p className="help-text">The proxy does not accept compiler flags, environment variables, assembly files, repetition limits, warmup, memory limits or core selection. These controls are unavailable; execution uses the server defaults.</p>
        <button type="button" className="control">Build and runner settings unavailable</button>
      </fieldset>
      <div className="dialog-actions"><button className="control primary" type="button" onClick={close}>Done</button></div>
    </div>
  </Overlay>;
  return <Overlay title={`Lane ${lane.label} options`} drawer onClose={close}>
    <div className="overlay-body lane-options">
      <section>
        <h3>Build</h3>
        <label>{languages[lane.language]} toolchain<select value={lane.build.toolchainVersion} onChange={(e) => build({ toolchainVersion: e.target.value })}>{toolchains.map((version) => <option key={version}>{version}</option>)}</select></label>
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
        <label>Extra flags<textarea key={lane.language} spellCheck={false} defaultValue={lane.build.flags.filter((flag) => !flag.startsWith("-gcflags=") && flag !== "-O").join("\n")} onBlur={(e) => build({
          flags: [...lane.build.flags.filter((flag) => flag.startsWith("-gcflags=") || flag === "-O"), ...e.target.value.split("\n").map((flag) => flag.trim()).filter(Boolean)],
        })} /><small>Enter one flag per line.</small></label>
      </section>
      <section>
        <h3>Runner</h3>
        <div className="field-grid">
          {fields.map(({ key, label, min }) => <label key={key}>{label}<input type="number" min={min} step={1} value={lane.runner[key] ?? ""} onChange={(e) => {
            if (e.target.value === "") runner({ [key]: key === "warmup" ? 0 : undefined });
            else if (e.target.validity.valid) runner({ [key]: e.target.valueAsNumber });
          }} /></label>)}
        </div>
        <fieldset><legend>Counters</legend>{counters.map(({ value, label }) => <label key={value} className="check-setting"><input type="checkbox" disabled={machine?.perfCounters === false && ["cycles", "cacheMisses"].includes(value)} checked={lane.runner.counters.includes(value)} onChange={(e) =>
          runner({ counters: e.target.checked ? [...lane.runner.counters, value] : lane.runner.counters.filter((counter) => counter !== value) })} />{label}</label>)}</fieldset>
      </section>
      {lane.files["kernel.S"] && <section><h3>Assembly</h3><label>Assembler flags<textarea spellCheck={false} defaultValue={lane.build.asmFlags?.join("\n")} onBlur={(e) => build({ asmFlags: e.target.value.split("\n").map((flag) => flag.trim()).filter(Boolean) })} /><small>{lane.arch === "arm64" ? "AArch64 syntax" : "Use AT&T or set the Intel syntax directive."}</small></label></section>}
      <div className="dialog-actions"><button type="button" className="control" onClick={() => {
        useBench.getState().edit((workspace) => ({ ...workspace, lanes: workspace.lanes.map((item) => ({ ...item, runner: structuredClone(lane.runner) })) }));
        useBench.getState().notify({ text: "Runner options applied to all lanes." });
      }}>Apply to all lanes</button><button type="button" className="control primary" onClick={close}>Done</button></div>
    </div>
  </Overlay>;
}
