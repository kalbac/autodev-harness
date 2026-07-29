import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { runGate } from "./gate.js";
import type { GateDeps, GateInput } from "./gate.js";
import type { Invariants, ContractZone } from "./invariants.js";
import { diffAddedRemovedLines } from "./invariants.js";
import type { GuardRow, GuardRecipePair } from "./guards.js";
import { AgentCiUnavailableError } from "./agent-ci-exec.js";
import { CommandUnavailableError, inspectCommand } from "./command-availability.js";
import type { CommandAvailabilityReport } from "./command-availability.js";
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
  /** The gate's resolved ruleset path, mirroring what `root.ts` hands
   *  `filterFindings` to anchor a RELATIVE report path (#155). `root.ts` derives
   *  it as `g.ruleset === null ? null : g.rulesetPath`; here it is passed
   *  directly, and defaulting to `null` keeps every pre-existing case in this
   *  file exercising the absolute-path branch unchanged. */
  rulesetPath?: string | null;
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
    const findings = filterFindings(
      parsed,
      addedLines.added,
      opts.worktreePath,
      addedLines.newFiles,
      opts.rulesetPath ?? null,
    );
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
  docPaths?: GateDeps["docPaths"];
  commandAvailability?: GateDeps["commandAvailability"];
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
    ...(overrides.docPaths !== undefined ? { docPaths: overrides.docPaths } : {}),
    ...(overrides.commandAvailability !== undefined ? { commandAvailability: overrides.commandAvailability } : {}),
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

describe("#155: line-scoping survives a PROJECT-DECLARED ruleset (adr/010)", () => {
  // Captured s64 from the operator's own theme by running the gate's own phpcs
  // command against the project's `phpcs.xml.dist`, which declares
  // `<arg name="basepath" value="."/>`. PHPCS resolves that against the RULESET
  // FILE's directory -- the trusted root -- while the gate runs with the
  // worktree as cwd, so every path arrives carrying the worktree's own location
  // as a prefix instead of being relative to it.
  const PROJECT_XML = readFileSync(
    new URL("./__fixtures__/phpcs-checkstyle-project-basepath.xml", import.meta.url),
    "utf8",
  );
  const WORKTREE = "D:\\Projects\\woodev_base_theme_autodev\\.autodev\\worktrees\\s64-probe";
  const RULESET = "D:\\Projects\\woodev_base_theme_autodev\\phpcs.xml.dist";
  const PROBE = "woodev-base-theme/inc/s64-probe.php";

  // The fixture's four findings sit on lines 1, 2, 7 and 9. This diff adds line
  // 5 alone, so ALL of them are pre-existing debt this change never touched.
  const DIFF_TOUCHES_LINE_5 = [
    `diff --git a/${PROBE} b/${PROBE}`,
    `--- a/${PROBE}`,
    `+++ b/${PROBE}`,
    "@@ -4,1 +4,2 @@",
    " context-line-4",
    "+added-line-5",
  ].join("\n");

  it("COMMITs a change that touches no reported line, once the ruleset anchors the report", async () => {
    const { deps } = makeDeps({
      changedFiles: [PROBE],
      diffText: DIFF_TOUCHES_LINE_5,
      runProfileGates: makeReportGateRun({
        exitCode: 2,
        redExitCodes: [1, 2],
        rawOutput: PROJECT_XML,
        worktreePath: WORKTREE,
        rulesetPath: RULESET,
      }),
    });

    const result = await runGate({ taskId: "S64-1", fileSet: [PROBE] }, deps);

    expect(result.profile_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
  });

  it("REPRODUCES #155 without the anchor: the same change is blocked by debt it never wrote", async () => {
    // The only difference from the case above is the missing `rulesetPath`.
    // Every finding lands `unattributed`, unattributed findings are kept, and
    // the worker is now judged over the WHOLE FILE -- the exact defect
    // `docs/gotchas/profile-gates-must-be-diff-scoped.md` was written to close,
    // reopened by adr/010's own mechanism. On a legacy file this is
    // unsatisfiable: the worker cannot converge on debt that is not in its diff.
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      changedFiles: [PROBE],
      diffText: DIFF_TOUCHES_LINE_5,
      runProfileGates: makeReportGateRun({
        exitCode: 2,
        redExitCodes: [1, 2],
        rawOutput: PROJECT_XML,
        worktreePath: WORKTREE,
      }),
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });

    const result = await runGate({ taskId: "S64-2", fileSet: [PROBE] }, deps);

    expect(result.profile_green).toBe(false);
    expect(result.decision).toBe("RETRY");
    expect(written[0]).toContain("Missing file doc comment");
  });

  it("still RETRYs on a finding that IS on an added line (the anchor scopes, it does not excuse)", async () => {
    // Line 9 is the long-array literal. The fix must not turn line-scoping into
    // a blanket pass for project-declared rulesets.
    const diffTouchesLine9 = [
      `diff --git a/${PROBE} b/${PROBE}`,
      `--- a/${PROBE}`,
      `+++ b/${PROBE}`,
      "@@ -8,1 +8,2 @@",
      " context-line-8",
      "+added-line-9",
    ].join("\n");
    const written: (string | null)[] = [];
    const { deps } = makeDeps({
      changedFiles: [PROBE],
      diffText: diffTouchesLine9,
      runProfileGates: makeReportGateRun({
        exitCode: 2,
        redExitCodes: [1, 2],
        rawOutput: PROJECT_XML,
        worktreePath: WORKTREE,
        rulesetPath: RULESET,
      }),
      writeGateFeedback: async (_t: string, content: string | null) => {
        written.push(content);
      },
    });

    const result = await runGate({ taskId: "S64-3", fileSet: [PROBE] }, deps);

    expect(result.decision).toBe("RETRY");
    const doc = written[0]!;
    expect(doc).toContain("Short array syntax must be used");
    // ...and ONLY that one: the three findings on untouched lines stay dropped.
    expect(doc).not.toContain("Missing file doc comment");
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

// ---------------------------------------------------------------------------
// adr/008 (#140): documenting a contract value is not touching the contract.
//
// The measured shape, from the s59 corpus run: the ONLY changed file is
// `docs/OVERVIEW.md`, whose whole purpose was to document that the plugin
// registers `test_pickup` -- and the gate escalated `needs-guard`, demanding a
// mutation-verified guard for a sentence of prose, because `path_globs` was an
// OR-arm rather than the zone's scope.
// ---------------------------------------------------------------------------
describe("contract-zone scoping (adr/008)", () => {
  /** The polygon's real zone: it declares WHERE its contract lives. */
  const scopedZone: ContractZone = {
    id: "shipping-method-ids",
    why: "persisted shipping-method ids",
    auto_guardable: true,
    path_globs: ["includes/class-test-shipping-method-*.php"],
    grep_patterns: [],
    exact_strings: ["test_pickup"],
  };

  /** A zone that declares no scope at all -- (a) cannot help it, only (b) can. */
  const unscopedZone: ContractZone = { ...scopedZone, id: "unscoped-ids", path_globs: [] };

  /** No constitution globs: these tests are about the ZONE step, and the default
   *  fixture fences `docs/**` outright, which would mask the behaviour under test. */
  const noConstitution = { constitution: { path_globs: [] } };

  const docsDiff = [
    "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
    "--- a/docs/OVERVIEW.md",
    "+++ b/docs/OVERVIEW.md",
    "@@ -3,0 +4,1 @@",
    "+The plugin registers test_pickup as a shipping method id.",
  ].join("\n");

  const codeDiff = [
    "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-test-shipping-method-pickup.php",
    "--- a/includes/class-test-shipping-method-pickup.php",
    "+++ b/includes/class-test-shipping-method-pickup.php",
    "@@ -10,0 +11,1 @@",
    "+        $this->id = 'test_pickup';",
    "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
    "--- a/docs/OVERVIEW.md",
    "+++ b/docs/OVERVIEW.md",
    "@@ -3,0 +4,1 @@",
    "+The plugin registers test_pickup as a shipping method id.",
  ].join("\n");

  it("(a) a docs-only change does NOT touch a zone that declared where its contract lives", async () => {
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: docsDiff,
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.zones_touched).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.decision).toBe("COMMIT");
  });

  it("(a) still catches the value when the change actually touches the zone's files", async () => {
    // The other direction of the same test -- without this, "no escalation" above
    // could equally mean the zone check stopped working (a mutation of the fix
    // that passes the first test alone).
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"],
      diffText: codeDiff,
    });

    const result = await runGate(
      { taskId: "T1", fileSet: ["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"] },
      deps,
    );

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);
    expect(result.zones_touched[0]!.uncovered_strings).toEqual(["test_pickup"]);
  });

  it("(a) leaves a zone with NO path_globs scanning the whole diff (unchanged default)", async () => {
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [unscopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: docsDiff,
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["unscoped-ids"]);
  });

  it("(b) a declared contract.docPaths path is outside zone checking, even for an unscoped zone", async () => {
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [unscopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: docsDiff,
      docPaths: ["docs/**", "README.md"],
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.zones_touched).toEqual([]);
    expect(result.decision).toBe("COMMIT");
  });

  it("(b) does NOT exempt a declared doc path from the constitution fence", async () => {
    // The narrowing is scoped to contract zones. The human-only fence is the
    // stronger guarantee, and one declaration must not quietly buy two exemptions.
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [unscopedZone], constitution: { path_globs: ["docs/**"] } }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: docsDiff,
      docPaths: ["docs/**"],
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.constitution_touched).toEqual(["docs/OVERVIEW.md"]);
    expect(result.reasons.some((r) => r.includes("constitution path(s) changed"))).toBe(true);
  });

  it("a rename OUT of the zone into a DECLARED doc path still escalates (R1 review finding)", async () => {
    // The attack the first implementation opened: attribute a hunk's lines to its
    // post-image path only, and `git mv includes/class-x.php docs/x.md` carries the
    // zone's contract values into a declared documentation path, where (b) then
    // drops them. Both sides of the section decide now -- in scope if ANY path
    // matches the zone, exempt only if EVERY path is declared.
    const renameDiff = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/OVERVIEW.md",
      "similarity index 60%",
      "rename from includes/class-test-shipping-method-pickup.php",
      "rename to docs/OVERVIEW.md",
      "--- a/includes/class-test-shipping-method-pickup.php",
      "+++ b/docs/OVERVIEW.md",
      "@@ -10,1 +10,1 @@",
      "-        $this->id = 'test_pickup';",
      "+The plugin used to register test_pickup.",
    ].join("\n");
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      // What `git diff --name-only` reports for a detected rename: the new path only.
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: renameDiff,
      docPaths: ["docs/**"],
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);
    expect(result.zones_touched[0]!.uncovered_strings).toEqual(["test_pickup"]);
  });

  it("an unparseable diff falls back to the OLD unscoped reading, never to leniency", async () => {
    // Truncated mid-hunk: the strict walker throws, and the zone must still be
    // reported touched -- a diff the harness cannot read is not a reason to skip
    // a contract check (Principle 10).
    //
    // R3 review finding: asserting ESCALATE alone proves nothing, because the
    // PRE-adr/008 code escalated on this input too (it scanned the whole diff
    // unconditionally). The control below is what makes this test non-vacuous --
    // the SAME content in a WELL-FORMED diff must NOT escalate, so the only thing
    // that can explain the difference is the fallback actually running.
    const truncated = [
      "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
      "--- a/docs/OVERVIEW.md",
      "+++ b/docs/OVERVIEW.md",
      "@@ -3,4 +4,4 @@",
      "+The plugin registers test_pickup as a shipping method id.",
    ].join("\n");
    const wellFormed = [
      "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
      "--- a/docs/OVERVIEW.md",
      "+++ b/docs/OVERVIEW.md",
      "@@ -3,0 +4,1 @@",
      "+The plugin registers test_pickup as a shipping method id.",
    ].join("\n");

    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: truncated,
    });
    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);

    const { deps: controlDeps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: wellFormed,
    });
    const control = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, controlDeps);

    expect(control.zones_touched).toEqual([]);
    expect(control.decision).toBe("COMMIT");
  });

it("catches a contract value on a line the OLD flat reader dropped (R5 review finding)", async () => {
    // The strict walker tells a `+++ b/path` HEADER from an added line whose own
    // content starts with `++` by the hunk's declared counts, which is the only
    // way to tell them apart -- they are byte-identical on the wire. The flat
    // reader cannot, so it drops every such line (`/^(\+\+\+|---)/` in
    // `diffAddedRemovedLines`), and the pre-adr/008 gate never saw a contract
    // value written on one.
    //
    // So adr/008 is NOT byte-identical for a zone with no `path_globs` and no
    // declared docs: it is STRICTER, on exactly the shape a worker would use to
    // slip a contract value past the scan. First the measurement that the two
    // readers really do disagree, then the gate behaviour that follows from it.
    const sneaky = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-test-shipping-method-pickup.php",
      "--- a/includes/class-test-shipping-method-pickup.php",
      "+++ b/includes/class-test-shipping-method-pickup.php",
      "@@ -1,0 +1,1 @@",
      "+++test_pickup",
    ].join("\n");

    expect(diffAddedRemovedLines(sneaky).join("|")).not.toContain("test_pickup");

    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [unscopedZone], ...noConstitution }),
      changedFiles: ["includes/class-test-shipping-method-pickup.php"],
      diffText: sneaky,
    });

    const result = await runGate(
      { taskId: "T1", fileSet: ["includes/class-test-shipping-method-pickup.php"] },
      deps,
    );

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["unscoped-ids"]);
  });

  it("a headerless contract value still escalates -- malformed input is never LESS checked (R7 finding)", async () => {
    // The diff names a contract value and nothing else: no `diff --git`, no file
    // header, no hunk. The pre-adr/008 gate caught it, because its flat reader
    // takes any line starting with `+`. The strict walker ignored it, so the zone
    // saw no lines at all and the gate committed -- leniency introduced by a
    // parser upgrade, on exactly the input a parser upgrade must not relax.
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: "+test_pickup",
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);
  });

  it("an extra line past the hunk's declared count cannot hide behind the previous file (R8 finding)", async () => {
    // The hunk claims ONE added line. The second `+` line is outside it, and the
    // only path in scope belongs to the hunk that already ended. Filing it under
    // that path put a contract value inside a declared documentation file, where
    // a zone scoped to `includes/**` never looks -- so the gate committed a diff
    // naming `test_pickup`. A line no hunk accounts for belongs to no file.
    const extraLine = [
      "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
      "--- a/docs/OVERVIEW.md",
      "+++ b/docs/OVERVIEW.md",
      "@@ -3,0 +4,1 @@",
      "+ordinary documentation",
      "+test_pickup",
    ].join("\n");
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: extraLine,
      docPaths: ["docs/**"],
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);
  });

  it("a 100%-similarity rename OUT of the zone still trips it (R3 review finding)", async () => {
    // The shape that has no hunk body at all: no `---`/`+++` pair, no `+`/`-`
    // line, and `git diff --name-only` -- which is where the gate's changedFiles
    // come from -- names ONLY the destination. Without unioning in the paths the
    // diff itself names, the zone globbing the SOURCE file sees no changed file
    // and no lines to scan, so the gate reports untouched while the conductor
    // reports touched: two answers to one question, on a change that physically
    // moved a contract value out of the zone that governs it.
    const pureRename = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/OVERVIEW.md",
      "similarity index 100%",
      "rename from includes/class-test-shipping-method-pickup.php",
      "rename to docs/OVERVIEW.md",
    ].join("\n");
    const { deps } = makeDeps({
      invariants: makeInvariants({ contract_zones: [scopedZone], ...noConstitution }),
      // What git reports for a detected rename: the post-image path only.
      changedFiles: ["docs/OVERVIEW.md"],
      diffText: pureRename,
    });

    const result = await runGate({ taskId: "T1", fileSet: ["docs/OVERVIEW.md"] }, deps);

    expect(result.decision).toBe("ESCALATE");
    expect(result.zones_touched.map((z) => z.id)).toEqual(["shipping-method-ids"]);
  });
});

/**
 * Step 1b's pre-flight (#141 sibling fix, s61): the gate must not RUN a
 * `success_command` that does not exist. The s60 corpus run lost a correct diff to
 * exactly this -- a hallucinated `pnpm lint:php:changes` exited 1, the gate read
 * that as a failing check, and the worker was RETRIED three times against a
 * command no project ever declared.
 */
describe("runGate — success_command availability pre-flight", () => {
  const noConstitutionDeps = { invariants: makeInvariants({ constitution: { path_globs: [] } }) };

  /** The REAL classifier against a fake probe, rather than a hand-written report: the
   *  detail the gate throws is composed by the same code the production wiring uses, so
   *  these tests cannot pass on a message the real path would never produce. The probe
   *  says "the manager exists, the project declares no scripts", which is exactly the
   *  s60 shape (`pnpm <script>` with no such script). */
  const undeclaredScripts = (cmd: string): Promise<CommandAvailabilityReport> =>
    inspectCommand(cmd, { packageScripts: async () => new Set<string>(), programExists: async () => true });
  const reportOf = (availability: "available" | "unknown") => async (): Promise<CommandAvailabilityReport> => ({
    availability,
  });

  it("throws CommandUnavailableError instead of RUNNING an unavailable command", async () => {
    const ran: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: undeclaredScripts,
      runSuccessCommand: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 1 };
      },
    });

    const input: GateInput = {
      taskId: "TA1",
      fileSet: ["src/foo.ts"],
      successCommands: ["pnpm lint:php:changes"],
    };

    await expect(runGate(input, deps)).rejects.toBeInstanceOf(CommandUnavailableError);
    // The command must never have been spawned -- a throw AFTER running it would
    // still have burned the run and produced the misleading exit-1 output.
    expect(ran).toEqual([]);
  });

  it("names the command and what is missing in the thrown error's detail", async () => {
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: undeclaredScripts,
    });

    let err: unknown;
    try {
      await runGate({ taskId: "TA2", fileSet: ["src/foo.ts"], successCommands: ["pnpm lint:php:changes"] }, deps);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CommandUnavailableError);
    const cue = err as CommandUnavailableError;
    expect(cue.reason).toBe("script-not-declared");
    expect(cue.detail).toContain("pnpm lint:php:changes");
    expect(cue.detail).toMatch(/package\.json/);
  });

  it("does NOT return a RETRY verdict for an unavailable command", async () => {
    // The whole point: a missing command is broken CONFIG. A RETRY verdict here
    // would hand the worker a defect that is not in its diff.
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: undeclaredScripts,
    });

    const result = await runGate(
      { taskId: "TA3", fileSet: ["src/foo.ts"], successCommands: ["pnpm nope"] },
      deps,
    ).then(
      (v) => ({ threw: false as const, v }),
      (e: unknown) => ({ threw: true as const, e }),
    );

    expect(result.threw).toBe(true);
  });

  it("RUNS the command when the verdict is `unknown` (byte-identical to pre-change behaviour)", async () => {
    const ran: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: reportOf("unknown"),
      runSuccessCommand: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 0 };
      },
    });

    const result = await runGate(
      { taskId: "TA4", fileSet: ["src/foo.ts"], successCommands: ["mystery-tool --check"] },
      deps,
    );

    expect(ran).toEqual(["mystery-tool --check"]);
    expect(result.success_green).toBe(true);
    expect(result.decision).toBe("COMMIT");
  });

  it("RUNS the command when the verdict is `available`, and a real failure is still a RETRY", async () => {
    const ran: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: reportOf("available"),
      runSuccessCommand: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 1 };
      },
    });

    const result = await runGate(
      { taskId: "TA5", fileSet: ["src/foo.ts"], successCommands: ["npm run lint"] },
      deps,
    );

    expect(ran).toEqual(["npm run lint"]);
    expect(result.decision).toBe("RETRY");
    expect(result.reasons.some((r) => r.includes("npm run lint"))).toBe(true);
  });

  it("is INERT when the optional dep is absent (every pre-change caller unchanged)", async () => {
    const ran: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      runSuccessCommand: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 0 };
      },
    });

    const result = await runGate(
      { taskId: "TA6", fileSet: ["src/foo.ts"], successCommands: ["pnpm lint:php:changes"] },
      deps,
    );

    expect(ran).toEqual(["pnpm lint:php:changes"]);
    expect(result.decision).toBe("COMMIT");
  });

  it("checks each command BEFORE running it, command by command", async () => {
    // The first command is available and must actually run; the second is not and
    // must abort the loop before it is spawned.
    const ran: string[] = [];
    const asked: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: async (cmd) => {
        asked.push(cmd);
        return cmd === "npm run lint" ? { availability: "available" as const } : undeclaredScripts(cmd);
      },
      runSuccessCommand: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 0 };
      },
    });

    await expect(
      runGate(
        { taskId: "TA7", fileSet: ["src/foo.ts"], successCommands: ["npm run lint", "pnpm nope"] },
        deps,
      ),
    ).rejects.toBeInstanceOf(CommandUnavailableError);

    expect(asked).toEqual(["npm run lint", "pnpm nope"]);
    expect(ran).toEqual(["npm run lint"]);
  });

  it("skips blank commands without asking the probe (unchanged skip-blank behaviour)", async () => {
    const asked: string[] = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      commandAvailability: async (cmd) => {
        asked.push(cmd);
        return undeclaredScripts(cmd);
      },
    });

    const result = await runGate(
      { taskId: "TA8", fileSet: ["src/foo.ts"], successCommands: ["", "   "] },
      deps,
    );

    expect(asked).toEqual([]);
    expect(result.decision).toBe("COMMIT");
  });

  it("still writes a truthful gate-feedback document when it throws", async () => {
    // The write-once-at-the-decisive-exit contract must survive this new throw:
    // the check command failed BEFORE the availability abort, and the worker must
    // still see that -- not a stale document from the previous round.
    const writes: Array<{ taskId: string; content: string | null }> = [];
    const { deps } = makeDeps({
      ...noConstitutionDeps,
      runCheck: async () => ({ green: false, exitCode: 2, output: "CHECK BOOM" }),
      commandAvailability: undeclaredScripts,
      writeGateFeedback: async (taskId, content) => {
        writes.push({ taskId, content });
      },
    });

    await expect(
      runGate({ taskId: "TA9", fileSet: ["src/foo.ts"], successCommands: ["pnpm nope"] }, deps),
    ).rejects.toBeInstanceOf(CommandUnavailableError);

    expect(writes.length).toBe(1);
    expect(writes[0]!.taskId).toBe("TA9");
    expect(writes[0]!.content).toContain("CHECK BOOM");
  });
});
