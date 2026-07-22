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

  // The contract is "at most `limit` chars" for EVERY input, not just the
  // default PER_STEP_LIMIT. `half = Math.floor((limit - 40) / 2)` goes negative
  // (or zero) for small limits, and a negative/zero `half` fed into `slice`
  // stops meaning "half the budget" -- pin the boundary explicitly.
  describe("boundary: tiny limits never exceed their own limit", () => {
    const text = "x".repeat(1000);
    for (const limit of [0, 1, 39, 40, 41]) {
      it(`limit=${limit}`, () => {
        const out = clampOutput(text, limit);
        expect(out.length).toBeLessThanOrEqual(limit);
      });
    }
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

  // agent-ci returns `{ green, reasons }` -- there is no subprocess exit code to
  // report. `exitCode: null` must render as something honest, never as the
  // literal string "exit null" (which would read as a real, if odd, exit code).
  it("renders a step with NO subprocess exit code (e.g. agent-ci) honestly", () => {
    const doc = formatGateFeedback([step({ label: "agent-ci", exitCode: null, output: "workflow ci.yml FAILED" })])!;
    expect(doc).toContain("agent-ci");
    expect(doc).toContain("workflow ci.yml FAILED");
    expect(doc).not.toMatch(/exit null/i);
  });

  // CommonMark: a fence closes on the first line of backticks >= its own length.
  // Tool output legitimately contains ``` (e.g. a diff/markdown snippet in a
  // linter's own report), which would otherwise terminate the fence early and
  // let the rest of the document escape as prompt structure.
  it("uses a fence LONGER than the longest backtick run in the body, so the body cannot close it early", () => {
    const body = "before\n```\nsome nested code\n```\nafter";
    const doc = formatGateFeedback([step({ output: body })])!;
    expect(doc).toContain(body); // the whole body survives intact
    expect(doc).toMatch(/````+/); // a fence of 4+ backticks was actually used
  });

  it("bounds the whole document even when many steps each print a lot", () => {
    const noisy = step({ output: "x".repeat(50_000) });
    const doc = formatGateFeedback([noisy, noisy, noisy])!;
    expect(doc.length).toBeLessThan(40_000);
  });

  // PER_STEP_LIMIT bounds a single step, but the NUMBER of steps is unbounded
  // (many success_commands, several profile gates) -- pin a bound on the whole
  // assembled document, and require the omission to be stated rather than
  // silently dropping steps (a silent drop would read as "everything is fixed").
  it("caps the WHOLE document when there are MANY failing steps, not just large ones, and says how many were omitted", () => {
    const steps: FailedStep[] = Array.from({ length: 60 }, (_, i) =>
      step({ label: `success_command: cmd-${i}`, output: "line of output\n".repeat(50) }),
    );
    const doc = formatGateFeedback(steps)!;
    expect(doc.length).toBeLessThan(60_000); // well under 60 * (per-step budget)
    expect(doc).toMatch(/\d+ further failing steps? omitted/i);
    // the earliest failures are the ones a worker sees first
    expect(doc).toContain("cmd-0");
  });

  // A `success_command` label embeds the WHOLE command string, so the label
  // itself is unbounded too -- must be clamped like the output.
  it("clamps an oversized step LABEL, not just its output", () => {
    const hugeCmd = "echo " + "x".repeat(5_000);
    const doc = formatGateFeedback([step({ label: `success_command: ${hugeCmd}`, output: "boom" })])!;
    expect(doc.length).toBeLessThan(2_000);
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
