import { useId } from "react";
import type { Lane } from "../api/types";
import { compilerOptionsText, parseCompilerOptions } from "../model/compilerOptions";
import { useBench } from "../model/state";

export default function CompilerOptions({ lane, readOnly = false }: { lane: Lane; readOnly?: boolean }) {
  const id = useId();
  const text = compilerOptionsText(lane.build);
  let error = "";
  try { parseCompilerOptions(text); } catch (issue) { error = (issue as Error).message; }
  const go = lane.language === "go";
  return <div className="compiler-options">
    <label htmlFor={id}>{go ? "Compiler options" : "Interpreter options"}</label>
    <input id={id} aria-label={`Lane ${lane.label} ${go ? "compiler" : "interpreter"} options`} value={text}
      placeholder={go ? '-gcflags="-N -l"' : "-O"} readOnly={readOnly} spellCheck={false}
      autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      title={go ? 'Go build flags, e.g. -gcflags="all=-N -l" -trimpath. Blank uses defaults.' : 'Python interpreter flags, e.g. -O, -OO, -B, -W error or -X dev. Blank uses defaults.'}
      onChange={(event) => {
        const compilerOptions = event.target.value;
        let flags: string[] | undefined;
        try { flags = parseCompilerOptions(compilerOptions); } catch { /* Keep unfinished quotes editable. */ }
        useBench.getState().changeLane(lane.id, (entry) => ({ ...entry, build: { ...entry.build, compilerOptions, ...(flags ? { flags } : {}) } }));
      }} />
    {error && <small id={`${id}-error`} className="error-text">{error}</small>}
  </div>;
}
