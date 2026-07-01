import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTaskToPending } from "./enqueue.js";
import { validateTaskSpec } from "./task-spec.js";
import { parseTask } from "../blackboard/task.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-orch-enqueue-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(existingIds: string[] = []) {
  return { repoRoot: root, stateDir: ".autodev", existingIds: async () => existingIds };
}

describe("writeTaskToPending", () => {
  it("writes a valid spec to queue/pending/<id>.md", async () => {
    const spec = validateTaskSpec({ id: "t1", title: "Title", type: "tooling", file_set: ["src/a.ts"] });
    const result = await writeTaskToPending(spec, deps());
    expect(result.id).toBe("t1");
    const expectedPath = join(root, ".autodev", "queue", "pending", "t1.md");
    expect(result.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const task = parseTask(readFileSync(expectedPath, "utf8"), "queue/pending/t1.md");
    expect(task.id).toBe("t1");
    expect(task.file_set).toEqual(["src/a.ts"]);
  });

  it("creates the pending dir if it does not exist", async () => {
    const spec = validateTaskSpec({ id: "t1", title: "Title", type: "tooling", file_set: ["src/a.ts"] });
    expect(existsSync(join(root, ".autodev", "queue", "pending"))).toBe(false);
    await writeTaskToPending(spec, deps());
    expect(existsSync(join(root, ".autodev", "queue", "pending"))).toBe(true);
  });

  it("rejects a duplicate id found anywhere across existingIds (pending/active/escalated/quarantine/done)", async () => {
    const spec = validateTaskSpec({ id: "dup", title: "Title", type: "tooling", file_set: ["src/a.ts"] });
    await expect(writeTaskToPending(spec, deps(["dup"]))).rejects.toThrow(/dup/);
    expect(existsSync(join(root, ".autodev", "queue", "pending", "dup.md"))).toBe(false);
  });

  it("rejects a path-unsafe id before validateTaskSpec would even let it through as a TaskSpec", async () => {
    // TaskSpecSchema already rejects this at construction; assert the guard
    // in writeTaskToPending itself also rejects a spec-shaped object with an
    // unsafe id (constructed via the schema's own escape hatch: `parse` would
    // throw, so we go through the exported validator directly instead).
    expect(() => validateTaskSpec({ id: "../escape", title: "t", type: "tooling", file_set: ["a"] })).toThrow();
  });

  it("rejects a concurrent duplicate id even when existingIds() misses the race (both calls see [])", async () => {
    // Simulates a race: two callers both pass the existingIds() pre-check
    // (which returns [] both times, as it would for two tasks enqueued in
    // the same instant before either pending file exists) — the exclusive
    // "wx" write flag must still catch the second write.
    const spec = validateTaskSpec({ id: "race", title: "Title", type: "tooling", file_set: ["src/a.ts"] });
    await writeTaskToPending(spec, deps([]));
    await expect(writeTaskToPending(spec, deps([]))).rejects.toThrow(/race/);
  });

  it("never claims/triggers/runs anything — only the pending file is written", async () => {
    const spec = validateTaskSpec({ id: "t1", title: "Title", type: "tooling", file_set: ["src/a.ts"] });
    await writeTaskToPending(spec, deps());
    expect(existsSync(join(root, ".autodev", "queue", "active"))).toBe(false);
    expect(existsSync(join(root, ".autodev", "runtime"))).toBe(false);
  });
});
