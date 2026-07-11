import { getRouteApi } from "@tanstack/react-router";
import { useMemo } from "react";
import { ListTree } from "lucide-react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Dot } from "@/components/ui/Dot";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/Feedback";
import { useCiEvents, useCiStatus, useCiCapability } from "@/lib/queries";
import type { CiEventFrame } from "@/lib/api";

const route = getRouteApi("/p/$projectId/ci/$taskId");

type RunPhase = "running" | "passed" | "failed";
interface StepRow {
  step: string;
  index: number;
  status: RunPhase;
  durationMs?: number;
}
interface JobGroup {
  job: string;
  steps: StepRow[];
  status: RunPhase;
}

function norm(s: string): "passed" | "failed" {
  return /^(passed|success|succeeded)$/i.test(s) ? "passed" : "failed";
}

/** Folds the flat SSE event stream into a workflow -> job -> step tree. Events
 *  replay in order on connect (persisted history) then continue live, so a
 *  simple left-fold over the accumulated array (recomputed via useMemo on
 *  every new frame) is enough — no incremental reducer state needed. */
function reduceTree(events: CiEventFrame[]): { jobs: JobGroup[]; runStatus: RunPhase } {
  const jobs = new Map<string, JobGroup>();
  let runStatus: RunPhase = "running";
  const ensureJob = (job: string): JobGroup => {
    let g = jobs.get(job);
    if (!g) {
      g = { job, steps: [], status: "running" };
      jobs.set(job, g);
    }
    return g;
  };
  for (const e of events) {
    if (e.kind === "job-start") ensureJob(e.job);
    else if (e.kind === "step-start") {
      const g = ensureJob(e.job);
      if (!g.steps.some((s) => s.index === e.index)) {
        g.steps.push({ step: e.step, index: e.index, status: "running" });
      }
    } else if (e.kind === "step-finish") {
      const g = ensureJob(e.job);
      const row = g.steps.find((s) => s.index === e.index);
      const status = norm(e.status);
      if (row) {
        row.status = status;
        if (e.durationMs !== undefined) row.durationMs = e.durationMs;
      } else {
        g.steps.push({
          step: e.step,
          index: e.index,
          status,
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        });
      }
    } else if (e.kind === "job-finish") {
      ensureJob(e.job).status = norm(e.status);
    } else if (e.kind === "run-finish") {
      runStatus = norm(e.status);
    }
  }
  for (const g of jobs.values()) g.steps.sort((a, b) => a.index - b.index);
  return { jobs: [...jobs.values()], runStatus };
}

function StatusGlyph({ status }: { status: RunPhase }) {
  if (status === "running") return <Spinner className="size-3.5 text-[var(--color-working)]" />;
  return <Dot tone={status === "passed" ? "clean" : "broken"} />;
}

export function CiRunView() {
  const { projectId, taskId } = route.useParams();
  const events = useCiEvents(projectId, taskId);
  const status = useCiStatus(projectId, taskId);
  const capability = useCiCapability(projectId);
  const { jobs, runStatus } = useMemo(() => reduceTree(events), [events]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="font-sans text-xl font-semibold text-foreground">CI run</h1>
        <Badge variant="secondary" className="font-mono text-[11px]">
          {taskId}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusGlyph status={runStatus} />
          <span className="font-mono text-[12px] text-muted-foreground">{runStatus}</span>
        </div>
      </div>

      {capability.data && capability.data.mode === "unavailable" && (
        <div className="mb-4 rounded-md border border-[color-mix(in_srgb,var(--color-uncertain)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-uncertain)_8%,transparent)] px-3 py-2">
          <p className="font-mono text-[11px] text-uncertain">{capability.data.detail}</p>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState icon={ListTree} title="No CI events yet" description="Waiting for the agent-ci replay to start…" />
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.map((g) => (
            <Card key={g.job}>
              <Collapsible defaultOpen>
                <CollapsibleTrigger className="w-full text-left">
                  <CardHeader className="flex items-center gap-2">
                    <StatusGlyph status={g.status} />
                    <span className="font-mono text-[13px] text-foreground">{g.job}</span>
                    <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
                      {g.steps.filter((s) => s.status !== "running").length}/{g.steps.length}
                    </Badge>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardBody className="flex flex-col gap-1">
                    {g.steps.map((s) => (
                      <div key={s.index} className="flex items-center gap-2 py-0.5">
                        <StatusGlyph status={s.status} />
                        <span className="font-mono text-[12px] text-foreground">{s.step}</span>
                        {s.durationMs !== undefined && (
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {(s.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    ))}
                  </CardBody>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          {runStatus === "passed"
            ? "agent_ci_green ✓ → gate COMMIT unaffected"
            : runStatus === "failed"
              ? `agent_ci_green ✗ → gate RETRY${status.data?.failedSteps[0] ? ` (failed: ${status.data.failedSteps.join(", ")})` : ""}`
              : "CI replay in progress…"}
        </p>
      </div>
    </div>
  );
}
