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

/** Does this (folded, prefix-stripped) path already carry its own root, so that
 *  anchoring it at anything else would be a fabrication?
 *
 *  Two shapes qualify, and the second one is the subtle half:
 *   - anything starting with `/` -- a POSIX absolute path, and also the UNC
 *     form `//server/share/...` once folded.
 *   - anything starting with a drive letter and a colon. Note this deliberately
 *     does NOT require a following slash. `D:/x` is drive-ABSOLUTE, but `D:x`
 *     is drive-RELATIVE: Windows resolves it against that drive's own current
 *     directory, which this process does not know and must not guess. Joining
 *     `D:x` onto an anchor would invent a path the tool never named, so both
 *     drive shapes are refused here and fall through to the ordinary
 *     containment check (which fails, leaving the finding `unattributed` --
 *     fail-closed). `docs/gotchas/oracle-protected-paths-must-be-worktree-
 *     relative.md` round 5 is exactly this shape, found in a sibling module.
 */
function isRootedPath(folded: string): boolean {
  return folded.startsWith("/") || /^[A-Za-z]:/.test(folded);
}

/** Join a relative (folded) path onto a folded anchor, collapsing `.` and `..`
 *  LEXICALLY -- no filesystem access, for the same cross-platform reason this
 *  module refuses node's `path` module: the report and the anchor may have been
 *  produced on a different OS than the one running this code.
 *
 *  Returns `null` when a `..` would consume the anchor entirely. That is a
 *  refusal, not a clamp: a path that climbs past its own root is one this
 *  function cannot place, and the caller's answer to "cannot place" is already
 *  `unattributed` (Principle 10). Clamping instead -- silently treating `../..`
 *  as the root -- would manufacture a containment that the input never
 *  supported. */
function resolveAgainstAnchor(anchorFolded: string, relativeFolded: string): string | null {
  const segs = anchorFolded.split("/");
  for (const seg of relativeFolded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length <= 1) return null;
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return segs.join("/");
}

/** The directory a relative report path is anchored at, derived from the path
 *  of the ruleset the tool was run with, or `null` when there is no ruleset (or
 *  it names no directory).
 *
 *  Why the RULESET's directory and not the worktree, the repo root, or the
 *  process cwd: measured, not assumed (s64, #155). PHPCS resolves a ruleset's
 *  relative `basepath` against the directory of the RULESET FILE, and `adr/010`
 *  reads a project-declared ruleset from the TRUSTED ROOT -- so the operator's
 *  own `phpcs.xml.dist` (`<arg name="basepath" value="."/>`) makes every report
 *  path relative to the repo root, while the gate runs with the worktree as
 *  cwd. The two disagree by exactly the `.autodev/worktrees/<task>/` prefix.
 *  Both shapes were captured side by side on one file: the profile's own
 *  ruleset (no basepath) emits an absolute path, the project's emits
 *  `.autodev\worktrees\s64-probe\...`.
 *
 *  Deliberately ONE anchor. The worktree itself is NOT also tried: a relative
 *  path resolves under the worktree trivially, so admitting it as a second
 *  anchor would make the measured case AMBIGUOUS (two contained candidates) and
 *  send the finding straight back to `unattributed`, fixing nothing. No tool
 *  has been observed emitting a cwd-relative Checkstyle path; if one ever is,
 *  add it then, pinned on its own capture -- the same discipline
 *  `checkstyle.ts` applied to its fixture, and the same one this module's
 *  original doc comment prescribed for precisely this situation. */
function relativePathAnchor(rulesetPath: string | null): string | null {
  // An empty string is not "the current directory" here, it is "nobody told me":
  // `loadProfile` seeds `rulesetPath` with `""` for a gate that declares no
  // ruleset. Letting it through would anchor every relative report path at the
  // filesystem root -- the same shape as
  // `docs/gotchas/empty-path-resolves-to-repo-root.md`, where adding a resolve
  // step turned a harmless absent path into a confident wrong one.
  if (rulesetPath === null || rulesetPath.trim() === "") return null;
  const folded = stripExtendedLengthPrefix(foldSeparators(rulesetPath));
  const lastSlash = folded.lastIndexOf("/");
  if (lastSlash === -1) return null;
  return folded.slice(0, lastSlash);
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
 * case-sensitively otherwise.
 *
 * #155: a path that is NOT already rooted (`isRootedPath`) is first anchored at
 * `relativePathAnchor(rulesetPath)` and only then put through that same check --
 * one entry point, one normal form, both sides folded (folding only one of two
 * probe paths is round 6 of `docs/gotchas/oracle-protected-paths-must-be-
 * worktree-relative.md`). This is the case the original version of this comment
 * anticipated and deferred: *"if a tool is ever found to emit a relative path,
 * add that case explicitly, pinned on a captured example"*. One was --
 * `adr/010` let a project declare its own ruleset, the operator's declares
 * `basepath="."`, and every finding from it arrived relative to the trusted
 * root. The capture is `__fixtures__/phpcs-checkstyle-project-basepath.xml`,
 * taken from his real theme.
 *
 * Note the direction of the change: before it, a relative path was ALWAYS
 * `null` here. So this branch can only ever turn an `unattributed` finding into
 * an attributed, line-scoped one -- it cannot make an attributed finding
 * disappear, which is the one direction that would be fail-open.
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
function normalizeFindingPath(
  rawFile: string,
  worktreePath: string,
  rulesetPath: string | null,
): { rel: string; caseInsensitive: boolean } | null {
  const raw = stripExtendedLengthPrefix(foldSeparators(rawFile));
  let file = raw;
  if (!isRootedPath(raw)) {
    const anchor = relativePathAnchor(rulesetPath);
    if (anchor === null) return null;
    const anchored = resolveAgainstAnchor(anchor, raw);
    if (anchored === null) return null;
    file = anchored;
  }
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
 * `rulesetPath` is the absolute path of the ruleset the tool was run with, when
 * the gate declared one. It exists solely to anchor a RELATIVE report path
 * (#155 -- see `relativePathAnchor`). It defaults to `null`, which reproduces
 * the behaviour that predates it: every relative path is unattributed. That is
 * the fail-closed direction, so a caller that cannot say which ruleset was in
 * force loses line-scoping rather than mis-attributing a finding.
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
  rulesetPath: string | null = null,
): FilteredFinding[] {
  const kept: FilteredFinding[] = [];

  for (const f of findings) {
    const norm = normalizeFindingPath(f.file, worktreePath, rulesetPath);

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
    // R6-FIX1: resolve against the union of BOTH key spaces. Searching only
    // `addedLines` meant a file present ONLY in `newFiles` -- a binary addition
    // or a new empty file, neither of which has a hunk and so neither of which
    // appears in `addedLines` at all -- fell through to the raw `norm.rel`
    // fallback, which carries the REPORT's casing. The subsequent
    // `newFiles.has(...)` is an exact-case Set lookup, so `ASSET.BIN` missed the
    // key `asset.bin` and the file-level finding for a file the worker had just
    // created was dropped. The same "folded one string, looked up another" shape
    // as R2-FIX3, one key space over.
    const candidateKeys = norm.caseInsensitive
      ? (() => {
          const keys = new Set<string>([...addedLines.keys(), ...newFiles]);
          const matches = findAllCaseInsensitiveKeys(norm.rel, keys);
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

    // Rule 6, checked BEFORE the "no added lines" bail below (R5-FIX1). A file
    // can be genuinely NEW and still have no entry in `addedLines`: a binary
    // addition has no hunk at all, and neither does a new but EMPTY file. Both
    // land in `newFiles` (from `new file mode` / `--- /dev/null`) with no added
    // lines to their name. Bailing on `!added` first therefore discarded the
    // file-level finding for a file the worker had just created -- e.g. a new
    // zero-byte .php file drawing "missing file doc comment". Ordering is the
    // entire bug: both branches were individually correct.
    if (f.line === null) {
      if (newFiles.has(normalizedPath)) {
        kept.push({ ...f, file: normalizedPath, unattributed: false });
      }
      continue;
    }

    if (!added) {
      // Rule 4: a known file, just not one the diff touched. Drop, silently --
      // this is ordinary out-of-scope pre-existing debt, not a failure of any
      // kind.
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
