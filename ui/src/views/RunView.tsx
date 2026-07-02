import { getRouteApi } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { useRun, useState as useHarnessState } from "@/lib/queries";
import { useTaskIndex } from "@/lib/useTaskIndex";
import { timeAgo } from "@/lib/utils";
import { TaskCard } from "@/components/TaskCard";
import { DigestStrip } from "@/components/DigestStrip";
import { ErrorState, Loading } from "@/components/ui/Feedback";

const route = getRouteApi("/runs/$runId");

export function RunView() {
  const { runId } = route.useParams();
  const run = useRun(runId);
  const { index } = useTaskIndex();
  const state = useHarnessState();

  if (run.isLoading) return <Loading label="Loading run…" />;
  if (run.isError) return <ErrorState message={(run.error as Error).message} />;

  const manifest = run.data!;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-6 py-4 shrink-0">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-subtle mb-2">
          <Layers className="size-3.5" />
          <span>run</span>
          <span className="text-muted normal-case tracking-normal">{manifest.runId}</span>
          <span>·</span>
          <span>{timeAgo(manifest.at)}</span>
        </div>
        <h1 className="font-display text-xl font-semibold leading-snug text-text max-w-3xl">
          {manifest.intent}
        </h1>
        <p className="mt-1.5 font-mono text-[11px] text-subtle">
          decomposed into {manifest.taskIds.length} task{manifest.taskIds.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <ol className="flex flex-col gap-2.5">
            {manifest.taskIds.map((id, i) => {
              const located = index.get(id);
              return (
                <li key={id} className="flex gap-3">
                  <div className="flex flex-col items-center pt-1">
                    <span className="grid size-6 place-items-center rounded-full border border-line bg-surface font-mono text-[10px] text-muted">
                      {i + 1}
                    </span>
                    {i < manifest.taskIds.length - 1 && (
                      <span className="w-px flex-1 bg-line mt-1" />
                    )}
                  </div>
                  <div className="flex-1 pb-1">
                    {located ? (
                      <TaskCard task={located.task} state={located.state} />
                    ) : (
                      <div className="rounded-lg border border-dashed border-line px-3 py-2.5 font-mono text-xs text-subtle">
                        {id} — not in any queue (cleaned up or not yet materialized)
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <DigestStrip digest={state.data?.digestTail ?? ""} />
      </div>
    </div>
  );
}
