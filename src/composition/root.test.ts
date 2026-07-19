import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "../util/native.js";
import { buildProjectRoot, supervisorRunOpts } from "./root.js";

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
