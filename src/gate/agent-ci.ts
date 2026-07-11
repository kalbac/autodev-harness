import {
  AgentCiUnavailableError,
  buildAgentCiCommand,
  detectAgentCiCapability,
  spawnAgentCiStream,
  winToWslPath,
  worktreeGitDirWsl,
  type AgentCiCapability,
  type AgentCiSpawner,
} from "./agent-ci-exec.js";
import { deriveWorkflowVerdict, parseAgentCiEvent, type AgentCiEvent } from "./agent-ci-events.js";

export interface RunAgentCiInput {
  /** The per-task git worktree — agent-ci runs against its current file state. */
  cwd: string;
  /** Explicit allowlist of workflow file paths (never auto-discovered). */
  workflows: string[];
  /** Per-workflow wall-clock ceiling. Exceeding it is an INFRA failure (throw). */
  timeoutMs: number;
  /** Decides native/wsl/unavailable. Injected (defaults to the real probe in root.ts). */
  detectCapability: () => Promise<AgentCiCapability>;
  /** Streaming spawner (native or wsl). Injected; defaults to spawnAgentCiStream in root.ts. */
  spawn: AgentCiSpawner;
  /** Called for every STRUCTURED event (kind !== "other"). The caller persists + publishes. */
  onEvent: (workflow: string, event: AgentCiEvent) => void;
  /** WSL-form gitdir of the worktree (root.ts derives it from the worktree `.git` file).
   *  Only used in wsl mode; lets WSL git resolve HEAD in a Windows-created worktree. */
  gitDirWsl?: string;
}

export interface AgentCiResult {
  green: boolean;
  reasons: string[];
}

const AGENT_CI_ENV = { AGENT_CI_JSON: "1", AI_AGENT: "1" } as const;

/**
 * Replay a project's real GitHub Actions workflows locally via
 * `npx @redwoodjs/agent-ci run --workflow <path> --json`, one at a time, against
 * the given worktree, streaming its NDJSON output line-by-line.
 *
 * Contract UNCHANGED from v1 (buffered): returns `{green, reasons}` for a
 * clean/failed run; THROWS on an infra failure (no terminal event / timeout) so the
 * conductor escalates. NEW here: throws a typed `AgentCiUnavailableError` when the
 * platform can't run agent-ci at all (Windows without WSL, or WSL without Node), and
 * streams each parsed event to `onEvent` as it arrives.
 *
 * Sequential execution (never parallel) avoids the shared-node_modules-mount
 * collision agent-ci's own docs warn about for concurrent cold installs against
 * one working tree.
 */
export async function runAgentCiWorkflows(input: RunAgentCiInput): Promise<AgentCiResult> {
  const capability = await input.detectCapability();
  if (capability.mode === "unavailable") {
    throw new AgentCiUnavailableError(capability.reason ?? "needs-wsl-on-windows", capability.detail);
  }

  const reasons: string[] = [];
  let green = true;

  // Map the worktree path into WSL once (same cwd for every workflow). Unmappable -> honest unavailable.
  let commandCwd = input.cwd;
  if (capability.mode === "wsl") {
    const posix = winToWslPath(input.cwd);
    if (posix === null) {
      throw new AgentCiUnavailableError(
        "unmappable-worktree-path",
        `agent-ci cannot map the worktree path '${input.cwd}' into WSL (UNC or no drive letter) -- ` +
          `move the repo onto a drive-letter path or run the daemon on Linux/Mac`,
      );
    }
    commandCwd = posix;
  }

  for (const wf of input.workflows) {
    const events: AgentCiEvent[] = [];
    const { command, args } = buildAgentCiCommand(capability.mode, {
      cwd: commandCwd,
      workflow: wf,
      ...(input.gitDirWsl !== undefined ? { gitDirWsl: input.gitDirWsl } : {}),
    });
    const { exitCode, timedOut } = await input.spawn({
      command,
      args,
      cwd: input.cwd, // spawn from the Windows worktree; the `cd` inside the wsl script (commandCwd) is authoritative
      env: { ...process.env, ...AGENT_CI_ENV },
      timeoutMs: input.timeoutMs,
      onLine: (line) => {
        const ev = parseAgentCiEvent(line);
        if (ev.kind === "other") return; // non-structured line: not persisted/streamed
        events.push(ev);
        input.onEvent(wf, ev);
      },
    });

    if (timedOut) {
      throw new Error(
        `agent-ci workflow '${wf}' timed out after ${input.timeoutMs}ms -- treating as an infrastructure failure`,
      );
    }

    const verdict = deriveWorkflowVerdict(events);
    if (verdict.outcome === "infra") {
      throw new Error(
        `agent-ci workflow '${wf}' produced no parseable run.finish event (exit ${exitCode}) ` +
          `-- treating as an infrastructure failure`,
      );
    }
    if (verdict.outcome === "failed") {
      green = false;
      const steps = verdict.failedSteps.length > 0 ? ` (failed: ${verdict.failedSteps.join(", ")})` : "";
      reasons.push(`agent-ci workflow '${wf}' FAILED${steps}`);
    }
  }

  return { green, reasons };
}

// Re-export the real defaults so root.ts wires them without importing exec directly.
export { spawnAgentCiStream, detectAgentCiCapability, worktreeGitDirWsl };
export type { AgentCiEvent } from "./agent-ci-events.js";
