import type { ParseResponse, SweepParam } from "../api/types";

export const MAX_PERMUTATIONS = 256;
const reserved = new Set("break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var _".split(" "));
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
  const names = new Set<string>();
  let inSweep = false;
  for (const [index, raw] of dsl.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith("#")) { inSweep = line === "#sweep"; continue; }
    if (!inSweep || !line) continue;
    const match = /^([A-Za-z_]\w*)\s*:\s*(\[.*\])$/.exec(line);
    try {
      if (!match || reserved.has(match[1]) || names.has(match[1])) throw new Error();
      const values: unknown = JSON.parse(match[2]);
      if (!Array.isArray(values) || !values.length || !values.every((value) => typeof value === "number" && Number.isSafeInteger(value))) throw new Error();
      names.add(match[1]);
      sweep.push({ name: match[1], values });
    } catch { errors.push(`Line ${index + 1}: use a unique parameter and a nonempty integer list, e.g. N: [1024, 4096].`); }
  }
  const permutations = sweepCombinations(sweep);
  if (permutations > MAX_PERMUTATIONS) errors.push(`The sweep has ${permutations} combinations. The limit is ${MAX_PERMUTATIONS}.`);
  return { sweep, permutations: errors.length ? 0 : permutations, errors };
}
