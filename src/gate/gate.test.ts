import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { runGate } from "./gate.js";
import type { GateDeps, GateInput } from "./gate.js";
import type { Invariants, ContractZone } from "./invariants.js";
import type { GuardRow, GuardRecipePair } from "./guards.js";
import { AgentCiUnavailableError } from "./agent-ci-exec.js";
import { parseCheckstyle } from "./checkstyle.js";
import { filterFindings } from "./finding-filter.js";
import { classifyGateExit } from "../profile/profile.js";
import type { ProfileGateRecord } from "./profile-gate-record.js";

/** A green whole-project gate record, the shape the composition root emits. */
function gateRec(over: Partial<ProfileGateRecord> = {}): ProfileGateRecord {
  return {
    id: "phpcs",
    status: "green",
    exit_code: 0,
    skip_reason: null,
    scope: "whole-project",
    files: [],
    findings: null,
    findings_total: null,
    output: "",
    ...over,
  };
}

// The REAL captured PHPCS checkstyle report, same fixture `checkstyle.test.ts` and
// `finding-filter.test.ts` are pinned on -- never a hand-authored one (see
// `docs/gotchas/agent-ci-ndjson-keyed-by-event-not-type.md`). 17 findings across
// lines 1 (x2), 2 (x1), 3 (x14), against the absolute Windows path
// `C:\Users\maksi\AppData\Local\Temp\tmp.e3mbbP7xGX\bad.php`.
const CHECKSTYLE_XML = readFileSync(new URL("./__fixtures__/phpcs-checkstyle.xml", import.meta.url), "utf8");
const CHECKSTYLE_WORKTREE = "C:\\Users\\maksi\\AppData\\Local\\Temp\\tmp.e3mbbP7xGX";

/**
 * Fakes the composition root's real `runProfileGates` algorithm (`src/composition/
 * root.ts`) -- classify the exit code FIRST via the real `classifyGateExit`, and
 * only reach for the real `parseCheckstyle`/`filterFindings` when the outcome is
 * RED -- using the REAL functions those modules export, not a re-implementation.
 * `root.ts` itself is untested glue by design (it spawns real subprocesses); this
 * is how the safety-critical ordering it MUST follow gets pinned by an actual test
 * instead of living only as a comment nobody checks.
 */
function makeReportGateRun(opts: {
  exitCode: number;
  redExitCodes: number[];
  rawOutput: string;
  worktreePath: string;
  parseSpy?: typeof parseCheckstyle;
}): NonNullable<GateDeps["runProfileGates"]> {
  const parse = opts.parseSpy ?? parseCheckstyle;
  return async (_changedFiles, addedLines) => {
    const gate = { redExitCodes: opts.redExitCodes };
    const classification = classifyGateExit(gate, opts.exitCode);
    if (classification === "unrunnable") {
      throw new Error(
        `profile gate 'phpcs' exited ${opts.exitCode}, which is neither 0 nor one of its declared red exit codes ` +
          `[${opts.redExitCodes.join(", ")}] -- the gate could not complete (not a worker-fixable failure)`,
      );
    }
    if (classification === "green") {
      return [gateRec({ status: "green", exit_code: opts.exitCode, scope: "changed-lines" })];
    }
    // classification === "red" -- only NOW is the parser reached.
    const parsed = parse(opts.rawOutput);
    const findings = filterFindings(parsed, addedLines.added, opts.worktreePath, addedLines.newFiles);
    return [
      gateRec({
        status: findings.length === 0 ? "green" : "red",
        exit_code: opts.exitCode,
        scope: "changed-lines",
        findings,
        findings_total: parsed.length,
      }),
    ];
  };
}

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
      runProfileGates: async () => [gateRec({ status: "green", exit_code: 0 })],
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
        gateRec({ id: "phpcs", status: "red", exit_code: 2 }),
        gateRec({ id: "phpstan", status: "green", exit_code: 0 }),
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

describe("profile gates -- 'report: checkstyle' line-scoping (Task 4)", () => {
  // Both diffs below describe changes to the SAME file the real fixture's
  // findings are attributed to (`bad.php`, under CHECKSTYLE_WORKTREE) -- only the
  // ADDED line differs, which is exactly the variable under test.

  // Adds line 10 only. None of the fixture's finding lines (1, 2, 3) match, so
  // every finding is dropped as pre-existing debt outside this diff.
  const DIFF_TOUCHES_LINE_10 = [
    "diff --git a/bad.php b/bad.php",
    "--- a/bad.php",
    "+++ b/bad.php",
    "@@ -9,1 +9,2 @@",
    " context-line-9",
    "+added-line-10",
  ].join("\n");

  // Adds line 2 only. Exactly ONE fixture finding sits on line 2 ("Missing doc
  // comment for class Bad_Thing") -- every other finding (lines 1 and 3) is
  // pre-existing debt on lines this diff never touched.
  const DIFF_TOUCHES_LINE_2 = [
    "diff --git a/bad.php b/bad.php",
    "--- a/bad.php",
    "+++ b/bad.php",
    "@@ -1,2 +1,3 @@",
    " context-line-1",
    "+added-line-2",
    " context-line-3",
  ].join("\n");

  it("is green and COMMITs when every finding sits OUTSIDE the diff, even though the fixture's exit code is non-zero (the whole feature)", async () => {
    const { deps } = makeDeps({
      changedFiles: ["bad.php"],
      diffText: DIFF_TOUCHES_LINE_10,
      runProfileGates: makeReportGateRun({
        exitCode: 2, // PHPCS real "errors+warnings" exit -- genuinely non-zero
        redExitCodes: [1, 2],
        rawOutput: CHECKSTYLE_XML,
        worktreePath: CHECKSTYLE_WORKTREE,
      }),
    });
    const input: GateInput = { taskId: "PR1", fileSet: ["bad.php"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
    expect(result.reasons.some((r) => /profile gate/i.test(r))).toBe(false);
  });

  it("RETRYs on one in-diff finding, and the feedback names ONLY that finding", async () => {
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      changedFiles: ["bad.php"],
      diffText: DIFF_TOUCHES_LINE_2,
      runProfileGates: makeReportGateRun({
        exitCode: 2,
        redExitCodes: [1, 2],
        rawOutput: CHECKSTYLE_XML,
        worktreePath: CHECKSTYLE_WORKTREE,
      }),
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });
    const input: GateInput = { taskId: "PR2", fileSet: ["bad.php"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(false);
    expect(result.decision).toBe("RETRY");
    expect(written).toHaveLength(1);
    const doc = written[0]!;
    expect(doc).not.toBeNull();
    expect(doc).toContain("Missing doc comment for class Bad_Thing");
    // The line-1 and line-3 findings are pre-existing debt outside this diff --
    // this is the assertion the whole feature exists to make true.
    expect(doc).not.toContain("Missing file doc comment");
    expect(doc).not.toContain("Missing doc comment for function x()");
  });

  it("THROWS (unrunnable), not green, when the report does not parse", async () => {
    const { deps } = makeDeps({
      changedFiles: ["bad.php"],
      diffText: DIFF_TOUCHES_LINE_2,
      runProfileGates: makeReportGateRun({
        exitCode: 2, // RED per redExitCodes -- reaches the parser
        redExitCodes: [1, 2],
        rawOutput: "phpcs: command not found", // not a checkstyle report at all
        worktreePath: CHECKSTYLE_WORKTREE,
      }),
    });
    const input: GateInput = { taskId: "PR3", fileSet: ["bad.php"] };

    await expect(runGate(input, deps)).rejects.toThrow(/checkstyle/i);
  });

  it("classifies UNRUNNABLE before any parse is attempted for an exit code outside redExitCodes (proves the parser was never called)", async () => {
    const parseSpy = vi.fn(parseCheckstyle);
    const { deps } = makeDeps({
      changedFiles: ["bad.php"],
      diffText: DIFF_TOUCHES_LINE_2,
      runProfileGates: makeReportGateRun({
        exitCode: 3, // PHPCS processing-error exit -- neither 0 nor a declared red code
        redExitCodes: [1, 2],
        rawOutput: CHECKSTYLE_XML,
        worktreePath: CHECKSTYLE_WORKTREE,
        parseSpy,
      }),
    });
    const input: GateInput = { taskId: "PR4", fileSet: ["bad.php"] };

    await expect(runGate(input, deps)).rejects.toThrow(/neither 0 nor/);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("a gate WITHOUT 'report' is byte-identical to today: verdict from the exit code alone, raw output in the feedback", async () => {
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runProfileGates: async () => [gateRec({ status: "red", exit_code: 2, output: "3 | ERROR | some finding" })],
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });
    const input: GateInput = { taskId: "PR5", fileSet: ["src/foo.ts"] };

    const result = await runGate(input, deps);

    expect(result.profile_green).toBe(false);
    expect(result.decision).toBe("RETRY");
    expect(written[0]).toContain("3 | ERROR | some finding");
  });
});

describe("gate feedback persistence", () => {
  it("writes the failing step's output when the decision is RETRY", async () => {
    const written: { taskId: string; content: string | null }[] = [];
    const { deps } = makeDeps({
      runProfileGates: async () => [
        gateRec({ status: "red", exit_code: 1, output: "3 | ERROR | Missing docblock" }),
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
      runProfileGates: async () => [gateRec({ status: "red", exit_code: 1, output: "x" })],
    });
    const v = await runGate({ taskId: "t1", fileSet: ["a.php"] }, deps);
    expect(v.decision).toBe("RETRY");
  });

  // agent-ci pushes to `reasons` but, before this fix, never to `failedSteps` --
  // so when it is the ONLY red component, `formatGateFeedback([])` returns null
  // and write-or-clear DELETES any existing document: a RETRY with no
  // explanation at all.
  it("agent-ci red ALONE still produces gate-feedback content (does not wrongly CLEAR the previous document)", async () => {
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      runAgentCi: async () => ({ green: false, reasons: ["agent-ci workflow '.github/workflows/ci.yml' FAILED"] }),
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });
    const input: GateInput = { taskId: "t1", fileSet: ["a.ts"] };

    const result = await runGate(input, deps);

    expect(result.decision).toBe("RETRY");
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBeNull();
    expect(written[0]).toContain("ci.yml");
  });

  // `runGate` can throw from many places (a loader, resolveScope, guardStillRed,
  // an agent-ci/profile-gate infra failure, writeVerdict itself). Before this fix
  // the write-or-clear call sat only at the normal decisive exit, so a throw left
  // the PREVIOUS round's gate-feedback.md untouched -- presenting an old run's
  // failure as feedback for a run that never completed.
  it("a dep that throws AFTER a prior failing step still calls writeGateFeedback with that step, and the original error propagates unmasked", async () => {
    const written: { taskId: string; content: string | null }[] = [];
    const boom = new Error("guardStillRed boom");
    const invariants = makeInvariants({ contract_zones: [zoneA] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [pairA],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';"]),
      runCheck: async () => ({ green: false, exitCode: 1, output: "prior failure output" }),
      guardStillRed: async () => {
        throw boom;
      },
      writeGateFeedback: async (taskId: string, content: string | null) => {
        written.push({ taskId, content });
      },
    });
    const input: GateInput = { taskId: "T-throw", fileSet: ["src/thing.ts"] };

    await expect(runGate(input, deps)).rejects.toBe(boom);
    expect(written).toHaveLength(1);
    expect(written[0]!.content).toContain("prior failure output");
  });

  // If the feedback write ITSELF throws while the gate is already unwinding from
  // a real error, the original error must still be what the caller sees --
  // otherwise a disk-full feedback write would mask the actual gate failure.
  it("when the ORIGINAL gate step throws AND the feedback write also throws, the original error wins (not masked)", async () => {
    const originalErr = new Error("guardStillRed boom");
    const feedbackErr = new Error("disk full");
    const invariants = makeInvariants({ contract_zones: [zoneA] });
    const { deps } = makeDeps({
      invariants,
      guardPairs: [pairA],
      changedFiles: ["src/thing.ts"],
      diffText: makeDiff(["+const x = 'value-a';"]),
      guardStillRed: async () => {
        throw originalErr;
      },
      writeGateFeedback: async () => {
        throw feedbackErr;
      },
    });
    const input: GateInput = { taskId: "T-double-throw", fileSet: ["src/thing.ts"] };

    await expect(runGate(input, deps)).rejects.toBe(originalErr);
  });

  // The mirror case: on the NORMAL (non-throwing) path, a persistence failure in
  // writeGateFeedback SHOULD reject runGate -- a failed clear that still returned
  // COMMIT would be more dangerous than surfacing the write failure.
  it("on a normal (non-throwing) gate run, a writeGateFeedback persistence failure REJECTS runGate rather than returning a silent COMMIT", async () => {
    const feedbackErr = new Error("disk full");
    const { deps } = makeDeps({
      changedFiles: ["src/foo.ts"],
      writeGateFeedback: async () => {
        throw feedbackErr;
      },
    });
    const input: GateInput = { taskId: "T-normal-write-fail", fileSet: ["src/foo.ts"] };

    await expect(runGate(input, deps)).rejects.toBe(feedbackErr);
  });
});

describe("ProfileGateRecord (Task 1 -- per-gate records, including skipped)", () => {
  it("a SKIPPED profile gate does not turn the verdict red but is recorded", async () => {
    const { deps } = makeDeps({
      changedFiles: ["docs/x.md"],
      runProfileGates: async () => [
        gateRec({ id: "phpcs", status: "skipped", exit_code: null, skip_reason: "no changed file matched **/*.php", scope: "changed-lines" }),
        gateRec({ id: "composer-validate", status: "green" }),
      ],
    });
    const v = await runGate({ taskId: "t1", fileSet: ["docs/x.md"] }, deps);
    expect(v.profile_green).toBe(true);
    expect(v.decision).not.toBe("RETRY");
    expect(v.profile_gates.map((r) => [r.id, r.status])).toEqual([
      ["phpcs", "skipped"],
      ["composer-validate", "green"],
    ]);
    expect(v.profile_gates[0]!.skip_reason).toBe("no changed file matched **/*.php");
  });

  it("a RED profile gate record turns the verdict red and is recorded", async () => {
    const { deps } = makeDeps({
      changedFiles: ["src/a.php"],
      runProfileGates: async () => [gateRec({ status: "red", exit_code: 1, scope: "changed-files", files: ["src/a.php"] })],
    });
    const v = await runGate({ taskId: "t1", fileSet: ["src/a.php"] }, deps);
    expect(v.profile_green).toBe(false);
    expect(v.decision).toBe("RETRY");
    expect(v.profile_gates[0]!.status).toBe("red");
  });

  it("no profile attached leaves profile_gates empty, not absent", async () => {
    const { deps } = makeDeps({ changedFiles: ["src/foo.ts"], runProfileGates: null });
    const v = await runGate({ taskId: "t1", fileSet: ["src/foo.ts"] }, deps);
    expect(v.profile_gates).toEqual([]);
  });
});
