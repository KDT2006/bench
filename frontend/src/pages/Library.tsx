import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { request, send } from "../api/client";
import type { Workspace } from "../api/types";
import { LaneBadge } from "../chart/config";
import { date, duration, languages } from "../model/format";
import { freshWorkspace, useBench } from "../model/state";
import { Overlay } from "../shell/Overlay";

export default function Library() {
  const [url, setUrl] = useSearchParams();
  const showingHistory = url.get("tab") === "history";
  const [selection, setSelection] = useState<string[]>([]);
  const [operation, setOperation] = useState<{ kind: "rename" | "delete"; bench: Workspace }>();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const history = useBench((s) => s.history);
  const query = useQueryClient();
  const benches = useQuery({ queryKey: ["benches"], queryFn: ({ signal }) => request<Workspace[]>("/benches", { signal }), retry: false, enabled: !showingHistory });
  async function mutate(kind: "rename" | "delete" | "duplicate", bench: Workspace) {
    if (pending || !bench.id) return;
    setPending(true); setError("");
    const path = `/benches/${encodeURIComponent(bench.id)}`;
    try {
      if (kind === "delete") {
        await request(path, { method: "DELETE" });
        const state = useBench.getState();
        if (state.workspace.id === bench.id) state.setWorkspace({ ...state.workspace, id: undefined }, true);
      } else if (kind === "rename") {
        const saved = await send<Workspace>(path, { ...bench, title: title.trim() }, "PUT");
        const state = useBench.getState();
        if (state.workspace.id === bench.id) state.setWorkspace({ ...state.workspace, title: saved.title }, state.dirty);
      } else {
        await send("/benches", { ...freshWorkspace(bench), title: `${bench.title} copy` });
      }
      await query.invalidateQueries({ queryKey: ["benches"] });
      setOperation(undefined);
      useBench.getState().notify({ text: kind === "delete" ? "Bench deleted." : kind === "duplicate" ? "Bench duplicated." : "Saved." });
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "The request failed. Try again.";
      setError(text); useBench.getState().notify({ text, error: true });
    } finally { setPending(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); if (operation) void mutate(operation.kind, operation.bench); }

  return <div className="page index-page library-page">
    <div className="page-heading"><h1>Library</h1><p>Reopen a saved bench or revisit a run with its original configuration.</p></div>
    <div className="section-line library-tabs"><div className="segmented" aria-label="Library view">
      <Link className="control" aria-current={!showingHistory ? "page" : undefined} to="/benches">Benches</Link>
      <Link className="control" aria-current={showingHistory ? "page" : undefined} to="/benches?tab=history">Run history</Link>
    </div>{showingHistory && (selection.length === 2 ? <Link className="control" to={`/results/${selection[0]}?compare=${encodeURIComponent(selection[1])}`}>Compare runs</Link>
      : <button className="control" type="button" disabled title="Select two runs to compare">Compare runs</button>)}</div>
    {showingHistory ? (history.length ? <div className="library-list">{history.map((entry) => <article className="library-row" key={entry.id}>
      <input aria-label={`Select ${entry.title} at ${date.format(new Date(entry.start))}`} type="checkbox" checked={selection.includes(entry.id)} disabled={selection.length === 2 && !selection.includes(entry.id)}
        onChange={(e) => setSelection((current) => e.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id))} />
      <div className="library-row-main"><h2>{entry.title}</h2><p>{date.format(new Date(entry.start))} · {entry.machine}</p></div>
      <span className="chip">{entry.status === "done" ? "Finished" : entry.status}</span><span className="mono library-duration">{duration(entry.start, entry.finish)}</span>
      <Link className="control" to={`/results/${entry.id}`}>View results</Link>
    </article>)}</div> : <div className="empty-panel"><ArchiveIcon size={28} aria-hidden="true" /><h2>No runs yet</h2><p>Run a bench to add it to your history.</p><Link className="control primary" to="/bench">Open the workbench</Link></div>)
      : benches.isPending ? <div className="library-list loading-state" role="status"><span className="sr-only">Loading benches…</span><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
        : benches.isError ? <div className="empty-panel"><p className="error-text">Couldn’t load saved benches.</p><button type="button" className="control" onClick={() => void benches.refetch()}>Try again</button></div>
          : benches.data.length ? <div className="library-list">{benches.data.map((bench) => {
            const last = history.find((entry) => entry.title === bench.title);
            return <article className="library-row" key={bench.id}>
              <div className="library-row-main"><h2>{bench.title}</h2><p>{[...new Set(bench.lanes.map((lane) => languages[lane.language]))].join(" · ")} · Modified {date.format(new Date(bench.updatedAt))}</p></div>
              <div className="lane-badges">{bench.lanes.map((lane) => <LaneBadge key={lane.id} lane={lane} />)}</div>
              {last && <Link className="text-action" to={`/results/${last.id}`}>Last run</Link>}
              <Link className="control" to="/bench" state={{ workspace: bench }}>Open</Link>
              <details className="action-menu"><summary className="control icon-control" aria-label={`Actions for ${bench.title}`} title="Bench actions"><DotsThreeIcon size={20} weight="bold" aria-hidden="true" /></summary><div className="menu-panel">
                <button type="button" onClick={(e) => { e.currentTarget.closest("details")!.open = false; setTitle(bench.title); setError(""); setOperation({ kind: "rename", bench }); }}>Rename</button>
                <button type="button" disabled={pending} onClick={(e) => { e.currentTarget.closest("details")!.open = false; void mutate("duplicate", bench); }}>Duplicate</button>
                <button type="button" onClick={(e) => { e.currentTarget.closest("details")!.open = false; setError(""); setOperation({ kind: "delete", bench }); }}>Delete</button>
              </div></details>
            </article>;
          })}</div> : <div className="empty-panel"><ArchiveIcon size={28} aria-hidden="true" /><h2>No saved benches yet</h2><p>Save a bench from the workbench and it shows up here.</p><Link className="control primary" to="/bench">Open the workbench</Link></div>}
    {operation && <Overlay title={operation.kind === "delete" ? "Delete bench?" : "Rename bench"} onClose={() => { if (!pending) setOperation(undefined); }}>
      <form className="overlay-body library-form" onSubmit={submit}>
        {operation.kind === "delete" ? <p>Delete “{operation.bench.title}” from your library?</p>
          : <label>Bench title<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="control" disabled={pending} onClick={() => setOperation(undefined)}>Cancel</button>
          <button className="control primary" type="submit" disabled={pending || (operation.kind === "rename" && !title.trim())}>{operation.kind === "delete" ? "Delete" : "Save"}</button></div>
      </form>
    </Overlay>}
    {showingHistory && selection.length > 0 && <button className="text-action" type="button" onClick={() => { setSelection([]); setUrl({ tab: "history" }, { replace: true }); }}>Clear selection</button>}
  </div>;
}
