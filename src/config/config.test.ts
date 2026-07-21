import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadConfigWithRaw,
  isPlannerExplicitlyConfigured,
  isContractFileConfigured,
  detectRepoRoot,
} from "./config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "adh-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it("applies documented defaults when the file omits keys", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const cfg = await loadConfig(dir);
    expect(cfg.loop.maxAttempts).toBe(3);
    expect(cfg.roles.worker.ladder).toEqual(["opus", "sonnet", "haiku"]);
    expect(cfg.gate.checkCommand).toBe("npm test");
    expect(cfg.allowedBranchPattern).toBe("^autodev/");
    expect(cfg.roles.critic.model).toBe("gpt-5.6-luna");
    expect(cfg.policy.heterogeneity).toBe("warn");
  });

  it("defaults gate.agentCi to disabled when the config omits it", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const cfg = await loadConfig(dir);
    expect(cfg.gate.agentCi).toEqual({ enabled: false, workflows: [], timeoutMs: 600000 });
  });

  it("loads an explicit gate.agentCi block", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(
      join(dir, ".autodev", "config.yaml"),
      "gate:\n  agentCi:\n    enabled: true\n    workflows:\n      - .github/workflows/ci.yml\n    timeoutMs: 120000\n",
    );
    const cfg = await loadConfig(dir);
    expect(cfg.gate.agentCi).toEqual({
      enabled: true,
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 120000,
    });
  });

  it("throws a clear error on an invalid type", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "loop:\n  maxAttempts: not-a-number\n");
    await expect(loadConfig(dir)).rejects.toThrow(/maxAttempts/);
  });

  it("falls back to all-defaults when no config file exists", async () => {
    const cfg = await loadConfig(dir);
    expect(cfg.stateDir).toBe(".autodev");
  });

  it("applies defaults when the config file is empty", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "");
    const cfg = await loadConfig(dir);
    expect(cfg.stateDir).toBe(".autodev");
  });

  it("rejects a config file whose root parses to null", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "null\n");
    await expect(loadConfig(dir)).rejects.toThrow(/\(root\)/);
  });

  it("rejects a config file whose root parses to an array", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "- one\n- two\n");
    await expect(loadConfig(dir)).rejects.toThrow(/\(root\)/);
  });

  it("rejects a legacy flat `worker:` block (must be migrated to roles:) instead of silently ignoring it", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    // Pre-R3 shape: a stale flat `worker:` block. After the hard-cut to `roles:`,
    // the root schema is .strict() so this fails LOUD rather than silently
    // reverting the ladder to the default [opus,sonnet,haiku].
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worker:\n  ladder: [sonnet]\n");
    await expect(loadConfig(dir)).rejects.toThrow(/worker/);
  });

  it("rejects an empty worker ladder at config-load", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "roles:\n  worker:\n    ladder: []\n");
    await expect(loadConfig(dir)).rejects.toThrow(/ladder/);
  });

  it("detectRepoRoot walks up to the nearest marker dir", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(detectRepoRoot(nested, [".git"])).toBe(dir);
  });

  it("defaults worktree.provision to an empty list", async () => {
    const cfg = await loadConfig(dir);
    expect(cfg.worktree.provision).toEqual([]);
  });

  it("accepts a worktree.provision list", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: [vendor, plugins-reference]\n");
    const cfg = await loadConfig(dir);
    expect(cfg.worktree.provision).toEqual(["vendor", "plugins-reference"]);
  });

  it("rejects a worktree.provision entry with a .. segment", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['../escape']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });

  it("rejects an absolute worktree.provision entry", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['/etc']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });

  it("rejects a Windows-style absolute worktree.provision entry regardless of the host platform (finding 3)", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    // YAML single-quoted scalars treat backslash as a literal character.
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['C:\\repo\\vendor']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });

  it("rejects a UNC worktree.provision entry regardless of the host platform (finding 3)", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['\\\\host\\share\\vendor']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });

  it("rejects a nested (multi-segment, forward-slash) worktree.provision entry — deps dirs are always top-level", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['a/b']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });

  it("rejects a nested (multi-segment, backslash) worktree.provision entry regardless of host platform", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    // YAML single-quoted scalars treat backslash as a literal character.
    writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['a\\b']\n");
    await expect(loadConfig(dir)).rejects.toThrow(/provision/);
  });
});

describe("loadConfigWithRaw", () => {
  it("returns the parsed cfg AND the pre-defaults raw YAML object", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const { cfg, raw } = await loadConfigWithRaw(dir);
    expect(cfg.gate.checkCommand).toBe("npm test");
    // raw carries ONLY what the operator wrote (no schema defaults filled in).
    expect(raw).toEqual({ gate: { checkCommand: "npm test" } });
  });

  it("returns raw {} when no config file exists (all-defaults path)", async () => {
    const { cfg, raw } = await loadConfigWithRaw(dir);
    expect(cfg.stateDir).toBe(".autodev");
    expect(raw).toEqual({});
  });

  it("throws (same as loadConfig) on an invalid config", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "loop:\n  maxAttempts: not-a-number\n");
    await expect(loadConfigWithRaw(dir)).rejects.toThrow(/maxAttempts/);
  });
});

describe("isPlannerExplicitlyConfigured", () => {
  it("is true only when roles.planner is present in the raw object", () => {
    expect(isPlannerExplicitlyConfigured({ roles: { planner: { adapter: "codex" } } })).toBe(true);
    expect(isPlannerExplicitlyConfigured({ roles: { planner: {} } })).toBe(true);
  });

  it("is false when roles is absent, roles.planner is absent, or roles is not a mapping", () => {
    expect(isPlannerExplicitlyConfigured({})).toBe(false);
    expect(isPlannerExplicitlyConfigured({ roles: { orchestrator: { adapter: "claude" } } })).toBe(false);
    expect(isPlannerExplicitlyConfigured({ roles: [] as unknown as Record<string, unknown> })).toBe(false);
  });

  it("reflects raw presence end-to-end through loadConfigWithRaw", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "roles:\n  planner:\n    adapter: codex\n    model: o3\n");
    const { raw } = await loadConfigWithRaw(dir);
    expect(isPlannerExplicitlyConfigured(raw)).toBe(true);
  });

  it("is false end-to-end for a config that omits planner", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const { raw } = await loadConfigWithRaw(dir);
    expect(isPlannerExplicitlyConfigured(raw)).toBe(false);
  });
});

describe("isContractFileConfigured", () => {
  // adr/006 Phase 1: the parsed HarnessConfig always defaults contract.invariantsFile
  // to "INVARIANTS.md" / contract.guardsFile to "GUARDS.md" (schema.ts), so only the
  // raw pre-defaults object can tell "operator configured an oracle file" apart from
  // "the schema filled in a default" -- the fail-closed loader rule hinges on this.
  it("is true when contract.invariantsFile is explicitly set in raw", () => {
    expect(
      isContractFileConfigured({ contract: { invariantsFile: "custom/INVARIANTS.md" } }, "invariantsFile"),
    ).toBe(true);
  });

  it("is true when contract.guardsFile is explicitly set in raw", () => {
    expect(isContractFileConfigured({ contract: { guardsFile: "custom/GUARDS.md" } }, "guardsFile")).toBe(true);
  });

  it("is false for a bare {} (no contract block at all)", () => {
    expect(isContractFileConfigured({}, "invariantsFile")).toBe(false);
    expect(isContractFileConfigured({}, "guardsFile")).toBe(false);
  });

  it("is false when contract is present but the specific key is absent", () => {
    expect(isContractFileConfigured({ contract: { guardsFile: "GUARDS.md" } }, "invariantsFile")).toBe(false);
  });

  it("is false when contract is not a plain object (array or scalar)", () => {
    expect(isContractFileConfigured({ contract: [] as unknown as Record<string, unknown> }, "invariantsFile")).toBe(
      false,
    );
    expect(
      isContractFileConfigured({ contract: "INVARIANTS.md" as unknown as Record<string, unknown> }, "invariantsFile"),
    ).toBe(false);
  });

  it("reflects raw presence end-to-end through loadConfigWithRaw", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(
      join(dir, ".autodev", "config.yaml"),
      "contract:\n  invariantsFile: custom/INVARIANTS.md\n",
    );
    const { raw } = await loadConfigWithRaw(dir);
    expect(isContractFileConfigured(raw, "invariantsFile")).toBe(true);
    expect(isContractFileConfigured(raw, "guardsFile")).toBe(false);
  });
});
