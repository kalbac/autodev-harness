/**
 * File-set lock scheduler — parity: `scheduler.ps1`. Pure set-intersection +
 * task-queue moves; there is no LLM and no judgment call here. A pending
 * task is claimable iff every id in its `depends_on` already has a matching
 * task in `done/`, AND its `file_set` is disjoint from the `file_set` of
 * every task currently in `active/` OR `escalated/` (an escalated task
 * still holds its files and blocks intersecting pending tasks exactly like
 * an active one does).
 */
import type { BlackboardRepository } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";

export interface ClaimableReportEntry {
  id: string;
  claimable: boolean;
  blocked_by: string;
}

export interface Scheduler {
  /**
   * Atomically claims the first claimable pending task in id order, moving
   * it pending -> active. Returns `null` if nothing is claimable. If the
   * underlying `moveTask` throws for a task this scheduler judged claimable
   * (another process already won the race), that loss is swallowed and the
   * scan continues with the next pending task -- it is never surfaced as an
   * error.
   */
  claimNextTask(): Promise<Task | null>;
  /** Dry-run report over every pending task; moves nothing. */
  listClaimable(): Promise<ClaimableReportEntry[]>;
}

/** Normalizes a path for set-membership comparison: `\` -> `/`, then strips leading `.`/`/` runs. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^[./]+/, "");
}

/** Port of `Test-FileSetsDisjoint`: true iff `a` and `b` share no normalized path. */
export function fileSetsDisjoint(a: string[], b: string[]): boolean {
  const normalizedA = new Set(a.map(normalizePath));
  return !b.some((p) => normalizedA.has(normalizePath(p)));
}

export function createScheduler(repo: BlackboardRepository): Scheduler {
  async function loadLocksAndDeps(): Promise<{
    pending: Task[];
    active: Task[];
    escalated: Task[];
    doneIds: Set<string>;
  }> {
    const [pending, active, escalated, done] = await Promise.all([
      repo.listTasks("pending"),
      repo.listTasks("active"),
      repo.listTasks("escalated"),
      repo.listTasks("done"),
    ]);
    return { pending, active, escalated, doneIds: new Set(done.map((t) => t.id)) };
  }

  async function claimNextTask(): Promise<Task | null> {
    const { pending, active, escalated, doneIds } = await loadLocksAndDeps();
    const locked = [...active, ...escalated];

    for (const task of pending) {
      const depsMet = task.depends_on.every((id) => doneIds.has(id));
      if (!depsMet) continue;

      const disjoint = locked.every((other) => fileSetsDisjoint(task.file_set, other.file_set));
      if (!disjoint) continue;

      try {
        await repo.moveTask(task.id, "pending", "active");
      } catch {
        // Lost the race to another claimer -- silently move on, not an error.
        continue;
      }
      return task;
    }

    return null;
  }

  async function listClaimable(): Promise<ClaimableReportEntry[]> {
    const { pending, active, escalated, doneIds } = await loadLocksAndDeps();

    return pending.map((task): ClaimableReportEntry => {
      const blockedBy: string[] = [];
      let fileConflict = false;

      for (const other of active) {
        if (!fileSetsDisjoint(task.file_set, other.file_set)) {
          blockedBy.push(`active:${other.id}`);
          fileConflict = true;
        }
      }
      for (const other of escalated) {
        if (!fileSetsDisjoint(task.file_set, other.file_set)) {
          blockedBy.push(`escalated:${other.id}`);
          fileConflict = true;
        }
      }

      let depsMet = true;
      for (const depId of task.depends_on) {
        if (!doneIds.has(depId)) {
          blockedBy.push(`dep:${depId}`);
          depsMet = false;
        }
      }

      return { id: task.id, claimable: depsMet && !fileConflict, blocked_by: blockedBy.join(",") };
    });
  }

  return { claimNextTask, listClaimable };
}
