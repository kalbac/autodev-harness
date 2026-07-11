import { describe, it, expect, vi } from "vitest";
import {
  winToWslPath,
  worktreeGitDirWsl,
  buildAgentCiCommand,
  detectAgentCiCapability,
  spawnAgentCiStream,
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

describe("worktreeGitDirWsl", () => {
  it("derives the /mnt gitdir from a Windows worktree .git file", () => {
    expect(worktreeGitDirWsl("gitdir: D:/Projects/app/.git/worktrees/task1"))
      .toBe("/mnt/d/Projects/app/.git/worktrees/task1");
  });
  it("handles backslash gitdir paths", () => {
    expect(worktreeGitDirWsl("gitdir: D:\\Projects\\app\\.git\\worktrees\\t"))
      .toBe("/mnt/d/Projects/app/.git/worktrees/t");
  });
  it("returns null for a POSIX gitdir (Linux/Mac -- native git resolves it)", () => {
    expect(worktreeGitDirWsl("gitdir: /home/u/app/.git/worktrees/t")).toBeNull();
  });
  it("returns null when there is no gitdir pointer / null content", () => {
    expect(worktreeGitDirWsl("ref: refs/heads/main")).toBeNull();
    expect(worktreeGitDirWsl(null)).toBeNull();
  });
});

describe("buildAgentCiCommand gitDirWsl", () => {
  it("wsl: prepends GIT_DIR + GIT_WORK_TREE exports when gitDirWsl is given", () => {
    const { args } = buildAgentCiCommand("wsl", { cwd: "/mnt/d/a/wt", workflow: "ci.yml", gitDirWsl: "/mnt/d/a/.git/worktrees/wt" });
    expect(args[3]).toContain("export GIT_DIR='/mnt/d/a/.git/worktrees/wt'");
    expect(args[3]).toContain("export GIT_WORK_TREE='/mnt/d/a/wt'");
    expect(args[3]).toContain("cd '/mnt/d/a/wt'");
    expect(args[3]).toContain("npx @redwoodjs/agent-ci run --workflow 'ci.yml' --json");
  });
  it("wsl: no exports when gitDirWsl is omitted (unchanged shape)", () => {
    const { args } = buildAgentCiCommand("wsl", { cwd: "/mnt/d/a", workflow: "ci.yml" });
    expect(args[3]).toBe("cd '/mnt/d/a' && npx @redwoodjs/agent-ci run --workflow 'ci.yml' --json");
    expect(args[3]).not.toContain("GIT_DIR");
  });
  it("native: ignores gitDirWsl", () => {
    const { command, args } = buildAgentCiCommand("native", { cwd: "/repo", workflow: "ci.yml", gitDirWsl: "/mnt/d/x" });
    expect(command).toBe("npx");
    expect(args.join(" ")).not.toContain("GIT_DIR");
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

describe("spawnAgentCiStream", () => {
  it("resolves { exitCode: -1, timedOut: false } and never rejects when the child spawn throws synchronously", async () => {
    vi.resetModules();
    vi.doMock("cross-spawn", () => ({ default: () => { throw new Error("boom"); } }));
    const { spawnAgentCiStream } = await import("./agent-ci-exec.js");
    await expect(
      spawnAgentCiStream({ command: "x", args: [], cwd: "/", env: {}, timeoutMs: 1000, onLine: () => {} }),
    ).resolves.toEqual({ exitCode: -1, timedOut: false });
    vi.doUnmock("cross-spawn");
    vi.resetModules();
  });

  it("resolves { exitCode: -1, timedOut: true } when the deadline fires before the child exits", async () => {
    // Real child process that never exits on its own -- exercises the actual
    // deadline/kill path (no cross-spawn mock needed).
    const res = await spawnAgentCiStream({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 50,
      onLine: () => {},
    });
    expect(res).toEqual({ exitCode: -1, timedOut: true });
  }, 10000);
});

describe("AgentCiUnavailableError", () => {
  it("carries reason + detail", () => {
    const e = new AgentCiUnavailableError("needs-wsl-on-windows", "agent-ci gate requires WSL on Windows");
    expect(e.reason).toBe("needs-wsl-on-windows");
    expect(e.detail).toBe("agent-ci gate requires WSL on Windows");
    expect(e).toBeInstanceOf(Error);
  });
});
