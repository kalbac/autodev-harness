import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorkerAdapter } from "./fake-adapter.js";
import type { WorkerRunInput } from "./adapter.js";
import type { Task } from "../blackboard/types.js";

function makeInput(runtimeDir: string, overrides: Partial<WorkerRunInput> = {}): WorkerRunInput {
  const task: Task = {
    id: "s1-t1-example",
    title: "Example task",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: ["src/a.ts"],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "body",
    path: "queue/active/s1-t1-example.md",
  };
  return {
    task,
    worktreePath: "/fake/worktree",
    ladder: ["opus", "sonnet", "haiku"],
    runtimeDir,
    ...overrides,
  };
}

let runtimeDir: string;
beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "adh-worker-"));
});
afterEach(() => rmSync(runtimeDir, { recursive: true, force: true }));

describe("FakeWorkerAdapter", () => {
  it("returns the scripted result", async () => {
    const fake = new FakeWorkerAdapter({
      status: "DONE",
      model: "sonnet",
      rateLimited: false,
      timedOut: false,
      exitCode: 0,
    });
    const result = await fake.run(makeInput(runtimeDir));
    expect(result).toEqual({
      status: "DONE",
      model: "sonnet",
      rateLimited: false,
      timedOut: false,
      exitCode: 0,
    });
  });

  it("writes a worker-report.md into runtimeDir when configured with a report body", async () => {
    const fake = new FakeWorkerAdapter(
      { status: "DONE", model: "opus", rateLimited: false, timedOut: false, exitCode: 0 },
      { reportContent: "status: TOO_BIG\nnotes: too much scope\n" },
    );
    await fake.run(makeInput(runtimeDir));
    const reportPath = join(runtimeDir, "worker-report.md");
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain("status: TOO_BIG");
  });

  it("does not write a report when no report content is configured", async () => {
    const fake = new FakeWorkerAdapter({
      status: "RATE_LIMITED",
      model: "opus",
      rateLimited: true,
      timedOut: false,
      exitCode: 0,
    });
    await fake.run(makeInput(runtimeDir));
    expect(existsSync(join(runtimeDir, "worker-report.md"))).toBe(false);
  });
});
