import type { ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import type { MachineSnapshot } from "../api/types";
import { languages, num } from "../model/format";

export function MachineState({ loading, error, retry }: { loading: boolean; error: boolean; retry: () => void }) {
  if (loading) return (
    <div className="loading-state" role="status">
      <span className="sr-only">Loading machine…</span>
      <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
    </div>
  );
  return (
    <div className="machine-state" role="status">
      <p className={error ? "error-text" : undefined}>{error ? "Couldn’t reach the execution server. Try again." : "No machine available. Check again for a connected server."}</p>
      <button className="control" type="button" onClick={retry}>
        <ArrowClockwiseIcon size={16} aria-hidden="true" /> {error ? "Try again" : "Check again"}
      </button>
    </div>
  );
}

function Readouts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="readouts">{rows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value ?? "Unavailable"}</dd></div>
  ))}</dl>;
}

export function MachineDetails({ machine, status }: { machine: MachineSnapshot; status?: string }) {
  return (
    <div className="overlay-body machine-details">
      <div className="machine-identity">
        <div><h3>{machine.id}</h3><p className="mono">{machine.arch}</p></div>
        {status && <span className="chip">{status}</span>}
      </div>
      <section className="machine-group">
        <Readouts rows={[
          ["Architecture", machine.arch],
          ["Operating system", machine.os],
          ["CPU threads", num.format(machine.threads)],
          ["Executors", machine.languages?.map((language) => languages[language]).join(", ") || "None"],
        ]} />
      </section>
    </div>
  );
}
