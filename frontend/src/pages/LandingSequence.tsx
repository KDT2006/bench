import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { sampleRun } from "../model/examples";
import { EditorSkeleton } from "../bench/Workbench";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";

gsap.registerPlugin(ScrollTrigger);
const Editor = lazy(() => import("../bench/Editor"));
const Instrument = lazy(() => import("../chart/Instrument"));
const steps = [
  { title: "Write it", copy: "Describe the setup, the work to measure, and the input sizes to try in a small benchmark language." },
  { title: "Generate it", copy: "Turn the same benchmark into Go or Python. Inspect the generated harness before you run it." },
  { title: "Measure it", copy: "Watch results appear as the sweep grows. Each run keeps its settings and the machine it ran on." },
];
export default function LandingSequence() {
  const root = useRef<HTMLDivElement>(null);
  const pinned = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const lane = sampleRun.workspaceSnapshot.lanes[0];
  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const panels = Array.from(root.current!.querySelectorAll(".sequence-panel"));
      ScrollTrigger.create({ trigger: root.current, start: "top 112px", end: "bottom 420px", pin: pinned.current, pinSpacing: false, invalidateOnRefresh: true });
      panels.forEach((panel, index) => ScrollTrigger.create({
        trigger: panel, start: "top 60%", end: "bottom 60%", onEnter: () => setActive(index), onEnterBack: () => setActive(index),
      }));
    }, root);
    return () => media.revert();
  }, []);
  return <section className="landing-section sequence page" ref={root}>
    <div className="sequence-pin" ref={pinned}><h2>How it works</h2><p className="sequence-verb">{steps[active].title}</p><p>{steps[active].copy}</p>
      <div className="sequence-indicators" aria-hidden="true">{steps.map(({ title }, index) => <span key={title} className={index === active ? "is-current" : ""} />)}</div>
    </div>
    <div className="sequence-panels">
      <div className="sequence-panel"><header><h3>{steps[0].title}</h3><span className="mono">benchmark.perf</span></header><p>{steps[0].copy}</p>
        <div className="read-editor"><Suspense fallback={<EditorSkeleton />}><Editor file="benchmark.perf" label="Sample benchmark DSL" value={lane.files["benchmark.perf"]!} readOnly /></Suspense></div></div>
      <div className="sequence-panel"><header><h3>{steps[1].title}</h3><span className="mono">harness.go</span></header><p>{steps[1].copy}</p>
        <div className="read-editor"><Suspense fallback={<EditorSkeleton />}><Editor file="harness.go" label="Sample Go harness" value={lane.files["harness.go"]!} readOnly /></Suspense></div></div>
      <div className="sequence-panel"><header><h3>{steps[2].title}</h3><ArrowDownIcon size={16} aria-hidden="true" /></header><p>{steps[2].copy}</p>
        <Suspense fallback={<div className="instrument loading-plot" role="status">Loading results…</div>}><Instrument title="Sample sweep" rows={sampleRun.rows} lanes={sampleRun.workspaceSnapshot.lanes} sweep={sampleRun.sweep} /></Suspense></div>
    </div>
  </section>;
}
