import { parseCommandRef } from "../util/command-ref.js";

/**
 * Half (a) of the s61 fix: the composer may only ask for commands the PROJECT
 * declares.
 *
 * In the s60 corpus run the LLM decomposition invented `pnpm lint:php:changes`,
 * put it in a spec's `success_commands`, and a correct task was RETRIED three
 * times and then quarantined on the resulting exit 1. Half (b) (the gate's
 * availability pre-flight) stops that from being read as a worker defect; this
 * half stops the invented command from ever entering the queue.
 *
 * Pure — no fs, no IO. The declaration is supplied by the caller.
 */

/** What this project declares a task may run. */
export interface CommandDeclaration {
  /** Script names from the trusted root's package.json. */
  scripts: string[];
  /** Operator-declared command strings (`gate.checkCommand` + `gate.successCommands`). */
  configured: string[];
  /**
   * FALSE when the script set could not be read at all. Distinct from an empty
   * `scripts` array, which is a real answer ("this project declares none") --
   * `docs/gotchas/boolean-whose-no-means-two-things.md`.
   */
  scriptsKnown: boolean;
}

export interface SuccessCommandFilterResult {
  /** Commands allowed through, in their ORIGINAL text and original order. */
  kept: string[];
  /** Commands denied, in their original text. Never an error -- see below. */
  dropped: string[];
  /** True when the filter could not run at all (`scriptsKnown === false`) and every
   *  command was kept unfiltered. The caller MUST report this: a filter that silently
   *  did not run looks exactly like a filter that found nothing to drop. */
  filterSkipped: boolean;
}

/**
 * The ONE normalization used for BOTH sides of the operator-declared comparison.
 * Keeping it in a single exported function is the point: a check that folds
 * whitespace one way and a lookup that folds it another is this repo's most
 * recurring defect shape (`docs/gotchas/validated-one-string-used-another.md`).
 */
export function normalizeCommandText(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Filter a spec's `success_commands` down to what this project actually declares.
 *
 * A command is ALLOWED iff either:
 *   - its normalized text exactly matches an operator-declared string, or
 *   - it is a package-manager script ref whose script name the project declares.
 *
 * Everything else is DROPPED. Dropping, not rejecting: a hallucinated command must
 * not be able to fail a whole decomposition, because that would trade the s60
 * failure (a lost task) for the same loss by a different route. The caller reports
 * every drop (WARN + digest) so the discard is never silent.
 *
 * The one exception is FAIL-OPEN AND LOUD: when `scriptsKnown` is false we cannot
 * tell a real command from an invented one, so every command is kept and
 * `filterSkipped` is set. Denying on an unreadable package.json would strip real
 * checks off every task in the project; half (b) is the backstop that still refuses
 * to RUN anything that turns out not to exist.
 */
export function filterSuccessCommands(
  commands: string[],
  declaration: CommandDeclaration,
): SuccessCommandFilterResult {
  if (!declaration.scriptsKnown) {
    return { kept: [...commands], dropped: [], filterSkipped: true };
  }

  const configured = new Set(declaration.configured.map(normalizeCommandText));
  const scripts = new Set(declaration.scripts);

  const kept: string[] = [];
  const dropped: string[] = [];

  for (const cmd of commands) {
    if (isAllowed(cmd, configured, scripts)) kept.push(cmd);
    else dropped.push(cmd);
  }

  return { kept, dropped, filterSkipped: false };
}

function isAllowed(cmd: string, configured: Set<string>, scripts: Set<string>): boolean {
  if (configured.has(normalizeCommandText(cmd))) return true;
  const ref = parseCommandRef(cmd);
  // A blank command parses to null and names nothing -- deny-by-default covers it.
  if (ref === null || ref.kind !== "script") return false;
  return scripts.has(ref.script);
}
