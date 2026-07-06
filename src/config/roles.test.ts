import { describe, it, expect } from "vitest";
import { HarnessConfigSchema } from "./schema.js";
import {
  adapterMeta,
  resolveWorkerExe,
  resolveCriticExe,
  resolveOrchestratorExe,
  heterogeneityWarnings,
  assertKnownAdapters,
  workerIsolationFlags,
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

describe("resolveOrchestratorExe", () => {
  it("resolves to the adapter's default exe when no override is configured", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(resolveOrchestratorExe(cfg)).toBe("claude");
  });

  it("resolves to the configured exe override when present", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { orchestrator: { exe: "custom-orchestrator-exe" } } });
    expect(resolveOrchestratorExe(cfg)).toBe("custom-orchestrator-exe");
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

describe("workerIsolationFlags", () => {
  it("returns [] for the default config (all isolation OFF — byte-identical spawn)", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(workerIsolationFlags(cfg)).toEqual([]);
  });

  it("returns only ['--bare'] for cleanRoom alone", () => {
    const cfg = HarnessConfigSchema.parse({ isolation: { worker: { cleanRoom: true } } });
    expect(workerIsolationFlags(cfg)).toEqual(["--bare"]);
  });

  it("returns only ['--bare'] when cleanRoom is set with mcp+skills (cleanRoom subsumes them)", () => {
    const cfg = HarnessConfigSchema.parse({
      isolation: { worker: { cleanRoom: true, mcp: true, skills: true } },
    });
    expect(workerIsolationFlags(cfg)).toEqual(["--bare"]);
  });

  it("returns ['--strict-mcp-config'] for mcp only", () => {
    const cfg = HarnessConfigSchema.parse({ isolation: { worker: { mcp: true } } });
    expect(workerIsolationFlags(cfg)).toEqual(["--strict-mcp-config"]);
  });

  it("returns ['--disable-slash-commands'] for skills only", () => {
    const cfg = HarnessConfigSchema.parse({ isolation: { worker: { skills: true } } });
    expect(workerIsolationFlags(cfg)).toEqual(["--disable-slash-commands"]);
  });

  it("returns both flags (mcp then skills) when both are set without cleanRoom", () => {
    const cfg = HarnessConfigSchema.parse({ isolation: { worker: { mcp: true, skills: true } } });
    expect(workerIsolationFlags(cfg)).toEqual(["--strict-mcp-config", "--disable-slash-commands"]);
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
