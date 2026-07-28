import { parseCommandRef } from "../util/command-ref.js";

/**
 * "Can this command even be run here?" — asked BEFORE the gate runs a task's
 * `success_command`, so a command that does not exist is never mistaken for a
 * defect in the worker's diff.
 *
 * The s60 corpus run is the reason this module exists: the LLM decomposition
 * invented `pnpm lint:php:changes`, no such script existed, and the gate read the
 * resulting `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` exit 1 as a failing check — so a
 * correct diff was RETRIED three times and then quarantined. A missing command is
 * broken CONFIG, never worker-fixable work.
 */

/**
 * TRI-STATE, deliberately not a boolean. `unknown` means "the probe could not
 * determine an answer" and it must NEVER be folded into either other value:
 * folding it into `unavailable` would manufacture escalations out of an
 * unreadable package.json, folding it into `available` would silently re-open the
 * exact hole this module closes. See `docs/gotchas/boolean-whose-no-means-two-things.md`
 * (`[logic/ambiguous-false]`) — a `false` that carries both "no" and "I could not
 * tell" is the defect class this repo keeps re-closing.
 */
export type CommandAvailability = "available" | "unavailable" | "unknown";

/**
 * The two IO seams, injected so the classifier itself stays pure and unit-testable
 * with no fs and no PATH. `null` from EITHER seam means "could not determine" —
 * distinct from an empty script set (a project that genuinely declares no scripts)
 * and from `false` (a program that genuinely does not resolve).
 */
export interface CommandProbe {
  /** The script names the PROJECT declares, or `null` when they could not be read. */
  packageScripts(): Promise<Set<string> | null>;
  /** Whether `program` resolves to something runnable, or `null` when undeterminable. */
  programExists(program: string): Promise<boolean | null>;
}

/** Why a command was classified `unavailable` — carried on the error so the conductor's
 *  escalation can say which of the two things is missing. */
export type CommandUnavailableReason = "script-not-declared" | "program-not-on-path";

/**
 * A command the gate REFUSED TO RUN because it does not exist. Mirrors
 * `AgentCiUnavailableError` (src/gate/agent-ci-exec.ts) deliberately — same
 * `(reason, detail)` shape, same `name`, same role: it propagates OUT of `runGate`
 * so the conductor recognizes it as "the harness could not run a check", rather
 * than becoming a RETRY verdict that would loop a worker against an environment
 * problem its diff cannot fix.
 */
export class CommandUnavailableError extends Error {
  constructor(readonly reason: CommandUnavailableReason, readonly detail: string) {
    super(detail);
    this.name = "CommandUnavailableError";
  }
}

/**
 * Classify one command against a probe.
 *
 *   - unparseable (empty/whitespace)      -> `unknown`
 *   - script ref, scripts unreadable      -> `unknown`
 *   - script ref, name present/absent     -> `available` / `unavailable`
 *   - program ref, probe true/false/null  -> `available` / `unavailable` / `unknown`
 *
 * A script ref never touches the PATH probe and a program ref never touches the
 * script set: which question to ask is decided ONCE, by `parseCommandRef`.
 */
export async function classifyCommand(cmd: string, probe: CommandProbe): Promise<CommandAvailability> {
  const ref = parseCommandRef(cmd);
  if (ref === null) return "unknown";

  if (ref.kind === "script") {
    const scripts = await probe.packageScripts();
    if (scripts === null) return "unknown";
    return scripts.has(ref.script) ? "available" : "unavailable";
  }

  const exists = await probe.programExists(ref.program);
  if (exists === null) return "unknown";
  return exists ? "available" : "unavailable";
}

/**
 * Compose the honest, specific refusal for a command already classified
 * `unavailable`. Uses the SAME `parseCommandRef` the classification used, so the
 * message can never describe a different reading of the string than the one that
 * produced the verdict (`[critic/validated-one-string-used-another]`).
 *
 * A command that does not parse at all is described as a program — this is only
 * ever called after `classifyCommand` said `unavailable`, which an unparseable
 * command can never be, so the branch exists solely to keep the function total.
 */
export function describeUnavailableCommand(cmd: string): { reason: CommandUnavailableReason; detail: string } {
  const ref = parseCommandRef(cmd);

  if (ref !== null && ref.kind === "script") {
    return {
      reason: "script-not-declared",
      detail:
        `success_command '${cmd}' cannot run: this project's package.json declares no ` +
        `'${ref.script}' script (${ref.manager} would fail before the check ever executes). ` +
        `Either add the script to the project, declare the command in gate.successCommands, ` +
        `or remove it from the task spec.`,
    };
  }

  const program = ref !== null ? ref.program : cmd;
  return {
    reason: "program-not-on-path",
    detail:
      `success_command '${cmd}' cannot run: '${program}' was not found on PATH and is not a ` +
      `file in the worktree. Install the tool, or remove the command from the task spec.`,
  };
}
