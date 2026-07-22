import { describe, it, expect } from "vitest";
import { clampOutput, formatGateFeedback, type FailedStep } from "./gate-feedback.js";

describe("clampOutput", () => {
  it("returns short text unchanged", () => {
    expect(clampOutput("hello", 100)).toBe("hello");
  });

  it("keeps the head AND the tail, and says how much it dropped", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = clampOutput(text, 200);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("line 0"); // first errors survive
    expect(out).toContain("line 499"); // the summary line survives
    expect(out).toMatch(/omitted/i); // the cut is stated, never silent
  });
});

describe("formatGateFeedback", () => {
  const step = (over: Partial<FailedStep> = {}): FailedStep => ({
    label: "profile gate 'phpcs'",
    exitCode: 1,
    output: "FILE: x.php\n 3 | ERROR | Missing docblock",
    ...over,
  });

  it("returns null when nothing failed -- the caller must be able to CLEAR", () => {
    expect(formatGateFeedback([])).toBeNull();
  });

  it("names each failing step, its exit code and its output", () => {
    const doc = formatGateFeedback([step()])!;
    expect(doc).toContain("profile gate 'phpcs'");
    expect(doc).toContain("exit 1");
    expect(doc).toContain("Missing docblock");
  });

  it("renders every failing step, not just the first", () => {
    const doc = formatGateFeedback([step(), step({ label: "check command", exitCode: 2 })])!;
    expect(doc).toContain("profile gate 'phpcs'");
    expect(doc).toContain("check command");
  });

  it("still reports a step that failed with no output at all", () => {
    const doc = formatGateFeedback([step({ output: "" })])!;
    expect(doc).toContain("profile gate 'phpcs'");
    expect(doc).toMatch(/no output/i);
  });

  it("bounds the whole document even when many steps each print a lot", () => {
    const noisy = step({ output: "x".repeat(50_000) });
    const doc = formatGateFeedback([noisy, noisy, noisy])!;
    expect(doc.length).toBeLessThan(40_000);
  });
});
