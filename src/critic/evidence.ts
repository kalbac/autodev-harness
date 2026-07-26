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
import { extname, resolve } from "node:path";
import { READ_NO_FOLLOW_FLAGS } from "../util/bounded-read.js";
import { realpathContains } from "../util/path-contain.js";

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
 * File extensions that carry PROSE and nothing a machine executes. Deliberately short:
 * every extension here is one whose contents no toolchain in this project runs, and
 * anything not listed is treated as code (fail-closed — an unknown extension is an
 * unknown risk, not a safe one).
 */
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc", ".asciidoc"]);

/**
 * Does this change touch ONLY prose?
 *
 * This exists because `adr/007` narrows what the critic may reject for a change that
 * contains no executable code — and the FIRST version of that narrowing left the
 * boundary to the critic's own judgment ("this applies only when the changed files
 * contain no executable code"). The review gate called that a blocker, correctly: in a
 * project whose entire thesis is that the enforcement decision must not be an LLM's
 * (Principles 1 and 3), the question "does this change get leniency" is exactly the
 * kind that must be answered by code the model cannot argue with.
 *
 * So the harness decides, and the prompt is only *told* the answer. Two mechanical
 * conditions, both required:
 *
 *  1. **Every changed path has a prose extension.** An empty path set is NOT prose-only
 *    — "I do not know what changed" must never buy leniency.
 *  2. **No added line opens a fenced block.** This closes the review gate's concrete
 *    counter-example: a Markdown file whose fenced shell block a CI step executes is a
 *    code change wearing a `.md` extension. Refusing every fenced addition is blunter
 *    than the real question ("does anything run this?") — which is not decidable here —
 *    and blunt in the safe direction.
 *
 * Named residual, not closed: a `.md` that some pipeline reads as data (a checklist a
 * script parses, a table a generator consumes) is still treated as prose. The operator's
 * lever for that is `adr/006` — declare it in `constitutionPaths` and the oracle fence
 * protects it outright, which is a stronger guarantee than anything the critic could give.
 */
export function isProseOnlyChange(paths: string[], diff: string): boolean {
  const real = paths.filter((p) => typeof p === "string" && p.trim() !== "");
  if (real.length === 0) return false;
  for (const p of real) {
    if (!PROSE_EXTENSIONS.has(extname(p).toLowerCase())) return false;
  }
  // `+++ b/<path>` is a file header, not content; `+` alone is an added line. A fence
  // may be indented inside a list, so the check is on the trimmed body.
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const body = line.slice(1).trim();
    if (body.startsWith("```") || body.startsWith("~~~")) return false;
  }
  return true;
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
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  deps: EvidenceReaderDeps = DEFAULT_READER_DEPS,
): Promise<CriticEvidence> {
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
  return { attached: attached.sort(byPath), omitted: omitted.sort(byPath) };
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
