// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags, constructs every real dependency,
// and starts it). This module is the production composition root — it is
// integration glue that spawns real `claude`/`codex`/`git`, so it is
// deliberately NOT unit-tested; every module it wires already has its own
// unit tests against injected fakes.
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { detectRepoRoot, loadConfig } from "./config/config.js";
import { FileBlackboardRepository } from "./blackboard/file-repository.js";
import { createScheduler } from "./scheduler/scheduler.js";
import { createWorktreeManager, type Worktree } from "./worktree/worktree.js";
import { createRouter } from "./router/router.js";
import { createGit } from "./util/git.js";
import { runNative } from "./util/native.js";
import { ClaudeWorkerAdapter } from "./worker/claude-adapter.js";
import { RealWatchedProcessRunner } from "./watchdog/watchdog.js";
import { CodexCriticAdapter } from "./critic/codex-adapter.js";
import { runGate as runGateCore, type GateDeps, type GateInput, type GateVerdict } from "./gate/gate.js";
import { parseInvariants, zoneTouched, diffAddedRemovedLines, type Invariants } from "./gate/invariants.js";
import {
  parseGuardsTable,
  isMutationVerified,
  type GuardRow,
  type GuardRecipePair,
  type GuardRecipe,
} from "./gate/guards.js";
import { mutationCheck, type MutationRecipe } from "./gate/mutation-check.js";
import { escalate as escalateCore, type EscalationInput } from "./escalate/escalate.js";
import { runAntiDrift as runAntiDriftCore, type AntiDriftInput } from "./anti-drift/anti-drift.js";
import { snapshot } from "./util/fingerprint.js";
import { harvestWorkerReport as harvestWorkerReportCore } from "./worker/report.js";
import { createConductor, type ConductorDeps, type ConductorRunOptions } from "./conductor/conductor.js";
import { createLogger } from "./util/log.js";

const EMPTY_INVARIANTS: Invariants = { version: 1, updated: "", contract_zones: [], constitution: { path_globs: [] } };

/** Parse a `--max-iterations` value; a non-positive-integer must fail LOUD, never
 * silently disable the limit (NaN would make the conductor's `iterations >= max`
 * guard perpetually false). */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** `--once` / `--max-iterations <n>` / `--max-iterations=<n>` from `process.argv.slice(2)`. */
function parseArgs(argv: string[]): ConductorRunOptions {
  let once = false;
  let maxIterations: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--once") {
      once = true;
    } else if (arg === "--max-iterations") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error("--max-iterations: missing value (expected a positive integer)");
      }
      maxIterations = parsePositiveInt(val, arg);
      i++;
    } else if (arg.startsWith("--max-iterations=")) {
      maxIterations = parsePositiveInt(arg.slice("--max-iterations=".length), "--max-iterations");
    }
  }

  return {
    ...(once ? { once } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

/** Split a shell-style single-line command into `[cmd, ...args]`, guarding the noUncheckedIndexedAccess `[0]`. */
function splitCommand(cmd: string): { c: string; a: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const c = parts[0];
  if (!c) throw new Error(`splitCommand: empty command: ${JSON.stringify(cmd)}`);
  return { c, a: parts.slice(1) };
}

async function main(): Promise<void> {
  const runOpts = parseArgs(process.argv.slice(2));

  const repoRoot = detectRepoRoot(process.cwd());
  const cfg = await loadConfig(repoRoot);

  const log = createLogger(join(repoRoot, cfg.stateDir, "conductor.log"));

  // --- Core dependencies -----------------------------------------------
  const repo = new FileBlackboardRepository(repoRoot, cfg.stateDir);
  const scheduler = createScheduler(repo);
  const worktreesDir = join(repoRoot, cfg.stateDir, "worktrees");
  const worktree = createWorktreeManager(repoRoot, worktreesDir);
  const router = createRouter(cfg);
  const git = createGit(repoRoot);
  const worktreeGit = (wt: Worktree) => createGit(wt.path);

  const worker = new ClaudeWorkerAdapter({ runner: new RealWatchedProcessRunner(), cfg });
  const critic = new CodexCriticAdapter({ cfg, repoRoot });

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
        const r = await runNative(cfg.worker.exe, ["-p", "--model", model], { cwd: repoRoot, stdin: prompt });
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
  await conductor.run(runOpts);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
