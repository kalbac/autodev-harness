import { describe, it, expect } from "vitest";
import { createRouter } from "./router.js";
import { HarnessConfigSchema } from "../config/schema.js";
import type { Task } from "../blackboard/types.js";

const cfg = HarnessConfigSchema.parse({});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: [],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "",
    path: "p",
    ...overrides,
  };
}

describe("createRouter().resolveLadder", () => {
  it("pins contract-zone tasks to the top tier regardless of declared model, and warns on the downgrade", () => {
    const router = createRouter(cfg);
    const task = makeTask({ touches_contract_zone: true, model: "haiku" });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["opus"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/contract-zone/i);
    expect(warnings[0]).toMatch(/haiku/);
    expect(warnings[0]).toMatch(/opus/);
  });

  it("does not warn when a contract-zone task declares the top tier itself", () => {
    const router = createRouter(cfg);
    const task = makeTask({ touches_contract_zone: true, model: "opus" });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["opus"]);
    expect(warnings).toEqual([]);
  });

  it("uses a cheaper-only sub-ladder starting at the declared model (sonnet)", () => {
    const router = createRouter(cfg);
    const task = makeTask({ model: "sonnet" });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["sonnet", "haiku"]);
    expect(warnings).toEqual([]);
  });

  it("uses a single-entry sub-ladder when the declared model is the cheapest tier (haiku)", () => {
    const router = createRouter(cfg);
    const task = makeTask({ model: "haiku" });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["haiku"]);
    expect(warnings).toEqual([]);
  });

  it("uses the full ladder when no model is declared", () => {
    const router = createRouter(cfg);
    const task = makeTask({ model: null });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["opus", "sonnet", "haiku"]);
    expect(warnings).toEqual([]);
  });

  it("falls back to the full ladder and warns when the declared model is not in the ladder", () => {
    const router = createRouter(cfg);
    const task = makeTask({ model: "bogus" });
    const { ladder, warnings } = router.resolveLadder(task);
    expect(ladder).toEqual(["opus", "sonnet", "haiku"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/bogus/);
    expect(warnings[0]).toMatch(/not in ladder/i);
  });

  it("returns a fresh array each call rather than aliasing cfg.worker.ladder", () => {
    const router = createRouter(cfg);
    const { ladder } = router.resolveLadder(makeTask({ model: null }));
    ladder.push("mutated");
    expect(cfg.worker.ladder).toEqual(["opus", "sonnet", "haiku"]);
  });
});
