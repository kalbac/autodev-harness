import { useState } from "react";
import { FileText } from "lucide-react";
import type { QueueState } from "@/lib/api";
import { useEscalation, useRuntimeFile, useRuntimeFiles } from "@/lib/queries";
import { toneVar, verdictTone } from "@/lib/status";
import { TabBar, type TabDef } from "./ui/Tabs";
import { VerdictSeal } from "./ui/VerdictSeal";
import { RuntimeFileView } from "./RuntimeFileView";
import { EmptyState, Loading } from "./ui/Feedback";

type Verdict = "clean" | "broken" | "uncertain" | null;

const TABS: TabDef[] = [
  { id: "verdict", label: "Verdict" },
  { id: "diff", label: "Diff" },
  { id: "report", label: "Report" },
  { id: "files", label: "Files" },
];

/** The per-task inspector rail. Verdict leads — the critic's judgment is the
 *  first thing the operator sees on any task. */
export function Inspector({
  projectId,
  taskId,
  state,
}: {
  projectId: string;
  taskId: string;
  state: QueueState;
}) {
  const [tab, setTab] = useState("verdict");
  const files = useRuntimeFiles(projectId, taskId);
  const names = files.data ?? [];

  const verdictAccent =
    state === "done"
      ? toneVar.clean
      : state === "quarantine"
        ? toneVar.broken
        : state === "escalated"
          ? toneVar.uncertain
          : undefined;

  const tabs = TABS.map((t) =>
    t.id === "verdict" && verdictAccent ? { ...t, accent: verdictAccent } : t,
  );

  return (
    <div className="flex h-full flex-col">
      <TabBar tabs={tabs} value={tab} onChange={setTab} className="px-2 shrink-0" />
      <div className="flex-1 overflow-auto p-4">
        {tab === "verdict" && <VerdictTab projectId={projectId} taskId={taskId} state={state} names={names} />}
        {tab === "diff" &&
          (names.includes("diff.patch") ? (
            <RuntimeFileView projectId={projectId} taskId={taskId} name="diff.patch" />
          ) : (
            <EmptyState icon={FileText} title="No diff yet" description="The worker hasn't produced a diff for this task." />
          ))}
        {tab === "report" &&
          (names.includes("worker-report.md") ? (
            <RuntimeFileView projectId={projectId} taskId={taskId} name="worker-report.md" />
          ) : (
            <EmptyState icon={FileText} title="No worker report" />
          ))}
        {tab === "files" && <FilesTab projectId={projectId} taskId={taskId} names={names} loading={files.isLoading} />}
      </div>
    </div>
  );
}

function VerdictTab({
  projectId,
  taskId,
  state,
  names,
}: {
  projectId: string;
  taskId: string;
  state: QueueState;
  names: string[];
}) {
  const escalated = state === "escalated";
  const esc = useEscalation(projectId, taskId, escalated);
  const hasFeedback = names.includes("critic-feedback.md");
  const feedback = useRuntimeFile(projectId, taskId, hasFeedback ? "critic-feedback.md" : null);

  const verdict: Verdict =
    state === "done"
      ? "clean"
      : state === "quarantine"
        ? "broken"
        : escalated
          ? esc.data?.type === "disagreement"
            ? "broken"
            : "uncertain"
          : null;

  if (verdict === null) {
    return (
      <EmptyState
        icon={FileText}
        title="No verdict yet"
        description="This task is still queued or being worked — the critic hasn't ruled."
      />
    );
  }

  if (escalated && esc.isLoading) return <Loading />;

  const notes =
    (escalated ? esc.data?.evidence : undefined) ??
    (hasFeedback ? feedback.data?.text : undefined) ??
    (state === "done" ? "Critic returned clean; committed & merged." : undefined);

  return (
    <div className="flex flex-col gap-4">
      <VerdictSeal verdict={verdict} notes={notes} />
      {escalated && (
        <p className="rounded-md border border-line bg-panel/40 px-3 py-2 text-xs text-subtle">
          The gate refused to merge this. Resolve it with the A/B decision on the left.
        </p>
      )}
    </div>
  );
}

function FilesTab({
  projectId,
  taskId,
  names,
  loading,
}: {
  projectId: string;
  taskId: string;
  names: string[];
  loading: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  if (loading) return <Loading />;
  if (names.length === 0) {
    return <EmptyState icon={FileText} title="No runtime files" description="This task has produced no artifacts yet." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => (
          <button
            key={n}
            onClick={() => setSelected(n)}
            className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
              selected === n
                ? "border-line-strong bg-surface-2 text-text"
                : "border-line text-muted hover:text-text"
            }`}
            style={selected === n ? { color: toneVar[verdictTone("clean")] } : undefined}
          >
            {n}
          </button>
        ))}
      </div>
      <RuntimeFileView projectId={projectId} taskId={taskId} name={selected} />
    </div>
  );
}
