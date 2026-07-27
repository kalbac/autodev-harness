/**
 * The critic's EVIDENCE WINDOW (#123, `docs/gotchas/critic-sees-only-the-diff-hunk.md`).
 *
 * The critic's prompt used to carry `diff.patch` and nothing else — changed lines plus
 * three lines of context. The critic reasons fail-closed by design ("I cannot verify
 * this from what I was given" => not `clean`), and those two facts together make a
 * clean verdict STRUCTURALLY UNREACHABLE for any change whose correctness depends on
 * code outside the hunk. That is not a hypothesis: the first live corpus run measured
 * `first_pass_commit_rate: 0%`, with a change that replaced `array(1,2)` by a constant
 * declared FIFTEEN LINES ABOVE IT, in the same file, coming back `uncertain` because
 * "that declaration is not present in the inline diff".
 *
 * This module answers the narrow question that fix needs: given the files a diff
 * touches, WHICH of them can be handed to the critic in full, and which cannot — with
 * a NAMED reason for every one that cannot. It does not build the prompt (that is
 * `prompt.ts`) and it does not decide verdicts.
 *
 * Three rules are load-bearing, in the sense that getting any of them wrong makes the
 * gate worse than it is today rather than better:
 *
 *  1. **Never attach a truncated file.** A half-file reads to the critic exactly like
 *     a complete one, so truncation manufactures a brand-new class of FALSE `broken`
 *     ("the constant is never declared") that does not exist today. A file that does
 *     not fit is OMITTED, whole, and said out loud.
 *  2. **An omission is reported, never silent.** The prompt tells the critic that a
 *     file it was not shown is not evidence of absence. A silently dropped attachment
 *     would invite precisely the inference this whole change exists to remove.
 *  3. **Every "I could not read this" keeps its own reason.** Folding `absent`,
 *     `not-text` and `unreadable` into one boolean is the defect shape this repo has
 *     now hit four times in one review (`docs/gotchas/boolean-whose-no-means-two-
 *     things.md`): a deleted file and an unreadable one mean very different things to
 *     a reviewer, and only the reason field can tell them apart.
 *
 * The failure DIRECTION throughout is "attach less" — an evidence set that comes back
 * empty leaves the critic exactly as blind as it is today, which is the conservative
 * outcome (Principle 10). Nothing here can make a change easier to merge than it is
 * now by failing.
 */
import { open, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { READ_NO_FOLLOW_FLAGS } from "../util/bounded-read.js";
import { realpathContains } from "../util/path-contain.js";
import { globMatch } from "../util/glob.js";

/**
 * Per-file and total attachment budgets, in bytes.
 *
 * MEASURED rather than guessed (this repo has lost a review round to an assumed
 * number before): the files the evaluation corpus's cases touch are 281–1412 bytes;
 * the largest PHP file in the polygon project is ~136 KB; and codex digested an 88 KB
 * prompt in the s57 review gate without complaint. 64 KB per file therefore attaches
 * every realistic source file and omits only a genuine outlier, while 256 KB in total
 * bounds a pathological many-file task without ever bounding a normal one.
 *
 * These are deliberately CONSTANTS, not config: the number that matters is what the
 * critic can actually digest, which is a property of the critic, not of a project.
 */
export const MAX_EVIDENCE_BYTES_PER_FILE = 64 * 1024;
export const MAX_EVIDENCE_BYTES_TOTAL = 256 * 1024;

/**
 * Lines of context the critic's diff is captured with (`git diff -U25`), the cheap
 * half of the same fix. Attaching whole files makes this largely redundant for files
 * that ARE attached — it earns its keep for the ones that are not, where a wider
 * window is the only extra evidence available.
 */
export const CRITIC_DIFF_CONTEXT_LINES = 25;

/** Runtime-file name of the per-task evidence MANIFEST (paths, sizes, omission
 *  reasons — never contents). Named here so the writer and any reader of the archived
 *  corpus artifacts agree on it by construction. */
export const CRITIC_EVIDENCE_FILE = "critic-evidence.json";

/**
 * `adr/007`: does this change touch ONLY paths the operator declared as documentation?
 *
 * The critic's mandate is narrowed for such a change — an assertion it makes about code
 * the diff does not touch becomes a `notes` entry instead of a lowered verdict, because
 * the code in question is deliberately outside the change and the critic's only honest
 * answer is "I cannot verify this". A question with one possible answer is not a gate;
 * it is a permanent `uncertain` that blocks the whole class forever.
 *
 * **This is a DECLARATION check, not a detection.** The first implementation inferred
 * prose from the file extension plus a blacklist of executable markers, and three review
 * rounds found three different markers it missed — a fence arriving as a diff CONTEXT
 * line, then `<script>`, then `<iframe>`/`onerror`/`javascript:`/`{% include %}`. The
 * blacklist was not merely incomplete, it was unclosable: whether a `.md` executes is a
 * property of the PROJECT's toolchain (a doc-test runner, a static-site generator, a
 * templating include), which the harness has no way to see. So the operator declares
 * (`contract.docPaths`) and the harness verifies the declaration covers the change. That
 * is `adr/006`'s pattern applied to the mandate: the oracle is blessed, never guessed.
 *
 * Refusals, all of which yield `false` — the failure direction is always "no leniency",
 * so every way this can go wrong leaves the gate exactly as strict as it is today:
 *
 *  1. **Nothing declared.** An empty `docPaths` is the default, and it means the project
 *     has not opted in. No leniency anywhere.
 *  2. **No changed paths.** Nothing to vouch for; the question is not meaningful.
 *  3. **A non-string or blank path.** REFUSED, never filtered away. A blank entry names
 *     nothing, so it cannot be matched against a declaration — and quietly skipping it
 *     would let `["", "docs/x.md"]` qualify on the strength of a list only half read
 *     (`docs/gotchas/empty-path-resolves-to-repo-root.md` is the same shape one layer
 *     down).
 *  4. **Any path outside the declaration.** Every path must match; one unmatched path
 *     disqualifies the change. A mixed docs-plus-code diff is a code diff.
 *
 * `changedPaths` must be the file list of the SAME diff the critic reads — the
 * authoritative set, before any budget or blank filtering (see `CriticEvidence`).
 */
export function isDeclaredDocsOnlyChange(changedPaths: string[], docPathGlobs: string[]): boolean {
  // Both arguments cross a module boundary and one of them arrives from a config file.
  // A non-array here would throw out of a predicate whose every other failure mode is a
  // quiet `false`, turning "no leniency" into "the evidence collection died" (R1 major:
  // the middle-inserted positional parameter makes a mis-ordered call plausible, and TS
  // catches it only for callers it can see).
  if (!Array.isArray(changedPaths) || !Array.isArray(docPathGlobs)) return false;

  const globs = docPathGlobs.filter((g) => typeof g === "string" && g.trim() !== "");
  if (globs.length === 0) return false;
  if (changedPaths.length === 0) return false;

  for (const p of changedPaths) {
    if (typeof p !== "string" || p.trim() === "") return false;
    if (!isPlainRelativePath(p)) return false;
    if (!globs.some((g) => globMatch(g, p))) return false;
  }
  return true;
}

/**
 * Is this a worktree-relative path with no traversal and no drive/root anchor?
 *
 * `globMatch` is a pure textual matcher: `docs/**` compiles to `^docs/.*$`, which the
 * string `docs/../src/index.php` satisfies while naming a file that is not under `docs/`
 * at all (R1 blocker 2). Git's `--name-only` output never contains a `..` segment, so
 * this is not reachable through the conductor today — but `isDeclaredDocsOnlyChange` is
 * an exported predicate guarding an oracle decision, and "unreachable today" is not the
 * standard a leniency gate is held to.
 *
 * It REFUSES rather than normalizes, deliberately. Normalizing would silently accept a
 * path list that should never have contained a traversal segment in the first place; a
 * `..` arriving here means the caller is not passing what this function documents, and
 * the honest response to an input you cannot explain is to decline
 * (`docs/gotchas/boolean-whose-no-means-two-things.md`).
 */
function isPlainRelativePath(p: string): boolean {
  // A control character (NUL above all) cannot occur in a path git reports, and a NUL
  // in particular truncates the string for any C-level consumer downstream — so
  // `docs/README.md\0src/index.php` would match `docs/**` here and name a different
  // file to something else (R2 minor 3).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/")) return false; // POSIX absolute, and UNC `//server/share`
  if (/^[a-zA-Z]:/.test(s)) return false; // Windows drive-anchored, incl. a bare `D:`
  return !s.split("/").includes("..");
}

/**
 * Does this unified diff consist of ADDITIONS ONLY — at least one added line, and not a
 * single removed one?
 *
 * `adr/007`'s narrowing is scoped to added prose, because the attack it must keep closed
 * is "rewrite the documented contract, then ship code that matches the documentation".
 * The first version of this change stated that scope in the PROMPT and left the
 * added-vs-modified call to the model, which R1 called a blocker — correctly, and for the
 * same reason R1 of the parked attempt was a blocker: in this project the enforcement
 * decision is never the model's (Principles 1 and 3). The distinction is mechanically
 * decidable from the diff, so it is decided here.
 *
 * It parses hunks by their DECLARED LINE COUNTS (`@@ -old,n +new,m @@`) and consumes
 * exactly that many body lines, rather than guessing where a hunk ends from line
 * prefixes. R2 is why. The prefix version ended a hunk on the next `diff --git `, which
 * meant a bare `diff --git` line appearing *inside* a hunk body silently reset the parser
 * and hid every removal after it. Counting from the header removes the guess: inside a
 * hunk the first character is unambiguous, and outside one nothing is interpreted as
 * content at all.
 *
 * Refuses (returns `false`) on: any removal, a diff with no hunks (a pure rename or mode
 * change has nothing to be lenient about), a hunk whose body does not match its declared
 * counts, an unparseable hunk header, and any hunk-body line it cannot classify. Every
 * refusal costs only leniency (Principle 10).
 */
export function isAdditionsOnlyDiff(diff: string): boolean {
  if (typeof diff !== "string" || diff.trim() === "") return false;

  const lines = diff.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let additions = 0;
  let sawHunk = false;

  // R4: a POSITIONAL state machine, not a flat allow-list. R3 accepted any recognized
  // header prefix anywhere outside a hunk, and `--- ` is such a prefix — so a removed
  // line whose content is `-- ` renders as `--- `, lands after a consumed hunk, and was
  // skipped as a header instead of examined as a removal. `--- ` and `+++ ` are only
  // headers in ONE position: inside the block that a `diff --git` line opens. After a
  // hunk they are not headers at all, so they are not accepted there.
  //
  // This is the fifth round of the same shape (each fix removing one way to skip a line
  // rather than removing skip-by-default), and position is what finally makes the
  // question decidable: a line means what its LOCATION says it means, not what its first
  // characters resemble.
  type Ctx = "start" | "fileHeader" | "afterHunk";
  let ctx: Ctx = "start";
  /** Has the CURRENT file block produced a `+++ ` header? R5 high 2: a hunk accepted
   *  without one belongs to a file `diffHeaderPaths` cannot name, which makes
   *  `qualifiesForDocsNarrowing`'s subset check vacuous for exactly that file. */
  let blockHasNewPath = false;

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    if (!header.startsWith("@@")) {
      // The empty split element from a trailing newline can never be a removal.
      if (header === "") continue;
      if (header.startsWith("diff --git ")) {
        ctx = "fileHeader";
        blockHasNewPath = false;
        continue;
      }
      // `\ No newline at end of file` can trail the last counted line of a hunk.
      if (ctx === "afterHunk" && header.startsWith("\\ ")) continue;
      if (ctx === "fileHeader" && FILE_HEADER_BLOCK_PREFIXES.some((p) => header.startsWith(p))) {
        if (header.startsWith("+++ ")) blockHasNewPath = true;
        continue;
      }
      return false;
    }

    // R5 high 2: every hunk must belong to a file this diff actually NAMED. A hunk with
    // no `+++ ` header ahead of it is a hunk `diffHeaderPaths` cannot see, so the subset
    // check in `qualifiesForDocsNarrowing` would silently not cover it.
    if (!blockHasNewPath) return false;

    // `@@ -l[,s] +l[,s] @@ optional section heading`. A missing size means 1.
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header);
    if (!m) return false;
    let oldLeft = m[1] === undefined ? 1 : Number(m[1]);
    let newLeft = m[2] === undefined ? 1 : Number(m[2]);
    sawHunk = true;

    // R5 medium: the counters may never go NEGATIVE, and the loop may only end with both
    // at exactly zero. Exiting on `<= 0` let a hunk declaring `-1,1 +1,1` supply
    // `+a`/`+b`/` c`, drive newLeft to -2, consume every line, and report a malformed
    // diff as additions-only.
    while (oldLeft > 0 || newLeft > 0) {
      i++;
      if (i >= lines.length) return false; // truncated hunk -- do not guess the rest
      const line = lines[i]!;

      if (line.startsWith("-")) return false; // the whole point
      if (line.startsWith("+")) {
        if (newLeft <= 0) return false; // more additions than the header declared
        additions++;
        newLeft--;
        continue;
      }
      // A `\ No newline at end of file` marker belongs to the preceding line and
      // consumes no count of its own.
      if (line.startsWith("\\")) continue;
      // ` ` context, and the bare empty line git emits for an empty context line.
      if (line === "" || line.startsWith(" ")) {
        if (oldLeft <= 0 || newLeft <= 0) return false; // context outside both counts
        oldLeft--;
        newLeft--;
        continue;
      }
      return false; // anything else: we are not reading a hunk body we understand
    }
    ctx = "afterHunk";
  }

  return sawHunk && additions > 0;
}

/**
 * Lines git may emit INSIDE the header block a `diff --git` line opens, and nowhere else.
 * `--- `/`+++ ` are here rather than in a global list because that is the only position in
 * which they are headers: after a hunk, a line starting `--- ` is a removed line whose
 * content is `-- ` (R4 high).
 *
 * The list is deliberately SHORT, and every omission from it is a refusal:
 *
 *  - `deleted file mode` — a deletion is not an additions-only change, and an EMPTY file
 *    is deleted with NO HUNK AT ALL, so waiting to encounter a `-` line never catches it.
 *    R5 high 1: a diff that added one doc and deleted an empty one qualified.
 *  - `rename from`/`rename to`/`copy from`/`copy to`/`similarity index`/
 *    `dissimilarity index` — a rename removes a path, which this predicate cannot weigh,
 *    and a pure rename has nothing to be lenient about in the first place.
 *  - `Binary files ... differ` / `GIT binary patch` — content the parser cannot read, so
 *    it can neither confirm nor deny a removal.
 */
const FILE_HEADER_BLOCK_PREFIXES = ["index ", "--- ", "+++ ", "old mode ", "new mode ", "new file mode "];

/**
 * The post-change paths a unified diff's FILE HEADERS name — or `null` when the headers
 * are not the shape this function is willing to vouch for.
 *
 * Deliberately a separate reading of the diff TEXT, used only to cross-check the evidence
 * set against it (`qualifiesForDocsNarrowing`).
 *
 * It PINS the diff mode instead of stripping a prefix heuristically. R6 found why: under
 * `git diff --no-prefix`, a repository file genuinely at `a/x.md` is rendered
 * `--- a/x.md` / `+++ a/x.md`, and a blind `a/`-strip turns it into `x.md` — which then
 * matches an evidence entry for a DIFFERENT file. So the `---` side must be `a/…` or
 * `/dev/null` and the `+++` side must be `b/…` or `/dev/null`, which is exactly what
 * `buildDiffArgs` produces and nothing else does. A header that violates that returns
 * `null` and the narrowing is refused.
 *
 * Paths come from the `+++` side only: it is the post-change path, and the evidence set
 * describes files as they are AFTER the change. (`+++ /dev/null` is a deletion, which
 * `isAdditionsOnlyDiff` has already refused at the `deleted file mode` header.)
 *
 * `null` rather than `[]` because "these headers are wrong" and "this diff names no
 * files" are different facts, and folding them into one empty array is the shape this
 * repo keeps re-learning (`docs/gotchas/boolean-whose-no-means-two-things.md`).
 */
function diffHeaderPaths(diff: string): string[] | null {
  const out = new Set<string>();
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const isOld = line.startsWith("--- ");
    if (!isOld && !line.startsWith("+++ ")) continue;
    // Strip the marker, then git's trailing tab-timestamp field if present.
    const p = line.slice(4).split("\t")[0] ?? "";
    if (p === "/dev/null") continue;
    const expected = isOld ? "a/" : "b/";
    if (!p.startsWith(expected)) return null; // not the mode we know how to read
    const rel = p.slice(2);
    if (rel === "") return null;
    if (!isOld) out.add(rel);
  }
  return [...out];
}

/**
 * `adr/007`: may this diff be reviewed under the narrowed mandate?
 *
 * ONE predicate rather than two conditions at the call site, because R2's second finding
 * was precisely that the two mechanical checks read two different inputs and nothing
 * required them to describe the same change: `declaredDocsOnly` is computed from
 * `worktree.diffFiles`, while the additions check reads the diff TEXT. In production they
 * agree by construction (`buildDiffArgs` is shared, see `util/git.ts`) — but "agree by
 * construction elsewhere" is exactly the kind of invariant this repo has watched drift
 * (`docs/gotchas/validated-one-string-used-another.md`), and here drifting means granting
 * leniency to a diff that touches code.
 *
 * Three conditions, all required:
 *
 *  1. `evidence.declaredDocsOnly` — every changed path matched `contract.docPaths`.
 *  2. `isAdditionsOnlyDiff(diff)` — nothing is removed, so no documented contract is
 *     being rewritten.
 *  3. **Every path the diff's own headers name is present in the evidence set.** If the
 *     diff mentions a file the flag never saw, the two describe different changes and
 *     the flag vouches for nothing.
 */
export function qualifiesForDocsNarrowing(diff: string, evidence: CriticEvidence | undefined): boolean {
  if (evidence?.declaredDocsOnly !== true) return false;
  if (!isAdditionsOnlyDiff(diff)) return false;

  const known = new Set<string>([...evidence.attached.map((a) => a.path), ...evidence.omitted.map((o) => o.path)]);
  const named = diffHeaderPaths(diff);
  if (named === null) return false; // headers in a shape we will not vouch for (R6)
  if (named.length === 0) return false; // a diff whose files we cannot name is not vouched for
  return named.every((p) => known.has(p));
}

/** Why a touched file is not attached. Each value is a genuinely different fact about
 *  the file, and the prompt renders it verbatim so the critic can weigh it. */
export type OmissionReason =
  /** Larger than `MAX_EVIDENCE_BYTES_PER_FILE`; attaching part of it is not an option. */
  | "too-large"
  /** Would have fit on its own, but the run's total attachment budget was already spent. */
  | "budget-exhausted"
  /** Not on disk — the ordinary case is a file the diff DELETES. */
  | "absent"
  /** A directory, symlink, socket, FIFO — anything whose bytes are not the file's content. */
  | "not-a-regular-file"
  /** Binary, or not decodable as UTF-8. Never rendered as replacement characters. */
  | "not-text"
  /** Present, but could not be read or could not be proven to live inside the worktree. */
  | "unreadable";

export interface AttachedFile {
  /** Worktree-relative, `/`-separated — the same key the diff headers use. */
  path: string;
  /** Byte length of `content` as UTF-8. */
  bytes: number;
  /** The file's COMPLETE current content. Never a prefix, never a summary. */
  content: string;
}

export interface OmittedFile {
  path: string;
  reason: OmissionReason;
  /** Size in bytes when it is known (`too-large`, `budget-exhausted`), else `null`.
   *  `null` means "not known", never "zero" — an empty file is attachable and is
   *  attached, with `bytes: 0`. */
  bytes: number | null;
}

export interface CriticEvidence {
  attached: AttachedFile[];
  omitted: OmittedFile[];
  /**
   * `adr/007`: every path this change touches matched an operator-declared documentation
   * path (`contract.docPaths`). The prompt renders its leniency section only when this
   * is `true`, so the determination is the HARNESS's and the model never sees the
   * question — only the answer.
   *
   * Computed by `isDeclaredDocsOnlyChange` from the diff's own file list, NOT from
   * `attached`/`omitted` above. Those two are a budget-limited *view* of the change
   * and `collectCriticEvidence` drops blank entries before building them, so deriving
   * the flag from them would let a change qualify on the strength of a file list it
   * had not actually read in full.
   */
  declaredDocsOnly: boolean;
}

/** One touched file as the PLANNER sees it: a size, or an already-settled omission.
 *  Deliberately NOT the content — see `planEvidence` for why the plan is made from
 *  sizes and the reading happens afterwards. */
export type EvidenceEntry =
  | { path: string; kind: "sized"; bytes: number }
  | { path: string; kind: "omit"; reason: OmissionReason; bytes: number | null };

/** A file the plan says to read, and the EXACT size it was planned at. */
export interface PlannedRead {
  path: string;
  bytes: number;
}

export interface EvidencePlan {
  read: PlannedRead[];
  omitted: OmittedFile[];
}

export interface EvidenceLimits {
  perFileBytes: number;
  totalBytes: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  perFileBytes: MAX_EVIDENCE_BYTES_PER_FILE,
  totalBytes: MAX_EVIDENCE_BYTES_TOTAL,
};

/**
 * PURE budget pass: from the SIZES of the touched files, decide which to read and
 * which to omit.
 *
 * Split out from the filesystem glue below and exported so the whole decision — the
 * part that can actually be wrong — is testable on plain values, with no tmp dirs and
 * no platform behaviour in the way.
 *
 * **It plans from sizes, not from content, and that is the point** (codex R1 finding
 * 1). An earlier version read every touched file first and applied the total budget
 * afterwards: correct output, but it held every file in memory to then discard most
 * of them, so a task touching thousands of files loaded gigabytes to send 256 KB. The
 * budget has to be decided before the bytes are loaded, which means it has to be
 * decided from `lstat`, which is what this function consumes.
 *
 * Deliberate choices:
 *
 *  - **Entries are sorted by path** so the same task produces the same evidence set
 *    every run — an unstable set would make two corpus runs incomparable, and
 *    comparing runs is the entire point of the corpus.
 *  - **A file that does not fit the remaining total does not stop the scan.** Later,
 *    smaller files are still considered. Stopping at the first overflow would waste
 *    budget for no gain; the cost is that "budget-exhausted" is a statement about
 *    THAT file, not about everything after it, which is what the reason says.
 *  - **A duplicate path THROWS.** Real git never emits one, so a duplicate means the
 *    input is not what this function was told it is — and silently keeping "the
 *    first" would attach one version of a file while the diff shows another. The
 *    caller turns a throw into "no evidence at all", which is today's behaviour and
 *    therefore safe (`docs/gotchas/boolean-whose-no-means-two-things.md`: refuse a
 *    combination you cannot explain rather than pick one).
 *  - **This is the ONLY place a budget is applied.** The reader below does not
 *    re-budget; it either honours the plan exactly or omits the file. Two budgeting
 *    sites would be the same defect shape this repo keeps paying for
 *    (`docs/gotchas/validated-one-string-used-another.md`).
 */
export function planEvidence(
  entries: EvidenceEntry[],
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): EvidencePlan {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) {
      throw new Error(
        `planEvidence: duplicate path ${JSON.stringify(e.path)} in the candidate set -- refusing to guess ` +
          `which version of the file the diff refers to`,
      );
    }
    seen.add(e.path);
  }

  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const read: PlannedRead[] = [];
  const omitted: OmittedFile[] = [];
  let spent = 0;

  for (const e of ordered) {
    if (e.kind === "omit") {
      omitted.push({ path: e.path, reason: e.reason, bytes: e.bytes });
      continue;
    }
    if (e.bytes > limits.perFileBytes) {
      omitted.push({ path: e.path, reason: "too-large", bytes: e.bytes });
      continue;
    }
    if (spent + e.bytes > limits.totalBytes) {
      omitted.push({ path: e.path, reason: "budget-exhausted", bytes: e.bytes });
      continue;
    }
    read.push({ path: e.path, bytes: e.bytes });
    spent += e.bytes;
  }

  return { read, omitted };
}

/** Injectable filesystem seam — the real implementations are the module defaults. */
export interface EvidenceReaderDeps {
  /** Resolve-and-contain check: is `candidate` really inside `root`? */
  contains: (root: string, candidate: string) => Promise<boolean>;
}

const DEFAULT_READER_DEPS: EvidenceReaderDeps = { contains: realpathContains };

/**
 * Measure one touched file into a plan entry. NEVER throws: every failure becomes an
 * omission with its own reason, because a single unreadable file must not cost the
 * critic the evidence for all the others.
 *
 * Note it does NOT apply the size budget — that is `planEvidence`'s single job. This
 * function only answers "does this path name a readable regular file inside the
 * worktree, and how big is it".
 */
async function measureCandidate(
  root: string,
  relPath: string,
  deps: EvidenceReaderDeps,
): Promise<EvidenceEntry> {
  const full = resolve(root, relPath);

  // ORDER: existence first, containment second. `realpathContains` cannot resolve a
  // path that is not there and answers `false` for it -- so asking it first would
  // report every file the diff DELETES (the ordinary case for a deletion hunk) as
  // "unreadable" rather than "absent", which is precisely the collapse of two
  // different facts into one answer that this module refuses to make elsewhere.
  let lst;
  try {
    lst = await lstat(full);
  } catch (err) {
    // ENOENT/ENOTDIR is the ordinary case of a file the diff DELETES -- a real,
    // reportable fact. Every other errno (EACCES, ELOOP, EIO) is a genuine "could
    // not determine", and must not be folded into "the file is gone": the critic
    // would read a deleted file very differently from an unreadable one.
    const code = (err as NodeJS.ErrnoException).code;
    const reason: OmissionReason = code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
    return { path: relPath, kind: "omit", reason, bytes: null };
  }
  // `lstat` does not follow links, so a symlink lands here, not on its target.
  if (!lst.isFile()) {
    return { path: relPath, kind: "omit", reason: "not-a-regular-file", bytes: null };
  }

  // A path arriving from `git diff --name-only` cannot escape the worktree by its own
  // text, but an intermediate SYMLINKED ANCESTOR can put the real bytes outside it --
  // and those bytes would then be handed to the critic as if they were this task's
  // code. `realpathContains` answers `false` for BOTH "outside the root" and "could
  // not resolve"; that ambiguity is normally a defect (`docs/gotchas/boolean-whose-no-
  // means-two-things.md`) and is safe HERE, and only here, because both meanings map
  // to the same conservative action -- do not attach. The reason stays the unspecific
  // `unreadable` for the same reason: naming which of the two happened would be a
  // fabrication.
  //
  // ACCEPTED RESIDUAL (codex R1 finding 3, declined with rationale): an ancestor
  // directory swapped for a symlink BETWEEN this check and the `open` below would
  // still be followed, because `O_NOFOLLOW` guards only the final component. Closing
  // it needs `openat2(RESOLVE_BENEATH)`, which Node does not expose portably -- the
  // identical residual is already accepted at the harness's other containment site
  // (`docs/gotchas/static-file-serving-symlink-traversal.md`). It is also not
  // reachable from the worker: evidence is collected inside the conductor's
  // single-threaded iteration, AFTER the worker process has exited and after the
  // dirty-file fence has already run, so no writer is racing this read.
  //
  // The call is WRAPPED because `contains` is an injected seam, and a seam that
  // rejects would otherwise abort the whole collection from inside a function
  // documented as never-throwing -- the `[ts/fail-closed]` shape, where the guard
  // exists but the path around it does not have one (codex R2 finding 2). A rejection
  // is a "could not determine", which lands on the same conservative answer as
  // "outside the root".
  let contained: boolean;
  try {
    contained = await deps.contains(root, full);
  } catch {
    contained = false;
  }
  if (!contained) {
    return { path: relPath, kind: "omit", reason: "unreadable", bytes: null };
  }

  return { path: relPath, kind: "sized", bytes: lst.size };
}

/**
 * Read one PLANNED file, whole. NEVER throws, and never returns a partial file.
 *
 * Two refusals here are load-bearing, both from codex R1 finding 2:
 *
 *  - A single `fh.read` is not guaranteed to return the whole file, so the bytes are
 *    read in a LOOP. The earlier version treated a short read as the complete file --
 *    which would have handed the critic a silent prefix labelled "complete", the exact
 *    false-`broken` this module's no-truncation rule exists to prevent.
 *  - If the file's size no longer matches the size it was PLANNED at, it is omitted
 *    rather than re-budgeted. Re-budgeting here would put a second budget decision
 *    outside `planEvidence`, and the whole point of planning from sizes is that the
 *    budget is decided in exactly one place.
 */
async function readPlanned(
  root: string,
  planned: PlannedRead,
): Promise<{ path: string; content: string } | OmittedFile> {
  const full = resolve(root, planned.path);
  const omit = (reason: OmissionReason, bytes: number | null = null): OmittedFile => ({
    path: planned.path,
    reason,
    bytes,
  });

  let fh;
  try {
    fh = await open(full, READ_NO_FOLLOW_FLAGS);
  } catch {
    // ELOOP (a symlink swapped in after the lstat, POSIX) or a raced delete.
    return omit("unreadable");
  }
  try {
    // Re-stat on the SAME descriptor, closing the lstat->read TOCTOU.
    const st = await fh.stat();
    if (!st.isFile()) return omit("not-a-regular-file");
    if (st.size !== planned.bytes) return omit("unreadable", st.size);

    const buf = Buffer.alloc(planned.bytes);
    let got = 0;
    while (got < planned.bytes) {
      const { bytesRead } = await fh.read(buf, got, planned.bytes - got, got);
      if (bytesRead === 0) break; // EOF earlier than the size promised
      got += bytesRead;
    }
    if (got !== planned.bytes) return omit("unreadable", got);

    // A NUL byte is the conventional binary marker and is perfectly valid UTF-8, so
    // the strict decoder below would happily accept it and embed a control byte in
    // the prompt. Check it separately.
    if (buf.includes(0)) return omit("not-text", planned.bytes);

    let content: string;
    try {
      // `fatal: true` -- a lossy decode would silently replace undecodable bytes with
      // U+FFFD and hand the critic a file that differs from the one on disk. Refusing
      // to attach is honest; attaching an altered file is not.
      // `ignoreBOM: true` -- the DEFAULT decoder STRIPS a leading UTF-8 BOM (measured:
      // 4 bytes on disk decode to 1 character), which would both alter the attached
      // file and make its byte count disagree with the size the plan budgeted. The
      // BOM is part of the file; keep it.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return omit("not-text", planned.bytes);
    }
    // Defensive: the plan budgeted `planned.bytes`, and the prompt reports the same
    // number, so a decode that does not round-trip to it would mean the attachment
    // and the accounting describe different things. Valid UTF-8 always round-trips,
    // so this cannot fire today -- and if it ever does, refusing is the only honest
    // answer (`docs/gotchas/boolean-whose-no-means-two-things.md`: refuse a
    // combination you cannot explain).
    if (Buffer.byteLength(content, "utf8") !== planned.bytes) return omit("unreadable", planned.bytes);

    return { path: planned.path, content };
  } catch {
    return omit("unreadable");
  } finally {
    // A rejecting `close()` in a `finally` REPLACES the value the try/catch already
    // decided on and propagates out of a function documented as never-throwing --
    // the same `[ts/fail-closed]` shape as the `contains` seam above, and the reason
    // that gotcha says to guard the catch/finally too, not only the happy path
    // (codex R2 finding 2). The file has already been read; a failed close is a
    // descriptor-hygiene problem, not an evidence problem.
    await fh.close().catch(() => {});
  }
}

/**
 * Collect the critic's evidence set for one task: measure every path the diff covers,
 * plan against the budgets, then read only the files the plan selected.
 *
 * `relPaths` must be the file list of the SAME diff the critic will read (see
 * `diffFileNames` / `WorktreeManager.diffFiles`), or the attachments describe a
 * different change than the diff does.
 *
 * Blank paths are skipped outright rather than reported: `resolve(root, "")` returns
 * the ROOT DIRECTORY itself (`docs/gotchas/empty-path-resolves-to-repo-root.md`), so
 * a blank entry must never reach the reader, and there is nothing informative to tell
 * the critic about a path that does not name anything.
 */
export async function collectCriticEvidence(
  root: string,
  relPaths: string[],
  docPathGlobs: string[] = [],
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  deps: EvidenceReaderDeps = DEFAULT_READER_DEPS,
): Promise<CriticEvidence> {
  // `adr/007`, and it is deliberately computed from `relPaths` -- the diff's own file
  // list -- BEFORE the blank filter below. Deriving it from the attached/omitted lists
  // would ask the declaration to vouch for a set the blank filter had already pruned.
  const declaredDocsOnly = isDeclaredDocsOnlyChange(relPaths, docPathGlobs);

  const paths = relPaths.filter((p) => typeof p === "string" && p.trim() !== "");

  const entries: EvidenceEntry[] = [];
  for (const p of paths) entries.push(await measureCandidate(root, p, deps));

  const plan = planEvidence(entries, limits);

  const attached: AttachedFile[] = [];
  const omitted: OmittedFile[] = [...plan.omitted];
  for (const planned of plan.read) {
    const r = await readPlanned(root, planned);
    if ("content" in r) attached.push({ path: r.path, bytes: planned.bytes, content: r.content });
    else omitted.push(r);
  }

  // Both lists stay path-ordered even though read-time omissions arrive late, so the
  // prompt text for a given task is stable across runs.
  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { attached: attached.sort(byPath), omitted: omitted.sort(byPath), declaredDocsOnly };
}

/** One-line summary for the conductor log and the runtime manifest. */
export function summarizeEvidence(ev: CriticEvidence): string {
  const bytes = ev.attached.reduce((n, a) => n + a.bytes, 0);
  const omissions = ev.omitted.map((o) => `${o.path} (${o.reason})`).join(", ");
  return (
    `attached ${ev.attached.length} file(s), ${bytes} byte(s); omitted ${ev.omitted.length}` +
    (omissions.length > 0 ? ` -- ${omissions}` : "")
  );
}
