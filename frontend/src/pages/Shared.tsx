import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/client";
import type { ShareSnapshot } from "../api/types";
import { WorkspaceView, EditorSkeleton } from "../bench/Workbench";
import { useBench } from "../model/state";

export default function Shared() {
  const { shareId = "" } = useParams();
  const navigate = useNavigate();
  const share = useQuery({ queryKey: ["share", shareId], queryFn: ({ signal }) => request<ShareSnapshot>(`/share/${encodeURIComponent(shareId)}`, { signal }), retry: false });
  if (share.isPending) return <div className="page index-page"><h1>Shared bench</h1><EditorSkeleton text="Loading shared bench…" /></div>;
  if (share.isError) return <div className="page route-stub"><h1>Shared bench</h1><p className="error-text">This link could not be loaded. Check the address or ask for a new link.</p><Link className="control primary" to="/bench">Open the workbench</Link></div>;
  return <><WorkspaceView workspace={share.data.workspace} shared onFork={() => {
    navigate("/bench", { state: { workspace: share.data.workspace, fresh: true, fork: true } });
    useBench.getState().notify(null);
  }} />
  {share.data.runId && <div className="page shared-result"><Link className="control" to={`/results/${encodeURIComponent(share.data.runId)}`}>View included results</Link></div>}</>;
}
