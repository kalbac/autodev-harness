/**
 * Typed view of one line of agent-ci's `--json` NDJSON stream.
 * Real shape (verified against @redwoodjs/agent-ci@0.16.2, s37 live-prove): every line
 * is keyed by `event` (NOT `type`); the terminal line is
 * `{"event":"run.finish","status":"passed"|"failed"}`. See gotcha
 * [gate/agent-ci-ndjson-keyed-by-event-not-type].
 */
export type AgentCiEvent =
  | { kind: "run-start"; runId?: string }
  | { kind: "job-start"; job: string; runner?: string; workflow?: string }
  | { kind: "step-start"; job: string; step: string; index: number }
  | { kind: "step-finish"; job: string; step: string; index: number; status: string; durationMs?: number }
  | { kind: "job-finish"; job: string; status: string; durationMs?: number }
  | { kind: "run-finish"; status: string }
  | { kind: "other" };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Parse one raw stdout line into a typed event. Non-JSON / unrecognized -> { kind: "other" }. */
export function parseAgentCiEvent(line: string): AgentCiEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "other" };
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "other" };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }

  const kind = str(obj["event"]) ?? str(obj["type"]); // real key = `event`; `type` a defensive fallback
  const job = str(obj["job"]);
  const step = str(obj["step"]);
  const index = num(obj["index"]) ?? 0;
  const status = str(obj["status"]) ?? "";
  const durationMs = num(obj["durationMs"]);

  switch (kind) {
    case "run.start": {
      const runId = str(obj["runId"]);
      return { kind: "run-start", ...(runId !== undefined ? { runId } : {}) };
    }
    case "job.start": {
      const runner = str(obj["runner"]);
      const workflow = str(obj["workflow"]);
      return {
        kind: "job-start",
        job: job ?? "",
        ...(runner !== undefined ? { runner } : {}),
        ...(workflow !== undefined ? { workflow } : {}),
      };
    }
    case "step.start":
      return { kind: "step-start", job: job ?? "", step: step ?? "", index };
    case "step.finish":
      return { kind: "step-finish", job: job ?? "", step: step ?? "", index, status, ...(durationMs !== undefined ? { durationMs } : {}) };
    case "job.finish":
      return { kind: "job-finish", job: job ?? "", status, ...(durationMs !== undefined ? { durationMs } : {}) };
    case "run.finish":
      return { kind: "run-finish", status };
    default:
      return { kind: "other" };
  }
}

function isPassed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "passed" || s === "success" || s === "succeeded";
}
function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "failure" || s === "error";
}

export interface WorkflowVerdict {
  outcome: "passed" | "failed" | "infra";
  failedSteps: string[];
}

/**
 * Derive the per-workflow verdict from accumulated events. Fail-closed:
 * no terminal run-finish -> "infra" (throw upstream); LAST run-finish wins;
 * a run-finish whose status is neither pass nor fail reads as "failed" (never pass).
 */
export function deriveWorkflowVerdict(events: AgentCiEvent[]): WorkflowVerdict {
  let terminal: "passed" | "failed" | null = null;
  const failedSteps: string[] = [];
  for (const e of events) {
    if (e.kind === "run-finish") {
      terminal = isPassed(e.status) ? "passed" : "failed";
    } else if (e.kind === "step-finish" && isFailed(e.status)) {
      failedSteps.push(e.step);
    }
  }
  if (terminal === null) return { outcome: "infra", failedSteps: [] };
  return { outcome: terminal, failedSteps: terminal === "failed" ? failedSteps : [] };
}
