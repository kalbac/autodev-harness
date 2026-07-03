import { Link } from "@tanstack/react-router";
import { GitBranch, Inbox } from "lucide-react";
import { useRuns } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { timeAgo } from "@/lib/utils";
import { NewRunComposer } from "@/components/NewRunComposer";
import { EmptyState } from "@/components/ui/Feedback";

export function HomeView() {
  // Route guarantees projectId under `/p/:projectId/`; `?? ""` is only for the type.
  const projectId = useProjectId() ?? "";
  const runs = useRuns(projectId);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Hero — the thesis in one line, then the one control that starts work. */}
        <div className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-accent mb-3">
            Autodev Harness
          </p>
          <h1 className="font-display text-3xl font-semibold leading-tight text-text">
            Let agents code.
            <br />
            <span className="text-muted">Never let them merge bullshit.</span>
          </h1>
          <p className="mt-3 text-sm text-muted max-w-xl">
            Describe a change. The orchestrator decomposes it into tasks, an independent critic
            gate reviews every diff, and only clean work is committed.
          </p>
        </div>

        <NewRunComposer autoFocus />

        {/* Recent runs */}
        <div className="mt-12">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-wider text-subtle">Recent runs</h2>
          </div>

          {runs.data && runs.data.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {runs.data.slice(0, 8).map((r) => (
                <li key={r.runId}>
                  <Link
                    to="/p/$projectId/runs/$runId"
                    params={{ projectId, runId: r.runId }}
                    className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong"
                  >
                    <GitBranch className="size-4 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{r.intent}</span>
                    <span className="shrink-0 font-mono text-[11px] text-subtle">
                      {r.taskIds.length} task{r.taskIds.length === 1 ? "" : "s"} · {timeAgo(r.at)}
                    </span>
                  </Link>
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
