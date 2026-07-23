// Composition root: wires ONE project's full dependency graph (config, blackboard
// repo, scheduler, worktree manager, router, git, worker/critic adapters,
// contract-zone plumbing, gate, escalate, anti-drift, conductor, orchestrator).
// Extracted from src/index.ts (originally the daemon's inline `main()` wiring,
// used for the single cwd-detected repoRoot) so a later task can build one
// ProjectRoot per registered project (hub + registry) without duplicating this
// wiring. This module is integration glue that spawns real `claude`/`codex`/`git`,
// so it is deliberately NOT unit-tested; every module it wires already has its
// own unit tests against injected fakes (same status as src/index.ts).
import { readFile, writeFile, appendFile, mkdir, lstat, readdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { loadConfigWithRaw, isPlannerExplicitlyConfigured, isContractFileConfigured } from "../config/config.js";
import { realpathContains } from "../util/path-contain.js";
import { readBoundedFileText, MAX_BOUNDED_READ_BYTES } from "../util/bounded-read.js";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import { createScheduler } from "../scheduler/scheduler.js";
import { createWorktreeManager, type Worktree } from "../worktree/worktree.js";
import { createRouter } from "../router/router.js";
import { createGit, mainTreeStatus } from "../util/git.js";
import { applyOnAccept as runApplyOnAccept, type ApplyOnAcceptResult } from "../apply/apply-on-accept.js";
import { runNative } from "../util/native.js";
import { ClaudeWorkerAdapter } from "../worker/claude-adapter.js";
import type { WorkerAdapter } from "../worker/adapter.js";
import { RealWatchedProcessRunner } from "../watchdog/watchdog.js";
import { CodexCriticAdapter } from "../critic/codex-adapter.js";
import type { CriticAdapter } from "../critic/adapter.js";
import { assertKnownAdapters, heterogeneityWarnings, resolveWorkerExe } from "../config/roles.js";
import {
  createEnqueueCapability,
  createReadCapability,
  createRecordRunCapability,
  createReportCapability,
  buildReadSnapshot,
  slugifyIntent,
  type OrchestratorCapabilities,
} from "../orchestrator/capabilities.js";
import { isPathSafeId } from "../orchestrator/task-spec.js";
import { refreshExecutionReports, type RunListEntry } from "../report/report-service.js";
import { loadEvidence, EVIDENCE_FILE } from "../report/evidence-store.js";
import { buildQualificationReport, type QualificationReport } from "../report/qualification-report.js";
import { renderQualificationReport } from "../report/render.js";
import {
  buildMorningReport,
  renderMorningReport,
  buildMorningReportPrompt,
  type MorningReport,
} from "../report/morning-report.js";
import { resolveOrchestratorExe } from "../config/roles.js";
import { ThreadStore } from "../thread/thread-store.js";
import { ThreadEventBus } from "../api/thread-events.js";
import { ThreadChatService } from "../orchestrator/thread-chat-service.js";
import { performLaunch } from "../orchestrator/launch.js";
import { NarratorService } from "../orchestrator/narrator/narrator-service.js";
import { runOrchestratorOneShot } from "../orchestrator/narrator/orchestrator-oneshot.js";
import { buildRunSnapshot, type RunSnapshotReader } from "../orchestrator/narrator/run-snapshot.js";
import type { RunSnapshot, TaskSnapshot } from "../orchestrator/narrator/activity-map.js";
import type { QueueState } from "../blackboard/repository.js";
import { ClaudeOrchestratorAdapter } from "../orchestrator/claude-orchestrator-adapter.js";
import type { OrchestratorAdapter } from "../orchestrator/adapter.js";
import { createOrchestrator, type OrchestratorResult } from "../orchestrator/orchestrator.js";
import { ChatSessionManager } from "../orchestrator/chat-session-manager.js";
import { ClaudeOrchestratorChatAdapter } from "../orchestrator/claude-orchestrator-chat-adapter.js";
import type { OrchestratorChatAdapter } from "../orchestrator/chat-adapter.js";
import { runGate as runGateCore, type GateDeps, type GateInput, type GateVerdict } from "../gate/gate.js";
import { runAgentCiWorkflows, spawnAgentCiStream, detectAgentCiCapability, worktreeGitDirWsl } from "../gate/agent-ci.js";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";
import { CiEventBus } from "../api/ci-events.js";
import { foldCiStatus, initialCiStatus } from "../gate/ci-status.js";
import { parseInvariants, zoneTouched, diffAddedRemovedLines, type Invariants } from "../gate/invariants.js";
import {
  parseGuardsTable,
  isMutationVerified,
  type GuardRow,
  type GuardRecipePair,
  type GuardRecipe,
} from "../gate/guards.js";
import { mutationCheck, type MutationRecipe } from "../gate/mutation-check.js";
import { escalate as escalateCore, type EscalationInput } from "../escalate/escalate.js";
import { runAntiDrift as runAntiDriftCore, type AntiDriftInput } from "../anti-drift/anti-drift.js";
import { snapshot } from "../util/fingerprint.js";

import { resolveOracleSet, type OracleSet } from "../gate/oracle-paths.js";
import { loadProfile, prepareGateInvocation, classifyGateExit } from "../profile/profile.js";
import { parseCheckstyle } from "../gate/checkstyle.js";
import { filterFindings } from "../gate/finding-filter.js";
import type { AddedLines } from "../gate/diff-lines.js";
import type { ProfileGateRecord } from "../gate/profile-gate-record.js";
import { globMatch } from "../util/glob.js";
import { harvestWorkerReport as harvestWorkerReportCore } from "../worker/report.js";
import { createConductor, type Conductor, type ConductorDeps, type ConductorRunOptions } from "../conductor/conductor.js";
import { normalizeWorktreeEol, makeNormalizeEolDeps } from "../normalize/eol.js";
import { createLogger, type Logger } from "../util/log.js";
import type { HarnessConfig } from "../config/schema.js";
import { superviseOvernight, parseReworkCount } from "../autonomy/overnight-supervisor.js";
import { serializeDecision, parseDecisionJournal } from "../autonomy/decision-journal.js";
import { parseEscalation } from "../escalate/escalate.js";
import { loadSettings, defaultSettingsFile } from "../settings/settings.js";

const EMPTY_INVARIANTS: Invariants = { version: 1, updated: "", contract_zones: [], constitution: { path_globs: [] } };

/** Split a shell-style single-line command into `[cmd, ...args]`, guarding the noUncheckedIndexedAccess `[0]`. */
function splitCommand(cmd: string): { c: string; a: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const c = parts[0];
  if (!c) throw new Error(`splitCommand: empty command: ${JSON.stringify(cmd)}`);
  return { c, a: parts.slice(1) };
}

/**
 * The run options the overnight supervisor may inherit. `once` is DROPPED:
 * `conductor.run` evaluates `once` before `drain` (conductor.ts:705 vs :719), so
 * an inherited `once: true` would collapse the supervisor's queue-wide drain into
 * a single iteration. Every other bound (maxIterations, ...) is preserved -- the
 * operator's limits still apply, only the incompatible one is removed.
 */
export function supervisorRunOpts(runOpts: ConductorRunOptions | undefined): ConductorRunOptions {
  const { once: _once, ...rest } = runOpts ?? {};
  return rest;
}

/** Reads daemon-global operator presence. Injected so tests never touch `~`, and
 *  called FRESH per run so a toggle click takes effect on the next trigger with
 *  no cache to invalidate (unlike `cfg`, which a live ProjectRoot captures once
 *  -- see hub.ts:26). */
export type PresenceReader = () => Promise<boolean>;

/**
 * Overnight autonomy runs on the AND of daemon-global operator presence and the
 * project's own opt-in (spec 2026-07-19). Order matters twice over: the project
 * opt-in is checked first so the common attended case does no file IO, and ANY
 * presence-read failure resolves to `false` -- the system must never fall INTO
 * autonomy by accident.
 */
export async function shouldSupervise(presence: PresenceReader, projectOptIn: boolean): Promise<boolean> {
  if (!projectOptIn) return false;
  try {
    return await presence();
  } catch {
    return false;
  }
}

/** Why a candidate oracle-definition path was not readable (`resolveContainedOracleFile`
 *  below). Kept distinct from a plain `null` so callers can compose an actionable,
 *  specific error message instead of a generic "missing" (Principle 10/14). */
type OracleUnreadableReason = "absent" | "escaped-root" | "symlinked";

type OracleFileResolution = { readable: true; path: string } | { readable: false; reason: OracleUnreadableReason };

/**
 * Resolve `<root>/<relPath>` as a trusted oracle-DEFINITION file and verify FULL
 * containment under `root` -- not just the lexical `join` the callers used to do
 * before `adr/006` Phase 1 (codex-flagged: `join` does not clamp `..`, and a plain
 * `readFile` follows symlinks). Two escapes a lexical `..`-check alone misses (this
 * repo's precedent: `docs/gotchas/static-file-serving-symlink-traversal.md`):
 *
 *   1. `relPath` itself walks out via `..` (e.g. `../some-worktree/INVARIANTS.md`).
 *   2. An INTERMEDIATE ancestor directory between `root` and the leaf is a symlink
 *      pointing outside `root` -- lexically the joined path still LOOKS like it's
 *      under `root`, but the real file lives elsewhere (a worker-controlled
 *      worktree, in the threat model this closes).
 *
 * Both are closed the same way industry static servers do: canonicalize (`realpath`)
 * BOTH `root` and the candidate, then require the candidate's canonical form to be
 * `root` itself or a descendant of it -- via the SHARED `realpathContains` primitive
 * (`src/util/path-contain.ts`), not a private copy of the comparison here. That
 * module also carries the drive-root/UNC-share trailing-separator fix (round-2 fix
 * 3): a plain `canonicalRoot + sep` prefix build rejects every legitimate child of a
 * canonical Windows drive root (`C:\`) because `realpath` returns such a root WITH
 * its trailing separator already attached, doubling it in the prefix. `root.ts` uses
 * the shared helper rather than keeping its own copy so this repo has exactly ONE
 * containment implementation to get right and to fix, not two that can drift back
 * out of sync with each other (the same drift that let `healOneContractStub` in
 * `scaffold.ts` keep a lexical check after this file's read path had already moved
 * on to realpath containment).
 *
 * The FINAL path component must ALSO not itself be a symlink -- checked via `lstat`
 * (never `stat`/`existsSync`, which follow it) BEFORE any realpath containment check,
 * so a symlinked leaf is rejected outright even when its target happens to resolve
 * inside `root`. Mirrors `docs/gotchas/scaffold-symlink-escape.md`'s "lstat before
 * trusting a path" discipline, applied here to a READ instead of a write.
 *
 * Returns a `reason`, not just `null`/boolean, precisely so `loadInvariantsFrom` /
 * `loadGuardPairsFrom` below can name what went wrong when a CONFIGURED path fails
 * this check (fail-closed, Principle 10/14) -- and so the not-configured path can
 * still collapse "absent" and "blocked by a symlink/escape" into the SAME legitimate
 * empty result (Principle 10: no oracle declared is fine; a worker-controlled link
 * silently masquerading as "no oracle" is not something this function needs to
 * distinguish for that caller -- the configured branch is what actually enforces).
 *
 * KNOWN, ACCEPTED RESIDUAL (do not "fix" without re-reading the reasoning): a
 * `realpath` -> later `readFile`-by-path TOCTOU window remains between this
 * function's checks and its caller's subsequent read -- an adversary who could mutate
 * an intermediate directory into a symlink between the two calls could still redirect
 * the read. Exploiting it needs an actor with write access to the TRUSTED root
 * (`repoRoot`) itself mid-gate-run; the worker only ever writes its own worktree, never
 * `repoRoot`, so this is outside this harness's threat model. This repo has an
 * identical accepted residual, for the identical reason, already documented in
 * `docs/gotchas/static-file-serving-symlink-traversal.md` (closing it needs
 * `openat2`/`RESOLVE_BENEATH`, which Node exposes on no platform portably).
 */
async function resolveContainedOracleFile(root: string, relPath: string): Promise<OracleFileResolution> {
  const p = join(root, relPath);
  let lst;
  try {
    lst = await lstat(p);
  } catch {
    return { readable: false, reason: "absent" };
  }
  if (lst.isSymbolicLink()) return { readable: false, reason: "symlinked" };
  if (!lst.isFile()) return { readable: false, reason: "absent" }; // directory/fifo/etc -- nothing readable here

  if (!(await realpathContains(root, p))) {
    return { readable: false, reason: "escaped-root" }; // intermediate symlinked dir, a `..` escape, or root itself unresolvable
  }
  return { readable: true, path: p };
}

/** Compose the "why unreadable" clause for the fail-closed loader errors below. The
 *  `"absent"` wording is BYTE-IDENTICAL to the pre-containment-check message (root.test.ts
 *  tests 7/9 assert on it) -- only `"escaped-root"`/`"symlinked"` are new text. */
function oracleUnreadableClause(root: string, reason: OracleUnreadableReason): string {
  switch (reason) {
    case "absent":
      return `is not readable at the trusted root '${root}'`;
    case "escaped-root":
      return `resolves OUTSIDE the trusted root '${root}' (an intermediate symlinked directory or a '..' path segment escapes it)`;
    case "symlinked":
      return `resolves through a symlink under the trusted root '${root}' (the final path component is a link, not a real file)`;
  }
}

/**
 * Parse `<root>/<cfg.contract.invariantsFile>` -- oracle-DEFINITION read, always against
 * a TRUSTED root (`adr/006` Phase 1, closing `[gate/oracle-read-from-worktree]`). Resolves
 * via `resolveContainedOracleFile` (full realpath containment + final-component symlink
 * refusal, not a lexical `join`), then branches two ways, by design (Principle 10 -- fail
 * toward the safe state):
 *
 *   - NOT explicitly configured in `raw` -> `EMPTY_INVARIANTS` (today's behavior; most
 *     projects declare no oracle and that is legitimate — a zero-zone gate, not a broken one).
 *   - explicitly configured (`raw.contract.invariantsFile !== undefined`) -> THROWS whenever
 *     the file is absent, escapes the trusted root, or is reached through a symlink. A
 *     configured-but-unreadable oracle is an operator-config error, not a worker-fixable
 *     one; `runGate` deliberately rejects on a loader throw (gate.ts) and the conductor
 *     treats that as `broken -- operator config` -- no new escalation plumbing needed.
 *
 * An unparseable (but present) file already throws via `parseInvariants` -- unchanged.
 *
 * Hoisted out of `buildProjectRoot` (module scope, `cfg`/`raw`/`root` passed explicitly
 * rather than closed over) so this trusted-root / fail-closed contract is directly unit-
 * testable without the full ProjectRoot wiring — see root.test.ts's "trusted-root reads"
 * suite. `gateDeps(wt)` and `zonesTouchedInDiff` below both call this with `repoRoot`.
 */
export async function loadInvariantsFrom(
  cfg: HarnessConfig,
  raw: Record<string, unknown>,
  root: string,
): Promise<Invariants> {
  const resolution = await resolveContainedOracleFile(root, cfg.contract.invariantsFile);
  if (!resolution.readable) {
    if (isContractFileConfigured(raw, "invariantsFile")) {
      throw new Error(
        `contract.invariantsFile is configured ('${cfg.contract.invariantsFile}') but ` +
          `${oracleUnreadableClause(root, resolution.reason)} -- the gate cannot judge against ` +
          `a missing oracle (adr/006 Phase 1)`,
      );
    }
    return EMPTY_INVARIANTS;
  }
  const text = await readFile(resolution.path, "utf8");
  if (text.trim() === "") return EMPTY_INVARIANTS;
  return parseInvariants(text);
}

/**
 * Parse `<root>/<cfg.contract.guardsFile>` and load each mutation-verified row's recipe
 * JSON -- oracle-DEFINITION read, same trusted-root / fail-closed contract as
 * `loadInvariantsFrom` above (`adr/006` Phase 1). Best-effort per-row: a guard row whose
 * recipe path is missing/escaped/symlinked/unparseable is SKIPPED (`continue`), NEVER
 * thrown -- dropping one guard makes its zone read as *uncovered*, which already
 * escalates on its own (a touched `auto_guardable` zone with no covering guard fails the
 * gate); that direction is already fail-safe, so widening the per-row check to include
 * trusted-root containment (Finding 1: `recipePath = join(root, row.recipe)` had the same
 * `..`/symlink-escape hole as the whole-file case) only needs to SKIP the row, not escalate
 * the whole table -- unlike the whole-`guardsFile`-absent case, which DOES need the
 * configured-vs-not throw/no-throw distinction below, because there the operator declared
 * an oracle and got none at all, not merely one weaker row.
 */
export async function loadGuardPairsFrom(
  cfg: HarnessConfig,
  raw: Record<string, unknown>,
  root: string,
): Promise<GuardRecipePair[]> {
  const resolution = await resolveContainedOracleFile(root, cfg.contract.guardsFile);
  if (!resolution.readable) {
    if (isContractFileConfigured(raw, "guardsFile")) {
      throw new Error(
        `contract.guardsFile is configured ('${cfg.contract.guardsFile}') but ` +
          `${oracleUnreadableClause(root, resolution.reason)} -- the gate cannot judge against ` +
          `a missing oracle (adr/006 Phase 1)`,
      );
    }
    return [];
  }
  const text = await readFile(resolution.path, "utf8");
  const rows = parseGuardsTable(text);

  const pairs: GuardRecipePair[] = [];
  for (const row of rows) {
    if (!isMutationVerified(row)) continue;
    const recipeResolution = await resolveContainedOracleFile(root, row.recipe);
    if (!recipeResolution.readable) continue; // see doc comment above -- skip, never throw
    try {
      const recipeText = await readFile(recipeResolution.path, "utf8");
      const recipe = JSON.parse(recipeText) as GuardRecipe;
      pairs.push({ guard: row, recipe });
    } catch {
      continue; // unparseable recipe -- skip, never let one bad file break the whole table
    }
  }
  return pairs;
}

/** Everything the daemon knows about ONE project. Built once per project by the
 *  hub (serve) or once for cwd (CLI verbs). Untested glue by design — every
 *  wired piece is unit-tested; typecheck + the full suite cover this file
 *  (gotcha [conductor/wiring], same status as src/index.ts). */
export interface ProjectRoot {
  repoRoot: string;
  cfg: HarnessConfig;
  repo: FileBlackboardRepository;
  conductor: Conductor;
  /** Built on FIRST use (first `handleIntent`), not eagerly: the `run` verb never
   *  orchestrates, so a config with an unregistered orchestrator adapter (which
   *  `buildOrchestrator` rejects) must still let `run` work -- the pre-extraction
   *  behavior, when only serve/orchestrate constructed the orchestrator. */
  orchestrator: { handleIntent(intent: string): Promise<OrchestratorResult> };
  /** Pre-launch conversational layer (adr/003-safe — see chat-adapter.ts).
   *  Built LAZILY on first use, same rationale as `orchestrator`: the `run`
   *  CLI verb never opens a chat, so a config with an unregistered chat
   *  adapter must not break it. */
  chat: ChatSessionManager;
  /** apply-on-accept (operator gate-override): replay an escalated task's persisted
   *  `diff.patch` onto the loop branch and commit it. Consumed by the reply endpoint's
   *  choice "C". Fails CLOSED with a typed reason (missing diff / dirty tree / bad
   *  branch / apply conflict) so the caller keeps the task escalated. */
  applyOnAccept(taskId: string): Promise<ApplyOnAcceptResult>;
  log: Logger;
  /** Absolute `<repoRoot>/<stateDir>` — what the API server needs. */
  stateDirAbs: string;
  /** Whether the operator EXPLICITLY set `roles.planner` in the raw config. The
   *  parsed `cfg` always carries a defaulted planner, so the config projection
   *  (R1) needs this raw-presence signal to expose planner only when configured. */
  plannerConfigured: boolean;
  /** Live/replay surface for streamed agent-ci events (Task 7 wires this over HTTP/SSE).
   *  Built LAZILY, same rationale as `chat`. */
  ci: {
    bus: CiEventBus;
    readEvents: (taskId: string) => Promise<string>;
  };
  /** Probe agent-ci's runtime capability (native/wsl/unavailable) for the UI, without
   *  actually running a workflow. */
  onCiCapability: () => Promise<AgentCiCapability>;
  /** Build the live-orchestrator threads capability (adr/004): pre-launch chat
   *  service + post-launch narrator registry, wired over THIS project's store /
   *  bus / read-cap. Needs the HTTP-layer launch bits (`onOrchestrate` + an
   *  in-flight guard set) since those live at the index/server layer. Memoized:
   *  ONE `ThreadChatService` (holding the threadId->session map) is reused across
   *  per-request ProjectView rebuilds, same as `chat` reuses one ChatSessionManager
   *  -- so the FIRST httpDeps wins. Built LAZILY. */
  buildThreads(httpDeps: {
    onOrchestrate: ((intent: string) => Promise<unknown> | void) | undefined;
    inFlight: Set<string>;
  }): ThreadsCapability;
  /** Stop every live narrator (clears its interval + CI subscriptions) and close
   *  the thread SSE bus -- daemon-shutdown teardown, mirrors chat `closeAll()`. */
  closeThreads(): void;
  /** Re-arm the narrator for a thread parked `blocked` on an escalation, once the
   *  operator's reply re-queues `taskId` ([narrator/escalated-run-not-terminal]).
   *  Fire-and-forget from the reply path; best-effort (never throws). */
  rearmNarratorForTask(projectId: string, taskId: string): Promise<void>;
  /** Overnight-aware run entry (spec 2026-07-17, presence AND spec 2026-07-19): when
   *  `cfg.autonomy.overnight.enabled` AND daemon-global operator presence is set (read
   *  fresh per call via `shouldSupervise`/`PresenceReader`), drives the `superviseOvernight`
   *  loop (drain + reason-route + auto-rework/park each sweep); otherwise a plain bounded
   *  drain, identical to the pre-existing `run` verb. Never touches the critic/gate/commit
   *  -- only the reply-B requeue + journal. */
  runOrSupervise(runOpts?: ConductorRunOptions): Promise<void>;
  /** Write the Harness Execution Report for every run that has FINISHED and does not
   *  have one yet (spec 2026-07-22 "two reports"). Called once after a run entry
   *  resolves — never inside the iteration loop. Bookkeeping about the loop: it
   *  swallows and logs its own failures and never throws. */
  refreshReports(): Promise<void>;
  /** The stored Execution Report Markdown for `runId`, or null when the run has not
   *  produced one yet (it is still moving). */
  readExecutionReport(runId: string): Promise<string | null>;
  /** The stored Execution Report JSON text for `runId`, bounded + TOCTOU-hardened,
   *  or null when the run has produced none. The API layer reads reports ONLY
   *  through this, so the report's filename has exactly one builder
   *  (docs/gotchas/validated-one-string-used-another.md). */
  readExecutionReportJson(runId: string): Promise<string | null>;
  /** Assemble a Product Qualification Report over a commit range, ON DEMAND (D4).
   *  `to` defaults to `HEAD`, `from` to the repository's root commit. A `git rev-list`
   *  failure THROWS — never an empty commit list, which would read as "nothing to
   *  prove". */
  qualificationReport(range: { from?: string; to?: string }): Promise<{
    json: QualificationReport;
    markdown: string;
  }>;
  /** Assemble the Morning Report (spec 2026-07-23): parses the overnight decision
   *  journal, reconciles each task against the live blackboard, and asks the
   *  orchestrator model for a one-paragraph narration (best-effort -- a narration
   *  failure degrades to the structured summary, it never fails the whole call). */
  morningReport(opts?: { since?: string }): Promise<{ report: MorningReport; markdown: string }>;
}

/** The threads capability object the HTTP `ProjectView.threads` consumes; also
 *  carries a `closeThreads` so the ProjectView-scoped server shutdown can tear
 *  its narrators + bus down without reaching back to the ProjectRoot. */
export interface ThreadsCapability {
  store: ThreadStore;
  bus: ThreadEventBus;
  chat: ThreadChatService;
  narratorMessage: (threadId: string, text: string) => Promise<boolean>;
  closeThreads: () => void;
}

export async function buildProjectRoot(
  repoRoot: string,
  opts?: { presence?: PresenceReader },
): Promise<ProjectRoot> {
  const { cfg, raw } = await loadConfigWithRaw(repoRoot);
  const plannerConfigured = isPlannerExplicitlyConfigured(raw);

  const log = createLogger(join(repoRoot, cfg.stateDir, "conductor.log"));

  // Qualification profile (spec 2026-07-22). Loaded ONCE per root build and fail-
  // CLOSED: an unresolvable profile throws right here rather than degrading to "no
  // profile", because the degraded mode is the dangerous one -- gates the operator
  // believes are running would silently not run, and a green verdict would claim a
  // qualification that never happened. null = not attached = every profile contour
  // below (gate step 1d, the fifth oracle source, the provision union) is inert.
  const profile = cfg.profile === null ? null : await loadProfile(cfg.profile);
  if (profile !== null) {
    log("INFO", `profile attached: ${profile.id}@${profile.version} (${profile.gates.length} gate(s))`);
  }

  // Read-through: the daemon-global presence flag is NOT cached on the ProjectRoot
  // (unlike `cfg`, captured once above) -- see the PresenceReader doc comment. The
  // production default is only constructed here, where `log` is already in scope
  // for loadSettings' never-throws error logging.
  const presence: PresenceReader =
    opts?.presence ??
    (async () => (await loadSettings(defaultSettingsFile(homedir()), log)).overnight.enabled);

  // --- Core dependencies -----------------------------------------------
  const repo = new FileBlackboardRepository(repoRoot, cfg.stateDir);
  const scheduler = createScheduler(repo);
  const worktreesDir = join(repoRoot, cfg.stateDir, "worktrees");
  const worktree = createWorktreeManager(repoRoot, worktreesDir, {
    // Union, never override: a profile ADDS what its gates need (e.g. `vendor`,
    // which supplies vendor/bin/phpcs) to whatever the project already
    // provisions. De-duplicated because the two lists legitimately overlap -- a
    // project that already provisioned `vendor` must not have it linked twice.
    provision: [...new Set([...cfg.worktree.provision, ...(profile?.provision ?? [])])],
    log,
  });
  const router = createRouter(cfg);
  const git = createGit(repoRoot);
  const worktreeGit = (wt: Worktree) => createGit(wt.path);

  // Order is intentional: the hard capability check (is this adapter even
  // implemented?) runs BEFORE the soft heterogeneity policy warning. In the
  // MVP the only same-family worker/critic combos require an unregistered
  // adapter, so assertKnownAdapters surfaces the more actionable error first;
  // heterogeneityWarnings is forward-looking — it starts firing once a second
  // adapter of the same family (e.g. a Claude-based critic) is registered.
  assertKnownAdapters(cfg); // fail loud on an unregistered worker/critic adapter
  for (const w of heterogeneityWarnings(cfg)) log("WARN", w);
  const worker = ((): WorkerAdapter => {
    switch (cfg.roles.worker.adapter) {
      case "claude":
        return new ClaudeWorkerAdapter({ runner: new RealWatchedProcessRunner(), cfg });
      default:
        throw new Error(`unreachable: assertKnownAdapters should have caught '${cfg.roles.worker.adapter}'`);
    }
  })();
  const critic = ((): CriticAdapter => {
    switch (cfg.roles.critic.adapter) {
      case "codex":
        return new CodexCriticAdapter({ cfg, repoRoot });
      default:
        throw new Error(`unreachable: assertKnownAdapters should have caught '${cfg.roles.critic.adapter}'`);
    }
  })();

  // --- Contract-zone plumbing (INVARIANTS.md / GUARDS.md) ---------------
  // `loadInvariantsFrom`/`loadGuardPairsFrom` are the module-level, trusted-root loaders
  // defined above (adr/006 Phase 1) -- both closures below pass `cfg`/`raw` explicitly.

  /** Which contract zones (by id) does this diff touch? Path-less: only the +/- diff lines
   *  are checked. Already read from `repoRoot` pre-Phase-1 (this is the symmetry `gateDeps`
   *  below now matches). */
  const zonesTouchedInDiff = async (diff: string): Promise<string[]> => {
    const inv = await loadInvariantsFrom(cfg, raw, repoRoot);
    const diffLines = diffAddedRemovedLines(diff);
    return inv.contract_zones.filter((z) => zoneTouched(z, [], diffLines)).map((z) => z.id);
  };

  // --- Gate --------------------------------------------------------------
  /** Combine a subprocess's stdout+stderr into the single blob `gate-feedback.md`
   *  reports for a failing step. Both streams, not just stdout: a linter may put
   *  its report on either one (PHPCS writes to stdout; some tools write violations
   *  to stderr and only a summary to stdout), and guessing which one to keep would
   *  silently drop half the report the worker needs to fix the failure. */
  const mergedOutput = (r: { stdout: string; stderr: string }): string =>
    [r.stdout, r.stderr].filter((s) => s.trim() !== "").join("\n");

  function gateDeps(wt: Worktree): GateDeps {
    const checkCommand = cfg.gate.checkCommand;
    const agentCi = cfg.gate.agentCi;
    return {
      // Oracle DEFINITIONS read from the trusted root (adr/006 Phase 1) -- NOT `wt.path`.
      // A worker only ever writes a per-task worktree, never `repoRoot`, so a diff cannot
      // talk the gate into judging against a definition it just edited.
      loadInvariants: () => loadInvariantsFrom(cfg, raw, repoRoot),
      loadGuardPairs: () => loadGuardPairsFrom(cfg, raw, repoRoot),
      constitutionPaths: cfg.contract.constitutionPaths,
      resolveScope: async (inp: GateInput) => {
        const g = createGit(wt.path);
        return { changedFiles: await g.changedFiles(inp.fileSet), diffText: await g.diffText(inp.fileSet) };
      },
      runCheck: checkCommand
        ? async () => {
            const { c, a } = splitCommand(checkCommand);
            const r = await runNative(c, a, { cwd: wt.path });
            return { green: r.exitCode === 0, exitCode: r.exitCode, output: mergedOutput(r) };
          }
        : null,
      runSuccessCommand: async (cmd: string) => {
        const { c, a } = splitCommand(cmd);
        const r = await runNative(c, a, { cwd: wt.path });
        return { exitCode: r.exitCode, output: mergedOutput(r) };
      },
      // Profile gates (spec 2026-07-22) run in the WORKTREE -- that is the code
      // under judgement -- while their rulesets come from the profile directory in
      // the harness repo, already absolute after `{profile}` expansion at load.
      // `runNative` REJECTS on a spawn ENOENT, so a missing tool or an unprovisioned
      // `vendor` propagates OUT of runGate as the infra throw the conductor
      // escalates, instead of reading as a red gate that would loop the worker on
      // an environment it cannot fix -- the same contract as runAgentCi below.
      //
      // A ZERO exit code is not the only "the gate ran fine" outcome, and a
      // non-zero exit code is not automatically a worker-fixable RED (critic
      // finding 1). `classifyGateExit` (src/profile/profile.ts) makes that call
      // per-gate against its declared `redExitCodes`; an "unrunnable" verdict
      // THROWS here, naming the gate, the exit code and the declared red codes, so
      // it propagates out of runGate exactly like the ENOENT case above -- the
      // conductor escalates it as broken environment instead of RETRYing the
      // worker against a defect that was never in the diff.
      runProfileGates:
        profile === null || profile.gates.length === 0
          ? null
          : async (changedFiles: string[], addedLines: AddedLines) => {
              const out: ProfileGateRecord[] = [];
              for (const g of profile.gates) {
                // Derived from the DECLARATION, never from the outcome.
                const scope: ProfileGateRecord["scope"] =
                  g.report !== null ? "changed-lines" : g.filesGlob !== null ? "changed-files" : "whole-project";
                const inv = prepareGateInvocation(g, changedFiles);
                if (inv.skipped) {
                  // Still logged (unchanged), AND now recorded: a skipped gate is a
                  // bound on what this verdict covers, and an unreported bound reads
                  // as coverage.
                  log("INFO", `profile gate '${g.id}' skipped -- ${inv.reason}`);
                  out.push({
                    id: g.id,
                    status: "skipped",
                    exit_code: null,
                    skip_reason: inv.reason,
                    scope,
                    files: [],
                    findings: null,
                    findings_total: null,
                    output: "",
                  });
                  continue;
                }
                const { c, a } = splitCommand(inv.command);
                const r = await runNative(c, a, { cwd: wt.path });

                // SAFETY-CRITICAL ORDERING (unchanged from Task 4 of the line-scoping
                // plan): classify FIRST, parse only on RED. An unrunnable exit fed to
                // the parser reads as zero findings, which downstream means CLEAN -- a
                // broken gate would become a PASS.
                const verdict = classifyGateExit(g, r.exitCode);
                if (verdict === "unrunnable") {
                  throw new Error(
                    `profile gate '${g.id}' exited ${r.exitCode}, which is neither 0 nor one of its declared red ` +
                      `exit codes [${g.redExitCodes.join(", ")}] -- the gate could not complete (not a ` +
                      `worker-fixable failure)`,
                  );
                }

                const scopedFiles = g.filesGlob === null ? [] : changedFiles.filter((f) => globMatch(g.filesGlob!, f));

                if (verdict === "green") {
                  // Exit 0: the tool reported nothing, so there is nothing to parse
                  // and no debt to measure. `findings_total: null` means "not
                  // measured" -- deliberately not `0`, which would claim the file is
                  // clean when this run never looked.
                  out.push({
                    id: g.id, status: "green", exit_code: r.exitCode, skip_reason: null,
                    scope, files: scopedFiles, findings: null, findings_total: null, output: mergedOutput(r),
                  });
                  continue;
                }

                if (g.report === null) {
                  out.push({
                    id: g.id, status: "red", exit_code: r.exitCode, skip_reason: null,
                    scope, files: scopedFiles, findings: null, findings_total: null, output: mergedOutput(r),
                  });
                  continue;
                }

                const parsed = parseCheckstyle(r.stdout);
                const filtered = filterFindings(parsed, addedLines.added, wt.path, addedLines.newFiles);
                out.push({
                  id: g.id,
                  // The verdict comes from the FILTERED count, not the exit code: a tool
                  // legitimately exits non-zero while every finding sits outside this diff.
                  status: filtered.length === 0 ? "green" : "red",
                  exit_code: r.exitCode,
                  skip_reason: null,
                  scope,
                  files: scopedFiles,
                  findings: filtered,
                  // The tool's FULL count, before diff-filtering. `filtered.length`
                  // is what the worker owns; the difference is the file's
                  // pre-existing debt, which the Qualification Report names.
                  findings_total: parsed.length,
                  output: mergedOutput(r),
                });
              }
              return out;
            },
      runAgentCi: agentCi.enabled
        ? async (taskId: string) => {
            if (agentCi.workflows.length === 0) {
              // Enabled but nothing to run: fail OPEN with a loud warning
              // (mirrors policy.heterogeneity's misconfig convention). Never
              // blocks a run on a half-finished config.
              log("WARN", "gate.agentCi.enabled but workflows allowlist is empty -- skipping agent-ci this round");
              return { green: true, reasons: [] };
            }
            const MAX_CI_NDJSON_BYTES = 2_000_000; // ~2MB persisted history cap (strict incl. the marker)
            const CI_TRUNCATION_MARKER = JSON.stringify({ kind: "other", note: "event log truncated (size cap)" }) + "\n";
            let ndjson = "";
            let ndjsonCapped = false;
            let status = initialCiStatus();
            const onEvent = (workflow: string, event: AgentCiEvent): void => {
              // Persist (best-effort; a persist failure must NEVER fail a real CI verdict).
              // Cap the persisted ndjson so a verbose/stuck workflow can't grow it (and its
              // rewrite cost) unbounded; the live bus publish + status.json summary below
              // are unaffected by the cap.
              if (!ndjsonCapped) {
                const line = JSON.stringify(event) + "\n";
                // Reserve the marker's length so the final file is STRICTLY <= MAX_CI_NDJSON_BYTES
                // (the marker is always appended within the reserved budget on the tripping event).
                if (ndjson.length + line.length > MAX_CI_NDJSON_BYTES - CI_TRUNCATION_MARKER.length) {
                  ndjsonCapped = true;
                  ndjson += CI_TRUNCATION_MARKER;
                  log(
                    "WARN",
                    `agent-ci event log for task ${taskId} exceeded ${MAX_CI_NDJSON_BYTES} bytes -- truncating persisted history`,
                  );
                } else {
                  ndjson += line;
                }
                void repo.writeRuntimeFile(taskId, "agent-ci-events.ndjson", ndjson).catch(() => {});
              }
              status = foldCiStatus(status, workflow, event);
              void repo.writeRuntimeFile(taskId, "agent-ci-status.json", JSON.stringify(status, null, 2)).catch(() => {});
              // Publish to the live bus (best-effort).
              try {
                getCiBus().publish(taskId, event);
              } catch {
                /* ignore */
              }
            };
            // Derive the WSL-form gitdir so WSL git can resolve HEAD in a Windows-created
            // worktree (its `.git` pointer is a Windows path). null/native -> no exports.
            let gitDirWsl: string | undefined;
            try {
              const dotGit = join(wt.path, ".git");
              if (statSync(dotGit).isFile()) {
                gitDirWsl = worktreeGitDirWsl(readFileSync(dotGit, "utf8")) ?? undefined;
              }
            } catch {
              /* best-effort: no gitdir derivation -> agent-ci runs without the exports */
            }
            // agent-ci MUTATES the repo's SHARED git config (flips core.bare=true, overwrites
            // user.*) via the GIT_DIR it's pointed at -- which, for a linked worktree, is the
            // MAIN repo's `.git/config`. That leaves the main tree "bare" and breaks the
            // conductor's post-gate merge (`fatal: this operation must be run in a work tree`).
            // Snapshot the config and restore it after the run -- the conductor is single-threaded
            // per project, so nothing else touches it meanwhile. Applies to native + wsl alike.
            const gitConfigPath = join(repoRoot, ".git", "config");
            let savedGitConfig: string | null = null;
            try {
              savedGitConfig = readFileSync(gitConfigPath, "utf8");
            } catch {
              /* no readable config -> nothing to protect */
            }
            try {
              return await runAgentCiWorkflows({
                cwd: wt.path,
                workflows: agentCi.workflows,
                timeoutMs: agentCi.timeoutMs,
                detectCapability: () => detectAgentCiCapability(),
                spawn: spawnAgentCiStream,
                onEvent,
                ...(gitDirWsl !== undefined ? { gitDirWsl } : {}),
              });
            } finally {
              // Restore the config even if agent-ci threw (an infra/timeout run can still have
              // flipped core.bare before dying).
              if (savedGitConfig !== null) {
                try {
                  writeFileSync(gitConfigPath, savedGitConfig);
                } catch {
                  /* best-effort restore */
                }
              }
            }
          }
        : null,
      guardStillRed: async (guard: GuardRow) => {
        // SELECTION reads the trusted root (adr/006 Phase 1 -- this reload is load-bearing:
        // a loader-only fix elsewhere would leave THIS reload a worktree bypass, per the
        // gotcha this closes). The mutation RUN below stays against `wt.path` on purpose --
        // executing the recipe against the worktree is unchanged, in scope for a later phase.
        const pairs = await loadGuardPairsFrom(cfg, raw, repoRoot);
        // Match the FULL row identity, not contract_id alone: per-value coverage
        // (divergence #2) means one contract_id can have several sibling rows
        // with different recipes -- matching on contract_id alone could run the
        // wrong recipe and produce a false pass/fail.
        const pair = pairs.find(
          (p) =>
            p.guard.contract_id === guard.contract_id &&
            p.guard.contract_value === guard.contract_value &&
            p.guard.guard_test === guard.guard_test &&
            p.guard.recipe === guard.recipe,
        );
        if (!pair) return false;
        const recipe = pair.recipe as MutationRecipe;
        const res = await mutationCheck(recipe, {
          repoRoot: wt.path,
          runGuardTest: async (testFile: string) => {
            const { c, a } = splitCommand(cfg.guards.testCommandTemplate.replace("{testFile}", testFile));
            const r = await runNative(c, a, { cwd: wt.path });
            return { green: r.exitCode === 0 };
          },
        });
        return res.pass;
      },
      writeVerdict: async (taskId: string, verdict: GateVerdict) => {
        await repo.writeRuntimeFile(taskId, "gate-verdict.json", JSON.stringify(verdict, null, 2));
      },
      // `content === null` means CLEAR -- actually delete the file, never write an
      // empty one. An empty-but-present `gate-feedback.md` would still read as a
      // present (if blank) feedback section to the next round's worker/conductor,
      // which defeats the anti-staleness property `runGate`'s write-or-clear
      // contract is built around (docs/gotchas/per-round-overwrite-artifact-stale.md).
      writeGateFeedback: async (taskId: string, content: string | null) => {
        if (content === null) {
          await repo.removeRuntimeFile(taskId, "gate-feedback.md");
          return;
        }
        await repo.writeRuntimeFile(taskId, "gate-feedback.md", content);
      },
    };
  }

  const runGate = (input: GateInput, wt: Worktree): Promise<GateVerdict> => runGateCore(input, gateDeps(wt));

  // --- Escalate ------------------------------------------------------------
  const escalationsDir = join(repoRoot, cfg.stateDir, "escalations");

  const escalate = (input: EscalationInput): Promise<unknown> =>
    escalateCore(input, {
      escalationsDir,
      writeFile: async (p: string, c: string) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, c, "utf8");
      },
      appendFile: async (p: string, c: string) => {
        await mkdir(dirname(p), { recursive: true });
        await appendFile(p, c, "utf8");
      },
      env: (n: string) => process.env[n],
      telegramPost: async (token: string, chat: string, text: string) => {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text }),
        });
      },
      log,
    });

  // --- Anti-drift ----------------------------------------------------------
  const runAntiDrift = (input: AntiDriftInput): Promise<string> =>
    runAntiDriftCore(input, cfg.antiDrift, {
      readFile: async (p: string) => (existsSync(p) ? await readFile(p, "utf8") : null),
      gitLog: async (sinceRef: string) =>
        (await runNative("git", ["log", `${sinceRef}..HEAD`, "--oneline"], { cwd: repoRoot })).stdout,
      gitDiff: async (sinceRef: string) =>
        (await runNative("git", ["diff", `${sinceRef}..HEAD`], { cwd: repoRoot })).stdout,
      runModel: async (model: string, prompt: string) => {
        const r = await runNative(resolveWorkerExe(cfg), ["-p", "--model", model], { cwd: repoRoot, stdin: prompt });
        return { exitCode: r.exitCode, output: r.stdout };
      },
      appendDigest: (line: string) => repo.appendDigest(line),
      now: () => new Date(),
      log,
    });

  // --- Misc conductor deps --------------------------------------------------
  const gitChangedPaths = async (cwd: string): Promise<string[]> => {
    const r = await runNative("git", ["status", "--porcelain"], { cwd });
    return r.stdout
      .split(/\r?\n/)
      .map((l) => {
        // Porcelain lines are 2 status chars + a space, then the path. A
        // rename ("R  old -> new") is reported after that prefix as
        // "old -> new" -- take the part after "->" when present.
        const rest = l.length > 3 ? l.slice(3) : "";
        const arrowIdx = rest.indexOf("->");
        return (arrowIdx !== -1 ? rest.slice(arrowIdx + 2) : rest).trim();
      })
      .filter((l) => l.length > 0);
  };

  const snapshotFingerprints = (cwd: string, rawPaths: string[]): Map<string, string> => snapshot(cwd, rawPaths);

  // Oracle-path set (adr/006 Phase 2): resolved against `repoRoot` -- the TRUSTED
  // root, never `wt.path` -- same discipline as `loadInvariantsFrom`/
  // `loadGuardPairsFrom` above. Built fresh on every call (not memoized): the
  // conductor calls this once per round, and the underlying GUARDS.md/config can
  // legitimately change between an operator's edits and the next task.
  // The attached profile's `protectedPaths` ride in as the fifth source. Passed as
  // a plain `string[]`, not the ResolvedProfile: `gate/` must not depend on
  // `profile/`, the same dependency-direction rule `oracle-paths.ts` already keeps
  // toward `composition/`.
  const resolveProjectOracleSet = (): Promise<OracleSet> =>
    resolveOracleSet(cfg, raw, repoRoot, profile?.protectedPaths ?? []);

  const harvestWorkerReport = async (wt: Worktree, taskId: string): Promise<void> => {
    await harvestWorkerReportCore(wt.path, repo.runtimeDir(taskId));
  };

  const clock = { now: () => Date.now() };
  const sleep = (seconds: number): Promise<void> => new Promise((r) => setTimeout(r, seconds * 1000));

  // EOL normalization dep: bind the real git check-attr + node fs, with the same
  // `log` the rest of the conductor uses. Best-effort; see src/normalize/eol.ts.
  const eolDeps = makeNormalizeEolDeps(log);
  const normalizeEol = (wt: Worktree, relPaths: string[]) => normalizeWorktreeEol(eolDeps, wt.path, relPaths);

  const deps: ConductorDeps = {
    cfg,
    repo,
    scheduler,
    worktree,
    worker,
    critic,
    router,
    git,
    worktreeGit,
    mainTreeStatus: () => mainTreeStatus(repoRoot),
    runGate,
    escalate,
    runAntiDrift,
    harvestWorkerReport,
    normalizeEol,
    gitChangedPaths,
    snapshotFingerprints,
    resolveOracleSet: resolveProjectOracleSet,
    zonesTouchedInDiff,
    // Identity only, from the already-loaded profile: the evidence ledger records
    // WHICH ruleset judged the task, so a report can never present a qualification
    // under one profile as if it were another's.
    profileRef: profile === null ? null : { id: profile.id, version: profile.version },
    clock,
    sleep,
    log,
  };

  const conductor = createConductor(deps);

  // Orchestrator is built LAZILY (on first handleIntent) rather than eagerly:
  // buildOrchestrator throws for an unregistered orchestrator adapter, but the
  // `run` CLI verb never orchestrates. Building it eagerly here would make
  // `autodev run` fail on a config that has a valid worker/critic but an
  // unsupported orchestrator adapter -- a config that worked pre-extraction
  // (when only serve/orchestrate called buildOrchestrator). The laziness keeps
  // the ProjectRoot interface unchanged; only `run` benefits.
  let orchestrator: { handleIntent(intent: string): Promise<OrchestratorResult> } | undefined;
  // `runEntry: runOrSupervise` is a direct reference, not a thunk -- and that is
  // safe here even though `runOrSupervise` is declared LATER in this function
  // (const, ~line 789): getOrchestrator's body only runs on first `handleIntent`,
  // which can only happen after buildProjectRoot has fully returned (this object
  // is the only place `orchestrator` is exposed), i.e. strictly after the
  // `runOrSupervise` const has already been initialized. See gotcha
  // [refactor/extraction-eagerness] -- verified, not assumed.
  // The DAEMON's trigger path: the orchestrator's `trigger` capability is the only
  // enforcement handle it has, and it routes through this entry. The report refresh
  // hangs off the entry (once, AFTER the bounded run resolves) rather than off the
  // conductor's iteration loop -- a report is about a FINISHED run, and refreshing it
  // per iteration would write a report over a run that is still moving. `refreshReports`
  // never throws by contract, so it cannot turn a completed run into a failed trigger.
  // Same TDZ reasoning as `runEntry: runOrSupervise` above: this closure is only
  // CREATED on first `handleIntent`, strictly after buildProjectRoot has returned.
  const getOrchestrator = () =>
    (orchestrator ??= buildOrchestrator({
      cfg,
      repoRoot,
      repo,
      runEntry: async (opts) => {
        await runOrSupervise(opts);
        await refreshReports();
      },
      log,
    }));

  // Chat manager is built LAZILY on first access, same rationale as the
  // orchestrator above: the `run` CLI verb never opens a chat, so a config
  // with an unregistered chat adapter must not break it.
  let chatManager: ChatSessionManager | undefined;
  const getChatManager = (): ChatSessionManager => {
    if (!chatManager) {
      const chatAdapter: OrchestratorChatAdapter = new ClaudeOrchestratorChatAdapter({ cfg, repoRoot });
      chatManager = new ChatSessionManager({ adapter: chatAdapter, log });
      chatManager.startReaper();
    }
    return chatManager;
  };

  // CI event bus is built LAZILY on first access, same rationale as the chat
  // manager above: most CLI verbs never stream agent-ci, so there is no need
  // to construct it eagerly.
  let ciBus: CiEventBus | undefined;
  const getCiBus = (): CiEventBus => {
    if (!ciBus) ciBus = new CiEventBus();
    return ciBus;
  };

  // --- Live-orchestrator threads (adr/004) -------------------------------
  // Composition glue only, same untested-by-design status as the chat/orchestrator
  // wiring above: ThreadStore, ThreadEventBus, ThreadChatService, NarratorService
  // and the one-shot narrator each have their own unit tests against fakes.
  const runsDir = join(repoRoot, cfg.stateDir, "runs");
  const threadReadCap = createReadCapability(repo);

  let threadStore: ThreadStore | undefined;
  let threadBus: ThreadEventBus | undefined;
  const getThreadStore = (): ThreadStore =>
    (threadStore ??= new ThreadStore({ threadsRoot: join(repoRoot, cfg.stateDir, "threads"), log }));
  const getThreadBus = (): ThreadEventBus => (threadBus ??= new ThreadEventBus());

  // Live narrator registry (threadId -> service): lets a mid-run operator message
  // reach the right narrator, and lets shutdown stop every timer.
  const narrators = new Map<string, NarratorService>();

  /** Read `<runsDir>/<runId>.json` -> its taskIds. Tolerant: an unsafe id or any
   *  read/parse failure yields null so the narrator simply waits for the next tick. */
  const readOneRunManifest = async (runId: string): Promise<{ taskIds: string[] } | null> => {
    try {
      if (!isPathSafeId(runId)) return null;
      const p = join(runsDir, `${runId}.json`);
      if (!existsSync(p)) return null;
      const parsed = JSON.parse(await readFile(p, "utf8")) as { taskIds?: unknown };
      if (!Array.isArray(parsed.taskIds)) return null;
      return { taskIds: parsed.taskIds.filter((x): x is string => typeof x === "string") };
    } catch {
      return null;
    }
  };

  /** Compose a RunSnapshot: the run manifest gives the task ids, the live queues
   *  give status+title per id (no single blackboard call returns this shape). */
  const runSnapshot = async (runId: string): Promise<RunSnapshot | null> => {
    const manifest = await readOneRunManifest(runId);
    if (!manifest) return null;
    const queues = await threadReadCap.queues();
    const byId = new Map<string, { status: TaskSnapshot["status"]; title: string }>();
    for (const state of Object.keys(queues) as QueueState[]) {
      for (const t of queues[state]) byId.set(t.id, { status: state, title: t.title });
    }
    const reader: RunSnapshotReader = {
      readRunManifest: async () => manifest,
      readTaskStatus: async (id: string) => byId.get(id) ?? null,
    };
    return buildRunSnapshot(reader, runId);
  };

  // Narrator one-shot: SAME exe + model + isolation flags as the chat adapter
  // (converse-only -- no tools, no MCP, hooks/plugins/CLAUDE.md off). The one-shot
  // itself appends `-p --output-format stream-json --verbose <prompt>`.
  const narrate = (prompt: string, onToken: (t: string) => void): Promise<string> =>
    runOrchestratorOneShot({
      exe: resolveOrchestratorExe(cfg),
      cwd: repoRoot,
      args: ["--model", cfg.roles.orchestrator.model, "--safe-mode", "--strict-mcp-config", "--tools", ""],
      prompt,
      onToken,
    });

  const startNarrator = (a: {
    projectId: string;
    threadId: string;
    finalIntent: string;
    launchedAt: number;
    /** Re-arm mode: skip discovery, narrate from this already-bound run. */
    boundRunId?: string;
  }): void => {
    // Defensive: never leave two live narrators for one thread (a re-arm after a
    // `blocked` park, or a rare double-fire). Stop any lingering one first; its
    // onStopped prunes the map before the new svc re-registers below.
    narrators.get(a.threadId)?.stop();
    const svc = new NarratorService({
      ...a,
      store: getThreadStore(),
      bus: getThreadBus(),
      ciBus: getCiBus(),
      read: {
        // recentRuns() returns RunManifestSummary with the timestamp field `at`;
        // the narrator expects `created_at`, so map it here.
        recentRuns: async () =>
          (await threadReadCap.recentRuns()).map((m) => ({ runId: m.runId, created_at: m.at, intent: m.intent })),
        runSnapshot,
      },
      narrate,
      log,
      now: () => Date.now(),
      onStopped: () => { narrators.delete(a.threadId); },
    });
    narrators.set(a.threadId, svc);
    svc.start();
  };

  /** Re-arm a narrator for a thread that parked `blocked` on an escalation, once
   *  the operator's reply re-queues its task ([narrator/escalated-run-not-terminal]).
   *  Finds the blocked thread whose run manifest owns `taskId`, flips it back to
   *  `running`, and starts a fresh narrator bound to the SAME run (baseline-silent
   *  so it narrates only post-reply progress). Best-effort: a failure here must
   *  never affect the reply/gate path (called fire-and-forget from onReplyRework). */
  const rearmNarratorForTask = async (projectId: string, taskId: string): Promise<void> => {
    try {
      const store = getThreadStore();
      for (const meta of await store.list()) {
        if (meta.status !== "blocked" || meta.run_id === undefined) continue;
        const manifest = await readOneRunManifest(meta.run_id);
        if (!manifest || !manifest.taskIds.includes(taskId)) continue;
        await store.setMeta(meta.id, { status: "running" });
        startNarrator({
          projectId,
          threadId: meta.id,
          finalIntent: meta.title,
          launchedAt: Date.now(),
          boundRunId: meta.run_id,
        });
        // Observability (codex #3): a successful re-arm is the positive signal —
        // its ABSENCE for a thread that should have resumed is the diagnostic for
        // the stale/corrupt-run_id edge. We deliberately do NOT warn on the
        // zero-match case: a curl/direct /orchestrate run legitimately owns no
        // thread, so "no blocked thread for this task" is normal, not an error.
        log("INFO", `narrator: re-armed blocked thread ${meta.id} (run ${meta.run_id}) after reply-B on ${taskId}`);
      }
    } catch (err) {
      try { log("WARN", `[ts/fail-closed] rearm narrator failed for ${taskId}: ${String(err)}`); } catch { /* logger must never break the reply path */ }
    }
  };

  const closeThreads = (): void => {
    for (const n of narrators.values()) {
      try {
        n.stop();
      } catch {
        /* best-effort teardown: a narrator stop failure must never block shutdown */
      }
    }
    narrators.clear();
    threadBus?.closeAll();
  };

  // Memoized so ONE ThreadChatService (holding the threadId->session map) is reused
  // across per-request ProjectView rebuilds -- same rationale as getChatManager.
  // The FIRST httpDeps wins (onOrchestrate/inFlight are stable per project).
  let threadsCapability: ThreadsCapability | undefined;
  const buildThreads = (httpDeps: {
    onOrchestrate: ((intent: string) => Promise<unknown> | void) | undefined;
    inFlight: Set<string>;
  }): ThreadsCapability => {
    if (threadsCapability) return threadsCapability;
    const store = getThreadStore();
    const bus = getThreadBus();
    const chat = new ThreadChatService({
      store,
      bus,
      manager: getChatManager(),
      buildSnapshot: () => buildReadSnapshot(threadReadCap),
      launch: (pid, intent) =>
        performLaunch({ pid, intent, onOrchestrate: httpDeps.onOrchestrate, inFlight: httpDeps.inFlight, log }),
      startNarrator,
      // Thread ids become URL path segments (`/p/:id/t/:threadId`). slugifyIntent
      // KEEPS dots (e.g. an intent naming `FAQ.md`), but a dotted last path
      // segment makes the static server treat a reload/direct-nav as a file
      // request -> SPA fallback 404s. Strip dots so thread URLs always resolve.
      mintThreadId: (intent: string) =>
        slugifyIntent(intent)
          .replace(/\./g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, ""),
      log,
      now: () => Date.now(),
    });
    const narratorMessage = async (threadId: string, text: string): Promise<boolean> => {
      const n = narrators.get(threadId);
      if (!n) return false;
      try {
        await n.handleOperatorMessage(text);
      } catch {
        /* best-effort: a narrator reply failure must not fail the HTTP turn */
      }
      return true;
    };
    threadsCapability = { store, bus, chat, narratorMessage, closeThreads };
    return threadsCapability;
  };

  // Overnight escalation supervisor (spec 2026-07-17). Above-gate: it only drives the
  // reply-B triple (setAttempts + move) and reads escalation artifacts -- never the gate.
  // Reuses the `escalationsDir` already built for the escalate() wiring above.
  const decisionJournalPath = join(repoRoot, cfg.stateDir, "decision-journal.ndjson");
  const buildSupervisorDeps = (runOpts?: ConductorRunOptions) => ({
    enabled: cfg.autonomy.overnight.enabled,
    maxAutoReworks: cfg.autonomy.overnight.maxAutoReworks,
    // Each supervisor drain honors the operator's run options (e.g. maxIterations) --
    // `drain: true` is the supervisor's inherent mode (it must sweep the whole queue),
    // but the other bounds are NOT silently dropped when overnight is enabled.
    drain: () => conductor.run({ ...runOpts, drain: true }).then(() => undefined),
    listEscalated: async () => (await repo.listTasks("escalated")).map((t) => ({ id: t.id })),
    readEscalationType: async (taskId: string) => {
      const md = await readFile(join(escalationsDir, `${taskId}.md`), "utf8").catch(() => null);
      return md ? (parseEscalation(md)?.type ?? null) : null;
    },
    // Fail-closed: a corrupt/absent counter is handled by parseReworkCount -- absent -> 0
    // (fresh), corrupt -> maxAutoReworks (park), so a damaged counter never grants a
    // fresh unattended quota.
    getReworkCount: async (taskId: string) =>
      parseReworkCount(await repo.readRuntimeFile(taskId, "auto-rework-count"), cfg.autonomy.overnight.maxAutoReworks),
    setReworkCount: (taskId: string, n: number) => repo.writeRuntimeFile(taskId, "auto-rework-count", String(n)),
    requeueForRework: async (taskId: string) => {
      await repo.setAttempts(taskId, 0);
      await repo.moveTask(taskId, "escalated", "pending");
    },
    writeDecision: (entry: Parameters<typeof serializeDecision>[0]) =>
      appendFile(decisionJournalPath, serializeDecision(entry), "utf8"),
    now: () => new Date().toISOString(),
    log,
  });

  /** Overnight-aware run entry: when overnight autonomy is on, drive the supervisor
   *  loop (which internally drains + sweeps escalations, honoring `runOpts`); otherwise
   *  a plain bounded run with the operator's exact `runOpts` (byte-identical to the
   *  pre-existing `run` verb). */
  const runOrSupervise = async (runOpts?: ConductorRunOptions): Promise<void> => {
    if (await shouldSupervise(presence, cfg.autonomy.overnight.enabled)) {
      await superviseOvernight(buildSupervisorDeps(supervisorRunOpts(runOpts)));
    } else {
      await conductor.run(runOpts);
    }
  };

  // ---- Reports (spec 2026-07-22 "two reports") ------------------------------
  // Two documents that must never be mixed: the per-run Harness Execution Report
  // (written automatically once a run has finished) and the Product Qualification
  // Report (assembled ON DEMAND -- a claim about the product is a deliberate act,
  // spec D4). Both are pure functions over the per-task evidence ledger.
  const reportsDir = join(repoRoot, cfg.stateDir, "reports");
  const runsDirAbs = join(repoRoot, cfg.stateDir, "runs");

  /**
   * A run id reaches this module from a manifest ON DISK or from an operator's CLI
   * argument, and it is used to BUILD a path -- so it is re-validated with exactly
   * the allowlist the write side uses (`isPathSafeId`, which permits the dots
   * `slugifyIntent` preserves). Validating with a different, stricter function is
   * how every filename-derived run silently disappeared once before
   * (docs/gotchas/run-id-dot-validation-mismatch.md).
   */
  const executionReportPath = (runId: string, ext: "md" | "json"): string => {
    if (!isPathSafeId(runId)) throw new Error(`unsafe run id: ${JSON.stringify(runId)}`);
    // `<runId>.<ext>` -- NOT `run-<runId>`: a run id already starts with `run-`
    // (`slugifyIntent`), so a prefix here would bake `run-run-...` into every
    // artifact name forever. ONE function builds this name for both the write and
    // the `reportExists` probe: a probe looking at a different name than the writer
    // writes would regenerate every report on every pass, which is the
    // check-one-string/use-another shape this repo keeps getting bitten by
    // (docs/gotchas/validated-one-string-used-another.md).
    return join(reportsDir, `${runId}.${ext}`);
  };

  /** Best-effort read of every run manifest; one corrupt file is skipped (with a
   *  WARN), never allowed to hide every other run's report. */
  const listRunEntries = async (): Promise<RunListEntry[]> => {
    let files: string[];
    try {
      files = (await readdir(runsDirAbs)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      // A missing runs/ dir is the normal "no orchestrator run yet" case.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", `report: cannot list run manifests: ${String(err)}`);
      }
      return [];
    }
    const out: RunListEntry[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await readFile(join(runsDirAbs, f), "utf8")) as Partial<RunListEntry> | null;
        if (
          parsed === null ||
          typeof parsed.runId !== "string" ||
          !isPathSafeId(parsed.runId) ||
          typeof parsed.intent !== "string" ||
          typeof parsed.at !== "number" ||
          !Number.isFinite(parsed.at) ||
          !Array.isArray(parsed.taskIds) ||
          !parsed.taskIds.every((t) => typeof t === "string")
        ) {
          log("WARN", `report: skipping invalid run manifest ${f}`);
          continue;
        }
        out.push({ runId: parsed.runId, intent: parsed.intent, at: parsed.at, taskIds: parsed.taskIds });
      } catch (err) {
        log("WARN", `report: skipping unreadable run manifest ${f}: ${String(err)}`);
      }
    }
    return out;
  };

  const REPORT_QUEUE_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

  /** taskId -> the queue it currently sits in. Built once per report pass, so a
   *  run with N tasks does not re-walk the whole blackboard N times. */
  const loadTaskStates = async (): Promise<Map<string, QueueState>> => {
    const map = new Map<string, QueueState>();
    for (const state of REPORT_QUEUE_STATES) {
      for (const t of await repo.listTasks(state)) map.set(t.id, state);
    }
    return map;
  };

  const readEvidenceText = (taskId: string): Promise<string | null> => repo.readRuntimeFile(taskId, EVIDENCE_FILE);

  const refreshReports = async (): Promise<void> => {
    let states: Map<string, QueueState> | null = null;
    await refreshExecutionReports({
      listRuns: listRunEntries,
      taskState: async (taskId) => {
        states ??= await loadTaskStates();
        return states.get(taskId) ?? null;
      },
      readEvidence: readEvidenceText,
      reportExists: async (runId) => existsSync(executionReportPath(runId, "json")),
      writeReport: async (runId, markdown, json) => {
        await mkdir(reportsDir, { recursive: true });
        // Markdown FIRST, JSON second: `reportExists` probes the .json, so a
        // half-written pair is retried on the next pass instead of being marked
        // done with a missing rendering.
        await writeFile(executionReportPath(runId, "md"), markdown, "utf8");
        await writeFile(executionReportPath(runId, "json"), json, "utf8");
      },
      log,
    });
  };

  const readExecutionReport = async (runId: string): Promise<string | null> => {
    const p = executionReportPath(runId, "md");
    return existsSync(p) ? readFile(p, "utf8") : null;
  };

  /**
   * The stored report's JSON, for the API layer. It goes through
   * `executionReportPath` for the same reason `reportExists` does: ONE function
   * builds this filename. The read is bounded + TOCTOU-hardened, and an unsafe run
   * id (which the route already rejects) degrades to `null` rather than throwing out
   * of a request handler -- the route reports that as "not ready", which is the safe
   * direction for a name this function refuses to build.
   */
  const readExecutionReportJson = async (runId: string): Promise<string | null> => {
    let p: string;
    try {
      p = executionReportPath(runId, "json");
    } catch (err) {
      log("WARN", `report: refusing to read a report for an unsafe run id: ${String(err)}`);
      return null;
    }
    return readBoundedFileText(p, MAX_BOUNDED_READ_BYTES);
  };

  /** `git rev-list`, spawned as argv (never a shell string). A non-zero exit THROWS:
   *  degrading it to "no commits" would produce an empty report that reads as
   *  "nothing to prove" -- the exact silent overclaim this feature exists to avoid. */
  const gitRevList = async (args: string[]): Promise<string[]> => {
    const r = await runNative("git", ["rev-list", ...args], { cwd: repoRoot });
    if (r.exitCode !== 0) {
      throw new Error(`git rev-list ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const qualificationReport = async (range: {
    from?: string;
    to?: string;
  }): Promise<{ json: QualificationReport; markdown: string }> => {
    const to = range.to ?? "HEAD";
    // With an explicit `from` the operator's exclusive two-dot semantics apply.
    // With the DEFAULT `from` (the repository's root commit) the range is the full
    // history of `to` instead: `<root>..<to>` excludes `<root>` itself, which would
    // silently drop a task that landed as the very first commit.
    let from: string;
    let commits: string[];
    if (range.from === undefined) {
      // Newest-first; the last entry is the oldest root of this history.
      const roots = await gitRevList(["--max-parents=0", to]);
      from = roots[roots.length - 1] ?? to;
      commits = await gitRevList([to]);
    } else {
      from = range.from;
      commits = await gitRevList([`${range.from}..${to}`]);
    }
    const taskIds = [...(await loadTaskStates()).keys()];
    const slots = await loadEvidence(taskIds, readEvidenceText);
    const doc = buildQualificationReport({ from, to, commits }, slots);
    return { json: doc, markdown: renderQualificationReport(doc) };
  };

  /** Assemble the Morning Report on demand (spec 2026-07-23): the decision journal
   *  is the record of what unattended autonomy DECIDED; `loadTaskStates` is the
   *  live blackboard's truth about where each task landed (Principle 11). Narration
   *  reuses the same orchestrator one-shot as the thread narrator -- a failure there
   *  is logged and swallowed, never allowed to fail the whole report. */
  const morningReport = async (opts?: { since?: string }): Promise<{ report: MorningReport; markdown: string }> => {
    let journalText = "";
    try {
      journalText = await readFile(decisionJournalPath, "utf8");
    } catch (err) {
      // Only a genuine "not there" is an empty report. A real read error (EACCES, EIO,
      // ...) means the journal data is UNKNOWN, not absent -- fabricating "no overnight
      // decisions" over an unreadable file would be a fail-open lie (Principle 11
      // honesty). ENOENT (no overnight ran yet) is the one legitimately-empty case.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      journalText = "";
    }
    const { entries, skipped } = parseDecisionJournal(journalText);

    const states = await loadTaskStates();

    const report = buildMorningReport(
      entries,
      (id) => states.get(id) ?? null,
      () => Date.now(),
      { ...(opts?.since !== undefined ? { since: opts.since } : {}), skipped },
    );

    try {
      const text = await narrate(buildMorningReportPrompt(report), () => {});
      if (text.trim() !== "") {
        report.narration = text.trim();
      }
    } catch (err) {
      // Best-effort, and the logger itself may throw ([ts/fail-closed]): a narration
      // miss -- including a throw from the narrate call OR from the logger recording it
      // -- must never turn into a rejected report. The structured digest always stands.
      try {
        log("WARN", `morningReport: narration failed (ignored): ${String(err)}`);
      } catch {
        /* a broken logger must not resurrect the failure */
      }
    }

    return { report, markdown: renderMorningReport(report) };
  };

  return {
    repoRoot,
    cfg,
    repo,
    conductor,
    orchestrator: { handleIntent: (intent) => getOrchestrator().handleIntent(intent) },
    get chat(): ChatSessionManager {
      return getChatManager();
    },
    applyOnAccept: (taskId) =>
      runApplyOnAccept({
        taskId,
        repoRoot,
        cfg,
        git,
        mainTreeStatus: () => mainTreeStatus(repoRoot),
        readPatch: () => repo.readRuntimeFile(taskId, "diff.patch"),
        readLoopBranch: async () => (await repo.readRuntimeFile(taskId, "loop-branch"))?.trim() || null,
        readTask: async () => (await repo.listTasks("escalated")).find((t) => t.id === taskId) ?? null,
        log,
      }),
    log,
    stateDirAbs: join(repoRoot, cfg.stateDir),
    plannerConfigured,
    get ci() {
      return {
        bus: getCiBus(),
        readEvents: async (taskId: string): Promise<string> =>
          (await repo.readRuntimeFile(taskId, "agent-ci-events.ndjson")) ?? "",
      };
    },
    onCiCapability: () => detectAgentCiCapability(),
    buildThreads,
    closeThreads,
    rearmNarratorForTask,
    runOrSupervise,
    refreshReports,
    readExecutionReport,
    readExecutionReportJson,
    qualificationReport,
    morningReport,
  };
}

/**
 * Does this opts object actually carry a bound? `ConductorRunOptions` has exactly
 * three bounding fields, and an opts object without any of them is
 * run-until-session-cap. An explicit allow-list on the VALUE (not on key
 * presence) is required: `{maxIterations: undefined}` is type-valid and has a
 * key, so a key-count check would wave it through as an unbounded run. Nor is
 * `once: false`/`drain: false` a bound.
 *
 * This backs `trigger`'s bounded default. The orchestrator always passes a real
 * bound, so this only ever catches a caller that specified none -- but that
 * handle now starts an UNATTENDED loop, so the fail direction must be bounded.
 * Keep in sync with `ConductorRunOptions` (conductor.ts): a new bounding field
 * must be added here, and the compiler will not tell you.
 */
export function hasBound(opts: ConductorRunOptions | undefined): boolean {
  if (!opts) return false;
  // `Number.isFinite`, not `typeof === "number"`: the conductor bounds a run with
  // `iterations >= opts.maxIterations` (conductor.ts:705), and that comparison is
  // ALWAYS false for NaN and never true for Infinity -- either value type-checks
  // as a bound and runs unbounded. `0` and negatives are genuinely bounded there
  // (the comparison holds on the first iteration), so they stay accepted.
  return opts.once === true || opts.drain === true || Number.isFinite(opts.maxIterations);
}

/**
 * Builds the orchestrator's exact capability surface (adr/003 R1): `enqueue`,
 * `trigger`, `read`, `report`, `recordRun` and nothing else. Extracted out of
 * `buildOrchestrator` so `trigger`'s routing is directly unit-testable
 * (see root.test.ts's "orchestrator trigger routing" suite) without spinning
 * up a real `OrchestratorAdapter` (which would spawn a real `claude`/`codex`
 * process). This is composition glue, same pattern as the individual capability
 * builders in orchestrator/capabilities.ts.
 */
export function buildOrchestratorCapabilities(ctx: {
  cfg: HarnessConfig;
  repoRoot: string;
  repo: FileBlackboardRepository;
  /** The overnight-aware run entry (`runOrSupervise`). Still the orchestrator's
   *  ONLY enforcement handle and still only STARTS a bounded loop -- adr/003 R1
   *  is unchanged; overnight merely decides WHICH bounded loop starts. */
  runEntry: (opts?: ConductorRunOptions) => Promise<void>;
  log: Logger;
}): OrchestratorCapabilities {
  const { cfg, repoRoot, repo, runEntry, log } = ctx;

  const existingIds = async (): Promise<string[]> => {
    const states = ["pending", "active", "done", "escalated", "quarantine"] as const;
    const all = await Promise.all(states.map((s) => repo.listTasks(s)));
    return all.flat().map((t) => t.id);
  };

  return {
    enqueue: createEnqueueCapability({ repoRoot, stateDir: cfg.stateDir, existingIds }),
    trigger: (opts) => runEntry(hasBound(opts) ? opts : { once: true }),
    read: createReadCapability(repo),
    report: createReportCapability(repo, log),
    recordRun: createRecordRunCapability({
      runsDir: join(repoRoot, cfg.stateDir, "runs"),
      now: () => Date.now(),
      log,
    }),
  };
}

/**
 * Build the orchestrator layer (adr/003 R1/R2) over the daemon's overnight-aware
 * run entry. Reused by BOTH the `orchestrate` CLI verb (decompose one intent,
 * run once, exit) and the `serve` verb (`POST /orchestrate` calls
 * `handleIntent` per request, via `ApiServerDeps.onOrchestrate`).
 *
 * The orchestrator receives EXACTLY the four capabilities (+recordRun) and
 * nothing else — `trigger` is a closure over `runEntry` (`runOrSupervise`),
 * the ONLY enforcement handle it sees, and it can only START a bounded loop,
 * never sequence/skip/gate/commit -- overnight autonomy only decides WHICH
 * bounded loop starts. There is no worker/critic/gate/worktree handle in its
 * dependency surface, so it — and therefore anything built on top of it,
 * including the HTTP layer's `onOrchestrate` closure — physically cannot talk
 * past the gate (adr/003 R1).
 */
function buildOrchestrator(ctx: {
  cfg: HarnessConfig;
  repoRoot: string;
  repo: FileBlackboardRepository;
  runEntry: (opts?: ConductorRunOptions) => Promise<void>;
  log: Logger;
}): { handleIntent(intent: string): Promise<OrchestratorResult> } {
  const { cfg, repoRoot, log } = ctx;

  const caps: OrchestratorCapabilities = buildOrchestratorCapabilities(ctx);

  const adapter = ((): OrchestratorAdapter => {
    switch (cfg.roles.orchestrator.adapter) {
      case "claude":
        return new ClaudeOrchestratorAdapter({ cfg, repoRoot });
      default:
        throw new Error(
          `no orchestrator adapter registered for '${cfg.roles.orchestrator.adapter}' (MVP supports: claude)`,
        );
    }
  })();

  return createOrchestrator({ caps, adapter, log });
}
