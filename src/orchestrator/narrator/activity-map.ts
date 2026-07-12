import type { ActivityKind, ActivityStatus, ThreadEntry } from "../../thread/thread-types.js";

export interface TaskSnapshot {
  taskId: string;
  status: "pending" | "active" | "escalated" | "quarantine" | "done";
  title: string;
}

export interface RunSnapshot {
  runId: string;
  tasks: TaskSnapshot[];
}

export type Milestone =
  | { kind: "run_started"; runId: string }
  | { kind: "task_active"; taskId: string; title: string }
  | { kind: "task_done"; taskId: string; title: string }
  | { kind: "task_escalated"; taskId: string; title: string }
  | { kind: "run_finished"; runId: string };

/** An activity cell = a thread activity entry minus its ts (the store stamps ts). */
export type ActivityCell = Omit<Extract<ThreadEntry, { type: "activity" }>, "ts" | "type">;

function isTerminal(status: TaskSnapshot["status"]): boolean {
  return status === "done" || status === "quarantine";
}

export function diffRunSnapshot(
  prev: RunSnapshot | null,
  next: RunSnapshot,
): { cells: ActivityCell[]; milestones: Milestone[] } {
  const cells: ActivityCell[] = [];
  const milestones: Milestone[] = [];

  if (prev === null) {
    milestones.push({ kind: "run_started", runId: next.runId });
    cells.push({
      kind: "run" as ActivityKind,
      ref: { runId: next.runId },
      summary: "run started",
      status: "running" as ActivityStatus,
    });
    return { cells, milestones };
  }

  const prevStatusByTaskId = new Map(prev.tasks.map((t) => [t.taskId, t.status]));

  for (const task of next.tasks) {
    const prevStatus = prevStatusByTaskId.get(task.taskId) ?? "pending";
    if (prevStatus === task.status) continue;

    if (task.status === "active") {
      cells.push({
        kind: "worker",
        ref: { taskId: task.taskId },
        summary: `worker: ${task.title}`,
        status: "running",
      });
      milestones.push({ kind: "task_active", taskId: task.taskId, title: task.title });
    } else if (task.status === "done") {
      cells.push({
        kind: "merge",
        ref: { taskId: task.taskId },
        summary: `done: ${task.title}`,
        status: "ok",
      });
      milestones.push({ kind: "task_done", taskId: task.taskId, title: task.title });
    } else if (task.status === "escalated") {
      cells.push({
        kind: "escalation",
        ref: { taskId: task.taskId },
        summary: `escalated: ${task.title}`,
        status: "error",
      });
      milestones.push({ kind: "task_escalated", taskId: task.taskId, title: task.title });
    } else if (task.status === "quarantine") {
      cells.push({
        kind: "escalation",
        ref: { taskId: task.taskId },
        summary: `quarantined: ${task.title}`,
        status: "warn",
      });
    }
  }

  const prevAllTerminal = prev.tasks.length > 0 && prev.tasks.every((t) => isTerminal(t.status));
  const nextAllTerminal = next.tasks.length > 0 && next.tasks.every((t) => isTerminal(t.status));
  if (prev.tasks.length > 0 && nextAllTerminal && !prevAllTerminal) {
    milestones.push({ kind: "run_finished", runId: next.runId });
  }

  return { cells, milestones };
}
