import type { ReactNode } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { useRuntimeFiles } from "@/lib/queries";
import { useTaskIndex } from "@/lib/useTaskIndex";
import { QUEUE_META, isGuarded } from "@/lib/status";
import type { QueueState } from "@/lib/api";
import { StatusPill } from "@/components/ui/StatusPill";
import { Dot } from "@/components/ui/Dot";
import { EscalationCard } from "@/components/EscalationCard";
import { Inspector } from "@/components/Inspector";
import { EmptyState, Loading } from "@/components/ui/Feedback";
import { FileQuestion } from "lucide-react";

const route = getRouteApi("/p/$projectId/tasks/$taskId");

export function TaskDetailView() {
  const { projectId, taskId } = route.useParams();
  const { index, isLoading } = useTaskIndex(projectId);

  if (isLoading) return <Loading label="Loading task…" />;

  const located = index.get(taskId);
  if (!located) {
    return (
      <div className="flex h-full flex-col">
        <Header projectId={projectId} taskId={taskId} title={taskId} />
        <EmptyState
          icon={FileQuestion}
          title="Task not in any queue"
          description="It may have been cleaned up, or never materialized. Runtime artifacts (if any) are still readable below."
        />
        <div className="flex-1 border-t border-line overflow-hidden">
          <Inspector projectId={projectId} taskId={taskId} state="done" />
        </div>
      </div>
    );
  }

  const { task, state } = located;
  const meta = QUEUE_META[state];

  return (
    <div className="flex h-full flex-col">
      <Header projectId={projectId} taskId={taskId} title={task.title}>
        <StatusPill tone={meta.tone} label={meta.label} pulse={state === "active"} />
        {isGuarded(task) && (
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-uncertain">
            <ShieldAlert className="size-3" />
            zone
          </span>
        )}
      </Header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left — decision + spec + lifecycle */}
        <div className="flex-1 min-w-0 overflow-auto p-5 space-y-5">
          {state === "escalated" && <EscalationCard projectId={projectId} taskId={taskId} />}
          <Lifecycle projectId={projectId} taskId={taskId} state={state} />
          <TaskSpec
            type={task.type}
            model={task.model}
            body={task.body}
            acceptance={task.acceptance}
            fileSet={task.file_set}
            zones={task.contract_zones_touched}
          />
        </div>

        {/* Right — inspector rail */}
        <div className="w-[420px] shrink-0 border-l border-line overflow-hidden bg-panel/30">
          <Inspector projectId={projectId} taskId={taskId} state={state} />
        </div>
      </div>
    </div>
  );
}

function Header({
  projectId,
  taskId,
  title,
  children,
}: {
  projectId: string;
  taskId: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-b border-line px-6 py-3 shrink-0">
      <Link
        to="/p/$projectId/board"
        params={{ projectId }}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] text-subtle hover:text-muted mb-1.5"
      >
        <ArrowLeft className="size-3" />
        board
      </Link>
      <div className="flex items-center gap-3">
        <h1 className="font-display text-lg font-semibold leading-tight text-text min-w-0 truncate">
          {title}
        </h1>
        <div className="flex items-center gap-2 shrink-0">{children}</div>
      </div>
      <p className="font-mono text-[11px] text-subtle mt-0.5">{taskId}</p>
    </header>
  );
}

const STAGES = ["Worker", "Diff", "Critic", "Gate"] as const;

/** Compact at-a-glance lifecycle derived from runtime artifacts + queue state.
 *  Not authoritative — the blackboard is; this just reads what's on disk. */
function Lifecycle({
  projectId,
  taskId,
  state,
}: {
  projectId: string;
  taskId: string;
  state: QueueState;
}) {
  const files = useRuntimeFiles(projectId, taskId);
  const names = files.data ?? [];

  const done = {
    Worker: names.includes("worker-report.md"),
    Diff: names.includes("diff.patch"),
    Critic: names.includes("critic-feedback.md") || state === "done" || state === "escalated",
    Gate: state === "done" || state === "escalated" || state === "quarantine",
  } as const;

  const tone = (stage: (typeof STAGES)[number]) => {
    if (stage === "Gate") {
      if (state === "done") return "clean" as const;
      if (state === "quarantine") return "broken" as const;
      if (state === "escalated") return "uncertain" as const;
    }
    if (stage === "Critic" && state === "escalated") return "uncertain" as const;
    return done[stage] ? ("clean" as const) : ("idle" as const);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2.5">
      {STAGES.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <Dot tone={tone(s)} pulse={state === "active" && s === "Worker" && !done.Diff} />
          <span
            className={`font-mono text-[11px] ${done[s] || tone(s) !== "idle" ? "text-muted" : "text-subtle"}`}
          >
            {s}
          </span>
          {i < STAGES.length - 1 && <span className="mx-1 text-subtle">→</span>}
        </div>
      ))}
    </div>
  );
}

function TaskSpec({
  type,
  model,
  body,
  acceptance,
  fileSet,
  zones,
}: {
  type: string;
  model: string | null;
  body: string;
  acceptance: string[];
  fileSet: string[];
  zones: string[];
}) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-subtle">Task spec</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-subtle">
          <span className="rounded border border-line px-1 py-0.5 text-muted">{type}</span>
          {model && <span>{model}</span>}
        </span>
      </div>
      <div className="p-4 space-y-4">
        {body.trim().length > 0 && (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-muted leading-relaxed">
            {body.trim()}
          </pre>
        )}

        {acceptance.length > 0 && (
          <Section title="Acceptance">
            <ul className="space-y-1">
              {acceptance.map((a, i) => (
                <li key={i} className="flex gap-2 text-sm text-muted">
                  <span className="text-clean">✓</span>
                  {a}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {fileSet.length > 0 && (
          <Section title="Files">
            <div className="flex flex-wrap gap-1.5">
              {fileSet.map((f) => (
                <span key={f} className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {f}
                </span>
              ))}
            </div>
          </Section>
        )}

        {zones.length > 0 && (
          <Section title="Contract zones">
            <div className="flex flex-wrap gap-1.5">
              {zones.map((z) => (
                <span
                  key={z}
                  className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-uncertain"
                  style={{ borderColor: "color-mix(in srgb, var(--color-uncertain) 30%, transparent)" }}
                >
                  {z}
                </span>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-subtle mb-1.5">{title}</p>
      {children}
    </div>
  );
}
