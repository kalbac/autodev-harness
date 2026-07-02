import { useMemo } from "react";
import { QUEUE_STATES, type QueueState, type Task } from "./api";
import { useState as useHarnessState } from "./queries";

export interface LocatedTask {
  task: Task;
  state: QueueState;
}

/** Index every task from /state by id → {task, state}. The blackboard is the
 *  single source of truth; a task's queue IS its lifecycle status. */
export function useTaskIndex() {
  const state = useHarnessState();
  const index = useMemo(() => {
    const map = new Map<string, LocatedTask>();
    const queues = state.data?.queues;
    if (queues) {
      for (const s of QUEUE_STATES) {
        for (const task of queues[s]) map.set(task.id, { task, state: s });
      }
    }
    return map;
  }, [state.data]);

  return { index, isLoading: state.isLoading, isError: state.isError, error: state.error };
}
