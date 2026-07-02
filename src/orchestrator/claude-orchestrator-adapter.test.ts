import { describe, it, expect } from "vitest";
import { ClaudeOrchestratorAdapter } from "./claude-orchestrator-adapter.js";
import { HarnessConfigSchema } from "../config/schema.js";
import type { NativeOptions, NativeResult } from "../util/native.js";
import type { ReadSnapshot } from "./adapter.js";
import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";

const ALL_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

function emptySnapshot(): ReadSnapshot {
  return {
    existingIds: [],
    queues: Object.fromEntries(ALL_STATES.map((s) => [s, [] as Task[]] as const)) as Record<QueueState, Task[]>,
  };
}

interface RecordedCall {
  command: string;
  args: string[];
  options?: NativeOptions;
}

/** Scripted fake runner: records every call, replays one result per call. */
class FakeRunner {
  public readonly calls: RecordedCall[] = [];
  private readonly queue: NativeResult[];

  constructor(queue: NativeResult[]) {
    this.queue = [...queue];
  }

  run = async (command: string, args: string[], options?: NativeOptions): Promise<NativeResult> => {
    this.calls.push(options !== undefined ? { command, args, options } : { command, args });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeRunner: no more scripted results");
    }
    return next;
  };
}

function okResult(overrides: Partial<NativeResult> = {}): NativeResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

const validSpecJson = [
  { id: "s1-t1-foo", title: "Foo", type: "tooling", file_set: ["src/a.ts"] },
];

describe("ClaudeOrchestratorAdapter", () => {
  it("spawns claude -p --model <model> with the decompose prompt on stdin", async () => {
    const cfg = HarnessConfigSchema.parse({ roles: { orchestrator: { model: "opus" } } });
    const runner = new FakeRunner([okResult({ stdout: JSON.stringify(validSpecJson) })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    await adapter.decompose({ intent: "Add a login page.", state: emptySnapshot() });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe("claude");
    expect(runner.calls[0]!.args).toEqual(["-p", "--model", "opus"]);
    expect(runner.calls[0]!.options?.stdin).toContain("Add a login page.");
  });

  it("passes cwd: repoRoot to the runner so decompose explores the harness repo, not process.cwd()", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ stdout: JSON.stringify(validSpecJson) })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    await adapter.decompose({ intent: "intent", state: emptySnapshot() });

    expect(runner.calls[0]!.options?.cwd).toBe("/repo/root");
  });

  it("parses a clean JSON array response into validated TaskSpecs", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ stdout: JSON.stringify(validSpecJson) })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    const specs = await adapter.decompose({ intent: "intent", state: emptySnapshot() });

    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("s1-t1-foo");
    expect(specs[0]!.title).toBe("Foo");
  });

  it("tolerantly extracts a JSON array surrounded by prose", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const stdout = `Here is the decomposition:\n${JSON.stringify(validSpecJson)}\nDone.`;
    const runner = new FakeRunner([okResult({ stdout })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    const specs = await adapter.decompose({ intent: "intent", state: emptySnapshot() });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("s1-t1-foo");
  });

  it("throws naming the element index when one array element is malformed", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const bad = [
      { id: "s1-t1-ok", title: "Ok", type: "tooling", file_set: ["src/a.ts"] },
      { id: "s1-t2-bad", title: "", type: "tooling", file_set: ["src/b.ts"] }, // empty title
    ];
    const runner = new FakeRunner([okResult({ stdout: JSON.stringify(bad) })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    await expect(adapter.decompose({ intent: "intent", state: emptySnapshot() })).rejects.toThrow(/element \[1\]/);
  });

  it("throws a clear error when no JSON array is parseable in the output", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ stdout: "I cannot help with that." })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    await expect(adapter.decompose({ intent: "intent", state: emptySnapshot() })).rejects.toThrow(
      /no parseable JSON array/,
    );
  });

  it("throws a clear error when output has a bracket but never yields a parseable top-level array", async () => {
    const cfg = HarnessConfigSchema.parse({});
    // A "[" with no matching "]" (never balances), and a "]" with no
    // preceding "[" — neither yields a valid array candidate.
    const runner = new FakeRunner([okResult({ stdout: "Here's a list [not closed, sorry" })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    await expect(adapter.decompose({ intent: "intent", state: emptySnapshot() })).rejects.toThrow(
      /no parseable JSON array/,
    );
  });

  it("returns an empty array for a valid empty decomposition (a 'no work needed' outcome, NOT an error)", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([okResult({ stdout: "[]" })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    // An empty array is a legitimate "no tasks" decomposition — the adapter
    // returns [] and lets handleIntent's empty-batch skip handle it. Only
    // UNPARSEABLE output is a decomposition failure (covered by another test).
    await expect(adapter.decompose({ intent: "intent", state: emptySnapshot() })).resolves.toEqual([]);
  });

  it("extracts an array even when prose contains a stray bracket before the real JSON array", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const stdout = `Here are tasks [draft]\n${JSON.stringify(validSpecJson)}`;
    const runner = new FakeRunner([okResult({ stdout })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    const specs = await adapter.decompose({ intent: "intent", state: emptySnapshot() });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("s1-t1-foo");
  });

  it("extracts the real array (skipping a stray prose bracket) when a string value inside it also contains brackets", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const specWithBracketInTitle = [
      { id: "s1-t1-foo", title: "fix [x]", type: "tooling", file_set: ["src/a.ts"] },
    ];
    // Combines both hazards: a stray "[draft]" in prose BEFORE the real array
    // (so the scan must reject that candidate and try the next "["), and a
    // bracket pair inside a JSON string value (so bracket-depth tracking
    // must ignore brackets that occur inside quoted strings).
    const stdout = `Here are tasks [draft]\n${JSON.stringify(specWithBracketInTitle)}`;
    const runner = new FakeRunner([okResult({ stdout })]);
    const adapter = new ClaudeOrchestratorAdapter({ cfg, runner: runner.run, repoRoot: "/repo/root" });

    const specs = await adapter.decompose({ intent: "intent", state: emptySnapshot() });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.title).toBe("fix [x]");
  });
});
