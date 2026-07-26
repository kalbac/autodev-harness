import { resolve } from "node:path";

import type { CorpusCase } from "./corpus-case.js";
import type { CaseEnvironment } from "./case-executor.js";
import { applySeedOverlay } from "./seed-overlay.js";
import { archiveAndReport, archiveCaseArtifacts, conductorLogOffset, type CaseArchiveStatus } from "./case-archive.js";

// The status type belongs with the archive, not with this glue module; re-exported here so
// the pre-existing import path keeps working.
export type { CaseArchiveStatus } from "./case-archive.js";
import { resetHarnessState } from "./harness-state-reset.js";
import { createOneShotQueueGuard } from "./eval-preflight.js";
import { assertArtifactsRootSafe } from "./artifacts-root.js";
import { acquireCorpusLock, type CorpusLock } from "./corpus-lock.js";
import type { ProjectRoot } from "../composition/root.js";
import { loadEvidence, EVIDENCE_FILE, type EvidenceSlot } from "../report/evidence-store.js";
import { mainTreeStatus } from "../util/git.js";
import { runNative } from "../util/native.js";
import { realpathContains } from "../util/path-contain.js";

/**
 * The REAL `CaseEnvironment` — the thin adapter between the corpus's deterministic
 * orchestration and the live harness (git, the blackboard, the LLM decompose, the
 * headless conductor). Integration glue by design, exactly like `src/index.ts` and
 * `src/composition/root.ts`: it constructs nothing of its own and every piece of real
 * logic it needs (`applySeedOverlay`, `resetHarnessState`, `loadEvidence`,
 * `createCaseExecutor`) is unit-tested on its own against fakes.
 *
 * It is deliberately CONSERVATIVE about the target repo. A corpus case needs a
 * deterministic starting tree, which means resetting the repo — so this module refuses
 * to touch a repo that carries uncommitted work at all, rather than choosing which of
 * the operator's edits to discard. That refusal is the whole safety story here
 * (docs/gotchas/reset-hard-discards-others-uncommitted.md): with a verified-clean tree
 * there is nothing a `reset --hard` can destroy.
 */
export interface HarnessCaseEnvironmentOptions {
  /** The already-built project root for the TARGET repo the corpus runs against. */
  root: ProjectRoot;
  /** Absolute path of the corpus directory; `case.seed` resolves under it. */
  corpusRoot: string;
  /** The commit every case resets the target repo to before it runs. The caller must
   *  pass an IMMUTABLE sha, not a symbolic ref: cases commit, so a `HEAD`/branch ref
   *  would be re-resolved per case and drift onto the previous case's result. */
  baseline: string;
  /** Bound on the per-case drain, so a pathological case cannot spin forever. */
  maxIterations: number;
  /** Absolute directory each case's blackboard artifacts are copied into before the next
   *  case purges them. Diagnostics only — nothing here feeds a metric. */
  artifactsRoot: string;

}

/** Baked identity so a seed commit never fails on a machine with no global git user
 *  (mirrors `git.ts`'s `commitEmpty`). The corpus's own commits are harness bookkeeping,
 *  not the operator's authorship. */
const SEED_COMMIT_IDENTITY = [
  "-c",
  "user.name=Autodev Harness",
  "-c",
  "user.email=autodev@harness.local",
];

export function createHarnessCaseEnvironment(opts: HarnessCaseEnvironmentOptions): CaseEnvironment {
  const { root, baseline, maxIterations } = opts;

  // Archive outcomes are recorded into a map this module OWNS and only exposes for reading.
  // Neither a callback nor a caller-supplied Map: both put foreign code in the recording
  // path, where a throwing sink (or a Map subclass with an overridden `set`) leaves a
  // SUCCESSFUL archive unrecorded -- which the manifest then reports as `archive: null`,
  // i.e. "this case never archived", for a case that did (codex R3, narrowed again in R4).
  // An internal `Map` has no such path; the caller reads it when it builds the manifest.
  const archiveStatuses = new Map<string, CaseArchiveStatus>();
  const repoRoot = root.repoRoot;
  const corpusRoot = resolve(opts.corpusRoot);
  const artifactsRoot = resolve(opts.artifactsRoot);
  const log = root.log;

  // Ownership of the target project, established once and in this order:
  //  1. take the EXCLUSIVE lock, so no second corpus run can be between its own check and
  //     its own purge (codex R4 High — a point-in-time check cannot settle that alone);
  //  2. only then ask whether the queue is idle, which is now a question about the
  //     operator's work rather than a race with another run.
  // The guard belongs HERE, on the destructive path itself, not at whichever caller
  // happens to remember it (codex R2 High), and is retired only once a purge has really
  // happened (codex R3 High).
  const queueGuard = createOneShotQueueGuard(root.repo);
  let lock: CorpusLock | null = null;
  // Where `conductor.log` had reached when the current case started, so the archive keeps
  // only that case's slice of a log that grows across the whole run. Captured inside
  // `resetToBaseline` — the one call every case makes, before anything of its own runs.
  let logOffset = 0;

  // The artifacts-root safety question lives in its own module so the CLI can ask it
  // BEFORE it touches any file and this path can ask it again per case -- one answer, two
  // callers, no memoization (a root safe for case 1 can be a junction by case 5).
  const assertArtifactsRootIsSafe = (): Promise<void> =>
    assertArtifactsRootSafe({
      repoRoot,
      artifactsRoot,
      git: async (args) => {
        const r = await runNative("git", args, { cwd: repoRoot });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
    });

  async function git(args: string[], label: string): Promise<string> {
    const r = await runNative("git", args, { cwd: repoRoot });
    if (r.exitCode !== 0) {
      throw new Error(`corpus: git ${label} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  return {
    log,

    now: () => Date.now(),

    async dispose(): Promise<void> {
      const held = lock;
      lock = null;
      if (held !== null) await held.release();
    },

    async resetToBaseline(): Promise<void> {
      if (lock === null) lock = await acquireCorpusLock(root.stateDirAbs);
      await queueGuard.check();
      // Before the FIRST mutation, not after case 1 has already written into the tree.
      await assertArtifactsRootIsSafe();

      // The conductor refuses to run off the loop branch, so a corpus started on the
      // wrong branch would reset the tree and then fail every case for a reason that
      // has nothing to do with the harness under test. Check FIRST, mutate after.
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], "rev-parse HEAD")).trim();
      if (branch === "main" || !new RegExp(root.cfg.allowedBranchPattern).test(branch)) {
        throw new Error(
          `corpus: target repo ${repoRoot} is on branch '${branch}', which the conductor refuses to run on ` +
            `(must match ${root.cfg.allowedBranchPattern}, never main)`,
        );
      }

      // Fail-closed on ANY uncommitted work rather than deciding what may be discarded.
      // RESIDUAL, named rather than papered over (codex R1): the check and the reset are
      // two git invocations, so an edit landing between them is still lost. Nothing short
      // of holding the repo exclusively closes that, and `eval` is an operator-invoked,
      // operator-watched command over a repo they were told the corpus owns. The window
      // this DOES close is the one that actually bit s54 — starting a destructive sync on
      // a tree that was already carrying someone's work
      // (docs/gotchas/reset-hard-discards-others-uncommitted.md). Work under the
      // git-excluded `.autodev` is invisible here by construction and is guarded
      // separately, once, by `assertTargetQueueIsIdle` before the first case.
      const dirty = await mainTreeStatus(repoRoot);
      if (dirty.length > 0) {
        const listed = dirty
          .slice(0, 10)
          .map((e) => `${e.code} ${e.path}`)
          .join(", ");
        throw new Error(
          `corpus: refusing to run -- the target repo ${repoRoot} has ${dirty.length} uncommitted entr(ies) ` +
            `[${listed}${dirty.length > 10 ? ", ..." : ""}]. Each case resets the tree to '${baseline}', which ` +
            `would DISCARD them. Commit or stash first.`,
        );
      }

      // Read BEFORE the purge, and before the case writes anything: the purge leaves
      // `conductor.log` in place, so this offset is exactly where this case's log begins.
      logOffset = await conductorLogOffset(root.stateDirAbs);

      await git(["reset", "--hard", baseline], `reset --hard ${baseline}`);
      const purged = await resetHarnessState(root.stateDirAbs);
      // Only NOW is the queue the corpus's rather than the operator's — retiring the
      // guard any earlier would leave a failed first attempt unguarded on retry.
      queueGuard.satisfied();
      log("INFO", `corpus: reset ${repoRoot} to ${baseline}; purged blackboard [${purged.join(", ") || "nothing"}]`);
    },

    async applySeed(c: CorpusCase): Promise<void> {
      const seedDir = resolve(corpusRoot, c.seed);
      // Containment over REALPATHS, not a lexical prefix: an intermediate symlinked
      // ancestor lexically "looks" inside the corpus while resolving elsewhere
      // (docs/gotchas/static-file-serving-symlink-traversal.md).
      if (!(await realpathContains(corpusRoot, seedDir))) {
        throw new Error(`corpus case '${c.id}': seed '${c.seed}' does not resolve inside the corpus root ${corpusRoot}`);
      }

      const written = await applySeedOverlay(seedDir, repoRoot);
      if (written.length === 0) {
        log("INFO", `corpus case '${c.id}': seed '${c.seed}' is empty -- running against the pristine baseline`);
        return;
      }

      await git(["add", "--", ...written], "add (seed)");
      // A seed identical to the baseline stages nothing; committing then fails with
      // "nothing to commit", which is not an error for the corpus -- the premise is
      // simply already in place.
      const staged = await runNative("git", ["diff", "--cached", "--quiet"], { cwd: repoRoot });
      if (staged.exitCode === 0) {
        log("INFO", `corpus case '${c.id}': seed '${c.seed}' matches the baseline -- nothing to commit`);
        return;
      }
      await git([...SEED_COMMIT_IDENTITY, "commit", "-m", `corpus seed: ${c.id}`], "commit (seed)");
      log("INFO", `corpus case '${c.id}': seeded ${written.length} file(s) from '${c.seed}'`);
    },

    async compose(intent: string): Promise<string[]> {
      const result = await root.orchestrator.handleIntent(intent);
      return result.enqueued.map((e) => e.id);
    },

    async drain(): Promise<void> {
      // `drain` + a finite `maxIterations`, never `once` -- `once` short-circuits the
      // loop BEFORE `drain` is evaluated, so a case would get exactly one iteration
      // (docs/gotchas/conductor-once-precedes-drain-and-bounded-defaults.md).
      await root.conductor.run({ drain: true, maxIterations });
    },

    async archiveArtifacts(c: CorpusCase): Promise<void> {
      // Catches its OWN failure and REPORTS it, rather than throwing and letting the
      // executor's swallow decide. That matters for honesty, not tidiness: if the archive
      // fails after a previous run's directory could not be cleared, the stale directory
      // is still on disk, and a manifest that unconditionally names `artifacts: <caseId>`
      // would have the operator read the PREVIOUS run's diagnostics as this run's — the
      // stale-projection failure of docs/gotchas/stale-projection-needs-ssot-reconciliation.md
      // (codex R1). Reporting the status is what lets the manifest say `failed` instead.
      // The executor's `.catch()` remains as a backstop for a throwing implementation.
      // The decide-then-report ordering, and the guard around the sink, live in
      // `archiveAndReport` — extracted there because they are the fix for a defect the
      // critic found twice, and a fix that lives only in this untested glue module is a fix
      // nobody can prove (codex R1, then a narrower R2). This layer only supplies the
      // request and the sink.
      await archiveAndReport(
        {
          stateDirAbs: root.stateDirAbs,
          artifactsRoot,
          caseId: c.id,
          logFromByte: logOffset,
        },
        {
          archive: archiveCaseArtifacts,
          log,
          report: (status) => archiveStatuses.set(c.id, status),
        },
      );
    },

    archiveStatuses: () => new Map(archiveStatuses),

    async readEvidence(taskIds: string[]): Promise<EvidenceSlot[]> {
      return loadEvidence(taskIds, (taskId) => root.repo.readRuntimeFile(taskId, EVIDENCE_FILE));
    },
  };
}
