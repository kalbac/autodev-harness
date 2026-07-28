import { mkdir, realpath } from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";

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
 * Both git questions are asked about a REPO-RELATIVE, forward-slash pathspec, never the
 * resolved absolute path (issue #135 / docs/gotchas/git-check-ignore-windows-drive-colon.md,
 * found the first time this ran on a real Windows box). Git pathspecs treat a leading `:` as
 * magic (`:(literal)`, `:/`, `:!`), and a Windows absolute path carries a colon in position
 * 2 — so `git check-ignore D:\...` dies `fatal: pathspec magic not supported by this
 * command: 'literal'` (exit 128), UNCONDITIONALLY, for every absolute path on that
 * platform. `--literal-pathspecs` does not help (it turns off magic parsing, but the colon
 * itself is what the parser trips on before that flag is even consulted). The check being
 * fail-closed then made it fail-CLOSED-FOREVER: it correctly refused an answer it could
 * never actually get, which made the default artifacts directory unreachable on Windows.
 * The fix is legitimate, not a workaround: both questions are asked about a path INSIDE
 * the repo (this branch is only reached after containment is established above), so a
 * repo-relative path is both correct and colon-free. See `toRepoRelativePathspec` below.
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

/**
 * Turn two CANONICAL (post-`realpath`) absolute paths into the repo-relative,
 * forward-slash pathspec git expects — see the module doc comment (check 3) for why a
 * Windows absolute path can never be handed to git directly.
 *
 * `relativeFn` defaults to the host's own `path.relative`, which is correct at every
 * production call site: `canonicalRoot`/`canonicalCandidate` were themselves produced by
 * THIS host's `realpath`, so they are already in this host's own path style. It is a seam
 * only so a unit test can exercise `path.win32.relative`'s output shape on ANY host, not
 * only a real Windows machine — the exact gap that let the original bug ship: every
 * fixture in this suite was POSIX-shaped because CI runs on Linux, so the tests exercised
 * a string form the real Windows caller never produces
 * (docs/gotchas/git-check-ignore-windows-drive-colon.md).
 *
 * An empty result — `canonicalCandidate` IS `canonicalRoot` (the artifacts root is the
 * repo root itself) — is mapped to `"."` EXPLICITLY. An empty string handed to a git
 * pathspec is not a form this code is willing to guess the meaning of; `"."` is git's own
 * unambiguous spelling of "the current directory," which is exactly what is meant here.
 */
export function toRepoRelativePathspec(
  canonicalRoot: string,
  canonicalCandidate: string,
  relativeFn: (from: string, to: string) => string = relative,
  separator: string = sep,
): string {
  // Fold ONLY this host's own separator, and only when it is a backslash. An
  // unconditional `\` -> `/` is wrong on POSIX, where a backslash is an ordinary
  // filename byte: a directory genuinely named `artifacts\raw` would be handed to git
  // as `artifacts/raw`, a DIFFERENT path -- so the safety question would be answered
  // about something other than the directory about to be written to. That is the
  // check-one-string/use-another shape this repo keeps paying for
  // (docs/gotchas/validated-one-string-used-another.md), and the same POSIX-backslash
  // instance already cost a round in
  // docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md. Found by the
  // review gate, s61 -- the test could not have caught it, because it exercised only
  // the win32 shape.
  //
  // `separator` travels WITH `relativeFn` for exactly the same reason that seam exists:
  // a test driving `path.win32.relative` on a POSIX host must also get win32's `\`, or
  // the two halves would describe different platforms.
  const rel = relativeFn(canonicalRoot, canonicalCandidate);
  const normalized = separator === "\\" ? rel.split("\\").join("/") : rel;
  return normalized === "" ? "." : normalized;
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

  // `--literal-pathspecs` on BOTH invocations. A path is data here, never a pattern: without
  // it, a directory literally named `art[bc]` (or one whose name starts with `:`) is a
  // pathspec with glob/magic semantics, and a pattern that fails to match its own directory
  // answers "nothing tracked" for a directory full of tracked files — a fail-OPEN. codex R6
  // raised this from the git docs; on this git version the scenario did NOT reproduce (a
  // bracket pathspec still matched the literal directory), so the flag is defensive rather
  // than a fixed bug. It is applied anyway because it costs nothing and closes the whole
  // class, including future git versions and pathspec-magic prefixes.
  //
  // Both git checks are asked about a pathspec DERIVED FROM the CANONICAL path, never the
  // path as written. Resolving for the containment decision and then handing git the
  // unresolved one is the validated-one-string-used-another shape (codex R5), and it had a
  // concrete exploit: with `artifactsRoot = <repo>/link` a junction onto `<repo>/real`,
  // `check-ignore link` answers "ignored" while `ls-files -- link` answers "nothing tracked"
  // — because the index holds `real/...`, not `link/...`. Both answers are true about
  // `link` and both are irrelevant to where the writes actually land, so the run was
  // authorized to clear tracked files through the junction. `toRepoRelativePathspec` takes
  // the CANONICAL path as its input for the same reason, so this guarantee carries through
  // the Windows-drive-colon fix rather than being undone by it (`[git/check-ignore-windows-drive-colon]`).
  const pathspec = toRepoRelativePathspec(canonicalRepo, canonicalArtifacts);

  const ignored = await check.git(["--literal-pathspecs", "check-ignore", "--quiet", "--", pathspec]);
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
  // Exit codes are DISCRIMINATED, not split into "0 vs everything else", and the mapping was
  // MEASURED against real git rather than assumed (codex R4 cost a round on an assumed one):
  //   0 -> matched, and stdout ALWAYS carries the matching index paths
  //   1 -> `--error-unmatch` matched nothing: nothing tracked here, the answer we want
  //   128 -> fatal (not a repository, corrupt index, ...)
  // Anything else, including the CONTRADICTORY `0` with an empty listing, is refused. Real
  // git does not produce that combination (measured: an untracked or absent directory exits
  // 1, never 0-with-nothing), so if it ever appears the tool is not behaving as understood —
  // and "I do not understand this answer" is a refusal, not a pass. An earlier version
  // ALLOWED it, which is the fourth appearance of fold-cannot-determine-into-no in this
  // cycle (codex R5).
  const tracked = await check.git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", pathspec]);
  if (tracked.exitCode === 1) return; // nothing tracked here
  if (tracked.exitCode === 0) {
    const names = tracked.stdout.trim() === "" ? [] : tracked.stdout.trim().split(/\r?\n/);
    if (names.length === 0) {
      throw refuse(
        artifactsRoot,
        repoRoot,
        "git ls-files exited 0 (matched) but listed nothing -- a self-contradictory answer this code does not " +
          "know how to read. Refusing rather than guessing which half to believe",
      );
    }
    throw refuse(
      artifactsRoot,
      repoRoot,
      `it already contains ${names.length} TRACKED file(s) (${names.slice(0, 5).join(", ")}` +
        `${names.length > 5 ? ", ..." : ""}), which git reports as modified even inside an ignored directory`,
    );
  }
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
