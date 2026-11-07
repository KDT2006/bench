import { Suspense, lazy, useMemo } from "react";
import { Link } from "react-router-dom";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { USE_MOCK_API } from "../api/config";
import { sampleRun } from "../model/examples";
import type { Lane, Machine, RunEvent, Workspace } from "../api/types";
import { LaneBadge, defaultChart, laneRatio, type ChartSettings } from "../chart/config";
import { formatRatio, laneVar, num, param, params } from "../model/format";
import { useBench, type Panel } from "../model/state";
import { MAX_PERMUTATIONS, parseSweep, sweepCombinations } from "../model/sweep";

const Instrument = lazy(() => import("../chart/Instrument"));
const tabs: [Panel, string][] = [["live", "Live"], ["sweep", "Sweep"], ["build", "Build output"], ["log", "Run log"]];
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const noRows: never[] = [];

function eventText(event: RunEvent) {
  switch (event.type) {
    case "queued": return `Queued · position ${num.format(event.position)}`;
    case "build_start": return "Building…";
    case "build_done": return event.ok ? "Build complete." : event.log;
    case "perm_start": return `Permutation ${num.format(event.index)} of ${num.format(event.total)} · ${params(event.params)}`;
    case "result": return `Result kept · ${num.format(event.row.reps)} reps`;
    case "stderr": return event.text;
    case "done": return "Run stream finished.";
    case "error": return event.message;
  }
}

export default function RunPanel({ workspace, machine, onJump, onResize, editable }: {
  workspace: Workspace; machine?: Machine; onJump: (lane: Lane, line: number) => void;
  onResize: (height: number) => void; editable: boolean;
}) {
  const active = useBench((s) => s.active);
  const lastRun = useBench((s) => s.lastRun);
  const pending = useBench((s) => s.pending);
  const layout = useBench((s) => s.layout);
  const setLayout = useBench((s) => s.setLayout);
  const activeLanes = active?.snapshot.lanes ?? workspace.lanes;
  const rows = active?.rows ?? noRows;
  const laneSweeps = useMemo(() => workspace.lanes.map((lane) => ({ lane, ...parseSweep(lane.files["benchmark.perf"] ?? "") })), [workspace.lanes]);
  const sweep = lastRun?.id === active?.id && lastRun ? lastRun.sweep : active && USE_MOCK_API ? sampleRun.sweep : undefined;
  const activeSweep = useMemo(() => sweep ?? parseSweep((active?.snapshot.lanes[0] ?? workspace.lanes[0])?.files["benchmark.perf"] ?? "").sweep, [sweep, active?.snapshot.lanes, workspace.lanes]);
  const metric = USE_MOCK_API || rows.some((row) => row.metrics.cycles) ? "cycles" : "timeNs";
  const ratios = laneRatio(rows, activeLanes, metric, "min");
  const sizeName = activeSweep.find((entry) => entry.name === "N")?.name ?? activeSweep[0]?.name ?? "";
  const settings = useMemo<ChartSettings>(() => ({ ...defaultChart, metric, x: sizeName, size: sizeName, normalize: sizeName ? "element" as const : "raw" as const }), [metric, sizeName]);
  const running = pending || Boolean(active && ["queued", "building", "running"].includes(active.status));
  const logs = active?.events ?? [];
  const onSweepEdit = (lane: Lane, sweepText: string) => {
    const file = lane.files["benchmark.perf"] ?? "#bench\n";
    const replace = /^#sweep[ \t]*\r?\n[^]*?(?=^#\w|(?![^]))/m;
    useBench.getState().editFile(lane.id, "benchmark.perf", replace.test(file) ? file.replace(replace, () => `#sweep\n${sweepText.trim()}\n\n`) : `#sweep\n${sweepText.trim()}\n\n${file}`);
  };

  return <section className={`run-panel${layout.collapsed ? " is-collapsed" : ""}`} aria-label="Run panel">
    <div className="panel-resizer" role="separator" tabIndex={0} aria-label="Resize run panel" aria-orientation="horizontal" aria-valuenow={layout.height}
      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); onResize(layout.height + (e.key === "ArrowUp" ? 24 : -24)); } }}
      onPointerDown={(e) => { const target = e.currentTarget; target.setPointerCapture(e.pointerId); target.dataset.start = String(e.clientY + layout.height); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onResize(Number(e.currentTarget.dataset.start) - e.clientY); }} />
    <div className="panel-tabs">
      <div className="tab-strip" aria-label="Run panel views">{tabs.map(([value, label]) => <button type="button" key={value}
        aria-pressed={layout.panel === value && !layout.collapsed} onClick={() => setLayout({ panel: value, collapsed: false })}>{label}</button>)}</div>
      <button className="control icon-control" type="button" aria-expanded={!layout.collapsed} aria-label={layout.collapsed ? "Expand run panel" : "Collapse run panel"}
        title="Toggle run panel (Ctrl/⌘ J)" onClick={() => setLayout({ collapsed: !layout.collapsed })}><CaretDownIcon size={16} aria-hidden="true" className={layout.collapsed ? "flip" : ""} /></button>
    </div>
    {!layout.collapsed && <div className="run-panel-body" style={{ "--panel-height": `${layout.height}px` } as React.CSSProperties}>
      {layout.panel === "live" && <div className="live-grid">
        <Suspense fallback={<div className="instrument loading-plot" role="status">Loading chart…</div>}>
          <Instrument rows={rows} lanes={activeLanes} machine={lastRun?.machine ?? machine} sweep={activeSweep} settings={settings} beam={running}
            caption={rows.length ? "Each point is one measured input. Lower points mean less time or fewer timer ticks per element." : undefined}
            tableHref={active && !running ? `/results/${active.id}#results-table` : "#quick-results"} />
        </Suspense>
        <aside className="live-readouts">
          <div className="section-line"><h3>Run progress</h3><span className="chip" role="status">{active?.disconnected ? "Reconnecting…" : pending ? "Preparing…" : active?.status ?? "Ready"}</span></div>
          {running && active && <p className="help-text">Running a snapshot of this bench. You can keep editing.</p>}
          {activeLanes.map((lane) => {
            const done = rows.filter((row) => row.laneId === lane.id).length;
            const latest = logs.findLast(({ event }) => event.type === "perm_start" && event.laneId === lane.id)?.event;
            const total = latest?.type === "perm_start" ? latest.total : activeSweep.reduce((count, entry) => count * entry.values.length, 1);
            return <div key={lane.id} className="lane-meter"><LaneBadge lane={lane} /><progress style={{ "--channel": laneVar(lane.label) } as React.CSSProperties}
              aria-label={`Lane ${lane.label} results`} value={done} max={Math.max(done, total, 1)} /><span className="mono">{num.format(done)} / {num.format(total)}</span></div>;
          })}
          <h3 id="quick-results">Quick results</h3>
          {rows.length ? <div className="table-scroll quick-table" tabIndex={0} aria-label="Quick results table">
            <table><thead><tr><th>Lane</th><th>Params</th><th>Min cycles</th><th>Min ns</th>{activeLanes.length > 1 && <th>Ratio to A</th>}</tr></thead>
              <tbody>{rows.slice(-8).reverse().map((row, index) => {
                const lane = activeLanes.find((item) => item.id === row.laneId);
                const ratio = ratios(row);
                return <tr key={`${row.laneId}-${index}`}><td>{lane && <LaneBadge lane={lane} />}</td><td>{params(row.params)}</td><td>{row.metrics.cycles ? num.format(row.metrics.cycles.min) : "—"}</td>
                  <td>{row.metrics.timeNs ? num.format(row.metrics.timeNs.min) : "—"}</td>{activeLanes.length > 1 && <td>{formatRatio(ratio)}</td>}</tr>;
              })}</tbody></table>
          </div> : <p className="help-text">Results appear as each permutation finishes.</p>}
          {active && !running && <Link className="control" to={`/results/${active.id}`}>Open full results <ArrowUpRightIcon size={14} aria-hidden="true" /></Link>}
        </aside>
      </div>}
      {layout.panel === "sweep" && <div className="sweep-content">
        <div className="section-line"><h3>Sweep parameters</h3><span className="chip">Up to {MAX_PERMUTATIONS} combinations</span></div>
        <p className="help-text">Each lane runs every combination of the values you list. For example, 4 sizes × 3 strides gives 12 combinations.</p>
        {laneSweeps.map(({ lane, sweep: entries, errors }) => <section className="sweep-lane" key={lane.id}>
          <LaneBadge lane={lane} /><div>{errors.length ? <ul className="error-text">{errors.map((error) => <li key={error}>{error}</li>)}</ul>
            : entries.length ? entries.map((entry) => <div className="param-chips" key={entry.name}><code>{entry.name}</code>{entry.values.map((value, index) => <span className="chip mono" key={index}>{param(entry.name, value)}</span>)}</div>)
              : <p className="help-text">No sweep parameters. Add a #sweep section to try multiple values.</p>}
            {entries.length > 0 && <p className="help-text"><span className="mono">{entries.map((entry) => num.format(entry.values.length)).join(" × ")}{entries.length > 1 ? ` = ${num.format(sweepCombinations(entries))}` : ""}</span> combinations</p>}
            {lane.mode === "ejected" && editable && <label className="sweep-code">Sweep in code mode
              <textarea spellCheck={false} key={lane.files["benchmark.perf"]} defaultValue={/^#sweep[ \t]*\r?\n([^]*?)(?=^#\w|(?![^]))/m.exec(lane.files["benchmark.perf"] ?? "")?.[1].trim()} onBlur={(e) => { if (e.target.value !== e.target.defaultValue) onSweepEdit(lane, e.target.value); }} />
              <small>Enter one parameter list per line.</small>
            </label>}
          </div>
        </section>)}
      </div>}
      {layout.panel === "build" && <div className="sweep-content">
        <h3>Build output</h3>
        {!logs.length && <p className="help-text">Run the bench to see compiler output and diagnostics.</p>}
        {activeLanes.map((lane) => {
          const build = logs.findLast(({ event }) => event.type === "build_done" && event.laneId === lane.id)?.event;
          const problems = lane.mode === "scaffold" ? parseSweep(lane.files["benchmark.perf"] ?? "").errors : [];
          return <section className="build-row" key={lane.id}><LaneBadge lane={lane} /><div>
            <h4>Lane {lane.label}</h4>
            {build?.type === "build_done" ? <pre className={!build.ok ? "error-text" : ""}>{build.log}</pre> : <p className="help-text">No compiler output yet.</p>}
            {build?.type === "build_done" && !build.ok && /(?:line\s+|:)(\d+)/i.test(build.log) && <button className="control" type="button" onClick={() => onJump(lane, Number(/(?:line\s+|:)(\d+)/i.exec(build.log)![1]))}>Go to line</button>}
            {problems.map((problem) => <p className="error-text" key={problem}>{problem}</p>)}
          </div></section>;
        })}
      </div>}
      {layout.panel === "log" && <div className="sweep-content"><h3>Run log</h3>
        {!logs.length ? <p className="help-text">Run the bench to see the event log.</p> : <ol className="event-log">
          {logs.map(({ event, at }, index) => <li key={index} className={event.type === "error" || (event.type === "build_done" && !event.ok) ? "error-text" : ""}>
            <time dateTime={new Date(at).toISOString()}>{clock.format(at)}</time><span>{"laneId" in event && event.laneId ? `Lane ${activeLanes.find((lane) => lane.id === event.laneId)?.label ?? "?"} · ` : ""}{eventText(event)}</span>
          </li>)}
        </ol>}
      </div>}
    </div>}
  </section>;
}
