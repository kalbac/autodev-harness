import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { useProjects, useRuns, useState as useProjectState } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { runSeal } from "@/lib/runSeal";
import { toneVar, type Tone } from "@/lib/status";
import { timeAgo } from "@/lib/utils";
import type { RunManifest, StateResponse } from "@/lib/api";
import { NewRunComposer } from "@/components/NewRunComposer";
import { ProjectTopBar } from "@/components/ProjectTopBar";
import { EmptyState } from "@/components/ui/Feedback";

/** Seal tone → the short verdict label rendered on a recent-run card. */
const SEAL_LABEL: Record<Tone, string> = {
  working: "RUNNING",
  clean: "CLEAN",
  uncertain: "UNCERTAIN",
  broken: "BROKEN",
  idle: "IDLE",
  accent: "—",
};

/** Seal tone → the one-line status gloss under a recent-run card title. */
const SEAL_SUB: Record<Tone, string> = {
  working: "worker in progress",
  clean: "committed & merged",
  uncertain: "escalated — needs decision",
  broken: "quarantined",
  idle: "queued",
  accent: "",
};

export function HomeView() {
  // Route guarantees projectId under `/p/:projectId/`; `?? ""` is only for the type.
  const projectId = useProjectId() ?? "";
  const [showArchived, setShowArchived] = useState(false);
  const runs = useRuns(projectId, showArchived);
  const state = useProjectState(projectId);
  const projects = useProjects();

  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ProjectTopBar projectId={projectId} />

      <div className="flex-1 overflow-auto">
        {/* Hero — composer-first: the one control that starts work. */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-8 pt-14">
          <h1 className="mb-2 text-center font-display text-[26px] font-semibold leading-tight text-text">
            What are we building in {projectName}?
          </h1>
          <p className="mx-auto mb-6 max-w-xl text-center text-sm text-muted">
            Describe an intent — the orchestrator decomposes it into gated tasks, an independent
            critic reviews every diff, and only clean work is committed.
          </p>

          <NewRunComposer autoFocus />
        </div>

        {/* Recent runs — cards with a verdict seal. */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-16">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-wider text-subtle">Recent runs</h2>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="font-mono text-[10px] uppercase tracking-wider text-subtle transition-colors hover:text-muted"
            >
              {showArchived ? "hide archived" : "show archived"}
            </button>
          </div>

          {runs.data && runs.data.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {runs.data.slice(0, 8).map((r) => (
                <li key={r.runId}>
                  <RunCard run={r} projectId={projectId} state={state.data} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Inbox}
              title="No runs yet"
              description="Launch your first run above — it will appear here and in the sidebar."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RunCard({
  run,
  projectId,
  state,
}: {
  run: RunManifest;
  projectId: string;
  state: StateResponse | undefined;
}) {
  const tone = runSeal(run, state);
  const c = toneVar[tone];

  return (
    <Link
      to="/p/$projectId/runs/$runId"
      params={{ projectId, runId: run.runId }}
      className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong"
    >
      <span
        className="shrink-0 rounded-md border px-2 py-[3px] font-mono text-[10px] tracking-[0.08em]"
        style={{
          color: c,
          borderColor: `color-mix(in srgb, ${c} 40%, transparent)`,
          background: `color-mix(in srgb, ${c} 8%, transparent)`,
        }}
      >
        {SEAL_LABEL[tone]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text">{run.name ?? run.intent}</span>
          {run.archived_at !== undefined && (
            <span className="shrink-0 rounded border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-subtle">
              archived
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-subtle">
          {run.taskIds.length} task{run.taskIds.length === 1 ? "" : "s"}
          {SEAL_SUB[tone] ? ` · ${SEAL_SUB[tone]}` : ""}
        </div>
      </div>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle">{timeAgo(run.at)}</span>
    </Link>
  );
}
