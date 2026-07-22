/**
 * Maps a unified diff to the set of line numbers, IN THE NEW FILE, that the diff
 * ADDED. This is the foundation of line-scoped profile gates (`docs/superpowers/
 * plans/2026-07-22-line-scoped-profile-gates.md`): a linter run on a legacy
 * codebase blames the worker for the whole FILE it touched, which on a codebase
 * with pre-existing violations means every task is red before the worker writes
 * a line. Filtering a tool's findings down to only the lines a diff actually added
 * requires answering exactly one question — "which new-file line numbers did this
 * diff add?" — and this module answers ONLY that question. It does not know about
 * checkstyle, severities, or verdicts; those live in `gate/checkstyle.ts` and
 * `gate/finding-filter.ts`, built on top of this.
 *
 * A hand-rolled unified-diff walker is notorious for three silent-corruption
 * traps, each commented at its guard below because getting any one of them wrong
 * produces output that still LOOKS plausible:
 *
 *   1. The `+++ b/<path>` / `--- a/<path>` FILE HEADERS also start with `+`/`-`.
 *      Treating `+++ b/x.php` as an added content line would poison line 1 of
 *      every file in the diff with a bogus header string — the classic off-by-one
 *      every hand-rolled parser hits.
 *   2. The new-file line cursor advances on CONTEXT lines (` `) and on ADDED lines
 *      (`+`), but NOT on REMOVED lines (`-`) — a removed line never existed in the
 *      new file, so it must not consume a new-file line number. Get this backwards
 *      and every line number after the first hunk with a deletion is silently
 *      shifted — silently, because the output is still a plausible-looking set of
 *      numbers.
 *   3. A brand-new file is `--- /dev/null` with a single `@@ -0,0 +1,N @@` hunk;
 *      every one of its lines is an addition.
 *
 * Windows note: diffs captured on this platform can arrive with CRLF line endings.
 * Every line has its trailing `\r` stripped before any of the above logic runs —
 * skip that and a diff parses differently depending on which OS produced it.
 */

/** Matches a hunk header and captures the NEW-file starting line number (the
 *  first number after the `+`). The old-file half (`-10,6`) is irrelevant here:
 *  this module only ever numbers lines in the NEW file. The count after the comma
 *  is optional in a unified diff (a single-line hunk omits it), so it is not
 *  captured at all — the cursor is derived by walking the hunk body, not by
 *  trusting the header's line count. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Walks a unified diff (possibly covering several files and several hunks per
 * file) and returns, per worktree-relative `/`-separated path, the set of
 * new-file line numbers the diff added.
 *
 * A file that the diff touches but adds nothing to (a deletion-only hunk, or a
 * hunk that only reorders/removes lines) is simply absent from the returned map
 * rather than present with an empty set — callers that need "was this file even
 * touched" should consult the diff/touched-files list directly, not this map.
 */
export function addedLineNumbers(diffText: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  // Strip a trailing `\r` from every line UP FRONT, before any header/hunk/body
  // logic runs, so a CRLF-captured diff (routine on Windows) behaves identically
  // to an LF one. Splitting on `\n` alone would otherwise leave a `\r` glued to
  // the end of every path and every hunk-header number, breaking both the file
  // header match and the `+`/`-`/` ` prefix checks below (a line body of `\r`-only
  // content is indistinguishable from empty without this).
  const lines = diffText.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

  let currentPath: string | null = null;
  let cursor = 0; // next NEW-file line number; only meaningful once a hunk header set it

  for (const line of lines) {
    // `+++ b/<path>` — the NEW-file header. Must be checked BEFORE the generic
    // `+`-prefix "added line" check below, because it also starts with `+` (trap
    // #1 in the module doc). A deleted file's new side is `+++ /dev/null`; such a
    // file contributes nothing, so `currentPath` is set to null rather than a
    // path, and any hunk that follows (there shouldn't be one) simply has nowhere
    // to record into.
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? null : stripPrefix(raw);
      continue;
    }
    // `--- a/<path>` — the OLD-file header, checked before the generic `-`-prefix
    // "removed line" check for the identical reason. Its path is never used (this
    // module numbers the NEW file only), but the line must still be recognized as
    // a header and skipped rather than mistaken for a removed content line.
    if (line.startsWith("--- ")) {
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      cursor = Number(hunkMatch[1]);
      continue;
    }

    // Everything below only makes sense once a hunk header has been seen for the
    // current file (`cursor` initialized) and a target path is known. A line
    // before the first `@@` (the `diff --git` / `index` preamble) or a stray line
    // with no active path is neither header nor content — ignored.
    if (currentPath === null) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" -- a marker about the PREVIOUS line, not
      // content of its own. Must not advance the cursor or be mistaken for a
      // context line (it doesn't start with ` `, `+`, or `-`, so it wouldn't be
      // mistaken for +/- anyway, but it also isn't a context line to count).
      continue;
    }

    if (line.startsWith("+")) {
      // An ADDED line: record the cursor's current value as an added new-file
      // line number, THEN advance — the line being recorded occupies exactly this
      // new-file line number, and the next line (whatever it is) occupies the
      // next one.
      let set = result.get(currentPath);
      if (!set) {
        set = new Set<number>();
        result.set(currentPath, set);
      }
      set.add(cursor);
      cursor++;
      continue;
    }

    if (line.startsWith("-")) {
      // A REMOVED line: it existed only in the OLD file and has no new-file line
      // number, so the cursor must NOT advance (trap #2 in the module doc).
      // Getting this backwards silently shifts every subsequent line number in
      // the hunk without any visible symptom.
      continue;
    }

    // A context line (starts with a literal space) or a blank line inside a hunk
    // (some diff producers emit a bare empty line for a blank context line
    // instead of a line with a single leading space) — it exists in both old and
    // new files, so the new-file cursor advances but nothing is recorded as
    // added.
    cursor++;
  }

  return result;
}

/**
 * `+++ b/includes/a.php` -> `includes/a.php`. Unified diffs conventionally
 * prefix the new-file side with `b/` (and the old side with `a/`), but that
 * prefix is a git/diff-tool CONVENTION, not part of the path — matching a
 * finding's file path against this map requires the bare worktree-relative
 * path, so the prefix must be stripped here rather than carried through (the
 * "ignores the +++ header" test below pins exactly this: the map must key on
 * `includes/a.php`, never on `b/includes/a.php`).
 *
 * Only the FIRST `a/`/`b/` is stripped, and only when present — some diff
 * generators (`git diff --no-prefix`, or a hand-built patch) omit the prefix
 * entirely, and a path that happens to start with a literal `a/` or `b/`
 * directory of its own is rare enough, and the convention strong enough, that
 * stripping unconditionally (when the prefix is there) is the correct tradeoff
 * — this mirrors how `git apply`/`patch -p1` behave by default.
 */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}
