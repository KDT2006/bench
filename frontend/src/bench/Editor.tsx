import { useLayoutEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate, drawSelection, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter, foldKeymap, foldService, HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { linter, lintGutter, setDiagnostics } from "@codemirror/lint";
import { go } from "@codemirror/lang-go";
import { python } from "@codemirror/lang-python";
import { vim, getCM } from "@replit/codemirror-vim";
import { tags } from "@lezer/highlight";
import type { FileName } from "../api/types";
import { builtins, diagnostics, directives, primitives } from "../model/dsl";
import { parseSweep } from "../model/sweep";
import { sectionPattern } from "../model/sections";
import { usePreferences } from "../shell/preferences";
import { editorFlushes } from "./editorSync";

const section = sectionPattern;
const dslLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.sol() && stream.match(section)) return "keyword";
    if (stream.match(/\/\/.*/)) return "comment";
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/\b\d+(?:\.\d+)?(?:[KMG]i?B?)?/i)) return "number";
    const word = stream.match(/[A-Za-z_]\w*/);
    if (Array.isArray(word)) return builtins.has(word[0]) ? "builtin" : null;
    stream.next();
    return null;
  },
  tokenTable: { builtin: tags.standard(tags.variableName) },
});
const asmLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/(?:#|\/\/).*/)) return "comment";
    if (stream.match(/(?:[.$%][\w]+|[\w.]+:)/)) return "keyword";
    if (stream.match(/\d+/)) return "number";
    stream.next();
    return null;
  },
});
const style = HighlightStyle.define([
  { tag: tags.keyword, class: "cm-token-keyword" },
  { tag: tags.comment, class: "cm-token-comment" },
  { tag: [tags.string, tags.number], class: "cm-token-literal" },
  { tag: tags.standard(tags.variableName), class: "cm-token-builtin" },
]);

function rules(view: EditorView) {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let start = from; start <= to;) {
      const line = view.state.doc.lineAt(start);
      const match = section.exec(line.text);
      if (match) {
        ranges.push(Decoration.line({ class: "cm-directive" }).range(line.from));
        ranges.push(Decoration.mark({ class: "cm-directive-name" }).range(line.from, line.from + match[0].length));
      }
      start = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const rulePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = rules(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = rules(update.view); }
}, { decorations: (plugin) => plugin.decorations });

const sectionFolding = foldService.of((state, from, to) => {
    if (!section.test(state.doc.lineAt(from).text)) return null;
    let end = to;
    for (let i = state.doc.lineAt(from).number + 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (section.test(line.text)) break;
      end = line.to;
    }
    return end > to ? { from: to, to: end } : null;
  });

const dslExtras = [
  dslLanguage, rulePlugin, sectionFolding,
  autocompletion({ override: [(context) => {
    const word = context.matchBefore(/[#\w]+/);
    if (!word && !context.explicit) return null;
    const parameters = parseSweep(context.state.doc.toString()).sweep.map(({ name }) => ({ label: name, type: "variable" }));
    return { from: word?.from ?? context.pos, options: [
      ...primitives.map((entry) => ({ label: entry.name, detail: entry.signature, info: entry.description, type: "function" })),
      ...directives.map((directive) => ({ label: `#${directive}`, type: "keyword" })),
      ...parameters,
    ] };
  }] }),
  hoverTooltip((view, pos) => {
    const word = view.state.wordAt(pos);
    const entry = word && builtins.get(view.state.sliceDoc(word.from, word.to));
    if (!word || !entry) return null;
    return { pos: word.from, end: word.to, above: true, create: () => {
      const dom = document.createElement("div");
      dom.className = "editor-help";
      const signature = document.createElement("code");
      signature.textContent = entry.signature;
      const description = document.createElement("p");
      description.textContent = entry.description;
      const link = document.createElement("a");
      link.href = `/guide#${entry.name}`;
      link.textContent = "Open in guide";
      dom.append(signature, description, link);
      return { dom };
    } };
  }),
];

const language = (file: FileName): Extension => file === "benchmark.perf" ? dslExtras
  : file === "harness.go" ? [go(), rulePlugin, sectionFolding] : file === "harness.py" ? [python(), rulePlugin, sectionFolding] : asmLanguage;

interface Props {
  file: FileName;
  value: string;
  label: string;
  readOnly?: boolean;
  onChange?: (text: string) => void;
  jump?: { line: number; serial: number };
  buildError?: { line: number; message: string };
}

export default function Editor({ file, value, label, readOnly = false, onChange, jump, buildError }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const config = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;
  const initialValue = useRef(value);
  const settings = usePreferences((s) => s.keymap);
  const font = usePreferences((s) => s.fontSize);
  const [mode, setMode] = useState("Normal");
  const isVim = settings === "vim" && !readOnly;
  const lastPending = useRef<string | null>(null);

  useLayoutEffect(() => {
    let timer = 0;
    let external = false;
    const flush = () => {
      window.clearTimeout(timer);
      if (lastPending.current !== null) {
        const text = lastPending.current;
        lastPending.current = null;
        change.current?.(text);
      }
    };
    const view = new EditorView({ parent: root.current!, state: EditorState.create({
      doc: initialValue.current,
      extensions: [
        config.current.of([]), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
        history(), bracketMatching(), closeBrackets(), foldGutter(), lintGutter(), EditorView.lineWrapping,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
        syntaxHighlighting(style), language(file),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
        ...(file === "benchmark.perf" ? [linter((current) => diagnostics(current.state.doc.toString()).map((issue) => {
          const line = current.state.doc.line(Math.max(1, Math.min(issue.line, current.state.doc.lines)));
          return { from: line.from, to: line.to, severity: "error", message: issue.message };
        }), { delay: 280 })] : []),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || external || !change.current) return;
          lastPending.current = update.state.doc.toString();
          window.clearTimeout(timer);
          timer = window.setTimeout(flush, 180);
        }),
        EditorView.domEventHandlers({ blur: flush }),
      ],
    }) });
    const sync = (text: string) => {
      if (lastPending.current !== null || view.state.doc.toString() === text) return;
      external = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      external = false;
    };
    editor.current = view;
    editorFlushes.add(flush);
    synchronize.current = sync;
    return () => { flush(); editorFlushes.delete(flush); view.destroy(); editor.current = null; };
  }, [file, label]);

  useLayoutEffect(() => {
    const view = editor.current!;
    view.dispatch({ effects: config.current.reconfigure([
      ...(isVim ? [vim()] : []),
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) });
    const cm = isVim ? getCM(view) : undefined;
    const listener = (entry: { mode: string }) => setMode(entry.mode === "insert" ? "Insert" : entry.mode === "visual" ? "Visual" : "Normal");
    cm?.on("vim-mode-change", listener);
    return () => { cm?.off("vim-mode-change", listener); };
  }, [readOnly, isVim, file, label]);

  const synchronize = useRef<(text: string) => void>(() => {});
  useLayoutEffect(() => { synchronize.current(value); }, [value, file, label]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !jump) return;
    const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, jump.line)));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }, [jump, file]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || file === "benchmark.perf") return;
    const line = buildError && view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, buildError.line)));
    view.dispatch(setDiagnostics(view.state, line ? [{ from: line.from, to: line.to, severity: "error", message: buildError.message }] : []));
  }, [buildError, file]);

  return <div className="editor-frame" style={{ fontSize: `${font}px` }}>
    <div className="editor-host" ref={root} />
    {isVim && <div className="editor-mode" aria-live="polite">Vim · {mode}</div>}
  </div>;
}
