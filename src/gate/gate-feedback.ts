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
  /** `null` when the step has no real subprocess exit code to report (e.g.
   *  agent-ci returns `{ green, reasons }`, not an exit code) -- render that
   *  honestly rather than inventing a fake number that looks like a real one. */
  exitCode: number | null;
  /** Whatever the step printed (stdout+stderr), possibly empty. */
  output: string;
}

/** Per-step output budget. Generous enough for a real PHPCS report, small enough
 *  that three failing steps cannot dominate a worker prompt. */
const PER_STEP_LIMIT = 8_000;

/** Per-step LABEL budget. A `success_command` label embeds the whole command
 *  string, so the label is unbounded exactly like the output is -- clamp it too. */
const LABEL_LIMIT = 200;

/** Total document budget. PER_STEP_LIMIT bounds one step, but the NUMBER of
 *  steps is unbounded (many success_commands, several profile gates); without
 *  this the document is still unbounded overall and it goes straight into a
 *  worker prompt. */
const TOTAL_DOC_LIMIT = 40_000;

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
  //
  // `\x1b` rather than a literal ESC byte in the source: identical match, but a
  // raw control byte sitting in this file does not survive being pasted into a
  // prompt and reads, on a plain-text scan, as if there were no ESC handling
  // here at all -- `\x1b` says what it means in plain ASCII.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
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
  if (limit <= 0) return ""; // no budget at all -- nothing can be shown

  const half = Math.floor((limit - 40) / 2);
  if (half <= 0) {
    // Below ~40-42 chars there is no room for a head+tail split AND the
    // "[N characters omitted]" marker text -- the head+tail shape breaks down
    // (and `half === 0` would additionally make `text.slice(-half)` slice from
    // index 0, i.e. return the WHOLE text, since `slice(-0)` is `slice(0)`).
    // Fall back to a bare head-only slice: it still honours "at most `limit`
    // chars" for every input, which is the one thing this function promises.
    return text.slice(0, limit);
  }

  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n${text.slice(-half)}`;
}

/**
 * Choose a fence at least one backtick longer than the longest backtick run in
 * `body`, per the standard CommonMark rule -- so the body's own ``` runs (a
 * linter that echoes a markdown/diff snippet, for instance) can never close the
 * fence early and let the rest of the document escape as prompt structure.
 */
function fenceFor(body: string): string {
  const runs = body.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
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
  let used = parts.join("\n").length;
  let rendered = 0;

  for (const step of failed) {
    const label = clampOutput(step.label, LABEL_LIMIT);
    const exitLabel = step.exitCode === null ? "(no subprocess exit code)" : `exit ${step.exitCode}`;
    const body = step.output.trim();
    // Strip BEFORE clamping, not after: escape bytes are invisible but still cost
    // characters, so clamping first would spend the budget on them -- and a cut
    // landing mid-sequence would leave a fragment in the prompt.
    const cleanBody = body === "" ? "" : clampOutput(stripAnsi(body));
    const fence = fenceFor(cleanBody);
    const bodyBlock = body === "" ? "_(the step produced no output)_" : `${fence}\n${cleanBody}\n${fence}`;
    const stepParts = [`## ${label} — ${exitLabel}`, "", bodyBlock, ""];
    const stepText = stepParts.join("\n");

    // Global cap: stop BEFORE adding a step that would push the document over
    // budget, and say explicitly how many steps were left out -- a silently
    // truncated list would read to the worker as "everything is fixed", which
    // is the opposite of the truth. Always render at least the first step, even
    // if it alone is large, so the cap never produces an empty document.
    if (rendered > 0 && used + stepText.length > TOTAL_DOC_LIMIT) {
      const remaining = failed.length - rendered;
      parts.push(`_(${remaining} further failing step${remaining === 1 ? "" : "s"} omitted -- document size cap)_`, "");
      return parts.join("\n");
    }

    parts.push(...stepParts);
    used += stepText.length;
    rendered++;
  }

  return parts.join("\n");
}
