import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import type { Example, FileName, Lane, Machine, Workspace } from "../api/types";
import { request } from "../api/client";
import { download } from "../model/download";
import { USE_MOCK_API } from "../api/config";
import { LaneBadge } from "../chart/config";
import { generateLane, isStale, runBench } from "../model/actions";
import { freshWorkspace, replaceWorkspace, useBench, validWorkspace } from "../model/state";
import { harness, laneColors, laneVar, languages } from "../model/format";
import { starterWorkspace } from "../model/examples";
import { Overlay } from "../shell/Overlay";
import { flushEditors } from "./editorSync";
import LaneOptions from "./LaneOptions";
import RunPanel from "./RunPanel";

const Editor = lazy(() => import("./Editor"));
const small = matchMedia("(width < 768px)");
const tabbed = matchMedia("(width < 1024px)");
function useMedia(query: MediaQueryList) {
  return useSyncExternalStore((callback) => { query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }, () => query.matches);
}
export function useReadOnlyWidth() { return useMedia(small); }
const laneLabels = ["A", "B", "C", "D"] as const;
const safeFiles = (lane: Lane): FileName[] => ["benchmark.perf", harness(lane.language), ...(lane.files["kernel.S"] !== undefined ? ["kernel.S" as const] : [])];
const sizeLimit = 1024 * 1024;

export function EditorSkeleton({ text = "Loading editor…" }: { text?: string }) {
  return <div className="editor-skeleton loading-state" role="status"><p>{text}</p><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>;
}

function newLane(workspace: Workspace, from?: Lane, first?: Machine): Lane | undefined {
  const label = laneLabels.find((entry) => workspace.lanes.every((lane) => lane.label !== entry));
  if (!label) return;
  const source = structuredClone(from ?? starterWorkspace().lanes[0]);
  const language = from?.language ?? (workspace.lanes.length === 1 ? "python" : "go");
  return {
    ...source, id: crypto.randomUUID(), label, color: laneColors[label], name: undefined, language,
    arch: from?.arch ?? first?.arch ?? source.arch,
    files: from ? source.files : { "benchmark.perf": workspace.linkDsl
      ? workspace.lanes.find((lane) => lane.mode === "scaffold")?.files["benchmark.perf"] ?? source.files["benchmark.perf"]
      : "#sweep\nN = [1Ki, 64Ki, 1Mi]\n\n#setup\n\n#bench\nsink(N)\n" },
    build: from ? source.build : { ...source.build, toolchainVersion: first?.toolchains[language] ?? (language === "go" ? "go1.23" : "cpython3.13") },
  };
}

type Confirm = { title: string; text: string; action: string; cancel?: string; run: () => void };
interface LaneProps {
  lane: Lane; file: FileName; linked: boolean; editable: boolean; machine?: Machine; machines?: Machine[];
  setFile: (file: FileName) => void; setConfirm: (confirm: Confirm) => void; add: (lane?: Lane) => void;
  canRemove: boolean; canAdd: boolean; jump?: { line: number; serial: number }; onFocus: () => void;
}

function LanePane({ lane, file, linked, editable, machine, machines, setFile, setConfirm, add, canRemove, canAdd, jump, onFocus }: LaneProps) {
  const editFile = useBench((s) => s.editFile);
  const change = useBench((s) => s.changeLane);
  const generating = useBench((s) => s.generating.includes(lane.id));
  const events = useBench((s) => s.active?.events);
  const snapshot = useBench((s) => s.active?.snapshot.lanes.find((item) => item.id === lane.id));
  const active = useBench((s) => s.active?.status);
  const progress = useBench((s) => s.active?.rows.filter((row) => row.laneId === lane.id).length ?? 0);
  const [options, setOptions] = useState(false);
  const [menu, setMenu] = useState(false);
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const oldCode = useRef<string | undefined>(undefined);
  const harnessName = harness(lane.language);
  const harnessText = lane.files[harnessName];
  const compiling = events?.findLast(({ event }) => event.type === "build_done" && event.laneId === lane.id)?.event;
  const issue = compiling?.type === "build_done" && !compiling.ok ? compiling.log : undefined;
  const issueLine = issue ? Number(/(?:line\s+|:)(\d+)/i.exec(issue)?.[1]) : 0;
  const buildError = file === harnessName && issue && issueLine && snapshot?.files[file] === lane.files[file] ? { line: issueLine, message: issue } : undefined;
  const total = events?.findLast(({ event }) => event.type === "perm_start" && event.laneId === lane.id)?.event;
  const loadingHarness = generating && file === harnessName;
  const readOnly = !editable || (file === "benchmark.perf" && lane.mode === "ejected") || (file === harnessName && lane.mode === "scaffold");

  useEffect(() => {
    if (harnessText !== oldCode.current && oldCode.current !== undefined && harnessText !== undefined) setDiff({ before: oldCode.current, after: harnessText });
    oldCode.current = harnessText;
  }, [harnessText]);

  function updateLanguage(language: Lane["language"]) {
    flushEditors();
    const update = () => change(lane.id, (entry) => {
      const files = { ...entry.files };
      if (entry.mode === "ejected") delete files[harness(entry.language)];
      delete files[harness(language)];
      return { ...entry, language, scaffold: undefined, files, build: {
        ...entry.build, flags: [], env: {}, toolchainVersion: machine?.toolchains[language] ?? "",
      } };
    });
    if (lane.mode === "ejected" && harnessText) setConfirm({ title: "Change language?", text: "This discards the hand-written harness for this lane.", action: "Change language", run: update });
    else update();
  }

  function updateArch(arch: Lane["arch"]) {
    const run = () => change(lane.id, (entry) => ({ ...entry, arch, scaffold: undefined }));
    if (lane.files["kernel.S"]) setConfirm({ title: "Change architecture?", text: "Assembly syntax is architecture-specific. Update kernel.S for the new architecture.", action: "Change architecture", run });
    else run();
  }

  function editMode() {
    setMenu(false);
    if (lane.mode === "scaffold") {
      setConfirm({ title: `Edit lane ${lane.label} as code?`, text: `You’ll edit the generated ${languages[lane.language]} directly. The DSL won’t regenerate it anymore. You can switch back later, which discards your edits.`,
        action: "Edit as code", cancel: "Keep scaffold", run: () => {
          change(lane.id, (entry) => ({ ...entry, mode: "ejected" }));
          setFile(harnessName);
          useBench.getState().notify({ text: `Lane ${lane.label} is now in code mode.` });
        } });
    } else {
      setConfirm({ title: `Switch lane ${lane.label} back to scaffold?`, text: "Your harness edits will be discarded.", action: "Switch back to scaffold", run: () => {
        const { workspace } = useBench.getState();
        const linkedText = workspace.linkDsl ? workspace.lanes.find((item) => item.id !== lane.id && item.mode === "scaffold")?.files["benchmark.perf"] : undefined;
        change(lane.id, (entry) => {
          const files = { ...entry.files };
          delete files[harnessName];
          if (linkedText !== undefined) files["benchmark.perf"] = linkedText;
          return { ...entry, mode: "scaffold", scaffold: undefined, files };
        });
        setFile("benchmark.perf");
        useBench.getState().notify({ text: `Lane ${lane.label} is back in scaffold mode. Your code edits were discarded.` });
      } });
    }
  }

  const status = generating ? "Generating…" : issue ? "Build failed" : isStale(lane) ? (lane.scaffold ? "DSL changed" : "Needs generation")
    : lane.mode === "ejected" ? "Edited" : lane.scaffold?.cached ? "Cached" : "Generated";
  return <article className="lane" aria-label={`Lane ${lane.label}`} onFocus={onFocus} style={{ "--channel": laneVar(lane.label) } as CSSProperties}>
    <div className="lane-toolbar">
      <LaneBadge lane={lane} />
      {editable ? <>
        <input aria-label={`Lane ${lane.label} name`} title={lane.name || `Lane ${lane.label}`} className="lane-name" placeholder={`Lane ${lane.label}`} value={lane.name ?? ""} onChange={(e) => change(lane.id, (item) => ({ ...item, name: e.target.value }))} />
        <select aria-label={`Lane ${lane.label} language`} value={lane.language} onChange={(e) => updateLanguage(e.target.value as Lane["language"])}>
          {Object.entries(languages).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <select aria-label={`Lane ${lane.label} architecture`} value={lane.arch} onChange={(e) => updateArch(e.target.value as Lane["arch"])}>
          {(["x86_64", "arm64"] as const).map((arch) => <option key={arch} disabled={arch !== lane.arch && !machines?.some((item) => item.arch === arch && item.status !== "offline")}>{arch}</option>)}
        </select>
      </> : <><span className="lane-name view-only">{lane.name || `Lane ${lane.label}`}</span><span>{languages[lane.language]}</span><code>{lane.arch}</code></>}
      <span className="chip mode-chip" title={lane.mode === "scaffold" ? "Edit the DSL and generate a harness." : "Edit the harness directly."}>{lane.mode === "scaffold" ? "Scaffold" : "Code"}</span>
      {editable && <div className="lane-menu-wrap">
        <button className="control icon-control" type="button" aria-label={`Lane ${lane.label} actions`} title={`Lane ${lane.label} actions`} aria-expanded={menu} ref={menuButton} onClick={() => setMenu(!menu)}><DotsThreeIcon size={20} weight="bold" aria-hidden="true" /></button>
        {menu && <div className="lane-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== menuButton.current) setMenu(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") { setMenu(false); menuButton.current?.focus(); } }}>
          {lane.mode === "scaffold" && <button type="button" disabled={generating} onClick={() => { setMenu(false); flushEditors(); setFile(harnessName); void generateLane(useBench.getState().workspace.lanes.find((item) => item.id === lane.id)!); }}>Generate code</button>}
          <button type="button" onClick={editMode}>{lane.mode === "scaffold" ? "Edit as code" : "Switch back to scaffold"}</button>
          <button type="button" onClick={() => { setMenu(false); setOptions(true); }}>Options</button>
          <button type="button" disabled={!canAdd} onClick={() => { setMenu(false); add(lane); }}>Duplicate lane</button>
          <button type="button" onClick={() => { setMenu(false); setConfirm({ title: `Reset lane ${lane.label}?`, text: "This replaces this lane’s settings and files.", action: "Reset lane", run: () => {
            const starter = starterWorkspace().lanes[0];
            const dsl = linked ? lane.files["benchmark.perf"] : starter.files["benchmark.perf"];
            change(lane.id, (entry) => ({ ...starter, id: entry.id, label: entry.label, color: entry.color, files: { "benchmark.perf": dsl } }));
            setFile("benchmark.perf");
          } }); }}>Reset lane</button>
          <button type="button" disabled={!canRemove} onClick={() => { setMenu(false); setConfirm({ title: `Remove lane ${lane.label}?`, text: "This removes its files and options from the bench.", action: "Remove lane", run: () => useBench.getState().edit((workspace) => ({ ...workspace, lanes: workspace.lanes.filter((item) => item.id !== lane.id) })) }); }}>Remove lane</button>
        </div>}
      </div>}
    </div>
    {active && ["queued", "building", "running"].includes(active) && snapshot && <div className="lane-progress"><i style={{ transform: `scaleX(${total?.type === "perm_start" ? progress / total.total : 0})` }} /></div>}
    <div className="file-strip">
      <div className="tab-strip" role="tablist" aria-label={`Lane ${lane.label} files`}>{safeFiles(lane).map((name) =>
        <button type="button" role="tab" aria-selected={file === name} key={name} title={name} onClick={() => { flushEditors(); setFile(name); }}>
          {name}{snapshot && snapshot.files[name] !== lane.files[name] && <span className="file-dirty" aria-label="Modified since run">•</span>}
          {issue && name === harnessName && <span className="error-text" aria-label="Build failed">●</span>}
        </button>)}
        {editable && lane.files["kernel.S"] === undefined && <button type="button" title="Add kernel.S" onClick={() => { editFile(lane.id, "kernel.S", ""); setFile("kernel.S"); }}>+ asm</button>}
      </div>
      <span className={`file-state${issue ? " error-text" : ""}`} title={status}>{status}</span>
    </div>
    {file === "benchmark.perf" && linked && <div className="editor-note"><LinkSimpleIcon size={14} aria-hidden="true" /> Linked benchmark.perf</div>}
    {file === "benchmark.perf" && lane.mode === "ejected" && <div className="editor-note">DSL reference. Edit sweep parameters in the Sweep tab.</div>}
    {file === harnessName && lane.mode === "scaffold" && !loadingHarness && <div className="editor-note">
      {harnessText ? "Generated from benchmark.perf. Read-only until you edit as code." : "Generate code to view the harness."}
      {editable && <button type="button" className="text-action" onClick={() => { flushEditors(); void generateLane(useBench.getState().workspace.lanes.find((item) => item.id === lane.id)!); }}>Generate code</button>}
    </div>}
    {lane.scaffold?.warnings.length ? <details className="code-warning"><summary>{lane.scaffold.warnings.length === 1 ? "1 note from code generation" : `${lane.scaffold.warnings.length} notes from code generation`}</summary>
      <ul>{lane.scaffold.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    <div className="editor-slot" role="tabpanel">
      {loadingHarness ? <EditorSkeleton text={`Generating ${languages[lane.language]} from benchmark.perf…`} />
        : <Suspense fallback={<EditorSkeleton />}><Editor key={file} file={file} value={lane.files[file] ?? ""} label={`Lane ${lane.label} ${file}`} readOnly={readOnly}
          onChange={readOnly ? undefined : (text) => editFile(lane.id, file, text)} jump={jump} buildError={buildError} /></Suspense>}
    </div>
    {editable && <div className="lane-footer">
      <button className="text-action" type="button" onClick={() => setOptions(true)}><WrenchIcon size={14} aria-hidden="true" /> Options</button>
      <button className="text-action" type="button" onClick={editMode}><CodeIcon size={14} aria-hidden="true" /> {lane.mode === "scaffold" ? "Edit as code" : "Switch back to scaffold"}</button>
      {diff && file === harnessName && <button className="text-action" type="button" onClick={() => setDiffOpen(true)}>Compare generated code</button>}
    </div>}
    {options && <LaneOptions lane={lane} machine={machine} close={() => setOptions(false)} />}
    {diffOpen && diff && <Overlay title="Generated code changes" onClose={() => setDiffOpen(false)}><div className="overlay-body code-diff">
      <div><h3>Previous</h3><pre>{diff.before}</pre></div><div><h3>Current</h3><pre>{diff.after}</pre></div>
    </div></Overlay>}
  </article>;
}

export function WorkspaceView({ workspace, machines, shared = false, onFork }: { workspace: Workspace; machines?: Machine[]; shared?: boolean; onFork?: () => void }) {
  const mobile = useReadOnlyWidth();
  const tabs = useMedia(tabbed);
  const [params, setParams] = useSearchParams();
  const selectedLane = workspace.lanes.find((lane) => lane.label === params.get("lane")) ?? workspace.lanes[0];
  const editable = !shared && !mobile;
  const machine = machines?.find((item) => item.arch === selectedLane.arch) ?? machines?.[0];
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [help, setHelp] = useState(() => { try { return sessionStorage.getItem("benchscope-start-hidden") !== "yes"; } catch { return true; } });
  const [jump, setJump] = useState<{ id: string; line: number; serial: number }>();
  const layout = useBench((s) => s.layout);
  const setLayout = useBench((s) => s.setLayout);
  const [widthPreview, setWidthPreview] = useState<Record<string, number> | null>(null);
  const [heightPreview, setHeightPreview] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const grid = !tabs && workspace.lanes.length >= 3 && layout.grid;
  const shown = tabs ? [selectedLane] : workspace.lanes;
  const query = useQueryClient();

  function select(lane: Lane, file?: FileName) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("lane", lane.label);
      if (file) next.set(`file${lane.label}`, file);
      return next;
    }, { replace: true });
  }
  function fileFor(lane: Lane) {
    const files = safeFiles(lane);
    return files.find((file) => file === params.get(`file${lane.label}`)) ?? files[0];
  }
  function add(from?: Lane) {
    flushEditors();
    const current = useBench.getState().workspace;
    const lane = newLane(current, from, machine);
    if (!lane) return;
    useBench.getState().edit((entry) => ({ ...entry, lanes: [...entry.lanes, lane] }));
    select(lane, "benchmark.perf");
    setAddOpen(false);
  }
  function toggleLink() {
    flushEditors();
    const current = useBench.getState().workspace;
    const dsl = (selectedLane.mode === "scaffold" ? current.lanes.find((lane) => lane.id === selectedLane.id) : current.lanes.find((lane) => lane.mode === "scaffold"))?.files["benchmark.perf"];
    const link = () => useBench.getState().edit((entry) => ({
      ...entry, linkDsl: !entry.linkDsl, lanes: !entry.linkDsl && dsl !== undefined ? entry.lanes.map((lane) =>
        lane.mode === "scaffold" ? { ...lane, files: { ...lane.files, "benchmark.perf": dsl } } : lane) : entry.lanes,
    }));
    if (!current.linkDsl && current.lanes.some((lane) => lane.mode === "scaffold" && lane.files["benchmark.perf"] !== dsl)) setConfirm({
      title: "Link scaffold DSL?", text: "Scaffold lanes will use the same benchmark.perf. Code mode lanes keep their own files.", action: "Link DSL", run: link,
    });
    else link();
  }
  async function exportWorkspace(zip: boolean) {
    flushEditors();
    const snapshot = useBench.getState().workspace;
    const basename = snapshot.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "benchscope";
    if (!zip) {
      download(`${basename}.json`, new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
      return;
    }
    try {
      const { strToU8, zipSync } = await import("fflate");
      const files = Object.fromEntries(snapshot.lanes.flatMap((lane) => safeFiles(lane).flatMap((name) => {
        const contents = lane.files[name];
        return contents === undefined ? [] : [[`lane-${lane.label}/${name}`, strToU8(contents)] as const];
      })));
      const archive = zipSync(files);
      download(`${basename}.zip`, new Blob([new Uint8Array(archive)], { type: "application/zip" }));
    } catch { useBench.getState().notify({ text: "Couldn’t export the files. Try again.", error: true }); }
  }
  function jumpTo(lane: Lane, line: number) {
    if (!workspace.lanes.some((entry) => entry.id === lane.id)) return;
    select(lane, harness(lane.language));
    setJump({ id: lane.id, line, serial: Date.now() });
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || document.querySelector("dialog[open]")) return;
      const character = e.key.toLowerCase();
      if (character === "j" && !shared) { e.preventDefault(); setLayout({ collapsed: !useBench.getState().layout.collapsed }); }
      if (e.shiftKey && character === "g" && editable && selectedLane.mode === "scaffold") {
        e.preventDefault(); flushEditors(); select(selectedLane, harness(selectedLane.language));
        const lane = useBench.getState().workspace.lanes.find((item) => item.id === selectedLane.id);
        if (lane) void generateLane(lane);
      }
      const lane = workspace.lanes[Number(character) - 1];
      if (lane && /^[1-4]$/.test(character)) {
        e.preventDefault(); select(lane);
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[aria-label="Lane ${lane.label}"] [role="tab"][aria-selected="true"]`)?.focus());
      }
      if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault(); flushEditors();
        const files = safeFiles(selectedLane);
        select(selectedLane, files[(files.indexOf(fileFor(selectedLane)) + (e.key === "ArrowLeft" ? -1 : 1) + files.length) % files.length]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return <div className="page bench-page" ref={root}
    onDragOver={editable ? (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); } : undefined}
    onDrop={editable ? async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault(); flushEditors();
      const file = e.dataTransfer.files[0];
      try {
        if (file.size > sizeLimit) throw new Error();
        const value: unknown = JSON.parse(await file.text());
        if (!validWorkspace(value)) throw new Error();
        replaceWorkspace(freshWorkspace(value));
      } catch { useBench.getState().notify({ text: "Drop a Benchscope workspace JSON file under 1 MiB.", error: true }); }
    } : undefined}>
    <div className="bench-heading">
      <div><h1>{shared ? workspace.title : "Workbench"}</h1><p>{USE_MOCK_API ? "Mock machine · Array-sum fixture replay" : "Write, configure, and run a benchmark."}</p></div>
      {!shared && <div className="bench-tools">
        {editable && <label className="control link-toggle"><input type="checkbox" checked={workspace.linkDsl} onChange={toggleLink} /><LinkSimpleIcon size={15} aria-hidden="true" /> Linked DSL</label>}
        {editable && <details className="action-menu"><summary className="control">Export bench</summary><div className="menu-panel">
          <button type="button" onClick={() => void exportWorkspace(false)}>Workspace JSON</button>
          <button type="button" onClick={() => void exportWorkspace(true)}>Raw files ZIP</button>
        </div></details>}
        {editable && workspace.lanes.length >= 3 && <button type="button" className="control" aria-pressed={layout.grid} onClick={() => setLayout({ grid: !layout.grid })}>Grid</button>}
        {editable && <button className="control" type="button" onClick={() => setAddOpen(true)} disabled={workspace.lanes.length >= 4} title={workspace.lanes.length >= 4 ? "You can use up to four lanes" : "Add lane"}><PlusIcon size={16} aria-hidden="true" /> Add lane</button>}
      </div>}
    </div>
    {shared && <div className="bench-banner"><span>You’re viewing a shared bench. Fork it to edit and run.</span><button className="control primary" type="button" onClick={onFork}>Fork</button></div>}
    {!shared && mobile && <div className="bench-banner"><span>Open on a larger screen to edit and run</span></div>}
    {!shared && editable && help && <div className="bench-banner">
      <span>New here? Start from an <Link to="/examples">example</Link> or {workspace.lanes.every((lane) => machines?.some((item) => item.arch === lane.arch && item.status !== "offline")) ? <button type="button" className="text-action" onClick={() => { flushEditors(); void runBench(query); }}>run this one</button> : "run this one once the machine is ready"}.</span>
      <button className="control icon-control" type="button" title="Dismiss tip" aria-label="Dismiss tip" onClick={() => { try { sessionStorage.setItem("benchscope-start-hidden", "yes"); } catch { /* storage can be disabled */ } setHelp(false); }}><XIcon size={16} aria-hidden="true" /></button>
    </div>}
    {tabs && shown.length > 0 && workspace.lanes.length > 1 && <div className="tab-strip lane-switcher" aria-label="Choose lane">
      {workspace.lanes.map((lane) => <button type="button" key={lane.id} aria-pressed={selectedLane.id === lane.id} onClick={() => { flushEditors(); select(lane); }}><LaneBadge lane={lane} /> {lane.name || languages[lane.language]}</button>)}
    </div>}
    <div className={`lanes${grid ? " lanes-grid" : ""}${shown.length >= 3 ? " lanes-many" : ""}`}>
      {shown.map((lane, index) => <div className="lane-wrap" key={lane.id} style={{ "--lane-width": widthPreview?.[lane.label] ?? layout.widths[lane.label] ?? 1 } as CSSProperties}>
        <LanePane lane={lane} file={fileFor(lane)} linked={workspace.linkDsl && workspace.lanes.filter((item) => item.mode === "scaffold").length > 1 && lane.mode === "scaffold"} editable={editable}
          machine={machines?.find((item) => item.arch === lane.arch) ?? machine} machines={machines} setFile={(file) => select(lane, file)} setConfirm={setConfirm} add={add}
          canAdd={workspace.lanes.length < 4} canRemove={workspace.lanes.length > 1} jump={jump?.id === lane.id ? jump : undefined}
          onFocus={() => { if (selectedLane.id !== lane.id) select(lane); }} />
        {!grid && !tabs && index < shown.length - 1 && editable && <div className="lane-resizer" role="separator" tabIndex={0} aria-label={`Resize lanes ${lane.label} and ${shown[index + 1].label}`} aria-valuenow={Math.round((layout.widths[lane.label] ?? 1) * 50)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const other = shown[index + 1].label;
            const a = layout.widths[lane.label] ?? 1;
            const b = layout.widths[other] ?? 1;
            const next = Math.max(0.35, Math.min(a + b - 0.35, a + (e.key === "ArrowRight" ? 0.08 : -0.08)));
            setLayout({ widths: { ...layout.widths, [lane.label]: next, [other]: a + b - next } });
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.dataset.origin = String(e.clientX);
            e.currentTarget.dataset.span = String((e.currentTarget.parentElement?.offsetWidth ?? 1) + ((e.currentTarget.parentElement?.nextElementSibling as HTMLElement | null)?.offsetWidth ?? 0));
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const other = shown[index + 1].label;
            const a = layout.widths[lane.label] ?? 1;
            const b = layout.widths[other] ?? 1;
            const span = Number(e.currentTarget.dataset.span) || 1;
            const next = Math.max(0.35, Math.min(a + b - 0.35, a + (e.clientX - Number(e.currentTarget.dataset.origin)) * (a + b) / span));
            setWidthPreview({ ...layout.widths, [lane.label]: next, [other]: a + b - next });
          }}
          onPointerUp={() => { if (widthPreview) setLayout({ widths: widthPreview }); setWidthPreview(null); }}
          onPointerCancel={() => setWidthPreview(null)} />}
      </div>)}
    </div>
    {!shared && <div onPointerUp={() => { if (heightPreview !== null) { setLayout({ height: heightPreview }); setHeightPreview(null); } }} style={{ "--resized-panel": heightPreview === null ? undefined : `${heightPreview}px` } as CSSProperties}>
      <RunPanel workspace={workspace} machine={machine} onJump={jumpTo} editable={editable} onResize={(height) => {
        const next = Math.max(240, Math.min(720, height));
        if (document.activeElement?.classList.contains("panel-resizer") && !root.current?.querySelector(".panel-resizer:active")) setLayout({ height: next });
        else setHeightPreview(next);
      }} />
    </div>}
    {addOpen && <Overlay title="Add lane" onClose={() => setAddOpen(false)}><div className="overlay-body add-choices">
      <button type="button" className="control primary" onClick={() => add()}><PlusIcon size={16} aria-hidden="true" /> New lane</button>
      {workspace.lanes.map((lane) => <button type="button" className="control" key={lane.id} onClick={() => add(lane)}>Duplicate lane {lane.label}</button>)}
      <Link className="control" to="/examples">From examples <ArrowUpRightIcon size={14} aria-hidden="true" /></Link>
    </div></Overlay>}
    {confirm && <Overlay title={confirm.title} onClose={() => setConfirm(null)}><div className="overlay-body">
      <p>{confirm.text}</p><div className="dialog-actions"><button type="button" className="control" onClick={() => setConfirm(null)}>{confirm.cancel ?? "Cancel"}</button>
        <button type="button" className="control primary" onClick={() => { flushEditors(); confirm.run(); setConfirm(null); }}>{confirm.action}</button></div>
    </div></Overlay>}
  </div>;
}

export default function Workbench({ machines }: { machines?: Machine[] }) {
  const workspace = useBench((s) => s.workspace);
  const [params, setParams] = useSearchParams();
  const exampleId = params.get("example");
  const location = useLocation();
  const navigate = useNavigate();
  const query = useQueryClient();
  const examples = useQuery({ queryKey: ["examples"], queryFn: ({ signal }) => request<Example[]>("/examples", { signal }), enabled: Boolean(exampleId) });
  const handled = useRef("");
  useEffect(() => {
    if (!exampleId || !examples.data || handled.current === location.key) return;
    handled.current = location.key;
    const example = examples.data.find((entry) => entry.id === exampleId);
    if (example) replaceWorkspace(freshWorkspace(example.workspace));
    else useBench.getState().notify({ text: "Example unavailable. Pick another example.", error: true });
    setParams({}, { replace: true });
  }, [exampleId, examples.data, location.key, setParams]);

  useEffect(() => {
    const incoming = location.state as { workspace?: Workspace; fresh?: boolean; rerun?: boolean; fork?: boolean } | null;
    if (!incoming?.workspace || handled.current === location.key) return;
    handled.current = location.key;
    const next = incoming.fresh ? freshWorkspace(incoming.workspace) : incoming.workspace;
    if (replaceWorkspace(next, Boolean(incoming.fresh))) {
      if (incoming.fork) useBench.getState().notify({ text: "Forked to your workbench." });
      if (incoming.rerun && !small.matches) {
        const machines = query.getQueryData<Machine[]>(["machines"]);
        if (next.lanes.every((lane) => machines?.some((machine) => machine.arch === lane.arch && machine.status !== "offline"))) void runBench(query);
        else useBench.getState().notify({ text: "The selected machine is unavailable. Try again when it’s online.", error: true });
      }
    }
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location, navigate, query]);

  return <>{exampleId && examples.isError && <div className="page bench-error"><p className="error-text">The example could not be loaded.</p><button className="control" type="button" onClick={() => void examples.refetch()}>Try again</button></div>}<WorkspaceView workspace={workspace} machines={machines} /></>;
}
