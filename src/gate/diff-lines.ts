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

/** git C-quotes a path (wraps it in `"..."`) whenever it contains bytes it
 *  considers unsafe to print raw -- confirmed by capturing real `git diff`
 *  output: a non-ASCII filename produces e.g. `+++ "b/\321\204\320\260\320\271
 *  \320\273.php"`, where each `\NNN` is a 3-DIGIT OCTAL escape naming one raw
 *  UTF-8 byte of the encoded filename (NOT one decoded character -- a
 *  multi-byte UTF-8 character is a run of several consecutive `\NNN`
 *  escapes that must be regrouped and decoded together). `\"` and `\\`
 *  escape a literal quote/backslash; the other C-style single-letter
 *  escapes (`\n`, `\t`, `\r`, `\a`, `\b`, `\f`, `\v`) are recognized for the
 *  same reason -- a path is technically free to contain any of those raw
 *  bytes on a POSIX filesystem. (Empirically, a plain ASCII space alone does
 *  NOT trigger quoting on this git version -- only non-ASCII/control bytes
 *  do -- but this decoder handles whatever quoted form it is actually given,
 *  regardless of which condition triggered it.) */
function decodeGitQuotedPathContent(escaped: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i]!;
    if (ch === "\\" && i + 1 < escaped.length) {
      const next = escaped[i + 1]!;
      const simple: Record<string, number> = {
        '"': 0x22,
        "\\": 0x5c,
        n: 0x0a,
        t: 0x09,
        r: 0x0d,
        a: 0x07,
        b: 0x08,
        f: 0x0c,
        v: 0x0b,
      };
      if (Object.prototype.hasOwnProperty.call(simple, next)) {
        bytes.push(simple[next]!);
        i += 1;
        continue;
      }
      const octal = escaped.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8) & 0xff);
        i += 3;
        continue;
      }
      // R4-FIX1: an escape this decoder cannot read (a truncated `\12` at the
      // end, or an unknown letter) used to be kept as a literal backslash --
      // which quietly produced a DIFFERENT path than the one git wrote, and a
      // wrong key drops every finding for that file. Refuse instead.
      throw new Error(
        `addedLineNumbers: quoted path contains an unrecognized or truncated escape sequence ` +
          `at ${JSON.stringify(escaped.slice(i, i + 4))} -- the diff is malformed or was truncated`,
      );
    }
    // A literal (unescaped) character. git only ever leaves printable-safe
    // bytes unescaped inside a quoted path, so this is always a single
    // ASCII byte in practice.
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  // R4-FIX2: `fatal: true`. A non-fatal decoder REPLACES an invalid byte
  // sequence with U+FFFD, so `"b/x\200.php"` (a lone UTF-8 continuation byte)
  // yielded the key `x<U+FFFD>.php` -- a path that does not exist -- and every
  // finding for the real file was then silently dropped. A path we cannot decode
  // means a corrupt diff, and this module's contract is to be loud rather than
  // approximate.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(
      `addedLineNumbers: quoted path ${JSON.stringify(escaped)} does not decode as UTF-8 -- refusing to ` +
        `substitute replacement characters, which would key the added-line map on a path that does not exist`,
    );
  }
}

/** If `raw` is a whole, C-quoted path (`"..."`), decode it (R3-FIX1);
 *  otherwise return it unchanged. Applied at every point this module reads a
 *  path straight off a diff line -- `--- `, `+++ `, `copy to `, and the
 *  `diff --git a/... b/...` line -- because a quoted path's literal text
 *  starts with `"`, which `stripPrefix`'s `a/`/`b/` check does not
 *  recognize: without unquoting first, the map ends up keyed on the quoted,
 *  still-escaped string, and a finding on that file's added lines is
 *  silently dropped when a real caller looks it up by the plain, decoded
 *  path. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;

  // R4-FIX1: a path that OPENS a quote must close it, and the closing quote must
  // be a real terminator rather than an escaped `\"` that happens to sit last.
  // The previous `startsWith('"') && endsWith('"')` test accepted a truncated
  // header like `+++ "b/x.php` verbatim, so the map was keyed on the literal
  // `"b/x.php` -- quotes and all -- and a finding on the real `x.php` was
  // silently dropped. A corrupt diff must be loud here, not guessed at.
  //
  // Termination is decided by scanning, not by looking at the last character:
  // `"b/x\\"` ends in an ESCAPED backslash followed by a genuine closing quote
  // and is perfectly valid, while `"b/x\"` ends in an escaped QUOTE and is not
  // terminated at all. Only a scan that consumes escapes in order tells the two
  // apart.
  let i = 1;
  let closedAt = -1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      i += 2; // skip the escaped byte; a trailing lone `\` falls out of the loop
      continue;
    }
    if (ch === '"') {
      closedAt = i;
      break;
    }
    i += 1;
  }
  if (closedAt !== raw.length - 1) {
    throw new Error(
      `addedLineNumbers: quoted path ${JSON.stringify(raw)} is not properly terminated -- the diff is ` +
        `malformed or was truncated. Refusing to key the added-line map on a path this module cannot read, ` +
        `because a wrong key silently drops every finding for that file`,
    );
  }
  const decoded = decodeGitQuotedPathContent(raw.slice(1, closedAt));
  if (decoded === "") {
    // R5-FIX3: `""` passes the termination scan (the closing quote IS the last
    // character) and decodes to the empty string, which is not a filename any
    // filesystem can hold. Accepting it seeds the map -- and possibly
    // `newFiles` -- with an empty key that matches nothing, so every finding for
    // whatever file the diff actually meant is then treated as out of scope.
    throw new Error(
      `addedLineNumbers: diff contains an empty quoted path ("") -- no filesystem holds such a path, so the ` +
        `diff is malformed; refusing rather than keying the added-line map on a path that can never match`,
    );
  }
  return decoded;
}

/** Matches a `diff --git` line where BOTH sides are C-quoted (R3-FIX1/FIX2).
 *  Confirmed by real `git diff` output: git quotes each side of this line
 *  INDEPENDENTLY (only the side that actually needs it), but for a brand-new
 *  file specifically the old and new paths are always textually identical
 *  (the "old" side is nominal -- the file never existed there), so a
 *  genuinely new file's `diff --git` line is always either quoted on BOTH
 *  sides or on NEITHER, never a mismatched one-quoted-one-not. This pattern
 *  is deliberately only used for that guaranteed-identical case (see
 *  `newFilePathFromDiffGitLine`) -- it is not a general rename/copy parser. */
const DIFF_GIT_BOTH_QUOTED_RE = /^diff --git "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/;

/** Matches a `diff --git a/<path> b/<path>` line where BOTH sides are
 *  UNQUOTED and textually IDENTICAL -- the backreference `\1` is what makes
 *  this safe even when `<path>` itself contains spaces: unlike a naive
 *  split on the middle space, a backreference only matches at the one place
 *  (if any) where the text after `a/` and the text after `b/` are exactly
 *  the same string, which is guaranteed for a brand-new file's `diff --git`
 *  line (no rename is possible when the file did not exist before). */
const DIFF_GIT_BOTH_UNQUOTED_SAME_RE = /^diff --git a\/(.+) b\/\1$/;

/** Extract the new-file path from a `diff --git` line, for the ONE case this
 *  module needs it (R3-FIX2): a `new file mode` header, whose own text
 *  carries no path at all, on a file with no `+++` header to fall back on (a
 *  binary addition prints `Binary files /dev/null and b/x.png differ`
 *  instead). Returns `null` when the line does not match either recognized
 *  new-file shape -- notably, a rename or copy line (old path != new path)
 *  never matches, which is correct: those are handled by `rename to`/`copy
 *  to` directly (a rename is never new content; a copy's destination is
 *  read straight off `copy to`), and a `new file mode` header never appears
 *  on either of those anyway. */
function newFilePathFromDiffGitLine(line: string): string | null {
  const quoted = DIFF_GIT_BOTH_QUOTED_RE.exec(line);
  if (quoted) {
    // The decoded quoted content still carries its OWN a//b/ convention
    // prefix (`a/картинка.png` vs `b/картинка.png`) -- those two strings can
    // never be equal as-is even for the identical underlying file, so the
    // old==new proof has to compare the paths AFTER stripping each side's
    // own prefix, not the raw decoded strings.
    const oldPath = stripPrefix(decodeGitQuotedPathContent(quoted[1]!));
    const newPath = stripPrefix(decodeGitQuotedPathContent(quoted[2]!));
    if (oldPath !== newPath) return null;
    return newPath;
  }
  const unquoted = DIFF_GIT_BOTH_UNQUOTED_SAME_RE.exec(line);
  if (unquoted) return unquoted[1]!; // already prefix-free: captured after "a/"
  return null;
}

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
  const rawLines = diffText.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  // R6-FIX4: a trailing newline is the LAST REAL LINE'S TERMINATOR, not a line of
  // its own, but `split("\n")` yields an extra empty element for it. That element
  // was then treated as a bare blank context line -- so a diff truncated right
  // after a hunk header (`@@ -1,1 +1,1 @@\n`) had its counters fully discharged by
  // an artifact of splitting, and the underflow guard never fired: a corrupt diff
  // returned an empty added-set successfully. Drop exactly one trailing empty
  // element, and only when the text really ends in a newline -- a genuinely blank
  // final context line is `"\n\n"`, whose second-to-last element survives.
  const lines = diffText.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;

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
  // R3-FIX2: the new-side path parsed off the most recent `diff --git` line,
  // ONLY when that line proves (per `newFilePathFromDiffGitLine`) it is a
  // genuinely new file's line (old side textually identical to new side) --
  // `null` otherwise (a rename/copy, or a line this parser could not resolve).
  // Consumed the moment `new file mode` is seen, not deferred to `+++`,
  // because a binary addition never reaches a `+++` header at all.
  let pendingNewFilePath: string | null = null;

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
        // R7-FIX3: only the ONE marker git actually emits is a marker. Accepting
        // any `\`-prefixed line meant a corrupt body line like `\ bogus` was
        // skipped without consuming either counter, so the hunk still closed
        // cleanly on the following context line and the walker returned an empty
        // added-set successfully -- a corrupt diff reading as "the worker added
        // nothing", which makes a real finding on line 1 look pre-existing.
        if (line !== "\\ No newline at end of file") {
          throw new Error(
            `addedLineNumbers: hunk in ${currentPath ?? "<unknown file>"} contains a backslash line that is ` +
              `not git's "\\ No newline at end of file" marker -- the diff is malformed or was truncated. ` +
              `Offending line: ${JSON.stringify(line)}`,
          );
        }
        // "\ No newline at end of file" -- a marker about the PREVIOUS line,
        // not content of its own, and not counted in either the old or new
        // hunk-header count. Must not advance the cursor or consume a count.
        continue;
      }

      // R4-FIX3: only a genuine context line reaches here. Previously ANY
      // remaining line was consumed as context, so a corrupt body line such as
      // `@@ malformed-body` fully discharged BOTH counters and the walker
      // returned an empty added-set *successfully* -- a corrupt diff read as
      // "this task added no lines", which downstream means every finding is
      // pre-existing and none belongs to the worker. Silent and total.
      //
      // Legal body lines are exactly: ` ` (context), `+`, `-`, `\` (all handled
      // above), and a completely EMPTY line, which some producers emit for a
      // blank context line instead of a line holding a single space. Anything
      // else means the diff is not what it claims to be.
      // R8-FIX1: a context line MUST carry its leading space. The earlier
      // allowance for a bare empty line rested on an assumption ("some producers
      // emit a blank context line with no leading space") that was never checked
      // -- and is FALSE for the producer this actually consumes: `git diff` emits
      // `" "` for a blank context line, verified by capturing one (`cat -A` shows
      // a space before the line end). Accepting `""` therefore protected nothing
      // real and let a corrupt hunk close cleanly with an empty added-set, which
      // makes a genuine finding on an added line read as pre-existing. The
      // trailing-newline artifact that `split` produces is already dropped above,
      // so any empty line still reaching here is genuinely malformed.
      if (!line.startsWith(" ")) {
        throw new Error(
          `addedLineNumbers: hunk in ${currentPath ?? "<unknown file>"} contains a line that is not a valid ` +
            `unified-diff body line -- the diff is malformed or was truncated. Offending line: ${JSON.stringify(line)}`,
        );
      }

      // A context line — it starts with a literal space (git writes `" "` even
      // for a BLANK context line; verified against a real capture, see R8-FIX1
      // above). It exists in both old and new files, so both counts are consumed
      // and the new-file cursor advances, but nothing is recorded as added.
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
      // R3-FIX1: unquote BEFORE checking for the /dev/null sentinel and
      // before `+++` strips the a//b/ prefix -- a quoted path's raw text
      // starts with `"`, never matches `/dev/null` by accident, but must
      // still be decoded so the paired `+++` line (and `stripPrefix`) see
      // the real path, not the still-escaped wire form.
      const raw = unquotePath(line.slice(4).trim());
      oldWasDevNull = raw === "/dev/null";
      continue;
    }

    // `+++ b/<path>` — the NEW-file header. A deleted file's new side is
    // `+++ /dev/null`; such a file contributes nothing, so `currentPath` is set
    // to null rather than a path, and any hunk that follows (there shouldn't be
    // one) simply has nowhere to record into.
    if (line.startsWith("+++ ")) {
      // R3-FIX1: unquote first (see the `--- ` branch above) -- a quoted
      // path is `"b/<path>"` (the a//b/ convention prefix lives INSIDE the
      // quotes, confirmed against real `git diff` output), so `stripPrefix`
      // must run on the DECODED string, not the raw quoted one.
      const raw = unquotePath(line.slice(4).trim());
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
      if (line.startsWith("copy to ")) {
        // R3-FIX2: a git copy's destination is known directly from THIS
        // header (no a//b/ convention prefix on it -- confirmed against real
        // `copy to "<path>"` output) -- add it to `newFiles` right here
        // rather than waiting for a `+++` header a binary copy never has
        // ("Binary files ... differ" instead). Redundant-but-harmless for a
        // text copy, which also reaches the `+++` branch below.
        newFiles.add(unquotePath(line.slice("copy to ".length).trim()));
      } else if (pendingNewFilePath !== null) {
        // R3-FIX2: likewise for `new file mode` -- its own text carries no
        // path, so fall back to the new-side path already parsed off the
        // preceding `diff --git` line. Populating `newFiles` here (rather
        // than only inside `+++`) is what makes a binary addition (which
        // never reaches a `+++` header at all) actually get recorded.
        newFiles.add(pendingNewFilePath);
      }
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
      // R3-FIX2: (re)compute the pending new-file path for THIS file's
      // section. `null` when the line does not prove old==new (a rename or
      // copy, or a shape this parser cannot resolve) -- those never carry a
      // `new file mode` header anyway, so `pendingNewFilePath` is simply
      // never consumed for them.
      pendingNewFilePath = newFilePathFromDiffGitLine(line);
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
