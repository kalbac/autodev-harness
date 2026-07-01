/**
 * Anti-drift check — parity with `woodev_framework/tools/autodev/anti-drift.ps1`.
 *
 * Every M commits the conductor calls this. It does NOT compare commit
 * titles (too shallow to catch real drift). It feeds a critic model the
 * PHASE INTENT extracted from a configurable intent-source doc PLUS the
 * actual DIFFS of recent done-tasks, and asks: "does this work advance the
 * phase's stated intent, or has it wandered — satisfied the letter of the
 * tasks while missing their purpose?"
 *
 * Appends one timestamped verdict line (ON-TRACK/DRIFT/UNCERTAIN) to
 * digest.md via the injected `appendDigest` dependency.
 *
 * Fail-closed: if the model call fails or its output has no recognized
 * verdict prefix, this degrades to UNCERTAIN — it NEVER emits a false
 * ON-TRACK on failure (parity anti-drift.ps1:90-103).
 */

export interface AntiDriftConfig {
  /** Path to the intent-source doc, or null if none configured. */
  intentSource: string | null;
  /** Section headers to regex-extract from the intent source. Empty array = feed the WHOLE file. */
  headers: string[];
  /** Model tier for the anti-drift critic (fixed 'sonnet' in the PS default). */
  model: string;
}

export interface AntiDriftInput {
  sinceRef: string; // e.g. "HEAD~5"
  commitsSinceLast: number; // window size, shown in the digest line
}

export interface AntiDriftDeps {
  /** Read a text file; return null if it does not exist. */
  readFile: (path: string) => Promise<string | null>;
  /** `git log <sinceRef>..HEAD --grep=(autodev) --oneline` text. */
  gitLog: (sinceRef: string) => Promise<string>;
  /** `git diff <sinceRef>..HEAD` text. */
  gitDiff: (sinceRef: string) => Promise<string>;
  /** Run the model with the built prompt; returns exit code + combined output. */
  runModel: (model: string, prompt: string) => Promise<{ exitCode: number; output: string }>;
  /** Append exactly one line to digest.md. */
  appendDigest: (line: string) => Promise<void>;
  /** Injected clock for a deterministic timestamp. */
  now: () => Date;
  log?: (level: string, message: string) => void;
}

const VERDICT_LINE_RE = /^\s*(ON-TRACK|DRIFT|UNCERTAIN):.*$/im;

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the PHASE INTENT from the configured intent-source doc.
 *
 * - No `intentSource` configured -> a fixed placeholder.
 * - `intentSource` configured but missing on disk -> a fixed placeholder.
 * - `headers` empty -> feed the whole file (trimmed).
 * - `headers` non-empty -> regex-extract each `## <header>` section up to
 *   the next `## ` line (or end of file), concatenated in header order and
 *   joined by a blank line. Parity regex: `(?s)##\s*<H>(.*?)(\r?\n##\s)`.
 */
async function getIntent(cfg: AntiDriftConfig, readFile: AntiDriftDeps["readFile"]): Promise<string> {
  if (cfg.intentSource === null) {
    return "(no intent source configured)";
  }

  const text = await readFile(cfg.intentSource);
  if (text === null) {
    return "(intent source not found)";
  }

  if (cfg.headers.length === 0) {
    return text.trim();
  }

  const sections: string[] = [];
  for (const header of cfg.headers) {
    const escaped = escapeRegExp(header);
    // Mirrors the PS regex `(?s)##\s*<H>(.*?)(\r?\n##\s)`: dotall so `.`
    // matches newlines, non-greedy capture up to the next `## ` heading
    // (or end of file, via an alternation).
    const re = new RegExp(`##\\s*${escaped}([\\s\\S]*?)(?:\\r?\\n##\\s|$)`, "");
    const match = re.exec(text);
    if (match && match[1] !== undefined) {
      const section = match[1].trim();
      if (section.length > 0) {
        sections.push(section);
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Build the adversarial anti-drift prompt (parity anti-drift.ps1:60-77).
 */
function buildPrompt(intent: string, log: string, diff: string): string {
  return [
    "You are an anti-drift reviewer. You are given (1) the PHASE INTENT of an in-flight program,",
    "and (2) the actual code DIFFS of the most recent completed tasks. Judge ONE thing: does the",
    "work advance the phase's STATED INTENT, or has it wandered -- satisfied the letter of the",
    "tasks while missing their purpose? Do NOT judge by commit titles; judge by the diffs.",
    "",
    "Answer in EXACTLY one line, starting with one of: ON-TRACK: | DRIFT: | UNCERTAIN:",
    "followed by a single sentence of justification grounded in the diffs vs the intent.",
    "",
    "===== PHASE INTENT =====",
    intent,
    "",
    "===== RECENT DONE-TASK COMMITS =====",
    log,
    "",
    "===== RECENT DONE-TASK DIFFS =====",
    diff,
  ].join("\n");
}

/** Zero-padded `yyyy-MM-dd HH:mm:ss` in local time. */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

/** Collapse newlines to spaces and clip to `maxLength` chars. */
function firstChars(text: string, maxLength: number): string {
  const collapsed = text.replace(/[\r\n]+/g, " ").trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

/**
 * Run the anti-drift check: extract intent, gather recent commits/diffs,
 * ask the model for a verdict, append exactly one digest line, and return
 * the verdict line (without the digest timestamp/window prefix).
 */
export async function runAntiDrift(
  input: AntiDriftInput,
  cfg: AntiDriftConfig,
  deps: AntiDriftDeps,
): Promise<string> {
  // safeLog swallows a throwing logger so the fail-closed degradation paths
  // below (model-threw / digest-failed) can never be re-thrown by a broken
  // logger — the UNCERTAIN verdict + its single digest line must always win.
  const safeLog = (level: string, message: string): void => {
    try {
      deps.log?.(level, message);
    } catch {
      // a broken logger must never break the anti-drift verdict path
    }
  };

  const intent = await getIntent(cfg, deps.readFile);
  const log = (await deps.gitLog(input.sinceRef)).trim();
  const diff = await deps.gitDiff(input.sinceRef);
  const prompt = buildPrompt(intent, log, diff);

  safeLog("INFO", `Anti-drift: invoking model ${cfg.model} ...`);

  // Parity anti-drift.ps1:82-88 — the model invocation is wrapped so a thrown
  // call (e.g. the model exe is missing) degrades to exit 1 rather than
  // crashing the loop. The branch below turns that into an UNCERTAIN
  // could-not-run verdict — never a false ON-TRACK, and a digest line is still
  // written.
  let exitCode: number;
  let output: string;
  try {
    const r = await deps.runModel(cfg.model, prompt);
    exitCode = r.exitCode;
    output = r.output;
  } catch (err) {
    exitCode = 1;
    output = "";
    safeLog("WARN", `Anti-drift: model invocation threw (${String(err)}); degrading to UNCERTAIN.`);
  }

  let driftLine: string;
  if (exitCode === 0 && output) {
    const match = VERDICT_LINE_RE.exec(output);
    if (match) {
      driftLine = match[0].trim();
    } else {
      driftLine = `UNCERTAIN: model output had no ON-TRACK/DRIFT/UNCERTAIN prefix -- ${firstChars(output, 120)}`;
    }
  } else {
    driftLine = `UNCERTAIN: anti-drift could not run (model exit ${exitCode}) -- not asserting on-track.`;
  }

  safeLog("INFO", `Anti-drift result: ${driftLine}`);

  const stamp = formatTimestamp(deps.now());
  const digestEntry = `[${stamp}] [anti-drift] (window: ${input.commitsSinceLast} commits) ${driftLine}`;
  // Parity anti-drift.ps1:114-118 — a digest write failure is logged, never
  // fatal: the returned verdict line (which the conductor routes on) must
  // survive a scratch-file I/O hiccup.
  try {
    await deps.appendDigest(digestEntry);
  } catch (err) {
    safeLog("WARN", `Anti-drift: could not write digest line: ${String(err)}`);
  }

  return driftLine;
}
