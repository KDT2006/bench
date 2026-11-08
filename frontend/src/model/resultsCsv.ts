import type { Run } from "../api/types";
import { defaultChart, type ChartSettings } from "../chart/config";
import { resultColumns } from "./resultColumns";

// Export the table's measurements once, with numeric units in the headers.
export function resultsCsv(run: Run, settings: ChartSettings = defaultChart) {
  const columns = resultColumns(run, settings).filter((column) =>
    column.kind === "lane" || column.kind === "param" || run.rows.some((row) => column.value(row) !== undefined));
  const fields = columns.map((column) => column.unit ? `${column.label} (${column.unit})` : column.label);
  const rows = run.rows.map((row) => columns.map((column) => column.value(row)));
  return [fields, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
}
