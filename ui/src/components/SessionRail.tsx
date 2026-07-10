import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, CheckSquare, PanelRight, Square, X } from "lucide-react";
import { Spinner } from "./ui/spinner";
import { useCiStatus, useConfig, useRuns, useSessionUsage, useState as useProjectState } from "@/lib/queries";
import { useTaskIndex } from "@/lib/useTaskIndex";
import { useMediaQuery } from "@/lib/use-media-query";
import { toneVar } from "@/lib/status";
import type { QueueState } from "@/lib/api";
import { Dot } from "./ui/Dot";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "@/lib/utils";

// The session rail hides below this width on narrow desktops; a floating toggle
// then re-opens it as an overlay (see SessionRailZone). At/above it, the rail is
// an inline shell column. 70rem = 1120px.
const RAIL_INLINE = "(min-width: 70rem)";

/** Compact token count: 12345 -> "12.3k", 2_100_000 -> "2.1M", <1000 -> as-is. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * The per-SESSION inspector rail (s16 mockup `.rail`) — a sibling of `main` at
 * the shell level. Five blocks: Now (pipeline), Queue (counters), Session
 * (facts), Roles (real config), Tokens (cross-run token totals). Distinct from
 * the per-TASK `Inspector.tsx`. Every value degrades to "—" while data loads.
 *
 * Step granularity in "Now" is INFERRED from queue state — there is no live
 * per-step feed. An active task means the worker is running; gate → critic →
 * commit are shown as upcoming, decompose as done.
 */
export function SessionRail({ projectId, onClose }: { projectId: string; onClose?: () => void }) {
  const state = useProjectState(projectId);
  const config = useConfig(projectId);
  // Token totals across runs, from the server-side per-run aggregate
  // (GET /runs/:id/usage): this run (newest) / today / all-time. Token only.
  const usage = useSessionUsage(projectId);
  // Plan checklist: the newest run is "this plan" (same convention as
  // useSessionUsage's thisRun = runs[0]); resolve its ordered taskIds to live
  // queue status via the shared task index. Both auto-refresh on the root WS.
  const runs = useRuns(projectId);
  const { index } = useTaskIndex(projectId);
  const plan = runs.data?.[0];
  const planTaskIds = plan?.taskIds ?? [];
  const planDone = planTaskIds.reduce(
    (n, id) => (index.get(id)?.state === "done" ? n + 1 : n),
    0,
  );

  const queues = state.data?.queues;
  const activeTask = queues?.active[0];

  const cfg = config.data;
  const dash = "—";

  // CI block (Task 10) — shown only when the project opted into agent-ci; the
  // status query is scoped to the active task (no active task -> disabled).
  const ciEnabled = cfg?.gate?.agentCi?.enabled === true;
  const activeTaskId = activeTask?.id ?? "";
  const ciStatus = useCiStatus(projectId, ciEnabled ? activeTaskId : "");

  const roleWorker = cfg
    ? `${cfg.roles.worker.adapter} · ${cfg.roles.worker.ladder[0] ?? dash}${
        cfg.roles.worker.ladder.length > 1 ? ` +${cfg.roles.worker.ladder.length - 1}` : ""
      }`
    : dash;
  const roleCritic = cfg
    ? `${cfg.roles.critic.adapter} · ${cfg.roles.critic.model}${
        cfg.roles.critic.effort ? ` ${cfg.roles.critic.effort}` : ""
      }`
    : dash;
  const roleOrch = cfg
    ? `${cfg.roles.orchestrator.adapter} · ${cfg.roles.orchestrator.model}`
    : dash;

  const provision = cfg
    ? cfg.worktree.provision.length > 0
      ? cfg.worktree.provision.join(", ")
      : dash
    : dash;

  return (
    <aside className="h-full w-[300px] shrink-0 border-l border-border">
      <ScrollArea className="h-full">
        <div className="p-3.5">
          <div className="mb-2.5 flex items-center">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Session inspector
            </h3>
            {onClose && (
              <button
                onClick={onClose}
                aria-label="Hide session inspector"
                className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Now — pipeline inferred from queue state */}
          <Block title="Now">
            <div className="flex flex-col gap-1.5">
              {activeTask ? (
                <>
                  <Step state="done" label="decompose" />
                  <Step state="now" label={`${activeTask.id} worker`} />
                  <Step
                    state="idle"
                    label={`${activeTask.id} gate${
                      ciEnabled && ciStatus.data && ciStatus.data.phase === "running"
                        ? ` (CI ${ciStatus.data.steps.done}/${ciStatus.data.steps.total || "?"})`
                        : ""
                    } → critic → commit`}
                  />
                </>
              ) : (
                <Step state="idle" label="no active run" />
              )}
            </div>
          </Block>

          {/* CI — rolling agent-ci summary for the active task; only shown when
              the project opted into gate.agentCi. Links out to the dedicated CI
              screen (Task 11). */}
          {ciEnabled && (
            <Block
              title="CI"
              badge={
                ciStatus.data ? (
                  <Badge
                    variant="secondary"
                    className="ml-auto h-auto rounded-full px-1.5 py-0 font-mono text-[10px] normal-case tracking-normal text-muted-foreground"
                  >
                    {ciStatus.data.steps.done}/{ciStatus.data.steps.total || "?"}
                  </Badge>
                ) : undefined
              }
            >
              {ciStatus.data ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <Dot
                      tone={
                        ciStatus.data.phase === "passed"
                          ? "clean"
                          : ciStatus.data.phase === "failed"
                            ? "broken"
                            : "working"
                      }
                      pulse={ciStatus.data.phase === "running"}
                    />
                    <span className="font-mono text-[11px] text-foreground">
                      {ciStatus.data.phase === "running"
                        ? "running"
                        : ciStatus.data.phase === "passed"
                          ? "passed"
                          : "failed"}
                      {ciStatus.data.phase === "failed" && ciStatus.data.failedSteps[0]
                        ? ` (step "${ciStatus.data.failedSteps[0]}")`
                        : ""}
                    </span>
                  </div>
                  <Kv k="workflow" v={ciStatus.data.workflow ?? dash} />
                  {/* TODO Task 11: switch to typed <Link to="/p/$projectId/ci/$taskId">
                      once that route is registered — plain anchor keeps typecheck green now. */}
                  <a
                    href={`/p/${projectId}/ci/${activeTaskId}`}
                    className="font-mono text-[11px] text-accent hover:underline"
                  >
                    open CI run →
                  </a>
                </div>
              ) : (
                <Step state="idle" label="no CI run yet" />
              )}
            </Block>
          )}

          {/* Plan — the newest run's ordered tasks as a live status checklist */}
          <Block
            title="Plan"
            badge={
              planTaskIds.length > 0 ? (
                <Badge
                  variant="secondary"
                  className="ml-auto h-auto rounded-full px-1.5 py-0 font-mono text-[10px] normal-case tracking-normal text-muted-foreground"
                >
                  {planDone}/{planTaskIds.length}
                </Badge>
              ) : undefined
            }
          >
            {planTaskIds.length === 0 ? (
              <div className="font-mono text-[11px] text-muted-foreground">no plan yet</div>
            ) : (
              <>
                {plan && (
                  <div className="mb-2 truncate text-[11px] text-muted-foreground" title={plan.name ?? plan.intent}>
                    {plan.name ?? plan.intent}
                  </div>
                )}
                <ol className="flex flex-col gap-1.5">
                  {planTaskIds.map((id) => {
                    const located = index.get(id);
                    return (
                      <PlanRow
                        key={id}
                        state={located?.state}
                        label={located?.task.title ?? id}
                        resolved={located !== undefined}
                      />
                    );
                  })}
                </ol>
              </>
            )}
          </Block>

          {/* Queue — counters from the live blackboard */}
          <Block title="Queue">
            <div className="flex gap-1.5">
              <QCell n={queues?.pending.length} label="pending" />
              <QCell n={queues?.active.length} label="active" />
              <QCell n={queues?.escalated.length} label="escalated" att />
              <QCell n={queues?.done.length} label="done" />
            </div>
          </Block>

          {/* Session — facts from config */}
          <Block title="Session">
            <Kv k="branch" v={cfg?.allowedBranchPattern ?? dash} />
            <Kv k="gate" v={cfg ? (cfg.gate.checkCommand ?? dash) : dash} />
            <Kv k="worktree" v={cfg ? `${cfg.stateDir}/worktrees` : dash} />
            <Kv k="provision" v={provision} />
          </Block>

          {/* Roles — REAL data from the config endpoint */}
          <Block title="Roles">
            <Kv k="orchestrator" v={roleOrch} />
            <Kv k="worker" v={roleWorker} />
            <Kv k="critic" v={roleCritic} />
          </Block>

          {/* Tokens — cross-run totals via the server-side per-run aggregate (s25) */}
          <Block title="Tokens">
            <Kv k="this run" v={usage.data?.thisRun.any ? formatTokens(usage.data.thisRun.tokens) : dash} />
            <Kv k="today" v={usage.data?.today.any ? formatTokens(usage.data.today.tokens) : dash} />
            <Kv k="all-time" v={usage.data?.allTime.any ? formatTokens(usage.data.allTime.tokens) : dash} />
          </Block>
        </div>
      </ScrollArea>
    </aside>
  );
}

/**
 * Responsive wrapper for the session rail. At/above 1120px the rail is an inline
 * shell column (its normal home). Below it — on a narrow desktop where the fixed
 * 300px rail would starve `main` — the rail is hidden behind a floating toggle
 * and re-opens as a right-edge overlay with a scrim. Going wide again drops any
 * open overlay back to the inline column.
 */
export function SessionRailZone({ projectId }: { projectId: string }) {
  const inline = useMediaQuery(RAIL_INLINE);
  const [peek, setPeek] = useState(false);

  useEffect(() => {
    if (inline) setPeek(false);
  }, [inline]);

  if (inline) return <SessionRail projectId={projectId} />;

  if (!peek) {
    return (
      <button
        onClick={() => setPeek(true)}
        aria-label="Show session inspector"
        className="fixed bottom-4 right-4 z-30 grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:text-foreground"
      >
        <PanelRight className="size-4" />
      </button>
    );
  }

  return (
    <>
      <div
        aria-hidden
        onClick={() => setPeek(false)}
        className="fixed inset-0 z-30 bg-black/40"
      />
      <div className="fixed inset-y-0 right-0 z-40 bg-background shadow-xl">
        <SessionRail projectId={projectId} onClose={() => setPeek(false)} />
      </div>
    </>
  );
}

function Block({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      <div className="mb-2 flex items-center font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {title}
        {badge}
      </div>
      {children}
    </div>
  );
}

/**
 * One checklist row: a status glyph + the task title (truncated, native tooltip).
 * Each of the 5 queue states gets a DISTINCT icon SHAPE (not just a tone) so
 * active vs escalated read apart at a glance: done → checked box, pending → empty
 * box, active → spinner, escalated → warning triangle, quarantine → ban.
 * An unresolved id (not in any queue) degrades to a muted idle dot.
 */
function PlanRow({ state, label, resolved }: { state?: QueueState; label: string; resolved: boolean }) {
  const done = state === "done";
  const dimmed = !resolved || state === "pending";
  return (
    <li className="flex items-center gap-2 font-mono text-[11px]">
      <span className="grid size-3.5 shrink-0 place-items-center">
        <PlanGlyph state={state} resolved={resolved} />
      </span>
      <span
        className={cn("truncate", done ? "text-muted-foreground" : dimmed ? "text-muted-foreground" : "text-foreground")}
        title={label}
      >
        {label}
      </span>
    </li>
  );
}

/** Distinct icon per queue state, tinted by its `QUEUE_META` tone (via `toneVar`
 *  inline color). Shape carries the meaning so tone-adjacent states (active
 *  `working` vs escalated `uncertain`) never blur together. */
function PlanGlyph({ state, resolved }: { state?: QueueState; resolved: boolean }) {
  if (!resolved || state === undefined) return <Dot tone="idle" className="size-[7px]" />;
  if (state === "done") return <CheckSquare className="size-3.5" strokeWidth={2.5} style={{ color: toneVar.clean }} />;
  if (state === "active")
    return <Spinner className="size-3.5" strokeWidth={2.5} style={{ color: toneVar.working }} />;
  if (state === "escalated")
    return <AlertTriangle className="size-3.5" strokeWidth={2.5} style={{ color: toneVar.uncertain }} />;
  if (state === "quarantine") return <Ban className="size-3.5" strokeWidth={2.5} style={{ color: toneVar.broken }} />;
  return <Square className="size-3 text-muted-foreground" strokeWidth={2} />; // pending — empty checkbox
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2.5 py-[3px] text-[12px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="break-all text-right font-mono text-[11px]" title={v}>
        {v}
      </span>
    </div>
  );
}

function Step({ state, label }: { state: "done" | "now" | "idle"; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 font-mono text-[11px]",
        state === "idle" ? "text-muted-foreground" : state === "done" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {state === "idle" ? (
        <span className="size-2 shrink-0 rounded-full bg-border" />
      ) : (
        <Dot tone={state === "done" ? "clean" : "working"} pulse={state === "now"} className="size-2" />
      )}
      {label}
    </div>
  );
}

function QCell({ n, label, att = false }: { n?: number; label: string; att?: boolean }) {
  const flagged = att && (n ?? 0) > 0;
  return (
    <div
      className={cn(
        "flex-1 rounded-lg border py-1.5 text-center",
        flagged ? "border-[color-mix(in_srgb,var(--color-uncertain)_45%,transparent)]" : "border-border",
      )}
    >
      <div className={cn("font-sans text-base font-semibold", flagged ? "text-uncertain" : "text-foreground")}>
        {n ?? "—"}
      </div>
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
    </div>
  );
}
