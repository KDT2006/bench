import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { USE_MOCK_API } from "../api/config";
import { getMachines } from "../api/client";
import { MachineDetails, MachineState } from "./MachineDetails";
import { Overlay } from "./Overlay";
import { Settings } from "./Settings";
import { usePreferences } from "./preferences";
import { runBench, saveBench, stopBench, useDraftPersistence } from "../model/actions";
import { useBench } from "../model/state";
import { flushEditors } from "../bench/editorSync";
import { ShareDialog } from "../pages/ShareDialog";
import { motion, useReducedMotion } from "motion/react";

const Workbench = lazy(() => import("../bench/Workbench"));
const Launch = lazy(() => import("../pages/Launch"));
const Landing = lazy(() => import("../pages/Landing"));
const Results = lazy(() => import("../pages/Results"));
const Examples = lazy(() => import("../pages/Examples"));
const Guide = lazy(() => import("../pages/Guide"));
const Library = lazy(() => import("../pages/Library"));
const Shared = lazy(() => import("../pages/Shared"));
const mobileQuery = matchMedia("(width < 768px)");

function Brand() {
  return <Link to="/" className="brand" aria-label="Benchscope home"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M5 16h5v-4h4V8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg><span>Benchscope</span></Link>;
}

function Toast() {
  const notice = useBench((state) => state.notice);
  const notify = useBench((state) => state.notify);
  const reduced = useReducedMotion();
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (!notice || hold) return;
    const timer = setTimeout(() => notify(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, hold, notify]);
  if (!notice) return null;
  return <motion.div className={`toast${notice.error ? " toast-error" : ""}`} initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }}
    onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHold(false); }}>
    <p role="status" aria-live="polite">{notice.text}</p>{notice.href && <Link className="control" to={notice.href} onClick={() => { setHold(false); notify(null); }}>View results</Link>}
    <button className="control icon-control" type="button" aria-label="Dismiss notification" title="Dismiss notification" onClick={() => { setHold(false); notify(null); }}>×</button>
  </motion.div>;
}

const nav = [
  { path: "/welcome", label: "Welcome" },
  { path: "/bench", label: "Workbench" },
  { path: "/examples", label: "Examples" },
  { path: "/guide", label: "Guide" },
  { path: "/benches", label: "Library" },
];

type Dialog = "settings" | "machine" | "commands" | "shortcuts" | "menu" | "share";

function useTheme() {
  const theme = usePreferences((state) => state.theme);
  useEffect(() => {
    const root = document.documentElement;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (theme === "system") delete root.dataset.theme;
      else root.dataset.theme = theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--canvas").trim());
    };
    update();
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [theme]);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return nav.map(({ path, label }) => !USE_MOCK_API && path === "/benches" ? <span key={path} aria-disabled="true" title="Library and persistent history are unavailable with the execution proxy.">{label}</span> : (
    <NavLink key={path} to={path} end onClick={onNavigate}>{label}</NavLink>
  ));
}

function RouteStub({ title, children }: { title: string; children: string }) {
  return (
    <div className="page route-stub">
      <h1>{title}</h1>
      <p>{children}</p>
      <Link to="/bench" className="control primary">Open the workbench <ArrowRightIcon size={16} aria-hidden="true" /></Link>
    </div>
  );
}

interface Command {
  label: string;
  shortcut?: string;
  run: () => void;
}

function CommandPalette({ actions, shortcut }: { actions: Command[]; shortcut: string }) {
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const words = search.toLowerCase().trim().split(/\s+/);
  const matches = actions.filter(({ label }) => words.every((word) => {
    let index = 0;
    for (const letter of label.toLowerCase()) {
      if (letter === word[index]) index++;
    }
    return index === word.length;
  }));
  const submit = (event: FormEvent) => { event.preventDefault(); matches[0]?.run(); };
  return (
    <form className="overlay-body" onSubmit={submit}>
      <label className="sr-only" htmlFor="command-search">Search commands</label>
      <input ref={input} id="command-search" className="command-search" type="search" placeholder="Search commands…" value={search} onChange={(event) => setSearch(event.target.value)} />
      {matches.length ? (
        <ul className="commands">
          {matches.map((action) => (
            <li key={action.label}>
              <button type="button" onClick={action.run}>{action.label}{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>
            </li>
          ))}
        </ul>
      ) : <p className="command-empty" role="status">No commands found. Try a different search.</p>}
      <p className="help-text"><kbd>Enter</kbd> opens the first match. <kbd>{shortcut}</kbd> toggles the palette.</p>
    </form>
  );
}

function LaunchRipple({ origin }: { origin: { left: number; top: number; size: number } }) {
  const [finished, setFinished] = useState(false);
  const reduced = useReducedMotion();
  if (finished || reduced) return null;
  const x = origin.left + origin.size / 2;
  const y = origin.top + origin.size / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  // Overshoot the corners so the soft shadow reaches the entire viewport.
  const scale = Math.max(1, 4 * radius / origin.size);
  return <div className="launch-ripple" aria-hidden="true">
    <motion.span style={{ left: origin.left, top: origin.top, width: origin.size, height: origin.size }}
      initial={{ scale: 1, opacity: 0.65 }} animate={{ scale, opacity: [0.65, 0.5, 0.25, 0] }}
      transition={{ scale: { duration: 1.4, ease: [0.25, 0.46, 0.45, 0.94] }, opacity: { duration: 1.4, ease: "linear", times: [0, 0.35, 0.7, 1] } }}
      onAnimationComplete={() => setFinished(true)} />
  </div>;
}

export function App() {
  useTheme();
  useDraftPersistence();
  const navigate = useNavigate();
  const { pathname, hash, state, key } = useLocation();
  const reduced = useReducedMotion();
  const blendWorkbench = pathname === "/bench" && Boolean(state?.launchOrigin) && !reduced;
  const query = useQueryClient();
  const workbench = pathname === "/bench";
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const benchTitle = useBench((s) => s.workspace.title);
  const lastRunId = useBench((s) => s.lastRun?.id);
  const pending = useBench((s) => s.pending);
  const running = useBench((s) => Boolean(s.active && ["queued", "building", "running"].includes(s.active.status)));
  const cancelPending = useBench((s) => s.cancelPending);
  const arch = useBench((s) => s.workspace.lanes[0]?.arch);
  const setBenchTitle = (title: string) => useBench.getState().edit((workspace) => ({ ...workspace, title }));
  const mobile = useSyncExternalStore((notify) => {
    mobileQuery.addEventListener("change", notify);
    return () => mobileQuery.removeEventListener("change", notify);
  }, () => mobileQuery.matches);
  const landing = pathname === "/";
  const welcome = pathname === "/welcome";
  useEffect(() => { document.title = landing ? "Bench.it" : "Benchscope"; }, [landing]);
  useEffect(() => { if (!hash) window.scrollTo(0, 0); }, [pathname, hash]);
  const mac = /Mac|iPad|iPhone/.test(navigator.platform);
  const shortcut = mac ? "⌘K" : "Ctrl+K";
  const machines = useQuery({
    queryKey: ["machines"],
    queryFn: ({ signal }) => getMachines(signal),
    refetchInterval: 10_000,
    retry: false,
  });
  const machine = machines.data?.find((entry) => entry.arch === arch) ?? (!workbench ? machines.data?.[0] : undefined);
  const machineLabel = machine ? `${machine.arch} · ${machine.cpuModel} · ${machine.status}`
    : machines.isPending ? "Checking machine…" : machines.isError ? "Machine unavailable" : "No machine available";
  const machineArches = useBench((s) => s.workspace.lanes.map((lane) => lane.arch).join(","));
  const isOffline = !machine || machine.status === "offline" || machines.isError ||
    machineArches.split(",").some((arch) => !machines.data?.some((entry) => entry.arch === arch && entry.status !== "offline"));
  const runHint = mobile ? "Open on a larger screen to edit and run"
    : isOffline ? "The selected machine is unavailable. Try again or check the architecture."
      : running ? "Cancel run" : "Run (Ctrl/⌘ Enter). Regenerates stale scaffold lanes.";
  const runOrStop = () => {
    if (running) { void stopBench(query); return; }
    if (isOffline || mobile || pending) return;
    flushEditors();
    void runBench(query);
  };
  const renderRunControl = (showShortcut: boolean) => (
    <button className={running ? "control run-control" : "control primary run-control"} type="button"
      disabled={running ? cancelPending : mobile || isOffline || pending} title={runHint} onClick={runOrStop}>
      {running ? "Cancel run" : pending ? "Preparing…" : <>
        <PlayIcon size={14} weight="fill" aria-hidden="true" /> Run
        {showShortcut && <kbd className="run-shortcut" aria-hidden="true">{mac ? "⌘↵" : "Ctrl+↵"}</kbd>}
      </>}
    </button>
  );
  const save = () => { flushEditors(); void saveBench(query); };
  const shortMachineLabel = machine ? `${machine.cpuModel} · ${machine.status}` : machineLabel;
  const close = () => setDialog(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!dialog && !document.querySelector("dialog[open]") && workbench && !mobile && (event.metaKey || event.ctrlKey)) {
        if (event.key === "Enter") { event.preventDefault(); runOrStop(); return; }
        if (event.key.toLowerCase() === "s") { event.preventDefault(); save(); return; }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((current) => current === "commands" ? null : "commands");
      } else if (event.key === "?" && !dialog && !event.ctrlKey && !event.metaKey &&
        !(event.target instanceof HTMLElement && (event.target.closest("input, textarea, select") || event.target.isContentEditable))) {
        event.preventDefault();
        setDialog("shortcuts");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const actions: Command[] = [
    ...nav.filter(({ path }) => USE_MOCK_API || path !== "/benches").map(({ path, label }) => ({ label: `Open ${label.toLowerCase()}`, run: () => { close(); navigate(path); } })),
    { label: "Show machine details", run: () => setDialog("machine") },
    { label: "Open settings", run: () => setDialog("settings") },
    { label: "Show keyboard shortcuts", shortcut: "?", run: () => setDialog("shortcuts") },
  ];
  if (workbench && !mobile) {
    if (!pending && (!isOffline || running)) actions.push({ label: running ? "Cancel run" : "Run bench", shortcut: mac ? "⌘↵" : "Ctrl+Enter", run: () => { close(); runOrStop(); } });
    if (USE_MOCK_API) actions.push({ label: "Save bench", shortcut: mac ? "⌘S" : "Ctrl+S", run: () => { close(); save(); } });
    if (USE_MOCK_API) actions.push({ label: "Share bench", run: () => { flushEditors(); setDialog("share"); } });
    if (lastRunId) actions.push({ label: "Open last results", run: () => { close(); navigate(`/results/${lastRunId}`); } });
  }
  const dialogTitles = { settings: "Settings", machine: "Machine", commands: "Command palette", shortcuts: "Keyboard shortcuts", menu: "Navigation", share: "Share bench" };

  return (
    <>
      <a className="skip-link control primary" href="#main">Skip to content</a>
      {landing || welcome ? <header className={`landing-nav${landing ? " launch-nav" : ""}`}>
        <Brand />
        <nav aria-label="Main navigation"><NavLink to="/welcome">Welcome</NavLink>{!landing && <><Link to="/examples">Examples</Link><Link to="/guide">Guide</Link></>}</nav>
        <button type="button" className="control icon-control landing-settings" aria-label="Settings" title="Settings" onClick={() => setDialog("settings")}><GearIcon size={20} aria-hidden="true" /></button>
        {!landing && <Link className="control primary" to="/bench" onMouseEnter={() => void import("../bench/Workbench")} onFocus={() => void import("../bench/Workbench")}>Open the workbench</Link>}
      </header> : <header className={`top-bar${blendWorkbench ? " bench-enter" : ""}`}>
        <div className="top-bar-inner">
          <Brand />
          <nav className="desktop-nav" aria-label="Main navigation"><NavLinks /></nav>
          {workbench && (<>
            <input
              className="bench-title"
              aria-label="Bench title"
              title={benchTitle || "Untitled bench"}
              placeholder="Untitled bench"
              value={benchTitle}
              onChange={(event) => setBenchTitle(event.target.value)}
              onBlur={() => { if (!benchTitle.trim()) setBenchTitle("Untitled bench"); }}
            />
            <span className="mobile-bench-title" title={benchTitle}>{benchTitle}</span>
          </>)}
          <div className="top-actions">
            <button type="button" className="control machine-pill" onClick={() => setDialog("machine")} title={machineLabel} aria-label={`Machine details. ${machineLabel}`}>
              <CpuIcon size={16} aria-hidden="true" />
              <span className={machines.isError ? "machine-label error-text" : "machine-label"} aria-live="polite"><span className="machine-full">{machineLabel}</span>
                <span className="machine-compact">{shortMachineLabel}</span>
                <span className="machine-mobile">{machine?.status ?? "Machine"}</span>
              </span>
            </button>
            {workbench && <div className="workbench-actions" aria-label="Workbench actions">
              {renderRunControl(true)}
              <button className="control" type="button" disabled={mobile || !USE_MOCK_API} title={!USE_MOCK_API ? "Saving is unavailable with the execution proxy." : undefined} onClick={save}>Save</button>
              <button className="control" type="button" disabled={!USE_MOCK_API} title={!USE_MOCK_API ? "Sharing is unavailable with the execution proxy." : undefined} onClick={() => { flushEditors(); setDialog("share"); }}>Share</button>
            </div>}
            <button type="button" className="control icon-control command-trigger" onClick={() => setDialog("commands")} aria-label="Command palette" title={`Command palette (${shortcut})`}>
              <CommandIcon size={20} aria-hidden="true" />
            </button>
            <button type="button" className="control icon-control" onClick={() => setDialog("settings")} aria-label="Settings" title="Settings">
              <GearIcon size={20} aria-hidden="true" />
            </button>
            <button type="button" className="control icon-control mobile-menu" onClick={() => setDialog("menu")} aria-label="Navigation" title="Navigation">
              <ListIcon size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>}
      <main id="main" tabIndex={-1} className={blendWorkbench ? "bench-enter" : undefined}>
        <Suspense fallback={<div className="page route-loading loading-state" role="status"><span className="sr-only">Loading page…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}>
          <Routes>
            <Route path="/" element={<Launch />} />
            <Route path="/welcome" element={<Landing />} />
            <Route path="/bench" element={<Workbench machines={machines.data} runControl={renderRunControl(false)} />} />
            <Route path="/results/:runId" element={<Results />} />
            <Route path="/examples" element={<Examples />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/benches" element={USE_MOCK_API ? <Library /> : <RouteStub title="Library unavailable">The execution proxy does not store benches or persistent run history. Live results remain available in this tab.</RouteStub>} />
            <Route path="/s/:shareId" element={USE_MOCK_API ? <Shared /> : <RouteStub title="Sharing unavailable">The execution proxy does not provide shared benches.</RouteStub>} />
            <Route path="*" element={<RouteStub title="Page not found">Check the address or open the workbench.</RouteStub>} />
          </Routes>
        </Suspense>
      </main>
      {blendWorkbench && <LaunchRipple key={key} origin={state.launchOrigin} />}
      <Toast />
      {dialog === "share" && <ShareDialog workspace={useBench.getState().workspace} runId={lastRunId} close={close} />}
      {dialog && dialog !== "share" && (
        <Overlay key={dialog} title={dialogTitles[dialog]} onClose={close} drawer={dialog === "machine"} palette={dialog === "commands"}>
          {dialog === "settings" && <Settings />}
          {dialog === "machine" && (machine ? <MachineDetails machine={machine} /> : (
            <div className="overlay-body"><MachineState loading={machines.isFetching} error={machines.isError} retry={() => void machines.refetch()} /></div>
          ))}
          {dialog === "commands" && <CommandPalette actions={actions} shortcut={shortcut} />}
          {dialog === "shortcuts" && <dl className="overlay-body shortcuts">
            <div><dt>Command palette</dt><dd><kbd>{shortcut}</kbd></dd></div>
            <div><dt>Keyboard shortcuts</dt><dd><kbd>?</kbd></dd></div>
            <div><dt>Run or cancel</dt><dd><kbd>{mac ? "⌘↵" : "Ctrl+Enter"}</kbd></dd></div>
            <div><dt>Save</dt><dd><kbd>{mac ? "⌘S" : "Ctrl+S"}</kbd></dd></div>
            <div><dt>Generate code</dt><dd><kbd>{mac ? "⌘⇧G" : "Ctrl+Shift+G"}</kbd></dd></div>
            <div><dt>Focus lane</dt><dd><kbd>{mac ? "⌘ 1–4" : "Ctrl 1–4"}</kbd></dd></div>
            <div><dt>Switch file</dt><dd><kbd>{mac ? "⌘⌥←/→" : "Ctrl+Alt+←/→"}</kbd></dd></div>
            <div><dt>Toggle run panel</dt><dd><kbd>{mac ? "⌘J" : "Ctrl+J"}</kbd></dd></div>
            <div><dt>Close drawer or dialog</dt><dd><kbd>Esc</kbd></dd></div>
          </dl>}
          {dialog === "menu" && <div className="overlay-body">
            <nav className="mobile-nav" aria-label="Main navigation"><NavLinks onNavigate={close} /></nav>
            <button type="button" className="control" onClick={() => setDialog("commands")}><CommandIcon size={16} aria-hidden="true" /> Command palette</button>
            <button type="button" className="control" onClick={() => setDialog("shortcuts")}><QuestionIcon size={16} aria-hidden="true" /> Keyboard shortcuts</button>
          </div>}
        </Overlay>
      )}
    </>
  );
}
