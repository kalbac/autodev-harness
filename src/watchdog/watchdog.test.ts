import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRateLimited, runWatched } from "./watchdog.js";
import type { WatchedRunInput } from "./runner.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "watchdog-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function baseInput(overrides: Partial<WatchedRunInput> & Pick<WatchedRunInput, "args">): WatchedRunInput {
  return {
    command: process.execPath,
    stdin: "",
    cwd: workDir,
    heartbeatPath: join(workDir, "heartbeat"),
    activityPaths: [],
    staleSeconds: 60,
    timeoutSeconds: 60,
    pollMs: 100,
    ...overrides,
  };
}

describe("runWatched", () => {
  it("kills a silently-hung process once its heartbeat/activity goes stale", async () => {
    const input = baseInput({
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      staleSeconds: 0.6,
      timeoutSeconds: 120,
      pollMs: 150,
    });

    const t0 = Date.now();
    const result = await runWatched(input);
    const elapsedMs = Date.now() - t0;

    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(30000);
  }, 40000);

  it("stays alive while stdout activity keeps arriving, even past the stale window", async () => {
    const script = `
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        process.stdout.write('line ' + n + '\\n');
        if (n >= 8) { clearInterval(iv); process.exit(0); }
      }, 150);
    `;
    const input = baseInput({
      args: ["-e", script],
      staleSeconds: 0.6,
      timeoutSeconds: 30,
      pollMs: 100,
    });

    const result = await runWatched(input);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line 1");
    expect(result.stdout).toContain("line 8");
  }, 20000);

  it("fires the hard timeout even when the process stays constantly active", async () => {
    const script = `
      const iv = setInterval(() => {
        process.stdout.write('tick\\n');
      }, 100);
    `;
    const input = baseInput({
      args: ["-e", script],
      staleSeconds: 30,
      timeoutSeconds: 0.8,
      pollMs: 100,
    });

    const t0 = Date.now();
    const result = await runWatched(input);
    const elapsedMs = Date.now() - t0;

    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(15000);
  }, 20000);

  it("keeps a process alive with only heartbeat-file touches (no stdout)", async () => {
    const hbPath = join(workDir, "heartbeat");
    // Windows path separators need escaping inside the JS string literal.
    const jsHbPath = hbPath.replace(/\\/g, "\\\\");
    const script = `
      const fs = require('fs');
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        fs.writeFileSync('${jsHbPath}', 'beat ' + n);
        if (n >= 6) { clearInterval(iv); process.exit(0); }
      }, 150);
    `;
    const input = baseInput({
      args: ["-e", script],
      heartbeatPath: hbPath,
      staleSeconds: 0.6,
      timeoutSeconds: 30,
      pollMs: 100,
    });

    const result = await runWatched(input);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20000);

  it("detects a rate-limited run from stderr text and a non-zero exit code", async () => {
    const script = `
      process.stderr.write('429 Too Many Requests\\n');
      process.exit(1);
    `;
    const input = baseInput({
      args: ["-e", script],
      staleSeconds: 30,
      timeoutSeconds: 30,
      pollMs: 100,
    });

    const result = await runWatched(input);

    expect(result.rateLimited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  }, 20000);
});

describe("isRateLimited", () => {
  it("returns false when the exit code is zero, even with rate-limit-shaped text", () => {
    expect(isRateLimited(0, "429 rate limit exceeded")).toBe(false);
  });

  it("returns true on a non-zero exit code with quota-shaped text", () => {
    expect(isRateLimited(1, "You have exceeded your quota")).toBe(true);
  });

  it("returns false on a non-zero exit code with benign text", () => {
    expect(isRateLimited(1, "something unrelated went wrong")).toBe(false);
  });
});
