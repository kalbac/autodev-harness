import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus-loader.js";
import { collectSeedFiles } from "./seed-overlay.js";
import { evaluatePassBar } from "./eval-cli.js";
import { aggregateCorpus } from "./corpus-metrics.js";

/**
 * Structural checks on the CORPUS THAT SHIPS (`corpus/`), not on the machinery. A live
 * corpus run costs real worker and critic calls per case, so a typo'd seed path or a
 * contradictory expectation must be caught here — for free, in CI — rather than after
 * the operator has already paid for six cases and watched the seventh error out.
 *
 * These assertions are deliberately STRUCTURAL. Whether the harness actually commits or
 * catches each case is what the live `eval` run measures; that answer cannot be asserted
 * in a test without becoming the very "the agent said it works" claim this project exists
 * to reject.
 */
const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpus");

describe("the shipped corpus", () => {
  it("loads (fail-closed: a malformed case would throw here)", async () => {
    const cases = await loadCorpus(CORPUS_DIR);
    expect(cases.length).toBeGreaterThan(0);
  });

  it("every case's seed directory exists and is readable", async () => {
    const cases = await loadCorpus(CORPUS_DIR);
    for (const c of cases) {
      const seedDir = join(CORPUS_DIR, c.seed);
      expect(existsSync(seedDir), `${c.id}: seed '${c.seed}' is missing`).toBe(true);
      expect(statSync(seedDir).isDirectory(), `${c.id}: seed '${c.seed}' is not a directory`).toBe(true);
      await expect(collectSeedFiles(seedDir), `${c.id}: seed '${c.seed}' is unusable`).resolves.toBeInstanceOf(Array);
    }
  });

  it("measures catching power -- at least one adversarial case, or the headline metric is unmeasured", async () => {
    const cases = await loadCorpus(CORPUS_DIR);
    expect(cases.filter((c) => c.adversarial).length).toBeGreaterThan(0);
  });

  it("could in principle meet its own pass bar (a corpus that cannot is a broken oracle)", async () => {
    const cases = await loadCorpus(CORPUS_DIR);
    // Feed the aggregator the outcome each case DECLARES it expects. This proves the
    // corpus is internally consistent -- if a perfect run still failed the bar, the bar
    // could never be met and the measurement would be meaningless.
    const perfect = aggregateCorpus(
      cases.map((c) => ({
        case: c,
        evidence: {
          schema: 1 as const,
          task_id: c.id,
          run_id: null,
          title: c.id,
          type: c.type,
          declared: { file_set: [], acceptance: [], success_commands: [] },
          profile: null,
          outcome: c.expected.outcome,
          commit: c.expected.outcome === "committed" ? "abc123" : null,
          escalation:
            c.expected.outcome === "escalated"
              ? { type: c.expected.escalation_type ?? "disagreement", reason: "expected" }
              : null,
          rounds: 0,
          attempts: 1,
          started_at: "2026-07-26T00:00:00.000Z",
          ended_at: "2026-07-26T00:00:01.000Z",
          critic: null,
          gate: null,
          profile_gates: [],
          tokens: null,
        },
      })),
    );

    expect(perfect.failed).toBe(0);
    expect(evaluatePassBar(perfect)).toEqual({ met: true, reasons: [] });
  });

  it("spans more than one task type, so the numbers are not about a single shape of work", async () => {
    const cases = await loadCorpus(CORPUS_DIR);
    expect(new Set(cases.map((c) => c.type)).size).toBeGreaterThan(2);
  });
});
