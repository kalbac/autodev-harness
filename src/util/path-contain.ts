/**
 * Shared realpath-containment primitive (`adr/006` Phase 1, round-2 fix). Two call
 * sites need the SAME "is this path really inside that root" answer:
 *   - `src/composition/root.ts`'s `resolveContainedOracleFile` (oracle-DEFINITION reads)
 *   - `src/registry/scaffold.ts`'s `healOneContractStub` (the stub-migration WRITE path)
 *
 * It lives in `util/`, not `composition/` (where the first version of this logic was
 * born), because a `registry/` module importing from `composition/` would be the wrong
 * dependency direction -- `registry/` is lower-level, wired glue like `composition/`
 * consumes it, not the reverse. `util/` has no dependents of its own, so either module
 * importing it is safe either way.
 *
 * See `docs/gotchas/static-file-serving-symlink-traversal.md` for why a lexical
 * `startsWith` prefix check on UN-resolved paths is not enough: an intermediate
 * symlinked ancestor directory lexically "looks" contained while its REAL location is
 * outside the root. Only resolving (`realpath`) both sides before comparing closes
 * that hole.
 */
import { realpath } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Strip ALL trailing separators off `p`, not just one (round-3 fix 3). A single
 * `endsWith(sep) ? slice(0, -sep.length) : p` (the round-2 version) only removes ONE
 * separator, so a canonical root that happens to end in TWO (`C:\repo\\`) still left
 * a doubled-separator prefix (`C:\repo\\` + `\` when building the child prefix) that
 * no legitimate child could match -- the same spurious-reject bug the round-2 fix
 * targeted, just one separator further out. Codex rates a real `realpath` ever
 * emitting a double-trailing-separator as unlikely, but this helper is EXPORTED and
 * PURE, so it must implement its stated normalization fully rather than only the one
 * case a specific caller happens to hit today.
 *
 * GUARD: a root that is NOTHING BUT separators (`"///"`, `"\\\\\\"`) strips down to
 * `""`. An empty root string would make the prefix check below `candidate.startsWith(
 * "" + sep)` -- true for every absolute candidate, since every absolute path starts
 * with `sep` -- a fail-OPEN wildcard that "contains" anything, exactly the direction
 * this whole module exists to prevent. So an all-separator input is treated as "no
 * valid root" and `canonicalPathContains` returns `false` unconditionally for it,
 * never as an empty string that would swallow everything.
 */
function stripTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === sep) end--;
  return p.slice(0, end);
}

/**
 * Pure string-containment check between two ALREADY-CANONICAL (post-`realpath`)
 * paths. Split out from `realpathContains` below so the Windows drive-root / UNC
 * share-root trailing-separator edge case is unit-testable WITHOUT an actual drive
 * root: `realpath` returns a canonical drive root (`C:\`) or UNC share root (`\\
 * host\share\`) WITH its trailing separator intact -- unlike every other real
 * directory, which `realpath` always returns WITHOUT one. Building the prefix as
 * `canonicalRoot + sep` unconditionally then produces a doubled separator
 * (`C:\\`) that no legitimate child path can ever match, rejecting every real
 * child of a drive root as "escaped" (fail-closed direction -- a spurious hard
 * failure, not a bypass, but still a bug). Fix (round-2): strip trailing separator(s)
 * off the root before building the prefix (round-3 fix 3: strip ALL of them, not
 * just one -- see `stripTrailingSeparators` above), so a root that already ends in
 * `sep` (once or more) behaves identically to one that doesn't.
 *
 * CASE SENSITIVITY (round-3 fix 2): folds case ONLY when `platform === "win32"`.
 * Windows filesystems are case-insensitive/case-preserving, and the two `realpath`
 * results being compared here can legitimately differ only in case (a drive letter,
 * or an ancestor directory segment) -- comparing byte-wise rejected a LEGITIMATE
 * child as "escaped" on the harness's own primary platform (a spurious hard failure,
 * the same fail-closed-but-wrong direction as the trailing-separator bug above, not
 * a bypass). On POSIX, two paths differing only in case are genuinely DIFFERENT
 * files -- folding case there would be a real security weakening (a candidate that
 * escapes `root` via a differently-cased lookalike would wrongly read as
 * "contained"), so POSIX stays case-sensitive. `platform` defaults to the real
 * `process.platform`; production call sites never pass it -- the parameter exists so
 * the win32/POSIX branches are independently unit-testable on either CI runner
 * (`path-contain.test.ts`) without gating a test to only run on one OS.
 */
export function canonicalPathContains(
  canonicalRoot: string,
  canonicalCandidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const strippedRoot = stripTrailingSeparators(canonicalRoot);
  if (strippedRoot === "") return false; // all-separator root -- never contains anything (fail-closed, not fail-open)

  const foldCase = platform === "win32";
  const root = foldCase ? strippedRoot.toLowerCase() : strippedRoot;
  const candidate = foldCase ? canonicalCandidate.toLowerCase() : canonicalCandidate;
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve BOTH `root` and `candidate` to their canonical (symlink-free) form via
 * `fs.promises.realpath`, then verify `candidate` is `root` itself or a descendant
 * of it (`canonicalPathContains` above). Returns `false` -- never throws -- when
 * either side fails to resolve (does not exist, permission denied, a dangling
 * symlink, etc.): an unresolvable candidate is never "contained" by definition,
 * and a caller that needs to distinguish "doesn't exist" from "exists but escapes"
 * should `lstat`/`existsSync` BEFORE calling this (both call sites do).
 */
export async function realpathContains(root: string, candidate: string): Promise<boolean> {
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = await realpath(root);
    canonicalCandidate = await realpath(candidate);
  } catch {
    return false;
  }
  return canonicalPathContains(canonicalRoot, canonicalCandidate);
}
