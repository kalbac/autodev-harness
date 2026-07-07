import { unlink as fsUnlink } from "node:fs/promises";
import type { QueueState } from "../blackboard/repository.js";
import type { Logger } from "../util/log.js";
import type { OrchestratorAdapter, ReadSnapshot } from "./adapter.js";
import type { OrchestratorCapabilities } from "./capabilities.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";

export interface OrchestratorResult {
  intent: string;
  enqueued: { id: string; path: string }[];
  triggered: boolean;
  triggerOutcome?: unknown;
  /** Set when `caps.recordRun` (a best-effort report-family convenience
   *  index, see capabilities.ts) succeeded. Absent on a 0-task decomposition
   *  or when the manifest write failed — a missing `runId` must never be
   *  treated as `handleIntent` having failed. */
  runId?: string;
}

export interface CreateOrchestratorDeps {
  caps: OrchestratorCapabilities;
  adapter: OrchestratorAdapter;
  log: Logger;
  /**
   * Injectable so the enqueue-rollback path (see `handleIntent` step 4) is
   * unit-testable without touching real fs. Defaults to `node:fs/promises`
   * `unlink`.
   */
  unlink?: (path: string) => Promise<void>;
}

const ALL_QUEUE_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

/**
 * Validate every spec AND check id-uniqueness (within the batch AND against
 * ids already in-flight). Returns the list of problem strings — empty means
 * the batch is clean. This is intentionally all-or-nothing: a single bad
 * spec must not let the OTHER, valid specs through — see `handleIntent`
 * step 3's rationale (a decomposition is one atomic unit; a partial enqueue
 * would leave the operator unsure which half of their intent landed).
 */
function validateBatch(specs: TaskSpec[], existingIds: string[]): string[] {
  const problems: string[] = [];
  const existing = new Set(existingIds);
  const seenInBatch = new Set<string>();

  specs.forEach((spec, index) => {
    try {
      validateTaskSpec(spec);
    } catch (err) {
      problems.push(`spec [${index}]: ${String((err as Error).message ?? err)}`);
      return; // id-collision checks below assume a structurally valid spec
    }

    if (existing.has(spec.id)) {
      problems.push(`spec [${index}]: id '${spec.id}' collides with an existing in-flight task`);
    }
    if (seenInBatch.has(spec.id)) {
      problems.push(`spec [${index}]: id '${spec.id}' collides with another task in this same batch`);
    }
    seenInBatch.add(spec.id);
  });

  return problems;
}

/**
 * Build the staged, TERMINATING orchestrator pipeline (fork A1) — explicitly
 * NOT an agentic loop: `handleIntent` runs each step exactly once and
 * returns. Steps:
 *
 * 1. Snapshot every queue so the adapter (and the id-collision check below)
 *    can see all in-flight work.
 * 2. Ask the adapter to decompose the intent into `TaskSpec`s.
 * 3. Validate-all-or-nothing: EVERY spec must be individually valid AND
 *    every id must be unique (within the batch, and against in-flight ids).
 *    If anything fails, report the failure to the digest and THROW —
 *    nothing is enqueued. A bad decomposition means the operator re-runs;
 *    silently enqueueing "the good half" would hide which tasks landed.
 * 4. Enqueue every spec (now known-good), transactionally: the loop is
 *    all-or-nothing, matching step 3's guarantee. If `caps.enqueue` throws
 *    partway through the batch, every path already written by this loop is
 *    rolled back (best-effort `unlink`) before rethrowing, so a partial fs
 *    error never leaves a partial plan sitting in `queue/pending/`. This is
 *    race-free: `trigger` has not run yet at this point, so nothing has
 *    claimed (moved out of `pending/`) any of these files.
 * 5. If the batch was empty (0 specs — a valid decomposition of "no work
 *    needed"), skip `trigger` (and the manifest write in step 6) entirely
 *    and return early; there is nothing for a run to process.
 * 6. Best-effort: `caps.recordRun` writes a run manifest indexing this
 *    batch's task ids (report family, see capabilities.ts — a convenience
 *    index for the dashboard, NOT authoritative state). It never throws, so
 *    a manifest failure can never fail the run; a `null` result is ignored.
 * 7. Trigger a DRAIN run (`{drain:true}`) so the conductor processes the whole
 *    pending pool until nothing is claimable, then stops — NOT a batch-sized
 *    bound. A batch-sized bound (`maxIterations = specs.length`) could spend its
 *    iterations on OTHER pre-existing pending tasks (the scheduler claims from
 *    the global pool), stranding this batch's own tasks in PENDING with nothing
 *    to consume them (backlog B: orphaned PENDING). Draining guarantees every
 *    currently-claimable task is attempted. Tasks that are legitimately blocked
 *    (unmet `depends_on`, or re-queued after an escalation reply) are not
 *    claimable and correctly wait for a follow-up trigger; `handleIntent` still
 *    makes no promise that every enqueued task reaches `done` before returning.
 * 8. Report one summary digest line.
 */
export function createOrchestrator(deps: CreateOrchestratorDeps): {
  handleIntent(intent: string): Promise<OrchestratorResult>;
} {
  const { caps, adapter, log } = deps;
  const unlink = deps.unlink ?? fsUnlink;

  return {
    async handleIntent(intent: string): Promise<OrchestratorResult> {
      log("INFO", `orchestrator: building read snapshot for intent: ${intent}`);
      const queues = await caps.read.queues();
      const existingIds = ALL_QUEUE_STATES.flatMap((state) => queues[state].map((t) => t.id));
      const state: ReadSnapshot = { existingIds, queues };

      log("INFO", "orchestrator: decomposing intent");
      const specs = await adapter.decompose({ intent, state });

      const problems = validateBatch(specs, existingIds);
      if (problems.length > 0) {
        const message = `orchestrator decomposition rejected (all-or-nothing, nothing enqueued): ${problems.join("; ")}`;
        await caps.report({ level: "ERROR", message });
        throw new Error(message);
      }

      if (specs.length === 0) {
        const message =
          "orchestrator: decomposition produced 0 tasks; nothing enqueued, trigger skipped";
        log("INFO", message);
        await caps.report({ level: "INFO", message });
        return { intent, enqueued: [], triggered: false };
      }

      log("INFO", `orchestrator: enqueueing ${specs.length} task(s)`);
      const enqueued: { id: string; path: string }[] = [];
      try {
        for (const spec of specs) {
          enqueued.push(await caps.enqueue(spec));
        }
      } catch (err) {
        // Best-effort rollback of every path already written by this loop.
        // Race-free: `trigger` has not run yet, so nothing has claimed
        // (moved out of `pending/`) any of these files — see the doc
        // comment above `createOrchestrator`, step 4.
        for (const item of enqueued) {
          try {
            await unlink(item.path);
          } catch {
            // Rollback is best-effort — swallow unlink errors so they
            // don't mask the original enqueue failure below.
          }
        }
        const failedSpecId = specs[enqueued.length]?.id ?? "<unknown>";
        const message = `orchestrator enqueue failed on spec '${failedSpecId}' (rollback attempted for ${enqueued.length} already-written task(s)): ${String((err as Error).message ?? err)}`;
        await caps.report({ level: "ERROR", message });
        throw new Error(message);
      }

      // Best-effort convenience index (report family, see capabilities.ts
      // doc-comment) — `recordRun` never throws, so no try/catch is needed
      // here, and a `null` result must not affect the rest of the flow.
      const runRecord = await caps.recordRun({ intent, taskIds: enqueued.map((e) => e.id) });

      log("INFO", `orchestrator: triggering a drain run over the pending pool`);
      const triggerOutcome = await caps.trigger({ drain: true });

      await caps.report({
        level: "INFO",
        message: `orchestrated intent -> ${enqueued.length} task(s) enqueued and triggered`,
      });

      return { intent, enqueued, triggered: true, triggerOutcome, ...(runRecord ? { runId: runRecord.runId } : {}) };
    },
  };
}
