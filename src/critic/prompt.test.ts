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
