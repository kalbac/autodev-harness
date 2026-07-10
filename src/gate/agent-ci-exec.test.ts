import { describe, it, expect } from "vitest";
import {
  winToWslPath,
  buildAgentCiCommand,
  detectAgentCiCapability,
  AgentCiUnavailableError,
} from "./agent-ci-exec.js";

describe("winToWslPath", () => {
  it("maps a drive path to /mnt/<drive> with lowercased drive + forward slashes", () => {
    expect(winToWslPath("D:\\a\\b c")).toBe("/mnt/d/a/b c");
  });
  it("returns null for a UNC path (no drive letter)", () => {
    expect(winToWslPath("\\\\server\\share\\x")).toBeNull();
  });
  it("returns null for a path with no drive letter", () => {
    expect(winToWslPath("relative\\path")).toBeNull();
  });
});

describe("buildAgentCiCommand", () => {
  it("native: npx @redwoodjs/agent-ci run --workflow <wf> --json", () => {
    const { command, args } = buildAgentCiCommand("native", { cwd: "/repo", workflow: "ci.yml" });
    expect(command).toBe("npx");
    expect(args).toEqual(["@redwoodjs/agent-ci", "run", "--workflow", "ci.yml", "--json"]);
  });
  it("wsl: wsl.exe -e bash -lc with a cd into the posix cwd + single-quote-escaped workflow", () => {
    const { command, args } = buildAgentCiCommand("wsl", { cwd: "/mnt/d/a", workflow: "ci.yml" });
    expect(command).toBe("wsl.exe");
    expect(args[0]).toBe("-e");
    expect(args[1]).toBe("bash");
    expect(args[2]).toBe("-lc");
    expect(args[3]).toBe("cd '/mnt/d/a' && npx @redwoodjs/agent-ci run --workflow 'ci.yml' --json");
  });
});

describe("detectAgentCiCapability", () => {
  it("posix → native", async () => {
    const cap = await detectAgentCiCapability({ platform: "linux", probeWsl: async () => ({ hasDistro: false, hasNode: false }) });
    expect(cap.mode).toBe("native");
  });
  it("win + WSL distro + node → wsl", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: true, hasNode: true }) });
    expect(cap.mode).toBe("wsl");
  });
  it("win + no WSL distro → unavailable(needs-wsl-on-windows)", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: false, hasNode: false }) });
    expect(cap.mode).toBe("unavailable");
    expect(cap.reason).toBe("needs-wsl-on-windows");
    expect(cap.detail).toMatch(/WSL/i);
  });
  it("win + WSL distro but no node → unavailable(needs-node-in-wsl)", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: true, hasNode: false }) });
    expect(cap.mode).toBe("unavailable");
    expect(cap.reason).toBe("needs-node-in-wsl");
  });
});

describe("AgentCiUnavailableError", () => {
  it("carries reason + detail", () => {
    const e = new AgentCiUnavailableError("needs-wsl-on-windows", "agent-ci gate requires WSL on Windows");
    expect(e.reason).toBe("needs-wsl-on-windows");
    expect(e.detail).toBe("agent-ci gate requires WSL on Windows");
    expect(e).toBeInstanceOf(Error);
  });
});
