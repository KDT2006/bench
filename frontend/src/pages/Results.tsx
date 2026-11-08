import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState, type VisibilityState } from "@tanstack/react-table";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { getRun } from "../api/client";
import type { FileName, ResultRow, Run, Stat } from "../api/types";
import { chartTypes, defaultChart, LaneBadge, laneRatio, type ChartSettings, type ChartType, type Normalize, type YScale } from "../chart/config";
import { date, duration, formatMetric, formatRatio, harness, laneVar, languages, metricNames, num, param, params, paramsKey, statusLabel, time, type Metric } from "../model/format";
import { MachineDetails } from "../shell/MachineDetails";
import { download } from "../model/download";
import { resultsCsv } from "../model/resultsCsv";
import { resultColumns } from "../model/resultColumns";
import { compilerOptionsText } from "../model/compilerOptions";
import { EditorSkeleton } from "../bench/Workbench";

const Instrument = lazy(() => import("../chart/Instrument"));
const Editor = lazy(() => import("../bench/Editor"));
const chartLabels: Record<ChartType, string> = {
  line: "Over the sweep", ratio: "Relative to A", bars: "By input", heatmap: "Heatmap", scatter: "Two metrics",
};
const chartCaptions: Record<ChartType, string> = {
  line: "Each point is a measured input. Follow a lane’s color to see how it changes across the sweep.",
  ratio: "Lane A is the 1× baseline. A value of 2× means twice the selected metric at the same input.",
  bars: "Compare the selected metric by input, with one color per lane.",
  heatmap: "Each cell shows the selected metric for a pair of sweep values.",
  scatter: "Each point shows two metrics measured for the same input.",
};
const stats: [keyof Stat, string][] = [["min", "Min"], ["max", "Max"], ["mean", "Mean"], ["fastest", "Fastest timed iteration"], ["slowest", "Slowest timed iteration"]];
const metrics = Object.keys(metricNames) as Metric[];

function show(value: number | undefined, suffix = "") { return value === undefined || !Number.isFinite(value) ? "—" : num.format(value) + suffix; }

function finding(run: Run) {
  const [a, b] = run.workspaceSnapshot.lanes;
  if (!a || !b) return { text: "Use the sweep to see how the cost of this benchmark changes with input size." };
  const metric = run.rows.some((row) => row.metrics.timeNs) ? "timeNs" : "cycles";
  const ratios = laneRatio(run.rows, [a, b], metric, "min");
  const pairs = run.rows.filter((row) => row.laneId === b.id).flatMap((row) => {
    const ratio = ratios(row);
    return ratio && Number.isFinite(ratio) ? [{ ratio }] : [];
  });
  if (!pairs.length) return { text: "Compare lanes once both have results for the same parameters." };
  if (pairs.every(({ ratio }) => ratio >= 0.95 && ratio <= 1.05)) return { text: `Lanes ${a.label} and ${b.label} are within 5% of each other across the matched sizes.` };
  const values = pairs.map((pair) => pair.ratio).sort((x, y) => x - y);
  const mid = (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2;
  if (pairs.some(({ ratio }) => mid >= 1 ? ratio <= 1 : ratio >= 1) || (mid >= 0.95 && mid <= 1.05)) return { text: "The faster lane depends on the input size. Use the ratio chart to see where they differ." };
  const [faster, slower] = mid >= 1 ? [a, b] : [b, a];
  const label = (lane: typeof a) => lane.name || (a.language === b.language ? `Lane ${lane.label}` : languages[lane.language]);
  return {
    value: formatRatio(Math.max(mid, 1 / mid)),
    text: metric === "cycles"
      ? `${label(faster)} used fewer timer ticks than ${label(slower)} across matched parameters. Median ratio of minimum timer ticks.`
      : `${label(faster)} ran faster than ${label(slower)} across matched parameters. Median ratio of minimum times.`,
  };
}

function InputComparison({ rows, lanes, metric, stat }: { rows: ResultRow[]; lanes: Run["workspaceSnapshot"]["lanes"]; metric: Metric; stat: ChartSettings["stat"] }) {
  const [selection, setSelection] = useState("");
  const inputs = useMemo(() => {
    const groups = new Map<string, ResultRow[]>();
    for (const row of rows) {
      if (row.metrics[metric]?.[stat] === undefined) continue;
      const key = paramsKey(row.params);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    return [...groups].filter(([, rows]) => new Set(rows.map((row) => row.laneId)).size > 1);
  }, [rows, metric, stat]);
  const input = inputs.find(([key]) => key === selection) ?? inputs.at(-1);
  if (!input) return null;
  const [key, matchedRows] = input;
  const values = new Map(matchedRows.map((row) => [row.laneId, row.metrics[metric]![stat]!]));
  const max = Math.max(...values.values());
  const label = stats.find(([value]) => value === stat)?.[1];
  const metricLabel = metric === "timeNs" ? "time per repetition" : metricNames[metric].toLowerCase();
  return <section className="input-comparison" aria-labelledby="input-comparison-title">
    <div className="section-line">
      <div><h2 id="input-comparison-title">Compare at one input</h2><p>{label} {metricLabel} · {metric === "throughput" ? "Higher is better" : "Lower is better"}</p></div>
      <div className="inline-controls"><label htmlFor="comparison-input">Input</label>
        <select id="comparison-input" value={key} onChange={(event) => setSelection(event.target.value)}>
          {inputs.map(([id, group]) => <option key={id} value={id}>{params(group[0].params)}</option>)}
        </select>
      </div>
    </div>
    <ul>{lanes.map((lane) => {
      const value = values.get(lane.id);
      if (value === undefined) return null;
      return <li key={lane.id} style={{ "--channel": laneVar(lane.label) } as React.CSSProperties}>
        <span><LaneBadge lane={lane} /> {lane.name || languages[lane.language]}</span>
        <div className="comparison-track" aria-hidden="true"><div style={{ width: `${max > 0 ? value / max * 100 : 0}%` }} /></div>
        <span className="mono" title={metric === "timeNs" ? `${show(value)} ns` : undefined}>
          {formatMetric(metric, value)}
        </span>
      </li>;
    })}</ul>
  </section>;
}

function exportCsv(run: Run, settings: ChartSettings) {
  download(`benchscope-${run.id}.csv`, new Blob(["\uFEFF", resultsCsv(run, settings)], { type: "text/csv;charset=utf-8" }));
}

function ResultTable({ run, settings }: { run: Run; settings: ChartSettings }) {
  const [filter, setFilter] = useSearchParams();
  const laneFilter = filter.get("tableLane") ?? "";
  const search = filter.get("tableSearch") ?? "";
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>({ timeMax: false, timeAvg: false, ticksMin: false, ticksMax: false, ticksMean: false, pageFaults: false, throughput: false });
  const lanes = run.workspaceSnapshot.lanes;
  const columns = useMemo<ColumnDef<ResultRow>[]>(() => {
    return resultColumns(run, settings).map((column) => ({
      id: column.id,
      header: column.unit && column.kind !== "time" ? `${column.label} (${column.unit})` : column.label,
      accessorFn: column.value,
      enableHiding: column.kind !== "lane",
      cell: ({ row, getValue }) => {
        const value = getValue();
        if (column.kind === "lane") {
          const lane = lanes.find((lane) => lane.id === row.original.laneId);
          return lane ? <LaneBadge lane={lane} /> : String(value);
        }
        if (value === undefined) return "—";
        if (column.kind === "param") return param(column.label, value as string | number);
        if (column.kind === "time") return <span title={`${num.format(value as number)} ns`}>{time(value as number)}</span>;
        if (column.kind === "ratio") return formatRatio(value as number);
        return show(value as number);
      },
    }));
  }, [lanes, run.rows, run.sweep, settings.metric, settings.stat, settings.size, settings.normalize]);
  const data = useMemo(() => run.rows.filter((row) => (!laneFilter || laneFilter === row.laneId) &&
    Object.entries(row.params).map(([key, value]) => `${key}=${param(key, value)}`).join(" ").toLowerCase().includes(search.toLowerCase())), [run.rows, laneFilter, search]);
  const table = useReactTable({ data, columns, state: { sorting, columnVisibility: visibility }, onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  function update(key: string, value: string) {
    setFilter((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true, preventScrollReset: true });
  }
  return <section className="result-section" id="results-table" aria-labelledby="result-table-title">
    <div className="section-line table-controls"><h2 id="result-table-title">Results table</h2><div className="inline-controls">
      <button className="control" type="button" onClick={() => exportCsv(run, settings)} title="Export all rows and available table measurements; time values are in nanoseconds">
        <DownloadSimpleIcon size={16} aria-hidden="true" /> Export all CSV
      </button>
      <label className="sr-only" htmlFor="table-lane">Filter by lane</label><select id="table-lane" value={laneFilter} onChange={(e) => update("tableLane", e.target.value)}>
        <option value="">All lanes</option>{lanes.map((lane) => <option key={lane.id} value={lane.id}>Lane {lane.label}</option>)}
      </select>
      <label className="sr-only" htmlFor="table-params">Filter parameters</label><input id="table-params" type="search" placeholder="Filter parameters…" value={search} onChange={(e) => update("tableSearch", e.target.value)} />
      <details className="action-menu"><summary className="control">Columns</summary><div className="menu-panel">
        {table.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => <label className="check-setting" key={column.id}>
          <input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />{String(column.columnDef.header)}
        </label>)}
      </div></details>
    </div></div>
    {data.length ? <div className="table-scroll" tabIndex={0} aria-label="Sortable run results"><table className={data.length > 50 ? "long-table" : ""}>
      <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => {
        const order = header.column.getIsSorted();
        return <th key={header.id} aria-sort={order === "asc" ? "ascending" : order === "desc" ? "descending" : "none"}><button type="button" onClick={header.column.getToggleSortingHandler()}>
          {flexRender(header.column.columnDef.header, header.getContext())}{order === "asc" ? <ArrowUpIcon size={12} aria-hidden="true" /> : order === "desc" ? <ArrowDownIcon size={12} aria-hidden="true" /> : null}</button></th>;
      })}</tr>)}</thead>
      <tbody>{table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
    </table></div> : <div className="empty-panel"><p>{run.rows.length ? "No rows match these filters." : "This run has no recorded results."}</p>
      {run.rows.length > 0 && <button className="control" type="button" onClick={() => setFilter((current) => { const next = new URLSearchParams(current); next.delete("tableLane"); next.delete("tableSearch"); return next; }, { replace: true })}>Clear filters</button>}</div>}
  </section>;
}

function RunConfiguration({ run }: { run: Run }) {
  return <section className="result-section">
    <h2>Configuration</h2>
    <div className="config-grid">{run.workspaceSnapshot.lanes.map((lane) => <details key={lane.id} className="config-lane" style={{ "--channel": laneVar(lane.label) } as React.CSSProperties}>
      <summary><LaneBadge lane={lane} /> <strong>{languages[lane.language]}</strong><span className="help-text">Server toolchain · {lane.arch} · {lane.mode === "ejected" ? "Code" : "Scaffold"}</span></summary>
      <div className="config-lane-body"><dl className="readouts">
        <div><dt>{lane.language === "go" ? "Compiler options" : "Interpreter options"}</dt><dd><code>{compilerOptionsText(lane.build) || "Default"}</code></dd></div>
        <div><dt>Runner</dt><dd>Server defaults</dd></div>
        <div><dt>Bytes per iteration</dt><dd>{lane.execution?.byteCount ?? 0}</dd></div><div><dt>Fenced timing</dt><dd>{(lane.execution?.fenced ?? true) ? "On" : "Off"}</dd></div>
        {lane.scaffold && <div><dt>Scaffold model</dt><dd>{lane.scaffold.model}</dd></div>}
      </dl>
      {(["benchmark.perf", harness(lane.language)] as FileName[]).map((file) => lane.files[file] !== undefined && <details key={file} className="snapshot-file"><summary><code>{file}</code></summary><div className="read-editor"><Suspense fallback={<EditorSkeleton />}><Editor file={file} value={lane.files[file]!} label={`Lane ${lane.label} snapshot ${file}`} readOnly /></Suspense></div></details>)}</div>
    </details>)}</div>
    <details className="snapshot-details"><summary>Execution target snapshots</summary><p className="help-text">Captured for this run.</p><>{(run.machines ?? [run.machine]).map((machine, index) => <MachineDetails key={`${machine.id}-${index}`} machine={machine} />)}</></details>
  </section>;
}

function RunView({ run }: { run: Run }) {
  const [url, setUrl] = useSearchParams();
  const exportRef = useRef<(() => string) | null>(null);
  const chartType = chartTypes.find((entry) => entry === url.get("chart")) ?? "line";
  const presentMetrics = metrics.filter((entry) => run.rows.some((row) => row.metrics[entry]));
  const metric = presentMetrics.find((entry) => entry === url.get("metric")) ?? presentMetrics[0] ?? "cycles";
  const compareMetric = presentMetrics.find((entry) => entry === url.get("against")) ?? presentMetrics.find((entry) => entry !== metric) ?? "timeNs";
  const availableStats = stats.filter(([value]) => run.rows.some((row) => row.metrics[metric]?.[value] !== undefined));
  const stat = availableStats.find(([value]) => value === url.get("stat"))?.[0] ?? availableStats[0]?.[0] ?? "min";
  const x = run.sweep.find((entry) => entry.name === url.get("x")) ?? run.sweep[0];
  const sizes = run.sweep.filter((entry) => entry.values.every((value) => typeof value === "number"));
  const size = sizes.find((entry) => entry.name === url.get("size"))?.name ?? sizes.find((entry) => entry.name === "N")?.name ?? "";
  const norm = url.get("normalize");
  const normalize: Normalize = !size ? "raw" : norm === "element" ? "element" : norm === "byte" ? "byte" : "raw";
  const group = run.sweep.find((entry) => entry.name === url.get("group") && entry.name !== x?.name)?.name ?? "";
  const heatLane = run.workspaceSnapshot.lanes.find((lane) => lane.id === url.get("heatLane"))?.id ?? run.workspaceSnapshot.lanes[0]?.id ?? "";
  const requestedYScale = url.get("yScale");
  const yScale: YScale = requestedYScale === "log" || requestedYScale === "linear" ? requestedYScale : "auto";
  const settings = useMemo<ChartSettings>(() => ({
    ...defaultChart, type: chartType, metric, stat, x: x?.name ?? "", size, normalize, group, heatLane,
    compareMetric,
    logX: url.get("xScale") !== "linear", yScale,
  }), [chartType, metric, stat, x, size, normalize, group, heatLane, yScale, compareMetric, url]);
  const insight = finding(run);
  const unavailable: Partial<Record<ChartType, string>> = {
    ratio: run.workspaceSnapshot.lanes.length < 2 ? "Add a second lane for ratios." : undefined,
    heatmap: run.sweep.length < 2 ? "Heatmaps need two sweep variables." : undefined,
    scatter: !run.rows.some((row) => row.metrics[metric]?.[stat] !== undefined && row.metrics[compareMetric]?.[stat] !== undefined) || metric === compareMetric ? "This chart needs two metrics with the selected statistic." : undefined,
  };
  const shownCharts = chartTypes.filter((value) => !unavailable[value]);

  function update(key: string, value: string) {
    setUrl((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true, preventScrollReset: true });
  }
  const rail = <div className="chart-fields">
    <label>Metric<select value={metric} onChange={(e) => update("metric", e.target.value)}>{presentMetrics.map((value) => <option value={value} key={value}>{metricNames[value]}</option>)}</select></label>
    <label>Statistic<select value={stat} onChange={(e) => update("stat", e.target.value)}>{availableStats.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {chartType === "scatter" ? <label>X metric<select value={settings.compareMetric} onChange={(e) => update("against", e.target.value)}>{presentMetrics.map((value) => <option value={value} key={value}>{metricNames[value]}</option>)}</select></label>
      : <label>X axis<select value={x?.name ?? ""} disabled={!x} onChange={(e) => update("x", e.target.value)}>{!x && <option value="">Permutation</option>}{run.sweep.map(({ name }) => <option key={name}>{name}</option>)}</select></label>}
    <label>Group by<select value={group} onChange={(e) => update("group", e.target.value)}><option value="">Lane</option>{run.sweep.filter(({ name }) => name !== x?.name).map(({ name }) => <option key={name}>{name}</option>)}</select></label>
    <div className="field-grid"><label>X scale<select value={settings.logX ? "log" : "linear"} onChange={(e) => update("xScale", e.target.value)}><option value="log">Log</option><option value="linear">Linear</option></select></label>
      <label>Y scale<select value={settings.yScale} disabled={chartType === "heatmap"} onChange={(e) => update("yScale", e.target.value === "auto" ? "" : e.target.value)}><option value="auto">Auto</option><option value="linear">Linear</option><option value="log">Log</option></select></label></div>
    <label>Normalize<select value={normalize} disabled={!size} onChange={(e) => update("normalize", e.target.value)}><option value="raw">Raw</option><option value="element">Per element</option><option value="byte">Per byte</option></select></label>
    <label>Size parameter<select value={size} onChange={(e) => update("size", e.target.value)}>{!size && <option value="">Select a parameter</option>}{sizes.map(({ name }) => <option key={name}>{name}</option>)}</select></label>
    {chartType === "heatmap" && <label>Lane<select value={heatLane} onChange={(e) => update("heatLane", e.target.value)}>{run.workspaceSnapshot.lanes.map((lane) => <option value={lane.id} key={lane.id}>Lane {lane.label}</option>)}</select></label>}
  </div>;

  return <div className="page results-page">
    <div className="results-heading">
      <div><h1>{run.workspaceSnapshot.title}</h1><p>{date.format(new Date(run.startedAt))} · {run.machines && run.machines.length > 1 ? `${run.machines.length} execution targets` : `${run.machine.id} · ${run.machine.arch} · ${num.format(run.machine.threads)} threads`} · {num.format(run.rows.length)} results · {duration(run.startedAt, run.finishedAt)}</p>
        <div className="result-status"><span className="chip">{statusLabel(run.status)}</span>{run.rows.length > 0 && <span className="chip">Measured on hardware</span>}</div></div>
      <div className="inline-controls">
        <Link to="/bench" state={{ workspace: run.workspaceSnapshot, fresh: true }} className="control">Open in workbench</Link>
        <Link to="/bench" state={{ workspace: run.workspaceSnapshot, fresh: true, rerun: true }} className="control primary">Run again</Link>
        <details className="action-menu"><summary className="control"><DownloadSimpleIcon size={16} aria-hidden="true" /> Export</summary><div className="menu-panel">
          <button type="button" onClick={() => exportCsv(run, settings)}>Results CSV (all data)</button>
          <button type="button" onClick={() => download(`benchscope-${run.id}.json`, new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }))}>JSON</button>
          <button type="button" onClick={() => { const image = exportRef.current?.(); if (image) download(`benchscope-${run.id}.png`, image); }}>Chart PNG</button>
        </div></details>
      </div>
    </div>
    <div className="finding">{insight.value && <strong>{insight.value}</strong>}<p>{insight.text}</p></div>
    <InputComparison rows={run.rows} lanes={run.workspaceSnapshot.lanes} metric={metric} stat={stat} />
    <div className="result-chart-grid">
      <div>
        {shownCharts.length > 1 && <div className="segmented chart-tabs" aria-label="Chart type">{shownCharts.map((value) => <button className="control" key={value} type="button" aria-pressed={value === chartType}
          onClick={() => update("chart", value)}>{chartLabels[value]}</button>)}</div>}
        <Suspense fallback={<div className="instrument loading-plot" role="status">Loading chart…</div>}>
          <Instrument title="Sweep results" rows={run.rows} lanes={run.workspaceSnapshot.lanes} sweep={run.sweep}
            settings={settings} caption={unavailable[chartType] ?? chartCaptions[chartType]} tableHref="#results-table" onExport={(exportChart) => { exportRef.current = exportChart; }} />
        </Suspense>
      </div>
      <details className="result-rail"><summary>Chart controls</summary>{rail}</details>
    </div>
    <p className="help-text">Miss counters and per-iteration fault counts marked fastest/slowest belong to the corresponding timed iterations. A dash means the measurement is unavailable; a measured zero is shown as 0.</p>
    <ResultTable run={run} settings={settings} />
    <RunConfiguration run={run} />
  </div>;
}

export default function Results() {
  const { runId = "" } = useParams();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => getRun(runId), refetchInterval: (query) => {
    const status = query.state.data?.status;
    return status && ["queued", "building", "running"].includes(status) ? 1000 : false;
  }, retry: false });
  if (run.isPending) return <div className="page results-page"><h1>Results</h1><div className="instrument loading-plot" role="status">Loading results…</div><EditorSkeleton text="Loading result rows…" /></div>;
  if (run.isError) return <div className="page route-stub"><h1>Results</h1><p className="error-text" role="alert">{run.error.message}</p><div className="inline-controls"><button className="control" type="button" onClick={() => void run.refetch()}>Try again</button><Link className="control" to="/bench">Open workbench</Link></div></div>;
  return <RunView run={run.data} key={runId} />;
}
