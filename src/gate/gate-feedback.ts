/**
 * Formats the machine gate's failing steps into the document the NEXT round's
 * worker reads (`gate-feedback.md`).
 *
 * Why this exists: a gate RETRY used to tell the worker nothing at all -- the
 * conductor moved the task back to pending, and each step's subprocess output was
 * discarded with only the exit code kept. The worker then re-ran with identical
 * context, reproduced the same diff, and burned its attempt budget before
 * escalating. The exit code is not feedback; the linter's report is.
 *
 * Pure and separately tested rather than inlined into `runGate`, because the
 * clamping rule is a judgement call (what to keep when the output does not fit)
 * and judgement calls in this repo get pinned by tests.
 */

/** One gate step that ran and failed. */
export interface FailedStep {
  /** Human-readable step name, e.g. `profile gate 'phpcs'` / `check command`. */
  label: string;
  exitCode: number;
  /** Whatever the step printed (stdout+stderr), possibly empty. */
  output: string;
}

/** Per-step output budget. Generous enough for a real PHPCS report, small enough
 *  that three failing steps cannot dominate a worker prompt. */
const PER_STEP_LIMIT = 8_000;

/**
 * Remove ANSI escape sequences (SGR colour, cursor moves) from tool output.
 *
 * Found by the LIVE proof rather than by any unit test: PHPCS's `--report=full`
 * detects no terminal but still honours the ruleset's `colors` arg, so the first
 * real `gate-feedback.md` carried `ESC[31mERROR ESC[0m` where the worker needed to
 * read `ERROR`. Control bytes in a prompt are pure noise: they cost tokens, they
 * can confuse the model, and they make the document unreadable to a human
 * inspecting the artifact.
 *
 * Stripped centrally, HERE, rather than by disabling colour on each tool: a gate
 * is an arbitrary operator-authored command, so any future profile would have to
 * remember to pass the right no-colour flag for its own tool — and one that forgot
 * would degrade silently and invisibly. The one place that formats every gate's
 * output is the one place that can guarantee it.
 */
export function stripAnsi(text: string): string {
  // Deliberately narrow: CSI sequences (`ESC [ ... final-byte`), which is what
  // colour and cursor control actually use. A broader "strip every control
  // character" rule would also eat tabs and newlines, destroying the layout of
  // precisely the reports this exists to make readable.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Clamp `text` to `limit` characters, keeping BOTH ends.
 *
 * Head and tail, not a plain prefix: the head holds the first (usually
 * representative) errors, while the tail holds the summary line a tool prints
 * last -- and "3 ERRORS AFFECTING 2 LINES" is often the most orienting line in
 * the whole report. The omission is stated inline; a silent truncation would read
 * as a complete report and quietly mislead the worker about what it must fix.
 */
export function clampOutput(text: string, limit: number = PER_STEP_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 40) / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n${text.slice(-half)}`;
}

/**
 * Build the feedback document, or `null` when nothing failed.
 *
 * `null` is a first-class result the caller must honour by CLEARING any previous
 * document: a "latest value" artifact that survives a run with nothing to say
 * contradicts the real outcome (docs/gotchas/per-round-overwrite-artifact-stale.md).
 */
export function formatGateFeedback(failed: FailedStep[]): string | null {
  if (failed.length === 0) return null;

  const parts = [
    "# Gate failure — previous round",
    "",
    "The machine gate ran your previous diff and rejected it. Each failing step is",
    "reported below with the tool's own output. Fix these before resubmitting.",
    "",
  ];

  for (const step of failed) {
    parts.push(`## ${step.label} — exit ${step.exitCode}`, "");
    const body = step.output.trim();
    // Strip BEFORE clamping, not after: escape bytes are invisible but still cost
    // characters, so clamping first would spend the budget on them -- and a cut
    // landing mid-sequence would leave a fragment in the prompt.
    parts.push(body === "" ? "_(the step produced no output)_" : "```\n" + clampOutput(stripAnsi(body)) + "\n```", "");
  }

  return parts.join("\n");
}
