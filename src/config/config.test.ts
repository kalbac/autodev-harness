import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, detectRepoRoot } from "./config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "adh-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it("applies documented defaults when the file omits keys", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const cfg = await loadConfig(dir);
    expect(cfg.loop.maxAttempts).toBe(3);
    expect(cfg.worker.ladder).toEqual(["opus", "sonnet", "haiku"]);
    expect(cfg.gate.checkCommand).toBe("npm test");
    expect(cfg.allowedBranchPattern).toBe("^autodev/");
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

  it("detectRepoRoot walks up to the nearest marker dir", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(detectRepoRoot(nested, [".git"])).toBe(dir);
  });
});
