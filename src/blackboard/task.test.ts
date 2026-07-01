import { describe, it, expect } from "vitest";
import { parseTask } from "./task.js";

const SAMPLE = `---
id: s7-t1-model-tiering
title: Wire per-task model tiering
type: tooling
touches_contract_zone: false
file_set:
  - src/a.ts
  - src/b.ts
depends_on: []
needs_guard: no
acceptance:
  - "supports optional model field"
---
# Task
Do the thing.
`;

describe("parseTask", () => {
  it("parses scalars, lists, and body", () => {
    const t = parseTask(SAMPLE, "queue/pending/s7-t1.md");
    expect(t.id).toBe("s7-t1-model-tiering");
    expect(t.type).toBe("tooling");
    expect(t.file_set).toEqual(["src/a.ts", "src/b.ts"]);
    expect(t.needs_guard).toBe(false);
    expect(t.body.trim().startsWith("# Task")).toBe(true);
    expect(t.path).toBe("queue/pending/s7-t1.md");
  });

  it("applies StrictMode-safe defaults for omitted keys", () => {
    const t = parseTask("---\nid: x\ntitle: y\ntype: z\n---\nbody", "p");
    expect(t.touches_contract_zone).toBe(false);
    expect(t.model).toBeNull();
    expect(t.success_commands).toEqual([]);
    expect(t.file_set).toEqual([]);
    expect(t.max_rounds).toBeNull();
  });

  it("coerces yes/no to booleans (needs_guard, writes_guard)", () => {
    const t = parseTask("---\nid: x\ntitle: y\ntype: z\nwrites_guard: yes\nneeds_guard: no\n---\n", "p");
    expect(t.writes_guard).toBe(true);
    expect(t.needs_guard).toBe(false);
  });

  it("does not treat a `---` that is not its own line as the closing delimiter", () => {
    const t = parseTask("---\nid: x\n--- this is body\nmore", "p");
    expect(t.id).toBe("");
    expect(t.body).toContain("--- this is body");
  });
});
