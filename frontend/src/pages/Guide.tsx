import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { primitives } from "../model/dsl";
import { freshWorkspace } from "../model/state";
import { assembleSections, directives as directiveNames, type Directive } from "../model/sections";
import { starterWorkspace } from "../model/examples";

const sections = [
  { id: "quick-start", title: "Quick start", copy: "Open the array sum example, read its sweep, then press Run. Open full results to compare the lanes against the machine’s cache boundaries." },
  { id: "how-it-works", title: "How it works", copy: "Benchscope parses the sweep, generates a harness for each scaffold lane, executes the snapshot, and returns a result for each permutation. The local mock replays the array-sum fixture." },
  { id: "directives", title: "Directives", copy: "Each directive starts a section. The runner reads #sweep itself. Code generation receives the remaining sections." },
  { id: "language", title: "Language constructs", copy: "Assign with name = expression. Use for i in 0..N: to iterate over indices and if condition: to branch. Indent the body when it spans multiple lines. Use // for comments." },
  { id: "data-structures", title: "Data structures", copy: "Read or write an array at arr[index] and a map at table[key]. Make data in #setup and keep the operation under test in #bench." },
  { id: "algorithms", title: "Algorithms", copy: "Compare sequential, binary, and hash-based lookups. Binary search requires sorted input." },
  { id: "syscalls", title: "Syscalls", copy: "Reserve memory and work with file handles. Keep initialization or cleanup outside the timed block unless it is the operation you intend to measure." },
  { id: "primitives", title: "Primitives", copy: "Use shared operations across languages. Go and Python expansions below are illustrative." },
  { id: "metrics", title: "Metrics", copy: "Timer ticks come from the processor timer, time uses nanoseconds, page faults count memory faults, L1 data-cache read misses and branch-prediction misses are recorded for the fastest and slowest timed iterations when the counters are available, and throughput describes work per unit time when the harness reports it." },
  { id: "reading-results", title: "Reading results", copy: "Use minimum cycles to estimate the cost with fewer interruptions. Median and p95 are shown only when supplied by the runner. Coefficient of variation divides standard deviation by the mean. Normalize by a size parameter to compare work per element." },
  { id: "pitfalls", title: "Pitfalls", copy: "Compiler elimination, cold caches, page faults, garbage collection, and Python interpreter overhead can change what a short benchmark measures." },
  { id: "code-mode", title: "Writing ejected harnesses", copy: "Choose Edit as code to edit the harness directly. Edit sweep inputs separately in the Sweep tab. The mock accepts the workspace and replays the fixture. Live code mode accepts the same six directive sections with executable code; sweep values are injected by the executor." },
  { id: "assembly", title: "Assembly and FFI", copy: "Add kernel.S and keep its syntax and calling convention aligned with the selected architecture. The live proxy does not accept assembly files. On x86_64 SysV the first integer arguments use registers such as rdi and rsi. On AArch64 they begin at x0." },
];

const directiveCopy: Record<Directive, string> = {
  imports: "Dependencies required by the generated code.",
  globals: "Package-level variables and helper functions, including observable results.",
  sweep: "Integer parameter lists, e.g. N: [1024, 4096]. The runner forms the Cartesian product.",
  setup: "Prepare data before each measured iteration.",
  bench: "Only this section is timed.",
  cleanup: "Release resources after each measured iteration.",
};
const directives = directiveNames.map((name) => [`#${name}`, directiveCopy[name]]);

const lists: Record<string, string[]> = {
  algorithms: ["linear_search", "binary_search", "hashmap_lookup"],
  syscalls: ["allocate", "free", "mmap", "open", "close", "io_read"],
  primitives: ["gen_file", "sink", "rand", "random_array", "flush_cache", "align"],
};
const preparations: Record<string, string> = {
  sink: "total = N", free: "buf = allocate(N)", close: 'fd = open("data.bin", "r")', io_read: 'fd = open("data.bin", "r")',
  linear_search: "arr = [0, 1, 2]\nkey = 1", binary_search: "arr = [0, 1, 2]\nkey = 1", hashmap_lookup: "table = {1: 2}\nkey = 1",
};
function Primitive({ entry }: { entry: typeof primitives[number] }) {
  const [lang, setLang] = useState<"go" | "python">("go");
  const workspace = freshWorkspace(starterWorkspace());
  workspace.title = entry.name;
  const prep = preparations[entry.name];
  workspace.lanes[0].files["benchmark.perf"] = assembleSections({ sweep: "N: [1024, 4096]", setup: prep, bench: entry.example });
  return <article className="primitive-doc" id={entry.name}>
    <h3><a href={`#${entry.name}`}><code>{entry.signature}</code></a></h3>
    <p>{entry.description}</p>
    <pre><code>{entry.example}</code></pre>
    <div className="segmented" aria-label="Illustrative translations">{(["go", "python"] as const).map((value) => <button className="control" type="button" key={value} aria-pressed={lang === value} onClick={() => setLang(value)}>{value === "go" ? "Go" : "Python"}</button>)}</div>
    <pre><code>{entry[lang]}</code></pre>
    <Link to="/bench" state={{ workspace, fresh: true }} className="control">Try it</Link>
  </article>;
}

export default function Guide() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const query = q.toLowerCase().trim();
  const input = useRef<HTMLInputElement>(null);
  const { hash } = useLocation();
  const matches = (text: string) => text.toLowerCase().includes(query);
  const visible = sections.filter((section) => !query || matches(`${section.title} ${section.copy}`) || primitives.some((entry) => lists[section.id]?.includes(entry.name) && matches(`${entry.name} ${entry.description}`)));
  useEffect(() => { if (hash) { let id = hash.slice(1); try { id = decodeURIComponent(id); } catch { /* an invalid fragment can be ignored */ } document.getElementById(id)?.scrollIntoView(); } }, [hash]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => { if (e.key === "/" && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLElement && (e.target.closest("input,textarea,select") || e.target.isContentEditable))) { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  return <div className="page index-page guide-page">
    <div className="page-heading"><h1>Guide</h1><p>Write a benchmark, understand the runner, and read the results.</p></div>
    <div className="guide-search"><label className="sr-only" htmlFor="guide-search">Search guide</label><input ref={input} id="guide-search" type="search" placeholder="Search the guide…" value={q}
      onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} /><kbd>/</kbd></div>
    <div className="guide-layout">
      <aside className="guide-nav"><nav aria-label="Guide contents"><h2>Contents</h2>{visible.map((section) => <a href={`#${section.id}`} key={section.id}>{section.title}</a>)}</nav></aside>
      <div className="guide-content">
        {visible.length === 0 && <div className="empty-panel"><p>No guide entries match “{q}”.</p><button className="control" type="button" onClick={() => setParams({})}>Clear search</button></div>}
        {visible.map((section) => <section id={section.id} key={section.id}>
          <h2><a href={`#${section.id}`}>{section.title}</a></h2><p>{section.copy}</p>
          {section.id === "quick-start" && <><pre><code>{starterWorkspace().lanes[0].files["benchmark.perf"]}</code></pre><Link className="control primary" to="/bench?example=sample-array-sum">Open in workbench</Link></>}
          {section.id === "directives" && <dl className="directive-list">{directives.map(([token, meaning]) => <div key={token}><dt><code>{token}</code></dt><dd>{meaning}</dd></div>)}</dl>}
          {section.id === "how-it-works" && <div className="guide-flow"><span>DSL</span><span>Harness</span><span>Repetition tester</span><span>Results</span></div>}
          {section.id === "pitfalls" && <div className="guide-callout"><InfoIcon size={20} aria-hidden="true" /><p>Keep the result observable with <code>sink</code>. Move setup outside <code>#bench</code> unless setup is the operation you want to measure.</p></div>}
          {section.id === "assembly" && <pre><code>{'.text\n.globl kernel\nkernel:\n  mov %rdi, %rax\n  ret'}</code></pre>}
          {primitives.filter((entry) => lists[section.id]?.includes(entry.name) && (!query || matches(`${section.title} ${section.copy} ${entry.name} ${entry.description}`))).map((entry) => <Primitive key={entry.name} entry={entry} />)}
        </section>)}
      </div>
      <aside className="guide-outline"><nav aria-label="On this page"><h2>On this page</h2>{visible.filter((section) => ["quick-start", "directives", "primitives", "metrics", "reading-results", "assembly"].includes(section.id)).map((section) => <a href={`#${section.id}`} key={section.id}>{section.title}</a>)}</nav></aside>
    </div>
  </div>;
}
