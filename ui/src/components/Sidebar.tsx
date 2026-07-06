import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, Settings, Terminal } from "lucide-react";
import { useProjects } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { useAppStore, type ConnState } from "@/lib/store";
import { Dot } from "./ui/Dot";
import { ProjectRow } from "./ProjectRow";
import { SettingsPopover } from "./SettingsPopover";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting",
  live: "daemon",
  offline: "offline",
};
const CONN_TONE = { connecting: "uncertain", live: "clean", offline: "broken" } as const;

/**
 * Multi-project sidebar: brand → New Project → the project list (each project
 * expandable to its last-5 runs when active) → a footer with the daemon status
 * and a settings gear that toggles the settings popover. Board/escalations are
 * reached from each project's own screens now — the sidebar's job is project
 * navigation (matches the s16 mockup).
 */
export function Sidebar() {
  const projects = useProjects();
  const activeProjectId = useProjectId();
  const conn = useAppStore((s) => s.conn);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeProject = projects.data?.projects.find((p) => p.id === activeProjectId);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line">
        <div className="grid size-7 place-items-center rounded-md bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent">
          <Terminal className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="font-sans text-sm font-semibold leading-tight text-text">Autodev</div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-subtle leading-tight">
            harness
          </div>
        </div>
      </div>

      {/* New Project */}
      <div className="p-3">
        <Link
          to="/new"
          className="flex items-center gap-2 rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-text transition-colors hover:border-line-strong"
        >
          <Plus className="size-4 text-accent" />
          New Project
        </Link>
      </div>

      {/* Projects */}
      <div className="px-4 pt-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-subtle">
        Projects
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
        {projects.isError ? (
          <p className="px-2 py-3 text-xs text-broken">daemon unreachable</p>
        ) : (
          projects.data?.projects.map((p) => (
            <ProjectRow key={p.id} project={p} active={p.id === activeProjectId} />
          ))
        )}
      </nav>

      {/* Daemon status + settings gear */}
      <div className="relative flex items-center gap-2 border-t border-line px-3 h-11 font-mono text-[11px] text-muted">
        <Dot tone={CONN_TONE[conn]} pulse={conn === "connecting"} />
        <span>{CONN_LABEL[conn]}</span>
        <button
          type="button"
          // Stop the mousedown from reaching the popover's outside-click handler,
          // so the gear is a clean toggle (open → close) instead of re-opening.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Settings"
          className="ml-auto rounded-md border border-line px-1.5 py-1 text-muted transition-colors hover:border-line-strong hover:text-text"
        >
          <Settings className="size-3.5" />
        </button>
        {settingsOpen && (
          <SettingsPopover
            projectId={activeProjectId}
            projectName={activeProject?.name}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </aside>
  );
}
