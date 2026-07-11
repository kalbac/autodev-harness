import { describe, it, expect, vi } from "vitest";
import { runAgentCiWorkflows, type RunAgentCiInput } from "./agent-ci.js";
import { AgentCiUnavailableError, type AgentCiSpawner } from "./agent-ci-exec.js";
import type { AgentCiEvent } from "./agent-ci-events.js";

function fakeSpawnerFromLines(linesByWorkflow: Record<string, string[]>): AgentCiSpawner {
  return async ({ args, onLine }) => {
    // native args: [..., "--workflow", wf, "--json"]; wsl args: the script string contains the wf too.
    const wfIdx = args.indexOf("--workflow");
    const wf = wfIdx >= 0 ? args[wfIdx + 1]! : Object.keys(linesByWorkflow)[0]!;
    for (const l of linesByWorkflow[wf] ?? []) onLine(l);
    return { exitCode: 0, timedOut: false };
  };
}

const nativeCap = async () => ({ mode: "native" as const, detail: "native" });

function baseInput(over: Partial<RunAgentCiInput>): RunAgentCiInput {
  return {
    cwd: "/repo",
    workflows: ["ci.yml"],
    timeoutMs: 600000,
    detectCapability: nativeCap,
    spawn: fakeSpawnerFromLines({ "ci.yml": ['{"event":"run.finish","status":"passed"}'] }),
    onEvent: () => {},
    ...over,
  };
}

describe("runAgentCiWorkflows (streaming)", () => {
  it("green on a passed workflow; fires onEvent per structured event", async () => {
    const seen: Array<[string, AgentCiEvent]> = [];
    const res = await runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": [
        '{"event":"run.start"}',
        '{"event":"step.finish","job":"build","step":"lint","index":0,"status":"passed"}',
        'Pulling image...',            // non-JSON -> dropped, no onEvent
        '{"event":"run.finish","status":"passed"}',
      ] }),
      onEvent: (wf, ev) => seen.push([wf, ev]),
    }));
    expect(res).toEqual({ green: true, reasons: [] });
    expect(seen.map(([, e]) => e.kind)).toEqual(["run-start", "step-finish", "run-finish"]); // "other" dropped
    expect(seen.every(([wf]) => wf === "ci.yml")).toBe(true);
  });

  it("red on a failed workflow; reason names the failing step", async () => {
    const res = await runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": [
        '{"event":"step.finish","job":"build","step":"unit tests","index":1,"status":"failed"}',
        '{"event":"run.finish","status":"failed"}',
      ] }),
    }));
    expect(res.green).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/ci\.yml/);
    expect(res.reasons.join(" ")).toMatch(/unit tests/);
  });

  it("throws (infra) when a workflow produces no terminal run-finish", async () => {
    await expect(runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": ['{"event":"run.start"}'] }),
    }))).rejects.toThrow(/infrastructure|no parseable|run\.finish/i);
  });

  it("throws AgentCiUnavailableError when capability is unavailable (never spawns)", async () => {
    const spawn = vi.fn(fakeSpawnerFromLines({ "ci.yml": [] }));
    await expect(runAgentCiWorkflows(baseInput({
      detectCapability: async () => ({ mode: "unavailable", reason: "needs-wsl-on-windows", detail: "needs WSL" }),
      spawn,
    }))).rejects.toBeInstanceOf(AgentCiUnavailableError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("processes multiple workflows sequentially and aggregates reasons", async () => {
    const res = await runAgentCiWorkflows(baseInput({
      workflows: ["a.yml", "b.yml"],
      spawn: fakeSpawnerFromLines({
        "a.yml": ['{"event":"run.finish","status":"passed"}'],
        "b.yml": ['{"event":"step.finish","job":"j","step":"x","index":0,"status":"failed"}', '{"event":"run.finish","status":"failed"}'],
      }),
    }));
    expect(res.green).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/b\.yml/);
    expect(res.reasons.join(" ")).not.toMatch(/a\.yml/);
  });

  it("throws infra on a timeout even if a terminal run.finish was already seen", async () => {
    const timingOutSpawner: AgentCiSpawner = async ({ onLine }) => {
      onLine('{"event":"run.finish","status":"passed"}');
      return { exitCode: -1, timedOut: true };
    };
    await expect(runAgentCiWorkflows(baseInput({ spawn: timingOutSpawner })))
      .rejects.toThrow(/timed out|infrastructure/i);
  });

  it("wsl mode maps the Windows worktree path into /mnt/<drive> in the spawned command", async () => {
    let capturedArgs: string[] = [];
    const capturingSpawner: AgentCiSpawner = async ({ args, onLine }) => {
      capturedArgs = args;
      onLine('{"event":"run.finish","status":"passed"}');
      return { exitCode: 0, timedOut: false };
    };
    await runAgentCiWorkflows(baseInput({
      cwd: "D:\\Projects\\app",
      detectCapability: async () => ({ mode: "wsl", detail: "wsl" }),
      spawn: capturingSpawner,
    }));
    expect(capturedArgs.join(" ")).toContain("cd '/mnt/d/Projects/app'");
    expect(capturedArgs.join(" ")).not.toContain("D:\\");
  });

  it("throws AgentCiUnavailableError(unmappable-worktree-path) for a UNC worktree under wsl mode (never spawns)", async () => {
    const spawn = vi.fn(fakeSpawnerFromLines({ "ci.yml": [] }));
    await expect(runAgentCiWorkflows(baseInput({
      cwd: "\\\\server\\share\\app",
      detectCapability: async () => ({ mode: "wsl", detail: "wsl" }),
      spawn,
    }))).rejects.toBeInstanceOf(AgentCiUnavailableError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("wsl mode forwards gitDirWsl into the spawned command (GIT_DIR export)", async () => {
    let capturedArgs: string[] = [];
    const capturingSpawner: AgentCiSpawner = async ({ args, onLine }) => {
      capturedArgs = args;
      onLine('{"event":"run.finish","status":"passed"}');
      return { exitCode: 0, timedOut: false };
    };
    await runAgentCiWorkflows(baseInput({
      cwd: "D:\\a\\wt",
      gitDirWsl: "/mnt/d/a/.git/worktrees/wt",
      detectCapability: async () => ({ mode: "wsl", detail: "wsl" }),
      spawn: capturingSpawner,
    }));
    expect(capturedArgs.join(" ")).toContain("export GIT_DIR='/mnt/d/a/.git/worktrees/wt'");
  });
});
