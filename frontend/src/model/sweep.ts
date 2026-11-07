import type { ParseResponse, SweepParam } from "../api/types";

const units: Record<string, number> = { "": 1, K: 1024, KI: 1024, M: 1024 ** 2, MI: 1024 ** 2, G: 1024 ** 3, GI: 1024 ** 3 };
export const MAX_PERMUTATIONS = 200;

export function parseSweep(dsl: string): ParseResponse {
  const sweep: SweepParam[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  let inSweep = false;

  for (const [index, raw] of dsl.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (/^#\w+/.test(line)) inSweep = line === "#sweep";
    else if (inSweep && line && !line.startsWith("//")) {
      const match = /^(\w+)\s*=\s*\[(.*)\]$/.exec(line);
      if (!match || !/^[A-Za-z_]\w*$/.test(match[1]) || names.has(match[1])) {
        errors.push(`Line ${index + 1}: use a unique parameter name and a list of values.`);
        continue;
      }
      const [, name, list] = match;
      // Split at commas outside double-quoted strings and reject incomplete entries.
      const values = list.split(/,(?=(?:[^"\\]|\\.|"(?:[^"\\]|\\.)*")*$)/).map((part) => part.trim());
      try {
        const parsed = values.map((value): string | number => {
          if (value.startsWith('"')) return JSON.parse(value) as string;
          const number = /^(-?\d+(?:\.\d+)?)\s*(Ki?|Mi?|Gi?)?(?:B)?$/i.exec(value);
          if (!number) throw new Error();
          const scaled = Number(number[1]) * units[(number[2] ?? "").toUpperCase()];
          if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) throw new Error();
          return scaled;
        });
        if (!parsed.length) throw new Error();
        names.add(name);
        sweep.push({ name, values: parsed });
      } catch {
        errors.push(`Line ${index + 1}: enter numbers or double-quoted strings in the list.`);
      }
    }
  }
  const permutations = sweep.reduce((count, param) => count * param.values.length, 1);
  if (permutations > MAX_PERMUTATIONS) errors.push(`Reduce the sweep to ${MAX_PERMUTATIONS} permutations or fewer.`);
  return { sweep, permutations: errors.length ? 0 : permutations, errors };
}
