import { spawn } from "node:child_process";

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
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject); // spawn failure (ENOENT) is a real error
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
