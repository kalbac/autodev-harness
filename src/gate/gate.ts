import { globMatch } from "../util/glob.js";
import { diffAddedRemovedLines, zoneTouched, zoneTouchedStrings } from "./invariants.js";
import type { Invariants } from "./invariants.js";
import { isBlessed, selectGuardForValue, selectGuardForZone } from "./guards.js";
import type { GuardRow, GuardRecipePair } from "./guards.js";

/**
 * The machine-gate decision core — parity: `gate.ps1 Invoke-AutodevGate`
 * (parity spec §4). Orchestrates the invariants/guards modules built in
 * earlier tasks into a single COMMIT/RETRY/ESCALATE verdict. This module
 * owns no I/O itself: every side effect (git, fs, subprocess) is injected
 * via `GateDeps` so the decision cascade can be unit-tested with fakes.
 */

export type Decision = "COMMIT" | "RETRY" | "ESCALATE";

/** Per-zone outcome recorded in the verdict. Parity: the `zones_touched` entries of `gate-verdict.json`. */
export interface ZoneResult {
  id: string;
  auto_guardable: boolean;
  guarded: boolean;
  guard_test: string | null;
  mutation_passed: boolean;
  blessed: boolean;
  touched_strings: string[];
  uncovered_strings: string[];
}

/**
 * The full gate decision. `composer_green` keeps the PS name for parity with
 * `gate-verdict.json`, even though the underlying check command is generic
 * (not necessarily `composer`).
 */
export interface GateVerdict {
  task_id: string;
  composer_green: boolean;
  success_green: boolean;
  agent_ci_green: boolean; // true when the feature is off / not applicable
  constitution_touched: string[];
  zones_touched: ZoneResult[];
  decision: Decision;
  reasons: string[];
  changed_files: string[];
}

export interface GateInput {
  taskId: string;
  fileSet: string[];
  range?: string;
  successCommands?: string[];
}

export interface GateDeps {
  /** Parse INVARIANTS.md. Called ONLY after the empty-file_set fast-path (a broken file must not block that verdict). */
  loadInvariants: () => Invariants | Promise<Invariants>;
  /** Parse GUARDS.md + load each mutation-verified guard's recipe (skips unverified/missing). Owns the fs. */
  loadGuardPairs: () => GuardRecipePair[] | Promise<GuardRecipePair[]>;
  /** Resolve the scoped changed files + unified diff text for this task (git). */
  resolveScope: (input: GateInput) => Promise<{ changedFiles: string[]; diffText: string }>;
  /** The whole-tree build/test command (composer check / npm test). null = skip. */
  runCheck: (() => Promise<{ green: boolean; exitCode: number }>) | null;
  /** Run one task success_command; exit 0 = pass. */
  runSuccessCommand: (cmd: string) => Promise<{ exitCode: number }>;
  /** Live mutation-check for a guard: true iff it still goes red-on-flip. Parity: Test-AutodevGuardStillRed. */
  guardStillRed: (guard: GuardRow) => Promise<boolean>;
  /** Optional agent-ci replay. null = feature off. May THROW: a genuine infra failure or an
   *  AgentCiUnavailableError (Windows-without-WSL) propagates OUT of runGate on purpose --
   *  do NOT wrap in try/catch here; the conductor escalates a gate throw. */
  runAgentCi: ((taskId: string) => Promise<{ green: boolean; reasons: string[] }>) | null;
  /** Config-level (trusted-root, worker-inaccessible) human-only path globs (adr/006
   *  Phase 1, closing Finding 2 -- `contract.constitutionPaths` was previously dead
   *  config). Unioned with `inv.constitution.path_globs` for the constitution check.
   *  Optional so the existing gate unit tests keep compiling unchanged. */
  constitutionPaths?: string[];
  /** Optional: persist gate-verdict.json. Omit in unit tests. */
  writeVerdict?: (taskId: string, verdict: GateVerdict) => Promise<void>;
}

/**
 * Parity: gate.ps1 Invoke-AutodevGate (parity spec §4). Checks in exact order
 * -> COMMIT|RETRY|ESCALATE.
 *
 * Failure contract (parity with the PS gate): the invariants/guards loaders and
 * `resolveScope` run BEFORE the check/zone logic, exactly as `gate.ps1` loads
 * `Get-AutodevInvariants`/`Get-AutodevGuards` before `composer check`. If a
 * loader, `guardStillRed`, or `writeVerdict` throws (e.g. a broken INVARIANTS.md
 * / GUARDS.md — an operator-config error a worker cannot fix), runGate REJECTS
 * rather than inventing a RETRY: a broken constitution file is not worker-fixable.
 * The conductor is the fail-closed net — it treats a gate throw as ESCALATE
 * (parity spec §2 step 7), and reads the durable gate-verdict.json only on
 * success. The one thing guaranteed without any loader is the empty-file_set
 * fast-path below.
 */
export async function runGate(input: GateInput, deps: GateDeps): Promise<GateVerdict> {
  // Step 0 — empty file_set fast-path, BEFORE any loader (a broken INVARIANTS.md
  // must never stop this verdict from being written).
  if (!input.range && (!input.fileSet || input.fileSet.length === 0)) {
    const verdict: GateVerdict = {
      task_id: input.taskId,
      composer_green: false,
      success_green: false,
      agent_ci_green: true,
      constitution_touched: [],
      zones_touched: [],
      decision: "ESCALATE",
      reasons: ["empty file_set -- nothing can be safely judged"],
      changed_files: [],
    };
    if (deps.writeVerdict) {
      await deps.writeVerdict(input.taskId, verdict);
    }
    return verdict;
  }

  const inv = await deps.loadInvariants();
  const guardPairs = await deps.loadGuardPairs();
  const { changedFiles, diffText } = await deps.resolveScope(input);
  const diffLines = diffAddedRemovedLines(diffText);
  const reasons: string[] = [];

  // 1. check command (whole tree). null = skip.
  let composerGreen = true;
  if (deps.runCheck !== null) {
    const cc = await deps.runCheck();
    composerGreen = cc.green;
    if (!composerGreen) {
      reasons.push(`check command FAILED (exit ${cc.exitCode})`);
    }
  }

  // 1b. success commands (each must exit 0; a failure is worker-fixable -> RETRY, like a check failure)
  let successGreen = true;
  for (const cmd of input.successCommands ?? []) {
    if (!cmd || cmd.trim() === "") {
      continue;
    }
    const sc = await deps.runSuccessCommand(cmd);
    if (sc.exitCode !== 0) {
      successGreen = false;
      reasons.push(`success_command FAILED (exit ${sc.exitCode}): ${cmd}`);
    }
  }

  // 1c. optional agent-ci local CI replay (spec 2026-07-08). null = feature off.
  // A red workflow is worker-fixable -> RETRY (folds in below, exactly like a
  // failed success_command). An INFRA failure THROWS out of runGate here (Docker
  // down / binary unresolvable / timeout) -- intentionally NOT caught: the
  // conductor's try/catch around runGate escalates it as a broken-operator-config
  // problem, the same path a throwing loadInvariants takes.
  let agentCiGreen = true;
  if (deps.runAgentCi !== null) {
    const ci = await deps.runAgentCi(input.taskId);
    agentCiGreen = ci.green;
    if (!ci.green) {
      reasons.push(...ci.reasons);
    }
  }

  // 2. constitution (always human). Union of the INVARIANTS constitution globs and
  // `deps.constitutionPaths` (the previously-dead `contract.constitutionPaths` config
  // field -- adr/006 Phase 1, Finding 2). Both sources are trusted-root reads as of
  // Phase 1; they stay distinct because one is per-repo contract text and the other is
  // gate config. Filtering `changedFiles` (not concatenating two glob-filtered
  // lists) is what keeps a file matching BOTH lists appearing exactly ONCE.
  const constitutionGlobs = [...inv.constitution.path_globs, ...(deps.constitutionPaths ?? [])];
  const constitutionTouched = changedFiles.filter((f) => constitutionGlobs.some((g) => globMatch(g, f)));
  if (constitutionTouched.length > 0) {
    reasons.push(`constitution path(s) changed: ${constitutionTouched.join(", ")}`);
  }

  // 3. per-zone coverage (per-VALUE first, zone-level fallback)
  const zonesTouched: ZoneResult[] = [];
  for (const zone of inv.contract_zones) {
    if (!zoneTouched(zone, changedFiles, diffLines)) {
      continue;
    }

    const zr: ZoneResult = {
      id: zone.id,
      auto_guardable: zone.auto_guardable,
      guarded: false,
      guard_test: null,
      mutation_passed: false,
      blessed: false,
      touched_strings: [],
      uncovered_strings: [],
    };

    if (!zone.auto_guardable) {
      reasons.push(`zone '${zone.id}' touched but is NOT auto_guardable (human-only: ${zone.why})`);
      zonesTouched.push(zr);
      continue;
    }

    const touchedStrings = zoneTouchedStrings(zone, diffLines);
    zr.touched_strings = touchedStrings;

    if (touchedStrings.length > 0) {
      const guardsUsed: GuardRow[] = [];
      let allCovered = true;
      for (const s of touchedStrings) {
        const g = selectGuardForValue(guardPairs, s);
        if (g === null) {
          allCovered = false;
          zr.uncovered_strings.push(s);
          reasons.push(
            `zone '${zone.id}': contract value '${s}' touched but NO mutation-verified guard covers THAT value (needs guard)`,
          );
        } else {
          guardsUsed.push(g);
        }
      }

      if (!allCovered) {
        // guarded stays false -> ESCALATE
        zonesTouched.push(zr);
        continue;
      }

      zr.guarded = true;
      zr.guard_test = guardsUsed.map((g) => g.guard_test).join(", ");

      let blessedAll = true;
      let mutAll = true;
      for (const g of guardsUsed) {
        // run BOTH for every guard (collect all reasons, no short-circuit)
        if (!isBlessed(g)) {
          blessedAll = false;
          reasons.push(`zone '${zone.id}': guard '${g.contract_id}' mutation-proven but not yet blessed by operator`);
        }
        if (!(await deps.guardStillRed(g))) {
          mutAll = false;
          reasons.push(`zone '${zone.id}': guard '${g.contract_id}' did NOT go red on mutation (guard not protecting)`);
        }
      }
      zr.blessed = blessedAll;
      zr.mutation_passed = mutAll;
      zonesTouched.push(zr);
      continue;
    }

    // fallback: touched via path/grep with no enumerated value
    const cover = selectGuardForZone(guardPairs, zone.id);
    if (cover === null) {
      reasons.push(
        `zone '${zone.id}' touched (path/grep, no enumerated value) but no mutation-verified guard covers it (needs guard)`,
      );
      zonesTouched.push(zr);
      continue;
    }
    zr.guarded = true;
    zr.guard_test = cover.guard_test;
    zr.blessed = isBlessed(cover);
    zr.mutation_passed = await deps.guardStillRed(cover);
    if (!zr.mutation_passed) {
      reasons.push(`guard for zone '${zone.id}' did NOT go red on mutation (guard not protecting)`);
    } else if (!zr.blessed) {
      reasons.push(`zone '${zone.id}' guarded + mutation-proven but guard not yet blessed by operator`);
    }
    zonesTouched.push(zr);
  }

  // 4. decision — RETRY overrides everything, then constitution, then any bad zone, else COMMIT
  let decision: Decision = "COMMIT";
  if (!composerGreen || !successGreen || !agentCiGreen) {
    decision = "RETRY";
  } else if (constitutionTouched.length > 0) {
    decision = "ESCALATE";
  } else {
    for (const z of zonesTouched) {
      if (!z.auto_guardable || !z.guarded || !z.mutation_passed || !z.blessed) {
        decision = "ESCALATE";
        break;
      }
    }
  }

  const verdict: GateVerdict = {
    task_id: input.taskId,
    composer_green: composerGreen,
    success_green: successGreen,
    agent_ci_green: agentCiGreen,
    constitution_touched: constitutionTouched,
    zones_touched: zonesTouched,
    decision,
    reasons,
    changed_files: changedFiles,
  };

  if (deps.writeVerdict) {
    await deps.writeVerdict(input.taskId, verdict);
  }

  return verdict;
}
