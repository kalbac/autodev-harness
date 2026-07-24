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
import type { Git, PorcelainEntry } from "../util/git.js";
import type { GateInput, GateVerdict } from "../gate/gate.js";
import type { EscalationInput, EscalationType } from "../escalate/escalate.js";
import type { AntiDriftInput } from "../anti-drift/anti-drift.js";
import { isNorthStarSilent } from "../anti-drift/north-star.js";
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";
import type { HarnessConfig } from "../config/schema.js";
import type { NormalizeResult } from "../normalize/eol.js";
import { AgentCiUnavailableError } from "../gate/agent-ci-exec.js";
import { workerTouched, strayChanged, forbiddenTouches } from "../util/fingerprint.js";
import { oracleGlobTouches, type OracleSet } from "../gate/oracle-paths.js";
import { globMatch, normalizePath } from "../util/glob.js";
import { buildTokenUsageDoc, type WorkerUsage, type CriticUsage } from "../usage/usage.js";
import { buildCriticVerdictDoc, type Verdict } from "../critic/verdict.js";
import { writeEvidence, EVIDENCE_FILE, type EvidenceDraft } from "../report/evidence.js";

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
  /** Optional dirty-tree preflight: the MAIN tree's porcelain entries (empty =
   *  clean). Wired at the composition root to `() => mainTreeStatus(mainRepoRoot)`.
   *  When omitted the warning is skipped (keeps the fake-driven tests untouched).
   *  Best-effort — a throw here must never abort a run. */
  mainTreeStatus?: () => Promise<PorcelainEntry[]>;
  /** Best-effort EOL normalization of the worker's changed files toward LF
   *  (`src/normalize/eol.ts`), called on the happy path AFTER the fences and BEFORE
   *  the diff, so the critic, the gate, and the commit all see LF. Optional so the
   *  fake-driven conductor tests are untouched; when omitted the step is skipped.
   *  Never throws (the module is best-effort). */
  normalizeEol?: (wt: Worktree, relPaths: string[]) => Promise<NormalizeResult>;
  /** May THROW on a broken operator config; the conductor treats a throw as fail-closed ESCALATE. */
  runGate: (input: GateInput, wt: Worktree) => Promise<GateVerdict>;
  /** Never-throws contract; still called defensively. */
  escalate: (input: EscalationInput) => Promise<unknown>;
  runAntiDrift: (input: AntiDriftInput) => Promise<string>;
  /** Read the project's north-star (`cfg.antiDrift.intentSource`, e.g. `.autodev/GOAL.md`)
   *  as raw text, or `null` when it is not configured, absent, or unreadable (every
   *  "could not read" collapses to `null` -- the fail-closed case for the unattended
   *  preflight, spec 2026-07-23). Wired at the composition root against the TRUSTED
   *  repoRoot, resolved identically to the anti-drift `readFile`. Consulted ONLY when a
   *  run's anti-drift policy sets `requireNorthStar`; omitted -> treated as silent (the
   *  conservative default). */
  readNorthStar?: () => Promise<string | null>;
  /** Append one decision-journal entry (`.autodev/decision-journal.ndjson`) so the
   *  morning report surfaces an unattended park/refusal (spec 2026-07-23). Best-effort:
   *  a throw is swallowed (the run's decision already stands; only the audit line is
   *  lost). Called ONLY on the two unattended anti-drift outcomes (north-star refusal,
   *  drift-halt); omitted -> journaling is skipped, which is how the fake-driven tests
   *  stay untouched. */
  writeDecision?: (entry: DecisionJournalEntry) => Promise<void>;
  /** Move <worktree>/worker-report.md -> runtimeDir/worker-report.md, called right after the
   * worker's rate-limit/timeout early-returns and BEFORE the status read + dirty-file fence
   * (parity spec §6): the report belongs in runtimeDir, never in the worktree. */
  harvestWorkerReport: (wt: Worktree, taskId: string) => Promise<void>;
  gitChangedPaths: (cwd: string) => Promise<string[]>;
  snapshotFingerprints: (cwd: string, rawPaths: string[]) => Map<string, string>;
  /** Resolve the current protected-oracle-artifact set (`adr/006` Phase 2): the guard
   *  test files, mutation recipes, agent-ci workflow files, and configured constitution
   *  paths a worker must never edit, regardless of what it declared in `file_set`. Built
   *  against the TRUSTED root at the composition root (`resolveOracleSet` in
   *  `gate/oracle-paths.ts`, wired at `composition/root.ts` against `repoRoot`, never
   *  `wt.path`) -- same "read from the trusted root, not the worktree" discipline as
   *  Phase 1's `loadInvariants`/`loadGuardPairs` above. May THROW on a broken operator
   *  declaration (an escaping `constitutionPaths` entry, a configured-but-missing
   *  contract file, ...); the conductor treats that throw as fail-closed ESCALATE,
   *  same contract as a throwing `runGate`. */
  resolveOracleSet: () => Promise<OracleSet>;
  zonesTouchedInDiff: (diff: string) => Promise<string[]>;
  /** Identity of the attached qualification profile, for the evidence ledger
   *  (spec 2026-07-22 "two reports"). Passed as a plain `{id, version}` rather
   *  than the `ResolvedProfile`, so `conductor/` does not depend on `profile/`.
   *  `null`/omitted = no profile attached, which the reports render as an
   *  explicit "no profile" rather than as a silent pass. */
  profileRef?: { id: string; version: number } | null;
  clock: { now: () => number };
  sleep: (seconds: number) => Promise<void>;
  log: (level: string, message: string) => void;
}

/**
 * How a run responds to the anti-drift check + whether it demands a written north-star
 * (spec 2026-07-23, `adr/004` last slice). Both enforcements live ABOVE the gate
 * (Principle 8): they park / stop / refuse; they never skip the critic or force a
 * commit. Attended runs use the default (below); the overnight supervisor passes
 * `{ onDrift: "halt-drain", requireNorthStar: true }`.
 */
export interface AntiDriftPolicy {
  /** What a `DRIFT:` verdict does. `"escalate-task"` (attended, default) escalates the
   *  current task and the drain continues -- the operator is present to steer.
   *  `"halt-drain"` (unattended) escalates AND stops the drain: cumulative drift means
   *  the whole direction is off, so continuing burns the night on more wrong code. */
  onDrift: "escalate-task" | "halt-drain";
  /** When true (unattended), a run refuses to process any task if the north-star is
   *  silent (absent/empty/still the scaffold stub) -- a fail-closed preflight that
   *  burns no worker tokens. Default false (attended): the operator may run a project
   *  whose GOAL is still a stub, because they are there to steer. */
  requireNorthStar: boolean;
}

/** The default anti-drift policy = today's attended behavior, byte-for-byte: a DRIFT
 *  escalates one task and the run continues, and no north-star is required. A run that
 *  omits `opts.antiDrift` gets exactly this, so every existing caller/test is untouched. */
const DEFAULT_ANTI_DRIFT_POLICY: AntiDriftPolicy = { onDrift: "escalate-task", requireNorthStar: false };

export interface ConductorRunOptions {
  once?: boolean;
  maxIterations?: number;
  /** Anti-drift response + north-star requirement for THIS run (spec 2026-07-23).
   *  Omitted = `DEFAULT_ANTI_DRIFT_POLICY` (attended behavior). Only the overnight
   *  supervisor sets a non-default policy. */
  antiDrift?: AntiDriftPolicy;
  /** Drain mode: keep processing while the queue yields claimable work and stop
   * the moment an iteration finds nothing to claim OR hits a rate limit. Used by
   * the orchestrator's trigger so ONE launch clears the whole pending pool (its
   * own batch + any pre-existing leftovers) instead of a fixed batch-count -- a
   * batch-sized bound can spend its iterations on other pending tasks and strand
   * its own (backlog B: orphaned PENDING). Stopping on rate-limit keeps the drain
   * bounded (a persistent 429 can't hold it open to maxSessionHours). */
  drain?: boolean;
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

/**
 * The synthetic escalation raised when an UNATTENDED run refuses to start because the
 * north-star is silent (spec 2026-07-23; `adr/004` "if the north star is silent ->
 * escalate to class 3"). Not tied to a real task -- the run never claimed one -- so it
 * uses the `(north-star)` sentinel taskId, mirroring `(anti-drift)` above. Type
 * `blocked`: it needs an operator (write the GOAL), it is not worker-fixable.
 */
function buildNorthStarEscalation(nowMs: number): EscalationInput {
  return {
    id: `north-star-${nowMs}`,
    taskId: "(north-star)",
    title: "No north-star -- cannot run unattended",
    reason: "north-star is silent",
    type: "blocked",
    what:
      "Unattended autonomy refused to run: the project north-star (.autodev/GOAL.md) is absent, " +
      "empty, or still the unfilled scaffold stub. An autonomous night must not build against an " +
      "intent that is not written down.",
    decision: "Fill in .autodev/GOAL.md (what it is / why / must do / must never do), then re-run.",
    optionA: "Write the north-star and let the overnight run proceed next window.",
    optionB: "Leave overnight autonomy off for this project until the goal is written.",
    costOfWrong: "Building autonomously against an unwritten intent risks a whole night of confidently-wrong work.",
    evidence: "isNorthStarSilent(.autodev/GOAL.md) = true (absent / empty / unfilled sentinel).",
  };
}

/**
 * Human-readable "why is this protected" for one oracle-fence hit (adr/006 Phase 2
 * escalation evidence). A LITERAL hit is keyed directly in `OracleSet.sources`. A
 * GLOB hit is keyed by the DECLARED glob pattern, not the touched path it matched --
 * `oracleGlobTouches` only proves set membership, it does not report which glob did
 * the matching -- so find the first declared glob that actually matches `hitPath`
 * and report ITS source instead.
 */
/**
 * Merge the two oracle-fence arms into ONE hit per real file (adr/006 Phase 2;
 * found by the s50 live proof). A protected file that is BOTH a declared literal
 * and covered by a declared glob is caught twice — once as `.github/workflows/ci.yml`
 * by the fs-fingerprint arm, once as `github/workflows/ci.yml` by the glob arm, whose
 * `normalizePath` strips the leading dot. Reported raw that read as "modified 2 oracle
 * artifact(s)" with one of the two paths visibly wrong: a single edit overstated as
 * two, which is exactly the kind of unearned claim Principle 13 forbids in our own
 * artifacts.
 *
 * Dedupe key is `normalizePath` (the only form in which the two arms' spellings
 * agree); the DISPLAYED path prefers the fs-fingerprint arm's, because that one is the
 * literal as declared — dot intact — while the glob arm's has been through the
 * `.TrimStart('./')` parity quirk. Kinds accumulate so the evidence still shows which
 * arm(s) caught it.
 */
function mergeOracleHits(driftPaths: string[], globPaths: string[]): { path: string; kinds: string[] }[] {
  const byKey = new Map<string, { path: string; kinds: string[] }>();
  const add = (p: string, kind: string): void => {
    const key = normalizePath(p);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    byKey.set(key, { path: p, kinds: [kind] });
  };
  // fs-fingerprint FIRST so its (undistorted) spelling wins the displayed path.
  for (const p of driftPaths) add(p, "fs-fingerprint");
  for (const p of globPaths) add(p, "glob");
  return [...byKey.values()];
}

function oracleSourceFor(hitPath: string, set: OracleSet): string {
  const direct = set.sources.get(hitPath);
  if (direct) return direct;
  const matchingGlob = set.globs.find((g) => globMatch(normalizePath(g), normalizePath(hitPath)));
  return (matchingGlob && set.sources.get(matchingGlob)) || "protected oracle path";
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
    mainTreeStatus,
    runGate,
    escalate,
    runAntiDrift,
    harvestWorkerReport,
    gitChangedPaths,
    snapshotFingerprints,
    resolveOracleSet,
    zonesTouchedInDiff,
    clock,
    sleep,
    log,
  } = deps;

  const profileRef = deps.profileRef ?? null;

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

  // safeJournal: best-effort decision-journal append for the two unattended anti-drift
  // outcomes (north-star refusal, drift-halt). The run's decision already stands by the
  // time we journal, so a write failure -- OR a throwing injected logger inside the
  // catch ([ts/fail-closed]) -- must never propagate. Omitted dep -> a silent no-op,
  // which keeps the fake-driven tests untouched.
  const safeJournal = async (entry: DecisionJournalEntry): Promise<void> => {
    try {
      await deps.writeDecision?.(entry);
    } catch (err) {
      safeLog("WARN", `conductor: decision-journal write failed (ignored): ${String(err)}`);
    }
  };

  // Tooling-churn dirs the New Project scaffold git-excludes; a TRACKED file under
  // one of these (e.g. a committed .serena/project.yml) can't be neutralized by
  // .git/info/exclude and needs `update-index --skip-worktree` instead.
  const CHURN_PREFIXES = [".serena/", ".autodev/"];
  const MAX_DIRTY_SHOWN = 10;

  /** Best-effort dirty-tree preflight (run start): a dirty MAIN tree makes
   *  `mergeAfterGate` refuse, so every gated commit escalates `blocked` instead of
   *  merging (gotchas `[conductor/real-repo-run]`, `[env/serena-churn-blocks-merge]`).
   *  Warn EARLY (before the loop) and, for TRACKED churn files that an exclude can't
   *  fix, point at the skip-worktree remedy. Never throws — a status failure must
   *  not abort the run. */
  async function warnIfMainTreeDirty(): Promise<void> {
    if (!mainTreeStatus) return;
    let entries: PorcelainEntry[];
    try {
      entries = await mainTreeStatus();
    } catch (err) {
      safeLog("WARN", `conductor: dirty-tree preflight skipped (git status failed): ${String(err)}`);
      return;
    }
    if (entries.length === 0) return;
    const shown = entries
      .slice(0, MAX_DIRTY_SHOWN)
      .map((e) => `${e.code} ${e.path}`)
      .join(", ");
    const more = entries.length > MAX_DIRTY_SHOWN ? `, +${entries.length - MAX_DIRTY_SHOWN} more` : "";
    safeLog(
      "WARN",
      `conductor: main working tree is not clean (${entries.length} path(s)): ${shown}${more}. ` +
        `A dirty main tree makes the worktree merge-back refuse, so gated commits will escalate 'blocked' instead of merging.`,
    );
    const trackedChurn = entries.filter(
      (e) => e.code !== "??" && CHURN_PREFIXES.some((p) => e.path.startsWith(p)),
    );
    if (trackedChurn.length > 0) {
      // Present the remedy as a TEMPLATE + the paths as a DATA list, NOT a single
      // ready-to-paste command with untrusted paths interpolated: no cross-shell
      // quoting is fully safe (double quotes still allow $()/backtick expansion in
      // POSIX & PowerShell), so a hostile filename in a copy-pasted one-liner would
      // be a footgun (codex Sev-2). The operator applies the template per path.
      const paths = trackedChurn.map((e) => e.path).join(", ");
      safeLog(
        "WARN",
        `conductor: ${trackedChurn.length} of these are TRACKED tooling-churn file(s) that .git/info/exclude cannot neutralize. ` +
          `Neutralize each with:  git update-index --skip-worktree -- <path>  (tracked churn paths: ${paths})`,
      );
    }
  }

  async function runIteration(): Promise<IterationResult> {
    // 1. CLAIM
    const task = await scheduler.claimNextTask();
    if (task === null) {
      return { claimedTaskId: null, committed: false, rateLimited: false };
    }

    // 2. CIRCUIT BREAKER
    const attempts = (await repo.getAttempts(task.id)) + 1;
    await repo.setAttempts(task.id, attempts);

    // EVIDENCE (spec 2026-07-22 "two reports"). Accumulated across this iteration
    // and written ONCE, in the `finally` below. The draft is mutable on purpose:
    // `runIteration` has more than a dozen decisive exits, and writing at each one
    // is a dozen chances to forget one -- the same reasoning that makes
    // gate-feedback.md write-or-clear from a single `finally`. The default outcome
    // is "abandoned": an exit that forgets to set one yields a record saying the
    // task ended without a recorded decision, which is honest, rather than one
    // claiming a success that never happened (Principle 10 -- fail toward the safe
    // state). `Task` carries no run id; run attribution comes from the run
    // manifest's `taskIds`, so `runId` stays null rather than inventing a field.
    // ONE clock read for both ends of the draft: `endedAt` is overwritten in the
    // `finally`, and starting it equal to `startedAt` keeps an unwritable-clock
    // edge case from producing an end BEFORE the start.
    //
    // The PREVIOUS iteration's record is removed FIRST, before any work: the write
    // in the `finally` is fail-soft (H6, it must never fail a task), so a failed
    // write would otherwise leave the stale record in place and the report would
    // repeat it. Concretely: a RETRY iteration records `abandoned`, the next
    // iteration commits, its evidence write fails -- and the task is `done` while
    // the ledger still says abandoned. Absent is the honest state (the store reports
    // it as missing evidence, H1); present-and-wrong is not. Best-effort itself:
    // `removeRuntimeFile` is idempotent for an absent file, and a failure to remove
    // must no more fail the iteration than a failure to write.
    try {
      await repo.removeRuntimeFile(task.id, EVIDENCE_FILE);
    } catch (err) {
      safeLog("WARN", `conductor: clearing stale evidence for ${task.id} failed (ignored): ${String(err)}`);
    }

    const startedAt = new Date(clock.now()).toISOString();
    const evidence: EvidenceDraft = {
      taskId: task.id,
      runId: null,
      title: task.title,
      type: task.type,
      fileSet: task.file_set,
      acceptance: task.acceptance,
      successCommands: task.success_commands,
      profile: profileRef,
      outcome: "abandoned",
      commit: null,
      escalation: null,
      rounds: 0,
      attempts,
      startedAt,
      endedAt: startedAt,
      critic: null,
      gate: null,
      profileGates: [],
      tokens: null,
    };

    /** Raise an escalation AND record it in the draft, from ONE `EscalationFields`
     *  object, so the recorded reason/type can never drift from the escalation the
     *  operator actually sees (docs/gotchas/validated-one-string-used-another.md).
     *  The draft is written before the await, so even a throwing `escalate` (the
     *  backstop calls this inside its own try/catch) still leaves the record set. */
    const escalateAndRecord = async (
      fields: EscalationFields,
      outcome: EvidenceDraft["outcome"] = "escalated",
    ): Promise<void> => {
      evidence.outcome = outcome;
      evidence.escalation = { type: fields.type, reason: fields.reason };
      await escalate(buildEscalation(task, fields));
    };

    // Token/usage accumulators (s22), hoisted ahead of the evidence `try` so the
    // single write in its `finally` can total them for ANY exit.
    const workerRuns: WorkerUsage[] = [];
    const criticRuns: CriticUsage[] = [];

    // The worktree, once created -- null on an exit that returns before it exists
    // (the circuit-breaker quarantine). Held out here because teardown now shares
    // the evidence `finally`.
    let createdWorktree: Worktree | null = null;

    try {
      if (attempts > cfg.loop.maxAttempts) {
        await repo.moveTask(task.id, "active", "quarantine");
        await escalateAndRecord(
          {
            reason: "circuit breaker tripped -- too many attempts",
            type: "poison",
            what: `Task ${task.id} exceeded max attempts (${attempts} > ${cfg.loop.maxAttempts}).`,
            decision: "Quarantine and investigate why this task cannot converge.",
            optionA: "Fix the task definition (file_set / acceptance / scope) and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "A poisoned task can burn unbounded attempts if left in the pending pool.",
            evidence: `attempts=${attempts} maxAttempts=${cfg.loop.maxAttempts}`,
          },
          "quarantined",
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
      createdWorktree = wt;

      // Token/usage accounting (s22): accumulate every worker + critic invocation
      // across all rounds of this task and persist a `token-usage.json` runtime
      // artifact. Best-effort by contract -- a write/aggregate failure must NEVER
      // break the enforcement loop or convert a decided iteration into a rejection
      // (same never-throws discipline as recordRun / digest / teardown, gotcha
      // [ts/fail-closed]). Served unchanged by the existing runtime-file endpoint.
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
          // ORACLE-PATH baseline (adr/006 Phase 2, closing the executable-input
          // residual Phase 1 left open -- see `docs/superpowers/plans/
          // 2026-07-22-adr006-phase2-executable-input-protected-paths.md`). Resolved
          // + fingerprinted BEFORE the worker runs, every round (a worker that only
          // touches the oracle on a LATER retry round must still be caught), on the
          // same footing as the dirty-file fence's own baseline just below: a worker
          // touch of a guard test / recipe / workflow / constitution literal must
          // register as drift even when that literal is gitignored (invisible to
          // `gitChangedPaths`) or sits INSIDE `file_set` (invisible to the
          // stray-check). A throw here (a broken GUARDS.md row, an escaping
          // `constitutionPaths` entry, a configured-but-missing contract file, ...)
          // is a broken operator config, not a worker-fixable one -- fail closed:
          // escalate `constitution` and never let a task run against an oracle set
          // this harness could not even resolve (Principle 10).
          let oracleSet: OracleSet;
          try {
            oracleSet = await resolveOracleSet();
          } catch (err) {
            await repo.moveTask(task.id, "active", "escalated");
            await escalateAndRecord({
              reason: "oracle-path set could not be resolved -- broken operator config",
              type: "constitution",
              what: `Task ${task.id}: resolveOracleSet threw before the worker ran: ${String(err)}.`,
              decision: "Fix the broken contract/guards/agent-ci declaration at the trusted root.",
              optionA: "Fix the config and re-queue.",
              optionB: "Abandon the task.",
              costOfWrong: "A gate that cannot resolve its own oracle set cannot protect anything this round.",
              evidence: String(err),
            });
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }
          const oracleBaseline = snapshotFingerprints(wt.path, oracleSet.literals);

          // Pre-worker fingerprint baseline.
          const basePaths = await gitChangedPaths(wt.path);
          const baseline = snapshotFingerprints(wt.path, basePaths);

          // WORKER
          // Read any persisted critic objection. Within a task's own retry loop
          // this is the feedback the previous round wrote; on a RE-CLAIM after an
          // escalation + reply-B (rework) it is the objection persisted at
          // escalation time, so the re-run's worker sees it even at round 0
          // (round starts at 0 on every fresh claim). Fixes
          // [rework/reply-b-drops-critic-feedback]: a fresh task's first claim has
          // no such file -> undefined (behavior unchanged); a reply-B re-claim
          // reads the durable objection. Task ids are unique per decompose, so the
          // only round-0-with-feedback case is a genuine re-claim (no cross-task bleed).
          const criticFeedback =
            (await repo.readRuntimeFile(task.id, "critic-feedback.md")) ?? undefined;
          // Same claim-time read as criticFeedback above, and the same rationale:
          // a gate RETRY (this task's own prior round) OR a re-claim after
          // escalation + reply-B both need the worker to see it at round 0. The
          // file is write-or-clear (`runGate`'s decisive-exit contract, gate.ts) --
          // absent means either "no prior gate run" or "the last gate run was
          // clean" -- so `?? undefined` collapsing "absent" and "empty" is correct
          // here the same way it already is for criticFeedback.
          const gateFeedback =
            (await repo.readRuntimeFile(task.id, "gate-feedback.md")) ?? undefined;
          const wr = await worker.run({
            task,
            worktreePath: wt.path,
            ladder,
            runtimeDir,
            ...(criticFeedback !== undefined ? { criticFeedback } : {}),
            ...(gateFeedback !== undefined ? { gateFeedback } : {}),
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
            await escalateAndRecord(
              {
                reason: "worker reported task too big",
                type: "blocked",
                what: `Task ${task.id} worker report status TOO_BIG.`,
                decision: "Split the task into smaller pieces and re-queue.",
                optionA: "Split the task.",
                optionB: "Abandon the task.",
                costOfWrong: "An oversized task will keep failing and burning attempts.",
                evidence: report,
              },
              "quarantined",
            );
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }
          if (status === "NEEDS_GUARD") {
            await repo.moveTask(task.id, "active", "escalated");
            await escalateAndRecord({
              reason: "worker reported it needs a guard",
              type: "needs-guard",
              what: `Task ${task.id} worker report status NEEDS_GUARD.`,
              decision: "Author/bless a mutation-verified guard for the touched contract zone.",
              optionA: "Add the guard and re-queue.",
              optionB: "Reject the change.",
              costOfWrong: "An unguarded contract-zone change cannot be safely auto-committed.",
              evidence: report,
            });
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }
          if (status === "BLOCKED") {
            await repo.moveTask(task.id, "active", "escalated");
            await escalateAndRecord({
              reason: "worker reported it is blocked",
              type: "blocked",
              what: `Task ${task.id} worker report status BLOCKED.`,
              decision: "Unblock the task (missing dependency / access / decision).",
              optionA: "Unblock and re-queue.",
              optionB: "Abandon the task.",
              costOfWrong: "A blocked task cannot make progress and will keep failing.",
              evidence: report,
            });
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }
          // (DONE / anything else falls through to the fence.)

          // POST-WORKER TOUCHED SET -- computed once, ahead of BOTH checks that
          // consume it below (the oracle glob arm, then the stray/forbidden fence),
          // so there is exactly one gitChangedPaths/snapshotFingerprints round trip
          // for "what changed" (unchanged cost vs. before this task).
          const nowPaths = await gitChangedPaths(wt.path);
          const now = snapshotFingerprints(wt.path, nowPaths);
          const touched = workerTouched(baseline, now);

          // ORACLE-PATH FENCE (adr/006 Phase 2). Runs BEFORE the stray/forbidden
          // fence below so an oracle touch is reported with its SPECIFIC reason
          // ("the worker edited the oracle") instead of the generic "out of scope"
          // a plain dirty-file escalation would give -- an oracle file outside
          // `file_set` would otherwise be caught by `strayChanged` first and
          // reported as `dirty-file` (spec: order matters). Two arms, matching
          // `OracleSet`'s two guarantees: `literals` are fingerprinted DIRECTLY on
          // disk (`oracleBaseline`/`oracleAfter`), covering a gitignored oracle file
          // `touched` would never see; `globs` are matched against the SAME
          // git-visible `touched` set the fence below uses (accepted residual: a
          // gitignored path matching only a glob stays uncovered -- see the Phase 2
          // spec's "Accepted residuals").
          const oracleAfter = snapshotFingerprints(wt.path, oracleSet.literals);
          const oracleDrift = workerTouched(oracleBaseline, oracleAfter);
          const oracleGlobHits = oracleGlobTouches(touched, oracleSet.globs);
          if (oracleDrift.length > 0 || oracleGlobHits.length > 0) {
            await repo.moveTask(task.id, "active", "escalated");
            const hits = mergeOracleHits(oracleDrift, oracleGlobHits);
            const oracleEvidence = hits
              .map((h) => `${h.path}  (${oracleSourceFor(h.path, oracleSet)})  [${h.kinds.join("+")}]`)
              .join("\n");
            await escalateAndRecord({
              reason: "worker touched a protected oracle path",
              type: "constitution",
              what: `Task ${task.id} modified ${hits.length} oracle artifact(s) -- the files that define what "pass" means.`,
              decision: "Bless the oracle change explicitly, or reject it.",
              optionA:
                "Bless: apply the oracle change yourself at the trusted root, then re-queue the task without it in file_set.",
              optionB: "Reject the change.",
              costOfWrong: "A worker-authored oracle edit lets the next run be judged against a standard the worker chose.",
              evidence: oracleEvidence,
            });
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }

          // DIRTY-FILE FENCE
          const stray = strayChanged(touched, task.file_set, cfg.dirtyFenceIgnore);
          const forbidden = forbiddenTouches(touched, task.forbidden_paths);
          if (stray.length > 0 || forbidden.length > 0) {
            await repo.moveTask(task.id, "active", "escalated");
            await escalateAndRecord({
              reason: "worker touched files outside its declared scope",
              type: "dirty-file",
              what: `Task ${task.id} touched files outside file_set and/or forbidden_paths.`,
              decision: "Review the stray/forbidden touches before allowing this task to land.",
              optionA: "Approve the extra scope and re-queue with an updated file_set.",
              optionB: "Reject the change.",
              costOfWrong: "An unreviewed out-of-scope write can silently corrupt other tasks' territory.",
              evidence: `stray: ${stray.join(", ")}\nforbidden: ${forbidden.join(", ")}`,
            });
            return { claimedTaskId: task.id, committed: false, rateLimited: false };
          }

          // EOL NORMALIZATION -- the worker's Windows editor may have written CRLF, an
          // environmental artifact the WPCS line-ending sniff would (correctly, on that
          // platform) red on a brand-new file. Normalize the worker's changed files
          // toward LF per the target repo's .gitattributes (default LF) BEFORE the diff,
          // so the critic, the gate, and the commit all see the same LF content. Scoped
          // to `touched` -- the files that actually changed; strays already escalated
          // above. Best-effort: the module never throws, so no try/catch is needed here.
          if (deps.normalizeEol && touched.length > 0) {
            const eolResult = await deps.normalizeEol(wt, touched);
            if (eolResult.normalized.length > 0) {
              safeLog(
                "INFO",
                `conductor: normalized CRLF->LF in ${eolResult.normalized.length} file(s): ${eolResult.normalized.join(", ")}`,
              );
            }
          }

          // DIFF + CRITIC
          const diff = await worktree.diff(wt, task.file_set);
          await repo.writeRuntimeFile(task.id, "diff.patch", diff);
          // Pin the loop branch this diff was captured on, so a later apply-on-accept
          // (operator override) can refuse to replay it onto a DIFFERENT branch.
          await repo.writeRuntimeFile(task.id, "loop-branch", loopBranch);
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
            evidence.rounds = round;
            evidence.critic = { verdict: cr.verdict.verdict, confidence: cr.verdict.confidence };
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
            // Persist the critic's objection as durable rework feedback so a
            // reply-B (rework) re-run reads it at round 0 on re-claim
            // ([rework/reply-b-drops-critic-feedback]). Without this the escalation
            // branch wrote only critic-verdict.json (not read by the worker), so a
            // reworked task reproduced the same diff. Same content shape as the
            // in-loop retry branch below (notes, or a generic fallback).
            await repo.writeRuntimeFile(
              task.id,
              "critic-feedback.md",
              cr.verdict?.notes ?? "critic returned no parseable verdict; make the smallest, clearest change and retry.",
            );
            const escType: EscalationType = cr.verdict?.verdict === "broken" ? "disagreement" : "uncertain";
            await repo.moveTask(task.id, "active", "escalated");
            evidence.rounds = round;
            if (cr.verdict) {
              evidence.critic = { verdict: cr.verdict.verdict, confidence: cr.verdict.confidence };
            }
            await escalateAndRecord({
              reason: "critic did not return a clean verdict",
              type: escType,
              what: `Task ${task.id} critic verdict: ${cr.verdict?.verdict ?? "(unparseable)"}.`,
              decision: "Review the critic notes and diff, decide whether to accept or reject.",
              optionA: "Accept the change despite the critic's concerns.",
              optionB: "Reject and require rework.",
              costOfWrong: "Committing a broken/uncertain contract-zone change can silently break behavior.",
              evidence: cr.verdict?.notes ?? "critic returned no parseable verdict",
            });
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
        } catch (err) {
          await repo.moveTask(task.id, "active", "escalated");
          const escType: EscalationType = task.contract_zones_touched.length > 0 ? "constitution" : "needs-guard";
          const isUnavailable = err instanceof AgentCiUnavailableError;
          const reason = isUnavailable
            ? err.detail
            : "gate threw -- broken operator config";
          const decision = isUnavailable
            ? "Install WSL (Windows) or run the daemon on Linux/Mac, then re-queue -- or disable gate.agentCi."
            : "Fix the broken gate config (INVARIANTS.md / GUARDS.md / check command) before retrying.";
          await escalateAndRecord({
            reason,
            type: escType,
            what: `Task ${task.id} gate invocation threw.`,
            decision,
            optionA: isUnavailable ? "Enable WSL / switch platform and re-queue." : "Fix the config and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "A broken gate config cannot safely judge ANY task, not just this one.",
            evidence: `taskId=${task.id}${isUnavailable ? ` reason=${err.reason}` : ""}`,
          });
          return { claimedTaskId: task.id, committed: false, rateLimited: false };
        }

        // The verdict is evidence regardless of which way it decides: recorded ONCE
        // here, right after the gate returned, so every decision branch below
        // (COMMIT / RETRY / ESCALATE) carries it without a per-branch copy.
        evidence.gate = {
          decision: gv.decision,
          composer_green: gv.composer_green,
          success_green: gv.success_green,
          agent_ci_green: gv.agent_ci_green,
          profile_green: gv.profile_green,
          constitution_touched: gv.constitution_touched,
          zones: gv.zones_touched.map((z) => ({
            id: z.id,
            guarded: z.guarded,
            mutation_passed: z.mutation_passed,
            blessed: z.blessed,
          })),
          changed_files: gv.changed_files,
        };
        evidence.profileGates = gv.profile_gates;

        // 5. DECISION
        if (gv.decision === "RETRY") {
          await repo.moveTask(task.id, "active", "pending");
          // Deliberately left "abandoned": the task goes back to pending, so THIS
          // iteration decided nothing about the product. The next iteration
          // overwrites the record -- the artifact must describe the most recent run.
          evidence.outcome = "abandoned";
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
            await escalateAndRecord({
              reason: "branch moved before commit",
              type: "blocked",
              what: `Task ${task.id} gate said COMMIT but HEAD moved from '${loopBranch}' to '${cur}' (or off the allowed pattern).`,
              decision: "Restore the loop branch and re-run, or abandon.",
              optionA: "Restore the branch and re-queue.",
              optionB: "Abandon the task.",
              costOfWrong: "Committing/merging on the wrong branch could land the change on main or a stale branch.",
              evidence: `currentBranch=${cur} loopBranch=${loopBranch} allowedPattern=${cfg.allowedBranchPattern}`,
            });
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
            await escalateAndRecord(fields);
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
          evidence.outcome = "committed";
          evidence.commit = hash;
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
        await escalateAndRecord({
          reason: "gate did not COMMIT",
          type: escType,
          what: `Task ${task.id} gate decision: ${gv.decision}.`,
          decision: "Review the gate reasons and decide how to proceed.",
          optionA: "Approve manually.",
          optionB: "Reject and require rework.",
          costOfWrong: "Committing without gate approval can land an unguarded/uncovered contract change.",
          evidence: gv.reasons.join("\n"),
        });
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
          await escalateAndRecord({
            reason: "conductor hit an unexpected error",
            type: "blocked",
            what: `Task ${task.id} processing threw before reaching a decision: ${detail}.`,
            decision: "Investigate the conductor error, fix the underlying cause, then re-queue.",
            optionA: "Fix the cause and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "An orphaned task silently locks its file_set and blocks every future same-file run.",
            evidence: err instanceof Error && err.stack ? err.stack : detail,
          });
        } catch (escErr) {
          safeLog("WARN", `conductor: backstop escalate for ${task.id} failed (ignored): ${String(escErr)}`);
        }
        safeLog("ERROR", `conductor: unexpected error processing ${task.id} (fail-closed to escalated): ${detail}`);
        return { claimedTaskId: task.id, committed: false, rateLimited: false };
      }
    } finally {
      // EVIDENCE FIRST, teardown second. This is the ONE write of the record:
      // every decisive exit above only ASSIGNS to the draft, so no exit can forget
      // to persist it -- including the circuit-breaker quarantine, which returns
      // before a worktree exists and therefore used to sit outside any `finally`.
      // Ordering is load-bearing: a teardown failure must not be able to cost us
      // the record. `writeEvidence` is fail-soft by contract (H6) -- bookkeeping
      // ABOUT the enforcement loop must never be able to fail the loop.
      evidence.endedAt = new Date(clock.now()).toISOString();
      evidence.tokens = {
        worker_total: workerRuns.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0),
        critic_total: criticRuns.reduce((n, r) => n + r.tokens, 0),
      };
      await writeEvidence(evidence, {
        write: (id, name, content) => repo.writeRuntimeFile(id, name, content),
        log: safeLog,
      });

      // Teardown is best-effort cleanup: a throw here must NEVER override the
      // iteration's already-decided result (e.g. turn a clean 429 return into a
      // rejected iteration that loses the rateLimited flag). Swallow + log.
      if (createdWorktree !== null) {
        try {
          await worktree.teardown(createdWorktree);
        } catch (err) {
          safeLog("WARN", `conductor: worktree teardown for ${task.id} failed (ignored): ${String(err)}`);
        }
      }
    }
  }

  async function run(opts?: ConductorRunOptions): Promise<void> {
    const branch = await git.currentBranch();
    if (branch === "main" || !new RegExp(cfg.allowedBranchPattern).test(branch)) {
      log("ERROR", `conductor: refusing to run on branch '${branch}' (must match ${cfg.allowedBranchPattern}, never main)`);
      throw new Error(`conductor: refusing to run on branch '${branch}' (must match ${cfg.allowedBranchPattern}, never main)`);
    }

    await warnIfMainTreeDirty();

    const policy = opts?.antiDrift ?? DEFAULT_ANTI_DRIFT_POLICY;

    // North-star preflight (spec 2026-07-23; Principle 10). Only the unattended path
    // sets `requireNorthStar`; when it does, a silent north-star fail-CLOSES the whole
    // run BEFORE any task is claimed -- no worktree, no worker tokens. Every "could not
    // read" collapses to `null` in `readNorthStar`, and `null` reads as silent, so an
    // unreadable GOAL.md refuses rather than proceeds (cannot confirm intent -> do not
    // build). The refusal is an operator escalation + a decision-journal park so the
    // morning report surfaces it.
    if (policy.requireNorthStar) {
      const readNorthStar = deps.readNorthStar ?? (async () => null);
      let northStar: string | null;
      try {
        northStar = await readNorthStar();
      } catch (err) {
        // Defensive: readNorthStar is contracted to map its own failures to null, but
        // if it throws anyway, treat that as silent (fail-closed) rather than crash.
        northStar = null;
        safeLog("WARN", `conductor: north-star read threw (${String(err)}); treating as silent.`);
      }
      if (isNorthStarSilent(northStar)) {
        const nowMs = clock.now();
        await escalate(buildNorthStarEscalation(nowMs));
        await safeJournal({
          ts: new Date(nowMs).toISOString(),
          taskId: "(north-star)",
          escalationType: "blocked",
          decision: "park",
          reworkCount: 0,
          reason: "no north-star: refusing to run unattended until .autodev/GOAL.md is written",
          reversible: true,
        });
        safeLog("INFO", "conductor: north-star is silent -> refusing to run unattended (no tasks claimed).");
        return;
      }
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
            // Unattended (halt-drain): cumulative drift means the whole direction is off,
            // so stop claiming further tasks rather than burn the night building more of
            // the wrong thing (spec 2026-07-23). The drifted task is ALREADY parked by the
            // escalation above; this only stops MORE work. Attended (escalate-task) leaves
            // the loop running -- the operator is present to decide (regression-pinned).
            if (policy.onDrift === "halt-drain") {
              await safeJournal({
                ts: new Date(clock.now()).toISOString(),
                taskId: "(anti-drift)",
                escalationType: "drift",
                decision: "park",
                reworkCount: 0,
                reason: `drift: halting the unattended drain -- ${line}`,
                reversible: true,
              });
              safeLog("INFO", "conductor: DRIFT under the unattended policy -> halting the drain.");
              break;
            }
          }
          commitsSinceDrift = 0;
        }
      }

      iterations++;
      if (opts?.once || (opts?.maxIterations !== undefined && iterations >= opts.maxIterations)) {
        break;
      }

      // Drain mode: stop as soon as the queue can't yield further progress --
      // either nothing is claimable (idle) OR the run hit a rate limit. A
      // dep-blocked task is not claimable, so it correctly stays pending without
      // spinning. A rate limit means the API is throttled: rate-limited tasks
      // refund their attempt (the circuit breaker never advances), so continuing
      // to retry would just hammer the throttled API and could hold a drain open
      // to maxSessionHours -- instead we stop and leave the rate-limited/remaining
      // tasks pending for a follow-up trigger. This keeps a drain BOUNDED while
      // still clearing the whole claimable pool in one pass (prevents orphaned
      // PENDING, backlog B).
      if (opts?.drain && (res.claimedTaskId === null || res.rateLimited)) {
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
