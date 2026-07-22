import { loadEvidence } from "./evidence-store.js";
import { buildExecutionReport } from "./execution-report.js";
import { renderExecutionReport } from "./render.js";

export interface RunListEntry {
  runId: string;
  intent: string;
  at: number;
  taskIds: string[];
}

export interface ReportServiceDeps {
  listRuns: () => Promise<RunListEntry[]>;
  /** The queue a task currently sits in, or null when it cannot be located. */
  taskState: (taskId: string) => Promise<string | null>;
  readEvidence: (taskId: string) => Promise<string | null>;
  reportExists: (runId: string) => Promise<boolean>;
  writeReport: (runId: string, markdown: string, json: string) => Promise<void>;
  log: (level: string, msg: string) => void;
}

/**
 * A run is finished when no task is still `pending` or `active`. An ESCALATED task
 * counts as finished on purpose: it is parked awaiting an operator, and a run that
 * waits forever for one would never produce a report at all — the same predicate
 * the narrator needed for exactly this reason
 * (docs/gotchas/escalated-run-not-terminal.md).
 *
 * A task whose state cannot be determined is treated as NOT finished: a report
 * written over a run that is still moving would be wrong, and waiting is the
 * cheap failure (Principle 10).
 */
const UNFINISHED = new Set(["pending", "active"]);

export async function refreshExecutionReports(deps: ReportServiceDeps): Promise<void> {
  try {
    const runs = await deps.listRuns();
    for (const run of runs) {
      if (await deps.reportExists(run.runId)) continue;

      let finished = true;
      for (const id of run.taskIds) {
        const state = await deps.taskState(id);
        if (state === null || UNFINISHED.has(state)) {
          finished = false;
          break;
        }
      }
      if (!finished) continue;

      const slots = await loadEvidence(run.taskIds, deps.readEvidence);
      const doc = buildExecutionReport({ runId: run.runId, intent: run.intent, at: run.at }, slots);
      await deps.writeReport(run.runId, renderExecutionReport(doc), JSON.stringify(doc, null, 2));
      deps.log("INFO", `report: wrote execution report for ${run.runId}`);
    }
  } catch (err) {
    // Reporting is bookkeeping about the loop; it must never break the loop.
    try {
      deps.log("WARN", `report: refreshing execution reports failed (ignored): ${String(err)}`);
    } catch {
      /* a throwing logger must not resurrect the failure */
    }
  }
}
