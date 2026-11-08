import type { Lane, ParseResponse, SweepParam } from "../api/types";

export const MAX_PERMUTATIONS = 256;
export function sweepCombinations(sweep: SweepParam[]) {
  return sweep.reduce((count, param) => count * param.values.length, 1);
}
export const serializeSweep = (sweep: SweepParam[]) => sweep.map(({ name, values }) => `${name}: ${JSON.stringify(values)}`).join("\n");
export function sweepMatrix(sweep: SweepParam[]): Record<string, number>[] {
  return sweep.reduce<Record<string, number>[]>((rows, { name, values }) =>
    rows.flatMap((row) => values.map((value) => ({ ...row, [name]: value }))), [{}]);
}
export function parseSweep(dsl: string): ParseResponse {
  const sweep: SweepParam[] = [];
  const errors: string[] = [];
  let inSweep = false;
  for (const [index, raw] of dsl.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith("#")) { inSweep = line === "#sweep"; continue; }
    if (!inSweep || !line) continue;
    const match = /^([A-Za-z_]\w*)\s*:\s*(\[.*\])$/.exec(line);
    try {
      if (!match) throw new Error();
      const values: unknown = JSON.parse(match[2]);
      if (!Array.isArray(values) || !values.length || !values.every((value) => typeof value === "number" && Number.isSafeInteger(value))) throw new Error();
      sweep.push({ name: match[1], values });
    } catch { errors.push(`Line ${index + 1}: use a parameter name and a nonempty integer list, e.g. N: [1024, 4096].`); }
  }
  const permutations = sweepCombinations(sweep);
  if (permutations > MAX_PERMUTATIONS) errors.push(`The sweep has ${permutations} combinations. The limit is ${MAX_PERMUTATIONS}.`);
  return { sweep, errors };
}

/** Every parameter used by any lane, with the union of its values across lanes. */
export function unionSweep(lanes: Lane[]): SweepParam[] {
  const sweeps = lanes.map((lane) => parseSweep(lane.files["benchmark.perf"] ?? "").sweep);
  return [...new Set(sweeps.flat().map(({ name }) => name))].map((name) => ({
    name, values: [...new Set(sweeps.flatMap((sweep) => sweep.find((entry) => entry.name === name)?.values ?? []))],
  }));
}
