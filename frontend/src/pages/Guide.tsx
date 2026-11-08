import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { primitives } from "../model/dsl";
import { freshWorkspace } from "../model/state";
import { assembleSections, directives as directiveNames, type Directive } from "../model/sections";
import { starterWorkspace } from "../model/examples";

const sections = [
  { id: "quick-start", title: "Quick start", copy: "Open the array sum example, read its sweep, then press Run. Open full results to compare the lanes as the input grows." },
  { id: "how-it-works", title: "How it works", copy: "Bench.it parses the sweep and has Gemini translate each scaffold lane into a harness. It then sends one request per sweep combination to the execution server, which builds and times the harness and returns the measurements. Results stay in the current tab." },
  { id: "directives", title: "Directives", copy: "Each directive starts a section. The runner reads #sweep itself. Code generation receives the remaining sections." },
  { id: "language", title: "Language constructs", copy: "Assign with name = expression. Use for i in 0..N: to iterate over indices and if condition: to branch. Indent the body when it spans multiple lines. Use // for comments." },
  { id: "data-structures", title: "Data structures", copy: "Read or write an array at arr[index] and a map at table[key]. Make data in #setup and keep the operation under test in #bench." },
  { id: "algorithms", title: "Algorithms", copy: "Compare sequential, binary, and hash-based lookups. Binary search requires sorted input." },
  { id: "syscalls", title: "Syscalls", copy: "Reserve memory and work with file handles. Keep initialization or cleanup outside the timed block unless it is the operation you intend to measure." },
  { id: "primitives", title: "Primitives", copy: "Use shared operations across languages. Go and Python expansions below are illustrative." },
  { id: "metrics", title: "Metrics", copy: "Timer ticks come from the processor timer, time uses nanoseconds, page faults count memory faults, L1 data-cache read misses and branch-prediction misses are recorded for the fastest and slowest timed iterations when the counters are available, and throughput describes work per unit time when the harness reports it." },
  { id: "reading-results", title: "Reading results", copy: "Use the minimum time to estimate the cost with fewer interruptions. Mean and maximum show how much the other iterations varied. Normalize by a size parameter to compare work per element." },
  { id: "pitfalls", title: "Pitfalls", copy: "Compiler elimination, cold caches, page faults, garbage collection, and Python interpreter overhead can change what a short benchmark measures." },
  { id: "code-mode", title: "Writing ejected harnesses", copy: "Choose Edit as code to edit the harness directly. Edit sweep inputs separately in the Sweep tab. Code mode uses the same six directive sections with executable code; the executor injects the sweep values before #setup." },
  { id: "native-assembly", title: "Native assembly", copy: "Open native.asm (x64) or native.S (ARM64) and choose Load NOP example to start a native benchmark. The example includes MOV, NOP, CMP and DEC loops; call the routine you want in #bench. Declare assembly functions in #globals in code mode. Each code and assembly field accepts up to 65,536 Unicode characters. Assembly is saved, duplicated and exported with the lane." },
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
    <div className="page-heading"><h2>Guide</h2><p>Write a benchmark, understand the runner, and read the results.</p></div>
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
          {section.id === "how-it-works" && <div className="guide-flow"><span>DSL</span><span>Gemini harness</span><span>Execution server</span><span>Results</span></div>}
          {section.id === "pitfalls" && <div className="guide-callout"><InfoIcon size={20} aria-hidden="true" /><p>Keep the result observable with <code>sink</code>. Move setup outside <code>#bench</code> unless setup is the operation you want to measure.</p></div>}
          {section.id === "native-assembly" && <>
            <p>Go uses cgo to bind bodyless declarations. Supported types are fixed-width integers, int, uint, uintptr, float32, float64, byte, rune, and pointers to those types. A function can return one value or no value.</p>
            <pre><code>{"#globals\nfunc NOPAllBytesASM(count uint64)\n\n#bench\nNOPAllBytesASM(uint64(N))"}</code></pre>
            <p>Python binds pass or ellipsis stubs with ctypes annotations, including numeric types, c_void_p and POINTER(type). Specify the return type explicitly; use None for void.</p>
            <pre><code>{"#imports\nimport ctypes\n\n#globals\ndef NOPAllBytesASM(count: ctypes.c_uint64) -> None:\n    ...\n\n#bench\nNOPAllBytesASM(N)"}</code></pre>
            <p>Executors require GCC or Clang; Go also requires CGO_ENABLED=1. The x64 example uses NASM (install nasm on the executor), with global, section .text, db, and semicolon comments. The executor detects NASM directives and handles object format, macOS symbol prefixes, and Linux stack metadata. Existing GNU/Clang assembly is also supported. ARM64 uses GNU/Clang AArch64 syntax, with examples generated for the selected host.</p>
            <p>Assembly follows the host C ABI: x64 Linux/macOS passes the first two integer arguments in RDI/RSI; Windows examples using RCX/RDX need those registers adapted. ARM64 uses X0/X1. Preserve callee-saved registers and stack alignment, return normally, and use position-independent addressing. Go pointer arguments must obey cgo pointer rules and cannot be retained after the call.</p>
            <p>Both cgo and ctypes calls add overhead inside the timed region. Put repeated work inside the assembly function when measuring short instructions. The executor runs only its native architecture. Go Plan 9 syntax, inline assembly and ARM32 are unsupported. Compiler and linker errors appear in the run log.</p>
          </>}
          {primitives.filter((entry) => lists[section.id]?.includes(entry.name) && (!query || matches(`${section.title} ${section.copy} ${entry.name} ${entry.description}`))).map((entry) => <Primitive key={entry.name} entry={entry} />)}
        </section>)}
      </div>
      <aside className="guide-outline"><nav aria-label="On this page"><h2>On this page</h2>{visible.filter((section) => ["quick-start", "directives", "primitives", "metrics", "reading-results", "code-mode"].includes(section.id)).map((section) => <a href={`#${section.id}`} key={section.id}>{section.title}</a>)}</nav></aside>
    </div>
  </div>;
}
