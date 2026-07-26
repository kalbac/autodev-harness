import { describe, it, expect } from "vitest";
import { buildCriticPrompt } from "./prompt.js";

describe("buildCriticPrompt", () => {
  const diff = "diff --git a/foo.ts b/foo.ts\n+const x = 1;\n";

  it("embeds the diff text inline", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toContain(diff);
    expect(prompt).toContain("BEGIN DIFF");
    expect(prompt).toContain("END DIFF");
  });

  it("includes an always-on NO-TOOLS preamble instructing the critic to review from the inline diff only", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/no tools/i);
    expect(prompt).toMatch(/do not run any shell command/i);
    expect(prompt).toMatch(/do not read any file/i);
    expect(prompt).toMatch(/skill, plugin, or mcp tool/i);
    expect(prompt).toMatch(/inline/i);
  });

  it("states the default assumption that the diff breaks a contract", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/assume.*breaks a contract/i);
  });

  it("instructs the critic NOT to read the worker report or rely on the commit message", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/do not.*read.*worker-report/i);
    expect(prompt).toMatch(/commit message/i);
  });

  it("still names the three real defect concerns: contract zones, fabrication, and logic/regression", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/contract zones/i);
    expect(prompt).toMatch(/fabricated.proof/i);
    expect(prompt).toMatch(/logic.*regression/i);
  });

  it("requires a single JSON object matching the verdict schema fields", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/JSON object/i);
    expect(prompt).toContain("verdict");
    expect(prompt).toContain("broken_contracts");
    expect(prompt).toContain("notes");
    expect(prompt).toContain("confidence");
  });

  // ADR-005: the critic is a correctness gate, not a coverage gate. Coverage
  // (a NEW test locking new behavior) is enforced mechanically by the machine
  // gate (contract zones + mutation-verified guards) + agent-ci, never by the
  // critic. A correct change that merely lacks a brand-new test is `clean`.
  it("does NOT treat a missing new test as a clean-blocker", () => {
    const prompt = buildCriticPrompt(diff);
    // the assume-broken clean-blocker enumeration must not list a missing guard/test
    expect(prompt).not.toMatch(/missing guard/i);
    // and it must positively state that coverage is enforced mechanically, not by the critic
    expect(prompt).toMatch(/coverage is enforced/i);
    expect(prompt).toMatch(/lacks a (brand-new|new) test/i);
  });

  it("still treats a fabricated proof (a test edited to match a changed value) as broken", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/fabricated.proof/i);
    expect(prompt).toMatch(/broken/i);
  });
});

describe("buildCriticPrompt — the evidence window (#123)", () => {
  const diff = "diff --git a/foo.php b/foo.php\n+return self::SUPPORTED;\n";
  const evidence = {
    attached: [{ path: "foo.php", bytes: 42, content: "<?php\nconst SUPPORTED = [1, 2];\nreturn self::SUPPORTED;\n" }],
    omitted: [{ path: "logo.png", reason: "not-text" as const, bytes: null }],
    declaredDocsOnly: false,
  };

  it("omitting the argument reproduces the pre-#123 diff-only prompt (promises nothing)", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).not.toMatch(/## Your evidence window/);
    expect(prompt).not.toMatch(/## Attached files/);
    expect(prompt).not.toMatch(/BEGIN FILE/);
    expect(prompt).not.toMatch(/Files NOT attached/);
    // The preamble may only ever speak of attachments CONDITIONALLY ("when present"):
    // a prompt with nothing attached must never assert that anything is.
    expect(prompt).not.toMatch(/each attached file is shown/i);
  });

  it("embeds each attachment COMPLETE, and says so", () => {
    const prompt = buildCriticPrompt(diff, evidence);
    expect(prompt).toContain(evidence.attached[0]!.content);
    expect(prompt).toContain("===== BEGIN FILE foo.php (42 bytes, complete) =====");
    expect(prompt).toContain("===== END FILE foo.php =====");
  });

  it("tells the critic a declaration outside the hunk is verifiable — the actual fix", () => {
    // This is the sentence that makes a `clean` verdict reachable for an edit whose
    // correctness depends on a constant declared above the changed lines
    // (docs/gotchas/critic-sees-only-the-diff-hunk.md). Without it the attachments
    // are present but the critic has no instruction to trust them over the hunk.
    const prompt = buildCriticPrompt(diff, evidence);
    expect(prompt).toMatch(/declared outside the changed lines/i);
    expect(prompt).toMatch(/do not withhold `clean`/i);
  });

  it("names every omission and forbids reading it as evidence of absence", () => {
    // The other half: without this, the change would swap one false verdict for a
    // NEW one — a critic inferring "not shown" means "not there".
    const prompt = buildCriticPrompt(diff, evidence);
    expect(prompt).toContain("## Files NOT attached");
    expect(prompt).toContain("`logo.png`");
    expect(prompt).toContain("not UTF-8 text (binary content)");
    expect(prompt).toMatch(/is NOT evidence\s+that anything is missing/i);
    expect(prompt).toMatch(/do not infer a defect from a file you were not shown/i);
  });

  it("renders every omission reason in plain language, never as a bare enum token", () => {
    const reasons = ["too-large", "budget-exhausted", "absent", "not-a-regular-file", "not-text", "unreadable"] as const;
    const prompt = buildCriticPrompt(diff, {
      attached: [],
      omitted: reasons.map((reason, i) => ({ path: `f${i}.php`, reason, bytes: null })),
      declaredDocsOnly: false,
    });
    expect(prompt).toMatch(/never sent truncated/);
    expect(prompt).toMatch(/total attachment budget/);
    expect(prompt).toMatch(/deleted by this diff/);
    expect(prompt).toMatch(/directory, symlink/);
    expect(prompt).toMatch(/binary content/);
    expect(prompt).toMatch(/could not be read/);
    // A raw token would leave the critic guessing at what it means.
    expect(prompt).not.toMatch(/— not-a-regular-file,/);
  });

  it("does NOT soften the fail-closed mandate — more evidence, not a lower bar", () => {
    // adr/005 and the adversarial framing are untouched by this change; a prompt that
    // quietly relaxed them would trade a throughput number for a weaker gate.
    const prompt = buildCriticPrompt(diff, evidence);
    expect(prompt).toMatch(/Assume, by default, that this diff BREAKS a contract/);
    expect(prompt).toMatch(/fabricated proof/i);
    expect(prompt).toMatch(/answer `uncertain` rather than `broken`/i);
  });

  it("keeps the no-tools and fencing rules consistent with the attachments", () => {
    // Two statements of one rule must not diverge: a preamble still saying "the diff
    // alone" while whole files are attached is a contradiction the critic has to
    // resolve on its own, and it resolves it fail-closed.
    const prompt = buildCriticPrompt(diff, evidence);
    expect(prompt).toMatch(/do not run any shell command/i);
    expect(prompt).not.toMatch(/review it from that text alone/i);
    expect(prompt).not.toMatch(/Judge ONLY the diff shown below/i);
    expect(prompt).toMatch(/worker's own rationale is fenced/i);
  });
});

describe("buildCriticPrompt — the adr/007 mandate narrowing", () => {
  const diff = "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md\n+The plugin registers `test_pickup`.\n";
  const docsEvidence = {
    attached: [{ path: "docs/OVERVIEW.md", bytes: 12, content: "# Overview\n" }],
    omitted: [],
    declaredDocsOnly: true,
  };
  const codeEvidence = { ...docsEvidence, declaredDocsOnly: false };

  it("renders the narrowing ONLY when the harness has already decided the change qualifies", () => {
    // The section's presence IS the decision. It is never phrased as a question the
    // model answers -- Principles 1 and 3 put "does this change get leniency" in code
    // the model cannot argue with, and the parked first attempt lost a review round
    // precisely for leaving that judgement to the critic.
    expect(buildCriticPrompt(diff, docsEvidence)).toContain("A claim you cannot verify is not a defect you found");
    expect(buildCriticPrompt(diff, codeEvidence)).not.toContain("A claim you cannot verify");
    expect(buildCriticPrompt(diff)).not.toContain("A claim you cannot verify");
  });

  it("attributes the determination to the OPERATOR's declaration, not to a content sniff", () => {
    // If the prompt claimed the harness had inspected the text and found it inert, it
    // would be overclaiming: nothing here reads the bytes. It says what is true --
    // the operator declared these paths to be documentation for this project.
    const prompt = buildCriticPrompt(diff, docsEvidence);
    expect(prompt).toMatch(/the OPERATOR has declared to be\s+documentation/);
    expect(prompt).toMatch(/not yours to make or to revisit/i);
  });

  it("instructs `notes` instead of a lowered verdict, and says why a permanent uncertain is not a gate", () => {
    const prompt = buildCriticPrompt(diff, docsEvidence);
    expect(prompt).toMatch(/do NOT\s+lower the verdict/);
    expect(prompt).toMatch(/permanent `uncertain`/);
    expect(prompt).toContain("SAY SO in `notes`");
  });

  it("keeps the ADDED-prose carve-out — a rewritten documented contract stays fully reviewable", () => {
    // The attack this deliberately leaves closed: rewrite the documented contract
    // first, then ship code that "matches the documentation". Losing this sentence is
    // the single most expensive way this change could go wrong, so it is pinned.
    const prompt = buildCriticPrompt(diff, docsEvidence);
    expect(prompt).toMatch(/carve-out is for ADDED prose only/);
    expect(prompt).toMatch(/MODIFIES or DELETES text/);
    expect(prompt).toMatch(/review it in full, with no leniency/);
  });

  it("does not soften anything else — the other clean-blockers survive the narrowing", () => {
    // adr/005's list and the adversarial framing must read identically on a qualifying
    // change. A narrowing that quietly relaxed the rest would trade one measured number
    // for a weaker gate, which is the opposite of the point.
    const prompt = buildCriticPrompt(diff, docsEvidence);
    expect(prompt).toMatch(/Assume, by default, that this diff BREAKS a contract/);
    expect(prompt).toMatch(/fabricated proof/i);
    expect(prompt).toMatch(/internal contradictions/);
    expect(prompt).toMatch(/worker's own rationale is fenced/i);
  });

  it("adds the checklist step only for a qualifying change", () => {
    expect(buildCriticPrompt(diff, docsEvidence)).toMatch(/5\. Which of this change's ADDED assertions/);
    expect(buildCriticPrompt(diff, codeEvidence)).not.toMatch(/ADDED assertions/);
  });
});
