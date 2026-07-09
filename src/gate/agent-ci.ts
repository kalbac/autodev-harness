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

/** Spawn one workflow with an independent timeout race. A promise that never
 *  resolves before `timeoutMs` is an infra failure -> throw. */
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
 * DEFENSIVE by design: the terminal signal may appear as a `run.finish` event
 * carrying a `status`/`conclusion`/`result` string, or as a top-level `passed`
 * boolean. Any recognized "passed" wins; any recognized "failed" is a job
 * failure; NOTHING recognized (no terminal event at all) is an infra failure.
 * Unknown/extra fields are ignored, never a crash. The EXACT real shape is
 * confirmed later in a live-prove — this stays defensive.
 */
export function parseWorkflowOutcome(stdout: string): WorkflowOutcome {
  let sawTerminal = false;
  let failed = false;
  let passed = false;

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

    const type = obj["type"];
    if (type === "run.finish" || type === "run.finished" || type === "run.complete") {
      sawTerminal = true;
      const verdict = terminalVerdict(obj);
      if (verdict === "passed") passed = true;
      else if (verdict === "failed") failed = true;
    } else if (typeof obj["passed"] === "boolean" && (type === undefined || type === "run.finish")) {
      sawTerminal = true;
      if (obj["passed"] === true) passed = true;
      else failed = true;
    }
  }

  if (!sawTerminal) return "infra";
  if (failed) return "failed";
  if (passed) return "passed";
  return "failed"; // a terminal event we couldn't read as pass -> job failure, not infra
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
