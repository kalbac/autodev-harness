import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ClaudeWorkerAdapter } from "./claude-adapter.js";
import { buildWorkerPrompt } from "./prompt.js";
import { HarnessConfigSchema } from "../config/schema.js";
import { resolveWorkerExe } from "../config/roles.js";
import type { Task } from "../blackboard/types.js";
import type { WatchedProcessRunner, WatchedRunInput, WatchedRunResult } from "../watchdog/runner.js";
import { runNative } from "../util/native.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: [],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "# Task\nDo the thing.",
    path: "p",
    ...overrides,
  };
}

function okResult(overrides: Partial<WatchedRunResult> = {}): WatchedRunResult {
  return { exitCode: 0, timedOut: false, rateLimited: false, stdout: "", stderr: "", ...overrides };
}

/** Scripted fake runner: replays one result per call, in order, and records every input. */
class FakeRunner implements WatchedProcessRunner {
  public readonly calls: WatchedRunInput[] = [];
  private readonly queue: WatchedRunResult[];

  constructor(queue: WatchedRunResult[]) {
    this.queue = [...queue];
  }

  run(input: WatchedRunInput): Promise<WatchedRunResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeRunner: no more scripted results");
    }
    return Promise.resolve(next);
  }
}

describe("ClaudeWorkerAdapter", () => {
  it("returns DONE on the first ladder step", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ exitCode: 0 })]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask();

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus"],
      runtimeDir: "/rt",
    });

    expect(result).toEqual({ status: "DONE", model: "opus", exitCode: 0, rateLimited: false, timedOut: false });
    expect(runner.calls).toHaveLength(1);
  });

  it("constructs the command exactly as the parity spec pins", async () => {
    // Non-default worker config so this proves the adapter FORWARDS config
    // values rather than coincidentally matching the schema defaults.
    const cfg = HarnessConfigSchema.parse({
      roles: { worker: { exe: "claude-cli", maxTurns: 42, staleMinutes: 7, timeoutMinutes: 11 } },
    });
    expect(resolveWorkerExe(cfg)).not.toBe(resolveWorkerExe(HarnessConfigSchema.parse({})));
    const runner = new FakeRunner([okResult()]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask();

    await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus"],
      runtimeDir: "/rt",
    });

    const call = runner.calls[0]!;
    expect(call.command).toBe(resolveWorkerExe(cfg));
    expect(call.args).toEqual([
      "-p",
      "--model",
      "opus",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      String(cfg.roles.worker.maxTurns),
      "--verbose",
      "--output-format",
      "stream-json",
    ]);
    expect(call.stdin).toBe(buildWorkerPrompt(task, cfg));
    expect(call.cwd).toBe("/wt");
    expect(call.heartbeatPath).toBe(join("/rt", "heartbeat"));
    expect(call.activityPaths).toEqual(["/rt"]);
    expect(call.staleSeconds).toBe(cfg.roles.worker.staleMinutes * 60);
    expect(call.timeoutSeconds).toBe(cfg.roles.worker.timeoutMinutes * 60);
  });

  it("excludes isolation flags for a default cfg and appends --bare for a cleanRoom cfg", async () => {
    // Default cfg: isolation all-OFF → no isolation flags in the arg array.
    const defCfg = HarnessConfigSchema.parse({});
    const defRunner = new FakeRunner([okResult()]);
    await new ClaudeWorkerAdapter({ runner: defRunner, cfg: defCfg }).run({
      task: makeTask(),
      worktreePath: "/wt",
      ladder: ["opus"],
      runtimeDir: "/rt",
    });
    const defArgs = defRunner.calls[0]!.args;
    expect(defArgs).not.toContain("--bare");
    expect(defArgs).not.toContain("--strict-mcp-config");
    expect(defArgs).not.toContain("--disable-slash-commands");

    // cleanRoom cfg: --bare appended after --output-format stream-json.
    const isoCfg = HarnessConfigSchema.parse({ isolation: { worker: { cleanRoom: true } } });
    const isoRunner = new FakeRunner([okResult()]);
    await new ClaudeWorkerAdapter({ runner: isoRunner, cfg: isoCfg }).run({
      task: makeTask(),
      worktreePath: "/wt",
      ladder: ["opus"],
      runtimeDir: "/rt",
    });
    const isoArgs = isoRunner.calls[0]!.args;
    expect(isoArgs).toContain("--bare");
    expect(isoArgs.slice(-3)).toEqual(["--output-format", "stream-json", "--bare"]);
  });

  it("steps down to the next (cheaper) ladder entry on a non-contract rate limit", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ rateLimited: true, exitCode: 1 }),
      okResult({ exitCode: 0 }),
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask({ touches_contract_zone: false });

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["sonnet", "haiku"],
      runtimeDir: "/rt",
    });

    expect(result.status).toBe("DONE");
    expect(result.model).toBe("haiku");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.args).toContain("haiku");
  });

  it("PAUSEs immediately on a contract-zone rate limit — never steps down", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ rateLimited: true, exitCode: 1 }),
      okResult({ exitCode: 0 }), // would prove a step-down happened if ever consumed
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask({ touches_contract_zone: true });

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus", "sonnet"],
      runtimeDir: "/rt",
    });

    expect(result).toEqual({ status: "RATE_LIMITED", model: "opus", exitCode: 1, rateLimited: true, timedOut: false });
    expect(runner.calls).toHaveLength(1);
  });

  it("breaks immediately on a timeout — no further ladder steps", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ timedOut: true, exitCode: 1 }),
      okResult({ exitCode: 0 }),
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask();

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus", "sonnet"],
      runtimeDir: "/rt",
    });

    expect(result).toEqual({ status: "TIMED_OUT", model: "opus", exitCode: 1, rateLimited: false, timedOut: true });
    expect(runner.calls).toHaveLength(1);
  });

  // §6 pins the priority order EXACTLY: rate-limit is evaluated before
  // timeout. These two cases set BOTH flags on the same step so a wrong impl
  // that checked `timedOut` first would fail (single-flag tests could not
  // catch that reordering).
  it("prioritizes rate-limit over timeout on a contract-zone step (PAUSE, no step-down)", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ rateLimited: true, timedOut: true, exitCode: 1 }),
      okResult({ exitCode: 0 }), // must never be consumed
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask({ touches_contract_zone: true });

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus", "sonnet"],
      runtimeDir: "/rt",
    });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.model).toBe("opus");
    expect(runner.calls).toHaveLength(1);
  });

  it("prioritizes rate-limit over timeout on a non-contract step (steps down, not TIMED_OUT)", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ rateLimited: true, timedOut: true, exitCode: 1 }),
      okResult({ exitCode: 0 }),
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask({ touches_contract_zone: false });

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["sonnet", "haiku"],
      runtimeDir: "/rt",
    });

    expect(result.status).toBe("DONE");
    expect(result.model).toBe("haiku");
    expect(runner.calls).toHaveLength(2);
  });

  it("returns RATE_LIMITED with the last model when every ladder step (non-contract) is rate-limited", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      okResult({ rateLimited: true, exitCode: 1 }),
      okResult({ rateLimited: true, exitCode: 1 }),
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask({ touches_contract_zone: false });

    const result = await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["sonnet", "haiku"],
      runtimeDir: "/rt",
    });

    expect(result).toEqual({ status: "RATE_LIMITED", model: "haiku", exitCode: 1, rateLimited: true, timedOut: false });
    expect(runner.calls).toHaveLength(2);
  });

  it("forwards criticFeedback into the built prompt", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult()]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask();
    const feedback = "Your fix broke invariant X.";

    await adapter.run({
      task,
      worktreePath: "/wt",
      ladder: ["opus"],
      runtimeDir: "/rt",
      criticFeedback: feedback,
    });

    expect(runner.calls[0]!.stdin).toBe(buildWorkerPrompt(task, cfg, feedback));
  });

  it("attaches parsed usage (with the ladder model) when stdout carries a stream-json result event", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const resultEvent = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.042,
      usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56, cache_creation_input_tokens: 7 },
    });
    const runner = new FakeRunner([
      okResult({ exitCode: 0, stdout: `${JSON.stringify({ type: "system" })}\n${resultEvent}\n` }),
    ]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });

    const result = await adapter.run({ task: makeTask(), worktreePath: "/wt", ladder: ["sonnet"], runtimeDir: "/rt" });

    expect(result.usage).toEqual({
      model: "sonnet",
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 56,
      cache_creation_input_tokens: 7,
    });
  });

  it("omits the usage key entirely when stdout carries no parseable usage event", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ exitCode: 0, stdout: "no json here" })]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });

    const result = await adapter.run({ task: makeTask(), worktreePath: "/wt", ladder: ["opus"], runtimeDir: "/rt" });

    expect("usage" in result).toBe(false);
  });

  it("throws a clear error when the ladder is empty", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([]);
    const adapter = new ClaudeWorkerAdapter({ runner, cfg });
    const task = makeTask();

    await expect(
      adapter.run({ task, worktreePath: "/wt", ladder: [], runtimeDir: "/rt" }),
    ).rejects.toThrow("ClaudeWorkerAdapter: ladder must be non-empty");
    expect(runner.calls).toHaveLength(0);
  });

  // Live integration path is behind ADH_LIVE=1 and is not part of default CI.
  // The real watchdog lands in Task 20; this uses a thin stand-in runner
  // built on runNative (no heartbeat/staleness enforcement) purely to prove
  // the adapter can drive a real `claude -p` process end-to-end when asked.
  const liveIt = process.env.ADH_LIVE === "1" ? it : it.skip;
  liveIt("live: runs a real claude -p process (ADH_LIVE=1 only)", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const thinRunner: WatchedProcessRunner = {
      async run(input) {
        const res = await runNative(input.command, input.args, { cwd: input.cwd, stdin: input.stdin });
        return { exitCode: res.exitCode, timedOut: false, rateLimited: false, stdout: res.stdout, stderr: res.stderr };
      },
    };
    const adapter = new ClaudeWorkerAdapter({ runner: thinRunner, cfg });
    const task = makeTask({ file_set: ["README.md"] });

    const result = await adapter.run({
      task,
      worktreePath: process.cwd(),
      ladder: ["haiku"],
      runtimeDir: process.cwd(),
    });

    expect(["DONE", "RATE_LIMITED", "TIMED_OUT"]).toContain(result.status);
  });
});
