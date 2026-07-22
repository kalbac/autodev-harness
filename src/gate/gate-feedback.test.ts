import { describe, it, expect } from "vitest";
import { clampOutput, formatGateFeedback, stripAnsi, type FailedStep } from "./gate-feedback.js";

/** SGR colour sequence, written with an escaped ESC so the source stays plain ASCII. */
const ESC = String.fromCharCode(27);

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

describe("ANSI escape stripping", () => {
  it("strips the colour codes a tool emits when it thinks it is on a terminal", () => {
    // Found by the LIVE proof, not by unit tests: PHPCS's --report=full wrote SGR
    // sequences into gate-feedback.md, so the worker prompt carried an escaped
    // "ERROR" instead of a readable one. Stripped here rather than by disabling
    // colour per tool, because otherwise every future profile gate has to remember
    // to, and one that forgets fails silently and invisibly.
    const coloured = ESC + "[31mERROR" + ESC + "[0m | Missing doc comment";
    expect(stripAnsi(coloured)).toBe("ERROR | Missing doc comment");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });

  it("is applied BY formatGateFeedback, not left to each caller", () => {
    const doc = formatGateFeedback([
      { label: "phpcs", exitCode: 1, output: ESC + "[31mERROR" + ESC + "[0m | boom" },
    ])!;
    expect(doc).toContain("ERROR | boom");
    expect(doc).not.toContain(ESC);
  });

  it("strips BEFORE clamping, so escape bytes never eat the character budget", () => {
    // Clamping first would spend the budget on invisible control bytes and could
    // also slice a sequence in half, leaving a fragment in the prompt.
    const noisy = (ESC + "[31m").repeat(2000) + "TAIL_MARKER";
    const doc = formatGateFeedback([{ label: "s", exitCode: 1, output: noisy }])!;
    expect(doc).toContain("TAIL_MARKER");
    expect(doc).not.toMatch(/omitted/);
  });
});
