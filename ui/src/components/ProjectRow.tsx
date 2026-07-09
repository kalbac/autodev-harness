import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "@/lib/api";
import { toneVar } from "@/lib/status";
import { runSeal } from "@/lib/runSeal";
import { useRuns, useState as useHarnessState } from "@/lib/queries";
import { cn, timeAgo } from "@/lib/utils";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";

/**
 * One project in the sidebar, rendered as a shadcn `SidebarMenuItem`.
 *
 * DATA-FETCH DISCIPLINE (unchanged from the pre-block version): only the ACTIVE
 * project's runs + state are fetched. The runs/state hooks live in
 * `<ActiveProject>`, mounted ONLY for the active row — so collapsed rows issue
 * zero requests and just show the idle dot. Mount-gating the child is what keeps
 * this to a single project's fetch instead of N.
 *
 * In the collapsed icon rail, the leading letter-avatar shows (tooltip = name)
 * and the label + runs sub-menu clip/hide via the block's own icon-mode classes.
 */
export function ProjectRow({ project, active }: { project: ProjectSummary; active: boolean }) {
  if (active) return <ActiveProject project={project} />;
  return (
    <SidebarMenuItem>
      <ProjectHead project={project} active={false} hasActiveRun={false} />
    </SidebarMenuItem>
  );
}

/** Stable 1-letter avatar for the collapsed icon rail. */
function initial(name: string): string {
  const c = name.trim()[0];
  return c ? c.toUpperCase() : "?";
}

/** The head row: letter-avatar + name + a status dot on the right. */
function ProjectHead({
  project,
  active,
  hasActiveRun,
}: {
  project: ProjectSummary;
  active: boolean;
  hasActiveRun: boolean;
}) {
  const isError = project.status === "error";
  const tone = isError ? "broken" : hasActiveRun ? "working" : "idle";
  return (
    <SidebarMenuButton
      isActive={active}
      tooltip={project.name}
      render={<Link to="/p/$projectId" params={{ projectId: project.id }} />}
      className={cn(
        "font-semibold",
        isError && !active && "bg-[color-mix(in_srgb,var(--color-broken)_10%,transparent)]",
      )}
    >
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-muted text-[9px] font-bold text-muted-foreground"
      >
        {initial(project.name)}
      </span>
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      <StatusDot tone={tone} pulse={hasActiveRun} />
    </SidebarMenuButton>
  );
}

/** 7px head dot — working glows/pulses, idle is a flat border-toned pip. */
function StatusDot({ tone, pulse }: { tone: "working" | "idle" | "broken"; pulse: boolean }) {
  return (
    <span
      className="size-[7px] shrink-0 rounded-full"
      style={{
        background: tone === "idle" ? "var(--border)" : toneVar[tone],
        boxShadow: tone === "working" ? `0 0 6px ${toneVar.working}` : undefined,
        animation: pulse ? "status-pulse 1.8s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/** Active project: fetches its runs + state, renders head (with live dot) + last-5 runs. */
function ActiveProject({ project }: { project: ProjectSummary }) {
  const runs = useRuns(project.id);
  const state = useHarnessState(project.id);
  const hasActiveRun = (state.data?.queues.active.length ?? 0) > 0;
  const last5 = (runs.data ?? []).slice(0, 5);

  return (
    <SidebarMenuItem>
      <ProjectHead project={project} active hasActiveRun={hasActiveRun} />
      {last5.length > 0 && (
        <SidebarMenuSub>
          {last5.map((run) => (
            <SidebarMenuSubItem key={run.runId}>
              <SidebarMenuSubButton
                render={
                  <Link
                    to="/p/$projectId/runs/$runId"
                    params={{ projectId: project.id, runId: run.runId }}
                  />
                }
              >
                <span
                  className="size-[6px] shrink-0 rounded-[2px]"
                  style={{ background: toneVar[runSeal(run, state.data)] }}
                />
                <span className="min-w-0 flex-1 truncate text-xs">{run.name ?? run.intent}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                  {timeAgo(run.at)}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
          {runs.data && runs.data.length > 0 && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<Link to="/p/$projectId/board" params={{ projectId: project.id }} />}
                className="text-[11px] text-muted-foreground"
              >
                show more…
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}
