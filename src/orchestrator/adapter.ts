import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { TaskSpec } from "./task-spec.js";

/**
 * Read-only snapshot handed to an `OrchestratorAdapter` so it can author
 * non-colliding ids and be aware of in-flight work across every queue.
 */
export interface ReadSnapshot {
  existingIds: string[];
  queues: Record<QueueState, Task[]>;
}

export interface DecomposeInput {
  intent: string;
  state: ReadSnapshot;
  /**
   * Set ONLY on a retry (#141): the exact failure text the previous attempt was
   * rejected with — an adapter-level parse/validation throw, or the batch
   * validation problems. The adapter feeds it back into the prompt so the model
   * fixes the specific thing that was wrong instead of re-rolling.
   *
   * A malformed decomposition (e.g. an array element arriving as a bare string)
   * used to kill a corpus case outright with no retry — and it is INTERMITTENT,
   * which is the one thing a measuring instrument may not be.
   */
  previousFailure?: string;
}

/**
 * MVP orchestrator adapter surface (the R2 planner concept is folded into
 * this single method): turn an operator's freeform intent into concrete
 * `TaskSpec`s. Nothing else — no trigger, no enqueue, no report; those are
 * `OrchestratorCapabilities` concerns (capabilities.ts), never the adapter's.
 */
export interface OrchestratorAdapter {
  decompose(input: DecomposeInput): Promise<TaskSpec[]>;
}
