import { describe, it, expect } from "vitest";
import { parseVerdict, attachDiffSha256 } from "./verdict.js";
import type { Verdict } from "./verdict.js";

describe("parseVerdict", () => {
  it("parses a clean verdict (bare JSON)", () => {
    const text = JSON.stringify({
      verdict: "clean",
      broken_contracts: [],
      notes: "all good",
      confidence: 0.95,
    });
    const result = parseVerdict(text);
    expect(result).toEqual({
      verdict: "clean",
      broken_contracts: [],
      notes: "all good",
      confidence: 0.95,
    });
  });

  it("parses a broken verdict whose JSON is wrapped in surrounding prose (tolerant extraction)", () => {
    const payload = {
      verdict: "broken",
      broken_contracts: [
        { zone: "billing", file: "src/billing/charge.ts", line: 42, evidence: "removed idempotency check" },
      ],
      notes: "contract violation found",
      confidence: 0.8,
    };
    const text = `Here is my analysis of the diff:\n\n${JSON.stringify(payload)}\n\nLet me know if you need more detail.`;
    const result = parseVerdict(text);
    expect(result).toEqual(payload);
  });

  it("returns null when confidence is missing", () => {
    const text = JSON.stringify({
      verdict: "clean",
      broken_contracts: [],
      notes: "missing confidence",
    });
    expect(parseVerdict(text)).toBeNull();
  });

  it("returns null when verdict is an invalid enum value", () => {
    const text = JSON.stringify({
      verdict: "maybe",
      broken_contracts: [],
      notes: "invalid enum",
      confidence: 0.5,
    });
    expect(parseVerdict(text)).toBeNull();
  });

  it("returns null for text with no JSON object at all", () => {
    expect(parseVerdict("no json here, just prose")).toBeNull();
  });

  it("returns null when the JSON has an unknown extra key (strictness)", () => {
    const text = JSON.stringify({
      verdict: "clean",
      broken_contracts: [],
      notes: "has an extra key",
      confidence: 0.5,
      extra_unknown_field: "should cause rejection",
    });
    expect(parseVerdict(text)).toBeNull();
  });
});

describe("attachDiffSha256", () => {
  const base: Verdict = {
    verdict: "clean",
    broken_contracts: [],
    notes: "n/a",
    confidence: 1,
  };

  it("sets a 64-char lowercase hex string", () => {
    const result = attachDiffSha256(base, "diff --git a/foo b/foo");
    expect(result.diff_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same diff", () => {
    const a = attachDiffSha256(base, "same diff content");
    const b = attachDiffSha256(base, "same diff content");
    expect(a.diff_sha256).toBe(b.diff_sha256);
  });

  it("differs for different diffs", () => {
    const a = attachDiffSha256(base, "diff one");
    const b = attachDiffSha256(base, "diff two");
    expect(a.diff_sha256).not.toBe(b.diff_sha256);
  });

  it("does not mutate the original verdict object", () => {
    attachDiffSha256(base, "some diff");
    expect(base).not.toHaveProperty("diff_sha256");
  });
});
