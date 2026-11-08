import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { getExamples } from "../api/client";
import { expectations } from "../model/examples";
import { languages, num } from "../model/format";


export default function Examples() {
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? "";
  const language = params.get("language") ?? "";
  const arch = params.get("arch") ?? "";
  const search = params.get("q") ?? "";
  const examples = useQuery({ queryKey: ["examples"], queryFn: ({ signal }) => getExamples(signal), retry: false });
  const categories = [...new Set(examples.data?.map((entry) => entry.category))];
  const matching = examples.data?.filter(({ category: group, workspace, description }) => (!category || category === group) &&
    workspace.lanes.some((lane) => (!language || lane.language === language) && (!arch || lane.arch === arch)) &&
    `${workspace.title} ${description}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  function update(key: string, value: string) {
    setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true });
  }
  return <div className="page index-page">
    <header className="page-heading"><h1>Examples</h1><p>Start with a benchmark you can open, change, and run in the workbench.</p></header>
    <div className="filter-bar"><div className="segmented" aria-label="Category">
      {["", ...categories].map((value) => <button key={value} className="control" type="button" aria-pressed={value === category} onClick={() => update("category", value)}>{value || "All examples"}</button>)}
    </div><div className="inline-controls">
      <label className="sr-only" htmlFor="examples-search">Search examples</label><input id="examples-search" type="search" placeholder="Search examples…" value={search} onChange={(e) => update("q", e.target.value)} />
      <label className="sr-only" htmlFor="examples-language">Language</label><select id="examples-language" value={language} onChange={(e) => update("language", e.target.value)}><option value="">All languages</option><option value="go">Go</option><option value="python">Python</option></select>
      <label className="sr-only" htmlFor="examples-arch">Architecture</label><select id="examples-arch" value={arch} onChange={(e) => update("arch", e.target.value)}><option value="">All architectures</option><option>x86_64</option><option>arm64</option></select>
    </div></div>
    {examples.isPending ? <div className="example-grid loading-state" role="status"><span className="sr-only">Loading examples…</span><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
      : examples.isError ? <div className="empty-panel"><p className="error-text">Couldn’t load examples. Try again.</p><button className="control" type="button" onClick={() => void examples.refetch()}>Try again</button></div>
        : matching.length === 0 ? <div className="empty-panel"><p>{examples.data?.length ? "No examples match these filters." : "No examples are available yet."}</p>
          {params.size > 0 ? <button className="control" type="button" onClick={() => setParams({})}>Clear filters</button> : <Link className="control" to="/bench">Open the workbench</Link>}</div>
          : categories.map((group) => {
            const entries = matching.filter((entry) => entry.category === group);
            if (!entries.length) return null;
            return <section className="example-group" key={group}><h2>{group}</h2><div className="example-grid">{entries.map((entry) => (
              <Link className="example-card" key={entry.id} to={`/bench?example=${encodeURIComponent(entry.id)}`}>
                <div className="example-preview"><TerminalWindowIcon size={24} aria-hidden="true" /><code>{entry.workspace.lanes[0]?.files["benchmark.perf"]?.match(/#bench\n([^\n]+)/)?.[1] ?? "benchmark.perf"}</code></div>
                <div className="example-copy"><h3>{entry.workspace.title}</h3><p>{entry.description}</p>{expectations[entry.id] && <p className="help-text">{expectations[entry.id]}</p>}
                  <div className="param-chips">{[...new Set(entry.workspace.lanes.map((lane) => languages[lane.language]))].map((label) => <span className="chip" key={label}>{label}</span>)}
                    {[...new Set(entry.workspace.lanes.map((lane) => lane.arch))].map((label) => <span className="chip mono" key={label}>{label}</span>)}
                    <span className="chip">{num.format(entry.workspace.lanes.length)} {entry.workspace.lanes.length === 1 ? "lane" : "lanes"}</span></div>
                  <span className="text-action">Open in workbench <ArrowUpRightIcon size={15} aria-hidden="true" /></span>
                </div>
              </Link>
            ))}</div></section>;
          })}
  </div>;
}
