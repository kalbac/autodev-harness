import { describe, it, expect } from "vitest";
import { parseTask } from "../blackboard/task.js";
import { isPathSafeId, TaskSpecSchema, serializeTask, validateTaskSpec, type TaskSpec } from "./task-spec.js";

const MINIMAL: TaskSpec = TaskSpecSchema.parse({
  id: "s11-t1-orchestrator-substrate",
  title: "Build orchestrator substrate",
  type: "tooling",
  file_set: ["src/orchestrator/task-spec.ts"],
});

/** Minimal valid spec input — required fields only, overridable for one-off tests. */
function minimalSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "t1", title: "Title", type: "tooling", file_set: ["src/a.ts"], ...overrides };
}

describe("isPathSafeId", () => {
  it.each(["t1\nowned", "a b", "a/b", "..", "a..b"])("rejects %j", (badId) => {
    expect(isPathSafeId(badId)).toBe(false);
  });

  it.each(["t1\rowned", "t1\r\nowned", "a\\b", "a\0b"])("rejects control/separator chars %j", (badId) => {
    expect(isPathSafeId(badId)).toBe(false);
  });

  it("accepts a realistic task id", () => {
    expect(isPathSafeId("s7-t1-conductor_model.v2")).toBe(true);
  });
});

describe("validateTaskSpec", () => {
  it("accepts a minimal spec and applies parseTask-matching defaults", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "Title",
      type: "tooling",
      file_set: ["src/a.ts"],
    });
    expect(spec.touches_contract_zone).toBe(false);
    expect(spec.writes_guard).toBe(false);
    expect(spec.model).toBeNull();
    expect(spec.success_commands).toEqual([]);
    expect(spec.forbidden_paths).toEqual([]);
    expect(spec.max_rounds).toBeNull();
    expect(spec.depends_on).toEqual([]);
    expect(spec.contract_zones_touched).toEqual([]);
    expect(spec.needs_guard).toBe(false);
    expect(spec.acceptance).toEqual([]);
    expect(spec.phase).toBeUndefined();
    expect(spec.body).toBe("");
  });

  it("accepts a fully-populated spec", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "Title",
      type: "tooling",
      file_set: ["src/a.ts", "src/b.ts"],
      touches_contract_zone: true,
      writes_guard: true,
      model: "sonnet",
      success_commands: ["npm test"],
      forbidden_paths: ["src/index.ts"],
      max_rounds: 3,
      depends_on: ["t0"],
      contract_zones_touched: ["zone-a"],
      needs_guard: true,
      acceptance: ["does the thing"],
      phase: "p1",
      body: "# Task\nDo the thing.\n",
    });
    expect(spec.model).toBe("sonnet");
    expect(spec.max_rounds).toBe(3);
    expect(spec.phase).toBe("p1");
  });

  it("rejects a spec missing id", () => {
    expect(() => validateTaskSpec({ title: "t", type: "tooling", file_set: ["a"] })).toThrow(/id/);
  });

  it("rejects a spec missing title", () => {
    expect(() => validateTaskSpec({ id: "t1", type: "tooling", file_set: ["a"] })).toThrow(/title/);
  });

  it("rejects a spec missing type", () => {
    expect(() => validateTaskSpec({ id: "t1", title: "t", file_set: ["a"] })).toThrow(/type/);
  });

  it("rejects an empty file_set", () => {
    expect(() => validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: [] })).toThrow(/file_set/);
  });

  it("rejects a missing file_set", () => {
    expect(() => validateTaskSpec({ id: "t1", title: "t", type: "tooling" })).toThrow(/file_set/);
  });

  it.each(["../escape", "a/b", "a\\b", ""])("rejects a path-unsafe id %j", (badId) => {
    expect(() => validateTaskSpec({ id: badId, title: "t", type: "tooling", file_set: ["a"] })).toThrow();
  });

  it.each([-1, 1.5, NaN])("rejects a non-nonnegative-integer max_rounds %j", (bad) => {
    expect(() =>
      validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: ["a"], max_rounds: bad }),
    ).toThrow(/max_rounds/);
  });

  it.each([0, 3])("accepts an integer max_rounds %j", (good) => {
    const spec = validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: ["a"], max_rounds: good });
    expect(spec.max_rounds).toBe(good);
  });

  it("accepts a null max_rounds", () => {
    const spec = validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: ["a"], max_rounds: null });
    expect(spec.max_rounds).toBeNull();
  });

  it("accepts an omitted max_rounds (defaults to null)", () => {
    const spec = validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: ["a"] });
    expect(spec.max_rounds).toBeNull();
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() =>
      validateTaskSpec({ id: "t1", title: "t", type: "tooling", file_set: ["a"], bogus: "nope" }),
    ).toThrow(/bogus/);
  });

  it("error message lists multiple offending paths", () => {
    try {
      validateTaskSpec({ file_set: [] });
      throw new Error("expected validateTaskSpec to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/id/);
      expect(msg).toMatch(/title/);
      expect(msg).toMatch(/type/);
      expect(msg).toMatch(/file_set/);
    }
  });
});

describe("forbidden_paths / file_set overlap (cross-field trust-boundary check)", () => {
  it("rejects the real-world negation case: a forbidden_paths glob matches a required file_set entry", () => {
    // The exact spec an LLM emitted in a live run: `!`-negation is NOT
    // supported by the harness glob matcher, so the wildcard glob matches the
    // very file the task is required to touch — an impossible spec.
    expect(() =>
      validateTaskSpec(
        minimalSpec({
          file_set: ["server/app/Services/Llm/LlmServiceFactory.php"],
          forbidden_paths: ["server/app/Services/Llm/*", "!server/app/Services/Llm/LlmServiceFactory.php"],
        }),
      ),
    ).toThrow(/forbidden_paths/);
  });

  it("rejects an exact-equal overlap between file_set and forbidden_paths", () => {
    expect(() =>
      validateTaskSpec(minimalSpec({ file_set: ["src/a.ts"], forbidden_paths: ["src/a.ts"] })),
    ).toThrow(/forbidden_paths/);
  });

  it("accepts a non-overlapping file_set / forbidden_paths pair", () => {
    expect(() =>
      validateTaskSpec(minimalSpec({ file_set: ["src/a.ts"], forbidden_paths: ["src/generated/**"] })),
    ).not.toThrow();
  });

  it("accepts an empty forbidden_paths (regression)", () => {
    expect(() => validateTaskSpec(minimalSpec({ forbidden_paths: [] }))).not.toThrow();
  });

  it("accepts an omitted forbidden_paths (regression)", () => {
    expect(() => validateTaskSpec(minimalSpec())).not.toThrow();
  });
});

describe("serializeTask / parseTask round trip", () => {
  it("round-trips a minimal spec", () => {
    const serialized = serializeTask(MINIMAL);
    const task = parseTask(serialized, "queue/pending/x.md");
    expect(task.id).toBe(MINIMAL.id);
    expect(task.title).toBe(MINIMAL.title);
    expect(task.type).toBe(MINIMAL.type);
    expect(task.file_set).toEqual(MINIMAL.file_set);
    expect(task.touches_contract_zone).toBe(false);
    expect(task.writes_guard).toBe(false);
    expect(task.model).toBeNull();
    expect(task.success_commands).toEqual([]);
    expect(task.forbidden_paths).toEqual([]);
    expect(task.max_rounds).toBeNull();
    expect(task.depends_on).toEqual([]);
    expect(task.contract_zones_touched).toEqual([]);
    expect(task.needs_guard).toBe(false);
    expect(task.acceptance).toEqual([]);
    expect(task.phase).toBeUndefined();
    expect(task.body).toBe("");
  });

  it("round-trips a fully-populated spec, including phase and a non-null model/max_rounds", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "Title with: a colon",
      type: "tooling",
      file_set: ["src/a.ts", "src/b.ts"],
      touches_contract_zone: true,
      writes_guard: true,
      model: "sonnet",
      success_commands: ["npm test", "npm run typecheck"],
      forbidden_paths: ["src/index.ts"],
      max_rounds: 3,
      depends_on: ["t0"],
      contract_zones_touched: ["zone-a"],
      needs_guard: true,
      acceptance: ["does the thing"],
      phase: "p1",
      body: "# Task\nDo the thing.\n\nMultiple lines.\n",
    });
    const task = parseTask(serializeTask(spec), "queue/pending/t1.md");
    expect(task.id).toBe(spec.id);
    expect(task.title).toBe(spec.title);
    expect(task.type).toBe(spec.type);
    expect(task.touches_contract_zone).toBe(true);
    expect(task.writes_guard).toBe(true);
    expect(task.model).toBe("sonnet");
    expect(task.success_commands).toEqual(["npm test", "npm run typecheck"]);
    expect(task.forbidden_paths).toEqual(["src/index.ts"]);
    expect(task.max_rounds).toBe(3);
    expect(task.file_set).toEqual(["src/a.ts", "src/b.ts"]);
    expect(task.depends_on).toEqual(["t0"]);
    expect(task.contract_zones_touched).toEqual(["zone-a"]);
    expect(task.needs_guard).toBe(true);
    expect(task.acceptance).toEqual(["does the thing"]);
    expect(task.phase).toBe("p1");
    expect(task.body).toBe(spec.body);
  });

  it("omits the phase key entirely when unset (matches parseTask's absent-key behavior)", () => {
    const serialized = serializeTask(MINIMAL);
    expect(serialized).not.toMatch(/^phase:/m);
  });

  it("produces a frontmatter fence parseTask recognizes", () => {
    const serialized = serializeTask(MINIMAL);
    expect(serialized.startsWith("---\n")).toBe(true);
    expect(serialized).toMatch(/\n---\n/);
  });

  it("round-trips a title containing a literal '---' line without corrupting the frontmatter fence", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "before\n---\nafter",
      type: "tooling",
      file_set: ["src/a.ts"],
    });
    const serialized = serializeTask(spec);
    const task = parseTask(serialized, "queue/pending/t1.md");
    expect(task.title).toBe(spec.title);
  });

  it("round-trips an acceptance entry containing '---'", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "Title",
      type: "tooling",
      file_set: ["src/a.ts"],
      acceptance: ["line one", "---", "line three"],
    });
    const serialized = serializeTask(spec);
    const task = parseTask(serialized, "queue/pending/t1.md");
    expect(task.acceptance).toEqual(spec.acceptance);
  });

  it("round-trips a body containing a line that is exactly '---'", () => {
    const spec = validateTaskSpec({
      id: "t1",
      title: "Title",
      type: "tooling",
      file_set: ["src/a.ts"],
      body: "before\n---\nafter\n",
    });
    const serialized = serializeTask(spec);
    const task = parseTask(serialized, "queue/pending/t1.md");
    expect(task.body).toBe(spec.body);
  });
});
