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
import { existsSync } from "node:fs";
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
  type OrchestratorCapabilities,
} from "../orchestrator/capabilities.js";
import { ClaudeOrchestratorAdapter } from "../orchestrator/claude-orchestrator-adapter.js";
import type { OrchestratorAdapter } from "../orchestrator/adapter.js";
import { createOrchestrator, type OrchestratorResult } from "../orchestrator/orchestrator.js";
import { ChatSessionManager } from "../orchestrator/chat-session-manager.js";
import { ClaudeOrchestratorChatAdapter } from "../orchestrator/claude-orchestrator-chat-adapter.js";
import type { OrchestratorChatAdapter } from "../orchestrator/chat-adapter.js";
import { runGate as runGateCore, type GateDeps, type GateInput, type GateVerdict } from "../gate/gate.js";
import { runAgentCiWorkflows } from "../gate/agent-ci.js";
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
        ? async () => {
            if (agentCi.workflows.length === 0) {
              // Enabled but nothing to run: fail OPEN with a loud warning
              // (mirrors policy.heterogeneity's misconfig convention). Never
              // blocks a run on a half-finished config.
              log("WARN", "gate.agentCi.enabled but workflows allowlist is empty -- skipping agent-ci this round");
              return { green: true, reasons: [] };
            }
            return runAgentCiWorkflows({
              cwd: wt.path,
              workflows: agentCi.workflows,
              timeoutMs: agentCi.timeoutMs,
              runner: runNative,
            });
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
