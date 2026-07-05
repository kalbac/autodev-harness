// cross-spawn, not node:child_process: on Windows, node's bare `spawn("codex", ...)`
// fails ENOENT for a PATH command that resolves to a `.cmd`/`.bat` shim (e.g. the
// npm-global `codex` critic), and node 22 refuses to spawn `.cmd` without a shell
// (CVE-2024-27980). cross-spawn resolves the shim via PATH+PATHEXT and invokes it
// through cmd.exe with correct argument quoting -- so the codex arg
// `model_reasoning_effort="high"` survives intact. A no-op passthrough on POSIX.
import spawn from "cross-spawn";

/** Grace period between SIGTERM and the escalated SIGKILL when a `timeoutMs`
 *  deadline fires (POSIX; Windows kills forcefully on the first signal). */
const SIGKILL_GRACE_MS = 2000;

export interface NativeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeOptions {
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Kill deadline in ms. When set, the child is SIGTERM'd after `timeoutMs` and,
   * if it ignores that, SIGKILL'd after a short grace period — so the promise
   * always settles via the `close` handler even for a child that traps SIGTERM.
   * Opt-in — omitted means no timeout, so existing callers are unaffected. On
   * Windows a `.cmd`/`.bat` shim runs under `cmd.exe`; killing reaps the direct
   * child (the wrapper), which is sufficient for a fast-exiting probe like
   * `--version` (and Windows terminates forcefully on the first signal anyway).
   */
  timeoutMs?: number;
}

/**
 * Run a native process and resolve with its captured output. Never rejects on a
 * non-zero exit code — the caller inspects `exitCode` (parity with the PS
 * `Invoke-Native` stderr-as-terminating-error workaround).
 */
export function runNative(
  command: string,
  args: string[],
  options: NativeOptions = {},
): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    // cross-spawn types stdout/stderr as nullable (they are null only for
    // non-'pipe' stdio, which we never request), so guard defensively -- with
    // default stdio these streams are always present at runtime.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    // Kill deadline: reap a hung child instead of leaking it (a repeatedly-hit
    // endpoint could otherwise accumulate orphans). SIGTERM first, then escalate
    // to SIGKILL after a grace period -- a child that IGNORES SIGTERM must still
    // terminate, or the promise would hang forever (on POSIX; on Windows both map
    // to a forceful TerminateProcess, so the first kill already ends it). The kill
    // triggers 'close', which resolves normally below; both timers clear on settle.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* already gone */
            }
            killTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }, SIGKILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;
    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on("error", (err) => {
      clearTimers();
      reject(err); // spawn failure (ENOENT) is a real error
    });
    child.on("close", (code) => {
      clearTimers();
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    // Writing stdin races the child closing its read end: a child that never
    // reads stdin and exits fast (e.g. many `git` subcommands) leaves the pipe's
    // reader gone, so our `end()` write raises EPIPE. That is benign here -- the
    // child's output/exit are captured via the handlers above -- but without an
    // 'error' listener it surfaces as an UNHANDLED error event and crashes the
    // run (observed as a flaky EPIPE on linux/node20 in CI). Swallow it.
    child.stdin?.on("error", () => {});
    // Always close stdin so children that read until EOF (e.g. `cat`, or a
    // node script waiting on 'end') don't hang forever waiting for more input.
    child.stdin?.end(options.stdin ?? "");
  });
}
