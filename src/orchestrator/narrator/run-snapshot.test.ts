import { describe, it, expect } from "vitest";
import { buildRunSnapshot } from "./run-snapshot.js";

describe("buildRunSnapshot", () => {
  it("assembles a snapshot from the manifest + per-task status", async () => {
    const reader = {
      readRunManifest: async (_r: string) => ({ taskIds: ["t1", "t2"] }),
      readTaskStatus: async (id: string) =>
        id === "t1"
          ? { status: "active" as const, title: "Build A" }
          : { status: "pending" as const, title: "Build B" },
    };
    const snap = await buildRunSnapshot(reader, "run-1");
    expect(snap).toEqual({
      runId: "run-1",
      tasks: [
        { taskId: "t1", status: "active", title: "Build A" },
        { taskId: "t2", status: "pending", title: "Build B" },
      ],
    });
  });

  it("returns null when the manifest is missing", async () => {
    const reader = { readRunManifest: async () => null, readTaskStatus: async () => null };
    expect(await buildRunSnapshot(reader, "run-x")).toBeNull();
  });

  it("skips a task that cannot be resolved (partial run still narrates)", async () => {
    const reader = {
      readRunManifest: async () => ({ taskIds: ["t1", "gone"] }),
      readTaskStatus: async (id: string) => (id === "t1" ? { status: "done" as const, title: "A" } : null),
    };
    const snap = await buildRunSnapshot(reader, "run-1");
    expect(snap!.tasks.map((t) => t.taskId)).toEqual(["t1"]);
  });
});
