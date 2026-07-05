/**
 * Build the independent adversarial critic prompt for a diff — parity spec
 * §5 `invoke-critic.ps1` (lines 119-164).
 *
 * Assembles, in order:
 * 1. Adversarial framing: the DEFAULT ASSUMPTION is that the diff BREAKS a
 *    contract — the critic must actively try to prove that, not rubber-stamp
 *    the change.
 * 2. An explicit fencing instruction: do NOT try to read `worker-report.md`
 *    or the commit message; judge ONLY the diff shown below.
 * 3. An ordered checklist: (1) which contract zones the diff touches,
 *    (2) whether each touch has a guard/test covering it, (3) fabricated-proof
 *    detection — a test edited to match a changed contract value is itself
 *    BROKEN, (4) logic/regression risk independent of contracts.
 * 4. A statement that the response MUST be a single JSON object matching the
 *    verdict schema (`verdict`, `broken_contracts`, `notes`, `confidence`).
 * 5. The diff embedded INLINE inside clear delimiters — the diff is passed
 *    in the prompt, never read from disk by codex (parity: "diff embedded
 *    inline — avoids a second fencing surface").
 */
export function buildCriticPrompt(diff: string): string {
  const sections: string[] = [];

  sections.push(
    "# Independent adversarial critic review",
    "",
  );

  sections.push(
    "## No tools — review from the inline diff only",
    "",
    "Do NOT run any shell command, do NOT read any file, and do NOT invoke any",
    "skill, plugin, or MCP tool. Subprocess spawning is unnecessary here and may",
    "be blocked by the sandbox. The COMPLETE diff under review is embedded inline",
    "below — review it from that text alone and respond directly with the verdict",
    "JSON. This is complementary to the fencing rule below: fencing tells you to",
    "ignore the worker's rationale; this tells you not to try to invoke anything.",
    "",
  );

  sections.push(
    "## Default assumption",
    "",
    "Assume, by default, that this diff BREAKS a contract somewhere. Your job",
    "is to actively try to PROVE that — not to rubber-stamp the change. Only",
    "conclude `clean` if you cannot find a broken contract, a missing guard,",
    "or a fabricated proof after genuinely trying.",
    "",
  );

  sections.push(
    "## Fencing — judge the diff only",
    "",
    "Do NOT try to read `worker-report.md` and do NOT rely on the commit message",
    "for justification. Judge ONLY the diff shown below, on its own merits.",
    "The worker's own rationale is fenced out of your reach for this review",
    "and must not factor into your verdict.",
    "",
  );

  sections.push(
    "## Checklist (work through this in order)",
    "",
    "1. Which contract zones does this diff touch?",
    "2. For each touched zone, is there a guard/test that actually covers",
    "   the touch?",
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

  return sections.join("\n");
}
