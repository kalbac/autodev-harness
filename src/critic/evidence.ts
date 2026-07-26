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

/** One touched file, already read (or already known to be unreadable) — the input to
 *  the pure budget pass below. */
export type EvidenceCandidate =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "omit"; reason: OmissionReason; bytes: number | null };

export interface EvidenceLimits {
  perFileBytes: number;
  totalBytes: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  perFileBytes: MAX_EVIDENCE_BYTES_PER_FILE,
  totalBytes: MAX_EVIDENCE_BYTES_TOTAL,
};

/**
 * PURE budget pass: decide which candidates are attached and which are omitted.
 *
 * Split out from the filesystem glue below and exported so the whole decision — the
 * part that can actually be wrong — is testable on plain values, with no tmp dirs and
 * no platform behaviour in the way (`docs/gotchas/deterministic-real-clock-loop.md`
 * is the same lesson from the other direction).
 *
 * Deliberate choices:
 *
 *  - **Byte length is computed HERE, from the content**, never accepted from the
 *    caller. A size measured by `stat` and a size measured after decoding are two
 *    different numbers (BOM, CRLF, any lossy step), and budgeting against one while
 *    emitting the other is the exact validated-one-string/used-another shape this
 *    repo keeps paying for.
 *  - **Candidates are sorted by path** so the same task produces the same evidence
 *    set every run — an unstable set would make two corpus runs incomparable, and
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
 */
export function selectEvidence(
  candidates: EvidenceCandidate[],
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): CriticEvidence {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.path)) {
      throw new Error(
        `selectEvidence: duplicate path ${JSON.stringify(c.path)} in the candidate set -- refusing to guess ` +
          `which version of the file the diff refers to`,
      );
    }
    seen.add(c.path);
  }

  const ordered = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const attached: AttachedFile[] = [];
  const omitted: OmittedFile[] = [];
  let spent = 0;

  for (const c of ordered) {
    if (c.kind === "omit") {
      omitted.push({ path: c.path, reason: c.reason, bytes: c.bytes });
      continue;
    }
    const bytes = Buffer.byteLength(c.content, "utf8");
    if (bytes > limits.perFileBytes) {
      omitted.push({ path: c.path, reason: "too-large", bytes });
      continue;
    }
    if (spent + bytes > limits.totalBytes) {
      omitted.push({ path: c.path, reason: "budget-exhausted", bytes });
      continue;
    }
    attached.push({ path: c.path, bytes, content: c.content });
    spent += bytes;
  }

  return { attached, omitted };
}

/** Injectable filesystem seam — the real implementations are the module defaults. */
export interface EvidenceReaderDeps {
  /** Resolve-and-contain check: is `candidate` really inside `root`? */
  contains: (root: string, candidate: string) => Promise<boolean>;
}

const DEFAULT_READER_DEPS: EvidenceReaderDeps = { contains: realpathContains };

/**
 * Read one touched file into a candidate. NEVER throws: every failure becomes an
 * omission with its own reason, because a single unreadable file must not cost the
 * critic the evidence for all the others.
 */
async function readCandidate(
  root: string,
  relPath: string,
  perFileBytes: number,
  deps: EvidenceReaderDeps,
): Promise<EvidenceCandidate> {
  const full = resolve(root, relPath);

  // ORDER: existence first, containment second. `realpathContains` cannot resolve a
  // path that is not there and answers `false` for it -- so asking it first would
  // report every file the diff DELETES (the ordinary case for a deletion hunk) as
  // "unreadable" rather than "absent", which is precisely the collapse of two
  // different facts into one answer that this module refuses to make elsewhere.
  // Establishing "the file exists and is a regular file" first leaves containment
  // answering only the question it can actually answer.
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
  if (lst.size > perFileBytes) {
    // Refused before reading: there is no point loading 10 MB to then discard it.
    return { path: relPath, kind: "omit", reason: "too-large", bytes: lst.size };
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
  if (!(await deps.contains(root, full))) {
    return { path: relPath, kind: "omit", reason: "unreadable", bytes: null };
  }

  let fh;
  try {
    fh = await open(full, READ_NO_FOLLOW_FLAGS);
  } catch {
    // ELOOP (a symlink swapped in after the lstat, POSIX) or a raced delete.
    return { path: relPath, kind: "omit", reason: "unreadable", bytes: null };
  }
  try {
    // Re-stat and read on the SAME descriptor, closing the lstat->read TOCTOU, and
    // re-check the size: the file may have grown between the two stats.
    const st = await fh.stat();
    if (!st.isFile()) return { path: relPath, kind: "omit", reason: "not-a-regular-file", bytes: null };
    if (st.size > perFileBytes) return { path: relPath, kind: "omit", reason: "too-large", bytes: st.size };
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const bytes = buf.subarray(0, bytesRead);

    // A NUL byte is the conventional binary marker and is perfectly valid UTF-8, so
    // the strict decoder below would happily accept it and embed a control byte in
    // the prompt. Check it separately.
    if (bytes.includes(0)) {
      return { path: relPath, kind: "omit", reason: "not-text", bytes: bytes.byteLength };
    }
    let content: string;
    try {
      // `fatal: true` -- a lossy decode would silently replace undecodable bytes with
      // U+FFFD and hand the critic a file that differs from the one on disk. Refusing
      // to attach is honest; attaching an altered file is not.
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { path: relPath, kind: "omit", reason: "not-text", bytes: bytes.byteLength };
    }
    return { path: relPath, kind: "text", content };
  } catch {
    return { path: relPath, kind: "omit", reason: "unreadable", bytes: null };
  } finally {
    await fh.close();
  }
}

/**
 * Collect the critic's evidence set for one task: read every path the diff covers,
 * then apply the budgets.
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
  const candidates: EvidenceCandidate[] = [];
  for (const p of paths) {
    candidates.push(await readCandidate(root, p, limits.perFileBytes, deps));
  }
  return selectEvidence(candidates, limits);
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
