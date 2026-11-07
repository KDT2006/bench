import primitives from "./primitives.json";
import { parseSweep } from "./sweep";

export { primitives };
export const directives = ["sweep", "imports", "setup", "bench", "clean"];
export const builtins = new Map(primitives.map((entry) => [entry.name, entry]));

export function diagnostics(dsl: string) {
  const issues = parseSweep(dsl).errors.map((message) => ({ message, line: Number(/^Line (\d+)/.exec(message)?.[1] ?? 1) }));
  if (!/^\s*#bench\s*$/m.test(dsl)) issues.push({ message: "Add a #bench section for the code you want to measure.", line: 1 });
  let section = "";
  const names = new Set(parseSweep(dsl).sweep.map((entry) => entry.name));
  dsl.split(/\r?\n/).forEach((raw, index) => {
    const source = raw.replace(/\/\/.*$/, "");
    const directive = /^\s*#(\w+)/.exec(source)?.[1];
    if (directive) section = directive;
    if (!["setup", "bench", "clean"].includes(section) || directive) return;
    if (/\bN\b/.test(source) && !names.has("N") && !/^\s*N\s*=/.test(source)) {
      issues.push({ line: index + 1, message: "Declare N in #sweep or assign it before use." });
    }
    if (/^\s*N\s*=/.test(source)) names.add("N");
    for (const call of source.matchAll(/\b([A-Za-z_]\w*)\(([^()]*)\)/g)) {
      const entry = builtins.get(call[1]);
      if (!entry && !["abs", "sqrt", "sin", "cos", "log", "min", "max", "len", "pow", "int", "float", "sort"].includes(call[1])) {
        issues.push({ line: index + 1, message: `Unknown primitive “${call[1]}”. See the Guide for supported calls.` });
      } else if (entry) {
        const count = call[2].trim() ? (call[2].match(/"(?:[^"\\]|\\.)*"|,/g) ?? []).filter((part) => part === ",").length + 1 : 0;
        if (count < entry.min || count > entry.max) issues.push({ line: index + 1, message: `Use ${entry.signature}.` });
      }
    }
  });
  return issues;
}
