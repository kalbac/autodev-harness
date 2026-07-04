import type { Task } from "../blackboard/types.js";
import type { WorkerUsage } from "../usage/usage.js";

/**
 * Transport-level outcome of a worker invocation — parity spec §6 line
 * 88-89: this is NOT the task's authoritative status. The conductor
 * separately reads `worker-report.md` (written by the worker itself) to
 * learn TOO_BIG / NEEDS_GUARD / BLOCKED / a plain done-with-a-diff outcome.
 * The adapter only knows whether the underlying process finished, was
 * rate-limited, or timed out.
 */
export type WorkerTransportStatus = "DONE" | "RATE_LIMITED" | "TIMED_OUT";

export interface WorkerResult {
  /** Transport outcome of the last ladder step attempted — NOT the report status. */
  status: WorkerTransportStatus;
  /** The ladder model actually used (last attempted). */
  model: string;
  rateLimited: boolean;
  timedOut: boolean;
  exitCode: number;
  /** Token/usage of the last ladder step attempted, parsed from the worker's
   *  stream-json stdout. Omitted (never explicit `undefined`) when the stdout
   *  carried no parseable usage event — token accounting is best-effort and must
   *  never change the transport outcome. */
  usage?: WorkerUsage;
}

export interface WorkerRunInput {
  task: Task;
  worktreePath: string;
  ladder: string[];
  runtimeDir: string;
  criticFeedback?: string;
}

export interface WorkerAdapter {
  run(input: WorkerRunInput): Promise<WorkerResult>;
}
