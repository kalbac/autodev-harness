import type { CriticEvidence, OmissionReason } from "./evidence.js";

/**
 * Build the independent adversarial critic prompt for a diff — parity spec
 * §5 `invoke-critic.ps1` (lines 119-164).
 *
 * Assembles, in order:
 * 1. Adversarial framing: the DEFAULT ASSUMPTION is that the diff BREAKS a
 *    contract — the critic must actively try to prove that, not rubber-stamp
 *    the change. Clean-blockers are a broken contract, a fabricated proof, or
 *    a logic/regression flaw — NOT a missing brand-new test (ADR-005: the
 *    critic is a correctness gate; coverage is enforced mechanically by the
 *    machine gate's contract zones + guards, never by the LLM critic).
 * 2. An explicit fencing instruction: do NOT try to read `worker-report.md`
 *    or the commit message; judge ONLY the diff shown below.
 * 3. An ordered checklist: (1) which contract zones the diff touches,
 *    (2) whether an EXISTING test covers each touch — diagnostic only, a
 *    missing new test is not a `broken` verdict, (3) fabricated-proof
 *    detection — a test edited to match a changed contract value is itself
 *    BROKEN, (4) logic/regression risk independent of contracts.
 * 4. A statement that the response MUST be a single JSON object matching the
 *    verdict schema (`verdict`, `broken_contracts`, `notes`, `confidence`).
 * 5. The diff embedded INLINE inside clear delimiters — the diff is passed
 *    in the prompt, never read from disk by codex (parity: "diff embedded
 *    inline — avoids a second fencing surface").
 * 6. When an evidence set is supplied (#123): the complete current text of the
 *    files the diff touches, also inline, plus a named list of any that could
 *    not be attached. See `evidenceGuidanceSection` for why both halves are
 *    mandatory. Omitting the argument renders NO attachment sections at all and
 *    asserts nothing about files — a caller with no evidence to give promises
 *    the critic nothing. (It is not byte-identical to the pre-#123 prompt: the
 *    no-tools and fencing sections were reworded once, for both shapes, so that
 *    two statements of one rule cannot diverge. Codex R1 finding 4 caught that
 *    overclaim where it was first written.)
 */
export function buildCriticPrompt(diff: string, evidence?: CriticEvidence): string {
  const sections: string[] = [];

  sections.push(
    "# Independent adversarial critic review",
    "",
  );

  sections.push(
    "## No tools — review from the inline evidence only",
    "",
    "Do NOT run any shell command, do NOT read any file, and do NOT invoke any",
    "skill, plugin, or MCP tool. Subprocess spawning is unnecessary here and may",
    "be blocked by the sandbox. Everything you are given is embedded inline below —",
    "the complete diff under review, and (when present) the complete current text of",
    "the files it touches. Review from that material and respond directly with the",
    "verdict JSON. This is complementary to the fencing rule below: fencing tells you",
    "to ignore the worker's rationale; this tells you not to try to invoke anything.",
    "",
  );

  sections.push(
    "## Default assumption",
    "",
    "Assume, by default, that this diff BREAKS a contract somewhere. Your job",
    "is to actively try to PROVE that — not to rubber-stamp the change. Only",
    "conclude `clean` if, after genuinely trying, you cannot find a broken",
    "contract, a fabricated proof, or a logic/regression flaw. A correct change",
    "that merely LACKS a brand-new test is NOT a reason to withhold `clean` —",
    "coverage is enforced mechanically by the gate, not by you (see below).",
    "",
  );

  sections.push(
    "## Coverage gaps are not defects — but correctness IS your job",
    "",
    "Do NOT fail a diff because a correct behavioral change lacks a NEW test",
    "locking it. That is a coverage gap, not a defect, and coverage is enforced",
    "MECHANICALLY — by the machine gate (declared contract zones + mutation-",
    "verified, operator-blessed guards) and by the repo's existing CI — never by",
    "you. Judge whether THIS diff is CORRECT. If a behavioral touch is uncovered,",
    "NOTE it in `notes` as information for the operator — do NOT lower the verdict",
    "for it. (A test EDITED to match a changed contract value is a different thing",
    "entirely: that is a fabricated proof — see the checklist — and IS `broken`.)",
    "",
  );

  sections.push(
    "## Fencing — judge the change, not the worker's account of it",
    "",
    "Do NOT try to read `worker-report.md` and do NOT rely on the commit message",
    "for justification. Judge the change on the evidence below — the diff, plus any",
    "attached file contents — on its own merits. The worker's own rationale is fenced",
    "out of your reach for this review and must not factor into your verdict.",
    "",
  );

  if (evidence) sections.push(...evidenceGuidanceSection(evidence));

  sections.push(
    "## Checklist (work through this in order)",
    "",
    "1. Which contract zones does this diff touch?",
    "2. For each touched zone, NOTE whether an existing test covers it — for",
    "   the operator's information only. A MISSING new test is NOT, by itself,",
    "   a `broken` verdict (coverage is the machine gate's job, see above).",
    "3. Fabricated-proof detection: was any test edited to match a changed",
    "   contract value rather than to genuinely verify the contract? A test",
    "   edited this way is itself BROKEN — treat it as evidence of a broken",
    "   contract, not as proof of correctness.",
    "4. Independent of contracts: is there any logic or regression risk in",
    "   this diff (off-by-one, unhandled edge case, silent failure, etc.)?",
    "",
  );

  sections.push(
    "## Output format",
    "",
    "Your response MUST be a single JSON object matching the verdict schema:",
    "`verdict` (one of \"clean\", \"broken\", \"uncertain\"), `broken_contracts`",
    "(an array of {zone, file, line, evidence}), `notes` (string), and",
    "`confidence` (number between 0 and 1). Emit ONLY that JSON object.",
    "",
  );

  sections.push(
    "## Diff under review",
    "",
    "===== BEGIN DIFF =====",
    diff,
    "===== END DIFF =====",
    "",
  );

  if (evidence) sections.push(...attachedFilesSection(evidence));

  return sections.join("\n");
}

/**
 * The instructions that make the attachments USABLE. Rendered before the diff, while
 * the guidance still has room to change how the diff is read.
 *
 * Two statements, and the balance between them is the whole design:
 *
 *  - What IS attached is complete, so a declaration visible in an attachment is
 *    genuinely present, and "I cannot see it in the diff" stops being a reason to
 *    withhold `clean`. This is the half that fixes #123.
 *  - What is NOT attached is stated by name, and explicitly does not license the
 *    opposite inference. Without this half the change would trade one false verdict
 *    for another: a critic that treats "not shown" as "not there" would start
 *    reporting phantom missing declarations, a NEW failure mode that does not exist
 *    today (which is also why a truncated file is never attached at all).
 *
 * The critic's fail-closed instinct is deliberately NOT softened anywhere here. It is
 * given more evidence, not a lower bar — the mandate (`adr/005`) is untouched.
 */
function evidenceGuidanceSection(evidence: CriticEvidence): string[] {
  const lines = [
    "## Your evidence window",
    "",
    "Your evidence is the diff below PLUS, under it, the current content of the files",
    "the diff touches. Read both before judging.",
    "",
  ];

  if (evidence.attached.length > 0) {
    lines.push(
      "1. Each attached file is shown COMPLETE and UNTRUNCATED, exactly as it stands",
      "   after this change. So a constant, method, import, or class referenced by the",
      "   diff but DECLARED OUTSIDE the changed lines can be checked directly against",
      "   the attachment. If it is there, it is there: do NOT withhold `clean` on the",
      "   grounds that a declaration is not visible inside the diff hunk. Conversely,",
      "   if something the diff depends on is genuinely absent from a file that IS",
      "   attached, that absence is real evidence of a defect — report it.",
      "",
    );
  }

  if (evidence.omitted.length > 0) {
    lines.push(
      `${evidence.attached.length > 0 ? "2" : "1"}. Some touched files are NOT attached; they are listed by name and reason under`,
      "   \"Files NOT attached\" below. Their absence from this prompt is NOT evidence",
      "   that anything is missing, wrong, or undeclared — it is a limit of what could",
      "   be sent, nothing more. Do not infer a defect from a file you were not shown.",
      "   If such a file is genuinely decisive for your verdict, say which one and why",
      "   in `notes`, and answer `uncertain` rather than `broken`.",
      "",
    );
  }

  return lines;
}

/** The attachments themselves, plus the honest list of what was left out. */
function attachedFilesSection(evidence: CriticEvidence): string[] {
  const lines: string[] = [];

  if (evidence.attached.length > 0) {
    lines.push("## Attached files (complete current content)", "");
    for (const f of evidence.attached) {
      lines.push(
        `===== BEGIN FILE ${f.path} (${f.bytes} bytes, complete) =====`,
        f.content,
        `===== END FILE ${f.path} =====`,
        "",
      );
    }
  }

  if (evidence.omitted.length > 0) {
    lines.push(
      "## Files NOT attached",
      "",
      "These files are touched by the diff but were not sent. Not being shown one is",
      "NOT evidence that anything is missing from it.",
      "",
    );
    for (const f of evidence.omitted) {
      const size = f.bytes === null ? "" : `, ${f.bytes} bytes`;
      lines.push(`- \`${f.path}\` — ${OMISSION_TEXT[f.reason]}${size}`);
    }
    lines.push("");
  }

  return lines;
}

/** Plain-language rendering of each omission reason. A raw enum token would leave the
 *  critic guessing at what it means, and a guessing critic is what this change exists
 *  to stop. */
const OMISSION_TEXT: Record<OmissionReason, string> = {
  "too-large": "too large to attach in full (never sent truncated)",
  "budget-exhausted": "left out because the total attachment budget was already spent",
  absent: "not present on disk after the change (e.g. deleted by this diff)",
  "not-a-regular-file": "not a regular file (directory, symlink, or similar)",
  "not-text": "not UTF-8 text (binary content)",
  unreadable: "could not be read",
};
