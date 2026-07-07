/**
 * The conductor loop — parity port of `conductor.ps1` (parity spec §2). Pure
 * wiring + deterministic routing: zero LLM calls, zero judgment of its own.
 * Every side effect (git, fs, subprocess, LLM adapters) is injected via
 * `ConductorDeps` so the whole spine can be exercised with fakes and no
 * subprocesses.
 */
import type { Task } from "../blackboard/types.js";
import type { BlackboardRepository } from "../blackboard/repository.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Worktree, WorktreeManager } from "../worktree/worktree.js";
import type { WorkerAdapter } from "../worker/adapter.js";
import type { CriticAdapter } from "../critic/adapter.js";
import type { Router } from "../router/router.js";
import type { Git } from "../util/git.js";
import type { GateInput, GateVerdict } from "../gate/gate.js";
import type { EscalationInput, EscalationType } from "../escalate/escalate.js";
import type { AntiDriftInput } from "../anti-drift/anti-drift.js";
import type { HarnessConfig } from "../config/schema.js";
import { workerTouched, strayChanged, forbiddenTouches } from "../util/fingerprint.js";
import { buildTokenUsageDoc, type WorkerUsage, type CriticUsage } from "../usage/usage.js";
import { buildCriticVerdictDoc, type Verdict } from "../critic/verdict.js";

export interface ConductorDeps {
  cfg: HarnessConfig;
  repo: BlackboardRepository;
  scheduler: Scheduler;
  worktree: WorktreeManager;
  worker: WorkerAdapter;
  critic: CriticAdapter;
  router: Router;
  /** Git bound to the MAIN repo (preflight + commit-time branch re-check). */
  git: Git;
  /** Git bound to a worktree (used to `add` file_set + `commit` there). */
  worktreeGit: (wt: Worktree) => Git;
  /** May THROW on a broken operator config; the conductor treats a throw as fail-closed ESCALATE. */
  runGate: (input: GateInput, wt: Worktree) => Promise<GateVerdict>;
  /** Never-throws contract; still called defensively. */
  escalate: (input: EscalationInput) => Promise<unknown>;
  runAntiDrift: (input: AntiDriftInput) => Promise<string>;
  /** Move <worktree>/worker-report.md -> runtimeDir/worker-report.md, called right after the
   * worker's rate-limit/timeout early-returns and BEFORE the status read + dirty-file fence
   * (parity spec §6): the report belongs in runtimeDir, never in the worktree. */
  harvestWorkerReport: (wt: Worktree, taskId: string) => Promise<void>;
  gitChangedPaths: (cwd: string) => Promise<string[]>;
  snapshotFingerprints: (cwd: string, rawPaths: string[]) => Map<string, string>;
  zonesTouchedInDiff: (diff: string) => Promise<string[]>;
  clock: { now: () => number };
  sleep: (seconds: number) => Promise<void>;
  log: (level: string, message: string) => void;
}

export interface ConductorRunOptions {
  once?: boolean;
  maxIterations?: number;
}

export interface IterationResult {
  claimedTaskId: string | null;
  committed: boolean;
  rateLimited: boolean;
}

export interface Conductor {
  runIteration(): Promise<IterationResult>;
  run(opts?: ConductorRunOptions): Promise<void>;
}

/** Fields needed to build an `EscalationInput` beyond the fixed `id`/`taskId`/`title`. */
interface EscalationFields {
  reason: string;
  type: EscalationType;
  what: string;
  decision: string;
  optionA: string;
  optionB: string;
  costOfWrong: string;
  evidence: string;
}

function buildEscalation(task: Task, fields: EscalationFields): EscalationInput {
  return {
    id: task.id,
    taskId: task.id,
    title: task.title,
    reason: fields.reason,
    type: fields.type,
    what: fields.what,
    decision: fields.decision,
    optionA: fields.optionA,
    optionB: fields.optionB,
    costOfWrong: fields.costOfWrong,
    evidence: fields.evidence,
  };
}

function buildDriftEscalation(line: string, nowMs: number): EscalationInput {
  return {
    id: `drift-${nowMs}`,
    taskId: "(anti-drift)",
    title: "Anti-drift check reported drift",
    reason: "anti-drift verdict: DRIFT",
    type: "drift",
    what: line,
    decision: "Review recent commits for scope drift vs the phase intent.",
    optionA: "Acknowledge and continue -- drift is acceptable / expected.",
    optionB: "Halt the loop and course-correct before more tasks land.",
    costOfWrong: "Undetected drift compounds silently across many small commits.",
    evidence: line,
  };
}

export function createConductor(deps: ConductorDeps): Conductor {
  const {
    cfg,
    repo,
    scheduler,
    worktree,
    worker,
    critic,
    router,
    git,
    worktreeGit,
    runGate,
    escalate,
    runAntiDrift,
    harvestWorkerReport,
    gitChangedPaths,
    snapshotFingerprints,
    zonesTouchedInDiff,
    clock,
    sleep,
    log,
  } = deps;

  // safeLog swallows a throwing injected logger. Load-bearing inside the
  // teardown `finally` catch: without it, a throwing logger would re-throw out
  // of `finally` and convert an already-decided iteration (e.g. a 429 refund)
  // into a rejected promise -- the [ts/fail-closed] gotcha.
  const safeLog = (level: string, message: string): void => {
    try {
      log(level, message);
    } catch {
      // a broken logger must never break the loop's control flow
    }
  };

  async function runIteration(): Promise<IterationResult> {
    // 1. CLAIM
    const task = await scheduler.claimNextTask();
    if (task === null) {
      return { claimedTaskId: null, committed: false, rateLimited: false };
    }

    // 2. CIRCUIT BREAKER
    const attempts = (await repo.getAttempts(task.id)) + 1;
    await repo.setAttempts(task.id, attempts);
    if (attempts > cfg.loop.maxAttempts) {
      await repo.moveTask(task.id, "active", "quarantine");
      await escalate(
        buildEscalation(task, {
          reason: "circuit breaker tripped -- too many attempts",
          type: "poison",
          what: `Task ${task.id} exceeded max attempts (${attempts} > ${cfg.loop.maxAttempts}).`,
          decision: "Quarantine and investigate why this task cannot converge.",
          optionA: "Fix the task definition (file_set / acceptance / scope) and re-queue.",
          optionB: "Abandon the task.",
          costOfWrong: "A poisoned task can burn unbounded attempts if left in the pending pool.",
          evidence: `attempts=${attempts} maxAttempts=${cfg.loop.maxAttempts}`,
        }),
      );
      return { claimedTaskId: task.id, committed: false, rateLimited: false };
    }

    // 3. WORKTREE + WORKER + FENCE + CRITIC
    const loopBranch = await git.currentBranch();
    const { ladder, warnings } = router.resolveLadder(task);
    warnings.forEach((w) => log("WARN", w));
    const maxRounds = task.max_rounds ?? cfg.roles.critic.retryMax;
    const runtimeDir = repo.runtimeDir(task.id);
    const workerReportPath = `${runtimeDir}/worker-report.md`;

    const wt = await worktree.create(task.id, loopBranch);

    // Token/usage accounting (s22): accumulate every worker + critic invocation
    // across all rounds of this task and persist a `token-usage.json` runtime
    // artifact. Best-effort by contract -- a write/aggregate failure must NEVER
    // break the enforcement loop or convert a decided iteration into a rejection
    // (same never-throws discipline as recordRun / digest / teardown, gotcha
    // [ts/fail-closed]). Served unchanged by the existing runtime-file endpoint.
    const workerRuns: WorkerUsage[] = [];
    const criticRuns: CriticUsage[] = [];
    const persistTokenUsage = async (): Promise<void> => {
      try {
        const doc = buildTokenUsageDoc(workerRuns, criticRuns, clock.now());
        await repo.writeRuntimeFile(task.id, "token-usage.json", JSON.stringify(doc, null, 2));
      } catch (err) {
        safeLog("WARN", `conductor: persisting token-usage for ${task.id} failed (ignored): ${String(err)}`);
      }
    };

    // Critic verdict persistence (s24): a CLEAN-committed task never escalates, so its
    // verdict+confidence would otherwise survive only as a digest line -- the dashboard
    // could not render a verdict seal for it (gotcha [ui/verdict-not-persisted]). Write a
    // `critic-verdict.json` runtime artifact ONLY at the decisive point of the round loop
    // (the clean-break that commits, or the escalation that ends the task) and only for a
    // parseable verdict -- NOT on intermediate retry rounds. This guarantees the file always
    // reflects the outcome that actually decided the task, with no stale earlier verdict left
    // behind when a later round returns a null/unparseable verdict. Best-effort/never-throws,
    // SAME contract as persistTokenUsage above; served unchanged by the runtime-file endpoint.
    const persistCriticVerdict = async (verdict: Verdict): Promise<void> => {
      try {
        const doc = buildCriticVerdictDoc(verdict, clock.now());
        await repo.writeRuntimeFile(task.id, "critic-verdict.json", JSON.stringify(doc, null, 2));
      } catch (err) {
        safeLog("WARN", `conductor: persisting critic-verdict for ${task.id} failed (ignored): ${String(err)}`);
      }
    };

    try {
      let round = 0;
      while (true) {
        // Pre-worker fingerprint baseline.
        const basePaths = await gitChangedPaths(wt.path);
        const baseline = snapshotFingerprints(wt.path, basePaths);

        // WORKER
        const criticFeedback =
          round > 0 ? (await repo.readRuntimeFile(task.id, "critic-feedback.md")) ?? undefined : undefined;
        const wr = await worker.run({
          task,
          worktreePath: wt.path,
          ladder,
          runtimeDir,
          ...(criticFeedback !== undefined ? { criticFeedback } : {}),
        });

        // Record worker usage BEFORE the rate-limit/timeout early returns so a
        // throttled or timed-out step still accounts for whatever it burned.
        if (wr.usage) {
          workerRuns.push(wr.usage);
          await persistTokenUsage();
        }

        if (wr.rateLimited) {
          await repo.setAttempts(task.id, attempts - 1);
          await repo.moveTask(task.id, "active", "pending");
          return { claimedTaskId: task.id, committed: false, rateLimited: true };
        }
        if (wr.timedOut) {
          await repo.moveTask(task.id, "active", "pending");
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        // Relocate the worker's report out of the worktree into the runtime
        // dir BEFORE reading status and BEFORE the dirty-file fence -- parity
        // spec §6: the report belongs at runtime/<id>/worker-report.md.
        // Leaving it in the worktree would (a) hide it from the status read
        // below (which reads runtimeDir, not the worktree) and (b) get it
        // flagged as a stray file by the dirty-file fence.
        await harvestWorkerReport(wt, task.id);

        // WORKER-REPORT routing
        const report = (await repo.readRuntimeFile(task.id, "worker-report.md")) ?? "";
        const m = /^\s*status\s*[:=]\s*([A-Z_]+)/im.exec(report);
        const status = m ? m[1] : "";

        if (status === "TOO_BIG") {
          await repo.moveTask(task.id, "active", "quarantine");
          await escalate(
            buildEscalation(task, {
              reason: "worker reported task too big",
              type: "blocked",
              what: `Task ${task.id} worker report status TOO_BIG.`,
              decision: "Split the task into smaller pieces and re-queue.",
              optionA: "Split the task.",
              optionB: "Abandon the task.",
              costOfWrong: "An oversized task will keep failing and burning attempts.",
              evidence: report,
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }
        if (status === "NEEDS_GUARD") {
          await repo.moveTask(task.id, "active", "escalated");
          await escalate(
            buildEscalation(task, {
              reason: "worker reported it needs a guard",
              type: "needs-guard",
              what: `Task ${task.id} worker report status NEEDS_GUARD.`,
              decision: "Author/bless a mutation-verified guard for the touched contract zone.",
              optionA: "Add the guard and re-queue.",
              optionB: "Reject the change.",
              costOfWrong: "An unguarded contract-zone change cannot be safely auto-committed.",
              evidence: report,
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }
        if (status === "BLOCKED") {
          await repo.moveTask(task.id, "active", "escalated");
          await escalate(
            buildEscalation(task, {
              reason: "worker reported it is blocked",
              type: "blocked",
              what: `Task ${task.id} worker report status BLOCKED.`,
              decision: "Unblock the task (missing dependency / access / decision).",
              optionA: "Unblock and re-queue.",
              optionB: "Abandon the task.",
              costOfWrong: "A blocked task cannot make progress and will keep failing.",
              evidence: report,
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }
        // (DONE / anything else falls through to the fence.)

        // DIRTY-FILE FENCE
        const nowPaths = await gitChangedPaths(wt.path);
        const now = snapshotFingerprints(wt.path, nowPaths);
        const touched = workerTouched(baseline, now);
        const stray = strayChanged(touched, task.file_set, cfg.dirtyFenceIgnore);
        const forbidden = forbiddenTouches(touched, task.forbidden_paths);
        if (stray.length > 0 || forbidden.length > 0) {
          await repo.moveTask(task.id, "active", "escalated");
          await escalate(
            buildEscalation(task, {
              reason: "worker touched files outside its declared scope",
              type: "dirty-file",
              what: `Task ${task.id} touched files outside file_set and/or forbidden_paths.`,
              decision: "Review the stray/forbidden touches before allowing this task to land.",
              optionA: "Approve the extra scope and re-queue with an updated file_set.",
              optionB: "Reject the change.",
              costOfWrong: "An unreviewed out-of-scope write can silently corrupt other tasks' territory.",
              evidence: `stray: ${stray.join(", ")}\nforbidden: ${forbidden.join(", ")}`,
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        // DIFF + CRITIC
        const diff = await worktree.diff(wt, task.file_set);
        await repo.writeRuntimeFile(task.id, "diff.patch", diff);
        const cr = await critic.run({ diff, runtimeDir, workerReportPath });

        if (cr.usage) {
          criticRuns.push(cr.usage);
          await persistTokenUsage();
        }

        if (cr.verdict === null && cr.rateLimited) {
          await repo.setAttempts(task.id, attempts - 1);
          await repo.moveTask(task.id, "active", "pending");
          return { claimedTaskId: task.id, committed: false, rateLimited: true };
        }

        if (cr.verdict?.verdict === "clean") {
          // Decisive: this verdict is what commits. Persist it (see the
          // persistCriticVerdict comment) BEFORE breaking to the gate.
          await persistCriticVerdict(cr.verdict);
          break;
        }

        // Not clean (broken / uncertain / unparseable-null).
        const actualZones = await zonesTouchedInDiff(diff);
        const contractRisk =
          task.touches_contract_zone ||
          actualZones.length > 0 ||
          (cr.verdict?.broken_contracts.length ?? 0) > 0;

        if (contractRisk || round >= maxRounds) {
          // Decisive: this round escalates. Persist the verdict that drove the
          // escalation -- but only if it is parseable. A null/unparseable
          // decisive verdict writes nothing (there is no verdict to record, and
          // because intermediate rounds are never persisted there is no stale
          // artifact to correct); the escalation body carries "(unparseable)".
          if (cr.verdict) {
            await persistCriticVerdict(cr.verdict);
          }
          const escType: EscalationType = cr.verdict?.verdict === "broken" ? "disagreement" : "uncertain";
          await repo.moveTask(task.id, "active", "escalated");
          await escalate(
            buildEscalation(task, {
              reason: "critic did not return a clean verdict",
              type: escType,
              what: `Task ${task.id} critic verdict: ${cr.verdict?.verdict ?? "(unparseable)"}.`,
              decision: "Review the critic notes and diff, decide whether to accept or reject.",
              optionA: "Accept the change despite the critic's concerns.",
              optionB: "Reject and require rework.",
              costOfWrong: "Committing a broken/uncertain contract-zone change can silently break behavior.",
              evidence: cr.verdict?.notes ?? "critic returned no parseable verdict",
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        await repo.writeRuntimeFile(
          task.id,
          "critic-feedback.md",
          cr.verdict?.notes ?? "critic returned no parseable verdict; make the smallest, clearest change and retry.",
        );
        round++;
      }

      // 4. GATE
      let gv: GateVerdict;
      try {
        gv = await runGate({ taskId: task.id, fileSet: task.file_set, successCommands: task.success_commands }, wt);
      } catch {
        await repo.moveTask(task.id, "active", "escalated");
        const escType: EscalationType = task.contract_zones_touched.length > 0 ? "constitution" : "needs-guard";
        await escalate(
          buildEscalation(task, {
            reason: "gate threw -- broken operator config",
            type: escType,
            what: `Task ${task.id} gate invocation threw.`,
            decision: "Fix the broken gate config (INVARIANTS.md / GUARDS.md / check command) before retrying.",
            optionA: "Fix the config and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "A broken gate config cannot safely judge ANY task, not just this one.",
            evidence: `taskId=${task.id}`,
          }),
        );
        return { claimedTaskId: task.id, committed: false, rateLimited: false };
      }

      // 5. DECISION
      if (gv.decision === "RETRY") {
        await repo.moveTask(task.id, "active", "pending");
        return { claimedTaskId: task.id, committed: false, rateLimited: false };
      }

      if (gv.decision === "COMMIT") {
        // Commit-time branch re-check (parity divergence #10): HEAD can move
        // mid-run. Guard the branch we are ABOUT TO MERGE INTO -- it must still
        // be allowed AND still be the exact loopBranch this worktree was
        // branched off. A drift to a *different* allowed branch (loop-A ->
        // loop-B) would otherwise silently merge into the stale loopBranch.
        const cur = await git.currentBranch();
        if (cur === "main" || !new RegExp(cfg.allowedBranchPattern).test(cur) || cur !== loopBranch) {
          await repo.moveTask(task.id, "active", "escalated");
          await escalate(
            buildEscalation(task, {
              reason: "branch moved before commit",
              type: "blocked",
              what: `Task ${task.id} gate said COMMIT but HEAD moved from '${loopBranch}' to '${cur}' (or off the allowed pattern).`,
              decision: "Restore the loop branch and re-run, or abandon.",
              optionA: "Restore the branch and re-queue.",
              optionB: "Abandon the task.",
              costOfWrong: "Committing/merging on the wrong branch could land the change on main or a stale branch.",
              evidence: `currentBranch=${cur} loopBranch=${loopBranch} allowedPattern=${cfg.allowedBranchPattern}`,
            }),
          );
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        const kind = cfg.commit.typeMap[task.type] ?? cfg.commit.defaultKind;
        const msg = `${kind}(autodev): ${task.title}`;
        const wg = worktreeGit(wt);
        await wg.add(task.file_set);
        const hash = await wg.commit(msg);

        const mr = await worktree.mergeAfterGate(wt, loopBranch);
        if (!mr.ok) {
          // A merge-back fails two ways: a genuine content CONFLICT, or a
          // refused PRECONDITION (dirty main tree / failed checkout) that
          // carries a `reason`. Escalate each with its own accurate wording so
          // the operator fixes the right thing -- never a phantom conflict.
          await repo.moveTask(task.id, "active", "escalated");
          const fields: EscalationFields = mr.conflict
            ? {
                reason: "worktree merge conflict",
                type: "blocked",
                what: `Task ${task.id} merge back into '${loopBranch}' conflicted.`,
                decision: "Resolve the conflict manually.",
                optionA: "Resolve and re-queue.",
                optionB: "Abandon the task.",
                costOfWrong: "An unresolved conflict blocks all tasks touching these files.",
                evidence: `branch=${wt.branch} into=${loopBranch}`,
              }
            : {
                reason: `worktree merge blocked: ${mr.reason ?? "precondition not met"}`,
                type: "blocked",
                what: `Task ${task.id} committed but its merge back into '${loopBranch}' was refused: ${mr.reason ?? "precondition not met"}.`,
                decision: "Clear the blocking precondition (e.g. commit/stash the dirty main tree), then re-queue.",
                optionA: "Resolve and re-queue.",
                optionB: "Abandon the task.",
                costOfWrong: "An unmerged committed task blocks all tasks touching these files and never lands.",
                evidence: `branch=${wt.branch} into=${loopBranch} reason=${mr.reason ?? "(none)"}`,
              };
          await escalate(buildEscalation(task, fields));
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        // Decisive: the change is committed AND merged; moving the task to
        // done/ commits the outcome. markDone/appendDigest are non-critical
        // bookkeeping -- a throw here must NOT fall through to the backstop and
        // get mis-reported as a failed iteration, which would leave the
        // contradictory state "task in done/ + an 'unexpected error'
        // escalation". Best-effort, same [ts/fail-closed] discipline as
        // persistTokenUsage / teardown.
        await repo.moveTask(task.id, "active", "done");
        try {
          await repo.markDone(task.id, hash);
          await repo.appendDigest(`[conductor] committed ${task.id} -> ${hash} (${msg})`);
        } catch (err) {
          safeLog("WARN", `conductor: post-commit bookkeeping for ${task.id} failed (ignored): ${String(err)}`);
        }
        return { claimedTaskId: task.id, committed: true, rateLimited: false };
      }

      // anything else (ESCALATE, or a malformed/empty decision) -- fail-closed.
      await repo.moveTask(task.id, "active", "escalated");
      const escType: EscalationType = gv.constitution_touched.length > 0 ? "constitution" : "needs-guard";
      await escalate(
        buildEscalation(task, {
          reason: "gate did not COMMIT",
          type: escType,
          what: `Task ${task.id} gate decision: ${gv.decision}.`,
          decision: "Review the gate reasons and decide how to proceed.",
          optionA: "Approve manually.",
          optionB: "Reject and require rework.",
          costOfWrong: "Committing without gate approval can land an unguarded/uncovered contract change.",
          evidence: gv.reasons.join("\n"),
        }),
      );
      return { claimedTaskId: task.id, committed: false, rateLimited: false };
    } catch (err) {
      // Defense-in-depth backstop. Every EXPECTED outcome above moves the task
      // out of active/ and returns; only an UNEXPECTED throw (a git/fs/adapter
      // fault with no dedicated handler) reaches here. Without this catch such a
      // throw unwinds past the caller -- which merely logs it (server.ts
      // orchestrate `.catch`) -- and strands the task in active/ forever: no
      // escalation, no quarantine, no operator signal, and its file_set silently
      // locks every future same-file run. That is exactly how a thrown
      // mergeAfterGate precondition once left a task "stuck in ACTIVE". Fail
      // closed: surface the task to the operator (escalated/ + an escalation)
      // and resolve the iteration so the bounded run ends cleanly. Both steps
      // are wrapped so nothing here can re-throw out of the loop.
      const detail = err instanceof Error ? err.message : String(err);
      try {
        await repo.moveTask(task.id, "active", "escalated");
      } catch (moveErr) {
        safeLog("WARN", `conductor: backstop move for ${task.id} failed (ignored): ${String(moveErr)}`);
      }
      try {
        await escalate(
          buildEscalation(task, {
            reason: "conductor hit an unexpected error",
            type: "blocked",
            what: `Task ${task.id} processing threw before reaching a decision: ${detail}.`,
            decision: "Investigate the conductor error, fix the underlying cause, then re-queue.",
            optionA: "Fix the cause and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "An orphaned task silently locks its file_set and blocks every future same-file run.",
            evidence: err instanceof Error && err.stack ? err.stack : detail,
          }),
        );
      } catch (escErr) {
        safeLog("WARN", `conductor: backstop escalate for ${task.id} failed (ignored): ${String(escErr)}`);
      }
      safeLog("ERROR", `conductor: unexpected error processing ${task.id} (fail-closed to escalated): ${detail}`);
      return { claimedTaskId: task.id, committed: false, rateLimited: false };
    } finally {
      // Teardown is best-effort cleanup: a throw here must NEVER override the
      // iteration's already-decided result (e.g. turn a clean 429 return into a
      // rejected iteration that loses the rateLimited flag). Swallow + log.
      try {
        await worktree.teardown(wt);
      } catch (err) {
        safeLog("WARN", `conductor: worktree teardown for ${task.id} failed (ignored): ${String(err)}`);
      }
    }
  }

  async function run(opts?: ConductorRunOptions): Promise<void> {
    const branch = await git.currentBranch();
    if (branch === "main" || !new RegExp(cfg.allowedBranchPattern).test(branch)) {
      log("ERROR", `conductor: refusing to run on branch '${branch}' (must match ${cfg.allowedBranchPattern}, never main)`);
      throw new Error(`conductor: refusing to run on branch '${branch}' (must match ${cfg.allowedBranchPattern}, never main)`);
    }

    const startMs = clock.now();
    let iterations = 0;
    let commitsSinceDrift = 0;

    while (true) {
      if (clock.now() - startMs >= cfg.loop.maxSessionHours * 3600 * 1000) {
        log("INFO", "MaxSessionHours reached; stopping.");
        break;
      }

      const res = await runIteration();

      if (res.committed) {
        commitsSinceDrift++;
        if (commitsSinceDrift >= cfg.antiDrift.everyCommits) {
          const window = commitsSinceDrift;
          const line = await runAntiDrift({ sinceRef: `HEAD~${window}`, commitsSinceLast: window });
          if (/^\s*DRIFT:/i.test(line)) {
            await escalate(buildDriftEscalation(line, clock.now()));
          }
          commitsSinceDrift = 0;
        }
      }

      iterations++;
      if (opts?.once || (opts?.maxIterations !== undefined && iterations >= opts.maxIterations)) {
        break;
      }

      if (res.rateLimited) {
        await sleep(cfg.loop.rateLimitBackoffSeconds);
      } else if (res.claimedTaskId === null) {
        await sleep(cfg.loop.sleepSeconds);
      }
    }
  }

  return { runIteration, run };
}
