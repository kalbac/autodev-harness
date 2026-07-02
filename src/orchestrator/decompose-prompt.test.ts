import { describe, it, expect } from "vitest";
import { buildDecomposePrompt } from "./decompose-prompt.js";
import type { ReadSnapshot } from "./adapter.js";
import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";

const ALL_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

function makeTask(id: string): Task {
  return {
    id,
    title: "t",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: ["src/x.ts"],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "",
    path: `queue/pending/${id}.md`,
  };
}

function emptySnapshot(): ReadSnapshot {
  return {
    existingIds: [],
    queues: Object.fromEntries(ALL_STATES.map((s) => [s, [] as Task[]] as const)) as Record<QueueState, Task[]>,
  };
}

describe("buildDecomposePrompt", () => {
  it("includes the operator intent verbatim", () => {
    const prompt = buildDecomposePrompt("Add a login page.", emptySnapshot());
    expect(prompt).toContain("Add a login page.");
  });

  it("lists existing ids so the model avoids colliding with them", () => {
    const state = emptySnapshot();
    state.existingIds = ["s1-t1-foo", "s1-t2-bar"];
    const prompt = buildDecomposePrompt("intent", state);
    expect(prompt).toContain("s1-t1-foo");
    expect(prompt).toContain("s1-t2-bar");
  });

  it("shows '(none)' when there are no existing ids", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toContain("(none)");
  });

  it("shows per-queue-state task counts", () => {
    const state = emptySnapshot();
    state.queues.pending = [makeTask("p1"), makeTask("p2")];
    state.queues.active = [makeTask("a1")];
    const prompt = buildDecomposePrompt("intent", state);
    expect(prompt).toContain("pending: 2");
    expect(prompt).toContain("active: 1");
    expect(prompt).toContain("done: 0");
  });

  it("spells out the required TaskSpec fields (id, title, type, file_set)", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toContain("id");
    expect(prompt).toContain("title");
    expect(prompt).toContain("type");
    expect(prompt).toContain("file_set");
    expect(prompt).toMatch(/\[A-Za-z0-9\._-\]/);
  });

  it("instructs the model to respond with ONLY a JSON array, no prose", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toMatch(/ONLY a JSON array/);
    expect(prompt).toContain("smallest");
  });
});
