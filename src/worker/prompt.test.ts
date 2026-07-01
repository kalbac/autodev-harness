import { describe, it, expect } from "vitest";
import { buildWorkerPrompt } from "./prompt.js";
import { HarnessConfigSchema } from "../config/schema.js";
import type { Task } from "../blackboard/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "s1-t1-example",
    title: "Example task",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: ["src/gate/gate.ts"],
    max_rounds: null,
    file_set: ["src/worker/prompt.ts", "src/worker/prompt.test.ts"],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "# Task\nDo the specific thing described here.",
    path: "queue/active/s1-t1-example.md",
    ...overrides,
  };
}

describe("buildWorkerPrompt", () => {
  it("includes the task id and the full task body", () => {
    const cfg = HarnessConfigSchema.parse({});
    const prompt = buildWorkerPrompt(makeTask(), cfg);
    expect(prompt).toContain("s1-t1-example");
    expect(prompt).toContain("Do the specific thing described here.");
  });

  it("points to GOAL.md and the configured invariants file, generically", () => {
    const cfg = HarnessConfigSchema.parse({});
    const prompt = buildWorkerPrompt(makeTask(), cfg);
    expect(prompt).toContain("GOAL.md");
    expect(prompt).toContain(cfg.contract.invariantsFile);
  });

  it("renders file_set and forbidden_paths values", () => {
    const cfg = HarnessConfigSchema.parse({});
    const task = makeTask();
    const prompt = buildWorkerPrompt(task, cfg);
    for (const f of task.file_set) expect(prompt).toContain(f);
    for (const f of task.forbidden_paths) expect(prompt).toContain(f);
  });

  it("includes a rules block with the key stop-condition and hygiene rules", () => {
    const cfg = HarnessConfigSchema.parse({});
    const prompt = buildWorkerPrompt(makeTask(), cfg);
    expect(prompt).toMatch(/file_set/);
    expect(prompt).toMatch(/forbidden_paths/);
    expect(prompt).toContain("smallest");
    expect(prompt).toContain("TOO_BIG");
    expect(prompt).toContain("NEEDS_GUARD");
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("worker-report");
    expect(prompt).toMatch(/do not.*git commit/i);
    expect(prompt).toMatch(/do not.*git add/i);
    expect(prompt).toContain("git add -N");
    expect(prompt).toMatch(/do not.*run.*gate/i);
    expect(prompt).toMatch(/heartbeat/i);
  });

  it("omits the critic feedback block when no feedback is passed", () => {
    const cfg = HarnessConfigSchema.parse({});
    const prompt = buildWorkerPrompt(makeTask(), cfg);
    expect(prompt).not.toMatch(/critic feedback/i);
  });

  it("includes the critic feedback block only on a retry round", () => {
    const cfg = HarnessConfigSchema.parse({});
    const prompt = buildWorkerPrompt(makeTask(), cfg, "Your fix broke invariant X.");
    expect(prompt).toMatch(/critic feedback/i);
    expect(prompt).toContain("Your fix broke invariant X.");
  });

  it("appends each configured worker.promptHints line", () => {
    const cfg = HarnessConfigSchema.parse({
      worker: { promptHints: ["Prefer the project's semantic code-nav tool over raw grep."] },
    });
    const prompt = buildWorkerPrompt(makeTask(), cfg);
    expect(prompt).toContain("Prefer the project's semantic code-nav tool over raw grep.");
  });
});
