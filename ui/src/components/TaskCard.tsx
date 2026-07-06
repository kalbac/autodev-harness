import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import type { QueueState, Task } from "@/lib/api";
import { QUEUE_META, isGuarded } from "@/lib/status";
import { useProjectId } from "@/lib/useProjectId";
import { Card, CardBody } from "./ui/Card";
import { StatusPill } from "./ui/StatusPill";

export function TaskCard({ task, state }: { task: Task; state: QueueState }) {
  const meta = QUEUE_META[state];
  const guarded = isGuarded(task);
  // TaskCard only renders inside project routes (board/run), so projectId is set.
  const projectId = useProjectId() ?? "";

  return (
    <Link
      to="/p/$projectId/tasks/$taskId"
      params={{ projectId, taskId: task.id }}
      className="group block"
    >
      <Card className="p-0 transition-colors hover:border-border">
        <CardBody className="px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <StatusPill tone={meta.tone} label={meta.label} pulse={state === "active"} />
            {guarded && (
              <span
                className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-uncertain"
                title="Touches a contract zone or writes a guard — the critic will scrutinize this"
              >
                <ShieldAlert className="size-3" />
                zone
              </span>
            )}
          </div>

          <div className="text-[13px] font-medium leading-snug text-foreground line-clamp-2 group-hover:text-white">
            {task.title}
          </div>

          <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span className="truncate">{task.id}</span>
            <span className="ml-auto flex items-center gap-2 shrink-0">
              <span className="rounded border border-border px-1 py-0.5 text-muted-foreground">{task.type}</span>
              {task.model && <span className="text-muted-foreground">{task.model}</span>}
            </span>
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}
