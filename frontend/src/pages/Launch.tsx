import { useEffect, useRef, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useReducedMotion } from "motion/react";

const preloadWorkbench = () => {
  void import("../bench/Workbench").catch(() => undefined);
};

export default function Launch() {
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const activated = useRef(false);
  useEffect(preloadWorkbench, []);

  const openWorkbench = (event: MouseEvent<HTMLButtonElement>) => {
    if (activated.current) return;
    activated.current = true;
    preloadWorkbench();
    const { left, top, width } = event.currentTarget.getBoundingClientRect();
    navigate("/bench", { state: reduced ? null : { launchOrigin: { left, top, size: width } } });
  };

  return <section className="launch" aria-labelledby="launch-title">
    <h1 id="launch-title">Bench.it</h1>
    <div className="launch-control">
      <span className="launch-halo" aria-hidden="true" />
      <button className="launch-go" type="button" aria-describedby="launch-description"
        onClick={openWorkbench} onMouseEnter={preloadWorkbench} onFocus={preloadWorkbench}>
        Go
      </button>
    </div>
    <p id="launch-description" className="sr-only">Open the benchmark workbench.</p>
  </section>;
}
