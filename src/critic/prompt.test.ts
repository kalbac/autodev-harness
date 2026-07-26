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

describe("buildCriticPrompt — adr/007: an unverifiable claim about untouched code", () => {
  const diff = "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md\n+the plugin registers test_pickup\n";

  it("tells the critic not to lower the verdict for an assertion it cannot verify", () => {
    // MEASURED before this ADR: the corpus's docs-only case came back `uncertain` @ 0.84
    // on "no implementation or tests are provided to independently verify that
    // test_pickup and test_courier are registered". The code it describes is outside the
    // change by design, so that verdict can never be earned -- it is a permanent block,
    // not a finding (docs/adr/007).
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/do NOT\s+lower the verdict for them/i);
    expect(prompt).toMatch(/permanent `uncertain`/);
    expect(prompt).toMatch(/say so in `notes`/i);
  });

  it("scopes the carve-out to CODE-FREE changes only", () => {
    // The narrowing must never reach a diff that touches executable code -- that is the
    // critic's actual job and adr/005's remit is untouched.
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/ONLY when the changed files contain no executable code/i);
    expect(prompt).toMatch(/for anything touching code, ignore this\s+section entirely/i);
  });

  it("keeps MODIFIED documented behaviour fully reviewable — the docs-first attack", () => {
    // The carve-out is for ADDED prose. Rewriting a documented contract so a later
    // change can claim to match it is a real attack shape, and this repo's own corpus
    // has a case built on documented contracts (`adv-break-documented-contract`).
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/carve-out is for ADDED prose only/i);
    expect(prompt).toMatch(/MODIFIES or DELETES text/);
    expect(prompt).toMatch(/review it in full, with no leniency/i);
    expect(prompt).toMatch(/Rewriting a documented contract/);
  });

  it("does not weaken anything adr/005 left standing", () => {
    const prompt = buildCriticPrompt(diff);
    expect(prompt).toMatch(/Assume, by default, that this diff BREAKS a contract/);
    expect(prompt).toMatch(/fabricated proof/i);
    // Still judges what it CAN judge in a docs change.
    expect(prompt).toMatch(/internal contradictions/i);
  });
});
