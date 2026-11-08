import { NavLink, Outlet } from "react-router-dom";

export default function Docs() {
  return <div className="page docs-page">
    <header className="page-heading"><h1>Docs</h1><p>Examples to get started and a guide to writing and measuring benchmarks.</p></header>
    <nav className="docs-tabs" aria-label="Documentation tabs">
      <NavLink className="control" to="/docs/examples">Examples</NavLink>
      <NavLink className="control" to="/docs/guide">Guide</NavLink>
    </nav>
    <div className="docs-content"><Outlet /></div>
  </div>;
}
