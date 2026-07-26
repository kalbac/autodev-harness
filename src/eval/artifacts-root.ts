import { mkdir, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";

import { canonicalPathContains } from "../util/path-contain.js";

/**
 * Decide whether a corpus run's artifacts directory can be written to WITHOUT dirtying the
 * target repo — the one way the diagnostics could stop being diagnostics.
 *
 * `resetToBaseline` fails closed on ANY uncommitted entry, so archive files that show up in
 * `git status` make every case after the first an errored case: a measurement broken by the
 * machinery that exists only to explain it. This module answers that question and nothing
 * else, and it lives apart from the environment so BOTH callers can use the same answer —
 * the CLI needs it BEFORE it touches any file, and `resetToBaseline` needs it again per case
 * (a root that was safe for case 1 can be swapped for a junction before case 5).
 *
 * Three checks, in the order that makes each one meaningful:
 *
 *  1. `mkdir -p`, THEN resolve. `realpath` cannot answer for a path that does not exist, so
 *     asking first would fold "cannot determine" into "not inside the repo". Creating it is
 *     harmless even when the verdict is a refusal — git does not report empty directories.
 *  2. Resolve BOTH sides explicitly and refuse if either resolution FAILS. This is the trap
 *     the first version fell into: `realpathContains` returns `false` for "outside the root"
 *     AND for "could not resolve", and treating that single `false` as "outside the repo, so
 *     safe" is the fold-could-not-determine-into-no fail-open this codebase keeps closing
 *     (codex R3). Resolving also settles junctions: a reparse-point root is followed to its
 *     real location before any question is asked.
 *  3. Ask GIT, twice, because "inside the repo" is not one question:
 *     - `check-ignore`: will files created here be ignored? (An earlier version instead
 *       ASSUMED anything under `.autodev` was ignored, without verifying it — codex R2.)
 *     - `ls-files`: is anything here already TRACKED? A tracked file inside an ignored
 *       directory is still reported by `git status`, so "the directory is ignored" alone does
 *       not mean writing here is invisible (codex R3).
 *
 * ACCEPTED RESIDUALS, named rather than papered over:
 *  - TOCTOU between this check and the writes it authorizes. Closing it needs an
 *    `openat2`-style fd-relative API Node does not expose — the same residual already
 *    accepted in docs/gotchas/static-file-serving-symlink-traversal.md and
 *    `harness-state-reset.ts`. Re-checking per case narrows the window to one case, which is
 *    why the caller does not memoize.
 *  - A gitignore pattern that ignores a directory's CONTENTS but not the directory itself
 *    (`artifacts/*`) makes `check-ignore` answer "not ignored" and this refuse a setup that
 *    would in fact have been safe. A false refusal is the safe direction; reimplementing
 *    gitignore pattern semantics to avoid it would be a much larger risk than the annoyance.
 */
export interface ArtifactsRootCheck {
  repoRoot: string;
  artifactsRoot: string;
  /** Runs a git command in `repoRoot` and returns its exit code + stderr. Injected so this
   *  module is testable without a real repository. */
  git: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Resolve a path, returning `null` when it cannot be resolved. The caller MUST treat
 *  `null` as a refusal, never as an answer. */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * Throws with an actionable message when the artifacts root is unsafe; returns normally when
 * it is safe to write there. Creates the directory as a side effect (see check 1 above).
 */
export async function assertArtifactsRootSafe(check: ArtifactsRootCheck): Promise<void> {
  const artifactsRoot = resolve(check.artifactsRoot);
  const repoRoot = resolve(check.repoRoot);

  await mkdir(artifactsRoot, { recursive: true });

  const canonicalArtifacts = await realpathOrNull(artifactsRoot);
  const canonicalRepo = await realpathOrNull(repoRoot);
  if (canonicalArtifacts === null || canonicalRepo === null) {
    const which = canonicalArtifacts === null ? `artifacts directory ${artifactsRoot}` : `repo root ${repoRoot}`;
    throw new Error(
      `corpus: refusing to run -- cannot resolve the ${which} to a real path, so whether the artifacts would ` +
        `dirty the target repo is UNKNOWN. An unanswerable safety question is a refusal, not a pass.`,
    );
  }

  // Outside the repo entirely: nothing written here can appear in `git status`.
  //
  // `canonicalPathContains` cannot be trusted for this decision on its own, because its
  // failure DIRECTION was chosen for a different caller's polarity: it answers `false` for
  // an all-separator root ("never contains anything") as a deliberate fail-CLOSED for the
  // oracle-containment call sites, where refusing is the safe answer. Here the polarity is
  // inverted — `false` means "outside the repo, go ahead and write" — so for a repo whose
  // root IS the filesystem root (`/`, `C:\`), that same `false` becomes a fail-OPEN and
  // skips every git check (codex R4). A filesystem root contains everything by definition,
  // so it is settled here rather than by the shared predicate.
  const repoIsFilesystemRoot = parse(canonicalRepo).root === canonicalRepo;
  if (!repoIsFilesystemRoot && !canonicalPathContains(canonicalRepo, canonicalArtifacts)) return;

  const ignored = await check.git(["check-ignore", "--quiet", "--", artifactsRoot]);
  if (ignored.exitCode !== 0) {
    const why =
      ignored.exitCode === 1
        ? "git reports it is NOT ignored"
        : `git check-ignore could not answer (exit ${ignored.exitCode}: ${ignored.stderr.trim() || "no detail"})`;
    throw refuse(artifactsRoot, repoRoot, why);
  }

  // Ignored, but a TRACKED file here would still be reported by `git status` when we write
  // over it -- being inside an ignored directory does not untrack anything.
  //
  // Exit codes are DISCRIMINATED, not split into "0 vs everything else". MEASURED against
  // real git: 0 = matched (paths on stdout), 1 = `--error-unmatch` found nothing tracked
  // (the normal, safe answer), 128 = fatal (not a repository, corrupt index, ...). Folding
  // 128 into "nothing tracked" would let a broken repository authorize writing inside the
  // work tree — the same fold-cannot-determine-into-no fail-open as above, and the THIRD
  // instance of that shape in this review cycle (codex R4).
  const tracked = await check.git(["ls-files", "--error-unmatch", "--", artifactsRoot]);
  if (tracked.exitCode === 0) {
    const names = tracked.stdout.trim() === "" ? [] : tracked.stdout.trim().split(/\r?\n/);
    if (names.length > 0) {
      throw refuse(
        artifactsRoot,
        repoRoot,
        `it already contains ${names.length} TRACKED file(s) (${names.slice(0, 5).join(", ")}` +
          `${names.length > 5 ? ", ..." : ""}), which git reports as modified even inside an ignored directory`,
      );
    }
    return;
  }
  if (tracked.exitCode === 1) return; // nothing tracked here -- the answer we wanted
  throw refuse(
    artifactsRoot,
    repoRoot,
    `git ls-files could not answer whether anything here is already tracked (exit ${tracked.exitCode}: ` +
      `${tracked.stderr.trim() || "no detail"}). An unanswerable safety question is a refusal, not a pass`,
  );
}

function refuse(artifactsRoot: string, repoRoot: string, why: string): Error {
  return new Error(
    `corpus: refusing to run -- the artifacts directory ${artifactsRoot} resolves INSIDE the target repo ` +
      `${repoRoot} and ${why}. Its files would dirty the tree, and every case after the first resets on a ` +
      `dirty tree and errors -- the diagnostics would change the measurement. Pass --artifacts a path outside ` +
      `the repo, or git-exclude it.`,
  );
}
