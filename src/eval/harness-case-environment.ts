import { resolve } from "node:path";

import type { CorpusCase } from "./corpus-case.js";
import type { CaseEnvironment } from "./case-executor.js";
import { applySeedOverlay } from "./seed-overlay.js";
import { resetHarnessState } from "./harness-state-reset.js";
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
  /** The commit-ish every case resets the target repo to before it runs. */
  baseline: string;
  /** Bound on the per-case drain, so a pathological case cannot spin forever. */
  maxIterations: number;
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
  const repoRoot = root.repoRoot;
  const corpusRoot = resolve(opts.corpusRoot);
  const log = root.log;

  async function git(args: string[], label: string): Promise<string> {
    const r = await runNative("git", args, { cwd: repoRoot });
    if (r.exitCode !== 0) {
      throw new Error(`corpus: git ${label} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  return {
    log,

    async resetToBaseline(): Promise<void> {
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

      await git(["reset", "--hard", baseline], `reset --hard ${baseline}`);
      const purged = await resetHarnessState(root.stateDirAbs);
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

    async readEvidence(taskIds: string[]): Promise<EvidenceSlot[]> {
      return loadEvidence(taskIds, (taskId) => root.repo.readRuntimeFile(taskId, EVIDENCE_FILE));
    },
  };
}
