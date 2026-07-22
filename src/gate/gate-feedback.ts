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
 *
 * Task 5 (`docs/superpowers/plans/2026-07-22-line-scoped-profile-gates.md`) adds a
 * second failure shape: a `report: checkstyle` profile gate's `FailedStep` carries
 * STRUCTURED findings (`FilteredFinding[]`) instead of raw tool output. Those are
 * rendered here too, as a readable list, through the exact same clamps this file
 * already enforces on raw output -- a finding list is just as unbounded as raw
 * output was (a linter can report thousands of findings), so it gets no exemption
 * from the per-step clamp or the global document cap.
 */
import type { FilteredFinding } from "./finding-filter.js";

/** One gate step that ran and failed. */
export interface FailedStep {
  /** Human-readable step name, e.g. `profile gate 'phpcs'` / `check command`. */
  label: string;
  /** `null` when the step has no real subprocess exit code to report (e.g.
   *  agent-ci returns `{ green, reasons }`, not an exit code) -- render that
   *  honestly rather than inventing a fake number that looks like a real one. */
  exitCode: number | null;
  /** Whatever the step printed (stdout+stderr), possibly empty. Ignored for
   *  rendering when `findings` is present (see below); kept required so every
   *  existing caller/test that builds a plain-output step keeps compiling
   *  unchanged. */
  output: string;
  /** Structured, already diff-filtered findings for a `report: checkstyle`
   *  profile gate (`docs/superpowers/plans/2026-07-22-line-scoped-profile-
   *  gates.md`, Task 5). When present, `formatGateFeedback` renders THESE --
   *  as a readable `path:line  message  [source]` list -- instead of `output`.
   *  The worker must never be shown the tool's raw Checkstyle XML: it is a
   *  machine format the worker cannot act on and it costs tokens for nothing.
   *  Optional so every step for a gate without `report` (the overwhelming
   *  majority: check command, success_command, agent-ci, and a profile gate
   *  that declares no report format) keeps rendering byte-identically to
   *  before this field existed. */
  findings?: FilteredFinding[];
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
/** The inline notice that a clamp dropped characters. One definition, so the
 *  budget reserved for it and the text actually emitted can never disagree. */
function renderOmissionMarker(dropped: number): string {
  return `\n\n... [${dropped} characters omitted] ...\n\n`;
}

export function clampOutput(text: string, limit: number = PER_STEP_LIMIT): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return ""; // no budget at all -- nothing can be shown

  // Reserve the marker's REAL length, not a fixed 40. The marker embeds the
  // dropped-character count, so its width grows with the digits of that number --
  // a 100 MB input needs 9 digits where 40 chars assumed room for far fewer, and
  // the result then ran one character over the limit it promises (round-2 critic
  // finding). `text.length` is the largest `dropped` can ever be, so sizing the
  // marker with it is the safe over-estimate.
  const markerWidth = renderOmissionMarker(text.length).length;
  const half = Math.floor((limit - markerWidth) / 2);
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
  return `${text.slice(0, half)}${renderOmissionMarker(dropped)}${text.slice(-half)}`;
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
 * Render ONE finding as a single readable line: `path:line  message
 * [source]`, or `path  message  [source]` when the finding has no line
 * number. Never `path:null` and never an invented line -- `finding-filter.ts`
 * hands this a real `number | null`, and inventing a number here would be a
 * lie a worker would act on (the same discipline `checkstyle.ts` applies at
 * parse time).
 *
 * This -- not the tool's raw Checkstyle XML -- is what the worker must be
 * shown: the machine format is noise it cannot act on and it costs tokens the
 * worker's prompt budget cannot spare.
 */
function renderFinding(f: FilteredFinding): string {
  const loc = f.line === null ? f.file : `${f.file}:${f.line}`;
  return `${loc}  ${f.message}  [${f.source}]`;
}

/** The label that opens the unattributed group. Defined once so the group
 *  test in `formatGateFeedback`'s own tests and the text actually emitted can
 *  never drift apart. */
const UNATTRIBUTED_GROUP_LABEL =
  "-- UNATTRIBUTED findings (the harness could not map these to a changed file; kept, not dropped -- fail-closed) --";

/**
 * Render a report gate's SURVIVING findings as the readable list a worker
 * prompt can act on.
 *
 * Unattributed findings (`unattributed: true` -- `finding-filter.ts` could not
 * map the tool's path to any file this diff touched, so it kept the finding
 * rather than silently dropping a possible real violation) are rendered in
 * their OWN clearly-labelled group, never interleaved with attributed ones.
 * The two are qualitatively different -- one the worker definitely owns,
 * because it landed on a line the worker added; the other is only a
 * SUSPECTED violation the harness could not place, which both the worker and
 * the operator need to be able to see is a different kind of claim. Flattening
 * them together would hide that the fail-closed path fired at all.
 */
function renderFindings(findings: FilteredFinding[]): string {
  const attributed = findings.filter((f) => !f.unattributed);
  const unattributed = findings.filter((f) => f.unattributed);

  const blocks: string[] = [];
  if (attributed.length > 0) {
    blocks.push(attributed.map(renderFinding).join("\n"));
  }
  if (unattributed.length > 0) {
    blocks.push([UNATTRIBUTED_GROUP_LABEL, ...unattributed.map(renderFinding)].join("\n"));
  }
  return blocks.join("\n\n");
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
  let rendered = 0;

  /** The document as it would actually be emitted. Measuring the JOINED string,
   *  rather than summing each step's length, is what makes the cap honest: the
   *  `"\n"` separators `join` inserts between parts are real characters the
   *  summing approach did not count, so the emitted document could exceed
   *  TOTAL_DOC_LIMIT while the bookkeeping believed it had not (round-2 critic
   *  finding). The step count here is tiny, so re-joining per step is free. */
  const emitted = (extra: string[] = []): string => [...parts, ...extra].join("\n");

  for (const step of failed) {
    const label = clampOutput(step.label, LABEL_LIMIT);
    const exitLabel = step.exitCode === null ? "(no subprocess exit code)" : `exit ${step.exitCode}`;
    // Strip BEFORE clamping, not after: escape bytes are invisible but still cost
    // characters, so clamping first would spend the budget on them -- and a cut
    // landing mid-sequence would leave a fragment in the prompt.
    //
    // Emptiness is judged AFTER stripping, not before: output consisting only of
    // colour codes is non-empty as bytes but carries no information, and testing
    // the raw text produced an empty fenced block instead of saying plainly that
    // the step printed nothing (round-2 critic finding).
    //
    // A `findings`-bearing step renders from `renderFindings`, NOT `step.output`
    // -- structured findings are the whole point of Task 5, and showing both
    // would either duplicate the same violations or (worse) show the raw
    // Checkstyle XML the worker must never see. `stripAnsi` does not apply to
    // rendered findings: they come from decoded/unescaped XML attributes, not a
    // terminal-aware tool's stdout, so there is nothing for it to strip.
    const rawBody = step.findings !== undefined ? renderFindings(step.findings) : stripAnsi(step.output);
    const cleanBody = clampOutput(rawBody).trim();
    const fence = fenceFor(cleanBody);
    const bodyBlock = cleanBody === "" ? "_(the step produced no output)_" : `${fence}\n${cleanBody}\n${fence}`;
    const stepParts = [`## ${label} — ${exitLabel}`, "", bodyBlock, ""];

    // Global cap: stop BEFORE adding a step that would push the document over
    // budget, and say explicitly how many steps were left out -- a silently
    // truncated list would read to the worker as "everything is fixed", which
    // is the opposite of the truth. Always render at least the first step, even
    // if it alone is large, so the cap never produces an empty document. The
    // omission footer is measured as part of the candidate, not appended
    // afterwards unchecked.
    if (rendered > 0) {
      const remaining = failed.length - rendered;
      const footer = `_(${remaining} further failing step${remaining === 1 ? "" : "s"} omitted -- document size cap)_`;
      if (emitted([...stepParts, footer, ""]).length > TOTAL_DOC_LIMIT) {
        parts.push(footer, "");
        return parts.join("\n");
      }
    }

    parts.push(...stepParts);
    rendered++;
  }

  return emitted();
}
