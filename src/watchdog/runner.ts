/**
 * Process-liveness runner seam — parity spec §6, the PS `Start-WatchedProcess`
 * signature. This interface is the injection point the `claude-adapter`
 * worker depends on so it never spawns a native process directly. The real
 * implementation (heartbeat/activity staleness polling, timeout enforcement,
 * rate-limit detection) lands in Task 20 — this file only defines the shape.
 */
export interface WatchedRunInput {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  heartbeatPath: string;
  activityPaths: string[];
  staleSeconds: number;
  timeoutSeconds: number;
  /** Liveness-poll interval in milliseconds. Optional — the real runner defaults it. */
  pollMs?: number;
}

export interface WatchedRunResult {
  exitCode: number;
  timedOut: boolean;
  rateLimited: boolean;
  stdout: string;
  stderr: string;
}

export interface WatchedProcessRunner {
  run(input: WatchedRunInput): Promise<WatchedRunResult>;
}
