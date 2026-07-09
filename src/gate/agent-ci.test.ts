import { describe, it, expect } from "vitest";
import { runAgentCiWorkflows, parseWorkflowOutcome } from "./agent-ci.js";
import type { NativeOptions, NativeResult } from "../util/native.js";

function res(stdout: string, exitCode = 0): NativeResult {
  return { stdout, stderr: "", exitCode } as NativeResult;
}

const PASS = [
  JSON.stringify({ type: "run.start", workflow: ".github/workflows/ci.yml" }),
  JSON.stringify({ type: "step.finish", name: "test", conclusion: "success" }),
  JSON.stringify({ type: "run.finish", status: "passed" }),
].join("\n");

const FAIL = [
  JSON.stringify({ type: "run.start", workflow: ".github/workflows/ci.yml" }),
  JSON.stringify({ type: "step.finish", name: "test", conclusion: "failure" }),
  JSON.stringify({ type: "run.finish", status: "failed" }),
].join("\n");

describe("runAgentCiWorkflows", () => {
  it("returns green:true when the single workflow's run.finish is passed", async () => {
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 60000,
      runner: async () => res(PASS),
    });
    expect(out).toEqual({ green: true, reasons: [] });
  });

  it("returns green:false with a reason when a workflow fails", async () => {
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 60000,
      runner: async () => res(FAIL, 1),
    });
    expect(out.green).toBe(false);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain(".github/workflows/ci.yml");
  });

  it("runs multiple workflows sequentially; any red fails the batch, naming each failure", async () => {
    const streams = [PASS, FAIL];
    let i = 0;
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/a.yml", ".github/workflows/b.yml"],
      timeoutMs: 60000,
      runner: async (_c, args) => {
        const stream = streams[i++] ?? PASS;
        expect(args.join(" ")).toMatch(/\.github\/workflows\//);
        return res(stream, stream === FAIL ? 1 : 0);
      },
    });
    expect(out.green).toBe(false);
    expect(out.reasons.some((r) => r.includes("b.yml"))).toBe(true);
  });

  it("THROWS (infra failure) when a run has no parseable run.finish event", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 60000,
        runner: async () => res("Cannot connect to the Docker daemon\n", 125),
      }),
    ).rejects.toThrow(/agent-ci/i);
  });

  it("THROWS (infra failure) when the runner exceeds timeoutMs", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 20,
        runner: () => new Promise<NativeResult>(() => {}),
      }),
    ).rejects.toThrow(/tim(ed )?out/i);
  });

  it("THROWS (infra failure) when the runner itself rejects (spawn error)", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 60000,
        runner: async () => {
          throw new Error("spawn npx ENOENT");
        },
      }),
    ).rejects.toThrow();
  });

  it("returns green:true (no throw) for an empty workflow list", async () => {
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [],
      timeoutMs: 60000,
      runner: async () => res(PASS),
    });
    expect(out).toEqual({ green: true, reasons: [] });
  });

  // Sev-2.1 fix (codex): the runner must receive `timeoutMs` in its options so the
  // real runNative reaps its child on timeout instead of leaking a running Docker job.
  it("passes timeoutMs through to the runner options (child-kill, no leak)", async () => {
    let seen: NativeOptions | undefined;
    await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 12345,
      runner: async (_c, _args, options) => {
        seen = options;
        return res(PASS);
      },
    });
    expect(seen?.timeoutMs).toBe(12345);
  });
});

// Sev-2.2 fix (codex): fail-closed classification — the LAST terminal event decides,
// and an unrecognized terminal verdict counts as failed (never COMMIT on ambiguity).
describe("parseWorkflowOutcome (fail-closed classification)", () => {
  it("a later 'cancelled' terminal after an earlier 'passed' is FAILED, not passed", () => {
    const stream = [
      JSON.stringify({ type: "run.finish", status: "passed" }),
      JSON.stringify({ type: "run.finish", status: "cancelled" }),
    ].join("\n");
    expect(parseWorkflowOutcome(stream)).toBe("failed");
  });

  it("a single terminal event with an unrecognized status is FAILED (fail-closed)", () => {
    const stream = JSON.stringify({ type: "run.finish", status: "cancelled" });
    expect(parseWorkflowOutcome(stream)).toBe("failed");
  });

  it("no terminal event at all is INFRA", () => {
    expect(parseWorkflowOutcome("Cannot connect to the Docker daemon\n")).toBe("infra");
  });

  it("the last terminal event wins even when it flips fail->pass", () => {
    const stream = [
      JSON.stringify({ type: "run.finish", status: "failed" }),
      JSON.stringify({ type: "run.finish", status: "passed" }),
    ].join("\n");
    expect(parseWorkflowOutcome(stream)).toBe("passed");
  });
});
