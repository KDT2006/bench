import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { getMachines } from "../api/client";
import { MachineDetails, MachineState } from "./MachineDetails";
import { Overlay } from "./Overlay";
import { Settings } from "./Settings";
import { usePreferences } from "./preferences";

function Brand() {
  return <Link to="/" className="brand" aria-label="Benchscope home"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M5 16h5v-4h4V8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg><span>Benchscope</span></Link>;
}

const nav = [
  { path: "/bench", label: "Workbench" },
  { path: "/examples", label: "Examples" },
  { path: "/guide", label: "Guide" },
  { path: "/benches", label: "Library" },
];

type Dialog = "settings" | "machine" | "commands" | "shortcuts" | "menu";

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
  return nav.map(({ path, label }) => (
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

export function App() {
  useTheme();
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();
  const workbench = pathname === "/bench";
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [benchTitle, setBenchTitle] = useState("Untitled bench");
  useEffect(() => { if (!hash) window.scrollTo(0, 0); }, [pathname, hash]);
  const mac = /Mac|iPad|iPhone/.test(navigator.platform);
  const shortcut = mac ? "⌘K" : "Ctrl+K";
  const machines = useQuery({
    queryKey: ["machines"],
    queryFn: ({ signal }) => getMachines(signal),
    refetchInterval: 10_000,
    retry: false,
  });
  const machine = machines.data?.[0];
  const machineLabel = machine ? `${machine.arch} · ${machine.cpuModel} · ${machine.status}`
    : machines.isPending ? "Checking machine…" : machines.isError ? "Machine unavailable" : "No machine available";
  const shortMachineLabel = machine ? `${machine.cpuModel} · ${machine.status}` : machineLabel;
  const close = () => setDialog(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
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
  }, [dialog]);

  const actions: Command[] = [
    ...nav.map(({ path, label }) => ({ label: `Open ${label.toLowerCase()}`, run: () => { close(); navigate(path); } })),
    { label: "Show machine details", run: () => setDialog("machine") },
    { label: "Open settings", run: () => setDialog("settings") },
    { label: "Show keyboard shortcuts", shortcut: "?", run: () => setDialog("shortcuts") },
  ];
  const dialogTitles = { settings: "Settings", machine: "Machine", commands: "Command palette", shortcuts: "Keyboard shortcuts", menu: "Navigation" };

  return (
    <>
      <a className="skip-link control primary" href="#main">Skip to content</a>
      <header className="top-bar">
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
              <button className="control primary" type="button" disabled title="Run will be available with the editor."><PlayIcon size={14} weight="fill" aria-hidden="true" /> Run</button>
              <button className="control" type="button" disabled title="Save will be available with the library.">Save</button>
              <button className="control" type="button" disabled title="Sharing will be available in a later update.">Share</button>
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
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<RouteStub title="Benchscope">A workbench for microbenchmarks.</RouteStub>} />
          <Route path="/bench" element={
            <div className="page workspace">
              <div className="page-heading">
                <h1>Workbench</h1>
                <p>Write, configure, and run a benchmark.</p>
              </div>
              <section className="workspace-panel" aria-labelledby="workspace-heading">
                <div className="workspace-header"><h2 id="workspace-heading">Workspace</h2></div>
                <div className="workspace-empty">
                  <h3>The editor is coming next</h3>
                  <p>Inspect the sample machine while the workspace is empty.</p>
                  <button type="button" className="control" onClick={() => setDialog("machine")}>Show machine details</button>
                </div>
              </section>
            </div>
          } />
          <Route path="/results/:runId" element={<RouteStub title="Results">Run results will be available here.</RouteStub>} />
          <Route path="/examples" element={<RouteStub title="Examples">Example benchmarks will be available here.</RouteStub>} />
          <Route path="/guide" element={<RouteStub title="Guide">The benchmark language reference will be available here.</RouteStub>} />
          <Route path="/benches" element={<RouteStub title="Library">Saved benches and run history will be available here.</RouteStub>} />
          <Route path="/s/:shareId" element={<RouteStub title="Shared bench">Shared benches will be available here.</RouteStub>} />
          <Route path="*" element={<RouteStub title="Page not found">Check the address or open the workbench.</RouteStub>} />
        </Routes>
      </main>
      {dialog && (
        <Overlay key={dialog} title={dialogTitles[dialog]} onClose={close} drawer={dialog === "machine"} palette={dialog === "commands"}>
          {dialog === "settings" && <Settings />}
          {dialog === "machine" && (machine ? <MachineDetails machine={machine} /> : (
            <div className="overlay-body"><MachineState loading={machines.isFetching} error={machines.isError} retry={() => void machines.refetch()} /></div>
          ))}
          {dialog === "commands" && <CommandPalette actions={actions} shortcut={shortcut} />}
          {dialog === "shortcuts" && <dl className="overlay-body shortcuts">
            <div><dt>Command palette</dt><dd><kbd>{shortcut}</kbd></dd></div>
            <div><dt>Keyboard shortcuts</dt><dd><kbd>?</kbd></dd></div>
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
