// cross-spawn, not node:child_process: on Windows, node's bare `spawn("codex", ...)`
// fails ENOENT for a PATH command that resolves to a `.cmd`/`.bat` shim (e.g. the
// npm-global `codex` critic), and node 22 refuses to spawn `.cmd` without a shell
// (CVE-2024-27980). cross-spawn resolves the shim via PATH+PATHEXT and invokes it
// through cmd.exe with correct argument quoting -- so the codex arg
// `model_reasoning_effort="high"` survives intact. A no-op passthrough on POSIX.
import spawn from "cross-spawn";

export interface NativeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeOptions {
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
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
    child.on("error", reject); // spawn failure (ENOENT) is a real error
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
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
