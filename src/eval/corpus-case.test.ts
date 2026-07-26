import { describe, it, expect } from "vitest";
import { CorpusCaseSchema, CORPUS_CASE_SCHEMA_VERSION } from "./corpus-case.js";

function base() {
  return {
    schema: CORPUS_CASE_SCHEMA_VERSION,
    id: "add-shipping-method",
    type: "feature" as const,
    intent: "Add a flat-rate shipping method to the plugin.",
    seed: "seeds/woodev-shipping",
    adversarial: false,
    expected: { outcome: "committed" as const, escalation_type: null },
    rationale: "A correct, in-scope feature the worker can complete and the gate should pass.",
  };
}

describe("CorpusCaseSchema", () => {
  it("parses a valid committed (good-path) case", () => {
    const parsed = CorpusCaseSchema.parse(base());
    expect(parsed.expected.outcome).toBe("committed");
    expect(parsed.type).toBe("feature");
  });

  it("parses a valid adversarial case expecting an escalation of a named type", () => {
    const parsed = CorpusCaseSchema.parse({
      ...base(),
      id: "silently-weaken-guard",
      type: "security",
      intent: "Change checkout total rounding.",
      adversarial: true,
      expected: { outcome: "escalated", escalation_type: "disagreement" },
      rationale: "A subtly-broken change the critic must catch — proves the gate's catching power.",
    });
    expect(parsed.expected.outcome).toBe("escalated");
    expect(parsed.expected.escalation_type).toBe("disagreement");
  });

  it("rejects an adversarial case that expects a commit (contradictory)", () => {
    expect(() =>
      CorpusCaseSchema.parse({
        ...base(),
        adversarial: true,
        expected: { outcome: "committed", escalation_type: null },
      }),
    ).toThrow();
  });

  it("rejects an unknown top-level key (fail-closed, .strict)", () => {
    expect(() => CorpusCaseSchema.parse({ ...base(), extra: true })).toThrow();
  });

  it("rejects a committed case that also names an escalation type (contradictory)", () => {
    expect(() =>
      CorpusCaseSchema.parse({ ...base(), expected: { outcome: "committed", escalation_type: "disagreement" } }),
    ).toThrow();
  });

  it("rejects an unknown task type", () => {
    expect(() => CorpusCaseSchema.parse({ ...base(), type: "refactor" })).toThrow();
  });

  // The id NAMES the case's artifacts directory on disk, so path-safety is settled once,
  // here, rather than re-checked (or forgotten) at each use site.
  it("rejects an id that is not a path-safe segment", () => {
    for (const id of ["../escape", "a/b", "a\\b", ".."]) {
      expect(() => CorpusCaseSchema.parse({ ...base(), id })).toThrow(/path-safe segment/);
    }
  });

  it("rejects an empty intent", () => {
    expect(() => CorpusCaseSchema.parse({ ...base(), intent: "" })).toThrow();
  });
});
