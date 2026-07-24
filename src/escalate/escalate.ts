/**
 * Human escalation artifact + best-effort delivery — parity: `escalate.ps1`
 * (parity spec §3 "escalations/<id>.md", §8). The durable artifact (the
 * markdown file) and the delivery channel (Telegram or the outbox) are both
 * best-effort: this module never throws. Moving the owning task in the
 * blackboard BEFORE writing the escalation is the conductor's responsibility,
 * not this module's — this module only writes the artifact and attempts
 * delivery.
 */

export type EscalationType =
  | "needs-guard"
  | "disagreement"
  | "constitution"
  | "uncertain"
  | "poison"
  | "blocked"
  | "dirty-file"
  | "drift"
  | "critic-unavailable";

export interface EscalationInput {
  id: string;
  reason: string;
  type: EscalationType;
  taskId: string;
  title: string;
  what: string;
  decision: string;
  optionA: string;
  optionB: string;
  costOfWrong: string;
  evidence: string;
}

export interface EscalateDeps {
  /** Absolute path to the escalations dir (e.g. <repo>/.autodev/escalations). */
  escalationsDir: string;
  /** Write (overwrite) a file. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Append to a file (create if missing). */
  appendFile: (path: string, content: string) => Promise<void>;
  /** Injected env reader — return undefined when unset. */
  env: (name: string) => string | undefined;
  /** Injected best-effort Telegram POST. Optional; if absent, delivery always goes to the outbox. */
  telegramPost?: (token: string, chat: string, text: string) => Promise<void>;
  /** Optional structured logger. */
  log?: (level: string, message: string) => void;
}

export interface EscalateResult {
  path: string;
  artifactWritten: boolean;
  delivery: "telegram" | "outbox";
}

/** Builds the artifact body exactly like `escalate.ps1:49-68`. */
function buildBody(input: EscalationInput): string {
  const lines = [
    `# ESCALATION ${input.id} -- ${input.reason}`,
    "",
    `**Task:** ${input.taskId} -- ${input.title}`,
    `**Type:** ${input.type}`,
    `**What happened:** ${input.what}`,
    `**Decision you need to make:** ${input.decision}`,
    `**Option A:** ${input.optionA}`,
    `**Option B:** ${input.optionB}`,
    `**Cost of being wrong:** ${input.costOfWrong}`,
    "",
    "**Evidence:**",
    "```",
    input.evidence,
    "```",
    "",
    "**Reply:** `A` / `B` -- structured choice only. Free-form text is recorded for",
    "context but is NEVER executed as a worker instruction (Telegram is an injection",
    "surface). Until you reply, this task is parked; other tasks continue.",
  ];
  return lines.join("\n");
}

const ESCALATION_TYPES: readonly EscalationType[] = [
  "needs-guard",
  "disagreement",
  "constitution",
  "uncertain",
  "poison",
  "blocked",
  "dirty-file",
  "drift",
  "critic-unavailable",
];

function isEscalationType(value: string): value is EscalationType {
  return (ESCALATION_TYPES as readonly string[]).includes(value);
}

/**
 * Splits `text` on the FIRST occurrence of `sep` only -- `null` if `sep` is absent.
 * Used for the header (`<id> -- <reason>`) and Task (`<taskId> -- <title>`) lines,
 * whose second half (`reason` / `title`) may itself contain ` -- `.
 */
function splitFirst(text: string, sep: string): [string, string] | null {
  const idx = text.indexOf(sep);
  if (idx < 0) return null;
  return [text.slice(0, idx), text.slice(idx + sep.length)];
}

/**
 * Value of the first line starting with `prefix` (prefix stripped), or `null` if no
 * such line exists. Callers pass the pre-evidence slice (see `parseEscalation`), so
 * evidence content that happens to start with the same prefix (`**Bold:**` etc.) can
 * never be matched here -- evidence itself is deliberately NOT extracted this way
 * (see the fenced-block extraction below).
 */
function findFieldLine(lines: readonly string[], prefix: string): string | null {
  const line = lines.find((l) => l.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length);
}

/**
 * Inverse of `buildBody`: parses one escalation artifact back into its
 * `EscalationInput`. Tolerant by design -- ANY malformed or missing field returns
 * `null` rather than throwing or returning a partial object, so a caller (the
 * `GET /escalations/:id` API handler) can treat "unparseable" the same as "not
 * found" without a try/catch. Field lines are matched by fixed `buildBody` prefixes;
 * `evidence` is the one multi-line field and is extracted purely from the fenced
 * code block after the `**Evidence:**` line, never by prefix matching, so evidence
 * containing lines that look like other fields (`**Bold:**`), backticks, or
 * `{`/`}` cannot corrupt the other fields or itself.
 *
 * The evidence header (`**Evidence:**`) is located FIRST, before any other field is
 * read, and every field lookup below (including the `# ESCALATION` header line)
 * runs only against the pre-evidence slice `lines.slice(0, evidenceHeaderIdx)`. A
 * well-formed artifact is unaffected -- every real field line already sits before
 * `**Evidence:**` -- but a MALFORMED artifact that is missing a real field can no
 * longer "borrow" a look-alike line (e.g. `**Option A:** ...`) that happens to
 * appear inside the evidence block itself.
 */
export function parseEscalation(markdown: string): EscalationInput | null {
  const lines = markdown.split(/\r?\n/);

  const evidenceHeaderIdx = lines.findIndex((l) => l === "**Evidence:**");
  if (evidenceHeaderIdx < 0) return null;
  const fieldLines = lines.slice(0, evidenceHeaderIdx);

  const HEADER_PREFIX = "# ESCALATION ";
  if (fieldLines.length === 0 || !fieldLines[0]!.startsWith(HEADER_PREFIX)) return null;

  const headerSplit = splitFirst(fieldLines[0]!.slice(HEADER_PREFIX.length), " -- ");
  if (headerSplit === null) return null;
  const [id, reason] = headerSplit;

  const taskRaw = findFieldLine(fieldLines, "**Task:** ");
  if (taskRaw === null) return null;
  const taskSplit = splitFirst(taskRaw, " -- ");
  if (taskSplit === null) return null;
  const [taskId, title] = taskSplit;

  const typeRaw = findFieldLine(fieldLines, "**Type:** ");
  if (typeRaw === null || !isEscalationType(typeRaw)) return null;
  const type = typeRaw;

  const what = findFieldLine(fieldLines, "**What happened:** ");
  if (what === null) return null;

  const decision = findFieldLine(fieldLines, "**Decision you need to make:** ");
  if (decision === null) return null;

  const optionA = findFieldLine(fieldLines, "**Option A:** ");
  if (optionA === null) return null;

  const optionB = findFieldLine(fieldLines, "**Option B:** ");
  if (optionB === null) return null;

  const costOfWrong = findFieldLine(fieldLines, "**Cost of being wrong:** ");
  if (costOfWrong === null) return null;

  // Fenced-block extraction (see doc comment): the "**Evidence:**" header line was
  // already located above; require the very next line to open the fence, then find
  // the CLOSING fence as the LAST line equal to "```" from the end of the file back
  // to the open -- the fixed `buildBody` trailer after the real close (a blank line,
  // then the "**Reply:**" paragraph) never itself contains a bare "```" line, so the
  // last such line is reliably the true close even when evidence contains its own
  // fenced blocks. Anything in between -- verbatim, including embedded blank lines
  // and nested fences -- is the evidence.
  const fenceOpenIdx = evidenceHeaderIdx + 1;
  if (lines[fenceOpenIdx] !== "```") return null;
  let fenceCloseIdx = -1;
  for (let i = lines.length - 1; i >= fenceOpenIdx + 1; i--) {
    if (lines[i] === "```") {
      fenceCloseIdx = i;
      break;
    }
  }
  if (fenceCloseIdx < 0) return null;
  const evidence = lines.slice(fenceOpenIdx + 1, fenceCloseIdx).join("\n");

  return { id, reason, type, taskId, title, what, decision, optionA, optionB, costOfWrong, evidence };
}

/** Builds the one-line delivery summary exactly like `escalate.ps1:73`. */
function buildSummary(input: EscalationInput): string {
  return (
    `[autodev escalation ${input.id}] ${input.type} :: ${input.title} -- ${input.decision} ` +
    `(A: ${input.optionA} | B: ${input.optionB}). Cost if wrong: ${input.costOfWrong}`
  );
}

/**
 * Parity: `escalate.ps1`. Writes the durable escalation artifact and then
 * attempts best-effort delivery (Telegram, falling back to the outbox on
 * any failure). Never throws: every side effect is wrapped so a failure in
 * the artifact write, the Telegram POST, or the outbox append is caught and
 * logged via `deps.log?.("WARN", ...)`.
 */
export async function escalate(input: EscalationInput, deps: EscalateDeps): Promise<EscalateResult> {
  // The "never throws" contract must hold even if the injected logger or env
  // reader itself throws — those are the only side effects not already inside
  // a protective try/catch below. safeLog swallows a broken logger; the env
  // reads are guarded so a throwing env() degrades to "Telegram unconfigured".
  const safeLog = (level: string, message: string): void => {
    try {
      deps.log?.(level, message);
    } catch {
      // a broken logger must never break escalation delivery
    }
  };

  const path = `${deps.escalationsDir}/${input.id}.md`;

  let artifactWritten = false;
  try {
    await deps.writeFile(path, buildBody(input));
    artifactWritten = true;
    safeLog("ESCALATE", `Wrote escalation ${input.id} (${input.type}) -> ${path}`);
  } catch (err) {
    safeLog("WARN", `Failed to write escalation artifact ${input.id}: ${String(err)}`);
  }

  const summary = buildSummary(input);

  let token: string | undefined;
  let chat: string | undefined;
  try {
    token = deps.env("AUTODEV_TELEGRAM_TOKEN");
    chat = deps.env("AUTODEV_TELEGRAM_CHAT");
  } catch (err) {
    safeLog("WARN", `escalate: env read threw (${String(err)}); treating Telegram as unconfigured.`);
  }
  let delivery: EscalateResult["delivery"] = "outbox";

  if (token && chat && deps.telegramPost) {
    try {
      await deps.telegramPost(token, chat, summary);
      delivery = "telegram";
      safeLog("ESCALATE", `Pushed escalation ${input.id} to Telegram chat ${chat}.`);
    } catch (err) {
      safeLog("WARN", `Telegram push failed for ${input.id} (${String(err)}); queued to _outbox.md.`);
    }
  }

  if (delivery === "outbox") {
    const outboxPath = `${deps.escalationsDir}/_outbox.md`;
    const outboxLine = `- [ ] ${summary}  (file: escalations/${input.id}.md)\n`;
    try {
      await deps.appendFile(outboxPath, outboxLine);
      safeLog("ESCALATE", `Queued escalation ${input.id} to _outbox.md (no direct Telegram transport configured).`);
    } catch (err) {
      safeLog("WARN", `Failed to append escalation ${input.id} to _outbox.md: ${String(err)}`);
    }
  }

  return { path, artifactWritten, delivery };
}
