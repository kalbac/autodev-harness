import { describe, it, expect, vi } from "vitest";
import { refreshExecutionReports } from "./report-service.js";

describe("refreshExecutionReports", () => {
  it("writes a report for a run whose tasks are all terminal-or-escalated", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "done",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).toHaveBeenCalledWith("run-1", expect.stringContaining("Harness Execution Report"), expect.any(String));
  });

  it("RE-renders a parked run even when a report already exists", async () => {
    // A parked run can still change: the operator answers, the task requeues and
    // commits. Keeping the report written while it was parked would leave it
    // saying "escalated" forever, contradicting the repository.
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "escalated",
      readEvidence: async () => null,
      reportExists: async () => true,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).toHaveBeenCalled();
  });

  it("reuses an existing report once the run can no longer change", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "done",
      readEvidence: async () => null,
      reportExists: async () => true,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does NOT write while a task is still pending", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "pending",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does NOT write when a task's state cannot be determined", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => null,
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("treats an ESCALATED task as terminal (a parked run still gets its report)", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "escalated",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).toHaveBeenCalled();
  });

  it("does not rewrite a report that already exists", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "done",
      readEvidence: async () => null,
      reportExists: async () => true,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("reports a task with no evidence as absent rather than dropping it (H1)", async () => {
    const write = vi.fn(async (_runId: string, _markdown: string, _json: string) => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1", "t2"] }],
      taskState: async () => "done",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    const json = write.mock.calls[0]?.[2] ?? "{}";
    expect((JSON.parse(json) as { completeness: unknown }).completeness).toEqual({
      total: 2,
      recorded: 0,
      absent: 2,
      unreadable: 0,
    });
  });

  it("never throws when a write fails", async () => {
    await expect(
      refreshExecutionReports({
        listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
        taskState: async () => "done",
        readEvidence: async () => null,
        reportExists: async () => false,
        writeReport: async () => {
          throw new Error("nope");
        },
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});
