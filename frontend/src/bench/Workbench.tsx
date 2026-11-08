import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import type { FileName, Lane, Machine, Workspace } from "../api/types";
import { getExamples } from "../api/client";
import { download } from "../model/download";
import { LaneBadge } from "../chart/config";
import { generateLane, isStale, runBench } from "../model/actions";
import { freshWorkspace, replaceWorkspace, useBench, validWorkspace } from "../model/state";
import { assemblyErrorLine, buildErrorLine, harness, laneColors, laneVar, languages } from "../model/format";
import { starterLane } from "../model/examples";
import { Overlay } from "../shell/Overlay";
import { flushEditors } from "./editorSync";
import LaneOptions from "./LaneOptions";
import CompilerOptions from "./CompilerOptions";
import RunPanel from "./RunPanel";
import { assemblyExample, assemblyFile, SOURCE_CHAR_LIMIT, sourceLength } from "../model/assembly";

const Editor = lazy(() => import("./Editor"));
const small = matchMedia("(width < 768px)");
const tabbed = matchMedia("(width < 1024px)");
function useMedia(query: MediaQueryList) {
  return useSyncExternalStore((callback) => { query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }, () => query.matches);
}
export function useReadOnlyWidth() { return useMedia(small); }
const laneLabels = ["A", "B", "C", "D"] as const;
const laneFiles = (lane: Lane): FileName[] => ["benchmark.perf", harness(lane.language), assemblyFile(lane)];

export function EditorSkeleton({ text = "Loading editor…" }: { text?: string }) {
  return <div className="editor-skeleton loading-state" role="status"><p>{text}</p><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>;
}

function newLane(workspace: Workspace, from?: Lane, machine?: Machine): Lane | undefined {
  const label = laneLabels.find((entry) => workspace.lanes.every((lane) => lane.label !== entry));
  if (!label) return;
  const source = from ? structuredClone(from) : starterLane(machine?.arch, machine?.languages?.[0]);
  return {
    ...source, id: crypto.randomUUID(), label, color: laneColors[label], name: undefined,
    files: from ? source.files : { "benchmark.perf": workspace.linkDsl
      ? workspace.lanes.find((lane) => lane.mode === "scaffold")?.files["benchmark.perf"] ?? source.files["benchmark.perf"]
      : "#imports\n\n#globals\n\n#sweep\nN: [1024,4096]\n\n#setup\n\n#bench\nsink(N)\n\n#cleanup\n" },
  };
}

/** Line-by-line diff (longest common subsequence). */
function lineDiff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines: { kind: " " | "+" | "-"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: " ", text: a[i] }); i++; j++; }
    else if (j < b.length && (i === a.length || common[i][j + 1] >= common[i + 1][j])) lines.push({ kind: "+", text: b[j++] });
    else lines.push({ kind: "-", text: a[i++] });
  }
  return lines;
}

function CodeDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const added = lines.filter((line) => line.kind === "+").length;
  const removed = lines.filter((line) => line.kind === "-").length;
  return <div className="overlay-body code-diff">
    <p className="help-text">{added} {added === 1 ? "line" : "lines"} added · {removed} removed</p>
    <pre>{lines.map((line, index) => <span key={index} className={line.kind === "+" ? "diff-add" : line.kind === "-" ? "diff-remove" : undefined}>
      <span className="diff-marker" aria-label={line.kind === "+" ? "Added" : line.kind === "-" ? "Removed" : undefined}>{line.kind}</span>{line.text || " "}</span>)}</pre>
  </div>;
}

type Confirm = { title: string; text: string; action: string; cancel?: string; run: () => void };
interface LaneProps {
  lane: Lane; file: FileName; linked: boolean; editable: boolean; machine?: Machine;
  setFile: (file: FileName) => void; setConfirm: (confirm: Confirm) => void; add: (lane?: Lane) => void;
  canRemove: boolean; canAdd: boolean; jump?: { line: number; serial: number }; onFocus: () => void;
}

function LanePane({ lane, file, linked, editable, machine, setFile, setConfirm, add, canRemove, canAdd, jump, onFocus }: LaneProps) {
  const editFile = useBench((s) => s.editFile);
  const change = useBench((s) => s.changeLane);
  const generating = useBench((s) => s.generating.includes(lane.id));
  const preparingRun = useBench((s) => s.pending);
  const events = useBench((s) => s.active?.events);
  const snapshot = useBench((s) => s.active?.snapshot.lanes.find((item) => item.id === lane.id));
  const active = useBench((s) => s.active?.status);
  const progress = useBench((s) => s.active?.rows.filter((row) => row.laneId === lane.id).length ?? 0);
  const [options, setOptions] = useState(false);
  const [menu, setMenu] = useState(false);
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);
  const oldCode = useRef<string | undefined>(undefined);
  const harnessName = harness(lane.language);
  const nativeFile = assemblyFile(lane);
  const harnessText = lane.files[harnessName];
  const compiling = events?.findLast(({ event }) => event.type === "build_done" && event.laneId === lane.id)?.event;
  const issue = compiling?.type === "build_done" && !compiling.ok ? compiling.log : undefined;
  const issueLine = issue ? buildErrorLine(issue) : undefined;
  const issueFile = issue && assemblyErrorLine(issue) !== undefined ? nativeFile : harnessName;
  const failed = events?.some(({ event }) => event.type === "error" && event.laneId === lane.id);
  const translationOnly = Boolean(machine && !machine.languages?.includes(lane.language));
  const buildError = file === issueFile && issue && issueLine && snapshot?.files[file] === lane.files[file] ? { line: issueLine, message: issue } : undefined;
  const total = events?.findLast(({ event }) => event.type === "perm_start" && event.laneId === lane.id)?.event;
  const loadingHarness = generating && file === harnessName;
  const readOnly = !editable || (file === "benchmark.perf" && lane.mode === "ejected") || (file === harnessName && lane.mode === "scaffold");

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuWrap.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);

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
        ...entry.build, flags: [], compilerOptions: "", env: {}, toolchainVersion: "",
      } };
    });
    if (lane.mode === "ejected" && harnessText) setConfirm({ title: "Change language?", text: "This discards the hand-written harness for this lane.", action: "Change language", run: update });
    else update();
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

  const status = generating ? "Generating…" : issue ? "Build failed" : failed ? "Failed" : isStale(lane) ? (lane.scaffold ? "DSL changed" : "Needs generation")
    : lane.mode === "ejected" ? "Edited" : "Generated";
  const translate = () => {
    flushEditors();
    setFile(harnessName);
    void generateLane(useBench.getState().workspace.lanes.find((item) => item.id === lane.id)!);
  };
  return <article className="lane" aria-label={`Lane ${lane.label}`} onFocus={onFocus} style={{ "--channel": laneVar(lane.label) } as CSSProperties}>
    <div className="lane-toolbar">
      <LaneBadge lane={lane} />
      {editable ? <>
        <input aria-label={`Lane ${lane.label} name`} title={lane.name || `Lane ${lane.label}`} className="lane-name" placeholder={`Lane ${lane.label}`} value={lane.name ?? ""} onChange={(e) => change(lane.id, (item) => ({ ...item, name: e.target.value }))} />
        <select aria-label={`Lane ${lane.label} language`} value={lane.language} onChange={(e) => updateLanguage(e.target.value as Lane["language"])}>
          {Object.entries(languages).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </> : <><span className="lane-name view-only">{lane.name || `Lane ${lane.label}`}</span><span>{languages[lane.language]}</span></>}
      <code className="lane-arch" title="The server's architecture">{lane.arch}</code>
      {translationOnly && <span className="chip" title={`The server has no ${languages[lane.language]} executor. You can translate this lane, but not run it.`}>Translation only</span>}
      <span className="chip mode-chip" title={lane.mode === "scaffold" ? "Edit the DSL and generate a harness." : "Edit the harness directly."}>{lane.mode === "scaffold" ? "Scaffold" : "Code"}</span>
      {editable && lane.mode === "scaffold" && <button className="control" type="button"
        disabled={generating || preparingRun} title={`Translate pseudocode to ${languages[lane.language]} (Ctrl/⌘ Shift G)`}
        onClick={translate}>{generating ? "Translating…" : "Translate"}</button>}
      {editable && <div className="lane-menu-wrap" ref={menuWrap}>
        <button className="control icon-control" type="button" aria-label={`Lane ${lane.label} actions`} title={`Lane ${lane.label} actions`} aria-expanded={menu} ref={menuButton} onClick={() => setMenu(!menu)}><DotsThreeIcon size={20} weight="bold" aria-hidden="true" /></button>
        {menu && <div className="lane-menu" onBlur={(e) => { if (e.relatedTarget && !menuWrap.current?.contains(e.relatedTarget)) setMenu(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") { setMenu(false); menuButton.current?.focus(); } }}>
          <button type="button" disabled={!canAdd} onClick={() => { setMenu(false); add(lane); }}>Duplicate lane</button>
          <button type="button" onClick={() => { setMenu(false); setConfirm({ title: `Reset lane ${lane.label}?`, text: "This replaces this lane’s settings and files.", action: "Reset lane", run: () => {
            const starter = starterLane(lane.arch, machine?.languages?.[0]);
            const dsl = linked ? lane.files["benchmark.perf"] : starter.files["benchmark.perf"];
            change(lane.id, (entry) => ({ ...starter, id: entry.id, label: entry.label, color: entry.color, files: { "benchmark.perf": dsl } }));
            setFile("benchmark.perf");
          } }); }}>Reset lane</button>
          <button type="button" disabled={!canRemove} onClick={() => { setMenu(false); setConfirm({ title: `Remove lane ${lane.label}?`, text: "This removes its files and options from the bench.", action: "Remove lane", run: () => useBench.getState().edit((workspace) => ({ ...workspace, lanes: workspace.lanes.filter((item) => item.id !== lane.id) })) }); }}>Remove lane</button>
        </div>}
      </div>}
    </div>
    {active && ["queued", "building", "running"].includes(active) && snapshot && <div className="lane-progress"><i style={{ transform: `scaleX(${total?.type === "perm_start" ? progress / total.total : 0})` }} /></div>}
    <CompilerOptions lane={lane} readOnly={!editable || preparingRun} />
    <div className="file-strip">
      <div className="tab-strip" role="tablist" aria-label={`Lane ${lane.label} files`}>{laneFiles(lane).map((name) =>
        <button type="button" role="tab" aria-selected={file === name} key={name} title={name} onClick={() => { flushEditors(); setFile(name); }}>
          {name}{snapshot && snapshot.files[name] !== lane.files[name] && <span className="file-dirty" aria-label="Modified since run">•</span>}
          {issue && name === issueFile && <span className="error-text" aria-label="Build failed">●</span>}
        </button>)}
      </div>
      <span className={`file-state${issue || failed ? " error-text" : ""}`} title={status}>{status}</span>
    </div>
    {file === "benchmark.perf" && linked && <div className="editor-note"><LinkSimpleIcon size={14} aria-hidden="true" /> Linked benchmark.perf</div>}
    {file === nativeFile && <div className="editor-note">
      <span>Native {lane.arch} · C ABI · {sourceLength(lane.files[file] ?? "").toLocaleString()} / {SOURCE_CHAR_LIMIT.toLocaleString()} characters.
        Declare {lane.language === "go" ? "bodyless functions" : "typed ellipsis functions"} in #globals in code mode. <a href="/docs/guide#native-assembly">Assembly guide</a></span>
      {editable && <button type="button" className="text-action" disabled={preparingRun || generating} onClick={() => {
        flushEditors();
        setConfirm({ title: "Load native NOP example?", text: "This replaces this lane’s code, assembly and sweep, and switches it to code mode.", action: "Load example", run: () => {
          const example = assemblyExample(lane.language, lane.arch, machine?.os);
          change(lane.id, (entry) => {
            const files = { ...entry.files };
            delete files["native.S"];
            delete files["native.asm"];
            return { ...entry, mode: "ejected", scaffold: undefined, files: { ...files,
              "benchmark.perf": example.code, [harnessName]: example.code, [example.file]: example.assembly } };
          });
          setFile(example.file);
        } });
      }}>Load NOP example</button>}
    </div>}
    {file === "benchmark.perf" && lane.mode === "ejected" && <div className="editor-note">DSL reference. Edit sweep parameters in the Sweep tab.</div>}
    {file === harnessName && lane.mode === "scaffold" && !loadingHarness && <div className="editor-note">
      {harnessText ? "Generated from benchmark.perf. Read-only until you edit as code." : "Translate to view the harness."}
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
    {options && <LaneOptions lane={lane} close={() => setOptions(false)} />}
    {diffOpen && diff && <Overlay title="Generated code changes" onClose={() => setDiffOpen(false)}><CodeDiff before={diff.before} after={diff.after} /></Overlay>}
  </article>;
}

function WorkspaceView({ workspace, machines }: { workspace: Workspace; machines?: Machine[] }) {
  const mobile = useReadOnlyWidth();
  const tabs = useMedia(tabbed);
  const [params, setParams] = useSearchParams();
  const selectedLane = workspace.lanes.find((lane) => lane.label === params.get("lane")) ?? workspace.lanes[0];
  const editable = !mobile;
  const machine = machines?.[0];
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [jump, setJump] = useState<{ id: string; line: number; serial: number }>();
  const layout = useBench((s) => s.layout);
  const setLayout = useBench((s) => s.setLayout);
  const [widthPreview, setWidthPreview] = useState<Record<string, number> | null>(null);
  const [heightPreview, setHeightPreview] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const grid = !tabs && workspace.lanes.length >= 3;
  const shown = tabs ? [selectedLane] : workspace.lanes;

  // Each lane follows the architecture of its language's execution target.
  useEffect(() => {
    if (!machines?.length) return;
    const current = useBench.getState().workspace;
    const lanes = current.lanes.map((lane) => {
      const target = machines.find((target) => target.languages?.includes(lane.language));
      return target && target.arch !== lane.arch ? { ...lane, arch: target.arch } : lane;
    });
    if (lanes.some((lane, index) => lane !== current.lanes[index])) useBench.setState({ workspace: { ...current, lanes } });
  }, [machines, workspace]);

  function select(lane: Lane, file?: FileName) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("lane", lane.label);
      if (file) next.set(`file${lane.label}`, file);
      return next;
    }, { replace: true });
  }
  function fileFor(lane: Lane) {
    const files = laneFiles(lane);
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
      const files = Object.fromEntries(snapshot.lanes.flatMap((lane) => laneFiles(lane).flatMap((name) => {
        const contents = lane.files[name];
        return contents === undefined ? [] : [[`lane-${lane.label}/${name}`, strToU8(contents)] as const];
      })));
      const archive = zipSync(files);
      download(`${basename}.zip`, new Blob([new Uint8Array(archive)], { type: "application/zip" }));
    } catch { useBench.getState().notify({ text: "Couldn’t export the files. Try again.", error: true }); }
  }
  function jumpTo(lane: Lane, line: number, file: FileName = harness(lane.language)) {
    if (!workspace.lanes.some((entry) => entry.id === lane.id)) return;
    select(lane, file);
    setJump({ id: lane.id, line, serial: Date.now() });
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      // Alt+1–4: Ctrl/⌘+1–8 are reserved by browsers for tab switching. Match the physical key; Option+digit types a symbol on macOS.
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-4]$/.test(e.code)) {
        const lane = workspace.lanes[Number(e.code.slice(5)) - 1];
        if (!lane) return;
        e.preventDefault(); select(lane);
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[aria-label="Lane ${lane.label}"] [role="tab"][aria-selected="true"]`)?.focus());
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      const character = e.key.toLowerCase();
      if (character === "j") { e.preventDefault(); setLayout({ collapsed: !useBench.getState().layout.collapsed }); }
      if (e.shiftKey && character === "g" && editable && selectedLane.mode === "scaffold") {
        e.preventDefault(); flushEditors(); select(selectedLane, harness(selectedLane.language));
        const lane = useBench.getState().workspace.lanes.find((item) => item.id === selectedLane.id);
        if (lane) void generateLane(lane);
      }
      if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault(); flushEditors();
        const files = laneFiles(selectedLane);
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
      try {
        const value: unknown = JSON.parse(await e.dataTransfer.files[0].text());
        if (!validWorkspace(value)) throw new Error();
        replaceWorkspace(freshWorkspace(value));
      } catch { useBench.getState().notify({ text: "Drop a Bench.it workspace JSON file.", error: true }); }
    } : undefined}>
    <h1 className="sr-only">Workbench</h1>
    {mobile ? <div className="bench-banner"><span>Open on a larger screen to edit and run</span></div> : <div className="bench-banner">
      <span>{machine ? `Live execution: ${machines?.map((target) => `${target.languages?.map((language) => languages[language]).join(", ")} on ${target.id}`).join(" · ")}` : "Waiting for the execution server."}</span>
      <div className="bench-tools">
        <label className="control link-toggle"><input type="checkbox" checked={workspace.linkDsl} onChange={toggleLink} /><LinkSimpleIcon size={15} aria-hidden="true" /> Linked DSL</label>
        <details className="action-menu"><summary className="control">Export bench</summary><div className="menu-panel">
          <button type="button" onClick={() => void exportWorkspace(false)}>Workspace JSON</button>
          <button type="button" onClick={() => void exportWorkspace(true)}>Raw files ZIP</button>
        </div></details>
        <button className="control" type="button" onClick={() => setAddOpen(true)} disabled={workspace.lanes.length >= 4} title={workspace.lanes.length >= 4 ? "You can use up to four lanes" : "Add lane"}><PlusIcon size={16} aria-hidden="true" /> Add lane</button>
      </div>
    </div>}
    {tabs && shown.length > 0 && workspace.lanes.length > 1 && <div className="tab-strip lane-switcher" aria-label="Choose lane">
      {workspace.lanes.map((lane) => <button type="button" key={lane.id} aria-pressed={selectedLane.id === lane.id} onClick={() => { flushEditors(); select(lane); }}><LaneBadge lane={lane} /> {lane.name || languages[lane.language]}</button>)}
    </div>}
    <div className={`lanes${grid ? " lanes-grid" : ""}`}>
      {shown.map((lane, index) => <div className="lane-wrap" key={lane.id} style={{ "--lane-width": widthPreview?.[lane.label] ?? layout.widths[lane.label] ?? 1 } as CSSProperties}>
        <LanePane lane={lane} file={fileFor(lane)} linked={workspace.linkDsl && workspace.lanes.filter((item) => item.mode === "scaffold").length > 1 && lane.mode === "scaffold"} editable={editable}
          machine={machines?.find((target) => target.languages?.includes(lane.language))} setFile={(file) => select(lane, file)} setConfirm={setConfirm} add={add}
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
    <div onPointerUp={() => { if (heightPreview !== null) { setLayout({ height: heightPreview }); setHeightPreview(null); } }} style={{ "--resized-panel": heightPreview === null ? undefined : `${heightPreview}px` } as CSSProperties}>
      <RunPanel workspace={workspace} onJump={jumpTo} editable={editable} onResize={(height) => {
        const next = Math.max(240, Math.min(720, height));
        if (document.activeElement?.classList.contains("panel-resizer") && !root.current?.querySelector(".panel-resizer:active")) setLayout({ height: next });
        else setHeightPreview(next);
      }} />
    </div>
    {addOpen && <Overlay title="Add lane" onClose={() => setAddOpen(false)}><div className="overlay-body add-choices">
      <button type="button" className="control primary" onClick={() => add()}><PlusIcon size={16} aria-hidden="true" /> New lane</button>
      {workspace.lanes.map((lane) => <button type="button" className="control" key={lane.id} onClick={() => add(lane)}>Duplicate lane {lane.label}</button>)}
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
  const examples = useQuery({ queryKey: ["examples"], queryFn: ({ signal }) => getExamples(signal), enabled: Boolean(exampleId) });
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
    const incoming = location.state as { workspace?: Workspace; fresh?: boolean; rerun?: boolean } | null;
    if (!incoming?.workspace || handled.current === location.key) return;
    handled.current = location.key;
    const next = incoming.fresh ? freshWorkspace(incoming.workspace) : incoming.workspace;
    if (replaceWorkspace(next) && incoming.rerun && !small.matches) {
      if (query.getQueryData<Machine[]>(["machines"])?.length) void runBench(query);
      else useBench.getState().notify({ text: "The execution server is unavailable. Try again when it’s online.", error: true });
    }
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location, navigate, query]);

  return <>{exampleId && examples.isError && <div className="page bench-error"><p className="error-text">The example could not be loaded.</p><button className="control" type="button" onClick={() => void examples.refetch()}>Try again</button></div>}<WorkspaceView workspace={workspace} machines={machines} /></>;
}
