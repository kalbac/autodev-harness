import { describe, it, expect } from "vitest";
import {
  parseClaudeUsage,
  parseCodexTokens,
  buildTokenUsageDoc,
  buildRunUsageSummary,
  isTokenUsageDoc,
  type WorkerUsage,
  type CriticUsage,
  type TokenUsageDoc,
} from "./usage.js";

/** A realistic final stream-json `result` event (fields trimmed to what we read). */
function resultEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 10,
      output_tokens: 50,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
    },
    ...overrides,
  });
}

describe("parseClaudeUsage", () => {
  it("extracts usage + total_cost_usd from the result event in a JSONL stream", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
      resultEvent(),
    ].join("\n");

    expect(parseClaudeUsage(stdout)).toEqual({
      input_tokens: 10,
      output_tokens: 50,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      total_cost_usd: 0.0123,
    });
  });

  it("takes the LAST result event when more than one is present", () => {
    const stdout = [
      resultEvent({ usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001 }),
      resultEvent({ usage: { input_tokens: 999, output_tokens: 888 }, total_cost_usd: 0.5 }),
    ].join("\n");

    const parsed = parseClaudeUsage(stdout);
    expect(parsed?.input_tokens).toBe(999);
    expect(parsed?.output_tokens).toBe(888);
    expect(parsed?.total_cost_usd).toBe(0.5);
  });

  it("defaults every missing usage field (and cost) to 0, never NaN", () => {
    const stdout = resultEvent({ usage: { input_tokens: 7 }, total_cost_usd: undefined });
    expect(parseClaudeUsage(stdout)).toEqual({
      input_tokens: 7,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0,
    });
  });

  it("skips non-JSON and non-result lines and tolerates CRLF", () => {
    const stdout = ["garbage not json", "", resultEvent(), "trailing prose"].join("\r\n");
    expect(parseClaudeUsage(stdout)?.input_tokens).toBe(10);
  });

  it("returns null when there is no result event with usage", () => {
    expect(parseClaudeUsage("")).toBeNull();
    expect(parseClaudeUsage(JSON.stringify({ type: "assistant" }))).toBeNull();
    // a result event WITHOUT a usage object is not usable
    expect(parseClaudeUsage(JSON.stringify({ type: "result", total_cost_usd: 0.1 }))).toBeNull();
  });
});

describe("parseCodexTokens", () => {
  it("parses the bare `tokens used\\n<N>` line", () => {
    expect(parseCodexTokens("some review prose\ntokens used\n12345\n")).toBe(12345);
  });

  it("parses a `tokens used: N` inline form with thousands separators", () => {
    expect(parseCodexTokens("Tokens used: 2,345")).toBe(2345);
  });

  it("accepts a space-separated count on the footer line, case-insensitively", () => {
    expect(parseCodexTokens("...\nTOKENS USED 999")).toBe(999);
  });

  it("takes the LAST footer when more than one is present", () => {
    expect(parseCodexTokens("tokens used: 10\n...\ntokens used: 20")).toBe(20);
  });

  it("is line-anchored: prose that merely mentions 'tokens used' is NOT parsed as a count", () => {
    // The exact false-telemetry scenario the critic flagged: a review note that
    // contains the phrase mid-sentence must never be read as the accounting line.
    expect(parseCodexTokens("No tokens used in this example; finding 3 explains why.")).toBeNull();
    expect(parseCodexTokens('{"notes":"tokens used incorrectly in 5 places"}')).toBeNull();
    // A bare footer followed by non-integer prose is not a count either.
    expect(parseCodexTokens("tokens used\nnot a number")).toBeNull();
  });

  it("returns null when the marker is absent", () => {
    expect(parseCodexTokens("")).toBeNull();
    expect(parseCodexTokens("no token accounting here, just 4242 elsewhere")).toBeNull();
  });
});

describe("buildTokenUsageDoc", () => {
  const w = (o: Partial<WorkerUsage> = {}): WorkerUsage => ({
    model: "sonnet",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
    total_cost_usd: 0.01,
    ...o,
  });
  const c = (o: Partial<CriticUsage> = {}): CriticUsage => ({ model: "gpt-5.5", tokens: 100, ...o });

  it("sums worker fields + cost and critic tokens across rounds, keeping per-run detail", () => {
    const doc = buildTokenUsageDoc([w(), w({ input_tokens: 5, total_cost_usd: 0.02 })], [c(), c({ tokens: 50 })], 1234);

    expect(doc.worker.input_tokens).toBe(15);
    expect(doc.worker.output_tokens).toBe(40);
    expect(doc.worker.total_cost_usd).toBeCloseTo(0.03, 10);
    expect(doc.worker.runs).toHaveLength(2);
    expect(doc.critic.tokens).toBe(150);
    expect(doc.critic.runs).toHaveLength(2);
    expect(doc.total_cost_usd).toBeCloseTo(0.03, 10);
    expect(doc.updated_at).toBe(1234);
  });

  it("produces an all-zero doc for empty runs", () => {
    const doc = buildTokenUsageDoc([], [], 7);
    expect(doc.worker.input_tokens).toBe(0);
    expect(doc.worker.total_cost_usd).toBe(0);
    expect(doc.critic.tokens).toBe(0);
    expect(doc.total_cost_usd).toBe(0);
    expect(doc.updated_at).toBe(7);
  });
});

/** A valid `TokenUsageDoc`, with overridable worker/critic/cost fields, for the
 *  s25 server-side run-usage aggregation tests below. */
function usageDoc(o: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  critic_tokens?: number;
  total_cost_usd?: number;
} = {}): TokenUsageDoc {
  return {
    worker: {
      input_tokens: o.input_tokens ?? 10,
      output_tokens: o.output_tokens ?? 20,
      cache_read_input_tokens: o.cache_read_input_tokens ?? 30,
      cache_creation_input_tokens: o.cache_creation_input_tokens ?? 40,
      total_cost_usd: o.total_cost_usd ?? 0.01,
      runs: [],
    },
    critic: { tokens: o.critic_tokens ?? 5, runs: [] },
    total_cost_usd: o.total_cost_usd ?? 0.01,
    updated_at: 1,
  };
}

describe("buildRunUsageSummary", () => {
  it("sums tokens (all 4 worker fields + critic.tokens) and cost across two docs", () => {
    const a = usageDoc({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, critic_tokens: 5, total_cost_usd: 0.01 });
    const b = usageDoc({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, critic_tokens: 5, total_cost_usd: 0.02 });

    const summary = buildRunUsageSummary([a, b], 2);

    expect(summary.tokens).toBe(10 + 20 + 30 + 40 + 5 + (1 + 2 + 3 + 4 + 5));
    expect(summary.cost).toBeCloseTo(0.03, 10);
    expect(summary).toMatchObject({ any: true, tasksWithUsage: 2, taskCount: 2 });
  });

  it("returns an all-zero, any:false summary for empty docs", () => {
    expect(buildRunUsageSummary([], 3)).toEqual({ tokens: 0, cost: 0, any: false, tasksWithUsage: 0, taskCount: 3 });
  });

  it("reads honestly for partial coverage: 1 doc but taskCount 3", () => {
    const summary = buildRunUsageSummary([usageDoc()], 3);
    expect(summary.tasksWithUsage).toBe(1);
    expect(summary.taskCount).toBe(3);
    expect(summary.any).toBe(true);
  });

  it("a NaN field on a guard-passing doc contributes 0, never poisons the total", () => {
    const bad = usageDoc();
    bad.worker.input_tokens = NaN;
    const summary = buildRunUsageSummary([bad], 1);
    expect(Number.isFinite(summary.tokens)).toBe(true);
    expect(summary.tokens).toBe(20 + 30 + 40 + 5); // input_tokens contributes 0
  });
});

describe("isTokenUsageDoc", () => {
  it("accepts a valid doc", () => {
    expect(isTokenUsageDoc(usageDoc())).toBe(true);
  });

  it("rejects null, a non-object, and structurally incomplete/malformed shapes", () => {
    expect(isTokenUsageDoc(null)).toBe(false);
    expect(isTokenUsageDoc("nope")).toBe(false);
    expect(isTokenUsageDoc({ worker: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, total_cost_usd: 0, runs: [] } })).toBe(false); // missing critic
    const stringField = usageDoc() as unknown as { worker: { input_tokens: unknown } };
    stringField.worker.input_tokens = "10";
    expect(isTokenUsageDoc(stringField)).toBe(false);
    const missingCost = usageDoc() as Partial<TokenUsageDoc>;
    delete missingCost.total_cost_usd;
    expect(isTokenUsageDoc(missingCost)).toBe(false);
  });
});
