import { describe, it, expect } from "vitest";
import { HarnessConfigSchema } from "./schema.js";
import {
  adapterMeta,
  resolveWorkerExe,
  resolveCriticExe,
  heterogeneityWarnings,
  assertKnownAdapters,
} from "./roles.js";

describe("adapterMeta", () => {
  it("returns the known metadata for 'claude'", () => {
    expect(adapterMeta("claude")).toEqual({ defaultExe: "claude", family: "claude" });
  });

  it("returns the known metadata for 'codex'", () => {
    expect(adapterMeta("codex")).toEqual({ defaultExe: "codex", family: "codex" });
  });

  it("falls back to the id itself as both exe and family for an unknown adapter", () => {
    expect(adapterMeta("some-novel-adapter")).toEqual({
      defaultExe: "some-novel-adapter",
      family: "some-novel-adapter",
    });
  });
});

describe("resolveWorkerExe", () => {
  it("resolves to the adapter's default exe when no override is configured", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(resolveWorkerExe(cfg)).toBe("claude");
  });

  it("resolves to the configured exe override when present", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { worker: { exe: "custom-claude-exe" } } });
    expect(resolveWorkerExe(cfg)).toBe("custom-claude-exe");
  });
});

describe("resolveCriticExe", () => {
  it("resolves to the adapter's default exe when no override is configured", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(resolveCriticExe(cfg)).toBe("codex");
  });

  it("resolves to the configured exe override when present", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { critic: { exe: "custom-codex-exe" } } });
    expect(resolveCriticExe(cfg)).toBe("custom-codex-exe");
  });
});

describe("heterogeneityWarnings", () => {
  it("warns when worker and critic share the same adapter family", () => {
    const cfg = HarnessConfigSchema.parse({
      roles: { worker: { adapter: "claude" }, critic: { adapter: "claude" } },
    });
    const warnings = heterogeneityWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/same adapter family 'claude'/);
  });

  it("is silent when worker and critic use different adapter families (default claude/codex)", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(heterogeneityWarnings(cfg)).toEqual([]);
  });

  it("is silent when policy.heterogeneity is 'off', even with matching families", () => {
    const cfg = HarnessConfigSchema.parse({
      roles: { worker: { adapter: "claude" }, critic: { adapter: "claude" } },
      policy: { heterogeneity: "off" },
    });
    expect(heterogeneityWarnings(cfg)).toEqual([]);
  });
});

describe("assertKnownAdapters", () => {
  it("passes for the default claude/codex configuration", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(() => assertKnownAdapters(cfg)).not.toThrow();
  });

  it("throws on an unregistered worker adapter", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { worker: { adapter: "unknown-worker" } } });
    expect(() => assertKnownAdapters(cfg)).toThrow(/no worker adapter registered for 'unknown-worker'/);
  });

  it("throws on an unregistered critic adapter", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { critic: { adapter: "unknown-critic" } } });
    expect(() => assertKnownAdapters(cfg)).toThrow(/no critic adapter registered for 'unknown-critic'/);
  });
});
