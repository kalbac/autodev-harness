import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutGrid, Plus, Radio, ShieldAlert, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import { useRuns, useState as useHarnessState } from "@/lib/queries";
import { useAppStore, type ConnState } from "@/lib/store";
import { Dot } from "./ui/Dot";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting",
  live: "live",
  offline: "offline",
};
const CONN_TONE = { connecting: "uncertain", live: "clean", offline: "broken" } as const;

export function Sidebar() {
  const runs = useRuns();
  const state = useHarnessState();
  const conn = useAppStore((s) => s.conn);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const escalatedCount = state.data?.queues.escalated.length ?? 0;
  const activeCount = state.data?.queues.active.length ?? 0;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line">
        <div className="grid size-7 place-items-center rounded-md bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent">
          <Terminal className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold leading-tight text-text">Autodev</div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-subtle leading-tight">
            harness
          </div>
        </div>
      </div>

      {/* New run */}
      <div className="p-3">
        <Link
          to="/"
          className={cn(
            "flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:border-line-strong",
            pathname === "/" && "border-line-strong bg-surface-2",
          )}
        >
          <Plus className="size-4 text-accent" />
          New run
        </Link>
      </div>

      {/* Nav */}
      <nav className="px-3 pb-2 flex flex-col gap-0.5">
        <NavItem to="/board" icon={LayoutGrid} label="Board" active={pathname === "/board"}>
          {activeCount > 0 && (
            <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-working">
              <Dot tone="working" pulse />
              {activeCount}
            </span>
          )}
        </NavItem>
        <NavItem to="/board" icon={ShieldAlert} label="Escalations" active={false}>
          {escalatedCount > 0 && (
            <span
              className="ml-auto rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold text-uncertain"
              style={{ background: "color-mix(in srgb, var(--color-uncertain) 15%, transparent)" }}
            >
              {escalatedCount}
            </span>
          )}
        </NavItem>
      </nav>

      {/* Runs */}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-subtle">Runs</span>
        <span className="font-mono text-[10px] text-subtle">{runs.data?.length ?? 0}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {runs.data && runs.data.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {runs.data.map((r) => {
              const active = pathname === `/runs/${r.runId}`;
              return (
                <li key={r.runId}>
                  <Link
                    to="/runs/$runId"
                    params={{ runId: r.runId }}
                    className={cn(
                      "block rounded-md px-2.5 py-1.5 transition-colors hover:bg-surface",
                      active && "bg-surface",
                    )}
                  >
                    <div
                      className={cn(
                        "truncate text-[13px] leading-snug",
                        active ? "text-text" : "text-muted",
                      )}
                    >
                      {r.intent}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-subtle mt-0.5">
                      <span>{r.taskIds.length} task{r.taskIds.length === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span>{timeAgo(r.at)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-2.5 py-3 text-xs text-subtle">No runs yet.</p>
        )}
      </div>

      {/* Daemon status */}
      <div className="flex items-center gap-2 border-t border-line px-4 h-10 font-mono text-[11px] text-muted">
        <Radio className="size-3.5 text-subtle" />
        <span>daemon</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Dot tone={CONN_TONE[conn]} pulse={conn === "connecting"} />
          {CONN_LABEL[conn]}
        </span>
      </div>
    </aside>
  );
}

function NavItem({
  to,
  icon: Icon,
  label,
  active,
  children,
}: {
  to: string;
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-surface",
        active ? "bg-surface text-text" : "text-muted",
      )}
    >
      <Icon className="size-4" />
      {label}
      {children}
    </Link>
  );
}
