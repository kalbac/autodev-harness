/**
 * Decides which parsed Checkstyle findings the WORKER is actually responsible
 * for. This is the third and last piece of the diff-scoping pipeline
 * (`docs/superpowers/plans/2026-07-22-line-scoped-profile-gates.md`, Task 3):
 * `diff-lines.ts` says which new-file line numbers a diff added, `checkstyle.ts`
 * decodes what the tool found, and this module joins the two into a verdict-
 * ready finding list. See `docs/superpowers/specs/2026-07-22-line-scoped-profile-
 * gates-design.md`, "Fail-closed rules" -- every branch below is Principle 10
 * ("when unsure, fail toward the safe state").
 *
 * THE NORMAL FORM (stated once, here, and enforced at exactly one entry point,
 * `normalizeFindingPath` below): a finding's path is matched against the diff's
 * added-line map only after being converted to a path that is WORKTREE-RELATIVE
 * and `/`-SEPARATED. `docs/gotchas/oracle-protected-paths-must-be-worktree-
 * relative.md` needed five independent review rounds to learn this the hard
 * way in a sibling module (a path resolved at one root and enforced at another
 * needs an explicit, written-down normal form, not a per-symptom patch) --
 * that lesson is applied directly here rather than re-learned.
 *
 * Deliberately NOT using node's `path` module for this normalization. `path`'s
 * behaviour (what counts as absolute, what separator `relative()` emits) is the
 * HOST platform's, but a Checkstyle report and the worktree path it was captured
 * against can legitimately have been produced on a DIFFERENT OS than the one
 * running this code (a config/report authored on Windows, processed by a Linux
 * daemon, or vice versa -- this is a cross-platform product). Folding `\` to `/`
 * and doing a plain string-prefix check works identically regardless of which
 * host actually executes it, which is exactly the property a cross-platform
 * normal form needs.
 */
import type { CheckstyleFinding } from "./checkstyle.js";

/** A finding that survived filtering, plus whether it could be attributed to a
 *  specific changed file. Every field from the parsed finding is carried
 *  through unchanged EXCEPT `file`, which is replaced by the normalized
 *  worktree-relative form when attribution succeeded (that is what a renderer
 *  downstream should show the worker -- an absolute temp-directory path is
 *  noise). When attribution FAILED (`unattributed: true`), `file` is left as
 *  the tool's raw, un-normalized string verbatim: that raw string is the only
 *  diagnostic the operator has for why the finding could not be placed, and
 *  normalizing it would erase the evidence. */
export interface FilteredFinding extends CheckstyleFinding {
  unattributed: boolean;
}

/** Fold `\` to `/` so a path captured on Windows and a path captured on POSIX
 *  compare equal once both sides go through this. Mirrors `oracle-paths.ts`'s
 *  `foldSeparators` (not imported -- that helper is private to its module, and
 *  this module owns its own single entry point for the same reason it states
 *  its own normal form rather than importing someone else's). */
function foldSeparators(p: string): string {
  return p.split("\\").join("/");
}

/** Strip a Windows extended-length prefix (`\\?\`, folded to `//?/`) so a
 *  path in that form normalizes identically to its ordinary equivalent
 *  (R2-FIX4). Windows itself, PowerShell, and various tools emit this form
 *  for paths near or over MAX_PATH -- `\\?\C:\repo\src\x.php` folds to
 *  `//?/C:/repo/src/x.php`, which does not start with `C:/repo/` by ANY
 *  string comparison, so without this the finding is flagged unattributed
 *  and a legitimate merge is blocked. Unlike the other findings in this
 *  round, that failure is in the SAFE direction (over-flagging, not
 *  silently dropping) -- but a false block is still a broken gate.
 *  The UNC variant, `\\?\UNC\server\share\...` (folded `//?/UNC/server/
 *  share/...`), maps back to an ordinary UNC path `\\server\share\...`
 *  (folded `//server/share/...`) -- one fewer path segment than the plain
 *  extended-length case, hence the separate branch.
 *
 *  R3-FIX4: `//?/` is stripped ONLY when what follows is actually
 *  Windows-shaped -- a drive letter (`//?/C:/...`) or the UNC form
 *  (`//?/UNC/server/share/...`). `?` is a perfectly legal POSIX filename
 *  character, so a bare `//?/repo/src.php` is an ORDINARY path (a
 *  directory literally named `?`), not an extended-length escape.
 *  Stripping it unconditionally (the old behaviour) turned it into
 *  `repo/src.php` -- a string that can then coincidentally collide with
 *  and be wrongly matched against an unrelated worktree, or fail a prefix
 *  check it should have passed, either way silently misnormalizing a path
 *  that was never in Windows extended-length form to begin with. */
function stripExtendedLengthPrefix(folded: string): string {
  const uncMatch = /^\/\/\?\/UNC\/(.*)$/i.exec(folded);
  if (uncMatch) return "//" + (uncMatch[1] ?? "");
  const driveMatch = /^\/\/\?\/([A-Za-z]:\/.*)$/.exec(folded);
  if (driveMatch) return driveMatch[1] ?? "";
  return folded;
}

/** Case-insensitively find EVERY key in `keys` that names the same path as
 *  `target` (both already folded/stripped to the same normal form). Used
 *  ONLY when the containment check that produced `target` was itself
 *  case-insensitive (R2-FIX3) -- see the long comment on
 *  `normalizeFindingPath` for why a case-insensitive prefix check followed
 *  by an exact-case lookup is the exact "validated one string, used
 *  another" shape that keeps recurring in this module.
 *
 *  Returns ALL matching keys, not just the first, because a repo created on a
 *  case-sensitive filesystem can legitimately hold both `src/Foo.php` and
 *  `SRC/foo.php` as two DISTINCT files that fold to the same lowercase string.
 *
 *  What the caller does with more than one match changed twice, and the history
 *  is the point. R3 had it pick the first key, which silently dropped a finding
 *  that landed only in the other. R3's fix UNIONED their line sets, which cured
 *  that and introduced the opposite error: a finding was kept because the OTHER
 *  file added that line number, attributing it to a file it may not belong to.
 *  R4 settled it: two matches means the report path is AMBIGUOUS, and neither
 *  picking nor uniting can answer a question the input does not contain. The
 *  caller now flags such a finding `unattributed` -- kept, so nothing is lost,
 *  and pinned to no file, so nothing is falsely attributed. This function's job
 *  is therefore to report the ambiguity faithfully, not to resolve it. */
function findAllCaseInsensitiveKeys(target: string, keys: Iterable<string>): string[] {
  const targetLower = target.toLowerCase();
  const matches: string[] = [];
  for (const k of keys) {
    if (k.toLowerCase() === targetLower) matches.push(k);
  }
  return matches;
}

/** Is a (separator-folded) path Windows-shaped -- a drive letter (`C:/...`) or
 *  a UNC share (`//server/share/...`, folded from `\\server\share\...`)? Only
 *  these two shapes get a case-INsensitive comparison (FIX8): Windows'
 *  filesystem is case-insensitive-but-preserving, so `c:\repo\x.php` and
 *  `C:\Repo\X.php` can legitimately name the same file, and a case-sensitive
 *  prefix check would wrongly flag a perfectly good path as unattributed. A
 *  bare POSIX path (`/repo/...`) never gets this treatment -- POSIX
 *  filesystems are genuinely case-sensitive, and `a.php`/`A.php` are different
 *  files there; folding case unconditionally would make them collide. */
function isWindowsShapedPath(folded: string): boolean {
  return /^[A-Za-z]:\//.test(folded) || folded.startsWith("//");
}

/**
 * Normalize one finding's raw path to a worktree-relative, `/`-separated form,
 * or return `null` when it cannot be attributed to anything under
 * `worktreePath` at all (rule 5: KEEP and flag, never drop -- handled by the
 * caller, not here; this function only answers the normalization question).
 *
 * The primary check is a folded-string prefix match: `file` must start with
 * `worktreePath + "/"` once both are folded to forward slashes -- case-
 * insensitively when either side is Windows-shaped (FIX8, `isWindowsShapedPath`),
 * case-sensitively otherwise. No attempt is made to also recognize a path that
 * looks ALREADY worktree-relative (bare, no drive letter, no leading slash) as
 * a pass-through -- `checkstyle.ts`'s own doc comment records that these tools
 * emit an ABSOLUTE path, and guessing at a second acceptable shape here would
 * widen what counts as "attributed" beyond what has actually been observed
 * from a real tool, in the one component whose job is deciding what may merge.
 * If a tool is ever found to emit a relative path, add that case explicitly,
 * pinned on a captured example -- the same discipline `checkstyle.ts` used for
 * its own fixture.
 *
 * FIX7: passing the prefix check is not sufficient proof of containment. A
 * finding path like `C:\repo\..\outside.php` (worktree `C:\repo`) folds to
 * `C:/repo/../outside.php`, which literally starts with the `C:/repo/`
 * prefix -- but slicing that prefix off yields `../outside.php`, a path that
 * ESCAPES the worktree entirely rather than naming anything inside it. Once
 * the worktree-relative remainder is computed, it is checked for a `..`
 * segment; if one is present, the path is not genuinely contained and this
 * returns `null` so the caller treats it exactly like any other
 * un-attributable path (KEPT, flagged `unattributed: true` -- never silently
 * dropped, per the same fail-closed reasoning as rule 5 and
 * `docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md`).
 *
 * R2-FIX3: the returned `rel` is sliced out of the finding's ORIGINAL case
 * (never lowercased), because on a case-SENSITIVE (POSIX) path an exact-case
 * `rel` is exactly what a `addedLines`/`newFiles` lookup needs. But when
 * `caseInsensitive` is true, `rel`'s case is whatever the REPORT happened to
 * use -- which is not necessarily the diff's own case for that path (a
 * report can say `SRC/FOO.PHP` while the diff key is `src/Foo.php`). The
 * caller MUST NOT do a bare `Map.get(rel)` in that case: it has to resolve
 * `rel` against the diff's actual keys using the SAME case-insensitive rule
 * that just decided this path was contained at all (`findCaseInsensitiveKey`
 * below) -- that is what `caseInsensitive` is returned for.
 */
function normalizeFindingPath(rawFile: string, worktreePath: string): { rel: string; caseInsensitive: boolean } | null {
  const file = stripExtendedLengthPrefix(foldSeparators(rawFile));
  let root = stripExtendedLengthPrefix(foldSeparators(worktreePath));
  if (root.endsWith("/")) root = root.slice(0, -1);
  const prefix = root + "/";

  const caseInsensitive = isWindowsShapedPath(root) || isWindowsShapedPath(file);
  const matches = caseInsensitive ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix);
  if (!matches) return null;

  const rel = file.slice(prefix.length);
  if (rel.split("/").includes("..")) return null;
  return { rel, caseInsensitive };
}

/**
 * Filter parsed Checkstyle findings down to the ones the worker is responsible
 * for, given the diff's added-line map and new-files set (`diff-lines.ts`'s
 * `addedLineNumbers` output -- `AddedLines.added` and `AddedLines.newFiles`)
 * and the worktree root the tool ran against.
 *
 * Four outcomes per finding, in the order checked (see the design doc's
 * "Fail-closed rules" for the reasoning behind each):
 *
 *   1. Path does not normalize to anything under `worktreePath` -> KEPT,
 *      `unattributed: true`. Fail-closed (rule 5): dropping an un-attributable
 *      finding would be fail-OPEN -- a real violation on the worker's own
 *      lines silently ignored, in the one component whose entire job is
 *      deciding whether a change may merge. Keeping it is a loud, visible
 *      failure the operator can act on instead. FIX7: this also covers a path
 *      that passes the string-prefix test but normalizes to something
 *      containing a `..` segment (an escape out of the worktree) --
 *      `normalizeFindingPath` returns `null` for that case too, so it is
 *      treated identically: kept and flagged, never dropped.
 *   2. Path normalizes but names a file the diff never touched at all -> the
 *      normalized path is not a key in `addedLines` -> DROPPED (rule 4): this
 *      is debt outside the scope of the current change entirely, distinct
 *      from #1 because we DO know exactly which file it is -- there is
 *      nothing ambiguous to flag.
 *   3. Path normalizes to a touched file, and the finding has a real line
 *      number -> KEPT only when that line is in the file's added-line set
 *      (rule 2), DROPPED otherwise (rule 3: pre-existing debt in a file the
 *      worker happened to also touch elsewhere).
 *   4. Path normalizes to a touched file, and the finding is file-level
 *      (`line === null`, e.g. "missing file doc comment") -> KEPT only when
 *      the file is in `newFiles` (rule 6, FIX9 -- the diff's own `--- /dev/null`
 *      signal, not a heuristic reconstructed from the added-line set's shape),
 *      DROPPED otherwise -- a file-level finding on an existing file is by
 *      definition pre-existing.
 */
export function filterFindings(
  findings: CheckstyleFinding[],
  addedLines: Map<string, Set<number>>,
  worktreePath: string,
  newFiles: Set<string>,
): FilteredFinding[] {
  const kept: FilteredFinding[] = [];

  for (const f of findings) {
    const norm = normalizeFindingPath(f.file, worktreePath);

    if (norm === null) {
      // Rule 5. Keep the RAW `f.file` (not a normalized form -- there isn't
      // one) so the operator can see exactly what the tool printed.
      kept.push({ ...f, unattributed: true });
      continue;
    }

    // R2-FIX3: the SAME fold that decided this path is contained under
    // `worktreePath` must also govern the lookup against `addedLines`/
    // `newFiles` -- a case-insensitive containment check followed by an
    // exact-case `Map.get` is exactly the "validated one string, used
    // another" bug this module's own doc comment warns about. When the
    // containment check was case-sensitive (POSIX), `norm.rel` IS the key
    // to use as-is. When it was case-insensitive (Windows-shaped), resolve
    // `norm.rel` against ALL of the diff's actual keys that fold to it
    // case-insensitively (R3-FIX3, plural -- not just the first): a
    // case-sensitive filesystem can legitimately hold two distinct touched
    // files, e.g. `src/Foo.php` and `SRC/foo.php`, that both fold to the
    // same lowercase string, and a Windows-shaped report path cannot say
    // which one it means. Falling back to `[norm.rel]` when no key matches
    // keeps the existing "not a file the diff touched" behaviour (rule 4)
    // rather than inventing a match.
    const candidateKeys = norm.caseInsensitive
      ? (() => {
          const matches = findAllCaseInsensitiveKeys(norm.rel, addedLines.keys());
          return matches.length > 0 ? matches : [norm.rel];
        })()
      : [norm.rel];
    // R4-FIX5: more than one diff key folding to this report path means the
    // path is genuinely AMBIGUOUS -- the report cannot say which of two
    // distinct files (`src/Foo.php` vs `SRC/foo.php`) it meant. R3 resolved
    // that by UNIONING their line sets, which fixed under-attribution and
    // created the opposite error: a finding at line 10 was kept because the
    // OTHER file added line 10, attributing it to a file it may not belong to.
    //
    // Neither "pick one" nor "union" is right, because both answer a question
    // the input cannot answer. Ambiguity is its own outcome: keep the finding
    // (nothing is lost) and flag it `unattributed` (nothing is falsely pinned
    // to a specific file), so the operator sees the ambiguity instead of a
    // confident wrong answer. Fail-closed, like every other unresolvable path
    // here.
    if (candidateKeys.length > 1) {
      kept.push({ ...f, unattributed: true });
      continue;
    }
    const normalizedPath = candidateKeys[0]!;

    // Exactly one candidate key survives to here (an ambiguous match returned
    // above), so there is nothing to union -- the key either names a file the
    // diff touched or it does not.
    const added = addedLines.get(normalizedPath);
    if (!added) {
      // Rule 4: a known file, just not one the diff touched. Drop, silently --
      // this is ordinary out-of-scope pre-existing debt, not a failure of any
      // kind.
      continue;
    }

    if (f.line === null) {
      // Rule 6.
      if (newFiles.has(normalizedPath)) {
        kept.push({ ...f, file: normalizedPath, unattributed: false });
      }
      continue;
    }

    if (added.has(f.line)) {
      // Rule 2.
      kept.push({ ...f, file: normalizedPath, unattributed: false });
    }
    // else: Rule 3, dropped.
  }

  return kept;
}
