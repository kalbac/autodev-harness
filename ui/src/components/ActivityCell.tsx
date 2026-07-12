import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ActivityKind, ActivityStatus, ThreadEntry } from "@/lib/api";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusPill } from "@/components/ui/StatusPill";

type ActivityEntry = Extract<ThreadEntry, { type: "activity" }>;

/** Activity status -> the app's shared tone vocabulary (`lib/status` `Tone`) --
 *  same language StatusPill/Dot speak everywhere else on the board/rail, so a
 *  thread's machine activity reads consistently with the rest of the UI:
 *  running -> working (amber, pulsing), ok -> clean (green), warn -> uncertain
 *  (amber/yellow), error -> broken (red). */
const STATUS_TONE: Record<ActivityStatus, Tone> = {
  running: "working",
  ok: "clean",
  warn: "uncertain",
  error: "broken",
};

/**
 * One compact machine-activity row inside the thread transcript -- a status
 * pill + kind + one-line summary, collapsed by default; expands to the raw
 * ref ids. Deep-links out to the CI/task/run screen for this activity's kind
 * when the entry's `ref` carries the id that route needs; otherwise renders
 * with no link (never a dead link).
 */
export function ActivityCell({ projectId, entry }: { projectId: string; entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const { kind, ref, summary, status } = entry;
  const tone = STATUS_TONE[status];

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-fit max-w-full rounded-lg border border-border bg-muted px-2.5 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <StatusPill tone={tone} label={status} pulse={status === "running"} />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {kind}
          </span>
          <span className="truncate text-[13px] text-foreground" title={summary}>
            {summary}
          </span>
        </CollapsibleTrigger>
        <ActivityDeepLink projectId={projectId} kind={kind} ref={ref} />
      </div>

      <CollapsibleContent>
        <div className="mt-1.5 flex flex-col gap-0.5 pl-5 font-mono text-[10px] text-muted-foreground">
          {ref.taskId && <div>taskId: {ref.taskId}</div>}
          {ref.runId && <div>runId: {ref.runId}</div>}
          {!ref.taskId && !ref.runId && <div>no reference id</div>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const linkClassName = "shrink-0 font-mono text-[11px] text-primary hover:underline";

/** Renders the ONE deep-link this activity kind supports, when its ref carries
 *  the needed id -- `agent_ci`/`gate` -> the CI screen, `worker`/`escalation`/
 *  `merge`/`critic` -> the task screen, `run` -> the run screen. Each branch
 *  uses a literal `to=` route string (TanStack Router's typed routing needs
 *  the literal, not a variable, to narrow `params`). */
function ActivityDeepLink({
  projectId,
  kind,
  ref,
}: {
  projectId: string;
  kind: ActivityKind;
  ref: { taskId?: string; runId?: string };
}) {
  if ((kind === "agent_ci" || kind === "gate") && ref.taskId) {
    return (
      <Link to="/p/$projectId/ci/$taskId" params={{ projectId, taskId: ref.taskId }} className={linkClassName}>
        open →
      </Link>
    );
  }
  if ((kind === "worker" || kind === "escalation" || kind === "merge" || kind === "critic") && ref.taskId) {
    return (
      <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: ref.taskId }} className={linkClassName}>
        open →
      </Link>
    );
  }
  if (kind === "run" && ref.runId) {
    return (
      <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: ref.runId }} className={linkClassName}>
        open →
      </Link>
    );
  }
  return null;
}
