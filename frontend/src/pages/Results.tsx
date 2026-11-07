import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type CellContext, type ColumnDef, type SortingState, type VisibilityState } from "@tanstack/react-table";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { getRun } from "../api/client";
import { USE_MOCK_API } from "../api/config";
import type { FileName, ResultRow, Run, Stat } from "../api/types";
import { chartTypes, defaultChart, LaneBadge, laneRatio, type ChartSettings, type ChartType, type Normalize, type YScale } from "../chart/config";
import { bytes, date, duration, formatRatio, harness, laneVar, languages, metricNames, num, param, type Metric } from "../model/format";
import { MachineDetails } from "../shell/MachineDetails";
import { download } from "../model/download";
import { ShareDialog } from "./ShareDialog";
import { EditorSkeleton } from "../bench/Workbench";

const Instrument = lazy(() => import("../chart/Instrument"));
const Editor = lazy(() => import("../bench/Editor"));
const chartLabels: Record<ChartType, string> = { line: "Line", ratio: "Ratio", bars: "Bars", distribution: "Distribution", heatmap: "Heatmap", scatter: "Scatter" };
const stats: [keyof Stat, string][] = [["min", "Min"], ["median", "Median"], ["mean", "Mean"], ["p95", "P95"]];
const metrics = Object.keys(metricNames) as Metric[];

function show(value: number | undefined, suffix = "") { return value === undefined || !Number.isFinite(value) ? "—" : num.format(value) + suffix; }

function finding(run: Run) {
  const [a, b] = run.workspaceSnapshot.lanes;
  if (!a || !b) return { text: "Use the sweep to see how the cost of this benchmark changes with input size." };
  const ratios = laneRatio(run.rows, [a, b], "cycles", "min");
  const pairs = run.rows.filter((row) => row.laneId === b.id).flatMap((row) => {
    const ratio = ratios(row);
    return ratio && Number.isFinite(ratio) ? [{ ratio, n: row.params.N }] : [];
  });
  if (!pairs.length) return { text: "Compare lanes once both have results for the same parameters." };
  if (pairs.every(({ ratio }) => ratio >= 0.95 && ratio <= 1.05)) return { text: `Lanes ${a.label} and ${b.label} are within 5% of each other across the matched sizes.` };
  const l2 = run.machine.caches.find((cache) => cache.level === "L2")?.sizeBytes;
  const beyond = l2 ? pairs.filter(({ n }) => typeof n === "number" && n > l2) : [];
  const cohort = beyond.length ? beyond : pairs;
  const values = cohort.map((pair) => pair.ratio).sort((x, y) => x - y);
  const mid = (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2;
  if (cohort.some(({ ratio }) => mid >= 1 ? ratio <= 1 : ratio >= 1) || (mid >= 0.95 && mid <= 1.05)) return { text: "The faster lane depends on the input size. Use the ratio chart to see where they differ." };
  const [faster, slower] = mid >= 1 ? [a, b] : [b, a];
  const label = (lane: typeof a) => lane.name || (a.language === b.language ? `Lane ${lane.label}` : languages[lane.language]);
  const range = beyond.length && l2 ? `past L2 (${bytes(l2)})` : "across matched parameters";
  return {
    value: formatRatio(Math.max(mid, 1 / mid)),
    text: `${label(faster)} used fewer cycles than ${label(slower)} ${range}. Median ratio of minimum cycles.`,
  };
}

function exportCsv(run: Run) {
  const names = [...new Set([...run.sweep.map(({ name }) => name), ...run.rows.flatMap((row) => Object.keys(row.params))])];
  const allStats: (keyof Stat)[] = ["min", "median", "mean", "p95", "stddev"];
  const fields = ["Lane", ...names, "Repetitions", ...metrics.flatMap((metric) => allStats.map((stat) => `${metric}.${stat}`))];
  const rows = run.rows.map((row) => [run.workspaceSnapshot.lanes.find((lane) => lane.id === row.laneId)?.label, ...names.map((name) => row.params[name]),
    row.reps, ...metrics.flatMap((metric) => allStats.map((stat) => row.metrics[metric]?.[stat]))]);
  const csv = [fields, ...rows].map((row) => row.map((value) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  download(`benchscope-${run.id}.csv`, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

function ResultTable({ run, settings }: { run: Run; settings: ChartSettings }) {
  const [filter, setFilter] = useSearchParams();
  const laneFilter = filter.get("tableLane") ?? "";
  const search = filter.get("tableSearch") ?? "";
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>({ mean: false, median: false, p95: false, stddev: false, pageFaults: false, cacheMisses: false, throughput: false });
  const lanes = run.workspaceSnapshot.lanes;
  const columns = useMemo<ColumnDef<ResultRow>[]>(() => {
    const byId = new Map(lanes.map((lane) => [lane.id, lane]));
    const ratio = laneRatio(run.rows, lanes, settings.metric, settings.stat);
    const numeric = (id: string, header: string, accessorFn: (row: ResultRow) => number | undefined, suffix = ""): ColumnDef<ResultRow> => ({
      id, header, accessorFn, cell: (cell) => show(cell.getValue() as number | undefined, suffix),
    });
    return [
      { id: "lane", header: "Lane", accessorFn: (row) => byId.get(row.laneId)?.label, enableHiding: false, cell: ({ row }) => {
        const lane = byId.get(row.original.laneId); return lane && <LaneBadge lane={lane} />;
      } },
      ...run.sweep.map(({ name }) => ({
        id: `param-${name}`, header: name, accessorFn: (row: ResultRow) => row.params[name],
        cell: (cell: { getValue: () => unknown }) => cell.getValue() === undefined ? "—" : param(name, cell.getValue() as string | number),
      })),
      ...(["min", "median", "mean", "p95", "stddev"] as const).map((key) => numeric(key, `${key === "p95" ? "P95" : key === "stddev" ? "Std. dev." : key[0].toUpperCase() + key.slice(1)} cycles`, (row) => row.metrics.cycles?.[key])),
      { ...numeric("cv", "CV", (row) => row.metrics.cycles?.mean ? row.metrics.cycles.stddev / row.metrics.cycles.mean * 100 : undefined, "%"),
        cell: (cell) => { const value = cell.getValue() as number | undefined; return <>{show(value, "%")}{value !== undefined && value > 5 && <span className="chip noisy" title="Coefficient of variation exceeds 5%">Noisy</span>}</>; } },
      numeric("time", "Min ns", (row) => row.metrics.timeNs?.min),
      ...(settings.size ? [numeric("perSize", `Cycles per ${settings.normalize === "byte" ? "byte" : "element"}`, (row) => {
        const value = row.params[settings.size]; return typeof value === "number" && value > 0 && row.metrics.cycles ? row.metrics.cycles.min / value : undefined;
      })] : []),
      numeric("reps", "Reps", (row) => row.reps),
      ...(["pageFaults", "cacheMisses", "throughput"] as const).map((key) => numeric(key, metricNames[key], (row) => row.metrics[key]?.min)),
      ...(lanes.length > 1 ? [{
        ...numeric("ratio", `Ratio to ${lanes[0].label}`, ratio),
        cell: (cell: CellContext<ResultRow, unknown>) => formatRatio(cell.getValue() as number | undefined),
      }] : []),
    ];
  }, [lanes, run.rows, run.sweep, settings.metric, settings.stat, settings.size, settings.normalize]);
  const data = useMemo(() => run.rows.filter((row) => (!laneFilter || laneFilter === row.laneId) &&
    Object.entries(row.params).map(([key, value]) => `${key}=${param(key, value)}`).join(" ").toLowerCase().includes(search.toLowerCase())), [run.rows, laneFilter, search]);
  const table = useReactTable({ data, columns, state: { sorting, columnVisibility: visibility }, onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  function update(key: string, value: string) {
    setFilter((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true, preventScrollReset: true });
  }
  return <section className="result-section" id="results-table" aria-labelledby="result-table-title">
    <div className="section-line table-controls"><h2 id="result-table-title">Results table</h2><div className="inline-controls">
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
      <summary><LaneBadge lane={lane} /> <strong>{languages[lane.language]}</strong><span className="help-text">{lane.build.toolchainVersion} · {lane.arch} · {lane.mode === "ejected" ? "Code" : "Scaffold"}</span></summary>
      <div className="config-lane-body"><dl className="readouts"><div><dt>Flags</dt><dd>{lane.build.flags.join(" ") || "Default"}</dd></div>
        <div><dt>Repetition limit</dt><dd>{show(lane.runner.maxReps)}</dd></div><div><dt>Warmup</dt><dd>{show(lane.runner.warmup)}</dd></div>
        {lane.scaffold && <div><dt>Scaffold model</dt><dd>{lane.scaffold.model}</dd></div>}
      </dl>
      {(["benchmark.perf", harness(lane.language), "kernel.S"] as FileName[]).map((file) => lane.files[file] !== undefined && <details key={file} className="snapshot-file"><summary><code>{file}</code></summary><div className="read-editor"><Suspense fallback={<EditorSkeleton />}><Editor file={file} value={lane.files[file]!} label={`Lane ${lane.label} snapshot ${file}`} readOnly /></Suspense></div></details>)}</div>
    </details>)}</div>
    <details className="snapshot-details"><summary>Machine snapshot · {run.machine.cpuModel}</summary><p className="help-text">Captured for this run.</p><MachineDetails machine={{ ...run.machine, queueLength: 0, status: "idle" }} frozen /></details>
  </section>;
}

function RunView({ run }: { run: Run }) {
  const [url, setUrl] = useSearchParams();
  const [share, setShare] = useState(false);
  const [controlsInitiallyOpen] = useState(() => !matchMedia("(width < 768px)").matches);
  const exportRef = useRef<(() => string) | null>(null);
  const chartType = chartTypes.find((entry) => entry === url.get("chart")) ?? "line";
  const metric = metrics.find((entry) => entry === url.get("metric")) ?? "cycles";
  const stat = stats.find(([value]) => value === url.get("stat"))?.[0] ?? "min";
  const x = run.sweep.find((entry) => entry.name === url.get("x")) ?? run.sweep[0];
  const sizes = run.sweep.filter((entry) => entry.values.every((value) => typeof value === "number"));
  const size = sizes.find((entry) => entry.name === url.get("size"))?.name ?? sizes.find((entry) => entry.name === "N")?.name ?? "";
  const norm = url.get("normalize");
  const normalize: Normalize = !size || norm === "raw" ? "raw" : norm === "byte" ? "byte" : "element";
  const group = run.sweep.find((entry) => entry.name === url.get("group") && entry.name !== x?.name)?.name ?? "";
  const heatLane = run.workspaceSnapshot.lanes.find((lane) => lane.id === url.get("heatLane"))?.id ?? run.workspaceSnapshot.lanes[0]?.id ?? "";
  const requestedYScale = url.get("yScale");
  const yScale: YScale = requestedYScale === "log" || requestedYScale === "linear" ? requestedYScale : "auto";
  const settings = useMemo<ChartSettings>(() => ({
    ...defaultChart, type: chartType, metric, stat, x: x?.name ?? "", size, normalize, group, heatLane,
    compareMetric: metrics.find((entry) => entry === url.get("against")) ?? "timeNs",
    logX: url.get("xScale") !== "linear", yScale, caches: url.get("caches") !== "off",
  }), [chartType, metric, stat, x, size, normalize, group, heatLane, yScale, url]);
  const insight = finding(run);
  const compareId = url.get("compare");
  const compare = useQuery({ queryKey: ["run", compareId], queryFn: ({ signal }) => getRun(compareId!, signal), enabled: Boolean(compareId && compareId !== run.id) });
  const compatible = compare.data && JSON.stringify(compare.data.sweep) === JSON.stringify(run.sweep);
  const comparison = useMemo(() => {
    if (!compatible || !compare.data) return undefined;
    const a = run.workspaceSnapshot.lanes[0];
    const b = compare.data.workspaceSnapshot.lanes[0];
    if (!a || !b) return undefined;
    const second = { ...b, id: `comparison-${b.id}`, label: "B" as const, name: compare.data.workspaceSnapshot.title };
    const rows = [...run.rows.filter((row) => row.laneId === a.id), ...compare.data.rows.filter((row) => row.laneId === b.id).map((row) => ({ ...row, laneId: second.id }))];
    return { lanes: [{ ...a, label: "A" as const, name: run.workspaceSnapshot.title }, second], rows };
  }, [compatible, compare.data, run]);

  function update(key: string, value: string) {
    setUrl((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true, preventScrollReset: true });
  }
  const rail = <div className="chart-fields">
    <label>Metric<select value={metric} onChange={(e) => update("metric", e.target.value)}>{metrics.map((value) => <option value={value} key={value}>{metricNames[value]}</option>)}</select></label>
    <label>Statistic<select value={stat} onChange={(e) => update("stat", e.target.value)}>{stats.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {chartType === "scatter" ? <label>X metric<select value={settings.compareMetric} onChange={(e) => update("against", e.target.value)}>{metrics.map((value) => <option value={value} key={value}>{metricNames[value]}</option>)}</select></label>
      : <label>X axis<select value={x?.name ?? ""} disabled={!x} onChange={(e) => update("x", e.target.value)}>{!x && <option value="">Permutation</option>}{run.sweep.map(({ name }) => <option key={name}>{name}</option>)}</select></label>}
    <label>Group by<select value={group} onChange={(e) => update("group", e.target.value)}><option value="">Lane</option>{run.sweep.filter(({ name }) => name !== x?.name).map(({ name }) => <option key={name}>{name}</option>)}</select></label>
    <div className="field-grid"><label>X scale<select value={settings.logX ? "log" : "linear"} onChange={(e) => update("xScale", e.target.value)}><option value="log">Log</option><option value="linear">Linear</option></select></label>
      <label>Y scale<select value={settings.yScale} disabled={chartType === "heatmap"} onChange={(e) => update("yScale", e.target.value === "auto" ? "" : e.target.value)}><option value="auto">Auto</option><option value="linear">Linear</option><option value="log">Log</option></select></label></div>
    <label>Normalize<select value={normalize} disabled={!size} onChange={(e) => update("normalize", e.target.value)}><option value="raw">Raw</option><option value="element">Per element</option><option value="byte">Per byte</option></select></label>
    <label>Size parameter<select value={size} onChange={(e) => update("size", e.target.value)}>{!size && <option value="">Select a parameter</option>}{sizes.map(({ name }) => <option key={name}>{name}</option>)}</select></label>
    {chartType === "heatmap" && <label>Lane<select value={heatLane} onChange={(e) => update("heatLane", e.target.value)}>{run.workspaceSnapshot.lanes.map((lane) => <option value={lane.id} key={lane.id}>Lane {lane.label}</option>)}</select></label>}
    <label className="check-setting"><input type="checkbox" checked={settings.caches} onChange={(e) => update("caches", e.target.checked ? "on" : "off")} /> Cache bands</label>
  </div>;

  return <div className="page results-page">
    <div className="results-heading">
      <div><h1>{run.workspaceSnapshot.title}</h1><p>{date.format(new Date(run.startedAt))} · {run.machine.cpuModel} · {num.format(run.rows.length)} results · {duration(run.startedAt, run.finishedAt)}</p>
        <div className="result-status"><span className="chip">{run.status === "done" ? "Finished" : run.status}</span>{USE_MOCK_API && <span className="help-text">Synthetic replay data</span>}</div></div>
      <div className="inline-controls">
        <Link to="/bench" state={{ workspace: run.workspaceSnapshot, fresh: true }} className="control">Open in workbench</Link>
        <Link to="/bench" state={{ workspace: run.workspaceSnapshot, fresh: true, rerun: true }} className="control primary">Run again</Link>
        <button className="control" type="button" onClick={() => setShare(true)}>Share</button>
        <details className="action-menu"><summary className="control"><DownloadSimpleIcon size={16} aria-hidden="true" /> Export</summary><div className="menu-panel">
          <button type="button" onClick={() => exportCsv(run)}>CSV</button>
          <button type="button" onClick={() => download(`benchscope-${run.id}.json`, new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }))}>JSON</button>
          <button type="button" onClick={() => { const image = exportRef.current?.(); if (image) download(`benchscope-${run.id}.png`, image); }}>Chart PNG</button>
        </div></details>
      </div>
    </div>
    <div className="finding">{insight.value && <strong>{insight.value}</strong>}<p>{insight.text}</p></div>
    {compareId && <div className="bench-banner"><span>{compare.isPending ? "Loading comparison…" : compare.isError ? "The comparison run could not be loaded." : compatible ? "Comparing the first lane of each run." : "These runs use different sweep parameters."}</span>
      <button className="control" type="button" onClick={() => update("compare", "")}>Clear comparison</button></div>}
    <div className="result-chart-grid">
      <div>
        <Suspense fallback={<div className="instrument loading-plot" role="status">Loading chart…</div>}>
          <Instrument title="Sweep results" rows={comparison?.rows ?? run.rows} lanes={comparison?.lanes ?? run.workspaceSnapshot.lanes} machine={run.machine} sweep={run.sweep}
            settings={settings} caption={insight.text} tableHref="#results-table" onExport={(exportChart) => { exportRef.current = exportChart; }} />
        </Suspense>
        <div className="segmented chart-tabs" aria-label="Chart type">{chartTypes.map((value) => <button className="control" key={value} type="button" aria-pressed={value === chartType}
          title={value === "distribution" && !run.rows.some((row) => row.samples?.length) ? "This run has no raw samples" : value === "heatmap" && run.sweep.length < 2 ? "Heatmaps need two sweep parameters" : undefined}
          onClick={() => update("chart", value)}>{chartLabels[value]}</button>)}</div>
      </div>
      <details className="result-rail" open={controlsInitiallyOpen}><summary>Chart controls</summary>{rail}</details>
    </div>
    <ResultTable run={run} settings={settings} />
    <RunConfiguration run={run} />
    {share && <ShareDialog workspace={run.workspaceSnapshot} runId={run.id} close={() => setShare(false)} />}
  </div>;
}

export default function Results() {
  const { runId = "" } = useParams();
  const run = useQuery({ queryKey: ["run", runId], queryFn: ({ signal }) => getRun(runId, signal), refetchInterval: (query) => {
    const status = query.state.data?.status;
    return status && ["queued", "building", "running"].includes(status) ? 1000 : false;
  }, retry: false });
  if (run.isPending) return <div className="page results-page"><h1>Results</h1><div className="instrument loading-plot" role="status">Loading results…</div><EditorSkeleton text="Loading result rows…" /></div>;
  if (run.isError) return <div className="page route-stub"><h1>Results</h1><p className="error-text" role="alert">{run.error.message}</p><div className="inline-controls"><button className="control" type="button" onClick={() => void run.refetch()}>Try again</button><Link className="control" to="/benches?tab=history">Run history</Link></div></div>;
  return <RunView run={run.data} key={runId} />;
}
