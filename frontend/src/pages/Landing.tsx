import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { sampleRun } from "../model/examples";
import { languages, num } from "../model/format";
import { API_BASE_URL } from "../api/config";
import { getMachines } from "../api/client";

const Instrument = lazy(() => import("../chart/Instrument"));
const LandingSequence = lazy(() => import("./LandingSequence"));
const fixture = sampleRun.workspaceSnapshot;

function ServerStatus() {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    const ping = () => fetch(`${API_BASE_URL}/health`).then((res) => setOnline(res.ok), () => setOnline(false));
    ping();
    const timer = setInterval(ping, 10_000);
    return () => clearInterval(timer);
  }, []);
  const label = online ? "Server online" : "Server offline";
  return <span className="server-status" role="status" title={label} aria-label={label} data-online={online} />;
}

function BenchLink() {
  return <Link className="control primary landing-button" to="/bench" onMouseEnter={() => void import("../bench/Workbench")} onFocus={() => void import("../bench/Workbench")}>Open the workbench <ArrowRightIcon size={16} aria-hidden="true" /></Link>;
}
const startExample = (id: string) => `/bench?example=${id}`;
const exampleLink = (id: string) => <Link className="text-action" to={startExample(id)}>Open example <ArrowUpRightIcon size={15} aria-hidden="true" /></Link>;

function Feature({ title, copy, id, children, className }: { title: string; copy: string; id: string; children: React.ReactNode; className: string }) {
  return <article className={`feature ${className}`}><div className="feature-copy"><h3>{title}</h3><p>{copy}</p>{exampleLink(id)}</div>{children}</article>;
}

export default function Landing() {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (reduced) return;
    let frame: number;
    let started: number | undefined;
    const tick = (at: number) => {
      started ??= at;
      const fraction = Math.max(0, Math.min(1, (at - started - 400) / 2800));
      setCount(Math.min(sampleRun.rows.length, Math.floor(fraction * sampleRun.rows.length / fixture.lanes.length) * fixture.lanes.length));
      if (fraction < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);
  const machines = useQuery({ queryKey: ["machines"], queryFn: ({ signal }) => getMachines(signal), retry: false });
  const machine = machines.data?.[0];
  const readouts = machine ? [
    ["Server", machine.id], ["Architecture", machine.arch], ["Operating system", machine.os ?? "Unavailable"],
    ["CPU threads", num.format(machine.threads)], ["Executors", machine.languages?.map((language) => languages[language]).join(", ") || "None"],
  ] : [];

  return <div className="landing">
    <section className="page landing-hero">
      <motion.div className="hero-lead" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : 0.7, ease: [0.16, 1, 0.3, 1] }}>
        <h1>See where your code<br className="hero-break" /> spends its cycles.<svg className="hero-trace" aria-hidden="true" viewBox="0 0 84 24"><path d="M1 20H21V14H43V17H62V5H83" /><circle cx="21" cy="14" r="2.2"/><circle cx="43" cy="17" r="2.2"/><circle cx="62" cy="5" r="2.2"/><circle cx="83" cy="5" r="2.2"/></svg></h1>
        <p>Write a benchmark in pseudocode, run it in Go or Python, and compare the results side by side.</p>
        <div className="hero-actions"><BenchLink /><Link className="control landing-button" to="/docs/examples">Browse examples</Link></div>
      </motion.div>
      <div className="hero-instrument">
        <Suspense fallback={<div className="instrument loading-plot" role="status">Loading sweep…</div>}>
          <Instrument title="Array sum sweep" scaleRows={sampleRun.rows} rows={reduced ? sampleRun.rows : sampleRun.rows.slice(0, count)} lanes={fixture.lanes}
            sweep={sampleRun.sweep} caption="Sample data · Synthetic Go and Python fixture" beam={!reduced && count < sampleRun.rows.length} />
        </Suspense>
      </div>
    </section>
    <Suspense fallback={<div className="page loading-state" role="status">Loading how it works…</div>}><LandingSequence /></Suspense>
    <section className="page landing-section measure-section">
      <div className="landing-section-head"><h2>What you can measure</h2><p>Pick a workload and see what changes when the input grows.</p></div>
      <div className="bento">
        <Feature title="Cache cliffs" copy="Sweep array size through the cache hierarchy." id={sampleRun.id} className="feature-cache">
          <Suspense fallback={<div className="instrument loading-plot" role="status">Loading sample chart…</div>}><Instrument compact rows={sampleRun.rows} lanes={fixture.lanes} sweep={sampleRun.sweep} caption="Synthetic array sum, time per element." /></Suspense>
        </Feature>
        <Feature title="Branch prediction" copy="Compare the same branch over sorted and random data." id="branch-prediction" className="feature-branch">
          <div className="branch-diagram" role="img" aria-label="Schematic showing sorted and mixed branch outcomes">
            <div><span>Sorted</span><code>○ ○ ○ ● ● ●</code></div><div><span>Random</span><code>● ○ ● ● ○ ○</code></div>
          </div>
        </Feature>
        <Feature title="Data layout" copy="Change how neighboring values share a cache line." id="data-layout" className="feature-layout">
          <div className="memory-diagram" role="img" aria-label="A schematic comparing interleaved XY pairs with grouped X and Y fields.">
            <div><span>Array of structs</span><div>{["x", "y", "x", "y", "x", "y"].map((v, i) => <i key={i} data-field={v}>{v}</i>)}</div></div>
            <div><span>Struct of arrays</span><div>{["x", "x", "x", "y", "y", "y"].map((v, i) => <i key={i} data-field={v}>{v}</i>)}</div></div>
          </div>
        </Feature>
        <Feature title="Page faults" copy="Measure the first touch of a memory region." id="page-faults" className="feature-faults">
          <img src="/dram.jpg" width="960" height="636" alt="" loading="lazy" />
        </Feature>
      </div>
    </section>
    <section className="lane-feature">
      <img src="/board.jpg" width="1800" height="1350" alt="" loading="lazy" />
      <div className="page"><h2>Compare up to four versions at once.</h2><p>Same bench in two languages, two data layouts, or two sets of compiler flags. Each version gets its own lane and color.</p></div>
    </section>
    <section className="page landing-section machine-section">
      <h2>Every result knows where it ran.</h2>
      <p>Every result keeps a snapshot of the server that produced it: host, architecture, operating system and CPU threads.</p>
      {readouts.length > 0 && <dl className="landing-readouts">{readouts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      <span className="help-text">{machine ? "Connected execution server" : machines.isPending ? "Checking the execution server…" : "The execution server is offline."}</span>
    </section>
    <section className="landing-close"><div className="page"><h2>Pick an example and press run.</h2><BenchLink /></div></section>
    <footer className="landing-footer"><div className="page">
      <Link className="brand" to="/">Bench.it</Link><ServerStatus /><nav aria-label="Footer"><Link to="/docs/examples">Examples</Link><Link to="/docs/guide">Guide</Link></nav>
      <details><summary>Photo credits</summary><div><a href="https://commons.wikimedia.org/wiki/File:Circuit_board_Closeup_(24884297897).jpg">Circuit board, Jonathan Cutrer (CC BY 2.0)</a><a href="https://commons.wikimedia.org/wiki/File:RAM-chips.jpg">RAM chips, Hannes Grobe (CC BY-SA 4.0)</a><p>Displayed with a monochrome treatment.</p></div></details>
    </div></footer>
  </div>;
}
