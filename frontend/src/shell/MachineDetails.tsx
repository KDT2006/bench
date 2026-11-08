import { useId, type ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import type { MachineSnapshot } from "../api/types";
import { bytes, languages, num } from "../model/format";

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

function Readouts({ rows }: { rows: [string, ReactNode, string?][] }) {
  return <dl className="machine-cards">{rows.map(([label, value, note]) => (
    <div className="machine-card" key={label}><dt>{label}</dt><dd>{value ?? "Unavailable"}</dd>{note && <dd className="machine-card-note">{note}</dd>}</div>
  ))}</dl>;
}

export function MachineDetails({ machine, status }: { machine: MachineSnapshot; status?: string }) {
  const hardware = machine.hardware;
  const cacheTitle = useId();
  return (
    <div className="overlay-body machine-details">
      <div className="machine-identity">
        <div><h3>{machine.id}</h3><p className="mono">{machine.languages?.map((language) => languages[language]).join(" / ")} · {machine.arch}</p></div>
        {status && <span className="chip">{status}</span>}
      </div>
      <section className="machine-group" aria-label="Processor and system">
        {hardware?.cpuModel && <div className="machine-cpu-model"><span>Processor</span><p>{hardware.cpuModel}</p></div>}
        <Readouts rows={[
          ["Architecture", machine.arch],
          ["Operating system", machine.os],
          ["Physical cores", hardware?.physicalCores ? num.format(hardware.physicalCores) : undefined, "OS-reported topology; may be virtualized"],
          ["Logical CPUs", num.format(machine.threads), "Reported by the execution runtime"],
          ["System memory", hardware?.memoryBytes ? bytes(hardware.memoryBytes) : undefined, "Host RAM reported by the OS"],
          ["CPU governor", hardware?.governor, "CPU 0 frequency policy"],
          ["Executors", machine.languages?.map((language) => languages[language]).join(", ") || "None"],
          ["Kernel", hardware?.kernel],
        ]} />
      </section>
      {Boolean(hardware?.caches?.length) && <section className="machine-group" aria-labelledby={cacheTitle}>
        <h3 id={cacheTitle}>Cache hierarchy</h3>
        <p className="machine-caption">CPU 0 cache instances. Shared caches are shown once; sizes can differ across cores.</p>
        <Readouts rows={hardware!.caches!.map((cache) => [
          `L${cache.level} ${cache.type.toLowerCase()}`, bytes(cache.sizeBytes),
          cache.sharedCpus ? `Logical CPUs ${cache.sharedCpus}` : undefined,
        ])} />
      </section>}
      <p className="machine-caption">Reported by the {machine.languages?.map((language) => languages[language]).join(" / ")} executor through the proxy.</p>
    </div>
  );
}
