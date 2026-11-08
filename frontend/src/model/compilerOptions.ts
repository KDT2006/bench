import type { BuildOptions } from "../api/types";

// Split command-line arguments without shell expansion or execution.
export function parseCompilerOptions(source: string): string[] {
  const args: string[] = [];
  let value = "", quote = "", started = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\" && quote !== "'") {
      if (++i === source.length) throw new Error("Finish the escaped character in compiler options.");
      value += source[i]; started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) { args.push(value); value = ""; started = false; }
    } else {
      value += char; started = true;
    }
  }
  if (quote) throw new Error("Close the quote in compiler options.");
  if (started) args.push(value);
  return args;
}

export function formatCompilerOptions(flags: string[]) {
  return flags.map((flag) => /[\s"'\\]/.test(flag) || !flag ? "'" + flag.replaceAll("'", "'\\''") + "'" : flag).join(" ");
}
export function compilerOptionsText(build: BuildOptions) {
  return build.compilerOptions ?? formatCompilerOptions(build.flags);
}
export function compilerFlags(build: BuildOptions) {
  return parseCompilerOptions(compilerOptionsText(build));
}
