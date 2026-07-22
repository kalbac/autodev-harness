import { describe, it, expect } from "vitest";
import { runGate } from "./gate.js";
import type { GateDeps, GateInput } from "./gate.js";
import type { Invariants, ContractZone } from "./invariants.js";
import type { GuardRow, GuardRecipePair } from "./guards.js";
import { AgentCiUnavailableError } from "./agent-ci-exec.js";

/** Builds a minimal unified diff whose body is exactly the given +/- lines. */
function makeDiff(lines: string[]): string {
  return ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", ...lines].join("\n");
}

function makeInvariants(overrides: Partial<Invariants> = {}): Invariants {
  return {
    version: 1,
    updated: "2026-01-01",
    contract_zones: [],
    constitution: { path_globs: ["docs/**"] },
    ...overrides,
  };
}

interface DepsOverrides {
  invariants?: Invariants;
  guardPairs?: GuardRecipePair[];
  changedFiles?: string[];
  diffText?: string;
  runCheck?: GateDeps["runCheck"];
  runSuccessCommand?: GateDeps["runSuccessCommand"];
  guardStillRed?: GateDeps["guardStillRed"];
  runAgentCi?: GateDeps["runAgentCi"];
  runProfileGates?: GateDeps["runProfileGates"];
  writeGateFeedback?: GateDeps["writeGateFeedback"];
}

interface Calls {
  loadInvariants: boolean;
  loadGuardPairs: boolean;
  resolveScope: boolean;
}

function makeDeps(overrides: DepsOverrides = {}): { deps: GateDeps; calls: Calls } {
  const calls: Calls = { loadInvariants: false, loadGuardPairs: false, resolveScope: false };
  const invariants = overrides.invariants ?? makeInvariants();
  const guardPairs = overrides.guardPairs ?? [];

  const deps: GateDeps = {
    loadInvariants: () => {
      calls.loadInvariants = true;
      return invariants;
    },
    loadGuardPairs: () => {
      calls.loadGuardPairs = true;
      return guardPairs;
    },
    resolveScope: async () => {
      calls.resolveScope = true;
      return {
        changedFiles: overrides.changedFiles ?? [],
        diffText: overrides.diffText ?? "",
      };
    },
    runCheck: overrides.runCheck !== undefined ? overrides.runCheck : async () => ({ green: true, exitCode: 0 }),
    runSuccessCommand: overrides.runSuccessCommand ?? (async () => ({ exitCode: 0 })),
    guardStillRed: overrides.guardStillRed ?? (async () => true),
    runAgentCi: overrides.runAgentCi !== undefined ? overrides.runAgentCi : null,
    runProfileGates: overrides.runProfileGates !== undefined ? overrides.runProfileGates : null,
    ...(overrides.writeGateFeedback !== undefined ? { writeGateFeedback: overrides.writeGateFeedback } : {}),
  };

  return { deps, calls };
}

const humanOnlyZone: ContractZone = {
  id: "human-only-zone",
  why: "needs human review",
  auto_guardable: false,
  path_globs: ["secrets/**"],
  grep_patterns: [],
  exact_strings: [],
};

const zoneA: ContractZone = {
  id: "zone-a",
  why: "single enumerated value",
  auto_guardable: true,
  path_globs: [],
  grep_patterns: [],
  exact_strings: ["value-a"],
};

const guardA: GuardRow = {
  contract_id: "c-a",
  contract_value: "value-a",
  guard_test: "T_a",
  recipe: "recipes/a.json",
  mutation_verified: "yes (red on flip)",
  blessed_by: "maksim",
  date: "2026-01-01",
};

const pairA: GuardRecipePair = {
  guard: guardA,
  recipe: { canonical_value: "value-a", zone_id: "zone-a" },
};

const fallbackZone: ContractZone = {
  id: "fallback-zone",
  why: "path/grep only, no enumerated values",
  auto_guardable: true,
  path_globs: ["fallback/**"],
  grep_patterns: [],
  exact_strings: [],
};

describe("runGate", () => {
  it("1. empty file_set fast-paths to ESCALATE without ever calling loadInvariants/loadGuardPairs/resolveScope", async () => {
    const { deps, calls } = makeDeps();
    const input: GateInput = { taskId: "T1", fileSet: [] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.composer_green).toBe(false);
    expect(result.success_green).toBe(false);
    expect(result.changed_files).toEqual([]);
    expect(result.zones_touched).toEqual([]);
    expect(result.constitution_touched).toEqual([]);
    expect(result.reasons).toEqual(["empty file_set -- nothing can be safely judged"]);
    expect(calls.loadInvariants).toBe(false);
    expect(calls.loadGuardPairs).toBe(false);
    expect(calls.resolveScope).toBe(false);
  });

  it("2. a clean non-contract task with a green check and no zones/constitution touched commits", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      diffText: makeDiff(["+something totally unrelated"]),
    });
    const input: GateInput = { taskId: "T2", fileSet: ["src/foo.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("COMMIT");
    expect(result.composer_green).toBe(true);
    expect(result.success_green).toBe(true);
    expect(result.zones_touched).toEqual([]);
    expect(result.constitution_touched).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("3. a failing check command yields RETRY, overriding a zone that would otherwise escalate", async () => {
    const invariants = makeInvariants({ contract_zones: [humanOnlyZone] });
    const { deps } = makeDeps({
      invariants,
      changedFiles: ["secrets/config.php"],
      runCheck: async () => ({ green: false, exitCode: 1 }),
    });
    const input: GateInput = { taskId: "T3", fileSet: ["secrets/config.php"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("RETRY");
    expect(result.composer_green).toBe(false);
    expect(result.reasons.some((r) => r.includes("check command FAILED (exit 1)"))).toBe(true);
  });

  it("4. a failing success_command yields RETRY with a reason naming the command", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runSuccessCommand: async (cmd) => ({ exitCode: cmd === "npm test" ? 1 : 0 }),
    });
    const input: GateInput = { taskId: "T4", fileSet: ["src/foo.ts"], successCommands: ["npm test"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("RETRY");
    expect(result.success_green).toBe(false);
    expect(result.reasons.some((r) => r.includes("npm test"))).toBe(true);
  });

  it("5. a constitution path touched escalates even with a green check", async () => {
    const { deps } = makeDeps({ changedFiles: ["docs/VISION.md"] });
    const input: GateInput = { taskId: "T5", fileSet: ["docs/VISION.md"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.constitution_touched).toEqual(["docs/VISION.md"]);
    expect(result.reasons.some((r) => r.includes("constitution path(s) changed"))).toBe(true);
  });

  it("6. a per-value-covered, blessed, mutation-proven zone commits", async () => {
    const invariants = makeInvariants({ contract_zones: [zoneA] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [pairA],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';"]),
    });
    const input: GateInput = { taskId: "T6", fileSet: ["src/thing.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("COMMIT");
    expect(result.zones_touched).toHaveLength(1);
    expect(result.zones_touched[0]).toMatchObject({
      id: "zone-a",
      guarded: true,
      blessed: true,
      mutation_passed: true,
      guard_test: "T_a",
    });
  });

  it("7. a sibling contract value with no guard escalates and is reported uncovered (divergence #2)", async () => {
    const zoneAB: ContractZone = { ...zoneA, id: "zone-ab", exact_strings: ["value-a", "value-b"] };
    const invariants = makeInvariants({ contract_zones: [zoneAB] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [{ guard: guardA, recipe: { canonical_value: "value-a", zone_id: "zone-ab" } }],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';", "+const y = 'value-b';"]),
    });
    const input: GateInput = { taskId: "T7", fileSet: ["src/thing.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    const zr = result.zones_touched.find((z) => z.id === "zone-ab");
    expect(zr).toBeDefined();
    expect(zr!.guarded).toBe(false);
    expect(zr!.uncovered_strings).toEqual(["value-b"]);
    expect(result.reasons.some((r) => r.includes("value-b"))).toBe(true);
  });

  it("8. covered but not-yet-blessed guard escalates with blessed:false", async () => {
    const pendingGuard: GuardRow = { ...guardA, blessed_by: "pending-operator" };
    const invariants = makeInvariants({ contract_zones: [zoneA] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [{ guard: pendingGuard, recipe: { canonical_value: "value-a", zone_id: "zone-a" } }],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';"]),
    });
    const input: GateInput = { taskId: "T8", fileSet: ["src/thing.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched[0]).toMatchObject({ guarded: true, blessed: false });
    expect(result.reasons.some((r) => r.includes("not yet blessed"))).toBe(true);
  });

  it("9. covered + blessed but guard fails to go red on mutation escalates with mutation_passed:false", async () => {
    const invariants = makeInvariants({ contract_zones: [zoneA] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [pairA],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';"]),
      guardStillRed: async () => false,
    });
    const input: GateInput = { taskId: "T9", fileSet: ["src/thing.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched[0]).toMatchObject({ guarded: true, mutation_passed: false });
    expect(result.reasons.some((r) => r.includes("did NOT go red on mutation"))).toBe(true);
  });

  it("10. a non-auto_guardable zone touched always escalates with a human-only reason", async () => {
    const invariants = makeInvariants({ contract_zones: [humanOnlyZone] });
    const { deps } = makeDeps({ invariants, changedFiles: ["secrets/config.php"] });
    const input: GateInput = { taskId: "T10", fileSet: ["secrets/config.php"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched[0]).toMatchObject({ id: "human-only-zone", auto_guardable: false, guarded: false });
    expect(result.reasons.some((r) => r.includes("NOT auto_guardable (human-only"))).toBe(true);
  });

  it("11. a zone touched via path/grep only (no enumerated value) commits via the zone-level fallback guard", async () => {
    const fallbackGuard: GuardRow = { ...guardA, contract_id: "c-fallback", guard_test: "T_fallback" };
    const invariants = makeInvariants({ contract_zones: [fallbackZone] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [{ guard: fallbackGuard, recipe: { zone_id: "fallback-zone" } }],
      changedFiles: ["fallback/thing.ts"],
      diffText: makeDiff(["+something unrelated to any enumerated value"]),
    });
    const input: GateInput = { taskId: "T11", fileSet: ["fallback/thing.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("COMMIT");
    expect(result.zones_touched).toHaveLength(1);
    expect(result.zones_touched[0]).toMatchObject({
      id: "fallback-zone",
      guarded: true,
      blessed: true,
      mutation_passed: true,
      guard_test: "T_fallback",
      touched_strings: [],
    });
  });

  it("12. agent-ci present and green leaves the decision unchanged and sets agent_ci_green", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async (_taskId: string) => ({ green: true, reasons: [] }),
    });
    const input: GateInput = { taskId: "t", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.agent_ci_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
  });

  it("13. agent-ci present and red forces RETRY and records its reasons", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async (_taskId: string) => ({
        green: false,
        reasons: ["agent-ci workflow '.github/workflows/ci.yml' FAILED"],
      }),
    });
    const input: GateInput = { taskId: "t", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.agent_ci_green).toBe(false);
    expect(result.decision).toBe("RETRY");
    expect(result.reasons.some((r) => r.includes("ci.yml"))).toBe(true);
  });

  it("14. an agent-ci INFRA throw propagates out of runGate (conductor escalates)", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async (_taskId: string) => {
        throw new Error("agent-ci ... infrastructure failure");
      },
    });
    const input: GateInput = { taskId: "t", fileSet: ["a.ts"] };

    await expect(runGate(input, deps)).rejects.toThrow(/infrastructure/i);
  });

  it("15. agent-ci absent (null) is a no-op: decision unchanged, agent_ci_green defaults true", async () => {
    const { deps } = makeDeps({ changedFiles: ["src/foo.ts"], runAgentCi: null });
    const input: GateInput = { taskId: "t", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.agent_ci_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
  });

  it("16. propagates an AgentCiUnavailableError out of runGate (not swallowed)", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async (_taskId: string) => {
        throw new AgentCiUnavailableError("needs-wsl-on-windows", "needs WSL");
      },
    });
    const input: GateInput = { taskId: "t1", fileSet: ["a.ts"] };

    await expect(runGate(input, deps)).rejects.toBeInstanceOf(AgentCiUnavailableError);
  });

  it("18. constitutionPaths alone (INVARIANTS declares no constitution) flags a changed file and escalates (adr/006)", async () => {
    const invariants = makeInvariants({ constitution: { path_globs: [] } });
    const { deps } = makeDeps({ invariants, changedFiles: ["secrets/config.php"] });
    const input: GateInput = { taskId: "T18", fileSet: ["secrets/config.php"] };

    const result = await runGate(input, { ...deps, constitutionPaths: ["secrets/**"] });

    expect(result.decision).toBe("ESCALATE");
    expect(result.constitution_touched).toEqual(["secrets/config.php"]);
  });

  it("19. a file matching BOTH the INVARIANTS glob and constitutionPaths appears ONCE, alongside a constitutionPaths-only file (isolates dedup from mere presence)", async () => {
    const invariants = makeInvariants({ constitution: { path_globs: ["docs/**"] } });
    const { deps } = makeDeps({
      invariants,
      changedFiles: ["docs/VISION.md", "secrets/config.php"],
    });
    const input: GateInput = { taskId: "T19", fileSet: ["docs/VISION.md", "secrets/config.php"] };

    // docs/VISION.md matches BOTH lists (dedup must collapse it to one entry);
    // secrets/config.php matches ONLY constitutionPaths (proves the union is real,
    // not a no-op that happens to already contain the double-matched file).
    const result = await runGate(input, {
      ...deps,
      constitutionPaths: ["docs/VISION.md", "secrets/**"],
    });

    expect(result.constitution_touched).toEqual(["docs/VISION.md", "secrets/config.php"]);
  });

  it("20. constitutionPaths omitted from GateDeps produces an identical verdict to today (no regression)", async () => {
    const { deps } = makeDeps({ changedFiles: ["src/foo.ts"] });
    const input: GateInput = { taskId: "T20", fileSet: ["src/foo.ts"] };

    const result = await runGate(input, deps); // no `constitutionPaths` key at all

    expect(result.decision).toBe("COMMIT");
    expect(result.constitution_touched).toEqual([]);
  });

  it("17. passes the task id into runAgentCi", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async (taskId: string) => {
        seen.push(taskId);
        return { green: true, reasons: [] };
      },
    });
    const input: GateInput = { taskId: "task-42", fileSet: ["a.ts"] };

    await runGate(input, deps);

    expect(seen).toEqual(["task-42"]);
  });
});

describe("profile gates (step 1d)", () => {
  it("is green and inert when no profile is attached", async () => {
    const { deps } = makeDeps({ changedFiles: ["src/foo.ts"], runProfileGates: null });
    const input: GateInput = { taskId: "P1", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(true);
    expect(result.reasons.some((r) => /profile gate/i.test(r))).toBe(false);
  });

  it("passes when every profile gate exits 0", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runProfileGates: async () => [{ id: "phpcs", green: true, exitCode: 0 }],
    });
    const input: GateInput = { taskId: "P2", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
  });

  it("RETRYs and names the failing gate when one is red", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runProfileGates: async () => [
        { id: "phpcs", green: false, exitCode: 2 },
        { id: "phpstan", green: true, exitCode: 0 },
      ],
    });
    const input: GateInput = { taskId: "P3", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(false);
    expect(result.decision).toBe("RETRY");
    expect(result.reasons).toContain("profile gate 'phpcs' FAILED (exit 2)");
  });

  it("propagates a gate that could not run at all", async () => {
    // A missing tool / absent vendor is an INFRA failure: not worker-fixable, so
    // it must escape runGate for the conductor to escalate -- never be folded
    // into a red verdict that loops the worker. Same contract as runAgentCi.
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runProfileGates: async () => {
        throw new Error("spawn phpcs ENOENT");
      },
    });
    const input: GateInput = { taskId: "P4", fileSet: ["a.ts"] };

    await expect(runGate(input, deps)).rejects.toThrow(/ENOENT/);
  });
});

describe("gate feedback persistence", () => {
  it("writes the failing step's output when the decision is RETRY", async () => {
    const written: { taskId: string; content: string | null }[] = [];
    const { deps } = makeDeps({
      runProfileGates: async () => [
        { id: "phpcs", green: false, exitCode: 1, output: "3 | ERROR | Missing docblock" },
      ],
      writeGateFeedback: async (taskId: string, content: string | null) => {
        written.push({ taskId, content });
      },
    });
    const v = await runGate({ taskId: "t1", fileSet: ["a.php"] }, deps);
    expect(v.decision).toBe("RETRY");
    expect(written).toHaveLength(1);
    expect(written[0]!.content).toContain("Missing docblock");
  });

  it("CLEARS the document when the gate run had no failures", async () => {
    // A "latest value" artifact that survives a clean run would contradict the
    // real outcome -- gotcha [conductor/per-round-overwrite-stale].
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });
    await runGate({ taskId: "t1", fileSet: ["a.php"] }, deps);
    expect(written).toEqual([null]);
  });

  it("includes a failing check command, not only profile gates", async () => {
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      runCheck: async () => ({ green: false, exitCode: 2, output: "PHPUnit: 1 failure" }),
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });
    await runGate({ taskId: "t1", fileSet: ["a.php"] }, deps);
    expect(written[0]).toContain("PHPUnit: 1 failure");
  });

  it("is optional -- a deps set without the hook behaves exactly as before", async () => {
    const { deps } = makeDeps({
      runProfileGates: async () => [{ id: "phpcs", green: false, exitCode: 1, output: "x" }],
    });
    const v = await runGate({ taskId: "t1", fileSet: ["a.php"] }, deps);
    expect(v.decision).toBe("RETRY");
  });
});
