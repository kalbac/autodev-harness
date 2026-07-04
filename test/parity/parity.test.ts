/**
 * Task 28 — the parity harness (P1 Definition of Done, fixture side).
 *
 * Drives the REAL conductor (`createConductor`) over a REAL on-disk fixture
 * blackboard (`FileBlackboardRepository`) + REAL scheduler + REAL escalate
 * module, with fake worker/critic/worktree/git adapters and a scripted gate,
 * and asserts the same COMMIT/ESCALATE/RETRY decisions and `queue/done/`,
 * `queue/escalated/`, `queue/quarantine/`, `escalations/` end-state that the
 * PowerShell autodev-loop oracle produces for equivalent inputs (see
 * `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md`).
 *
 * Self-contained: this file does not import fakes from
 * `src/conductor/conductor.test.ts` -- it builds its own harness so the
 * fixture wiring can freely diverge (real repo/scheduler/escalate instead of
 * in-memory fakes) while mirroring that file's fake-building *style*.
 *
 * No real network, no real git subprocess: the worktree/git seams are faked
 * (see divergence #1 note below); only the blackboard repo and the escalate
 * artifact writer touch a real (temp) filesystem.
 *
 * SCOPE NOTE: this parity harness asserts the on-disk queue/escalation
 * end-state for the primary decision routes + divergences #1/#4/#8/#9/#10.
 * The following conductor branches are already parity-verified with fakes in
 * `src/conductor/conductor.test.ts` and are intentionally NOT duplicated
 * here: worker `TIMED_OUT` -> pending (no refund), gate-throw fail-closed
 * escalation typing, `run()` branch preflight rejecting `main`/disallowed
 * branches, anti-drift `DRIFT:` -> escalation, and best-effort teardown
 * swallowing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile, appendFile as fsAppendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { stringify as yamlStringify } from "yaml";

import { createConductor } from "../../src/conductor/conductor.js";
import type { ConductorDeps, Conductor } from "../../src/conductor/conductor.js";
import { FileBlackboardRepository } from "../../src/blackboard/file-repository.js";
import { parseTask } from "../../src/blackboard/task.js";
import type { Task } from "../../src/blackboard/types.js";
import type { QueueState } from "../../src/blackboard/repository.js";
import { createScheduler } from "../../src/scheduler/scheduler.js";
import { createRouter } from "../../src/router/router.js";
import { escalate as realEscalate } from "../../src/escalate/escalate.js";
import type { EscalateDeps, EscalationInput } from "../../src/escalate/escalate.js";
import { HarnessConfigSchema, type HarnessConfig } from "../../src/config/schema.js";
import type { Worktree, WorktreeManager } from "../../src/worktree/worktree.js";
import type { Git, MergeResult } from "../../src/util/git.js";
import type { WorkerAdapter, WorkerResult, WorkerRunInput } from "../../src/worker/adapter.js";
import type { CriticAdapter, CriticResult, CriticRunInput } from "../../src/critic/adapter.js";
import type { GateInput, GateVerdict } from "../../src/gate/gate.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TaskSeed {
  id: string;
  title?: string;
  type?: string;
  touches_contract_zone?: boolean;
  file_set?: string[];
  forbidden_paths?: string[];
  success_commands?: string[];
  depends_on?: string[];
  contract_zones_touched?: string[];
  model?: string | null;
  max_rounds?: number | null;
  needs_guard?: boolean;
  body?: string;
}

interface WorkerStep {
  result: WorkerResult;
  report?: string;
}

interface CriticStep {
  result: CriticResult;
}

interface HarnessOptions {
  cfgOverrides?: Record<string, unknown>;
  workerScript?: WorkerStep[];
  criticScript?: CriticStep[];
  runGate?: ConductorDeps["runGate"];
  /** Sequence of `git.currentBranch()` results; last value repeats once exhausted. */
  gitBranches?: string[];
  mergeResult?: MergeResult;
  diffText?: string;
  zonesTouchedInDiff?: ConductorDeps["zonesTouchedInDiff"];
  gitChangedPaths?: ConductorDeps["gitChangedPaths"];
  snapshotFingerprints?: ConductorDeps["snapshotFingerprints"];
  clock?: { now: () => number };
}

interface Harness {
  conductor: Conductor;
  repo: FileBlackboardRepository;
  root: string;
  autodevDir: string;
  cfg: HarnessConfig;
  logs: { level: string; message: string }[];
  workerCalls: WorkerRunInput[];
  criticCalls: CriticRunInput[];
  worktreeCreateCalls: { taskId: string; baseBranch: string }[];
  worktreeMergeCalls: { taskId: string; into: string }[];
  worktreeGitAdds: { taskId: string; paths: string[] }[];
  worktreeGitCommits: { taskId: string; message: string }[];
  gateCalls: GateInput[];
  sleepCalls: number[];
  seedTask: (spec: TaskSeed) => Task;
  queuePath: (state: QueueState, id: string) => string;
  escalationPath: (id: string) => string;
}

function seedTaskFile(root: string, spec: TaskSeed): Task {
  const fm = {
    id: spec.id,
    title: spec.title ?? "Test task",
    type: spec.type ?? "feature",
    touches_contract_zone: spec.touches_contract_zone ?? false,
    file_set: spec.file_set ?? ["a.ts"],
    forbidden_paths: spec.forbidden_paths ?? [],
    success_commands: spec.success_commands ?? [],
    depends_on: spec.depends_on ?? [],
    contract_zones_touched: spec.contract_zones_touched ?? [],
    model: spec.model ?? null,
    max_rounds: spec.max_rounds ?? null,
    needs_guard: spec.needs_guard ?? false,
  };
  const body = spec.body ?? "Body.";
  const content = `---\n${yamlStringify(fm)}---\n${body}\n`;
  const dir = join(root, ".autodev", "queue", "pending");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec.id}.md`), content);
  return parseTask(content, join("queue", "pending", `${spec.id}.md`));
}

function makeParityHarness(opts: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "adh-parity-"));
  const stateDir = ".autodev";
  const autodevDir = join(root, stateDir);

  // REAL blackboard repo + REAL scheduler (both are pure fs/set-logic --
  // exercising them for real is the whole point of this harness).
  const repo = new FileBlackboardRepository(root, stateDir);
  const scheduler = createScheduler(repo);

  const cfg = HarnessConfigSchema.parse(opts.cfgOverrides ?? {});
  const router = createRouter(cfg);

  const logs: { level: string; message: string }[] = [];
  const log = (level: string, message: string): void => {
    logs.push({ level, message });
  };

  // --- worker (fake, scripted) ---
  const workerCalls: WorkerRunInput[] = [];
  const workerScript: WorkerStep[] = opts.workerScript ?? [
    {
      result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
      report: "status: DONE",
    },
  ];
  let workerIdx = 0;
  const worker: WorkerAdapter = {
    async run(input: WorkerRunInput): Promise<WorkerResult> {
      workerCalls.push(input);
      const step = workerScript[Math.min(workerIdx, workerScript.length - 1)]!;
      workerIdx++;
      if (step.report !== undefined) {
        await repo.writeRuntimeFile(input.task.id, "worker-report.md", step.report);
      }
      return step.result;
    },
  };

  // --- critic (fake, scripted) ---
  const criticCalls: CriticRunInput[] = [];
  const criticScript: CriticStep[] = opts.criticScript ?? [
    { result: { verdict: { verdict: "clean", broken_contracts: [], notes: "", confidence: 1 }, rateLimited: false } },
  ];
  let criticIdx = 0;
  const critic: CriticAdapter = {
    async run(input: CriticRunInput): Promise<CriticResult> {
      criticCalls.push(input);
      const step = criticScript[Math.min(criticIdx, criticScript.length - 1)]!;
      criticIdx++;
      return step.result;
    },
  };

  // --- worktree (FAKE -- models parity divergence #1: the real conductor
  // never had per-task git worktrees ("all workers share ONE working tree,
  // serialized purely by file_set disjointness" -- parity spec §11 #1). Our
  // TS port DOES use a per-task worktree seam (AO's isolation pattern). This
  // harness targets DECISIONS + queue end-state parity, not git internals,
  // so the worktree manager here is a thin fake over a real (harmless) temp
  // dir -- any accidental fs op inside it is inert. ---
  const worktreeCreateCalls: { taskId: string; baseBranch: string }[] = [];
  const worktreeMergeCalls: { taskId: string; into: string }[] = [];
  let worktreeCounter = 0;
  const worktree: WorktreeManager = {
    async create(taskId: string, baseBranch: string): Promise<Worktree> {
      worktreeCreateCalls.push({ taskId, baseBranch });
      const path = join(root, "worktrees", `${taskId}-${worktreeCounter++}`);
      mkdirSync(path, { recursive: true });
      return { path, branch: `autodev/wt-${taskId}`, taskId };
    },
    async diff(): Promise<string> {
      return opts.diffText ?? "";
    },
    async teardown(): Promise<void> {
      // no-op, per the locked harness design.
    },
    async mergeAfterGate(wt: Worktree, intoBranch: string): Promise<MergeResult> {
      worktreeMergeCalls.push({ taskId: wt.taskId, into: intoBranch });
      return opts.mergeResult ?? { ok: true, conflict: false };
    },
  };

  // --- git (main repo, fake, scripted branch sequence) ---
  const gitBranches = opts.gitBranches ?? ["autodev/loop"];
  let gitBranchIdx = 0;
  const git: Git = {
    async currentBranch(): Promise<string> {
      const b = gitBranches[Math.min(gitBranchIdx, gitBranches.length - 1)]!;
      gitBranchIdx++;
      return b;
    },
    async changedFiles(): Promise<string[]> {
      return [];
    },
    async diffText(): Promise<string> {
      return "";
    },
    async add(): Promise<void> {
      /* not used on main git */
    },
    async commit(): Promise<string> {
      throw new Error("commit should not be called on main git");
    },
    async worktreeAdd(): Promise<void> {
      /* unused */
    },
    async worktreeRemove(): Promise<void> {
      /* unused */
    },
    async merge(): Promise<MergeResult> {
      return { ok: true, conflict: false };
    },
  };

  // --- worktreeGit(wt) (fake) ---
  const worktreeGitAdds: { taskId: string; paths: string[] }[] = [];
  const worktreeGitCommits: { taskId: string; message: string }[] = [];
  const worktreeGit = (wt: Worktree): Git => ({
    async currentBranch(): Promise<string> {
      return wt.branch;
    },
    async changedFiles(): Promise<string[]> {
      return [];
    },
    async diffText(): Promise<string> {
      return "";
    },
    async add(paths: string[]): Promise<void> {
      worktreeGitAdds.push({ taskId: wt.taskId, paths });
    },
    async commit(message: string): Promise<string> {
      worktreeGitCommits.push({ taskId: wt.taskId, message });
      return "deadbeef";
    },
    async worktreeAdd(): Promise<void> {
      /* unused */
    },
    async worktreeRemove(): Promise<void> {
      /* unused */
    },
    async merge(): Promise<MergeResult> {
      return { ok: true, conflict: false };
    },
  });

  // --- runGate (scripted per-scenario, always wrapped by a call recorder) ---
  const gateCalls: GateInput[] = [];
  const baseGate: ConductorDeps["runGate"] =
    opts.runGate ??
    (async (input): Promise<GateVerdict> => ({
      task_id: input.taskId,
      composer_green: true,
      success_green: true,
      constitution_touched: [],
      zones_touched: [],
      decision: "COMMIT",
      reasons: [],
      changed_files: [],
    }));
  const runGate: ConductorDeps["runGate"] = async (input, wt) => {
    gateCalls.push(input);
    return baseGate(input, wt);
  };

  // --- escalate (REAL module) -- writes escalations/<id>.md under the real
  // temp stateDir via node:fs/promises; env() always returns undefined so
  // delivery is forced to the _outbox.md fallback path -- no network, ever.
  const escalateDeps: EscalateDeps = {
    escalationsDir: join(autodevDir, "escalations"),
    writeFile: async (path: string, content: string): Promise<void> => {
      await fsMkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content);
    },
    appendFile: async (path: string, content: string): Promise<void> => {
      await fsMkdir(dirname(path), { recursive: true });
      await fsAppendFile(path, content);
    },
    env: (): string | undefined => undefined,
    log,
  };
  const escalate = (input: EscalationInput): Promise<unknown> => realEscalate(input, escalateDeps);

  // --- fingerprint deps: default "nothing stray, no zones touched" ---
  const gitChangedPaths = opts.gitChangedPaths ?? (async (): Promise<string[]> => []);
  const snapshotFingerprints = opts.snapshotFingerprints ?? ((): Map<string, string> => new Map());
  const zonesTouchedInDiff = opts.zonesTouchedInDiff ?? (async (): Promise<string[]> => []);

  const clock = opts.clock ?? { now: (): number => Date.now() };
  const sleepCalls: number[] = [];
  const sleep = async (seconds: number): Promise<void> => {
    sleepCalls.push(seconds);
    // still resolves immediately -- never really sleeps in tests.
  };

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
    runAntiDrift: async (): Promise<string> => "ON-TRACK: fine",
    // No-op: this harness's worker fake (line ~174) already writes
    // "worker-report.md" straight into repo runtime files, so there is
    // nothing in a real worktree to relocate for these scripted scenarios.
    harvestWorkerReport: async (): Promise<void> => {},
    gitChangedPaths,
    snapshotFingerprints,
    zonesTouchedInDiff,
    clock,
    sleep,
    log,
  };

  const conductor = createConductor(deps);

  return {
    conductor,
    repo,
    root,
    autodevDir,
    cfg,
    logs,
    workerCalls,
    criticCalls,
    worktreeCreateCalls,
    worktreeMergeCalls,
    worktreeGitAdds,
    worktreeGitCommits,
    gateCalls,
    sleepCalls,
    seedTask: (spec: TaskSeed): Task => seedTaskFile(root, spec),
    queuePath: (state: QueueState, id: string): string => join(autodevDir, "queue", state, `${id}.md`),
    escalationPath: (id: string): string => join(autodevDir, "escalations", `${id}.md`),
  };
}

// Track every harness's temp root so afterEach can wipe it -- no leaked temp
// dirs across the suite regardless of pass/fail.
let cleanupRoots: string[] = [];
function harness(opts?: HarnessOptions): Harness {
  const h = makeParityHarness(opts);
  cleanupRoots.push(h.root);
  return h;
}
afterEach(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  cleanupRoots = [];
});

// ---------------------------------------------------------------------------
// 1. Normal -> COMMIT -> queue/done/
// ---------------------------------------------------------------------------

describe("parity scenario 1 -- normal COMMIT", () => {
  it("worker DONE + critic clean + gate COMMIT + merge ok -> queue/done/, committed marker, digest line", async () => {
    const h = harness();
    h.seedTask({ id: "t1", file_set: ["a.ts"] });

    const res = await h.conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: "t1", committed: true, rateLimited: false });
    expect(existsSync(h.queuePath("pending", "t1"))).toBe(false);
    expect(existsSync(h.queuePath("active", "t1"))).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t1"))).toBe(false);
    expect(existsSync(h.queuePath("done", "t1"))).toBe(true);

    const doneText = readFileSync(h.queuePath("done", "t1"), "utf8");
    expect(doneText).toContain("<!-- committed: ");
    expect(doneText).toContain("deadbeef");

    // Commit-path wiring: file_set add, kind-mapped message (type "feature"
    // has no cfg.commit.typeMap entry -> falls back to defaultKind
    // "refactor"), merge into the loop branch.
    expect(h.worktreeGitAdds).toEqual([{ taskId: "t1", paths: ["a.ts"] }]);
    expect(h.worktreeGitCommits[0]!.message).toBe("refactor(autodev): Test task");
    expect(h.worktreeMergeCalls).toEqual([{ taskId: "t1", into: "autodev/loop" }]);

    const digest = readFileSync(join(h.autodevDir, "digest.md"), "utf8");
    expect(digest).toContain("committed t1 -> deadbeef (refactor(autodev): Test task)");
  });
});

// ---------------------------------------------------------------------------
// 2a/2b. Contract-zone -> ESCALATE -> queue/escalated/
//
// Split from a single scenario that used to set BOTH touches_contract_zone
// AND a non-empty broken_contracts at once -- that passed even if the
// frontmatter-flag arm of `contractRisk` (conductor.ts's `task.touches_
// contract_zone || actualZones.length > 0 || broken_contracts.length > 0`)
// were broken, since the critic-verdict arm alone would still trip it. Each
// half below isolates ONE arm of that OR so a regression in either is caught.
// ---------------------------------------------------------------------------

describe("parity scenario 2a -- contract-zone via frontmatter flag only", () => {
  it("touches_contract_zone:true + critic 'uncertain' with no broken_contracts -> queue/escalated/, uncertain artifact, gate never called", async () => {
    const h = harness({
      criticScript: [
        {
          result: {
            verdict: { verdict: "uncertain", broken_contracts: [], notes: "not sure about this one", confidence: 0.4 },
            rateLimited: false,
          },
        },
      ],
      zonesTouchedInDiff: async (): Promise<string[]> => [],
    });
    h.seedTask({ id: "t2a", touches_contract_zone: true, file_set: ["a.ts"] });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t2a"))).toBe(true);
    expect(existsSync(h.queuePath("pending", "t2a"))).toBe(false);
    expect(existsSync(h.queuePath("active", "t2a"))).toBe(false);
    expect(existsSync(h.escalationPath("t2a"))).toBe(true);

    const artifact = readFileSync(h.escalationPath("t2a"), "utf8");
    expect(artifact).toContain("**Type:** uncertain");
    expect(h.gateCalls.length).toBe(0); // escalated before the gate
  });
});

describe("parity scenario 2b -- critic-reported broken contracts without the flag", () => {
  it("touches_contract_zone:false + critic 'broken' with non-empty broken_contracts -> queue/escalated/, disagreement artifact, gate never called", async () => {
    const h = harness({
      criticScript: [
        {
          result: {
            verdict: {
              verdict: "broken",
              broken_contracts: [{ zone: "z1", file: "a.ts", line: 3, evidence: "changed the enum" }],
              notes: "this breaks contract z1",
              confidence: 0.9,
            },
            rateLimited: false,
          },
        },
      ],
      zonesTouchedInDiff: async (): Promise<string[]> => [],
    });
    h.seedTask({ id: "t2b", touches_contract_zone: false, file_set: ["a.ts"] });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t2b"))).toBe(true);
    expect(existsSync(h.queuePath("pending", "t2b"))).toBe(false);
    expect(existsSync(h.queuePath("active", "t2b"))).toBe(false);
    expect(existsSync(h.escalationPath("t2b"))).toBe(true);

    const artifact = readFileSync(h.escalationPath("t2b"), "utf8");
    expect(artifact).toContain("**Type:** disagreement");
    expect(h.gateCalls.length).toBe(0); // escalated before the gate
  });
});

// ---------------------------------------------------------------------------
// 3. TOO_BIG -> queue/quarantine/
// ---------------------------------------------------------------------------

describe("parity scenario 3 -- worker TOO_BIG", () => {
  it("worker report status TOO_BIG -> queue/quarantine/, blocked artifact, no commit", async () => {
    const h = harness({
      workerScript: [
        {
          result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
          report: "status: TOO_BIG",
        },
      ],
    });
    h.seedTask({ id: "t3" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("quarantine", "t3"))).toBe(true);
    expect(existsSync(h.escalationPath("t3"))).toBe(true);

    const artifact = readFileSync(h.escalationPath("t3"), "utf8");
    expect(artifact).toContain("**Type:** blocked");

    // Proves the early return: TOO_BIG short-circuits BEFORE the critic,
    // BEFORE any worktree commit/merge, and BEFORE the gate is ever called.
    expect(h.criticCalls.length).toBe(0);
    expect(h.worktreeGitCommits.length).toBe(0);
    expect(h.worktreeMergeCalls.length).toBe(0);
    expect(h.gateCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Poison -> queue/quarantine/, worker never called
// ---------------------------------------------------------------------------

describe("parity scenario 4 -- poison (circuit breaker pre-tripped)", () => {
  it("attempts already at maxAttempts -> quarantines on claim, worker never invoked", async () => {
    const h = harness();
    h.seedTask({ id: "t4" });
    await h.repo.setAttempts("t4", h.cfg.loop.maxAttempts);

    const res = await h.conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: "t4", committed: false, rateLimited: false });
    expect(existsSync(h.queuePath("quarantine", "t4"))).toBe(true);
    expect(existsSync(h.escalationPath("t4"))).toBe(true);

    const artifact = readFileSync(h.escalationPath("t4"), "utf8");
    expect(artifact).toContain("**Type:** poison");
    expect(h.workerCalls.length).toBe(0);
    expect(h.gateCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 429 (worker) -> queue/pending/, attempt refunded
// ---------------------------------------------------------------------------

describe("parity scenario 5 -- worker RATE_LIMITED", () => {
  it("worker 429 -> queue/pending/, attempt count refunded to its pre-iteration value", async () => {
    const h = harness({
      workerScript: [{ result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } }],
    });
    h.seedTask({ id: "t5" });
    const before = await h.repo.getAttempts("t5");

    const res = await h.conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: "t5", committed: false, rateLimited: true });
    expect(existsSync(h.queuePath("pending", "t5"))).toBe(true);
    expect(existsSync(h.queuePath("active", "t5"))).toBe(false);
    expect(await h.repo.getAttempts("t5")).toBe(before);
    expect(h.gateCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Divergence #4 -- gate RETRY routes to pending/, NOT active/, attempt sticks
// ---------------------------------------------------------------------------

describe("parity divergence #4 -- gate RETRY routing", () => {
  it("gate RETRY -> queue/pending/ (not active/); attempt is NOT refunded (a real failure)", async () => {
    const h = harness({
      runGate: async (input) => ({
        task_id: input.taskId,
        composer_green: false,
        success_green: false,
        constitution_touched: [],
        zones_touched: [],
        decision: "RETRY",
        reasons: ["tests failed"],
        changed_files: [],
      }),
    });
    h.seedTask({ id: "t6" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("pending", "t6"))).toBe(true);
    expect(existsSync(h.queuePath("active", "t6"))).toBe(false);
    expect(await h.repo.getAttempts("t6")).toBe(1); // incremented, NOT refunded
  });
});

// ---------------------------------------------------------------------------
// Divergence #8 -- rate-limit refund symmetry (critic path too)
// ---------------------------------------------------------------------------

describe("parity divergence #8 -- critic RATE_LIMITED refund symmetry", () => {
  it("critic 429 (null verdict) -> queue/pending/, attempt refunded, symmetric with the worker path", async () => {
    const h = harness({
      criticScript: [{ result: { verdict: null, rateLimited: true } }],
    });
    h.seedTask({ id: "t7" });
    const before = await h.repo.getAttempts("t7");

    const res = await h.conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: "t7", committed: false, rateLimited: true });
    expect(existsSync(h.queuePath("pending", "t7"))).toBe(true);
    expect(await h.repo.getAttempts("t7")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Divergence #9 -- MaxSessionHours graceful exit (no hang)
// ---------------------------------------------------------------------------

describe("parity divergence #9 -- MaxSessionHours graceful exit", () => {
  it("session budget trips after ~1 iteration -> run() returns gracefully, not a hang", async () => {
    let nowCalls = 0;
    const clock = {
      now: (): number => {
        const call = nowCalls;
        nowCalls++;
        // call 0 = startMs baseline (0); call 1 = the FIRST iteration's
        // top-of-loop check (still within budget, elapsed=0); call 2+ =
        // budget tripped (10h elapsed > the 1h cap) -- simulates the session
        // expiring PARTWAY THROUGH the run, not before the first iteration.
        return call <= 1 ? 0 : 10 * 3600 * 1000;
      },
    };
    const h = harness({ cfgOverrides: { loop: { maxSessionHours: 1 } }, clock });
    h.seedTask({ id: "t9" });

    // [ts/test-hang] guard: run() with no `once` and no-op sleep/clock fakes
    // could starve vitest for the full default hang timeout if the
    // MaxSessionHours check never trips. maxIterations is a generous
    // backstop, not the mechanism under test -- nowCalls staying tiny below
    // proves the graceful exit fired, not the backstop.
    await h.conductor.run({ maxIterations: 50 });

    // startMs baseline + iter-1 loop-top check + persistCriticVerdict's
    // updated_at read (s24; the clean verdict is persisted mid-iteration) +
    // iter-2 loop-top check that trips the budget = 4 -- NOT 50. The extra read
    // vs. the historical 3 is the new critic-verdict.json timestamp; it does not
    // change the graceful-exit behaviour (both call>=2 return the tripped 10h).
    expect(nowCalls).toBe(4);
    expect(existsSync(h.queuePath("done", "t9"))).toBe(true); // the one iteration that ran did commit
  });
});

// ---------------------------------------------------------------------------
// Divergence #10 -- commit-time branch re-check
// ---------------------------------------------------------------------------

describe("parity divergence #10 -- commit-time branch re-check", () => {
  it("HEAD drifts to a different branch before commit -> queue/escalated/, blocked, no commit/merge", async () => {
    const h = harness({ gitBranches: ["autodev/loop", "autodev/other"] });
    h.seedTask({ id: "t10" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t10"))).toBe(true);
    expect(existsSync(h.escalationPath("t10"))).toBe(true);

    const artifact = readFileSync(h.escalationPath("t10"), "utf8");
    expect(artifact).toContain("**Type:** blocked");
    expect(h.worktreeGitCommits.length).toBe(0); // never committed
    expect(h.worktreeMergeCalls.length).toBe(0); // never merged into a stale branch
  });
});

// ---------------------------------------------------------------------------
// Dirty-file fence -- stray out-of-scope path
// ---------------------------------------------------------------------------

describe("parity -- dirty-file fence, stray out-of-scope path", () => {
  it("worker touches a NEW file outside file_set -> queue/escalated/, dirty-file artifact, evidence lists the stray path", async () => {
    let gitChangedCalls = 0;
    const h = harness({
      gitChangedPaths: async (): Promise<string[]> => {
        gitChangedCalls++;
        return gitChangedCalls === 1 ? [] : ["stray.ts"];
      },
      snapshotFingerprints: (_cwd: string, paths: string[]): Map<string, string> =>
        new Map(paths.map((p) => [p, "h:" + p])),
    });
    h.seedTask({ id: "t11", file_set: ["a.ts"] });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t11"))).toBe(true);
    expect(existsSync(h.queuePath("done", "t11"))).toBe(false);
    expect(h.gateCalls.length).toBe(0);
    expect(h.worktreeGitCommits.length).toBe(0);

    const artifact = readFileSync(h.escalationPath("t11"), "utf8");
    expect(artifact).toContain("**Type:** dirty-file");
    // Assert the actual stray PATH, not just the always-present `stray:` label
    // (evidence is `stray: <paths>\nforbidden: <paths>` -- the label alone is vacuous).
    expect(artifact).toContain("stray: stray.ts");
  });
});

// ---------------------------------------------------------------------------
// Dirty-file fence -- forbidden path
// ---------------------------------------------------------------------------

describe("parity -- dirty-file fence, forbidden path", () => {
  it("worker touches a forbidden path INSIDE file_set -> queue/escalated/, dirty-file, forbidden arm isolated", async () => {
    let gitChangedCalls = 0;
    const h = harness({
      gitChangedPaths: async (): Promise<string[]> => {
        gitChangedCalls++;
        return gitChangedCalls === 1 ? [] : ["secret.ts"];
      },
      snapshotFingerprints: (_cwd: string, paths: string[]): Map<string, string> =>
        new Map(paths.map((p) => [p, "h:" + p])),
    });
    // secret.ts is IN file_set (so the stray arm does NOT trip) but forbidden --
    // this isolates the forbidden arm: a broken forbiddenTouches() would let the
    // task through instead of escalating.
    h.seedTask({ id: "t12", file_set: ["secret.ts"], forbidden_paths: ["secret.ts"] });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t12"))).toBe(true);
    expect(h.gateCalls.length).toBe(0);

    const artifact = readFileSync(h.escalationPath("t12"), "utf8");
    expect(artifact).toContain("**Type:** dirty-file");
    // Assert the forbidden PATH (not the vacuous label); and prove the stray arm
    // was NOT the trigger (secret.ts is in file_set, so stray is empty).
    expect(artifact).toContain("forbidden: secret.ts");
    expect(artifact).not.toContain("stray: secret.ts");
  });
});

// ---------------------------------------------------------------------------
// Critic retry loop (parity spec §2 step 5 loop-back -> commit)
// ---------------------------------------------------------------------------

describe("parity -- critic retry loop, uncertain then clean", () => {
  it("round 0 uncertain -> feedback + retry; round 1 clean -> commit", async () => {
    const h = harness({
      criticScript: [
        {
          result: {
            verdict: { verdict: "uncertain", broken_contracts: [], notes: "please clarify X", confidence: 0.4 },
            rateLimited: false,
          },
        },
        {
          result: {
            verdict: { verdict: "clean", broken_contracts: [], notes: "", confidence: 1 },
            rateLimited: false,
          },
        },
      ],
      zonesTouchedInDiff: async (): Promise<string[]> => [],
    });
    h.seedTask({ id: "t13", touches_contract_zone: false, file_set: ["a.ts"] });

    const res = await h.conductor.runIteration();

    expect(h.workerCalls.length).toBe(2); // worker ran a second time after feedback
    expect(h.workerCalls[1]!.criticFeedback).toBeDefined();
    expect(h.workerCalls[1]!.criticFeedback).toBe("please clarify X");
    expect(await h.repo.readRuntimeFile("t13", "critic-feedback.md")).not.toBeNull();
    expect(res.committed).toBe(true);
    expect(existsSync(h.queuePath("done", "t13"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Worker-report NEEDS_GUARD / BLOCKED (siblings of the TOO_BIG scenario)
// ---------------------------------------------------------------------------

describe("parity -- worker-report NEEDS_GUARD", () => {
  it("worker report status NEEDS_GUARD -> queue/escalated/, needs-guard artifact, gate never called", async () => {
    const h = harness({
      workerScript: [
        {
          result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
          report: "status: NEEDS_GUARD",
        },
      ],
    });
    h.seedTask({ id: "t14" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t14"))).toBe(true);
    expect(h.gateCalls.length).toBe(0);

    const artifact = readFileSync(h.escalationPath("t14"), "utf8");
    expect(artifact).toContain("**Type:** needs-guard");
  });
});

describe("parity -- worker-report BLOCKED", () => {
  it("worker report status BLOCKED -> queue/escalated/, blocked artifact, gate never called", async () => {
    const h = harness({
      workerScript: [
        {
          result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
          report: "status: BLOCKED",
        },
      ],
    });
    h.seedTask({ id: "t15" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(existsSync(h.queuePath("escalated", "t15"))).toBe(true);
    expect(h.gateCalls.length).toBe(0);

    const artifact = readFileSync(h.escalationPath("t15"), "utf8");
    expect(artifact).toContain("**Type:** blocked");
  });
});

// ---------------------------------------------------------------------------
// Merge conflict after commit (fail-closed -> escalate, not a silent drop)
// ---------------------------------------------------------------------------

describe("parity -- merge conflict after gate COMMIT", () => {
  it("worktree commit succeeds but the merge conflicts -> queue/escalated/, blocked artifact, not done", async () => {
    const h = harness({ mergeResult: { ok: false, conflict: true } });
    h.seedTask({ id: "t16" });

    const res = await h.conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(h.worktreeGitCommits.length).toBe(1); // the worktree commit WAS made
    expect(existsSync(h.queuePath("escalated", "t16"))).toBe(true);
    expect(existsSync(h.queuePath("done", "t16"))).toBe(false);

    const artifact = readFileSync(h.escalationPath("t16"), "utf8");
    expect(artifact).toContain("**Type:** blocked");
  });
});

// ---------------------------------------------------------------------------
// run() backoff selection (divergence #8 busy-loop guard)
// ---------------------------------------------------------------------------

describe("parity -- run() backoff selection", () => {
  it("idle iteration sleeps cfg.loop.sleepSeconds", async () => {
    const h = harness();
    // No task seeded -- scheduler.claimNextTask() returns null every iteration.

    // maxIterations:2 so the iteration-1 sleep fires before the loop breaks
    // (run() checks iterations>=maxIterations BEFORE the sleep step) -- bounded,
    // cannot hang [ts/test-hang].
    await h.conductor.run({ maxIterations: 2 });

    expect(h.sleepCalls[0]).toBe(h.cfg.loop.sleepSeconds);
    expect(h.cfg.loop.sleepSeconds).toBe(30); // default, sanity-pin the fixture
  });

  it("worker RATE_LIMITED iteration sleeps cfg.loop.rateLimitBackoffSeconds", async () => {
    const h = harness({
      workerScript: [
        { result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } },
      ],
    });
    h.seedTask({ id: "t17" });

    // Bounded by maxIterations -- cannot hang [ts/test-hang]. The task is
    // refunded to pending after each 429, so it is reclaimed and re-429s on
    // iteration 2 as well; only iteration 1's sleep is observed here.
    await h.conductor.run({ maxIterations: 2 });

    expect(h.sleepCalls[0]).toBe(h.cfg.loop.rateLimitBackoffSeconds);
    expect(h.cfg.loop.rateLimitBackoffSeconds).toBe(600); // default, sanity-pin the fixture
  });
});
