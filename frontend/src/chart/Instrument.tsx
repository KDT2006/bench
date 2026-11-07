import { useLayoutEffect, useRef } from "react";
import { init, use, type EChartsType, type EChartsCoreOption } from "echarts/core";
import { BarChart, BoxplotChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Lane, MachineSnapshot, ResultRow, SweepParam } from "../api/types";
import { bytes, laneVar, languages, metricNames, num, param, params } from "../model/format";
import { usePreferences } from "../shell/preferences";

use([LineChart, BarChart, ScatterChart, BoxplotChart, HeatmapChart, GridComponent, MarkLineComponent, MarkAreaComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

import { defaultChart, shapes, laneRatio, measurement, type ChartSettings } from "./config";

interface Props {
  rows: ResultRow[];
  lanes: Lane[];
  machine?: MachineSnapshot;
  sweep: SweepParam[];
  settings?: ChartSettings;
  caption?: string;
  title?: string;
  compact?: boolean;
  beam?: boolean;
  loading?: boolean;
  onExport?: (exportChart: (() => string) | null) => void;
  tableHref?: string;
}

function quantile(sorted: number[], q: number) {
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

export default function Instrument({ rows, lanes, machine, sweep, settings = defaultChart, caption, title = "Live sweep", compact, beam, loading, onExport, tableHref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType | null>(null);
  const theme = usePreferences((s) => s.theme);
  const exportHandler = useRef(onExport);
  exportHandler.current = onExport;
  const x = sweep.find(({ name }) => name === settings.x) ?? sweep[0];
  const y = sweep.find(({ name }) => name !== x?.name);
  const xName = x?.name ?? "Permutation";
  const ratio = laneRatio(rows, lanes, settings.metric, settings.stat);
  const labels = lanes.map((lane) => `${lane.label} · ${lane.name || languages[lane.language]}`);
  const heading = settings.type === "ratio" ? "Ratio to lane A" : `${metricNames[settings.metric]}${settings.normalize === "raw" ? "" : ` per ${settings.normalize}`}`;
  const xValues = x?.values ?? ["Default"];
  const isNumeric = xValues.every((value) => typeof value === "number");
  const numericX = isNumeric && !["bars", "distribution", "heatmap"].includes(settings.type) && (!settings.logX || xValues.every((value) => Number(value) > 0));
  const available = settings.type === "distribution" ? rows.some((row) => row.samples?.length)
    : settings.type === "heatmap" ? Boolean(x && y && rows.some((row) => measurement(row, settings) !== undefined))
      : settings.type === "ratio" ? lanes.length >= 2 && rows.some((row) => row.laneId !== lanes[0]?.id && ratio(row) !== undefined)
        : rows.some((row) => measurement(row, settings) !== undefined && (settings.type !== "scatter" || row.metrics[settings.compareMetric]?.[settings.stat] !== undefined));
  const summary = caption ?? (loading ? "Loading sweep…" : available
    ? `${num.format(rows.length)} results across ${num.format(lanes.length)} ${lanes.length === 1 ? "lane" : "lanes"}.`
    : rows.length ? "This run has no data for the selected chart." : "Results appear as each permutation finishes.");

  useLayoutEffect(() => {
    const node = host.current!;
    const chart = init(node, undefined, { renderer: "canvas" });
    instance.current = chart;
    const resize = new ResizeObserver(() => { if (node.clientWidth && node.clientHeight) chart.resize(); });
    resize.observe(node);
    exportHandler.current?.(() => chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: getComputedStyle(node).getPropertyValue("--canvas").trim() }));
    return () => { resize.disconnect(); exportHandler.current?.(null); chart.dispose(); instance.current = null; };
  }, []);

  useLayoutEffect(() => {
    const chart = instance.current!;
    const node = host.current!;
    const system = matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => {
      const css = getComputedStyle(node);
      const token = (name: string) => css.getPropertyValue(name).trim();
      const primary = token("--text-1");
      const secondary = token("--text-2");
      const hairline = token("--hairline");
      const grid = token("--graticule");
      const colors = lanes.map((lane) => token(`--lane-${lane.label.toLowerCase()}`));
      const mono = "Martian Mono";
      const cacheSizes = machine?.caches.filter((cache) => ["L1d", "L2", "L3"].includes(cache.level)) ?? [];
      const minX = isNumeric ? Math.min(...xValues.map(Number)) : 0;
      const maxX = isNumeric ? Math.max(...xValues.map(Number)) : 1;
      const showBands = settings.caches && numericX && xName === settings.size && settings.type !== "scatter";
      const groupValues = sweep.find((entry) => entry.name === settings.group)?.values ?? [null];
      const categoryLabels = xValues.map((v) => param(xName, v));
      const axes = { axisLine: { lineStyle: { color: hairline } }, axisLabel: { color: secondary, fontFamily: mono, fontSize: compact ? 9 : 10, hideOverlap: true }, splitLine: { lineStyle: { color: grid } }, axisTick: { show: false } };
      let series: Record<string, unknown>[] = lanes.flatMap((lane, laneIndex) => groupValues.map((groupValue, groupIndex) => {
        const own = rows.filter((row) => row.laneId === lane.id && (groupValue === null || row.params[settings.group] === groupValue));
        const name = groupValue === null ? labels[laneIndex] : `${labels[laneIndex]} · ${param(settings.group, groupValue)}`;
        const symbol = shapes[lane.label];
        const markLine = settings.type === "ratio" && laneIndex === 0 ? { symbol: "none", label: { color: secondary, formatter: "1.0×" }, lineStyle: { color: secondary }, data: [{ yAxis: 1 }] } : undefined;
        if (settings.type === "distribution") return {
          name, type: "boxplot", data: xValues.map((value) => {
            const samples = own.filter((row) => (row.params[xName] ?? "Default") === value).flatMap((row) => row.samples ?? []).sort((a, b) => a - b);
            return samples.length ? [samples[0], quantile(samples, 0.25), quantile(samples, 0.5), quantile(samples, 0.75), samples.at(-1)] : "-";
          }), itemStyle: { color: colors[laneIndex], borderColor: colors[laneIndex] },
        };
        const data = own.map((row) => {
          const coordinate = row.params[xName] ?? "Default";
          const value = settings.type === "ratio" ? ratio(row) : measurement(row, settings);
          return { name: params(row.params), value: [
            settings.type === "scatter" ? row.metrics[settings.compareMetric]?.[settings.stat] : numericX ? Number(coordinate) : param(xName, coordinate),
            value !== undefined && (!settings.logY || value > 0) ? value : null,
          ] };
        }).sort((a, b) => typeof a.value[0] === "number" && typeof b.value[0] === "number" ? a.value[0] - b.value[0] : 0);
        const type = settings.type === "bars" ? "bar" : settings.type === "scatter" ? "scatter" : "line";
        return { name, type, data, symbol, symbolSize: compact ? 4 : 7, showSymbol: true,
          animation: false, itemStyle: { color: colors[laneIndex] },
          lineStyle: { color: colors[laneIndex], width: compact ? 1.5 : 2, type: (groupIndex % 3 === 1 ? "dashed" : groupIndex % 3 === 2 ? "dotted" : "solid") },
          markLine,
        };
      }));
      let heatData: (number | string)[][] = [];
      if (settings.type === "heatmap" && y) {
        const selected = lanes.find((lane) => lane.id === settings.heatLane) ?? lanes[0];
        heatData = rows.filter((row) => row.laneId === selected?.id).flatMap((row) => {
          const value = measurement(row, settings);
          return value === undefined ? [] : [[param(xName, row.params[xName]), param(y.name, row.params[y.name]), value]];
        });
        series = [{ type: "heatmap", data: heatData, name: selected?.label ?? "Lane" }];
      }
      if (showBands && maxX > minX) {
        let from = minX;
        const bands: object[][] = [];
        for (const [index, cache] of cacheSizes.entries()) {
          if (cache.sizeBytes <= from) continue;
          const to = Math.min(cache.sizeBytes, maxX);
          bands.push([{ name: `${cache.level.replace("d", "")} · ${bytes(cache.sizeBytes)}`, xAxis: from, itemStyle: { color: index % 2 === 0 ? grid : "transparent" } }, { xAxis: to }]);
          from = to;
          if (from >= maxX) break;
        }
        if (from < maxX) bands.push([{ name: "DRAM", xAxis: from, itemStyle: { color: grid } }, { xAxis: maxX }]);
        series.unshift({ type: "line", data: [], silent: true, tooltip: { show: false }, animation: false,
          markArea: { silent: true, data: bands, label: { position: "insideTop", color: secondary, fontSize: compact ? 8 : 10, fontFamily: mono } },
          markLine: { silent: true, symbol: "none", data: cacheSizes.filter((cache) => cache.sizeBytes > minX && cache.sizeBytes < maxX).map((cache) => ({ xAxis: cache.sizeBytes })),
            label: { show: false }, lineStyle: { color: hairline, type: "dashed" } },
        });
      }
      if (beam && numericX && rows.length && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const position = rows.at(-1)?.params[xName];
        if (typeof position === "number") series.push({ type: "line", data: [], silent: true, animation: false,
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: secondary, type: "solid", opacity: 0.65 }, data: [{ xAxis: position }] },
        });
      }
      const xAxis = settings.type === "scatter" ? { ...axes, type: settings.logX ? "log" : "value", name: metricNames[settings.compareMetric] }
        : numericX ? { ...axes, type: settings.logX ? "log" : "value", logBase: 2, min: minX, max: maxX > minX ? maxX : undefined, name: xName,
          axisLabel: { ...axes.axisLabel, formatter: (v: number) => param(xName, v) } }
          : { ...axes, type: "category", data: categoryLabels, name: xName };
      const yAxis = settings.type === "heatmap" && y
        ? { ...axes, type: "category", data: y.values.map((v) => param(y.name, v)), name: y.name }
        : { ...axes, type: settings.logY ? "log" : "value", name: settings.type === "distribution" ? "Cycles / repetition" : heading };
      chart.setOption({
        animation: false, textStyle: { color: primary, fontFamily: mono }, color: colors,
        grid: { left: compact ? 38 : 64, right: compact ? 16 : 34, top: compact ? 16 : 38, bottom: compact ? 24 : 45 },
        xAxis: { ...xAxis, nameTextStyle: { color: secondary }, nameLocation: "middle", nameGap: 28, name: compact ? "" : xAxis.name },
        yAxis: { ...yAxis, nameTextStyle: { color: secondary }, name: compact ? "" : yAxis.name },
        series,
        ...(heatData.length ? { visualMap: { min: Math.min(...heatData.map((p) => Number(p[2]))), max: Math.max(...heatData.map((p) => Number(p[2]))), show: false, inRange: { color: [token("--raised"), colors[Math.max(0, lanes.findIndex((lane) => lane.id === settings.heatLane))] || primary] } } } : {}),
        tooltip: {
          show: !compact, trigger: ["scatter", "heatmap"].includes(settings.type) ? "item" : "axis",
          renderMode: "richText", confine: true, backgroundColor: token("--raised"), borderColor: hairline,
          textStyle: { color: primary, fontFamily: mono, fontSize: 11 },
          axisPointer: { type: settings.type === "bars" ? "shadow" : "cross", lineStyle: { color: secondary }, label: { backgroundColor: token("--raised"), color: primary } },
          formatter: (input: unknown) => {
            const points = (Array.isArray(input) ? input : [input]) as { seriesName: string; value: unknown[]; name?: string }[];
            const values = points.filter((p) => Array.isArray(p.value) && p.value[1] != null);
            const first = values[0];
            if (!first) return "";
            const lines = values.map((p) => `${p.seriesName}  ${p.value.slice(settings.type === "heatmap" ? 2 : 1).map((v) => typeof v === "number" ? num.format(v) : String(v)).join(" · ")}${settings.type === "ratio" ? "×" : ""}`);
            if (values.length === 2 && settings.type === "line" && Number(values[0].value[1])) lines.push(`B/A  ${num.format(Number(values[1].value[1]) / Number(values[0].value[1]))}×`);
            return [first.name || param(xName, String(first.value[0])), ...lines].join("\n");
          },
        },
      } as EChartsCoreOption, { notMerge: true });
    };
    redraw();
    system.addEventListener("change", redraw);
    return () => system.removeEventListener("change", redraw);
  }, [rows, lanes, machine, sweep, settings, theme, compact, beam, x, y, xName, xValues, isNumeric, numericX, heading, labels, ratio]);

  return <figure className={`instrument${compact ? " instrument-compact" : ""}`}>
    <div className="instrument-screen">
      {!compact && <div className="instrument-head"><div><h2>{title}</h2><span>{heading}</span></div>
        <div className="instrument-legend">{lanes.map((lane, index) => <span key={lane.id} style={{ "--channel": laneVar(lane.label) } as React.CSSProperties}><i className={`marker marker-${shapes[lane.label]}`} aria-hidden="true" />{labels[index]}</span>)}</div>
      </div>}
      <div className="instrument-plot" ref={host} aria-hidden="true" />
      {!available && !compact && <div className="plot-state">{loading ? "Loading results…" : rows.length ? "No data for this view" : "Waiting for results"}</div>}
      {!compact && <figcaption><span>{summary}</span>{tableHref && <a href={tableHref}>View as table</a>}</figcaption>}
      {compact && <figcaption className="sr-only">{summary}</figcaption>}
    </div>
  </figure>;
}
