import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WatchedProcessRunner, WatchedRunInput, WatchedRunResult } from "./runner.js";

const DEFAULT_POLL_MS = 2000;

const RATE_LIMIT_PATTERN =
  /(429|rate.?limit|quota|overloaded|too many requests|usage limit)/i;

/**
 * Parity port of the PS `Test-RateLimited` helper: a non-zero exit combined
 * with rate-limit-shaped text (checked across both stdout and stderr by the
 * caller) signals the caller should step down the model ladder.
 */
export function isRateLimited(exitCode: number, text: string): boolean {
  return exitCode !== 0 && RATE_LIMIT_PATTERN.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The staleness/timeout decision for a single poll tick. */
export type WatchTickDecision = { kill: false } | { kill: true; reason: "stale" | "timeout" };

/**
 * Pure decision for one poll tick: given the current clock reading, the run's start,
 * the newest activity signal, and the two windows, decide whether to kill the child and
 * why. Extracted from the poll loop so the timing logic is proven on plain numbers — it
 * has no wall-clock and no subprocess, so it cannot flake under CPU load. Semantics match
 * the loop exactly: `staleSeconds` is checked BEFORE `timeoutSeconds`, and both use a
 * strict `>` (a value exactly at the threshold does not kill).
 */
export function classifyWatchTick(args: {
  now: number;
  start: number;
  newestActivity: number;
  staleSeconds: number;
  timeoutSeconds: number;
}): WatchTickDecision {
  const idleMs = args.now - args.newestActivity;
  const elapsedMs = args.now - args.start;
  if (idleMs > args.staleSeconds * 1000) return { kill: true, reason: "stale" };
  if (elapsedMs > args.timeoutSeconds * 1000) return { kill: true, reason: "timeout" };
  return { kill: false };
}

/** Best-effort newest mtime (ms) under a single file or directory. Missing paths and
 * unreadable entries are ignored — parity with the PS `-ErrorAction SilentlyContinue`
 * walk over `ActivityPaths`. */
async function newestMtimeUnder(path: string): Promise<number> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) {
      return st.mtimeMs;
    }
    let newest = 0;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      const m = await newestMtimeUnder(childPath);
      if (m > newest) newest = m;
    }
    return newest;
  } catch {
    return 0;
  }
}

async function newestActivityPathsMtime(paths: string[]): Promise<number> {
  let newest = 0;
  for (const p of paths) {
    const m = await newestMtimeUnder(p);
    if (m > newest) newest = m;
  }
  return newest;
}

async function heartbeatMtime(heartbeatPath: string): Promise<number> {
  try {
    const st = await stat(heartbeatPath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/** Best-effort cross-platform kill of the whole process tree rooted at `child`. */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid == null) return Promise.resolve();

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
      tk.on("close", () => resolve());
      tk.on("error", () => resolve()); // best-effort — swallow taskkill failures
    });
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort — the process may already be gone
    }
  }
  return Promise.resolve();
}

/** Injection seam for `runWatched`. Both default to the real implementations; tests
 *  override them to drive staleness/timeout decisions off a controlled clock and a fake
 *  child, so the liveness logic is proven deterministically instead of via a wall-clock
 *  race. `now` is the SINGLE clock source for the whole run — one coherent reading per
 *  decision, not two sub-microsecond-apart `Date.now()` calls. */
export interface RunWatchedDeps {
  now?: () => number;
  spawn?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}

/**
 * Spawn `input.command`, monitor process liveness (stdout/stderr activity,
 * heartbeat file mtime, newest mtime under `activityPaths`), and kill the
 * whole process tree on staleness or hard timeout. Parity port of the PS
 * `Start-WatchedProcess` (watchdog.ps1) — see parity spec §1 + §6.
 */
export async function runWatched(input: WatchedRunInput, deps: RunWatchedDeps = {}): Promise<WatchedRunResult> {
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawn ?? spawn;

  await mkdir(dirname(input.heartbeatPath), { recursive: true });
  await writeFile(input.heartbeatPath, "start", "utf8");

  let lastActivity = now();
  let stdout = "";
  let stderr = "";

  const child = spawnFn(input.command, input.args, {
    cwd: input.cwd,
    env: process.env,
    detached: process.platform !== "win32",
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    stdout += d;
    lastActivity = now();
  });
  child.stderr?.on("data", (d: string) => {
    stderr += d;
    lastActivity = now();
  });
  child.stdin?.end(input.stdin);

  let exited = false;
  let exitCode: number | null = null;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const settle = (code: number | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    resolveExit();
  };
  child.on("close", (code) => settle(code));
  child.on("error", () => settle(null)); // spawn failure — never rejects the caller

  const start = now();
  let timedOut = false;

  while (!exited) {
    const tick = await Promise.race([
      exitPromise.then(() => "exited" as const),
      sleep(pollMs).then(() => "tick" as const),
    ]);
    if (tick === "exited" || exited) break;

    const hbMtime = await heartbeatMtime(input.heartbeatPath);
    const activityMtime = await newestActivityPathsMtime(input.activityPaths);
    const newestActivity = Math.max(lastActivity, hbMtime, activityMtime);

    const decision = classifyWatchTick({
      now: now(),
      start,
      newestActivity,
      staleSeconds: input.staleSeconds,
      timeoutSeconds: input.timeoutSeconds,
    });
    if (decision.kill) {
      timedOut = true;
      await killTree(child);
      break;
    }
  }

  // Give the (possibly just-killed) child a bounded window to report its exit
  // so the result reflects its true termination state.
  await Promise.race([exitPromise, sleep(5000)]);

  const finalExitCode = exitCode ?? -1;
  const rateLimited = isRateLimited(finalExitCode, stderr + "\n" + stdout);

  return {
    exitCode: finalExitCode,
    timedOut,
    rateLimited,
    stdout,
    stderr,
  };
}

/** Real `WatchedProcessRunner` — the injection point `claude-adapter` uses to
 * run the actual watchdog instead of a fake in tests. */
export class RealWatchedProcessRunner implements WatchedProcessRunner {
  run(input: WatchedRunInput): Promise<WatchedRunResult> {
    return runWatched(input);
  }
}
