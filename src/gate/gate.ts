import { globMatch } from "../util/glob.js";
import { diffAddedRemovedLines, zoneTouched, zoneTouchedStrings } from "./invariants.js";
import type { Invariants } from "./invariants.js";
import { isBlessed, selectGuardForValue, selectGuardForZone } from "./guards.js";
import type { GuardRow, GuardRecipePair } from "./guards.js";
import { formatGateFeedback } from "./gate-feedback.js";
import type { FailedStep } from "./gate-feedback.js";
import { addedLineNumbers } from "./diff-lines.js";
import type { FilteredFinding } from "./finding-filter.js";

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
  profile_green: boolean; // true when no profile is attached
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
  /** The whole-tree build/test command (composer check / npm test). null = skip.
   *  `output` (stdout+stderr, combined) is OPTIONAL so every existing caller and
   *  test keeps compiling unchanged; when present it feeds `gate-feedback.md` on
   *  a failing run (see `writeGateFeedback` below). */
  runCheck: (() => Promise<{ green: boolean; exitCode: number; output?: string }>) | null;
  /** Run one task success_command; exit 0 = pass. `output` optional, same reason as `runCheck`. */
  runSuccessCommand: (cmd: string) => Promise<{ exitCode: number; output?: string }>;
  /** Live mutation-check for a guard: true iff it still goes red-on-flip. Parity: Test-AutodevGuardStillRed. */
  guardStillRed: (guard: GuardRow) => Promise<boolean>;
  /** Optional agent-ci replay. null = feature off. May THROW: a genuine infra failure or an
   *  AgentCiUnavailableError (Windows-without-WSL) propagates OUT of runGate on purpose --
   *  do NOT wrap in try/catch here; the conductor escalates a gate throw. */
  runAgentCi: ((taskId: string) => Promise<{ green: boolean; reasons: string[] }>) | null;
  /** Optional qualification-profile gates (`profile:` in config). null = no profile attached.
   *  A RED gate is worker-fixable -> RETRY. A gate that could not RUN (missing tool, absent
   *  vendor, spawn ENOENT) must THROW out of runGate exactly like runAgentCi's infra failure --
   *  do NOT catch it here; the conductor escalates a gate throw as broken operator config.
   *  Receives this task's CHANGED FILES so a profile gate can judge the diff rather than the
   *  whole tree. That scoping is load-bearing, not an optimization: measured on the real
   *  polygon, the same WPCS ruleset reports 7069 pre-existing errors tree-wide and 8 on the
   *  file a task actually touched, so a whole-tree profile gate would be red on every run
   *  regardless of the diff -- blocking everything while proving nothing about the change
   *  under judgement. A gate that declares no file glob is whole-project by design (e.g.
   *  `composer validate`) and ignores this argument.
   *
   *  Also receives the diff's ADDED-line map (line-scoped profile gates,
   *  `docs/superpowers/plans/2026-07-22-line-scoped-profile-gates.md`, Task 4), keyed by
   *  worktree-relative path -- computed ONCE here in `runGate` from `resolveScope`'s
   *  `diffText` via `addedLineNumbers` (`diff-lines.ts`), rather than have the composition
   *  root re-derive the diff with a second `git` call. A gate that declares `report:
   *  checkstyle` uses this map to filter its tool's findings down to only the lines this
   *  diff added; a gate without `report` ignores it, exactly like a whole-project gate
   *  ignores `changedFiles`.
   *
   *  A per-gate result MAY carry `findings`: the SURVIVING (already diff-filtered)
   *  findings for a `report` gate, or `undefined` for an ordinary gate (no report format,
   *  or a green run with nothing to show). When present, `green` was decided from the
   *  FILTERED FINDING COUNT, not from `exitCode` -- a report gate can legitimately have
   *  `green: true` alongside a non-zero `exitCode` (every finding sat outside the diff);
   *  that combination is not a bug, it is the entire point of Task 4. `output`, when
   *  present, is the raw tool output (kept for a non-report gate, and as a fallback for a
   *  report gate whose `findings` are for some reason absent) -- `runGate` prefers
   *  `findings` for the feedback document precisely because it excludes the debt outside
   *  the diff that `output` (the tool's raw, whole-file report) does not. */
  runProfileGates:
    | ((
        changedFiles: string[],
        addedLines: Map<string, Set<number>>,
      ) => Promise<
        { id: string; green: boolean; exitCode: number; output?: string; findings?: FilteredFinding[] }[]
      >)
    | null;
  /** Config-level (trusted-root, worker-inaccessible) human-only path globs (adr/006
   *  Phase 1, closing Finding 2 -- `contract.constitutionPaths` was previously dead
   *  config). Unioned with `inv.constitution.path_globs` for the constitution check.
   *  Optional so the existing gate unit tests keep compiling unchanged. */
  constitutionPaths?: string[];
  /** Optional: persist gate-verdict.json. Omit in unit tests. */
  writeVerdict?: (taskId: string, verdict: GateVerdict) => Promise<void>;
  /** Optional: persist (or CLEAR) the gate-failure document the next round's worker reads.
   *  Called exactly ONCE per gate run, at the decisive exit, with the content when this run
   *  had failures and `null` when it did not. Writing once with a nullable payload -- rather
   *  than appending per failing step -- is what makes the artifact always describe the most
   *  recent gate run, so it can never go stale
   *  (docs/gotchas/per-round-overwrite-artifact-stale.md). Omit in unit tests. */
  writeGateFeedback?: (taskId: string, content: string | null) => Promise<void>;
}

/**
 * Render a `report` gate's SURVIVING findings (already diff-filtered by
 * `deps.runProfileGates` before `runGate` ever sees them) as the plain-text block
 * `failedSteps` carries into `gate-feedback.md`.
 *
 * Deliberately MINIMAL: this exists only so a report gate's RETRY feedback names
 * the finding it is actually about, right now, without Task 4 reaching into
 * `gate-feedback.ts` -- a file it does not own. `gate-feedback.ts` (Task 5 of
 * `docs/superpowers/plans/2026-07-22-line-scoped-profile-gates.md`) owns the RICH
 * rendering: unattributed findings grouped and clearly labelled, the existing
 * per-step/label/total clamps applied to this text the same as any other step's
 * output, fence selection, etc. Until then, one finding per line is enough to
 * prove the filtering is real and to unblock the worker.
 */
function renderReportFindings(findings: FilteredFinding[]): string {
  if (findings.length === 0) return "";
  return findings
    .map((f) => {
      const loc = f.line === null ? f.file : `${f.file}:${f.line}`;
      const flag = f.unattributed ? " [UNATTRIBUTED -- could not be matched to a changed file]" : "";
      return `${loc}  ${f.message}  [${f.source}]${flag}`;
    })
    .join("\n");
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
 *
 * `writeGateFeedback` (write-or-clear of gate-feedback.md) runs exactly once
 * per real gate run via a `finally` around everything after the fast-path, so
 * a throw from ANY of the above still updates it with whatever steps failed
 * before the abort, instead of leaving a stale document from a previous round.
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
      profile_green: true,
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

  // Tool output from every FAILED step this run, in the order the steps executed.
  // Feeds `writeGateFeedback` in the `finally` below. Declared OUTSIDE the
  // try/catch/finally (not inside it) so that a throw from deep inside a
  // loader/guard/agent-ci/profile-gate still leaves whatever steps failed
  // BEFORE the abort visible to the feedback write. Deliberately narrower
  // than `reasons`: constitution/zone findings are NOT tool output (there is
  // no subprocess report to show) and are already fully expressed in
  // `reasons`, so they are never added here -- adding them would duplicate
  // content the worker already gets and dilute the actual linter/test output
  // with restated verdict text.
  const failedSteps: FailedStep[] = [];
  // Set in the `catch` below so `finally` can tell a throwing run from a
  // normal one -- the two need OPPOSITE handling if the feedback write
  // itself then also fails (see the comment in `finally`).
  let gateRunThrew = false;

  try {
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
        failedSteps.push({ label: "check command", exitCode: cc.exitCode, output: cc.output ?? "" });
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
        failedSteps.push({ label: `success_command: ${cmd}`, exitCode: sc.exitCode, output: sc.output ?? "" });
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
        // Without this push, a red agent-ci that is the ONLY failing component left
        // `failedSteps` empty -> `formatGateFeedback([])` returns null -> the
        // write-or-clear DELETES any existing gate-feedback.md, handing the worker a
        // RETRY with no explanation at all. agent-ci has no subprocess exit code
        // (it returns `{ green, reasons }`, not a spawned process's exit status), so
        // `exitCode` is `null` -- rendered honestly by `formatGateFeedback`, not
        // faked as a real-looking number.
        failedSteps.push({ label: "agent-ci", exitCode: null, output: ci.reasons.join("\n") });
      }
    }

    // 1d. optional qualification-profile gates (spec 2026-07-22). null = no profile
    // attached. A red gate folds into the verdict exactly like a failed check
    // command (worker-fixable -> RETRY, via `reasons` + the decision expression
    // below). A gate that could not RUN AT ALL (missing tool, absent vendor, spawn
    // ENOENT) is NOT worker-fixable -- `deps.runProfileGates` REJECTS in that case
    // and this THROWS through, uncaught, exactly like 1c's runAgentCi: the
    // conductor's try/catch around runGate is what escalates it as broken operator
    // config. Looping a worker against a broken environment is the exact failure
    // mode this contract exists to prevent.
    let profileGreen = true;
    if (deps.runProfileGates !== null) {
      // Computed from `diffText` (already resolved above), not re-derived with a
      // second `git` call -- see the `runProfileGates` doc comment. Cheap and pure,
      // so it is fine to compute unconditionally even when every gate happens to
      // declare no `report`; a report-less gate simply never reads it.
      const addedLines = addedLineNumbers(diffText);
      const results = await deps.runProfileGates(changedFiles, addedLines);
      for (const r of results) {
        if (!r.green) {
          profileGreen = false;
          reasons.push(`profile gate '${r.id}' FAILED (exit ${r.exitCode})`);
          // A `report` gate's `findings` ARE the feedback: they are already the
          // diff-filtered subset the worker is responsible for, and showing them
          // instead of the tool's raw whole-file `output` is what keeps a legacy
          // file's pre-existing debt out of the document -- the entire point of
          // line-scoped profile gates. `findings` is checked for `undefined`
          // (not truthiness / non-empty), because a report gate is only ever
          // pushed here with `green: false`, which -- per the composition root's
          // contract -- means `findings` is a NON-empty array whenever it is
          // present at all; an ordinary gate (no `report`) simply never sets it,
          // and falls back to raw `output`, byte-identical to pre-Task-4 behaviour.
          const output = r.findings !== undefined ? renderReportFindings(r.findings) : (r.output ?? "");
          failedSteps.push({ label: `profile gate '${r.id}'`, exitCode: r.exitCode, output });
        }
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
    if (!composerGreen || !successGreen || !agentCiGreen || !profileGreen) {
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
      profile_green: profileGreen,
      constitution_touched: constitutionTouched,
      zones_touched: zonesTouched,
      decision,
      reasons,
      changed_files: changedFiles,
    };

    if (deps.writeVerdict) {
      await deps.writeVerdict(input.taskId, verdict);
    }

    // `writeGateFeedback` is NOT called here -- it runs exactly once, in
    // `finally` below, so both this normal exit AND every throwing exit go
    // through the same write-or-clear call site (see the comment there).
    return verdict;
  } catch (err) {
    gateRunThrew = true;
    throw err;
  } finally {
    // Write-or-clear on EVERY path that actually ran gate steps -- including
    // throwing ones. Before this fix, the write-or-clear call sat only at the
    // normal decisive exit below, so a throw (a loader, resolveScope,
    // guardStillRed, an agent-ci/profile-gate infra failure, writeVerdict
    // itself) left the PREVIOUS round's gate-feedback.md untouched -- and the
    // conductor reads it unconditionally on the next claim, presenting an OLD
    // run's failure as feedback for a run that never completed. That is
    // exactly the staleness write-or-clear exists to prevent
    // (docs/gotchas/per-round-overwrite-artifact-stale.md); this closes the
    // one path it didn't cover. On a throw, `failedSteps` holds whatever
    // failed BEFORE the abort -- writing that is honest and useful (the
    // worker sees the real failures that did occur); writing nothing would be
    // silently misleading, and leaving the previous document is the bug.
    if (deps.writeGateFeedback) {
      try {
        await deps.writeGateFeedback(input.taskId, formatGateFeedback(failedSteps));
      } catch (feedbackErr) {
        if (!gateRunThrew) {
          // NORMAL path (no prior throw): a persistence failure here SHOULD
          // reject runGate -- a failed clear that still returned COMMIT would
          // be more dangerous than surfacing the write failure.
          throw feedbackErr;
        }
        // ALREADY THROWING path: never let a feedback-persistence failure MASK
        // the real error -- the original throw above must be what the caller
        // sees. Swallow this one; it is a distraction next to the real cause.
      }
    }
  }
}
