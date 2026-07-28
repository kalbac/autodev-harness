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

  it("documents forbidden_paths semantics: no negation/gitignore support, must not overlap file_set", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toContain("forbidden_paths");
    expect(prompt).toMatch(/negation|gitignore/i);
    // file_set guidance must appear right alongside the forbidden_paths
    // overlap warning, not just anywhere else in the prompt.
    expect(prompt).toMatch(/file_set[\s\S]{0,200}already defines/);
  });
});

/**
 * The prompt half of the s61 `success_commands` contract. The code half is
 * `success-command-policy.ts`; a contract split across code and prompt must add
 * BOTH in one change, and pin both -- gotcha
 * `[chat/launch-marker-needs-prompt-contract]`, where a marker the backend
 * detected was never taught to the model and the feature silently never fired.
 */
describe("buildDecomposePrompt — success_commands contract", () => {
  it("tells the model success_commands may only contain commands the PROJECT declares", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toContain("success_commands");
    expect(prompt).toMatch(/package\.json/);
    expect(prompt).toMatch(/declare/i);
  });

  it("tells the model that inventing a command is a defect", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toMatch(/invent/i);
    expect(prompt).toMatch(/DEFECT/i);
  });

  it("tells the model that omitting success_commands entirely is the normal case", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).toMatch(/NORMAL case/i);
    expect(prompt).toMatch(/leave it out/i);
  });

  it("tells the model an undeclared command is dropped", () => {
    expect(buildDecomposePrompt("intent", emptySnapshot())).toMatch(/DROPPED/i);
  });
});

describe("buildDecomposePrompt — retry feedback (#141)", () => {
  const VALIDATION_ERROR =
    "orchestrator decomposition element [0] is invalid: Invalid task spec: (root): Expected object, received string";

  it("omits the rejection section entirely on a first attempt", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot());
    expect(prompt).not.toMatch(/previous attempt was REJECTED/i);
  });

  it("omits the rejection section for an empty failure string", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot(), "   ");
    expect(prompt).not.toMatch(/previous attempt was REJECTED/i);
  });

  it("includes the EXACT previous validation error verbatim", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot(), VALIDATION_ERROR);
    expect(prompt).toContain(VALIDATION_ERROR);
  });

  it("says the attempt was rejected and demands an array of OBJECTS, never bare strings", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot(), VALIDATION_ERROR);
    expect(prompt).toMatch(/previous attempt was REJECTED/i);
    expect(prompt).toMatch(/never bare strings/i);
    expect(prompt).toMatch(/OBJECTS/);
  });

  it("tells the model to fix precisely what was named", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot(), VALIDATION_ERROR);
    expect(prompt).toMatch(/Fix precisely what/i);
  });

  it("keeps the rejection section LAST, after the output-format instruction", () => {
    const prompt = buildDecomposePrompt("intent", emptySnapshot(), VALIDATION_ERROR);
    expect(prompt.indexOf("## Your previous attempt was REJECTED")).toBeGreaterThan(prompt.indexOf("## Output format"));
  });
});
