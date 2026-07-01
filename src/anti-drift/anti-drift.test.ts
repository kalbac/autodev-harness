import { describe, expect, it, vi } from "vitest";
import type { AntiDriftConfig, AntiDriftDeps, AntiDriftInput } from "./anti-drift.js";
import { runAntiDrift } from "./anti-drift.js";

const FIXED_NOW = new Date(2026, 0, 15, 9, 5, 3); // local time: 2026-01-15 09:05:03

function makeDeps(overrides: Partial<AntiDriftDeps> = {}): AntiDriftDeps {
  return {
    readFile: vi.fn(async () => null),
    gitLog: vi.fn(async () => "abc123 (autodev) done task 1"),
    gitDiff: vi.fn(async () => "diff --git a/foo b/foo"),
    runModel: vi.fn(async () => ({ exitCode: 0, output: "ON-TRACK: fine" })),
    appendDigest: vi.fn(async () => {}),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function makeCfg(overrides: Partial<AntiDriftConfig> = {}): AntiDriftConfig {
  return {
    intentSource: null,
    headers: [],
    model: "sonnet",
    ...overrides,
  };
}

function makeInput(overrides: Partial<AntiDriftInput> = {}): AntiDriftInput {
  return {
    sinceRef: "HEAD~3",
    commitsSinceLast: 1,
    ...overrides,
  };
}

/** A `runModel` fake that captures the prompt it was called with (avoids indexing `mock.calls`). */
function capturingRunModel(): {
  runModel: AntiDriftDeps["runModel"];
  getPrompt: () => string;
} {
  let capturedPrompt = "";
  const runModel: AntiDriftDeps["runModel"] = async (_model, prompt) => {
    capturedPrompt = prompt;
    return { exitCode: 0, output: "ON-TRACK: fine" };
  };
  return { runModel, getPrompt: () => capturedPrompt };
}

describe("runAntiDrift", () => {
  it("returns ON-TRACK line and appends exactly one digest line with the expected shape", async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => ({ exitCode: 0, output: "ON-TRACK: fine" })),
    });
    const cfg = makeCfg();
    const input = makeInput({ commitsSinceLast: 4 });

    const result = await runAntiDrift(input, cfg, deps);

    expect(result).toBe("ON-TRACK: fine");
    expect(deps.appendDigest).toHaveBeenCalledTimes(1);
    expect(deps.appendDigest).toHaveBeenCalledWith(
      "[2026-01-15 09:05:03] [anti-drift] (window: 4 commits) ON-TRACK: fine",
    );
  });

  it("returns the DRIFT line so a caller can route it to escalation", async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => ({ exitCode: 0, output: "DRIFT: wandered off into unrelated refactors" })),
    });
    const cfg = makeCfg();
    const input = makeInput();

    const result = await runAntiDrift(input, cfg, deps);

    expect(result).toBe("DRIFT: wandered off into unrelated refactors");
    expect(deps.appendDigest).toHaveBeenCalledTimes(1);
  });

  it("degrades to UNCERTAIN when model output has no recognized prefix", async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => ({ exitCode: 0, output: "the model rambled without a verdict prefix" })),
    });
    const cfg = makeCfg();
    const input = makeInput();

    const result = await runAntiDrift(input, cfg, deps);

    expect(result).toMatch(/^UNCERTAIN:/);
    expect(result).toContain("no ON-TRACK/DRIFT/UNCERTAIN prefix");
    expect(deps.appendDigest).toHaveBeenCalledTimes(1);
  });

  it("degrades to UNCERTAIN on non-zero exit / empty output, never a false ON-TRACK", async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => ({ exitCode: 1, output: "" })),
    });
    const cfg = makeCfg();
    const input = makeInput();

    const result = await runAntiDrift(input, cfg, deps);

    expect(result).toBe("UNCERTAIN: anti-drift could not run (model exit 1) -- not asserting on-track.");
    expect(deps.appendDigest).toHaveBeenCalledTimes(1);
  });

  describe("intent extraction", () => {
    it("feeds the whole file when headers is empty", async () => {
      const { runModel, getPrompt } = capturingRunModel();
      const deps = makeDeps({
        readFile: vi.fn(async () => "This is the entire intent-source file content."),
        runModel,
      });
      const cfg = makeCfg({ intentSource: "docs/intent.md", headers: [] });
      const input = makeInput();

      await runAntiDrift(input, cfg, deps);

      expect(getPrompt()).toContain("This is the entire intent-source file content.");
    });

    it("extracts only the configured header section", async () => {
      const { runModel, getPrompt } = capturingRunModel();
      const fileText = "## Next action\nDo X\n## Other\nOTHER_SECTION_CONTENT\n";
      const deps = makeDeps({
        readFile: vi.fn(async () => fileText),
        runModel,
      });
      const cfg = makeCfg({ intentSource: "docs/intent.md", headers: ["Next action"] });
      const input = makeInput();

      await runAntiDrift(input, cfg, deps);

      expect(getPrompt()).toContain("Do X");
      expect(getPrompt()).not.toContain("OTHER_SECTION_CONTENT");
    });

    it("uses the placeholder when intentSource is null", async () => {
      const { runModel, getPrompt } = capturingRunModel();
      const deps = makeDeps({ runModel });
      const cfg = makeCfg({ intentSource: null });
      const input = makeInput();

      await runAntiDrift(input, cfg, deps);

      expect(getPrompt()).toContain("(no intent source configured)");
    });

    it("uses the placeholder when intentSource is configured but the file is missing", async () => {
      const { runModel, getPrompt } = capturingRunModel();
      const deps = makeDeps({
        readFile: vi.fn(async () => null),
        runModel,
      });
      const cfg = makeCfg({ intentSource: "docs/missing.md", headers: [] });
      const input = makeInput();

      await runAntiDrift(input, cfg, deps);

      expect(getPrompt()).toContain("(intent source not found)");
    });
  });
});
