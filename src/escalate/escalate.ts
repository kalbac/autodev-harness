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
  | "drift";

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
