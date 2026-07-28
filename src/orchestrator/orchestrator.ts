import { unlink as fsUnlink } from "node:fs/promises";
import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { Logger } from "../util/log.js";
import { fileSetsDisjoint } from "../scheduler/scheduler.js";
import type { OrchestratorAdapter, ReadSnapshot } from "./adapter.js";
import { buildReadSnapshot, type OrchestratorCapabilities } from "./capabilities.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";
import { filterSuccessCommands, type CommandDeclaration } from "./success-command-policy.js";

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
  /**
   * What commands this project declares (s61 half (a)). ABSENT = the filter is
   * disabled and every decomposed `success_commands` entry passes through
   * untouched — the pre-s61 behaviour, which is what keeps existing callers and
   * tests compiling unchanged.
   *
   * Read fresh per intent (not captured once): the operator can edit the allowlist
   * or add a script between runs, and a captured declaration would keep denying a
   * command the project now declares.
   */
  successCommandDeclaration?: () => Promise<CommandDeclaration>;
}

/** One dropped command, carried out of the decompose step so the caller reports
 *  it exactly once — for the attempt that actually WON (see `handleIntent`). */
interface DroppedCommand {
  taskId: string;
  command: string;
}

/** Queue states whose tasks represent live, not-yet-resolved work that a relaunch
 *  of the same intent would duplicate. Mirrors the scheduler's file-lock set
 *  (`active`+`escalated`) plus `pending` (queued but unclaimed). `done`/`quarantine`
 *  are excluded: a file-overlap with completed or abandoned work is legitimate (a
 *  re-run / retry), not a duplicate. */
const DEDUP_STATES: QueueState[] = ["pending", "active", "escalated"];

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Case/whitespace-folded intent text, for intent-level dedup (a relaunch of the
 *  SAME intent). Robust where the task-level title heuristic is not: the LLM
 *  re-titles the same work on each decomposition, but the operator's intent text
 *  is identical on a relaunch. */
function normalizeIntent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A new spec DUPLICATES an in-flight task when their `file_set`s OVERLAP (share a
 * normalized path — the scheduler would serialize them behind a file-lock anyway)
 * AND their titles match after normalization (case/whitespace-folded). Requiring
 * BOTH signals keeps false positives low: legitimate sequential work that merely
 * shares a file has a different title and is NOT flagged. When titles drift enough
 * to miss a real duplicate, we fail OPEN (enqueue) — a missed dup is just today's
 * behavior, whereas wrongly DROPPING distinct work would be strictly worse.
 */
export function isDuplicateTask(spec: TaskSpec, task: Pick<Task, "title" | "file_set">): boolean {
  return !fileSetsDisjoint(spec.file_set, task.file_set) && normalizeTitle(spec.title) === normalizeTitle(task.title);
}

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
      const state: ReadSnapshot = await buildReadSnapshot(caps.read);
      const { queues, existingIds } = state;

      // Intent-level dedup (PRIMARY, before the expensive decompose): if THIS exact
      // intent was already orchestrated and its prior run's tasks are still in-flight
      // (pending/active/escalated), it's a relaunch -> enqueue nothing and re-trigger
      // the existing pool, skipping the decompose entirely. Robust where the task-level
      // file_set+title heuristic (below) is not: the LLM re-titles the same work on each
      // decomposition, so a relaunch's specs rarely title-match — but the intent text is
      // identical. `done`/`quarantine` are excluded (a re-run after completion/abandon is
      // legitimate, not a duplicate), matching DEDUP_STATES.
      const inFlightIds = new Set(DEDUP_STATES.flatMap((s) => queues[s]).map((t) => t.id));
      if (inFlightIds.size > 0) {
        const priorRun = (await caps.read.recentRuns()).find(
          (r) => normalizeIntent(r.intent) === normalizeIntent(intent) && r.taskIds.some((id) => inFlightIds.has(id)),
        );
        if (priorRun) {
          const liveIds = priorRun.taskIds.filter((id) => inFlightIds.has(id));
          const message = `orchestrator: this intent was already orchestrated (run ${priorRun.runId}) with ${liveIds.length} task(s) still in-flight (${liveIds.join(", ")}); nothing enqueued -- re-triggering the existing pending pool instead of duplicating`;
          log("INFO", message);
          const triggerOutcome = await caps.trigger({ drain: true });
          await caps.report({ level: "WARN", message });
          return { intent, enqueued: [], triggered: true, triggerOutcome };
        }
      }

      /**
       * One decomposition attempt: ask the adapter, apply the success-command
       * policy, then validate the batch. Returns the problems rather than
       * throwing them, so the retry below can treat BOTH failure modes (an
       * adapter throw and a non-empty problem list) the same way.
       *
       * The policy runs INSIDE the attempt, before validation, but its drops are
       * only RETURNED — never reported here. Reporting inside would announce
       * commands dropped from a batch that was then discarded by a retry, which
       * is a digest line about work that never existed.
       */
      const attempt = async (
        previousFailure?: string,
      ): Promise<{ specs: TaskSpec[]; drops: DroppedCommand[]; filterSkipped: boolean; problems: string[] }> => {
        const raw = await adapter.decompose({
          intent,
          state,
          ...(previousFailure !== undefined ? { previousFailure } : {}),
        });

        const drops: DroppedCommand[] = [];
        let filterSkipped = false;
        let specs = raw;

        if (deps.successCommandDeclaration) {
          const declaration = await deps.successCommandDeclaration();
          specs = raw.map((spec) => {
            const r = filterSuccessCommands(spec.success_commands, declaration);
            filterSkipped ||= r.filterSkipped;
            for (const command of r.dropped) drops.push({ taskId: spec.id, command });
            // Rebuilt rather than mutated: the adapter's object may be shared with
            // the caller's fixtures, and a spec that lost nothing must stay
            // referentially harmless either way.
            return { ...spec, success_commands: r.kept };
          });
        }

        return { specs, drops, filterSkipped, problems: validateBatch(specs, existingIds) };
      };

      log("INFO", "orchestrator: decomposing intent");

      // #141: a decomposition that fails EITHER way is retried EXACTLY ONCE with
      // the failure text fed back to the model. The observed failure -- an array
      // element arriving as a bare string -- killed a corpus case outright, and it
      // is INTERMITTENT: the same case succeeded in another run. A measuring
      // instrument may not have an intermittent failure of its own. A SECOND
      // failure behaves exactly as before this change, message shape included.
      //
      // ONE retry budget spanning BOTH failure modes -- not one each. A first
      // attempt that throws and a retry that then fails validation must NOT buy a
      // third call: the budget is per-intent, and "exactly once" has to hold for
      // every path through the two failure shapes, not just for each shape alone.
      let outcome: Awaited<ReturnType<typeof attempt>> | undefined;
      let failureText: string | undefined;
      try {
        outcome = await attempt();
        if (outcome.problems.length > 0) failureText = outcome.problems.join("; ");
      } catch (err) {
        failureText = String((err as Error).message ?? err);
      }

      if (failureText !== undefined) {
        log("WARN", `orchestrator: decomposition failed, retrying ONCE with the failure fed back: ${failureText}`);
        // The retry is the LAST attempt. A throw here propagates UNWRAPPED --
        // today's behaviour exactly, so nothing downstream that reads this
        // message changes meaning.
        outcome = await attempt(failureText);
      }

      const specs = outcome!.specs;
      if (outcome!.problems.length > 0) {
        const message = `orchestrator decomposition rejected (all-or-nothing, nothing enqueued): ${outcome!.problems.join("; ")}`;
        await caps.report({ level: "ERROR", message });
        throw new Error(message);
      }

      // Report the policy's effect for the attempt that actually WON. A silent
      // discard of LLM output is how a feature becomes invisible, so every drop
      // gets BOTH a WARN log and a digest line naming the task and the command.
      if (outcome!.filterSkipped) {
        const message =
          "orchestrator: could not read this project's declared commands, so the success_command filter did NOT run; " +
          "every decomposed success_command was kept unchecked (the gate still refuses to run one that does not exist)";
        log("WARN", message);
        await caps.report({ level: "WARN", message });
      }
      for (const drop of outcome!.drops) {
        const message =
          `orchestrator: dropped success_command '${drop.command}' from task '${drop.taskId}' -- ` +
          "this project declares no such package.json script and the operator has not declared the command " +
          "(gate.successCommands); an undeclared command cannot judge a change, it only loses the task";
        log("WARN", message);
        await caps.report({ level: "WARN", message });
      }

      if (specs.length === 0) {
        const message =
          "orchestrator: decomposition produced 0 tasks; nothing enqueued, trigger skipped";
        log("INFO", message);
        await caps.report({ level: "INFO", message });
        return { intent, enqueued: [], triggered: false };
      }

      // Relaunch-intent dedup (backlog C): match each new spec against live in-flight
      // work (pending/active/escalated). A FULL duplicate (every spec matches) is a
      // relaunch of an already-queued intent -> enqueue nothing (no duplicates) but
      // still re-trigger the existing pool so a stalled relaunch re-drives its own
      // pending tasks. A PARTIAL overlap is ambiguous (could be legitimately expanded
      // work) -> enqueue everything and only WARN: dropping a subset could break a
      // kept spec's `depends_on` or silently lose genuinely-new work.
      const inFlight = DEDUP_STATES.flatMap((s) => queues[s]);
      const dupMatch = specs.map((spec) => inFlight.find((t) => isDuplicateTask(spec, t)));
      const overlapCount = dupMatch.filter((m) => m !== undefined).length;
      if (overlapCount === specs.length) {
        const pairs = specs.map((spec, i) => `'${spec.id}'~'${dupMatch[i]!.id}'`).join(", ");
        const message = `orchestrator: all ${specs.length} decomposed task(s) duplicate existing pending/active/escalated work (${pairs}); nothing enqueued — re-triggering the existing pending pool instead of duplicating`;
        log("INFO", message);
        const triggerOutcome = await caps.trigger({ drain: true });
        await caps.report({ level: "WARN", message });
        return { intent, enqueued: [], triggered: true, triggerOutcome };
      }
      if (overlapCount > 0) {
        const pairs = specs
          .map((spec, i) => (dupMatch[i] ? `'${spec.id}'~'${dupMatch[i]!.id}'` : undefined))
          .filter((p): p is string => p !== undefined)
          .join(", ");
        await caps.report({
          level: "WARN",
          message: `orchestrator: ${overlapCount} of ${specs.length} decomposed task(s) overlap existing in-flight work (${pairs}); enqueuing anyway (partial batch, not treated as a full relaunch)`,
        });
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
