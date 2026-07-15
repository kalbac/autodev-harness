// Composition root: wires ONE project's full dependency graph (config, blackboard
// repo, scheduler, worktree manager, router, git, worker/critic adapters,
// contract-zone plumbing, gate, escalate, anti-drift, conductor, orchestrator).
// Extracted from src/index.ts (originally the daemon's inline `main()` wiring,
// used for the single cwd-detected repoRoot) so a later task can build one
// ProjectRoot per registered project (hub + registry) without duplicating this
// wiring. This module is integration glue that spawns real `claude`/`codex`/`git`,
// so it is deliberately NOT unit-tested; every module it wires already has its
// own unit tests against injected fakes (same status as src/index.ts).
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { loadConfigWithRaw, isPlannerExplicitlyConfigured } from "../config/config.js";
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
import { harvestWorkerReport as harvestWorkerReportCore } from "../worker/report.js";
import { createConductor, type Conductor, type ConductorDeps } from "../conductor/conductor.js";
import { createLogger, type Logger } from "../util/log.js";
import type { HarnessConfig } from "../config/schema.js";

const EMPTY_INVARIANTS: Invariants = { version: 1, updated: "", contract_zones: [], constitution: { path_globs: [] } };

/** Split a shell-style single-line command into `[cmd, ...args]`, guarding the noUncheckedIndexedAccess `[0]`. */
function splitCommand(cmd: string): { c: string; a: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const c = parts[0];
  if (!c) throw new Error(`splitCommand: empty command: ${JSON.stringify(cmd)}`);
  return { c, a: parts.slice(1) };
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

export async function buildProjectRoot(repoRoot: string): Promise<ProjectRoot> {
  const { cfg, raw } = await loadConfigWithRaw(repoRoot);
  const plannerConfigured = isPlannerExplicitlyConfigured(raw);

  const log = createLogger(join(repoRoot, cfg.stateDir, "conductor.log"));

  // --- Core dependencies -----------------------------------------------
  const repo = new FileBlackboardRepository(repoRoot, cfg.stateDir);
  const scheduler = createScheduler(repo);
  const worktreesDir = join(repoRoot, cfg.stateDir, "worktrees");
  const worktree = createWorktreeManager(repoRoot, worktreesDir, {
    provision: cfg.worktree.provision,
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
  /** Parse `<root>/<contract.invariantsFile>`; missing/empty file -> an empty (zero-zone) Invariants. */
  async function loadInvariantsFrom(root: string): Promise<Invariants> {
    const p = join(root, cfg.contract.invariantsFile);
    if (!existsSync(p)) return EMPTY_INVARIANTS;
    const text = await readFile(p, "utf8");
    if (text.trim() === "") return EMPTY_INVARIANTS;
    return parseInvariants(text);
  }

  /** Parse `<root>/<contract.guardsFile>` and load each mutation-verified row's recipe JSON. Best-effort. */
  async function loadGuardPairsFrom(root: string): Promise<GuardRecipePair[]> {
    const p = join(root, cfg.contract.guardsFile);
    if (!existsSync(p)) return [];
    const text = await readFile(p, "utf8");
    const rows = parseGuardsTable(text);

    const pairs: GuardRecipePair[] = [];
    for (const row of rows) {
      if (!isMutationVerified(row)) continue;
      const recipePath = join(root, row.recipe);
      if (!existsSync(recipePath)) continue;
      try {
        const recipeText = await readFile(recipePath, "utf8");
        const recipe = JSON.parse(recipeText) as GuardRecipe;
        pairs.push({ guard: row, recipe });
      } catch {
        continue; // unparseable recipe -- skip, never let one bad file break the whole table
      }
    }
    return pairs;
  }

  /** Which contract zones (by id) does this diff touch? Path-less: only the +/- diff lines are checked. */
  const zonesTouchedInDiff = async (diff: string): Promise<string[]> => {
    const inv = await loadInvariantsFrom(repoRoot);
    const diffLines = diffAddedRemovedLines(diff);
    return inv.contract_zones.filter((z) => zoneTouched(z, [], diffLines)).map((z) => z.id);
  };

  // --- Gate --------------------------------------------------------------
  function gateDeps(wt: Worktree): GateDeps {
    const checkCommand = cfg.gate.checkCommand;
    const agentCi = cfg.gate.agentCi;
    return {
      loadInvariants: () => loadInvariantsFrom(wt.path),
      loadGuardPairs: () => loadGuardPairsFrom(wt.path),
      resolveScope: async (inp: GateInput) => {
        const g = createGit(wt.path);
        return { changedFiles: await g.changedFiles(inp.fileSet), diffText: await g.diffText(inp.fileSet) };
      },
      runCheck: checkCommand
        ? async () => {
            const { c, a } = splitCommand(checkCommand);
            const r = await runNative(c, a, { cwd: wt.path });
            return { green: r.exitCode === 0, exitCode: r.exitCode };
          }
        : null,
      runSuccessCommand: async (cmd: string) => {
        const { c, a } = splitCommand(cmd);
        const r = await runNative(c, a, { cwd: wt.path });
        return { exitCode: r.exitCode };
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
        const pairs = await loadGuardPairsFrom(wt.path);
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

  const harvestWorkerReport = async (wt: Worktree, taskId: string): Promise<void> => {
    await harvestWorkerReportCore(wt.path, repo.runtimeDir(taskId));
  };

  const clock = { now: () => Date.now() };
  const sleep = (seconds: number): Promise<void> => new Promise((r) => setTimeout(r, seconds * 1000));

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
    gitChangedPaths,
    snapshotFingerprints,
    zonesTouchedInDiff,
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
  const getOrchestrator = () => (orchestrator ??= buildOrchestrator({ cfg, repoRoot, repo, conductor, log }));

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
  };
}

/**
 * Build the orchestrator layer (adr/003 R1/R2) over an already-wired
 * conductor. Reused by BOTH the `orchestrate` CLI verb (decompose one intent,
 * run once, exit) and the `serve` verb (`POST /orchestrate` calls
 * `handleIntent` per request, via `ApiServerDeps.onOrchestrate`).
 *
 * The orchestrator receives EXACTLY the four capabilities (+recordRun) and
 * nothing else — `trigger` is a closure over `conductor.run`, the ONLY
 * enforcement handle it sees, and it can only START the (bounded) loop, never
 * sequence/skip/gate/commit. There is no worker/critic/gate/worktree handle
 * in its dependency surface, so it — and therefore anything built on top of
 * it, including the HTTP layer's `onOrchestrate` closure — physically cannot
 * talk past the gate (adr/003 R1).
 */
function buildOrchestrator(ctx: {
  cfg: HarnessConfig;
  repoRoot: string;
  repo: FileBlackboardRepository;
  conductor: Conductor;
  log: Logger;
}): { handleIntent(intent: string): Promise<OrchestratorResult> } {
  const { cfg, repoRoot, repo, conductor, log } = ctx;

  const existingIds = async (): Promise<string[]> => {
    const states = ["pending", "active", "done", "escalated", "quarantine"] as const;
    const all = await Promise.all(states.map((s) => repo.listTasks(s)));
    return all.flat().map((t) => t.id);
  };

  const caps: OrchestratorCapabilities = {
    enqueue: createEnqueueCapability({ repoRoot, stateDir: cfg.stateDir, existingIds }),
    // Bounded default: an argless `trigger()` must NOT start the unbounded
    // run loop (`{}` = run-until-session-cap). The orchestrator always passes
    // `{maxIterations}`, but the capability itself defaults to a single pass so
    // no caller can accidentally launch an unbounded run through this handle.
    trigger: (opts) => conductor.run(opts ?? { once: true }),
    read: createReadCapability(repo),
    report: createReportCapability(repo, log),
    recordRun: createRecordRunCapability({
      runsDir: join(repoRoot, cfg.stateDir, "runs"),
      now: () => Date.now(),
      log,
    }),
  };

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
