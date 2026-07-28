/**
 * PURE parsing of a harness command string — no IO, no fs, no PATH lookup.
 *
 * This is the SINGLE place that answers "what does this command string refer
 * to". Two call sites depend on that answer and they MUST get it from here:
 *
 *   - `src/gate/command-availability.ts` — may the gate run this command at all?
 *   - `src/orchestrator/success-command-policy.ts` — may a decomposed spec ask
 *     for this command in the first place?
 *
 * A second parser anywhere is the `[critic/validated-one-string-used-another]`
 * defect shape this repo keeps paying for: the string that was CHECKED and the
 * string that is USED must be interpreted by the same code, or the two answers
 * drift apart silently and neither side looks wrong.
 *
 * Everything here is deliberately CONSERVATIVE. When the token stream cannot be
 * confidently read as a package-manager script invocation, this returns a
 * `program` ref — which downstream resolves to "unknown", i.e. the pre-change
 * behaviour — rather than guessing a script name (Principle 10: an ambiguity
 * resolves toward the outcome that changes the least).
 */

/** A package-manager script invocation, or any other program. */
export type CommandRef =
  | { kind: "script"; manager: string; script: string }
  | { kind: "program"; program: string; args: string[] };

/**
 * Split a shell-style single-line command into `[cmd, ...args]`, guarding the
 * noUncheckedIndexedAccess `[0]`. Moved here from `src/composition/root.ts` (its
 * original home, where the gate/profile runners still call it) so that the
 * splitting the gate EXECUTES and the splitting this module PARSES are literally
 * the same function.
 *
 * KNOWN, PRE-EXISTING LIMITATION (gotcha `[conductor/wiring]`): the split is
 * whitespace-only, not quote-aware — a command or path containing spaces or
 * quotes is split wrongly. That limitation is inherited deliberately rather than
 * fixed here: the gate runs the command through this exact split, so a parser
 * that handled quotes would describe a command the runner never runs.
 */
export function splitCommand(cmd: string): { c: string; a: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const c = parts[0];
  if (!c) throw new Error(`splitCommand: empty command: ${JSON.stringify(cmd)}`);
  return { c, a: parts.slice(1) };
}

/** Package managers whose script-invocation grammar this module understands. */
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Executable suffixes stripped before matching the manager name. Windows resolves
 * `pnpm` to a `pnpm.cmd` shim (gotcha `[node/win-cmd-spawn]`), and an operator may
 * well write the shim name out in full.
 */
const EXE_SUFFIXES = [".cmd", ".exe"];

/**
 * Built-in subcommands of pnpm/yarn/bun that must NEVER be read as a script name.
 * `pnpm add zod` is not "run the `add` script"; misreading it would report a
 * perfectly runnable command as an undeclared script.
 *
 * The list is a floor, not a claim of completeness: a manager subcommand missing
 * from it degrades to "this is a script ref", and a script by that name almost
 * certainly is not declared -- so the failure lands on the conservative side for
 * the gate (a named, honest refusal) and on the deny-by-default side for the
 * composer filter. It is NOT applied to npm, which has no bare-script form at all.
 */
const MANAGER_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "exec",
  "dlx",
  "up",
  "update",
  "ci",
  "init",
  "why",
  "list",
  "ls",
  "link",
  "unlink",
  "pack",
  "publish",
  "audit",
  "store",
  "licenses",
  "create",
  "x",
]);

/**
 * npm subcommands that DO run a package script of the same name. Everything else
 * after a bare `npm` is an npm subcommand (`ci`, `install`, `exec`, ...), never a
 * script -- npm has no `npm <script>` shorthand.
 */
const NPM_IMPLICIT_SCRIPTS = new Set(["test", "start"]);

/** The `run` forms every supported manager accepts. */
const RUN_TOKENS = new Set(["run", "run-script"]);

/**
 * The manager name a program token refers to, or `null` when it names no known
 * manager. Takes the basename (both separators, because a Windows path may reach
 * us on a POSIX host and vice versa), folds case, and strips one `.cmd`/`.exe`.
 *
 * Case folding is applied on EVERY platform, not only for Windows-shaped input.
 * That is a deliberate simplification: a POSIX binary literally named `NPM` that
 * is not npm does not exist in practice, and the only cost of the fold would be
 * classifying such a command as a script ref -- which resolves to a named refusal
 * or a drop, never to something being let through unchecked.
 */
function managerName(token: string): string | null {
  const base = token.split(/[/\\]/).pop() ?? "";
  let name = base.toLowerCase();
  for (const suffix of EXE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return MANAGERS.has(name) ? name : null;
}

/** True for a token that cannot be a subcommand or a script name. */
function isFlag(token: string): boolean {
  return token.startsWith("-");
}

/**
 * Read a command string as either a package-manager script invocation or a plain
 * program invocation. `null` means the string is empty/whitespace-only -- there is
 * nothing to refer to.
 *
 * The script-name rules, and why each one refuses rather than guesses:
 *
 *   - `npm run <name>` / `npm run-script <name>` / `npm test` / `npm start`
 *     name a script. Any OTHER bare `npm <token>` is an npm subcommand.
 *   - `pnpm|yarn run <name>`, and the bare `pnpm|yarn <name>` shorthand, name a
 *     script UNLESS `<name>` is a known manager subcommand.
 *   - `bun run <name>` names a script; a bare `bun <token>` does not (bun's bare
 *     form collides with its own subcommands, so it is not read as a script).
 *   - A `-`-prefixed token in a position where a subcommand or script name is
 *     expected (right after the manager, or right after `run`) makes the whole
 *     thing a program ref: `npm --prefix ./sub run build` targets a DIFFERENT
 *     package.json, and pretending otherwise would check the wrong manifest.
 *     Tokens AFTER the resolved script name are the script's own arguments and
 *     cannot change which script is named, so they are ignored.
 *   - A missing name (`npm run`) is a program ref.
 */
export function parseCommandRef(cmd: string): CommandRef | null {
  if (cmd.trim() === "") return null;

  const { c, a } = splitCommand(cmd);
  const asProgram: CommandRef = { kind: "program", program: c, args: a };

  const manager = managerName(c);
  if (manager === null) return asProgram;

  const first = a[0];
  if (first === undefined || isFlag(first)) return asProgram;

  if (RUN_TOKENS.has(first)) {
    const name = a[1];
    if (name === undefined || isFlag(name)) return asProgram;
    return { kind: "script", manager, script: name };
  }

  if (manager === "npm") {
    return NPM_IMPLICIT_SCRIPTS.has(first) ? { kind: "script", manager, script: first } : asProgram;
  }

  // bun has no bare-script form here (see the doc comment) -- only `bun run`.
  if (manager === "bun") return asProgram;

  // pnpm / yarn bare shorthand.
  return MANAGER_SUBCOMMANDS.has(first) ? asProgram : { kind: "script", manager, script: first };
}
