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
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";

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
    constitution_touched: [],
    zones_touched: [],
    decision: "COMMIT",
    reasons: [],
    changed_files: [],
    ...overrides,
  };
}

function makeCleanVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return { verdict: "clean", broken_contracts: [], notes: "", confidence: 1, ...overrides };
}

/** Pairs up baseline/after fingerprint snapshots per fence round, driven by call count. */
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
    snapshotFingerprints: (): Map<string, string> => {
      const s = step();
      counter++;
      return s.map;
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
    zonesTouchedInDiff: partial.zonesTouchedInDiff ?? (async () => []),
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
