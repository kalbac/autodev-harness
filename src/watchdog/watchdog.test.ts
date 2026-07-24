import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyWatchTick, isRateLimited, runWatched } from "./watchdog.js";
import type { WatchedRunInput } from "./runner.js";

const realDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A minimal in-process stand-in for a spawned child: EventEmitters for stdout/stderr/self,
 *  a no-op stdin, and NO pid so `killTree()` is a guaranteed no-op (it early-returns on a
 *  null pid) — no real OS process is ever touched. Lets a test drive activity + exit
 *  deterministically while an injected clock drives every staleness/timeout decision. */
function makeFakeChild(): {
  child: ChildProcess;
  emitStdout: (s: string) => void;
  close: (code: number) => void;
} {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  // No `pid` field, so killTree()'s `pid == null` guard makes it a no-op — no OS process.
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { end: (_s?: string) => {} },
  });
  return {
    child: child as unknown as ChildProcess,
    emitStdout: (s: string) => stdout.emit("data", s),
    close: (code: number) => child.emit("close", code),
  };
}

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

  it("captures streamed stdout and waits for a clean exit (IO-wiring smoke)", async () => {
    // Real-subprocess smoke for the spawn -> stdout-capture -> clean-exit wiring only.
    // The tight-window property ("stdout activity resets the stale timer") is proven
    // deterministically in classifyWatchTick; this uses a generous stale window so it
    // asserts clean completion, never a wall-clock race that flakes under CPU load.
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
      staleSeconds: 30,
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

  it("does not spuriously kill a heartbeat-only process (no stdout) that exits cleanly", async () => {
    // Smoke that a process communicating only via the heartbeat file (never stdout) is
    // run to its own clean exit rather than killed. Uses a generous stale window: the
    // tight "heartbeat mtime resets the stale timer" boundary is classifyWatchTick's job,
    // so this asserts clean completion without a load-sensitive wall-clock race.
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
      staleSeconds: 30,
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

describe("runWatched with an injected clock + spawn (deterministic wiring)", () => {
  // These prove the END-TO-END liveness wiring — stdout activity resets lastActivity,
  // which feeds newestActivity, which the loop classifies — WITHOUT a wall-clock race, so
  // they can never flake under CPU load. The injected clock is seeded ABOVE the real epoch
  // so the heartbeat file's real mtime never dominates newestActivity. Loop pacing still
  // uses a few short real delays, but the OUTCOME is decided solely by the injected clock.
  const CLOCK0 = 2_000_000_000_000; // year ~2033 in ms — safely above any real file mtime

  it("kills the child (timedOut) once the injected clock crosses the stale window with no new activity", async () => {
    let now = CLOCK0;
    const fake = makeFakeChild();
    const input = baseInput({ args: [], staleSeconds: 0.6, timeoutSeconds: 600, pollMs: 5 });

    const p = runWatched(input, { now: () => now, spawn: () => fake.child });
    await realDelay(30); // let the loop start ticking at the seeded clock (idle 0 -> alive)
    now = CLOCK0 + 2_000; // jump 2s past the last activity: idle 2000ms > 600ms stale window
    // pollMs (5) << this delay, so an earlier-expiring poll timer always fires — observing
    // the advanced clock and killing — BEFORE the close below, even under scheduling load.
    await realDelay(60);
    fake.close(137); // the (fake) killed process now reports its exit, satisfying the grace

    const result = await p;
    // timedOut is set ONLY by the stale-kill path, so this cannot pass vacuously: with no
    // kill the close(137) would leave timedOut false and fail the assertion.
    expect(result.timedOut).toBe(true);
  }, 10000);

  it("stays alive while stdout activity keeps the injected clock fresh, then reports the clean exit", async () => {
    let now = CLOCK0;
    const fake = makeFakeChild();
    const input = baseInput({ args: [], staleSeconds: 0.6, timeoutSeconds: 600, pollMs: 5 });

    const p = runWatched(input, { now: () => now, spawn: () => fake.child });
    await realDelay(30); // let runWatched finish its async setup and attach the stdout handler
    // Eight stdout bursts. The clock is advanced BEFORE each emit, so the handler's
    // `lastActivity = now()` records the ADVANCED time — this test only stays alive if the
    // stdout->lastActivity wiring actually fires. Total elapsed reaches 800ms, PAST the
    // 600ms stale window, so a BROKEN wiring (lastActivity stuck at the seed) would go stale
    // (idle 700ms > 600ms by burst 7) and be killed — failing this test. Not a vacuous
    // boundary pass: with the wiring working, each burst resets idle to 0.
    for (let i = 1; i <= 8; i++) {
      now = CLOCK0 + i * 100;
      fake.emitStdout(`line ${i}\n`);
      await realDelay(15);
    }
    fake.close(0);

    const result = await p;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line 1");
    expect(result.stdout).toContain("line 8");
  }, 10000);
});

describe("classifyWatchTick", () => {
  // The pure staleness/timeout decision extracted from the poll loop, so its timing
  // correctness is proven on plain numbers (no wall-clock, no subprocess) and can never
  // flake under CPU load. Mirrors the loop's exact semantics: newestActivity is the max
  // of all activity signals; stale is checked BEFORE timeout; both use a strict `>`.

  it("continues while both the idle and elapsed windows are unbreached", () => {
    const d = classifyWatchTick({
      now: 5_000,
      start: 0,
      newestActivity: 4_500,
      staleSeconds: 1, // idle 500ms <= 1000ms
      timeoutSeconds: 60, // elapsed 5000ms <= 60000ms
    });
    expect(d.kill).toBe(false);
  });

  it("kills as 'stale' once idle exceeds staleSeconds", () => {
    const d = classifyWatchTick({
      now: 5_000,
      start: 0,
      newestActivity: 3_000, // idle 2000ms > 600ms
      staleSeconds: 0.6,
      timeoutSeconds: 60,
    });
    expect(d).toEqual({ kill: true, reason: "stale" });
  });

  it("kills as 'timeout' once elapsed exceeds timeoutSeconds while still active", () => {
    const d = classifyWatchTick({
      now: 5_000,
      start: 0,
      newestActivity: 4_900, // idle 100ms — well within a 30s stale window
      staleSeconds: 30,
      timeoutSeconds: 0.8, // elapsed 5000ms > 800ms
    });
    expect(d).toEqual({ kill: true, reason: "timeout" });
  });

  it("reports 'stale' (not 'timeout') when both windows are breached — stale has precedence", () => {
    const d = classifyWatchTick({
      now: 10_000,
      start: 0,
      newestActivity: 0, // idle 10000ms > stale AND elapsed 10000ms > timeout
      staleSeconds: 0.6,
      timeoutSeconds: 0.8,
    });
    expect(d).toEqual({ kill: true, reason: "stale" });
  });

  it("does not kill exactly at a threshold — the loop uses a strict '>'", () => {
    const stale = classifyWatchTick({
      now: 1_000,
      start: 0,
      newestActivity: 0, // idle exactly 1000ms == staleSeconds*1000
      staleSeconds: 1,
      timeoutSeconds: 60,
    });
    expect(stale.kill).toBe(false);

    const timeout = classifyWatchTick({
      now: 1_000,
      start: 0,
      newestActivity: 1_000, // idle 0; elapsed exactly 1000ms == timeoutSeconds*1000
      staleSeconds: 60,
      timeoutSeconds: 1,
    });
    expect(timeout.kill).toBe(false);
  });
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
