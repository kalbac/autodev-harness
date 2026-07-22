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
 * A hand-rolled unified-diff walker is notorious for four silent-corruption traps,
 * each commented at its guard below because getting any one of them wrong produces
 * output that still LOOKS plausible:
 *
 *   1. The `+++ b/<path>` / `--- a/<path>` FILE HEADERS also start with `+`/`-`,
 *      and so does an ADDED LINE whose own content happens to begin with `++`
 *      (its wire form is literally `+++ <content>`, byte-for-byte indistinguishable
 *      from a file header by TEXT alone). The only way to tell them apart
 *      correctly is to never guess from the text at all: a hunk header's `-a,b
 *      +c,d` line counts say exactly how many body lines belong to the hunk, so
 *      this walker counts them in and treats `+++`/`---` as headers ONLY between
 *      hunks (or before the first one) — never while a hunk still has counted
 *      lines outstanding. Trusting the header's counts is what makes this
 *      distinction possible at all; sniffing body text for header-shaped prefixes
 *      (the previous approach) cannot ever fully rule this out.
 *   2. An unrecognized `@@`-prefixed line (a combined/merge-diff `@@@ -a,b -c,d
 *      +e,f @@@` header, or simply a corrupt one) must never be silently treated
 *      as "not a header" and left for the cursor to drift on — wrong line numbers
 *      are worse than none, because findings then get attributed to lines nobody
 *      wrote, with no visible symptom. This walker throws, naming the offending
 *      line, the moment it sees `@@` outside an active hunk and `HUNK_HEADER`
 *      does not match it. Combined diffs are never produced by anything this
 *      harness runs, which is exactly why this must be loud rather than quietly
 *      wrong if it is ever fed one anyway.
 *   3. The new-file line cursor advances on CONTEXT lines (` `) and on ADDED
 *      lines (`+`), but NOT on REMOVED lines (`-`) — a removed line never existed
 *      in the new file, so it must not consume a new-file line number. Get this
 *      backwards and every line number after the first hunk with a deletion is
 *      silently shifted — silently, because the output is still a
 *      plausible-looking set of numbers.
 *   4. A brand-new file is `--- /dev/null` with a single `@@ -0,0 +1,N @@` hunk;
 *      every one of its lines is an addition, and the `--- /dev/null` marker is
 *      the exact, reliable signal for "this whole file is new" — reported
 *      separately as `newFiles` rather than reconstructed later from the shape
 *      of the added-line set (see `newFiles` below). Git's copy-detection
 *      output produces a genuinely new file WITHOUT `/dev/null` (the old side
 *      is the source file it was copied from), so `copy to <path>` and `new
 *      file mode ...` are recognized as the same signal — but `rename to
 *      <path>` deliberately is not: a rename moves existing content, it does
 *      not originate it (see `sawNewFileSignal` below).
 *
 * Windows note: diffs captured on this platform can arrive with CRLF line endings.
 * Every line has its trailing `\r` stripped before any of the above logic runs —
 * skip that and a diff parses differently depending on which OS produced it.
 */

/** Matches a hunk header and captures all four line-count fields: the OLD-file
 *  start/count and the NEW-file start/count. Both counts are OPTIONAL in a
 *  unified diff (a single-line hunk omits the comma-count and defaults to `1`)
 *  — per RFC/POSIX `diff -u` convention, an omitted count always means exactly
 *  one line. These counts are now TRUSTED (see trap #1 above): the walker
 *  consumes exactly `oldCount` old-file lines and `newCount` new-file lines from
 *  the hunk body, rather than guessing the hunk's extent from the text shape of
 *  each body line. A line that starts with `@@` but does not match this pattern
 *  (e.g. a combined-diff `@@@ ... @@@` header) is handled by the caller (trap
 *  #2): it throws rather than silently falling through. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Result of walking a diff: which new-file lines it added, and which files it
 *  created from nothing. Both are keyed on the same normalized, worktree-relative,
 *  `/`-separated path (see `stripPrefix`) so a caller can look either up with the
 *  identical key. */
export interface AddedLines {
  /** Per touched path, the set of new-file line numbers the diff added. A file
   *  the diff touches but adds nothing to (a deletion-only hunk, or a hunk that
   *  only reorders/removes lines) is simply absent from this map rather than
   *  present with an empty set — callers that need "was this file even touched"
   *  should consult the diff/touched-files list directly, not this map. */
  added: Map<string, Set<number>>;
  /** Paths whose diff hunk shows `--- /dev/null` as the old side — i.e. the file
   *  did not exist before this diff at all. This is the DIRECT signal for "brand
   *  new file", read straight off the diff rather than inferred later from
   *  whether the added-line set happens to look like a contiguous `1..N` run (a
   *  shape an ordinary full-file rewrite of an EXISTING file can also produce). */
  newFiles: Set<string>;
}

/**
 * Walks a unified diff (possibly covering several files and several hunks per
 * file) and returns, per worktree-relative `/`-separated path, the set of
 * new-file line numbers the diff added, plus the set of paths that are brand
 * new (see `AddedLines`).
 */
export function addedLineNumbers(diffText: string): AddedLines {
  const added = new Map<string, Set<number>>();
  const newFiles = new Set<string>();

  // Strip a trailing `\r` from every line UP FRONT, before any header/hunk/body
  // logic runs, so a CRLF-captured diff (routine on Windows) behaves identically
  // to an LF one. Splitting on `\n` alone would otherwise leave a `\r` glued to
  // the end of every path and every hunk-header number, breaking both the file
  // header match and the `+`/`-`/` ` prefix checks below (a line body of `\r`-only
  // content is indistinguishable from empty without this).
  const lines = diffText.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

  let currentPath: string | null = null;
  let cursor = 0; // next NEW-file line number; only meaningful once a hunk header set it
  let remainingOld = 0; // old-file body lines still owed by the current hunk
  let remainingNew = 0; // new-file body lines still owed by the current hunk
  // Set on `--- ` and consumed on the very next `+++ ` — a well-formed diff
  // always pairs them adjacently, so this needs no stack or per-file map.
  let oldWasDevNull = false;
  // Set on a `copy to <path>` or `new file mode ...` extended header and
  // consumed on the very next `+++ ` header, exactly like `oldWasDevNull`
  // above (R2-FIX2). A git COPY's old side is the source file, NOT
  // `/dev/null` (`--- a/src.php`), so `oldWasDevNull` alone misses it even
  // though a copy genuinely creates a new file the worker is responsible
  // for. A RENAME must NOT set this — its content moved, it did not
  // originate — so only `copy to` (never `rename to`) is recognized here.
  let sawNewFileSignal = false;

  for (const line of lines) {
    // Trap #3 (formerly #1): while a hunk still has counted body lines
    // outstanding, `+`/`-`/`\`-prefixed text is CONTENT, never a header — no
    // matter what it looks like. This is what makes an added line whose own
    // text begins with `++` (wire form `+++ <content>`) safe: it is only ever
    // interpreted as a header when the hunk's own line counts say there is no
    // more body left to consume.
    if (remainingOld > 0 || remainingNew > 0) {
      if (line.startsWith("+")) {
        // An ADDED line: record the cursor's current value as an added new-file
        // line number, THEN advance — the line being recorded occupies exactly
        // this new-file line number, and the next line (whatever it is)
        // occupies the next one.
        if (remainingNew <= 0) {
          throw new Error(
            `addedLineNumbers: hunk in ${currentPath ?? "<unknown file>"} has more added/context lines than ` +
              `its header declared -- the diff is malformed or was truncated. Offending line: ${JSON.stringify(line)}`,
          );
        }
        if (currentPath !== null) {
          let set = added.get(currentPath);
          if (!set) {
            set = new Set<number>();
            added.set(currentPath, set);
          }
          set.add(cursor);
        }
        cursor++;
        remainingNew--;
        continue;
      }

      if (line.startsWith("-")) {
        // A REMOVED line: it existed only in the OLD file and has no new-file
        // line number, so the cursor must NOT advance (trap #3 in the module
        // doc). Getting this backwards silently shifts every subsequent line
        // number in the hunk without any visible symptom.
        if (remainingOld <= 0) {
          throw new Error(
            `addedLineNumbers: hunk in ${currentPath ?? "<unknown file>"} has more removed/context lines than ` +
              `its header declared -- the diff is malformed or was truncated. Offending line: ${JSON.stringify(line)}`,
          );
        }
        remainingOld--;
        continue;
      }

      if (line.startsWith("\\")) {
        // "\ No newline at end of file" -- a marker about the PREVIOUS line,
        // not content of its own, and not counted in either the old or new
        // hunk-header count. Must not advance the cursor or consume a count.
        continue;
      }

      // A context line (starts with a literal space) or a blank line inside a
      // hunk (some diff producers emit a bare empty line for a blank context
      // line instead of a line with a single leading space) — it exists in
      // both old and new files, so both counts are consumed and the new-file
      // cursor advances, but nothing is recorded as added.
      if (remainingOld <= 0 || remainingNew <= 0) {
        throw new Error(
          `addedLineNumbers: hunk in ${currentPath ?? "<unknown file>"} has more context lines than its header ` +
            `declared -- the diff is malformed or was truncated. Offending line: ${JSON.stringify(line)}`,
        );
      }
      cursor++;
      remainingOld--;
      remainingNew--;
      continue;
    }

    // Outside an active hunk (before the first one, or between two): headers
    // and hunk openers are recognized here, and ONLY here (trap #3).

    // `--- a/<path>` — the OLD-file header. A brand-new file's old side is
    // `--- /dev/null` (trap #4): remember that so the immediately-following
    // `+++` header can record the new path into `newFiles`.
    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      oldWasDevNull = raw === "/dev/null";
      continue;
    }

    // `+++ b/<path>` — the NEW-file header. A deleted file's new side is
    // `+++ /dev/null`; such a file contributes nothing, so `currentPath` is set
    // to null rather than a path, and any hunk that follows (there shouldn't be
    // one) simply has nowhere to record into.
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? null : stripPrefix(raw);
      if ((oldWasDevNull || sawNewFileSignal) && currentPath !== null) {
        newFiles.add(currentPath);
      }
      oldWasDevNull = false;
      sawNewFileSignal = false;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      cursor = Number(hunkMatch[3]);
      remainingOld = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      remainingNew = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      continue;
    }

    // Trap #2: a line that starts with `@@` but did not match `HUNK_HEADER`
    // (a combined/merge-diff `@@@ ... @@@` header, or simply corrupt) must
    // never be silently treated as ordinary preamble text -- doing so would
    // leave `cursor` at its stale previous value and every subsequent added
    // line in this "hunk" would be numbered wrong, with no visible symptom.
    // Loud failure here is strictly safer than quiet corruption, even though
    // this harness never produces combined diffs itself.
    if (line.startsWith("@@")) {
      throw new Error(
        `addedLineNumbers: unrecognized hunk header (does not match "@@ -a[,b] +c[,d] @@"): ${JSON.stringify(line)}`,
      );
    }

    // `new file mode <mode>` and `copy to <path>` (R2-FIX2): extended-header
    // signals for "this path is a genuinely NEW file", recognized alongside
    // `--- /dev/null` rather than in place of it. Git's copy-detection output
    // pairs `copy from <src>` / `copy to <dst>` with a `--- a/<src>` /
    // `+++ b/<dst>` body -- the old side is the SOURCE file, not
    // `/dev/null`, so `oldWasDevNull` alone misses it even though the
    // destination is a file the worker created. `rename from`/`rename to` is
    // deliberately NOT matched here: a rename moves existing content, it
    // does not originate it, so its file-level findings stay pre-existing.
    if (line.startsWith("copy to ") || line.startsWith("new file mode ")) {
      sawNewFileSignal = true;
      continue;
    }

    // A `diff --git` line opens a new file's section, so BOTH new-file signals
    // are cleared here. They are normally consumed by the very next `+++`
    // header, but a file with no hunk body at all -- a binary addition, or a
    // pure mode change -- never reaches one, and the flag would then survive
    // into the FOLLOWING file's header and mark an ordinary modified file as
    // new. That misattributes the file's pre-existing file-level findings to
    // the worker: a false block rather than a missed violation, so the safe
    // direction, but wrong either way and cheap to close at the one boundary
    // that unambiguously means "previous file's section is over".
    if (line.startsWith("diff --git ")) {
      oldWasDevNull = false;
      sawNewFileSignal = false;
      continue;
    }

    // Everything else (the `diff --git` / `index` preamble, or a stray line
    // with no active path) is neither header nor content — ignored.
  }

  // R2-FIX1: symmetric with the overflow guard inside the loop above -- a
  // hunk that reaches end-of-input still owing old- or new-side body lines
  // means the diff was truncated (a killed `git diff`, a clipped buffer).
  // The overflow guard alone only catches a hunk that received TOO MANY
  // lines; without this, a hunk that received TOO FEW simply leaves the
  // shortfall's line numbers absent from `added` with no visible symptom --
  // and a finding that lands on one of them is then silently dropped as "not
  // an added line" rather than flagged as unattributed input.
  if (remainingOld > 0 || remainingNew > 0) {
    throw new Error(
      `addedLineNumbers: diff ended mid-hunk in ${currentPath ?? "<unknown file>"} -- the last hunk still ` +
        `owed ${remainingNew} new-file and ${remainingOld} old-file line(s) that its header declared. The ` +
        `diff is truncated (a killed process or a clipped buffer), not just short.`,
    );
  }

  return { added, newFiles };
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
