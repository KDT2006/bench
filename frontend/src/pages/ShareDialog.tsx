import { useState } from "react";
import { Link } from "react-router-dom";
import { send } from "../api/client";
import type { Workspace } from "../api/types";
import { useBench } from "../model/state";
import { Overlay } from "../shell/Overlay";

export function ShareDialog({ workspace, runId, close }: { workspace: Workspace; runId?: string; close: () => void }) {
  const [include, setInclude] = useState(false);
  const [link, setLink] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setPending(true);
    setError("");
    try {
      const { shareId } = await send<{ shareId: string }>("/share", { workspace, ...(include && runId ? { runId } : {}) });
      setLink(new URL(`/s/${encodeURIComponent(shareId)}`, location.origin).href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create a link. Try again."); }
    finally { setPending(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); useBench.getState().notify({ text: "Link copied." }); close(); }
    catch { setError("Select the link and copy it manually."); }
  }
  return <Overlay title="Share bench" onClose={close}><div className="overlay-body share-body">
    <p>Create a read-only link to this bench. Anyone who can reach this server and has the link can open it.</p>
    {runId && <label className="check-setting"><input type="checkbox" checked={include} disabled={pending} onChange={(e) => { setInclude(e.target.checked); setLink(""); }} /> Include results from the last run</label>}
    {link && <label>Share link<input type="url" value={link} readOnly onFocus={(e) => e.target.select()} /></label>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="dialog-actions">{link ? <><Link className="control" to={new URL(link).pathname} onClick={close}>Open shared bench</Link><button type="button" className="control primary" onClick={() => void copy()}>Copy link</button></>
      : <button type="button" className="control primary" disabled={pending} onClick={() => void create()}>{pending ? "Creating link…" : "Create link"}</button>}</div>
  </div></Overlay>;
}
