import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "../util/native.js";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import { buildProjectRoot, supervisorRunOpts, shouldSupervise, buildOrchestratorCapabilities } from "./root.js";

let repoRoot: string;

/** Minimal real git repo + `.autodev/config.yaml`, mirroring the temp-repo
 *  fixture style in `src/worktree/worktree.test.ts`. */
async function initRepo(dir: string): Promise<void> {
  let r = await runNative("git", ["init", "-b", "main"], { cwd: dir });
  if (r.exitCode !== 0) {
    r = await runNative("git", ["init"], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr}`);
    await runNative("git", ["branch", "-m", "main"], { cwd: dir });
  }
  await runNative("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runNative("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a1\n");
  await runNative("git", ["add", "-A"], { cwd: dir });
  const c = await runNative("git", ["commit", "-m", "initial"], { cwd: dir });
  if (c.exitCode !== 0) throw new Error(`initial commit failed: ${c.stderr}`);
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  writeFileSync(join(dir, ".autodev", "config.yaml"), yaml, "utf8");
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "adh-root-"));
  await initRepo(repoRoot);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("buildProjectRoot", () => {
  // Validation chain (verified against src/config/schema.ts + src/config/roles.ts):
  //   - roles.orchestrator.adapter is a plain z.string() (no enum) -> any id loads.
  //   - assertKnownAdapters checks ONLY worker/critic, not orchestrator.
  //   - buildOrchestrator's switch throws for any orchestrator adapter != "claude".
  // So this config loads and passes assertKnownAdapters, but eager orchestrator
  // construction would throw -- exactly the `run` regression this test guards.
  it("does NOT construct the orchestrator (run-verb regression): resolves with an unregistered orchestrator adapter", async () => {
    writeConfig(
      repoRoot,
      ["roles:", "  orchestrator:", "    adapter: codex", "    model: gpt-5.5", ""].join("\n"),
    );

    // Pre-extraction `run` never called buildOrchestrator; with the lazy fix
    // buildProjectRoot must resolve here rather than throw at construction time.
    const root = await buildProjectRoot(repoRoot);
    expect(typeof root.orchestrator.handleIntent).toBe("function");
    expect(root.cfg.roles.orchestrator.adapter).toBe("codex");

    // The adapter is resolved ONLY on the first handleIntent -- proving laziness:
    // it is the deferred call, not buildProjectRoot, that surfaces the unregistered
    // adapter. (Captured via try/catch so a sync throw or a rejection both count.)
    let thrown: unknown;
    try {
      await root.orchestrator.handleIntent("do something");
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("no orchestrator adapter registered for 'codex'");
  });

  it("resolves on a default config and exposes the core project surface", async () => {
    writeConfig(repoRoot, ""); // empty -> all defaults (orchestrator adapter = claude)
    const root = await buildProjectRoot(repoRoot);
    expect(root.repoRoot).toBe(repoRoot);
    expect(root.stateDirAbs).toBe(join(repoRoot, ".autodev"));
    expect(typeof root.orchestrator.handleIntent).toBe("function");
    expect(root.plannerConfigured).toBe(false); // no explicit roles.planner -> false (R1)
  });

  it("sets plannerConfigured=true when the raw config explicitly sets roles.planner (R1)", async () => {
    writeConfig(repoRoot, ["roles:", "  planner:", "    adapter: codex", "    model: o3", ""].join("\n"));
    const root = await buildProjectRoot(repoRoot);
    expect(root.plannerConfigured).toBe(true);
    // The parsed cfg carries the resolved planner values (raw is only the presence gate).
    expect(root.cfg.roles.planner).toMatchObject({ adapter: "codex", model: "o3" });
  });
});

describe("supervisorRunOpts", () => {
  it("strips `once` so the supervisor's drain is a real drain", () => {
    // conductor.run breaks on `once` BEFORE it evaluates `drain`
    // (conductor.ts:705 vs :719), so `{once:true, drain:true}` runs ONE
    // iteration -- which would silently reduce the overnight sweep to a
    // single task.
    expect(supervisorRunOpts({ once: true })).toEqual({});
  });

  it("keeps every other bound", () => {
    expect(supervisorRunOpts({ once: true, maxIterations: 5 })).toEqual({ maxIterations: 5 });
  });

  it("handles an absent options object", () => {
    expect(supervisorRunOpts(undefined)).toEqual({});
  });
});

describe("shouldSupervise (overnight truth table)", () => {
  const cases: { presence: boolean; optIn: boolean; expected: boolean }[] = [
    { presence: false, optIn: false, expected: false },
    { presence: false, optIn: true, expected: false },
    { presence: true, optIn: false, expected: false },
    { presence: true, optIn: true, expected: true },
  ];
  for (const { presence, optIn, expected } of cases) {
    it(`presence=${presence} optIn=${optIn} -> ${expected}`, async () => {
      expect(await shouldSupervise(async () => presence, optIn)).toBe(expected);
    });
  }

  it("falls back to a plain run when the presence read throws", async () => {
    // Fail-direction: never fall INTO autonomy by accident.
    expect(
      await shouldSupervise(async () => {
        throw new Error("unreadable");
      }, true),
    ).toBe(false);
  });

  it("does not read presence when the project has not opted in", async () => {
    // Cheap short-circuit AND: no file read for the overwhelmingly common case.
    let reads = 0;
    await shouldSupervise(async () => {
      reads++;
      return true;
    }, false);
    expect(reads).toBe(0);
  });
});

describe("orchestrator trigger routing", () => {
  it("routes the orchestrator's trigger through the injected run entry, not conductor.run", async () => {
    writeConfig(repoRoot, "");
    const root = await buildProjectRoot(repoRoot);
    const repo = new FileBlackboardRepository(repoRoot, root.cfg.stateDir);
    const calls: unknown[] = [];

    const caps = buildOrchestratorCapabilities({
      cfg: root.cfg,
      repoRoot,
      repo,
      runEntry: async (opts) => {
        calls.push(opts);
      },
      log: root.log,
    });

    await caps.trigger();

    expect(calls).toEqual([{ once: true }]);
  });

  it("forwards explicit trigger opts through the run entry unchanged", async () => {
    writeConfig(repoRoot, "");
    const root = await buildProjectRoot(repoRoot);
    const repo = new FileBlackboardRepository(repoRoot, root.cfg.stateDir);
    const calls: unknown[] = [];

    const caps = buildOrchestratorCapabilities({
      cfg: root.cfg,
      repoRoot,
      repo,
      runEntry: async (opts) => {
        calls.push(opts);
      },
      log: root.log,
    });

    await caps.trigger({ maxIterations: 3, drain: true });

    expect(calls).toEqual([{ maxIterations: 3, drain: true }]);
  });
});
