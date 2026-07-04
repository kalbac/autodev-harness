import { join } from "node:path";
import type { WorkerAdapter, WorkerResult, WorkerRunInput } from "./adapter.js";
import { buildWorkerPrompt } from "./prompt.js";
import type { HarnessConfig } from "../config/schema.js";
import { resolveWorkerExe } from "../config/roles.js";
import type { WatchedProcessRunner, WatchedRunResult } from "../watchdog/runner.js";
import { parseClaudeUsage } from "../usage/usage.js";

export interface ClaudeWorkerAdapterDeps {
  runner: WatchedProcessRunner;
  cfg: HarnessConfig;
}

/**
 * Live `claude -p` worker adapter — parity spec §6. Drives the model ladder
 * through an injected `WatchedProcessRunner` (the real watchdog lands in
 * Task 20; this adapter never spawns a process itself).
 *
 * Ladder loop semantics (§6), evaluated per step in this priority order:
 * 1. Rate-limited AND the task touches a contract zone → PAUSE immediately
 *    (`RATE_LIMITED`) — a contract-zone task must never be downgraded to a
 *    cheaper model on a 429.
 * 2. Rate-limited AND not contract-zone → step down to the next (cheaper)
 *    ladder entry.
 * 3. Timed out → stop immediately (`TIMED_OUT`), no further ladder steps.
 * 4. Otherwise → `DONE`.
 * If the ladder is exhausted with every step rate-limited (only reachable
 * for a non-contract task), the natural fall-through result is
 * `RATE_LIMITED` with the last attempted model.
 */
export class ClaudeWorkerAdapter implements WorkerAdapter {
  private readonly runner: WatchedProcessRunner;
  private readonly cfg: HarnessConfig;

  constructor(deps: ClaudeWorkerAdapterDeps) {
    this.runner = deps.runner;
    this.cfg = deps.cfg;
  }

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    if (input.ladder.length === 0) {
      throw new Error("ClaudeWorkerAdapter: ladder must be non-empty");
    }

    const stdin = buildWorkerPrompt(input.task, this.cfg, input.criticFeedback);

    let model = "";
    let result: WatchedRunResult | undefined;

    for (model of input.ladder) {
      result = await this.runner.run({
        command: resolveWorkerExe(this.cfg),
        args: [
          "-p",
          "--model",
          model,
          "--permission-mode",
          "acceptEdits",
          "--max-turns",
          String(this.cfg.roles.worker.maxTurns),
          "--verbose",
          "--output-format",
          "stream-json",
        ],
        stdin,
        cwd: input.worktreePath,
        heartbeatPath: join(input.runtimeDir, "heartbeat"),
        activityPaths: [input.runtimeDir],
        staleSeconds: this.cfg.roles.worker.staleMinutes * 60,
        timeoutSeconds: this.cfg.roles.worker.timeoutMinutes * 60,
      });

      if (result.rateLimited && input.task.touches_contract_zone) {
        return toResult("RATE_LIMITED", model, result);
      }
      if (result.rateLimited) {
        continue; // step down to the next (cheaper) ladder entry
      }
      if (result.timedOut) {
        return toResult("TIMED_OUT", model, result);
      }
      return toResult("DONE", model, result);
    }

    // Ladder exhausted — only reachable when every step was rate-limited on
    // a non-contract task.
    return toResult("RATE_LIMITED", model, result!);
  }
}

function toResult(
  status: WorkerResult["status"],
  model: string,
  result: WatchedRunResult,
): WorkerResult {
  // Best-effort usage parse: a null (no parseable stream-json result event)
  // leaves `usage` off the result entirely -- never assigned an explicit
  // `undefined` (exactOptionalPropertyTypes) -- so the transport shape is
  // byte-identical to the pre-instrumentation result when stdout carries no usage.
  const parsed = parseClaudeUsage(result.stdout);
  return {
    status,
    model,
    rateLimited: result.rateLimited,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    ...(parsed !== null ? { usage: { model, ...parsed } } : {}),
  };
}
