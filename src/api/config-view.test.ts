import { describe, it, expect } from "vitest";
import { HarnessConfigSchema } from "../config/schema.js";
import { buildProjectConfigView } from "./config-view.js";

/** Pure projection: HarnessConfig (+ a raw planner-presence flag) -> ProjectConfigView.
 *  The parsed config ALWAYS carries a defaulted roles.planner, so the caller must
 *  pass the RAW-config presence signal separately (R1). */
describe("buildProjectConfigView", () => {
  it("omits planner when it was NOT explicitly configured (plannerConfigured=false)", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectConfigView(cfg, false);
    expect(Object.prototype.hasOwnProperty.call(view.roles, "planner")).toBe(false);
  });

  it("includes planner (adapter+model) when explicitly configured; VALUES come from the parsed cfg", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { planner: { adapter: "codex", model: "o3", effort: "high" } } });
    const view = buildProjectConfigView(cfg, true);
    expect(view.roles.planner).toEqual({ adapter: "codex", model: "o3", effort: "high" });
  });

  it("omits planner.effort (conditional spread) when the parsed planner has no effort", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { planner: { adapter: "codex", model: "o3" } } });
    const view = buildProjectConfigView(cfg, true);
    expect(view.roles.planner).toEqual({ adapter: "codex", model: "o3" });
    expect(Object.prototype.hasOwnProperty.call(view.roles.planner ?? {}, "effort")).toBe(false);
  });

  it("projects the defaulted planner (claude/sonnet) when the operator set roles.planner: {}", () => {
    // agentRoleSchema applies its defaults; the presence flag (not the values) is
    // what distinguishes an explicit-but-empty planner from an absent one.
    const cfg = HarnessConfigSchema.parse({ roles: { planner: {} } });
    const view = buildProjectConfigView(cfg, true);
    expect(view.roles.planner).toEqual({ adapter: "claude", model: "sonnet" });
  });

  it("still conditionally omits an absent orchestrator effort (regression parity with planner)", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectConfigView(cfg, false);
    expect(Object.prototype.hasOwnProperty.call(view.roles.orchestrator, "effort")).toBe(false);
  });

  it("exposes policy.heterogeneity from the config (default 'warn')", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(buildProjectConfigView(cfg, false).policy).toEqual({ heterogeneity: "warn" });
  });

  it("exposes policy.heterogeneity 'off' when configured", () => {
    const cfg = HarnessConfigSchema.parse({ policy: { heterogeneity: "off" } });
    expect(buildProjectConfigView(cfg, false).policy).toEqual({ heterogeneity: "off" });
  });

  it("surfaces a heterogeneity warning when worker+critic share a family and policy is 'warn'", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { critic: { adapter: "claude" } } });
    const view = buildProjectConfigView(cfg, false);
    expect(view.heterogeneityWarnings).toHaveLength(1);
    expect(view.heterogeneityWarnings[0]).toMatch(/same adapter family 'claude'/);
  });

  it("surfaces NO warning for same-family worker+critic when policy is 'off'", () => {
    const cfg = HarnessConfigSchema.parse({
      roles: { critic: { adapter: "claude" } },
      policy: { heterogeneity: "off" },
    });
    expect(buildProjectConfigView(cfg, false).heterogeneityWarnings).toEqual([]);
  });

  it("surfaces NO warning for different worker/critic families (default claude/codex)", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(buildProjectConfigView(cfg, false).heterogeneityWarnings).toEqual([]);
  });

  it("projects worker isolation as all-false for the default (inherit-everything) config", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectConfigView(cfg, false);
    expect(view.isolation).toEqual({ worker: { cleanRoom: false, mcp: false, skills: false } });
  });

  it("projects a non-default worker isolation config verbatim", () => {
    const cfg = HarnessConfigSchema.parse({ isolation: { worker: { cleanRoom: true, mcp: true } } });
    const view = buildProjectConfigView(cfg, false);
    expect(view.isolation).toEqual({ worker: { cleanRoom: true, mcp: true, skills: false } });
  });

  it("faithfully projects the base roles/gate/worktree slice", () => {
    const cfg = HarnessConfigSchema.parse({
      gate: { checkCommand: "npm test" },
      worktree: { provision: ["vendor"] },
      roles: { worker: { ladder: ["sonnet"] } },
    });
    const view = buildProjectConfigView(cfg, false);
    expect(view.gate).toEqual({ checkCommand: "npm test", agentCi: { enabled: false } });
    expect(view.worktree).toEqual({ provision: ["vendor"] });
    expect(view.roles.worker).toEqual({ adapter: "claude", ladder: ["sonnet"] });
    expect(view.roles.critic).toEqual({ adapter: "codex", model: "gpt-5.6-luna", effort: "high" });
  });
});
