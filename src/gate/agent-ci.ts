import type { NativeOptions, NativeResult } from "../util/native.js";

/** The subprocess seam — same signature as `runNative`, injected so the whole
 *  module is unit-testable with a scripted fake (no Docker in unit tests). */
export type NativeRunner = (
  command: string,
  args: string[],
  options?: NativeOptions,
) => Promise<NativeResult>;

export interface RunAgentCiInput {
  /** The per-task git worktree — agent-ci runs against its current file state. */
  cwd: string;
  /** Explicit allowlist of workflow file paths (never auto-discovered). */
  workflows: string[];
  /** Per-workflow wall-clock ceiling. Exceeding it is an INFRA failure (throw). */
  timeoutMs: number;
  runner: NativeRunner;
}

export interface AgentCiResult {
  green: boolean;
  reasons: string[];
}

/**
 * Replay a project's real GitHub Actions workflows locally via
 * `npx @redwoodjs/agent-ci run --workflow <path> --json`, one at a time, against
 * the given worktree.
 *
 * TWO outcomes, deliberately distinct (callers rely on the difference):
 *  - A genuine JOB failure (agent-ci ran fine, a workflow's run.finish is not
 *    "passed") -> RETURN `{green:false, reasons:[...]}`. Worker-fixable.
 *  - An INFRASTRUCTURE failure (Docker down, agent-ci unresolvable, no parseable
 *    run.finish event, or the run exceeds `timeoutMs`) -> THROW. NOT worker-fixable.
 *
 * Sequential execution (never parallel) avoids the shared-node_modules-mount
 * collision agent-ci's own docs warn about for concurrent cold installs against
 * one working tree.
 */
export async function runAgentCiWorkflows(input: RunAgentCiInput): Promise<AgentCiResult> {
  const reasons: string[] = [];
  let green = true;

  for (const wf of input.workflows) {
    const result = await runOne(wf, input);
    const outcome = parseWorkflowOutcome(result.stdout);

    if (outcome === "infra") {
      throw new Error(
        `agent-ci workflow '${wf}' produced no parseable run.finish event ` +
          `(exit ${result.exitCode}) -- treating as an infrastructure failure`,
      );
    }
    if (outcome === "failed") {
      green = false;
      reasons.push(`agent-ci workflow '${wf}' FAILED`);
    }
  }

  return { green, reasons };
}

/** Spawn one workflow with a timeout that both throws (the infra-failure
 *  contract) AND kills the underlying child. Two layers, deliberately:
 *   1. `timeoutMs` is passed INTO the runner options — the real `runNative`
 *      honors it (SIGTERM -> grace -> SIGKILL), so a hung agent-ci/Docker child
 *      is actually reaped, not orphaned to keep running after the gate escalated.
 *   2. A module-level `Promise.race` timeout guarantees `runOne` THROWS on time
 *      even for a runner that ignores its `timeoutMs` (e.g. a test fake, or a
 *      seam whose child-kill is delayed) — the throw is the infra-failure signal
 *      callers rely on. Whichever fires, the child is still killed by layer 1. */
async function runOne(wf: string, input: RunAgentCiInput): Promise<NativeResult> {
  const args = ["@redwoodjs/agent-ci", "run", "--workflow", wf, "--json"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`agent-ci workflow '${wf}' timed out after ${input.timeoutMs}ms`)),
      input.timeoutMs,
    );
  });
  try {
    return await Promise.race([
      input.runner("npx", args, {
        cwd: input.cwd,
        env: { ...process.env, AGENT_CI_JSON: "1", AI_AGENT: "1" },
        // Layer 1: the real runner reaps its own child on this deadline, so an
        // infra-timeout never leaks a still-running Docker CI job.
        timeoutMs: input.timeoutMs,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type WorkflowOutcome = "passed" | "failed" | "infra";

/**
 * Parse agent-ci's buffered NDJSON stdout for a run's terminal outcome.
 *
 * REAL SHAPE (verified live s37, `@redwoodjs/agent-ci@0.16.2`): every line is an
 * object keyed by `event` (NOT `type` — the initial defensive guess was wrong,
 * caught by the live-prove), and the terminal line is
 * `{"event":"run.finish","ts":"...","status":"passed"|"failed"}`. We key off
 * `event` first and keep `type` as a defensive fallback for a future/alt build.
 * `status` carries the verdict (also seen on `step.finish`/`job.finish`).
 *
 * Classification rules (FAIL-CLOSED for the gate — never COMMIT on ambiguity):
 *  - NO terminal event at all -> `infra` (agent-ci itself did not complete a run:
 *    Docker down, bad binary, killed-on-timeout partial output). Callers throw.
 *  - The LAST terminal event decides (not an OR across all): a later
 *    `{status:"cancelled"}` after an earlier `{status:"passed"}` must NOT be
 *    read as passed. agent-ci emits one terminal event per run today, but the
 *    parser must not silently mis-rank a stream that carries more than one.
 *  - A terminal event whose verdict we can't read as an explicit pass counts as
 *    `failed`, not `passed` (unknown/`cancelled`/`skipped`/`neutral` -> RETRY,
 *    not COMMIT). This is a job-level outcome, NOT infra — the run DID finish.
 */
export function parseWorkflowOutcome(stdout: string): WorkflowOutcome {
  // null = no terminal event seen yet; last terminal event wins.
  let lastTerminal: "passed" | "failed" | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue; // non-JSON log line -> ignore
    }

    // agent-ci 0.16.2 keys events by `event` (verified live); keep `type` as a
    // defensive fallback for a future/alternate build.
    const kind = obj["event"] ?? obj["type"];
    if (kind === "run.finish" || kind === "run.finished" || kind === "run.complete") {
      // unknown terminal verdict -> failed (fail-closed): the run finished, but
      // not with a verdict we can read as an explicit pass.
      lastTerminal = terminalVerdict(obj) === "passed" ? "passed" : "failed";
    } else if (typeof obj["passed"] === "boolean" && (kind === undefined || kind === "run.finish")) {
      lastTerminal = obj["passed"] === true ? "passed" : "failed";
    }
  }

  if (lastTerminal === null) return "infra";
  return lastTerminal;
}

/** Read pass/fail from a terminal event across the field names agent-ci might use. */
function terminalVerdict(obj: Record<string, unknown>): "passed" | "failed" | "unknown" {
  if (obj["passed"] === true) return "passed";
  if (obj["passed"] === false) return "failed";
  for (const key of ["status", "conclusion", "result", "outcome"]) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    const s = v.toLowerCase();
    if (s === "passed" || s === "success" || s === "succeeded") return "passed";
    if (s === "failed" || s === "failure" || s === "error") return "failed";
  }
  return "unknown";
}
