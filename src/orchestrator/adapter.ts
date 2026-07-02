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
