import type { ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { USE_MOCK_API } from "../api/config";
import type { Machine } from "../api/types";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function size(bytes: number) {
  const unit = [[1024 ** 3, "GiB"], [1024 ** 2, "MiB"], [1024, "KiB"], [1, "B"]] as const;
  const [factor, label] = unit.find(([factor]) => bytes >= factor) ?? unit[3];
  return `${number.format(bytes / factor)} ${label}`;
}

export function MachineState({ loading, error, retry }: { loading: boolean; error: boolean; retry: () => void }) {
  if (loading) return (
    <div className="loading-state" role="status">
      <span className="sr-only">Loading machine…</span>
      <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
    </div>
  );
  return (
    <div className="machine-state" role="status">
      <p className={error ? "error-text" : undefined}>{error ? "Couldn’t load machines. Try again." : "No machines available. Check again for a connected machine."}</p>
      <button className="control" type="button" onClick={retry}>
        <ArrowClockwiseIcon size={16} aria-hidden="true" /> {error ? "Try again" : "Check again"}
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="machine-group"><h3>{title}</h3>{children}</section>;
}

function Readouts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="readouts">{rows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl>;
}

export function MachineDetails({ machine, frozen = false }: { machine: Machine; frozen?: boolean }) {
  const maxCache = Math.max(1, ...machine.caches.map((cache) => Math.log2(cache.sizeBytes)));
  return (
    <div className="overlay-body machine-details">
      <div className="machine-identity">
        <div><h3>{machine.cpuModel}</h3><p className="mono">{machine.arch}</p></div>
        {!frozen && <span className="chip">{machine.status}</span>}
      </div>
      {USE_MOCK_API && <p className="source-note">Sample snapshot from the local mock API.</p>}
      <Group title="CPU">
        <Readouts rows={[
          ["Cores", number.format(machine.cores)], ["Threads", number.format(machine.threads)], ["SMT", machine.smt ? "On" : "Off"],
        ]} />
      </Group>
      <Group title="Clocks">
        <Readouts rows={[
          ["Base", `${number.format(machine.baseMhz / 1000)} GHz`],
          ["Boost", `${number.format(machine.boostMhz / 1000)} GHz`],
          ["Governor", machine.governor],
          ["Turbo", machine.turbo ? "On" : "Off"],
        ]} />
      </Group>
      <Group title="Caches">
        {machine.caches.length > 0 ? (
          <ul className="caches" aria-label="Cache sizes on a logarithmic scale">
            {machine.caches.map((cache) => (
              <li key={cache.level}>
                <span>{cache.level}</span>
                <div className="cache-track" aria-hidden="true"><span style={{ width: `${100 * Math.log2(cache.sizeBytes) / maxCache}%` }} /></div>
                <span>{size(cache.sizeBytes)}</span>
                <span className="cache-detail">{size(cache.lineSize)} lines{cache.assoc === undefined ? "" : ` · ${number.format(cache.assoc)}-way`}</span>
              </li>
            ))}
          </ul>
        ) : <p className="help-text">Cache sizes are unavailable for this machine.</p>}
      </Group>
      <Group title="Memory">
        <Readouts rows={[["RAM", size(machine.ramBytes)], ["Page size", size(machine.pageSize)]]} />
      </Group>
      <Group title="Operating system">
        <Readouts rows={[
          ["Kernel", machine.kernel],
          ["Isolated cores", machine.isolatedCores.map((core) => number.format(core)).join(", ") || "None"],
          ["Perf counters", machine.perfCounters ? "Available" : "Unavailable"],
        ]} />
      </Group>
      <Group title="Toolchains">
        <Readouts rows={Object.entries(machine.toolchains)} />
      </Group>
      {!frozen && <Group title="Live state">
        <Readouts rows={[["Status", machine.status], ["Queue length", number.format(machine.queueLength)]]} />
      </Group>}
      {(machine.turbo || machine.governor !== "performance" || !machine.isolatedCores.length) && (
        <div className="noise-note">
          <WarningIcon size={16} aria-hidden="true" />
          <div>
            {machine.turbo && <p>Turbo is on. Expect more run-to-run variance.</p>}
            {machine.governor !== "performance" && <p>The performance governor is off. Expect more run-to-run variance.</p>}
            {!machine.isolatedCores.length && <p>No cores are isolated. Other processes can affect timings.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
