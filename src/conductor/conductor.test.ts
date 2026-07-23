import { describe, it, expect } from "vitest";
import { createConductor } from "./conductor.js";
import type { ConductorDeps } from "./conductor.js";
import type { Task } from "../blackboard/types.js";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Worktree, WorktreeManager } from "../worktree/worktree.js";
import type { WorkerAdapter, WorkerResult, WorkerRunInput } from "../worker/adapter.js";
import type { CriticAdapter, CriticResult, CriticRunInput } from "../critic/adapter.js";
import type { Verdict } from "../critic/verdict.js";
import type { Router } from "../router/router.js";
import type { Git, MergeResult } from "../util/git.js";
import type { GateInput, GateVerdict } from "../gate/gate.js";
import type { EscalationInput } from "../escalate/escalate.js";
import type { AntiDriftInput } from "../anti-drift/anti-drift.js";
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";
import { NORTH_STAR_UNFILLED_SENTINEL } from "../anti-drift/north-star.js";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import { AgentCiUnavailableError } from "../gate/agent-ci-exec.js";
import type { OracleSet } from "../gate/oracle-paths.js";
import { EvidenceSchema, type EvidenceRecord } from "../report/evidence-types.js";

// ---------------------------------------------------------------------------
// Fakes / test helpers. No real subprocesses, no real filesystem (except the
// real pure fingerprint fns are exercised indirectly through conductor.ts).
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    type: "feature",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: ["a.ts"],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "",
    path: "queue/pending/t1.md",
    ...overrides,
  };
}

interface RepoState {
  locations: Map<string, QueueState>;
  attempts: Map<string, number>;
  runtimeFiles: Map<string, Map<string, string>>;
  moves: { id: string; from: QueueState; to: QueueState }[];
  doneMarks: Map<string, string>;
  digest: string[];
}

function makeRepo(initialAttempts: Record<string, number> = {}): { repo: BlackboardRepository; state: RepoState } {
  const state: RepoState = {
    locations: new Map(),
    attempts: new Map(Object.entries(initialAttempts)),
    runtimeFiles: new Map(),
    moves: [],
    doneMarks: new Map(),
    digest: [],
  };

  const repo: BlackboardRepository = {
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async moveTask(id: string, from: QueueState, to: QueueState): Promise<void> {
      state.moves.push({ id, from, to });
      state.locations.set(id, to);
    },
    async getAttempts(id: string): Promise<number> {
      return state.attempts.get(id) ?? 0;
    },
    async setAttempts(id: string, n: number): Promise<void> {
      state.attempts.set(id, n);
    },
    async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
      if (!state.runtimeFiles.has(id)) state.runtimeFiles.set(id, new Map());
      state.runtimeFiles.get(id)!.set(name, content);
    },
    async readRuntimeFile(id: string, name: string): Promise<string | null> {
      return state.runtimeFiles.get(id)?.get(name) ?? null;
    },
    async removeRuntimeFile(id: string, name: string): Promise<void> {
      state.runtimeFiles.get(id)?.delete(name);
    },
    async markDone(id: string, hash: string): Promise<void> {
      state.doneMarks.set(id, hash);
    },
    async appendDigest(line: string): Promise<void> {
      state.digest.push(line);
    },
    runtimeDir(id: string): string {
      return `runtime/${id}`;
    },
  };

  return { repo, state };
}

function makeScheduler(queue: Task[], repo: BlackboardRepository): { scheduler: Scheduler; claimCalls: { count: number } } {
  const claimCalls = { count: 0 };
  const scheduler: Scheduler = {
    async claimNextTask(): Promise<Task | null> {
      claimCalls.count++;
      const task = queue.shift();
      if (task === undefined) return null;
      await repo.moveTask(task.id, "pending", "active");
      return task;
    },
    async listClaimable() {
      return [];
    },
  };
  return { scheduler, claimCalls };
}

interface WorktreeSpy {
  create: { taskId: string; baseBranch: string }[];
  teardown: Worktree[];
  diff: { wt: Worktree; scope?: string[] }[];
  merge: { wt: Worktree; into: string }[];
}

function makeWorktree(opts: {
  diffText?: string;
  mergeResult?: MergeResult;
} = {}): { worktree: WorktreeManager; spy: WorktreeSpy } {
  const spy: WorktreeSpy = { create: [], teardown: [], diff: [], merge: [] };
  const worktree: WorktreeManager = {
    async create(taskId: string, baseBranch: string): Promise<Worktree> {
      spy.create.push({ taskId, baseBranch });
      return { path: `/wt/${taskId}`, branch: `autodev/wt-${taskId}`, taskId };
    },
    async diff(wt: Worktree, scope?: string[]): Promise<string> {
      spy.diff.push(scope !== undefined ? { wt, scope } : { wt });
      return opts.diffText ?? "";
    },
    async teardown(wt: Worktree): Promise<void> {
      spy.teardown.push(wt);
    },
    async mergeAfterGate(wt: Worktree, intoBranch: string): Promise<MergeResult> {
      spy.merge.push({ wt, into: intoBranch });
      return opts.mergeResult ?? { ok: true, conflict: false };
    },
  };
  return { worktree, spy };
}

interface WorkerScriptStep {
  result: WorkerResult;
  report?: string;
}

function makeWorker(
  script: WorkerScriptStep[],
  repo: BlackboardRepository,
): { worker: WorkerAdapter; calls: WorkerRunInput[] } {
  const calls: WorkerRunInput[] = [];
  let i = 0;
  const worker: WorkerAdapter = {
    async run(input: WorkerRunInput): Promise<WorkerResult> {
      calls.push(input);
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.report !== undefined) {
        await repo.writeRuntimeFile(input.task.id, "worker-report.md", step.report);
      }
      return step.result;
    },
  };
  return { worker, calls };
}

interface CriticScriptStep {
  result: CriticResult;
}

function makeCritic(script: CriticScriptStep[]): { critic: CriticAdapter; calls: CriticRunInput[] } {
  const calls: CriticRunInput[] = [];
  let i = 0;
  const critic: CriticAdapter = {
    async run(input: CriticRunInput): Promise<CriticResult> {
      calls.push(input);
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      return step.result;
    },
  };
  return { critic, calls };
}

function makeGit(branch: string): { git: Git; setBranch: (b: string) => void; currentBranchCalls: { count: number } } {
  let current = branch;
  const currentBranchCalls = { count: 0 };
  const git: Git = {
    async currentBranch(): Promise<string> {
      currentBranchCalls.count++;
      return current;
    },
    async init(): Promise<void> {
      /* unused */
    },
    async listBranches(): Promise<string[]> {
      return [current];
    },
    async checkoutBranch(): Promise<void> {
      /* unused */
    },
    async createBranch(): Promise<void> {
      /* unused */
    },
    async commitEmpty(): Promise<string> {
      throw new Error("commitEmpty should not be called on main git");
    },
    async countUntracked(): Promise<number> {
      return 0;
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
  return { git, setBranch: (b: string) => (current = b), currentBranchCalls };
}

/**
 * A Git whose `currentBranch()` walks a scripted sequence (last value sticks).
 * Used to simulate HEAD drifting mid-iteration: call 0 = the loopBranch captured
 * at iteration start, call 1 = the commit-time re-check.
 */
function makeSequencedGit(branches: string[]): { git: Git; commitCalls: { count: number } } {
  let i = 0;
  const commitCalls = { count: 0 };
  const git: Git = {
    async currentBranch(): Promise<string> {
      const b = branches[Math.min(i, branches.length - 1)]!;
      i++;
      return b;
    },
    async init(): Promise<void> {},
    async listBranches(): Promise<string[]> {
      return branches;
    },
    async checkoutBranch(): Promise<void> {},
    async createBranch(): Promise<void> {},
    async commitEmpty(): Promise<string> {
      throw new Error("commitEmpty should not be called on main git");
    },
    async countUntracked(): Promise<number> {
      return 0;
    },
    async changedFiles(): Promise<string[]> {
      return [];
    },
    async diffText(): Promise<string> {
      return "";
    },
    async add(): Promise<void> {},
    async commit(): Promise<string> {
      commitCalls.count++;
      throw new Error("commit should not be called on main git");
    },
    async worktreeAdd(): Promise<void> {},
    async worktreeRemove(): Promise<void> {},
    async merge(): Promise<MergeResult> {
      return { ok: true, conflict: false };
    },
  };
  return { git, commitCalls };
}

interface WorktreeGitSpy {
  add: { wt: Worktree; paths: string[] }[];
  commit: { wt: Worktree; msg: string }[];
}

function makeWorktreeGitFactory(): { worktreeGit: (wt: Worktree) => Git; spy: WorktreeGitSpy } {
  const spy: WorktreeGitSpy = { add: [], commit: [] };
  const worktreeGit = (wt: Worktree): Git => ({
    async currentBranch(): Promise<string> {
      return wt.branch;
    },
    async init(): Promise<void> {
      /* unused */
    },
    async listBranches(): Promise<string[]> {
      return [wt.branch];
    },
    async checkoutBranch(): Promise<void> {
      /* unused */
    },
    async createBranch(): Promise<void> {
      /* unused */
    },
    async commitEmpty(): Promise<string> {
      throw new Error("commitEmpty should not be called on worktree git");
    },
    async countUntracked(): Promise<number> {
      return 0;
    },
    async changedFiles(): Promise<string[]> {
      return [];
    },
    async diffText(): Promise<string> {
      return "";
    },
    async add(paths: string[]): Promise<void> {
      spy.add.push({ wt, paths });
    },
    async commit(message: string): Promise<string> {
      spy.commit.push({ wt, msg: message });
      return `hash-${wt.taskId}`;
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
  return { worktreeGit, spy };
}

function defaultGateVerdict(overrides: Partial<GateVerdict> = {}): GateVerdict {
  return {
    task_id: "t1",
    composer_green: true,
    success_green: true,
    agent_ci_green: true,
    profile_green: true,
    constitution_touched: [],
    zones_touched: [],
    decision: "COMMIT",
    reasons: [],
    changed_files: [],
    profile_gates: [],
    ...overrides,
  };
}

function makeCleanVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return { verdict: "clean", broken_contracts: [], notes: "", confidence: 1, ...overrides };
}

/** The default `resolveOracleSet` fake (see `buildDeps`) always resolves to THIS
 *  SAME object -- a shared, stable reference, never reconstructed per call. That
 *  stability is load-bearing for `makeFingerprintFakes` below: it lets the fence
 *  fake recognize (and skip) the two NEW oracle-fingerprint calls (adr/006 Phase 2)
 *  by REFERENCE rather than by content, since an oracle call's `rawPaths` (this
 *  object's `.literals`, always `[]` here) is otherwise indistinguishable from a
 *  legitimate empty `gitChangedPaths()` result the regular fence also produces. */
const EMPTY_ORACLE_SET: OracleSet = { literals: [], globs: [], sources: new Map() };

/** Pairs up baseline/after fingerprint snapshots per fence round, driven by call count.
 *  Skips (without consuming the pairing counter) any `snapshotFingerprints` call made
 *  with the shared `EMPTY_ORACLE_SET.literals` array -- the oracle-fence baseline/after
 *  calls conductor.ts now makes every round (adr/006 Phase 2) alongside the regular
 *  dirty-file fence's own baseline/now calls that this fake exists to script. */
function makeFingerprintFakes(sequence: { paths: string[]; map: Map<string, string> }[]): {
  gitChangedPaths: (cwd: string) => Promise<string[]>;
  snapshotFingerprints: (cwd: string, rawPaths: string[]) => Map<string, string>;
} {
  let counter = 0;
  const step = (): { paths: string[]; map: Map<string, string> } => {
    const idx = Math.min(Math.floor(counter / 2), sequence.length - 1);
    return sequence[idx]!;
  };
  return {
    gitChangedPaths: async (): Promise<string[]> => {
      const s = step();
      counter++;
      return s.paths;
    },
    snapshotFingerprints: (_cwd: string, rawPaths: string[]): Map<string, string> => {
      if (rawPaths === EMPTY_ORACLE_SET.literals) return new Map();
      const s = step();
      counter++;
      return s.map;
    },
  };
}

/**
 * Fakes for exercising the oracle-path fence (adr/006 Phase 2) in isolation from the
 * regular dirty-file fence. POSITION-keyed, not content-keyed: one round calls
 * `snapshotFingerprints` exactly FOUR times, always in this order -- oracle-baseline
 * (pre-worker), fence-baseline, fence-now, oracle-after (post-worker, BEFORE the
 * dirty-file check) -- so scripting by position (rather than by the `rawPaths`
 * argument's content) is required whenever a test wants the SAME path to appear in
 * both the oracle literal set and the regular git-visible touched set (test 14
 * deliberately does this, to prove the oracle check wins the race). Assumes exactly
 * ONE round -- every test below uses the default single-shot DONE worker.
 */
function makeOracleFingerprintFakes(opts: {
  gitAfter: string[];
  oracleBefore: Map<string, string>;
  oracleAfter: Map<string, string>;
}): {
  gitChangedPaths: (cwd: string) => Promise<string[]>;
  snapshotFingerprints: (cwd: string, rawPaths: string[]) => Map<string, string>;
} {
  let gitCall = 0;
  let snapCall = 0;
  return {
    gitChangedPaths: async (): Promise<string[]> => {
      const paths = gitCall === 0 ? [] : opts.gitAfter;
      gitCall++;
      return paths;
    },
    snapshotFingerprints: (): Map<string, string> => {
      const pos = snapCall;
      snapCall++;
      if (pos === 0) return opts.oracleBefore;
      if (pos === 3) return opts.oracleAfter;
      // pos 1 (regular fence baseline, over the empty pre-worker path list) / pos 2
      // (regular fence "now", over `gitAfter`) -- content is irrelevant to every
      // oracle assertion these tests make; keyed only so the regular fence's own
      // `workerTouched` sees a stable, non-crashing map.
      const paths = pos === 1 ? [] : opts.gitAfter;
      return new Map(paths.map((p) => [p, "h"]));
    },
  };
}

function makeEscalate(): { escalate: (input: EscalationInput) => Promise<unknown>; calls: EscalationInput[] } {
  const calls: EscalationInput[] = [];
  return {
    escalate: async (input: EscalationInput): Promise<unknown> => {
      calls.push(input);
      return undefined;
    },
    calls,
  };
}

/** Builds a full ConductorDeps with sane defaults; any field can be overridden. */
function buildDeps(partial: Partial<ConductorDeps>): ConductorDeps {
  const cfg = partial.cfg ?? HarnessConfigSchema.parse({});
  const { repo } = partial.repo !== undefined ? { repo: partial.repo } : makeRepo();
  return {
    cfg,
    repo,
    scheduler: partial.scheduler ?? makeScheduler([], repo).scheduler,
    worktree: partial.worktree ?? makeWorktree().worktree,
    worker: partial.worker ?? makeWorker([{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" }], repo).worker,
    critic: partial.critic ?? makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]).critic,
    router: partial.router ?? ({ resolveLadder: () => ({ ladder: cfg.roles.worker.ladder, warnings: [] }) } as Router),
    git: partial.git ?? makeGit("autodev/loop-main").git,
    worktreeGit: partial.worktreeGit ?? makeWorktreeGitFactory().worktreeGit,
    ...(partial.mainTreeStatus !== undefined ? { mainTreeStatus: partial.mainTreeStatus } : {}),
    runGate: partial.runGate ?? (async () => defaultGateVerdict()),
    escalate: partial.escalate ?? makeEscalate().escalate,
    runAntiDrift: partial.runAntiDrift ?? (async () => "ON-TRACK: fine"),
    // Default is a no-op: the default `makeWorker` fake already writes
    // "worker-report.md" straight into repo runtime files (simulating a report
    // that's already where the conductor expects it), so no relocation is
    // needed for the existing scripted tests below.
    harvestWorkerReport: partial.harvestWorkerReport ?? (async () => {}),
    gitChangedPaths: partial.gitChangedPaths ?? (async () => []),
    snapshotFingerprints: partial.snapshotFingerprints ?? (() => new Map()),
    resolveOracleSet: partial.resolveOracleSet ?? (async () => EMPTY_ORACLE_SET),
    zonesTouchedInDiff: partial.zonesTouchedInDiff ?? (async () => []),
    ...(partial.profileRef !== undefined ? { profileRef: partial.profileRef } : {}),
    ...(partial.normalizeEol !== undefined ? { normalizeEol: partial.normalizeEol } : {}),
    ...(partial.readNorthStar !== undefined ? { readNorthStar: partial.readNorthStar } : {}),
    ...(partial.writeDecision !== undefined ? { writeDecision: partial.writeDecision } : {}),
    clock: partial.clock ?? { now: () => 0 },
    sleep: partial.sleep ?? (async () => {}),
    log: partial.log ?? (() => {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Circuit-breaker refund invariant
// ---------------------------------------------------------------------------

describe("runIteration -- circuit breaker refund", () => {
  it("refunds the attempt and returns the task to pending on RATE_LIMITED", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [{ result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } }],
      repo,
    );
    const { critic, calls: criticCalls } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);
    const { worktree, spy: wtSpy } = makeWorktree();

    const deps = buildDeps({ repo, scheduler, worker, critic, worktree });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: true });
    expect(state.attempts.get(task.id)).toBe(0); // incremented to 1, then refunded to 0
    expect(state.locations.get(task.id)).toBe("pending");
    expect(workerCalls.length).toBe(1);
    expect(criticCalls.length).toBe(0);
    expect(wtSpy.teardown.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-closed commit gating
// ---------------------------------------------------------------------------

describe("runIteration -- fail-closed commit gating", () => {
  it("escalates and does not commit when the gate resolves ESCALATE", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      worktreeGit,
      runGate: async () => defaultGateVerdict({ decision: "ESCALATE", constitution_touched: ["docs/x.md"] }),
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("constitution");
    expect(wgSpy.commit.length).toBe(0);
  });

  it("fails closed (escalates, no commit) when runGate throws", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      worktreeGit,
      runGate: async () => {
        throw new Error("broken INVARIANTS.md");
      },
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("needs-guard");
    expect(wgSpy.commit.length).toBe(0);
  });

  it("escalates with the AgentCiUnavailableError's detail (not the generic gate-threw string)", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      worktreeGit,
      runGate: async () => {
        throw new AgentCiUnavailableError(
          "needs-wsl-on-windows",
          "agent-ci gate requires WSL on Windows -- install WSL or run on Linux/Mac",
        );
      },
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.reason).toMatch(/requires WSL on Windows/);
    expect(escalateCalls[0]!.reason).not.toMatch(/broken operator config/);
    expect(wgSpy.commit.length).toBe(0);
  });

  it("still uses the generic reason for a non-agent-ci gate throw", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      worktreeGit,
      runGate: async () => {
        throw new Error("INVARIANTS.md missing");
      },
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.reason).toMatch(/broken operator config/);
    expect(wgSpy.commit.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Counter-increment guard / poison
// ---------------------------------------------------------------------------

describe("runIteration -- counter-increment guard", () => {
  it("quarantines and never spawns the worker once maxAttempts is exceeded", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo({ [task.id]: 3 }); // cfg.loop.maxAttempts default 3
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker([], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worker, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(state.attempts.get(task.id)).toBe(4);
    expect(state.locations.get(task.id)).toBe("quarantine");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("poison");
    expect(workerCalls.length).toBe(0);
    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: false });
  });
});

// ---------------------------------------------------------------------------
// 4. Branch preflight
// ---------------------------------------------------------------------------

describe("run -- branch preflight", () => {
  it("refuses to run on main and never claims a task", async () => {
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([makeTask()], repo);
    const { git } = makeGit("main");

    const deps = buildDeps({ repo, scheduler, git });
    const conductor = createConductor(deps);

    await expect(conductor.run()).rejects.toThrow(/branch|refus/i);
    expect(claimCalls.count).toBe(0);
  });

  it("refuses to run on a branch that doesn't match the allowed pattern", async () => {
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([makeTask()], repo);
    const { git } = makeGit("feature/x");

    const deps = buildDeps({ repo, scheduler, git });
    const conductor = createConductor(deps);

    await expect(conductor.run()).rejects.toThrow(/branch|refus/i);
    expect(claimCalls.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. Dirty-tree preflight (run start) -- warn early; skip-worktree hint for
//     tracked churn files that .git/info/exclude cannot neutralize.
// ---------------------------------------------------------------------------

describe("run -- dirty-tree preflight", () => {
  it("warns that the main tree is dirty AND hints skip-worktree for a TRACKED churn file", async () => {
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([], repo);
    const logs: string[] = [];
    const deps = buildDeps({
      repo,
      scheduler,
      log: (lvl, msg) => logs.push(`${lvl}:${msg}`),
      mainTreeStatus: async () => [{ code: " M", path: ".serena/project.yml" }],
    });
    const conductor = createConductor(deps);

    await conductor.run({ once: true });

    expect(logs.some((l) => l.startsWith("WARN:") && /not clean/i.test(l))).toBe(true);
    const hint = logs.find((l) => /skip-worktree/.test(l));
    expect(hint).toBeDefined();
    expect(hint).toContain(".serena/project.yml");
  });

  it("warns on a dirty tree but gives NO skip-worktree hint when the dirt is untracked / non-churn", async () => {
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([], repo);
    const logs: string[] = [];
    const deps = buildDeps({
      repo,
      scheduler,
      log: (lvl, msg) => logs.push(`${lvl}:${msg}`),
      // Untracked (??) file, and an untracked churn dir (?? is neutralized by exclude, so no hint).
      mainTreeStatus: async () => [
        { code: "??", path: "scratch.txt" },
        { code: "??", path: ".serena/cache/x" },
      ],
    });
    const conductor = createConductor(deps);

    await conductor.run({ once: true });

    expect(logs.some((l) => l.startsWith("WARN:") && /not clean/i.test(l))).toBe(true);
    expect(logs.some((l) => /skip-worktree/.test(l))).toBe(false);
  });

  it("stays silent on a clean tree", async () => {
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([], repo);
    const logs: string[] = [];
    const deps = buildDeps({
      repo,
      scheduler,
      log: (lvl, msg) => logs.push(`${lvl}:${msg}`),
      mainTreeStatus: async () => [],
    });
    const conductor = createConductor(deps);

    await conductor.run({ once: true });

    expect(logs.some((l) => /not clean/i.test(l))).toBe(false);
  });

  it("never aborts the run when the preflight status check throws (best-effort)", async () => {
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([], repo);
    const logs: string[] = [];
    const deps = buildDeps({
      repo,
      scheduler,
      log: (lvl, msg) => logs.push(`${lvl}:${msg}`),
      mainTreeStatus: async () => {
        throw new Error("git blew up");
      },
    });
    const conductor = createConductor(deps);

    await expect(conductor.run({ once: true })).resolves.toBeUndefined();
    expect(claimCalls.count).toBe(1); // the loop still ran its one iteration
    expect(logs.some((l) => /preflight skipped/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4b. Drain mode -- one trigger clears the whole pending pool (backlog B)
// ---------------------------------------------------------------------------

describe("run -- drain mode", () => {
  it("drains every claimable task then stops when the queue goes idle", async () => {
    const tasks = [
      makeTask({ id: "d1", file_set: ["a.ts"], path: "queue/pending/d1.md" }),
      makeTask({ id: "d2", file_set: ["b.ts"], path: "queue/pending/d2.md" }),
      makeTask({ id: "d3", file_set: ["c.ts"], path: "queue/pending/d3.md" }),
    ];
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([...tasks], repo);

    const deps = buildDeps({ repo, scheduler });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true });

    // All three claimed + committed to done; a 4th claim returned null -> stop.
    expect(claimCalls.count).toBe(4);
    expect(state.locations.get("d1")).toBe("done");
    expect(state.locations.get("d2")).toBe("done");
    expect(state.locations.get("d3")).toBe("done");
  });

  it("stops after a single empty claim when the queue is already idle (no spin)", async () => {
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([], repo);

    const deps = buildDeps({ repo, scheduler });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true });

    expect(claimCalls.count).toBe(1); // one claim -> null -> stop
  });

  it("stops draining on a rate limit instead of hammering a throttled API to the session cap", async () => {
    const task = makeTask({ id: "d1", file_set: ["a.ts"], path: "queue/pending/d1.md" });
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } }],
      repo,
    );

    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true });

    // The rate-limited task is refunded + returned to pending, and the drain
    // STOPS rather than looping the throttled API up to maxSessionHours.
    expect(state.locations.get("d1")).toBe("pending");
    expect(claimCalls.count).toBe(1); // claimed once -> rate-limited -> break
  });
});

// ---------------------------------------------------------------------------
// 5. Dirty-file fence -- stray + boundary-safety ignore
// ---------------------------------------------------------------------------

describe("runIteration -- dirty-file fence (path-set)", () => {
  it("escalates dirty-file when the worker touches a file outside file_set", async () => {
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { gitChangedPaths, snapshotFingerprints } = makeFingerprintFakes([
      { paths: [], map: new Map() },
      { paths: ["other.ts"], map: new Map([["other.ts", "h"]]) },
    ]);

    const deps = buildDeps({ repo, scheduler, escalate, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("dirty-file");
  });

  it("does NOT flag a touched file under cfg.dirtyFenceIgnore and proceeds to gate", async () => {
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { gitChangedPaths, snapshotFingerprints } = makeFingerprintFakes([
      { paths: [], map: new Map() },
      { paths: [".autodev/runtime/x"], map: new Map([[".autodev/runtime/x", "h"]]) },
    ]);

    const deps = buildDeps({ repo, scheduler, escalate, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(escalateCalls.length).toBe(0);
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 5b. EOL normalization -- runs AFTER the fences, BEFORE the diff/gate/commit
// ---------------------------------------------------------------------------

describe("runIteration -- EOL normalization", () => {
  it("normalizes the worker's touched files (with the touched set) before the gate, then commits", async () => {
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    // baseline snapshot empty; post-worker snapshot shows the worker changed a.ts (in file_set -> fence passes).
    const { gitChangedPaths, snapshotFingerprints } = makeFingerprintFakes([
      { paths: [], map: new Map() },
      { paths: ["a.ts"], map: new Map([["a.ts", "h"]]) },
    ]);
    const calls: string[][] = [];
    const normalizeEol = async (_wt: unknown, relPaths: string[]) => {
      calls.push(relPaths);
      return { normalized: [] as string[], skippedBinary: [] as string[] };
    };

    const deps = buildDeps({ repo, scheduler, gitChangedPaths, snapshotFingerprints, normalizeEol: normalizeEol as NonNullable<ConductorDeps["normalizeEol"]> });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["a.ts"]);
  });

  it("does NOT normalize when a fence escalates first (normalize runs after the fences)", async () => {
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate } = makeEscalate();
    // worker touched a file OUTSIDE file_set -> dirty-file fence escalates before normalize.
    const { gitChangedPaths, snapshotFingerprints } = makeFingerprintFakes([
      { paths: [], map: new Map() },
      { paths: ["other.ts"], map: new Map([["other.ts", "h"]]) },
    ]);
    let called = false;
    const normalizeEol = async () => {
      called = true;
      return { normalized: [] as string[], skippedBinary: [] as string[] };
    };

    const deps = buildDeps({ repo, scheduler, escalate, gitChangedPaths, snapshotFingerprints, normalizeEol: normalizeEol as NonNullable<ConductorDeps["normalizeEol"]> });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Dirty-file fence -- content fingerprint (already-dirty file, changed content)
// ---------------------------------------------------------------------------

describe("runIteration -- dirty-file fence (content fingerprint)", () => {
  it("catches an already-dirty out-of-file_set file whose content changed", async () => {
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    // Path-set is UNCHANGED across baseline/after (already dirty pre-existing),
    // but the content fingerprint differs -- a naive path-set diff would miss this.
    const { gitChangedPaths, snapshotFingerprints } = makeFingerprintFakes([
      { paths: ["other.ts"], map: new Map([["other.ts", "h1"]]) },
      { paths: ["other.ts"], map: new Map([["other.ts", "h2"]]) },
    ]);

    const deps = buildDeps({ repo, scheduler, escalate, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("dirty-file");
  });
});

// ---------------------------------------------------------------------------
// 6b. Oracle-path fence (adr/006 Phase 2) -- protects executable oracle INPUTS
//     (guard test files, recipes, agent-ci workflows, constitution paths) that
//     the worker still executes from the worktree by design, closing the
//     residual Phase 1 (trusted-root oracle-DEFINITION reads) left open.
// ---------------------------------------------------------------------------

describe("runIteration -- oracle-path fence (adr/006 Phase 2)", () => {
  it("10. worker edits a guard test file that IS in file_set -> escalates constitution BEFORE the critic runs", async () => {
    const oraclePath = "tests/FooTest.php";
    const task = makeTask({ file_set: [oraclePath] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { critic, calls: criticCalls } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [],
      sources: new Map([[oraclePath, "GUARDS.md guard_test (contract_id=c1)"]]),
    });
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [],
      oracleBefore: new Map([[oraclePath, "h1"]]),
      oracleAfter: new Map([[oraclePath, "h2"]]), // content changed -> drift
    });

    const deps = buildDeps({ repo, scheduler, escalate, critic, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("constitution");
    // The critic must never even run -- the oracle fence intercepts before it,
    // proving order, not merely outcome.
    expect(criticCalls.length).toBe(0);
  });

  it("11. worker edits a GITIGNORED oracle literal (invisible to gitChangedPaths) -> still escalates (fs-fingerprint arm)", async () => {
    const oraclePath = "recipes/mutation-recipe.json";
    // Deliberately NOT in file_set and NEVER reported by gitChangedPaths --
    // simulating a target-repo-gitignored oracle file. Only the literal arm's
    // direct filesystem fingerprint (not the git-visible touched set) can catch this.
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [],
      sources: new Map([[oraclePath, "GUARDS.md recipe (contract_id=c1)"]]),
    });
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [], // gitignored -> git never reports it, before OR after
      oracleBefore: new Map([[oraclePath, "h1"]]),
      oracleAfter: new Map([[oraclePath, "h2"]]),
    });

    const deps = buildDeps({ repo, scheduler, escalate, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("constitution");
    expect(escalateCalls[0]!.evidence).toContain(oraclePath);
  });

  it("11b. a file caught by BOTH arms is reported ONCE, with the literal's undistorted spelling and both kinds (s50 live proof: it read as 'modified 2 oracle artifact(s)', one path missing its leading dot)", async () => {
    const oraclePath = ".github/workflows/ci.yml";
    const task = makeTask({ file_set: [oraclePath] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [".github/workflows/**"],
      sources: new Map([
        [oraclePath, "gate.agentCi.workflows: .github/workflows/ci.yml"],
        [".github/workflows/**", "gate.agentCi.enabled"],
      ]),
    });
    // The SAME file drifts on disk AND shows up in the git-visible touched set, so the
    // fs-fingerprint arm and the glob arm both fire on it.
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [oraclePath],
      oracleBefore: new Map([[oraclePath, "h1"]]),
      oracleAfter: new Map([[oraclePath, "h2"]]),
    });

    const deps = buildDeps({ repo, scheduler, escalate, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    const call = escalateCalls[0]!;
    // ONE artifact, not two.
    expect(call.what).toContain("modified 1 oracle artifact(s)");
    // Exactly one evidence line, carrying BOTH arms.
    const evidenceLines = call.evidence.split("\n").filter((l) => l.trim() !== "");
    expect(evidenceLines).toHaveLength(1);
    expect(evidenceLines[0]).toContain("fs-fingerprint+glob");
    // The declared literal's spelling wins -- the glob arm's `normalizePath` form
    // ("github/workflows/ci.yml", dot stripped) must not be what the operator reads.
    expect(evidenceLines[0]).toContain(".github/workflows/ci.yml");
    expect(call.evidence).not.toMatch(/(^|\s)github\/workflows\/ci\.yml/m);
  });

  it("12. worker CREATES a previously-absent oracle literal -> escalates", async () => {
    const oraclePath = "GUARDS.md";
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [],
      sources: new Map([[oraclePath, "contract.guardsFile"]]),
    });
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [],
      oracleBefore: new Map([[oraclePath, "<absent>"]]), // matches util/fingerprint.ts's snapshot() convention
      oracleAfter: new Map([[oraclePath, "abc123"]]),
    });

    const deps = buildDeps({ repo, scheduler, escalate, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls[0]!.type).toBe("constitution");
  });

  it("13. worker touches NOTHING oracle -> unchanged behavior, reaches the critic and commits", async () => {
    const oraclePath = "GUARDS.md";
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic, calls: criticCalls } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [],
      sources: new Map([[oraclePath, "contract.guardsFile"]]),
    });
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [],
      oracleBefore: new Map([[oraclePath, "same-hash"]]),
      oracleAfter: new Map([[oraclePath, "same-hash"]]), // unchanged -> no drift
    });

    const deps = buildDeps({ repo, scheduler, critic, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(criticCalls.length).toBe(1);
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
  });

  it("14. an oracle file OUTSIDE file_set reports 'constitution', NOT 'dirty-file' (order matters)", async () => {
    const oraclePath = "GUARDS.md";
    // NOT in file_set -- the regular stray-check WOULD flag this too if the
    // oracle fence did not intercept first (git reports it changed, below).
    const task = makeTask({ file_set: ["a.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const resolveOracleSet = async (): Promise<OracleSet> => ({
      literals: [oraclePath],
      globs: [],
      sources: new Map([[oraclePath, "contract.guardsFile"]]),
    });
    const { gitChangedPaths, snapshotFingerprints } = makeOracleFingerprintFakes({
      gitAfter: [oraclePath], // git-visible too -- would ALSO be `stray` if reached
      oracleBefore: new Map([[oraclePath, "h1"]]),
      oracleAfter: new Map([[oraclePath, "h2"]]),
    });

    const deps = buildDeps({ repo, scheduler, escalate, resolveOracleSet, gitChangedPaths, snapshotFingerprints });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    // Exactly ONE escalation -- the oracle fence's early return means the
    // dirty-file fence never even runs, so there is no SECOND escalation either.
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("constitution");
  });

  it("15. resolveOracleSet throwing escalates 'constitution', never commits, and the drain survives to the next task", async () => {
    const { repo, state } = makeRepo();
    const taskA = makeTask({ id: "oa1", file_set: ["a.ts"], path: "queue/pending/oa1.md" });
    const taskB = makeTask({ id: "oa2", file_set: ["b.ts"], path: "queue/pending/oa2.md" });
    const { scheduler } = makeScheduler([taskA, taskB], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const resolveOracleSet = async (): Promise<OracleSet> => {
      throw new Error("GUARDS.md row escapes the trusted root");
    };

    const deps = buildDeps({ repo, scheduler, escalate, resolveOracleSet });
    const conductor = createConductor(deps);

    // Must resolve (not reject) for BOTH tasks -- a throw here must never crash the drain.
    await expect(conductor.run({ drain: true })).resolves.toBeUndefined();

    expect(state.locations.get("oa1")).toBe("escalated");
    expect(state.locations.get("oa2")).toBe("escalated");
    expect(escalateCalls.length).toBe(2);
    for (const call of escalateCalls) {
      expect(call.type).toBe("constitution");
      expect(call.evidence).toContain("GUARDS.md row escapes the trusted root");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Decision routing happy paths
// ---------------------------------------------------------------------------

describe("runIteration -- decision routing", () => {
  it("COMMIT: adds file_set, commits, merges, and marks done", async () => {
    const task = makeTask({ file_set: ["a.ts", "b.ts"] });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worktree, spy: wtSpy } = makeWorktree();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();

    const deps = buildDeps({ repo, scheduler, worktree, worktreeGit });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    expect(wgSpy.add.length).toBe(1);
    expect(wgSpy.add[0]!.paths).toEqual(["a.ts", "b.ts"]);
    expect(wgSpy.commit.length).toBe(1);
    expect(wtSpy.merge.length).toBe(1);
    expect(wtSpy.merge[0]!.into).toBe("autodev/loop-main");
    expect(state.locations.get(task.id)).toBe("done");
    expect(state.doneMarks.get(task.id)).toBe(`hash-${task.id}`);
    expect(state.digest.length).toBe(1);
  });

  it("RETRY: task returns to pending, attempt is NOT refunded", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);

    const deps = buildDeps({
      repo,
      scheduler,
      runGate: async () => defaultGateVerdict({ decision: "RETRY", success_green: false, reasons: ["tests failed"] }),
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("pending");
    expect(state.attempts.get(task.id)).toBe(1); // incremented, NOT refunded
  });

  it("merge conflict after COMMIT gate -> escalated, blocked, no done", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worktree } = makeWorktree({ mergeResult: { ok: false, conflict: true } });
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worktree, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(state.doneMarks.has(task.id)).toBe(false);
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("blocked");
  });

  it("merge precondition failure (ok:false, not a conflict) after COMMIT gate -> escalated, no done, accurate reason", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    // mergeAfterGate refused a precondition (e.g. dirty main tree) -- NOT a
    // conflict. The escalation must reflect the real precondition, never a
    // phantom "merge conflict".
    const { worktree } = makeWorktree({
      mergeResult: { ok: false, conflict: false, reason: "main working tree is not clean; refusing to merge" },
    });
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worktree, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(state.doneMarks.has(task.id)).toBe(false);
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("blocked");
    const esc = escalateCalls[0]!;
    expect(`${esc.reason} ${esc.what} ${esc.evidence}`).toMatch(/not clean/i);
    expect(esc.reason.toLowerCase()).not.toContain("conflict");
  });
});

// ---------------------------------------------------------------------------
// Unexpected-error backstop: an unhandled throw must never orphan a task in
// active/ (the live failure mode when mergeAfterGate threw on a dirty tree).
// ---------------------------------------------------------------------------

describe("runIteration -- unexpected-error backstop", () => {
  it("fails closed to escalated (not orphaned in active) when an unhandled error is thrown mid-iteration", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktree, spy: wtSpy } = makeWorktree();
    // A worktree-git whose commit throws an UNEXPECTED error with no dedicated
    // handler in the conductor. Before the backstop this unwound out of
    // runIteration and stranded the task in active/, silently locking its
    // file_set against every future same-file run.
    const worktreeGit = (wt: Worktree): Git => ({
      ...makeWorktreeGitFactory().worktreeGit(wt),
      async commit(): Promise<string> {
        throw new Error("git commit exploded");
      },
    });

    const deps = buildDeps({ repo, scheduler, escalate, worktree, worktreeGit });
    const conductor = createConductor(deps);

    // Must RESOLVE (not reject) so the bounded run ends gracefully.
    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: false });
    expect(state.locations.get(task.id)).toBe("escalated"); // NOT still "active"
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("blocked");
    expect(wtSpy.teardown.length).toBe(1); // finally still tore the worktree down
  });

  it("post-commit bookkeeping failure does not undo the commit or trip the backstop", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktreeGit } = makeWorktreeGitFactory();
    // markDone throws AFTER the decisive move to done/ (commit + merge already
    // landed). This must NOT reach the backstop and get re-escalated into the
    // contradictory "done/ + unexpected-error escalation" state (codex Sev 1).
    repo.markDone = async (): Promise<void> => {
      throw new Error("markDone exploded");
    };

    const deps = buildDeps({ repo, scheduler, escalate, worktreeGit });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: task.id, committed: true, rateLimited: false });
    expect(state.locations.get(task.id)).toBe("done"); // NOT re-moved to escalated
    expect(escalateCalls.length).toBe(0); // backstop not tripped
  });
});

describe("runIteration -- commit-time branch drift (divergence #10)", () => {
  it("escalates (no commit, no merge) when HEAD drifts to a different allowed branch before commit", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const { worktree, spy: wtSpy } = makeWorktree();
    const { worktreeGit, spy: wgSpy } = makeWorktreeGitFactory();
    // call 0 (loopBranch) = autodev/loop-A; call 1 (commit re-check) = autodev/loop-B.
    // Both match ^autodev/, but HEAD drifted -> must NOT merge into the stale loop-A.
    const { git } = makeSequencedGit(["autodev/loop-A", "autodev/loop-B"]);

    const deps = buildDeps({ repo, scheduler, escalate, worktree, worktreeGit, git });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls[0]!.type).toBe("blocked");
    expect(wgSpy.commit.length).toBe(0); // never committed
    expect(wtSpy.merge.length).toBe(0); // never merged into a stale branch
  });
});

describe("runIteration -- teardown is best-effort", () => {
  it("a worktree.teardown throw does NOT reject the iteration or lose the 429 flag", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } }],
      repo,
    );
    const worktree: WorktreeManager = {
      async create(taskId: string, baseBranch: string): Promise<Worktree> {
        return { path: `/wt/${taskId}`, branch: `autodev/wt-${taskId}`, taskId };
      },
      async diff(): Promise<string> {
        return "";
      },
      async teardown(): Promise<void> {
        throw new Error("teardown blew up");
      },
      async mergeAfterGate(): Promise<MergeResult> {
        return { ok: true, conflict: false };
      },
    };

    // A THROWING logger too: the finally's catch must swallow it via safeLog,
    // otherwise the [ts/fail-closed] gotcha re-throws out of finally and the
    // decided 429 result is lost.
    const deps = buildDeps({
      repo,
      scheduler,
      worker,
      worktree,
      log: () => {
        throw new Error("logger down");
      },
    });
    const conductor = createConductor(deps);

    // Must resolve (not reject) and preserve the rateLimited decision.
    const res = await conductor.runIteration();
    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: true });
    expect(state.locations.get(task.id)).toBe("pending");
    expect(state.attempts.get(task.id)).toBe(0); // refunded despite teardown throw
  });
});

// ---------------------------------------------------------------------------
// 8. Drift-escalation routing
// ---------------------------------------------------------------------------

describe("run -- anti-drift routing", () => {
  it("escalates with type 'drift' when runAntiDrift reports DRIFT", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const cfg: HarnessConfig = HarnessConfigSchema.parse({ antiDrift: { everyCommits: 1 } });

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      cfg,
      runAntiDrift: async (_input: AntiDriftInput) => "DRIFT: wandered off scope",
    });
    const conductor = createConductor(deps);

    await conductor.run({ maxIterations: 2 });

    const driftCalls = escalateCalls.filter((c) => c.type === "drift");
    expect(driftCalls.length).toBe(1);
  });

  it("does NOT escalate when runAntiDrift reports ON-TRACK", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const cfg: HarnessConfig = HarnessConfigSchema.parse({ antiDrift: { everyCommits: 1 } });

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      cfg,
      runAntiDrift: async (_input: AntiDriftInput) => "ON-TRACK: fine",
    });
    const conductor = createConductor(deps);

    await conductor.run({ maxIterations: 2 });

    const driftCalls = escalateCalls.filter((c) => c.type === "drift");
    expect(driftCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mandatory anti-drift + north-star (spec 2026-07-23; adr/004 last slice).
// The unattended POLICY: a silent north-star refuses the whole run before any
// task is claimed, and a DRIFT halts the drain. The DEFAULT policy (omitted) must
// reproduce today's attended behavior byte-for-byte (regression pin).
// ---------------------------------------------------------------------------
describe("run -- anti-drift policy (north-star preflight + halt-on-drift)", () => {
  it("requireNorthStar + a SILENT north-star: refuses before claiming any task, escalates blocked, journals a park", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const journal: DecisionJournalEntry[] = [];

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      // A GOAL.md that still carries the unfilled sentinel reads as silent.
      readNorthStar: async () => `# GOAL\n## What it is\n${NORTH_STAR_UNFILLED_SENTINEL}\n`,
      writeDecision: async (e) => {
        journal.push(e);
      },
    });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true, antiDrift: { onDrift: "halt-drain", requireNorthStar: true } });

    // No task ever claimed -> no worker/critic tokens burned.
    expect(claimCalls.count).toBe(0);
    expect(state.locations.get(task.id)).toBeUndefined();
    // A distinct operator escalation, keyed on the synthetic (north-star) task.
    const nsEsc = escalateCalls.filter((c) => c.taskId === "(north-star)");
    expect(nsEsc.length).toBe(1);
    expect(nsEsc[0]!.type).toBe("blocked");
    // A park entry the morning report will surface.
    expect(journal.length).toBe(1);
    expect(journal[0]).toMatchObject({ taskId: "(north-star)", escalationType: "blocked", decision: "park" });
  });

  it("requireNorthStar + an ABSENT north-star (readNorthStar -> null): refuses (fail-closed)", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, escalate, readNorthStar: async () => null });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true, antiDrift: { onDrift: "halt-drain", requireNorthStar: true } });

    expect(claimCalls.count).toBe(0);
    expect(escalateCalls.filter((c) => c.taskId === "(north-star)").length).toBe(1);
  });

  it("requireNorthStar + a FILLED north-star: does NOT refuse -- the drain proceeds normally", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      readNorthStar: async () =>
        "# GOAL\n## What it is\nA real WooCommerce shipping plugin.\n## What it must never do\nNever alter the checkout total.\n",
    });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true, antiDrift: { onDrift: "halt-drain", requireNorthStar: true } });

    // The task was processed to done -- a filled north-star must not brick the run.
    expect(claimCalls.count).toBeGreaterThanOrEqual(1);
    expect(state.locations.get(task.id)).toBe("done");
    expect(escalateCalls.filter((c) => c.taskId === "(north-star)").length).toBe(0);
  });

  it("onDrift 'halt-drain': a DRIFT escalates AND stops the drain -- a second queued task stays unclaimed", async () => {
    const tasks = [
      makeTask({ id: "h1", file_set: ["a.ts"], path: "queue/pending/h1.md" }),
      makeTask({ id: "h2", file_set: ["b.ts"], path: "queue/pending/h2.md" }),
    ];
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([...tasks], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const journal: DecisionJournalEntry[] = [];
    const cfg: HarnessConfig = HarnessConfigSchema.parse({ antiDrift: { everyCommits: 1 } });

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      cfg,
      runAntiDrift: async () => "DRIFT: wandered off scope",
      writeDecision: async (e) => {
        journal.push(e);
      },
    });
    const conductor = createConductor(deps);

    // requireNorthStar:false isolates halt-on-drift from the preflight.
    await conductor.run({ drain: true, antiDrift: { onDrift: "halt-drain", requireNorthStar: false } });

    // Exactly one task claimed + committed, then the drift halted the drain before h2.
    expect(claimCalls.count).toBe(1);
    expect(state.locations.get("h1")).toBe("done");
    expect(state.locations.get("h2")).toBeUndefined();
    expect(escalateCalls.filter((c) => c.type === "drift").length).toBe(1);
    // The halt is journaled as a park keyed on (anti-drift).
    const parks = journal.filter((e) => e.taskId === "(anti-drift)" && e.decision === "park");
    expect(parks.length).toBe(1);
  });

  it("DEFAULT policy (antiDrift omitted): a DRIFT escalates but the drain CONTINUES (regression pin)", async () => {
    const tasks = [
      makeTask({ id: "c1", file_set: ["a.ts"], path: "queue/pending/c1.md" }),
      makeTask({ id: "c2", file_set: ["b.ts"], path: "queue/pending/c2.md" }),
    ];
    const { repo, state } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([...tasks], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const journal: DecisionJournalEntry[] = [];
    const cfg: HarnessConfig = HarnessConfigSchema.parse({ antiDrift: { everyCommits: 1 } });

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      cfg,
      runAntiDrift: async () => "DRIFT: wandered off scope",
      writeDecision: async (e) => {
        journal.push(e);
      },
    });
    const conductor = createConductor(deps);

    await conductor.run({ drain: true }); // no policy -> attended default

    // Both tasks processed despite a DRIFT after each: the drain did NOT halt.
    expect(state.locations.get("c1")).toBe("done");
    expect(state.locations.get("c2")).toBe("done");
    expect(claimCalls.count).toBe(3); // c1, c2, then a null claim -> idle stop
    expect(escalateCalls.filter((c) => c.type === "drift").length).toBe(2);
    // Attended default never journals an anti-drift decision.
    expect(journal.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Extras: timed-out worker, critic clean/broken/uncertain routing.
// ---------------------------------------------------------------------------

describe("runIteration -- worker TIMED_OUT", () => {
  it("returns the task to pending WITHOUT refunding the attempt", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "TIMED_OUT", model: "opus", rateLimited: false, timedOut: true, exitCode: 124 } }],
      repo,
    );

    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: false });
    expect(state.locations.get(task.id)).toBe("pending");
    expect(state.attempts.get(task.id)).toBe(1); // NOT refunded
  });
});

describe("runIteration -- critic routing", () => {
  it("clean verdict proceeds straight to the gate", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic, calls: criticCalls } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(criticCalls.length).toBe(1);
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
  });

  it("broken verdict + contract risk -> disagreement escalation", async () => {
    const task = makeTask({ touches_contract_zone: true });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const brokenVerdict: Verdict = {
      verdict: "broken",
      broken_contracts: [{ zone: "z1", file: "a.ts", line: 3, evidence: "changed the enum" }],
      notes: "this breaks contract z1",
      confidence: 0.9,
    };
    const { critic } = makeCritic([{ result: { verdict: brokenVerdict, rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]!.type).toBe("disagreement");
  });

  it("uncertain verdict, non-contract, round < maxRounds -> writes feedback and retries", async () => {
    const task = makeTask({ touches_contract_zone: false, max_rounds: 2 });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const uncertainVerdict: Verdict = {
      verdict: "uncertain",
      broken_contracts: [],
      notes: "please clarify the edge case",
      confidence: 0.4,
    };
    const { critic, calls: criticCalls } = makeCritic([
      { result: { verdict: uncertainVerdict, rateLimited: false } },
      { result: { verdict: makeCleanVerdict(), rateLimited: false } },
    ]);
    const { worker, calls: workerCalls } = makeWorker(
      [
        { result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" },
        { result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" },
      ],
      repo,
    );

    const deps = buildDeps({ repo, scheduler, critic, worker });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(workerCalls.length).toBe(2);
    expect(criticCalls.length).toBe(2);
    expect(workerCalls[1]!.criticFeedback).toBe("please clarify the edge case");
    expect(state.runtimeFiles.get(task.id)?.get("critic-feedback.md")).toBe("please clarify the edge case");
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Extras: worker-report routing (TOO_BIG / NEEDS_GUARD / BLOCKED)
// ---------------------------------------------------------------------------

describe("runIteration -- worker-report routing", () => {
  it("TOO_BIG -> quarantine, blocked escalation", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: TOO_BIG" }],
      repo,
    );
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worker, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("quarantine");
    expect(escalateCalls[0]!.type).toBe("blocked");
  });

  it("NEEDS_GUARD -> escalated, needs-guard escalation", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: NEEDS_GUARD" }],
      repo,
    );
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worker, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls[0]!.type).toBe("needs-guard");
  });

  it("BLOCKED -> escalated, blocked escalation", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: BLOCKED" }],
      repo,
    );
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worker, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls[0]!.type).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Extras: critic rate-limited (symmetric refund), idle claim, sleep behavior
// ---------------------------------------------------------------------------

describe("runIteration -- critic rate-limited", () => {
  it("refunds the attempt and returns to pending, symmetric with the worker path", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic } = makeCritic([{ result: { verdict: null, rateLimited: true } }]);

    const deps = buildDeps({ repo, scheduler, critic });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: task.id, committed: false, rateLimited: true });
    expect(state.attempts.get(task.id)).toBe(0);
    expect(state.locations.get(task.id)).toBe("pending");
  });
});

describe("runIteration -- idle claim", () => {
  it("returns an idle result when nothing is claimable", async () => {
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([], repo);
    const deps = buildDeps({ repo, scheduler });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res).toEqual({ claimedTaskId: null, committed: false, rateLimited: false });
  });
});

describe("run -- sleep behavior", () => {
  it("sleeps sleepSeconds on an idle iteration and rateLimitBackoffSeconds after a 429", async () => {
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([], repo);
    const sleepCalls: number[] = [];
    const cfg = HarnessConfigSchema.parse({ loop: { sleepSeconds: 7, rateLimitBackoffSeconds: 99 } });

    const deps = buildDeps({
      repo,
      scheduler,
      cfg,
      sleep: async (seconds: number) => {
        sleepCalls.push(seconds);
      },
    });
    const conductor = createConductor(deps);

    // maxIterations:2 -> iteration 1 (idle) sleeps sleepSeconds; iteration 2
    // hits the maxIterations early-exit BEFORE its own sleep (parity spec §2:
    // -MaxIterations is checked before the sleep step), so exactly one sleep(7).
    await conductor.run({ maxIterations: 2 });

    expect(sleepCalls).toEqual([7]);
  });

  it("does not sleep after a claimed, successfully committed iteration", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const sleepCalls: number[] = [];

    const deps = buildDeps({
      repo,
      scheduler,
      sleep: async (seconds: number) => {
        sleepCalls.push(seconds);
      },
    });
    const conductor = createConductor(deps);

    await conductor.run({ maxIterations: 1 });

    expect(sleepCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// harvestWorkerReport wiring (parity spec §6 -- worker-report relocation fix)
// ---------------------------------------------------------------------------

describe("runIteration -- harvestWorkerReport wiring", () => {
  it("calls harvestWorkerReport(wt, task.id) exactly once, BEFORE the status read", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    // This worker fake deliberately does NOT write "worker-report.md" into
    // repo runtime files -- simulating the real world, where the worker only
    // ever writes the report into the WORKTREE. Only `harvestWorkerReport` can
    // make it visible to the conductor's status read (`repo.readRuntimeFile`).
    const worker: WorkerAdapter = {
      async run(): Promise<WorkerResult> {
        return { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 };
      },
    };
    const { escalate, calls: escalateCalls } = makeEscalate();

    const harvestCalls: { wt: Worktree; taskId: string }[] = [];
    const harvestWorkerReport = async (wt: Worktree, taskId: string): Promise<void> => {
      harvestCalls.push({ wt, taskId });
      // Simulate the relocation: only NOW does the report become visible at
      // runtimeDir, exactly like a real `rename(worktree/..., runtimeDir/...)`.
      await repo.writeRuntimeFile(taskId, "worker-report.md", "status: TOO_BIG");
    };

    const deps = buildDeps({ repo, scheduler, worker, escalate, harvestWorkerReport });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(harvestCalls.length).toBe(1);
    expect(harvestCalls[0]!.taskId).toBe(task.id);
    expect(harvestCalls[0]!.wt.path).toBe(`/wt/${task.id}`);
    // Load-bearing proof: the TOO_BIG status (written only by the harvest fake)
    // was visible to the status read, which only happens if the conductor
    // calls harvestWorkerReport BEFORE reading "worker-report.md". Without
    // this call wired in, the read would see "" and the task would fall
    // through to a normal COMMIT instead of being quarantined.
    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("quarantine");
    expect(escalateCalls[0]!.type).toBe("blocked");
  });

  it("relocates the report BEFORE the dirty-file fence snapshots the worktree", async () => {
    // The other half of the original bug: worker-report.md must be out of the
    // worktree BEFORE the fence's gitChangedPaths runs, else it is flagged as
    // a stray file. This test drives a DONE flow that reaches the fence and
    // records call order. Note the conductor calls gitChangedPaths TWICE: the
    // pre-worker baseline (before harvest) and the fence snapshot (after
    // harvest) -- so we assert harvest precedes the LAST gitChangedPaths call.
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const worker: WorkerAdapter = {
      async run(): Promise<WorkerResult> {
        return { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 };
      },
    };

    const order: string[] = [];
    const harvestWorkerReport = async (_wt: Worktree, taskId: string): Promise<void> => {
      order.push("harvest");
      await repo.writeRuntimeFile(taskId, "worker-report.md", "status: DONE");
    };
    const gitChangedPaths = async (): Promise<string[]> => {
      order.push("gitChangedPaths");
      return [];
    };

    const deps = buildDeps({ repo, scheduler, worker, harvestWorkerReport, gitChangedPaths });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    // DONE + clean fence + COMMIT gate -> the flow reached (and passed) the fence.
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
    // The fence's snapshot is the LAST gitChangedPaths call; harvest must
    // precede it. (The FIRST gitChangedPaths is the pre-worker baseline, which
    // legitimately runs before harvest -- so we compare against lastIndexOf.)
    const harvestIdx = order.indexOf("harvest");
    const fenceIdx = order.lastIndexOf("gitChangedPaths");
    expect(harvestIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThan(harvestIdx);
  });
});

// ---------------------------------------------------------------------------
// Token/usage instrumentation (s22)
// ---------------------------------------------------------------------------

describe("runIteration -- token-usage persistence", () => {
  const workerUsage = {
    model: "sonnet",
    input_tokens: 100,
    output_tokens: 200,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
  };
  const criticUsage = { model: "gpt-5.5", tokens: 777 };

  it("persists an aggregated token-usage.json when worker and critic report usage", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "DONE", model: "sonnet", rateLimited: false, timedOut: false, exitCode: 0, usage: workerUsage }, report: "status: DONE" }],
      repo,
    );
    const { critic } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false, usage: criticUsage } }]);

    const deps = buildDeps({ repo, scheduler, worker, critic, clock: { now: () => 4242 } });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    const raw = state.runtimeFiles.get(task.id)?.get("token-usage.json");
    expect(raw).toBeDefined();
    const doc = JSON.parse(raw!) as {
      worker: { input_tokens: number; runs: unknown[] };
      critic: { tokens: number; runs: unknown[] };
      updated_at: number;
    };
    expect(doc.worker.input_tokens).toBe(100);
    expect(doc.worker.runs).toHaveLength(1);
    expect(doc.critic.tokens).toBe(777);
    expect(doc.critic.runs).toHaveLength(1);
    expect(doc.updated_at).toBe(4242);
  });

  it("does not write token-usage.json when neither adapter reports usage", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);

    const deps = buildDeps({ repo, scheduler }); // default worker/critic carry no usage
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(state.runtimeFiles.get(task.id)?.has("token-usage.json")).toBeFalsy();
  });

  it("is best-effort: a throwing token-usage write neither rejects nor blocks the commit", async () => {
    const task = makeTask();
    const { repo: base, state } = makeRepo();
    const { scheduler } = makeScheduler([task], base);
    // Wrap the repo so ONLY the token-usage write throws; every other runtime
    // write (diff.patch, worker-report.md, ...) delegates unchanged.
    const repo: BlackboardRepository = {
      ...base,
      async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
        if (name === "token-usage.json") throw new Error("disk full");
        return base.writeRuntimeFile(id, name, content);
      },
    };
    const { worker } = makeWorker(
      [{ result: { status: "DONE", model: "sonnet", rateLimited: false, timedOut: false, exitCode: 0, usage: workerUsage }, report: "status: DONE" }],
      repo,
    );
    const { critic } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false, usage: criticUsage } }]);

    const deps = buildDeps({ repo, scheduler, worker, critic });
    const conductor = createConductor(deps);

    // Must resolve (not reject) and still commit despite the token-write throw.
    const res = await conductor.runIteration();
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
    expect(state.runtimeFiles.get(task.id)?.has("token-usage.json")).toBe(false);
  });

  it("persists loop-branch alongside diff.patch (pins the branch for a later apply-on-accept)", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    // Default makeGit branch is "autodev/loop-main"; loopBranch is captured from it.
    const deps = buildDeps({ repo, scheduler, git: makeGit("autodev/loop-main").git });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(state.runtimeFiles.get(task.id)?.get("diff.patch")).toBeDefined();
    expect(state.runtimeFiles.get(task.id)?.get("loop-branch")).toBe("autodev/loop-main");
  });
});

// ---------------------------------------------------------------------------
// Critic verdict persistence (s24)
// ---------------------------------------------------------------------------

describe("runIteration -- critic-verdict.json persistence", () => {
  it("persists critic-verdict.json for a clean verdict", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic } = makeCritic([{ result: { verdict: makeCleanVerdict({ confidence: 0.87 }), rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic, clock: { now: () => 4242 } });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    const raw = state.runtimeFiles.get(task.id)?.get("critic-verdict.json");
    expect(raw).toBeDefined();
    const doc = JSON.parse(raw!) as { verdict: string; confidence: number; notes: string; updated_at: number };
    expect(doc.verdict).toBe("clean");
    expect(doc.confidence).toBe(0.87);
    expect(doc.updated_at).toBe(4242);
  });

  it("persists critic-verdict.json for an escalating (broken) verdict", async () => {
    const task = makeTask({ touches_contract_zone: true });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const brokenVerdict: Verdict = {
      verdict: "broken",
      broken_contracts: [{ zone: "z1", file: "a.ts", line: 3, evidence: "changed the enum" }],
      notes: "this breaks contract z1",
      confidence: 0.9,
    };
    const { critic } = makeCritic([{ result: { verdict: brokenVerdict, rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    const raw = state.runtimeFiles.get(task.id)?.get("critic-verdict.json");
    expect(raw).toBeDefined();
    const doc = JSON.parse(raw!) as { verdict: string };
    expect(doc.verdict).toBe("broken");
  });

  it("writes nothing when the critic verdict is null/unparseable (not rate-limited)", async () => {
    const task = makeTask({ touches_contract_zone: true });
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate } = makeEscalate();
    const { critic } = makeCritic([{ result: { verdict: null, rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(state.runtimeFiles.get(task.id)?.has("critic-verdict.json")).toBeFalsy();
  });

  it("is best-effort: a throwing critic-verdict write neither rejects nor blocks the commit", async () => {
    const task = makeTask();
    const { repo: base, state } = makeRepo();
    const { scheduler } = makeScheduler([task], base);
    const repo: BlackboardRepository = {
      ...base,
      async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
        if (name === "critic-verdict.json") throw new Error("disk full");
        return base.writeRuntimeFile(id, name, content);
      },
    };
    const { critic } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);

    const deps = buildDeps({ repo, scheduler, critic });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
    expect(state.runtimeFiles.get(task.id)?.has("critic-verdict.json")).toBe(false);
  });

  it("leaves NO stale artifact when an earlier round was parseable but the decisive round is null", async () => {
    // Decisive-only persistence: round 0 returns a parseable `uncertain` (a
    // non-contract, non-final round -> retry, NOT persisted); round 1 returns a
    // null/unparseable verdict and escalates. Because intermediate rounds are
    // never written, the round-0 `uncertain` must NOT survive on disk as a
    // misleading "current" verdict -- the file stays absent.
    const task = makeTask({ max_rounds: 1 }); // round 0 retries, round 1 escalates
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const uncertain: Verdict = {
      verdict: "uncertain",
      broken_contracts: [],
      notes: "not sure, please retry",
      confidence: 0.4,
    };
    const { critic } = makeCritic([
      { result: { verdict: uncertain, rateLimited: false } },
      { result: { verdict: null, rateLimited: false } },
    ]);

    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    // The round-0 uncertain was never persisted, and the null round wrote
    // nothing -> no stale verdict on disk.
    expect(state.runtimeFiles.get(task.id)?.has("critic-verdict.json")).toBeFalsy();
  });

  it("never-throws even when the catch-block logger itself throws (fail-closed [ts/fail-closed])", async () => {
    // Both the primary dep (writeRuntimeFile) AND the failure logger throw --
    // the gotcha's exact scenario. safeLog must swallow the logger throw so the
    // enforcement loop still commits the clean task.
    const task = makeTask();
    const { repo: base, state } = makeRepo();
    const { scheduler } = makeScheduler([task], base);
    const repo: BlackboardRepository = {
      ...base,
      async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
        if (name === "critic-verdict.json") throw new Error("disk full");
        return base.writeRuntimeFile(id, name, content);
      },
    };
    const { critic } = makeCritic([{ result: { verdict: makeCleanVerdict(), rateLimited: false } }]);
    const log = (_level: string, message: string): void => {
      if (message.includes("critic-verdict")) throw new Error("logger exploded");
    };

    const deps = buildDeps({ repo, scheduler, critic, log });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();

    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
  });
});

describe("run -- MaxSessionHours graceful exit", () => {
  it("stops before claiming anything once the session budget is exhausted", async () => {
    const { repo } = makeRepo();
    const { scheduler, claimCalls } = makeScheduler([makeTask()], repo);
    const cfg = HarnessConfigSchema.parse({ loop: { maxSessionHours: 1 } });
    // The FIRST now() call is the loop's startMs baseline (0); every subsequent
    // call reports 2h elapsed, so the >1h budget trips at the TOP of the first
    // iteration -- before any claim. (Setting a constant 2h would make startMs
    // itself 2h, leaving elapsed pinned at 0 and looping forever.)
    let nowCalls = 0;
    const deps = buildDeps({
      repo,
      scheduler,
      cfg,
      clock: { now: () => (nowCalls++ === 0 ? 0 : 2 * 3600 * 1000) },
    });
    const conductor = createConductor(deps);

    await conductor.run();

    expect(claimCalls.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// N. Reply-B rework carries the critic's objection to the re-run
//    ([rework/reply-b-drops-critic-feedback], s42)
// ---------------------------------------------------------------------------

describe("runIteration -- reply-B rework feedback", () => {
  it("persists critic-feedback.md on a contract-risk escalation (durable objection for a re-run)", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic } = makeCritic([
      {
        result: {
          verdict: {
            verdict: "broken",
            broken_contracts: [{ zone: "z", file: "a.ts", line: 1, evidence: "load-order silent skip" }],
            notes: "The add_filter under a load-time class_exists can silently skip.",
            confidence: 0.8,
          },
          rateLimited: false,
        },
      },
    ]);
    const { escalate, calls: escalateCalls } = makeEscalate();
    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(state.locations.get(task.id)).toBe("escalated");
    expect(escalateCalls.length).toBe(1);
    const feedback = state.runtimeFiles.get(task.id)?.get("critic-feedback.md");
    expect(feedback).toBeDefined();
    expect(feedback).toMatch(/class_exists can silently skip/i);
  });

  it("feeds an existing critic-feedback.md to the worker at round 0 on a re-claim (reply-B rework)", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    // Pre-seed the persisted objection as if a prior escalation + reply-B happened.
    await repo.writeRuntimeFile(task.id, "critic-feedback.md", "Prior objection: fix the load order.");
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" }],
      repo,
    );
    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(workerCalls.length).toBe(1);
    expect(workerCalls[0]!.criticFeedback).toBe("Prior objection: fix the load order.");
    void state;
  });

  it("passes no critic feedback to a fresh task's first worker run (no file present)", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" }],
      repo,
    );
    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(workerCalls.length).toBe(1);
    expect(workerCalls[0]!.criticFeedback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gate feedback on retry (docs/superpowers/plans/2026-07-22-gate-feedback-on-
// retry.md, Tasks 3+4): the claim-time read beside critic-feedback.md, and the
// end-to-end loop closure a gate RETRY -> re-claim depends on. `runGate` itself
// (and its write-or-clear contract) is covered by gate.test.ts; these tests
// cover only what the CONDUCTOR does with the artifact runGate leaves behind.
// ---------------------------------------------------------------------------

describe("runIteration -- gate feedback on retry", () => {
  it("feeds an existing gate-feedback.md to the worker at round 0 on a re-claim", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    // Pre-seed the persisted gate report as if a prior RETRY round wrote it.
    await repo.writeRuntimeFile(task.id, "gate-feedback.md", "phpcs: 3 | ERROR | Missing docblock");
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" }],
      repo,
    );
    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(workerCalls.length).toBe(1);
    expect(workerCalls[0]!.gateFeedback).toBe("phpcs: 3 | ERROR | Missing docblock");
  });

  it("passes no gate feedback to a fresh task's first worker run (no file present)", async () => {
    const task = makeTask();
    const { repo } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [{ result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" }],
      repo,
    );
    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    expect(workerCalls.length).toBe(1);
    expect(workerCalls[0]!.gateFeedback).toBeUndefined();
  });

  it("closes the loop: a gate RETRY persists gate-feedback.md, and the SAME task's next claim reaches the worker with it set", async () => {
    // This is the test that proves the loop closes end to end -- the prompt test
    // only proves rendering, and the two tests above only prove the claim-time
    // read in isolation. Here `runGate` is scripted to behave like the real
    // `runGateCore` + composition-root `writeGateFeedback` wiring would: on its
    // first (RETRY) call it writes the failing step's content via the SAME
    // `repo.writeRuntimeFile` the real `writeGateFeedback` dep uses, then on its
    // second call (the re-claim after requeue) it returns a clean COMMIT.
    const task = makeTask({ id: "t-gate-retry" });
    const { repo, state } = makeRepo();
    // The scheduler fake shifts tasks off a plain array -- re-enqueue the SAME
    // task object to simulate the requeue a real RETRY performs via moveTask
    // (active -> pending), which conductor.ts already does before returning.
    const { scheduler } = makeScheduler([task, task], repo);
    const { worker, calls: workerCalls } = makeWorker(
      [
        { result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" },
        { result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 }, report: "status: DONE" },
      ],
      repo,
    );
    const gateFeedbackDoc = "# Gate failure -- previous round\n\n## check command -- exit 1\n\n```\nPHPUnit: 1 failure\n```\n";
    let gateCalls = 0;
    const runGate = async () => {
      gateCalls++;
      if (gateCalls === 1) {
        // Mirrors `composition/root.ts`'s `writeGateFeedback` dep at runGate's
        // decisive RETRY exit (gate.ts): persist the failing step's output
        // BEFORE returning the verdict.
        await repo.writeRuntimeFile(task.id, "gate-feedback.md", gateFeedbackDoc);
        return defaultGateVerdict({ decision: "RETRY", success_green: false, reasons: ["check command FAILED (exit 1)"] });
      }
      return defaultGateVerdict();
    };

    const deps = buildDeps({ repo, scheduler, worker, runGate });
    const conductor = createConductor(deps);

    const first = await conductor.runIteration();
    expect(first.committed).toBe(false);
    expect(state.locations.get(task.id)).toBe("pending");
    expect(state.runtimeFiles.get(task.id)?.get("gate-feedback.md")).toBe(gateFeedbackDoc);
    expect(workerCalls[0]!.gateFeedback).toBeUndefined(); // round 0 of round 1 had no prior gate failure

    const second = await conductor.runIteration();
    expect(second.committed).toBe(true);
    expect(workerCalls.length).toBe(2);
    expect(workerCalls[1]!.gateFeedback).toBe(gateFeedbackDoc);
  });
});

// ---------------------------------------------------------------------------
// Evidence ledger (spec 2026-07-22 "two reports")
// ---------------------------------------------------------------------------

describe("runIteration -- evidence ledger", () => {
  /** Parse the evidence record the iteration wrote, asserting it exists AND
   *  satisfies the fail-closed schema (a record the harness cannot fully read
   *  is worse than none). */
  function readEvidence(state: RepoState, taskId: string): EvidenceRecord {
    const raw = state.runtimeFiles.get(taskId)?.get("evidence.json");
    expect(raw).toBeDefined();
    return EvidenceSchema.parse(JSON.parse(raw!));
  }

  it("writes evidence.json for a COMMITTED task, with the commit hash and the gate verdict", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [
        {
          result: {
            status: "DONE",
            model: "sonnet",
            rateLimited: false,
            timedOut: false,
            exitCode: 0,
            usage: {
              model: "sonnet",
              input_tokens: 100,
              output_tokens: 200,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
          report: "status: DONE",
        },
      ],
      repo,
    );
    const { critic } = makeCritic([
      {
        result: {
          verdict: makeCleanVerdict({ confidence: 0.9 }),
          rateLimited: false,
          usage: { model: "gpt", tokens: 77 },
        },
      },
    ]);

    const deps = buildDeps({
      repo,
      scheduler,
      worker,
      critic,
      profileRef: { id: "wordpress-woocommerce", version: 2 },
      runGate: async () =>
        defaultGateVerdict({
          changed_files: ["a.ts"],
          profile_gates: [
            {
              id: "phpcs",
              status: "skipped",
              exit_code: null,
              skip_reason: "no changed file matched **/*.php",
              scope: "changed-lines",
              files: [],
              findings: null,
              findings_total: null,
              output: "",
            },
          ],
        }),
    });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();
    expect(res.committed).toBe(true);

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("committed");
    expect(rec.commit).toBe("hash-t1");
    expect(rec.escalation).toBeNull();
    expect(rec.rounds).toBe(0);
    expect(rec.attempts).toBe(1);
    expect(rec.run_id).toBeNull();
    expect(rec.title).toBe(task.title);
    expect(rec.declared.file_set).toEqual(["a.ts"]);
    expect(rec.profile).toEqual({ id: "wordpress-woocommerce", version: 2 });
    expect(rec.critic).toEqual({ verdict: "clean", confidence: 0.9 });
    expect(rec.gate?.decision).toBe("COMMIT");
    expect(rec.gate?.changed_files).toEqual(["a.ts"]);
    expect(rec.profile_gates.map((g) => [g.id, g.status])).toEqual([["phpcs", "skipped"]]);
    expect(rec.tokens).toEqual({ worker_total: 300, critic_total: 77 });
  });

  it("writes evidence.json for an ESCALATED task, naming the escalation type and the critic verdict", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { critic } = makeCritic([
      {
        result: {
          verdict: {
            verdict: "broken",
            broken_contracts: [{ zone: "z", file: "a.ts", line: 1, evidence: "e" }],
            notes: "n",
            confidence: 0.76,
          },
          rateLimited: false,
        },
      },
    ]);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, critic, escalate });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("escalated");
    expect(rec.commit).toBeNull();
    expect(rec.escalation).toEqual({ type: "disagreement", reason: "critic did not return a clean verdict" });
    // The recorded reason must be the SAME string the escalation carries, never a retyped copy.
    expect(rec.escalation?.reason).toBe(escalateCalls[0]!.reason);
    expect(rec.critic).toEqual({ verdict: "broken", confidence: 0.76 });
    expect(rec.gate).toBeNull();
  });

  it("records the QUARANTINED circuit-breaker exit, which returns before the worktree even exists", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo({ [task.id]: 3 });
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, escalate });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("quarantined");
    expect(rec.escalation?.type).toBe("poison");
    expect(rec.escalation?.reason).toBe(escalateCalls[0]!.reason);
    expect(rec.attempts).toBe(4);
  });

  it("records a gate-threw escalation with the gate's OWN reason string", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({
      repo,
      scheduler,
      escalate,
      runGate: async () => {
        throw new AgentCiUnavailableError(
          "needs-wsl-on-windows",
          "agent-ci gate requires WSL on Windows -- install WSL or run on Linux/Mac",
        );
      },
    });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("escalated");
    expect(rec.escalation?.reason).toBe(escalateCalls[0]!.reason);
    expect(rec.escalation?.reason).toBe("agent-ci gate requires WSL on Windows -- install WSL or run on Linux/Mac");
  });

  it("a stale record from a previous iteration does NOT survive an iteration whose own write fails", async () => {
    // The write is fail-soft by contract (H6), so the only way to keep the ledger
    // from repeating a lie is to remove the previous record BEFORE the work: a
    // failed write must leave the record ABSENT (reported honestly as missing
    // evidence, H1), never present and contradicting the task's real outcome.
    const task = makeTask();
    const { repo, state } = makeRepo();
    // What a previous RETRY iteration left behind.
    await repo.writeRuntimeFile(task.id, "evidence.json", JSON.stringify({ schema: 1, outcome: "abandoned" }));

    const { scheduler } = makeScheduler([task], repo);
    const failingRepo: BlackboardRepository = {
      ...repo,
      async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
        if (name === "evidence.json") throw new Error("disk full");
        await repo.writeRuntimeFile(id, name, content);
      },
    };

    const deps = buildDeps({ repo: failingRepo, scheduler });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();
    expect(res.committed).toBe(true);
    // Absent -- not the previous iteration's "abandoned" record beside a done task.
    expect(state.runtimeFiles.get(task.id)?.has("evidence.json")).toBe(false);
  });

  it("records a RETRY as 'abandoned' -- this iteration decided nothing", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);

    const deps = buildDeps({
      repo,
      scheduler,
      runGate: async () => defaultGateVerdict({ decision: "RETRY", composer_green: false }),
    });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("abandoned");
    expect(rec.escalation).toBeNull();
    expect(rec.gate?.decision).toBe("RETRY");
    expect(rec.gate?.composer_green).toBe(false);
  });

  it("records the worker-report BLOCKED exit, an exit with no gate at all", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [
        {
          result: { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
          report: "status: BLOCKED",
        },
      ],
      repo,
    );
    const { escalate, calls: escalateCalls } = makeEscalate();

    const deps = buildDeps({ repo, scheduler, worker, escalate });
    const conductor = createConductor(deps);

    await conductor.runIteration();

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("escalated");
    expect(rec.escalation?.type).toBe("blocked");
    expect(rec.escalation?.reason).toBe(escalateCalls[0]!.reason);
  });

  it("records a rate-limited iteration as 'abandoned' with no escalation", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const { worker } = makeWorker(
      [{ result: { status: "RATE_LIMITED", model: "opus", rateLimited: true, timedOut: false, exitCode: 1 } }],
      repo,
    );

    const deps = buildDeps({ repo, scheduler, worker });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();
    expect(res.rateLimited).toBe(true);

    const rec = readEvidence(state, task.id);
    expect(rec.outcome).toBe("abandoned");
    expect(rec.escalation).toBeNull();
  });

  it("an evidence write failure does NOT fail the iteration (H6)", async () => {
    const task = makeTask();
    const { repo: base, state } = makeRepo();
    const { scheduler } = makeScheduler([task], base);
    const repo: BlackboardRepository = {
      ...base,
      async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
        if (name === "evidence.json") throw new Error("disk full");
        return base.writeRuntimeFile(id, name, content);
      },
    };

    const deps = buildDeps({ repo, scheduler });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();
    expect(res.committed).toBe(true);
    expect(state.locations.get(task.id)).toBe("done");
    expect(state.runtimeFiles.get(task.id)?.has("evidence.json")).toBe(false);
  });

  it("writes evidence BEFORE the worktree teardown, so a teardown throw cannot lose the record", async () => {
    const task = makeTask();
    const { repo, state } = makeRepo();
    const { scheduler } = makeScheduler([task], repo);
    const worktree: WorktreeManager = {
      async create(taskId: string): Promise<Worktree> {
        return { path: `/wt/${taskId}`, branch: `autodev/wt-${taskId}`, taskId };
      },
      async diff(): Promise<string> {
        return "";
      },
      async teardown(): Promise<void> {
        throw new Error("teardown blew up");
      },
      async mergeAfterGate(): Promise<MergeResult> {
        return { ok: true, conflict: false };
      },
    };

    const deps = buildDeps({ repo, scheduler, worktree });
    const conductor = createConductor(deps);

    const res = await conductor.runIteration();
    expect(res.committed).toBe(true);
    expect(readEvidence(state, task.id).outcome).toBe("committed");
  });
});
