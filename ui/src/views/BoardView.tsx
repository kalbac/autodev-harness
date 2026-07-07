import { useState } from "react";
import { ChevronRight, LayoutGrid } from "lucide-react";
import { useState as useHarnessState } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { QUEUE_META } from "@/lib/status";
import type { QueueState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dot } from "@/components/ui/Dot";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskCard } from "@/components/TaskCard";
import { EmptyState, ErrorState, Loading } from "@/components/ui/Feedback";

const COLUMNS: QueueState[] = ["active", "escalated", "pending", "quarantine"];

export function BoardView() {
  // Route guarantees projectId under `/p/:projectId/board`; `?? ""` only for the
  // off-route type (useProjectId is `string | null`) and never actually fetched.
  const projectId = useProjectId() ?? "";
  const state = useHarnessState(projectId);
  const [doneOpen, setDoneOpen] = useState(false);

  if (state.isLoading) return <Loading label="Loading board…" />;
  if (state.isError) return <ErrorState message={(state.error as Error).message} />;

  const queues = state.data!.queues;
  const done = queues.done;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 h-14 shrink-0">
        <LayoutGrid className="size-4 text-muted-foreground" />
        <h1 className="font-sans text-base font-semibold">Board</h1>
        <span className="font-mono text-xs text-muted-foreground">
          {COLUMNS.reduce((n, s) => n + queues[s].length, 0)} open
        </span>
      </header>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((s) => {
              const meta = QUEUE_META[s];
              const tasks = queues[s];
              return (
                <section key={s} className="flex flex-col rounded-lg border border-border bg-muted/40">
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
                    <Dot tone={meta.tone} pulse={s === "active" && tasks.length > 0} />
                    <span
                      className="font-mono text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: meta.tone === "idle" ? "var(--muted-foreground)" : `var(--color-${meta.tone})` }}
                    >
                      {meta.label}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">{tasks.length}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{meta.hint}</span>
                  </div>
                  <div className="flex flex-col gap-2 p-2 min-h-24">
                    {tasks.length > 0 ? (
                      tasks.map((t) => <TaskCard key={t.id} task={t} state={s} />)
                    ) : (
                      <p className="px-2 py-6 text-center text-xs text-muted-foreground">Empty</p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          {/* Done — collapsed by default (AO pattern) */}
          <div className="mt-3">
            <button
              onClick={() => setDoneOpen((o) => !o)}
              className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left hover:border-border"
            >
              <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", doneOpen && "rotate-90")} />
              <Dot tone="clean" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-clean">
                Done
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{done.length}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">Committed &amp; merged</span>
            </button>
            {doneOpen &&
              (done.length > 0 ? (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {done.map((t) => (
                    <TaskCard key={t.id} task={t} state="done" />
                  ))}
                </div>
              ) : (
                <EmptyState icon={LayoutGrid} title="Nothing merged yet" className="py-8" />
              ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
