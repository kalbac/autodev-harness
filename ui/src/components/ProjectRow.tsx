import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "@/lib/api";
import { toneVar } from "@/lib/status";
import { runSeal } from "@/lib/runSeal";
import { useRuns, useState as useHarnessState } from "@/lib/queries";
import { cn, timeAgo } from "@/lib/utils";

/**
 * One project in the sidebar.
 *
 * DATA-FETCH DISCIPLINE: only the ACTIVE project's runs + state are fetched.
 * The runs/state hooks live in `<ActiveProjectRuns>`, which is mounted ONLY for
 * the active row — so collapsed rows issue zero requests and just show the idle
 * dot. (Hooks can't be conditional inside one component, so mounting-gating the
 * child is what keeps this to a single project's fetch instead of N.)
 */
export function ProjectRow({ project, active }: { project: ProjectSummary; active: boolean }) {
  if (active) return <ActiveProject project={project} />;
  return <ProjectHead project={project} active={false} hasActiveRun={false} />;
}

/** The collapsed/active head row: chevron + name + a status dot on the right. */
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
  return (
    <Link
      to="/p/$projectId"
      params={{ projectId: project.id }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-semibold transition-colors",
        active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface",
        isError && !active && "bg-[color-mix(in_srgb,var(--color-broken)_10%,transparent)]",
      )}
    >
      <span className="w-2.5 shrink-0 text-[10px] text-subtle">{active ? "▾" : "▸"}</span>
      <span className="min-w-0 truncate">{project.name}</span>
      <StatusDot tone={isError ? "broken" : hasActiveRun ? "working" : "idle"} pulse={hasActiveRun} />
    </Link>
  );
}

/** 7px head dot — working glows/pulses, idle is a flat line-strong pip. */
function StatusDot({ tone, pulse }: { tone: "working" | "idle" | "broken"; pulse: boolean }) {
  return (
    <span
      className="ml-auto size-[7px] shrink-0 rounded-full"
      style={{
        background: tone === "idle" ? "var(--color-line-strong)" : toneVar[tone],
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
    <div>
      <ProjectHead project={project} active hasActiveRun={hasActiveRun} />
      <div className="pl-6 pr-1 pt-0.5 pb-1.5">
        {last5.map((run) => (
          <Link
            key={run.runId}
            to="/p/$projectId/runs/$runId"
            params={{ projectId: project.id, runId: run.runId }}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <span
              className="size-[6px] shrink-0 rounded-[2px]"
              style={{ background: toneVar[runSeal(run, state.data)] }}
            />
            <span className="min-w-0 flex-1 truncate text-xs">{run.intent}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-subtle">{timeAgo(run.at)}</span>
          </Link>
        ))}
        {runs.data && runs.data.length > 0 && (
          <Link
            to="/p/$projectId/board"
            params={{ projectId: project.id }}
            className="block px-2 py-0.5 text-[11px] text-subtle transition-colors hover:text-muted"
          >
            show more…
          </Link>
        )}
      </div>
    </div>
  );
}
