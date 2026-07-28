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
  /**
   * Whether the OPERATOR declared this exact command (`gate.checkCommand` /
   * `gate.successCommands`). Optional — absent means "no declaration is known", which
   * reproduces the pre-`adr/009` behaviour exactly.
   *
   * A declared command is never classified `unavailable`: the operator's declaration IS
   * the oracle (`adr/009`), and this check exists to catch what the COMPOSER invented,
   * not to second-guess the operator. Without it, this module has to be a complete model
   * of every package manager's subcommand set to avoid false refusals -- `pnpm config get
   * registry` reads as a missing `config` SCRIPT unless `config` is on a hand-maintained
   * list -- and a false refusal escalates a task over a command that runs perfectly well.
   * Found by the review gate, s61.
   */
  isOperatorDeclared?(cmd: string): boolean;
}

/** Why a command was classified `unavailable` — carried on the error so the conductor's
 *  escalation can say which of the two things is missing. */
export type CommandUnavailableReason = "script-not-declared" | "program-not-on-path";

/** A classification plus, when it is `unavailable`, WHICH thing is missing. The cause
 *  travels with the verdict because only the code that asked the probes knows it. */
export interface CommandAvailabilityReport {
  availability: CommandAvailability;
  unavailable?: { reason: CommandUnavailableReason; detail: string };
}

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
 *   - operator-declared                   -> `unknown` (never refused; see `CommandProbe`)
 *   - unparseable (empty/whitespace)      -> `unknown`
 *   - script ref, manager not on PATH     -> `unavailable`
 *   - script ref, scripts unreadable      -> `unknown`
 *   - script ref, name present/absent     -> `available` / `unavailable`
 *   - program ref, probe true/false/null  -> `available` / `unavailable` / `unknown`
 *
 * A script ref asks BOTH questions, in this order: `pnpm run lint` with a declared
 * `lint` script is still unrunnable if `pnpm` itself is not installed, and answering
 * `available` there sends the command to a spawn that fails for a reason this module
 * exists to name (review gate, s61). The manager is asked FIRST because its absence
 * explains the failure completely, whatever the script set says.
 *
 * Which question to ask is decided ONCE, by `parseCommandRef` — never re-derived here.
 */
export async function classifyCommand(cmd: string, probe: CommandProbe): Promise<CommandAvailability> {
  return (await inspectCommand(cmd, probe)).availability;
}

/**
 * The classification AND, when it is `unavailable`, which of the two things is missing.
 *
 * One function answers both, because they are one answer: a caller that classified with
 * these probe results and then described the failure from the string alone could report
 * "no such script" for a command whose real problem is an uninstalled package manager —
 * the check-one-thing/report-another shape of
 * `docs/gotchas/validated-one-string-used-another.md`. `classifyCommand` above is the
 * thin projection for callers that only need the verdict.
 */
export async function inspectCommand(cmd: string, probe: CommandProbe): Promise<CommandAvailabilityReport> {
  if (probe.isOperatorDeclared?.(cmd) === true) return { availability: "unknown" };

  const ref = parseCommandRef(cmd);
  if (ref === null) return { availability: "unknown" };

  if (ref.kind === "script") {
    const managerExists = await probe.programExists(ref.manager);
    if (managerExists === false) {
      return { availability: "unavailable", unavailable: describeMissingProgram(cmd, ref.manager) };
    }
    const scripts = await probe.packageScripts();
    // A `null` manager probe is NOT folded into either answer: the script question can
    // still settle this on its own, and only when BOTH are unsettled is the verdict
    // `unknown` ([logic/ambiguous-false]).
    if (scripts === null) return { availability: "unknown" };
    if (!scripts.has(ref.script)) {
      return { availability: "unavailable", unavailable: describeMissingScript(cmd, ref.manager, ref.script) };
    }
    return { availability: managerExists === null ? "unknown" : "available" };
  }

  const exists = await probe.programExists(ref.program);
  if (exists === null) return { availability: "unknown" };
  return exists
    ? { availability: "available" }
    : { availability: "unavailable", unavailable: describeMissingProgram(cmd, ref.program) };
}

function describeMissingScript(
  cmd: string,
  manager: string,
  script: string,
): { reason: CommandUnavailableReason; detail: string } {
  return {
    reason: "script-not-declared",
    detail:
      `success_command '${cmd}' cannot run: this project's package.json declares no ` +
      `'${script}' script (${manager} would fail before the check ever executes). ` +
      `Either add the script to the project, declare the command in gate.successCommands, ` +
      `or remove it from the task spec.`,
  };
}

function describeMissingProgram(cmd: string, program: string): { reason: CommandUnavailableReason; detail: string } {
  return {
    reason: "program-not-on-path",
    detail:
      `success_command '${cmd}' cannot run: '${program}' was not found on PATH and is not a ` +
      `file in the worktree. Install the tool, declare the command in gate.successCommands, ` +
      `or remove it from the task spec.`,
  };
}
