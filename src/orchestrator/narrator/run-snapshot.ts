import type { RunSnapshot } from "./activity-map.js";

type TaskStatusResult = { status: RunSnapshot["tasks"][number]["status"]; title: string };

/**
 * Minimal read seam `buildRunSnapshot` needs — deliberately narrower than
 * `OrchestratorCapabilities["read"]` so this module stays pure/unit-testable
 * with fakes. The composition root adapts the real blackboard capabilities
 * to this shape (see run-snapshot investigation notes: no single blackboard
 * call already returns "manifest for a runId" or "status+title for a task
 * id" — both must be composed from `recentRuns()` / `queues()`).
 */
export interface RunSnapshotReader {
  readRunManifest: (runId: string) => Promise<{ taskIds: string[] } | null>;
  readTaskStatus: (taskId: string) => Promise<TaskStatusResult | null>;
}

/**
 * Pure orchestration: manifest -> per-task status/title -> RunSnapshot.
 * A missing manifest yields `null` (nothing to narrate yet). A task that
 * can't be resolved is SKIPPED rather than failing the whole snapshot, so a
 * partially-written run (e.g. a manifest recorded before every task file
 * landed) still narrates the tasks that ARE resolvable.
 */
export async function buildRunSnapshot(reader: RunSnapshotReader, runId: string): Promise<RunSnapshot | null> {
  const manifest = await reader.readRunManifest(runId);
  if (!manifest) return null;

  const tasks: RunSnapshot["tasks"] = [];
  for (const taskId of manifest.taskIds) {
    const st = await reader.readTaskStatus(taskId).catch(() => null);
    if (!st) continue;
    tasks.push({ taskId, status: st.status, title: st.title });
  }
  return { runId, tasks };
}
