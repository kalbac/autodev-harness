import { copyFile, lstat, mkdir, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import { PURGED_SUBDIRS } from "./harness-state-reset.js";
import { isPathSafeId } from "../orchestrator/task-spec.js";

/**
 * Preserve ONE corpus case's blackboard artifacts before the next case purges them.
 *
 * A corpus run resets the blackboard at the start of every case
 * (`harness-state-reset.ts`), which is what keeps each case an independent measurement —
 * and also what made the first live run (s56) undiagnosable: by the time the report said
 * `escalated (uncertain)`, the `runtime/` directory holding the critic's verdict, the
 * worker's report and the gate feedback for that case had already been deleted, so every
 * failed case cost a manual re-run to understand. This module closes that: the artifacts
 * are copied out immediately before the purge that would destroy them.
 *
 * DIAGNOSTICS, NOT MEASUREMENT — the load-bearing distinction here. Nothing this module
 * produces feeds a metric or a verdict; the corpus's outcome is decided exclusively by the
 * `EvidenceRecord`s the executor reads. So an archiving failure must NEVER fail a case: it
 * would turn a working harness into a failed measurement for a reason that has nothing to
 * do with the harness. The caller therefore treats a throw from here as a logged warning
 * (see `harness-case-environment.ts`), which is the OPPOSITE of the fail-closed discipline
 * every measurement path in this codebase follows — and is correct precisely because this
 * path measures nothing.
 */

/** What gets archived, and the reason the list is not written out by hand: these are
 *  exactly the subdirectories the purge destroys, so a future entry added to the purge is
 *  archived automatically instead of being silently lost the first time someone extends
 *  one list and forgets the other. */
export const ARCHIVED_SUBDIRS = PURGED_SUBDIRS;

/** The conductor's log lives at the state directory's root and is NOT purged — it grows
 *  across the whole corpus run. Archiving it whole per case would give seven copies of one
 *  file and force the reader to find the relevant window themselves, so only the slice
 *  written DURING the case is kept. */
export const CONDUCTOR_LOG = "conductor.log";

/** The archived slice's filename inside a case's archive directory. */
export const ARCHIVED_LOG_SLICE = "conductor.log";

export interface ArchiveCaseRequest {
  /** Absolute path of the harness state directory (`<repo>/.autodev`) about to be purged. */
  stateDirAbs: string;
  /** Absolute path of the run's artifacts root; the case's directory is created under it. */
  artifactsRoot: string;
  /** The case id. Used VERBATIM as a directory name, so it must be a path-safe segment —
   *  guaranteed at the corpus-case schema, re-checked here at the point of use
   *  (docs/gotchas/validated-one-string-used-another.md). */
  caseId: string;
  /** Byte offset in `conductor.log` at which this case began, captured by the caller
   *  immediately before the case's reset. */
  logFromByte: number;
}

export interface ArchiveCaseResult {
  /** Absolute path of this case's archive directory. */
  dest: string;
  /** `/`-separated paths written, relative to `dest`, sorted. */
  copied: string[];
  /** Entries deliberately NOT copied, each with its reason. Returned rather than logged
   *  here so the caller decides how loud to be; an empty archive with an empty `skipped`
   *  means there was genuinely nothing to preserve. */
  skipped: string[];
}

/** `lstat`, mapping only a positive "no such path" to `null`. An EACCES/ELOOP is not
 *  evidence of absence (docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md). */
async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Remove a previous run's archive for this case, so what is on disk always describes
 * exactly the run that wrote it rather than a mixture of two. A reparse point is UNLINKED,
 * never recursed into — `rm -r` follows a Windows junction and deletes its real target
 * (docs/gotchas/win-git-worktree-remove-follows-junction.md).
 */
async function clearPreviousArchive(dest: string): Promise<void> {
  const st = await lstatOrNull(dest);
  if (st === null) return;
  if (st.isDirectory()) {
    await rm(dest, { recursive: true, force: true });
    return;
  }
  await unlink(dest);
}

/**
 * Copy a directory tree, skipping anything that is not a regular file or a directory.
 *
 * A skip rather than a throw, unlike the seed overlay's identical walk: the seed is
 * authored input whose integrity decides what a case even means, while this is a copy of
 * output the harness just produced — a socket or a stray link inside `runtime/` is worth
 * naming in `skipped`, not worth losing the other twenty files over.
 */
async function copyTree(srcRoot: string, destRoot: string, relPrefix: string, out: ArchiveCaseResult): Promise<void> {
  const entries = await readdir(srcRoot, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const rel = `${relPrefix}/${e.name}`;
    const src = join(srcRoot, e.name);
    const dest = join(destRoot, e.name);
    // `withFileTypes` reports the entry itself and does NOT follow links, so a symlink is
    // visible here instead of presenting as whatever it points at.
    if (e.isSymbolicLink()) {
      out.skipped.push(`${rel} (symlink -- not followed)`);
      continue;
    }
    if (e.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await copyTree(src, dest, rel, out);
      continue;
    }
    if (!e.isFile()) {
      out.skipped.push(`${rel} (not a regular file)`);
      continue;
    }
    await copyFile(src, dest);
    out.copied.push(rel);
  }
}

/**
 * Copy the tail of `conductor.log` written since the case began.
 *
 * If the file SHRANK below the recorded offset it was rotated or truncated mid-run, and
 * clamping the offset would silently archive an empty slice. A diagnostics artifact fails
 * toward MORE information, so the whole file is kept and the substitution is named in
 * `skipped` — an archive that quietly omits the log reads exactly like a case that
 * produced no log.
 */
async function copyLogSlice(src: string, dest: string, fromByte: number, out: ArchiveCaseResult): Promise<void> {
  const st = await lstatOrNull(src);
  if (st === null) return;
  if (!st.isFile()) {
    out.skipped.push(`${CONDUCTOR_LOG} (not a regular file)`);
    return;
  }

  const fh = await open(src, "r");
  try {
    const size = Number((await fh.stat()).size);
    let from = fromByte;
    if (!Number.isFinite(from) || from < 0) {
      out.skipped.push(`${CONDUCTOR_LOG} (invalid start offset ${fromByte} -- archived in full)`);
      from = 0;
    } else if (from > size) {
      out.skipped.push(`${CONDUCTOR_LOG} (truncated below the ${from}-byte start offset -- archived in full)`);
      from = 0;
    }
    const length = size - from;
    const buf = Buffer.alloc(length);
    if (length > 0) await fh.read(buf, 0, length, from);
    await writeFile(dest, buf);
    out.copied.push(ARCHIVED_LOG_SLICE);
  } finally {
    await fh.close();
  }
}

/**
 * Read `conductor.log`'s current size, to be handed back as `logFromByte` after the case
 * has run. Returns 0 when the log does not exist yet — the first case on a fresh state
 * directory legitimately has no log, and its whole log is then its own slice.
 */
export async function conductorLogOffset(stateDirAbs: string): Promise<number> {
  const st = await lstatOrNull(join(stateDirAbs, CONDUCTOR_LOG));
  return st !== null && st.isFile() ? Number(st.size) : 0;
}

/**
 * Archive one case's blackboard artifacts into `<artifactsRoot>/<caseId>/`.
 *
 * Validates WHERE it may write before writing anything, in the same shape as
 * `resetHarnessState`: an absolute, non-root artifacts root and a path-safe case id. Both
 * feed a recursive removal (of a previous run's archive for this case), and a removal at a
 * path assembled from an unvalidated segment is how a cleanup lands somewhere nobody named.
 */
export async function archiveCaseArtifacts(req: ArchiveCaseRequest): Promise<ArchiveCaseResult> {
  const { caseId } = req;
  if (!isPathSafeId(caseId)) {
    throw new Error(`corpus archive: case id ${JSON.stringify(caseId)} is not a path-safe segment`);
  }
  if (req.artifactsRoot.trim() === "" || !isAbsolute(req.artifactsRoot)) {
    throw new Error(`corpus archive: artifacts root ${JSON.stringify(req.artifactsRoot)} is not an absolute path`);
  }
  const artifactsRoot = resolve(req.artifactsRoot);
  if (parse(artifactsRoot).root === artifactsRoot) {
    throw new Error(`corpus archive: refusing to use the filesystem root '${artifactsRoot}' as the artifacts root`);
  }
  if (req.stateDirAbs.trim() === "" || !isAbsolute(req.stateDirAbs)) {
    throw new Error(`corpus archive: state directory ${JSON.stringify(req.stateDirAbs)} is not an absolute path`);
  }
  const stateDirAbs = resolve(req.stateDirAbs);

  const dest = join(artifactsRoot, caseId);
  // A path-safe id cannot escape, so this re-states the invariant at the point of use
  // rather than trusting where the value came from — the recurring defect shape of
  // docs/gotchas/validated-one-string-used-another.md.
  const rootPrefix = artifactsRoot.endsWith(sep) ? artifactsRoot : artifactsRoot + sep;
  /* c8 ignore next 3 */
  if (!dest.startsWith(rootPrefix)) {
    throw new Error(`corpus archive: '${caseId}' resolves outside the artifacts root ${artifactsRoot}`);
  }

  await clearPreviousArchive(dest);
  await mkdir(dest, { recursive: true });

  const out: ArchiveCaseResult = { dest, copied: [], skipped: [] };

  for (const sub of ARCHIVED_SUBDIRS) {
    const src = join(stateDirAbs, sub);
    const st = await lstatOrNull(src);
    if (st === null) continue;
    // `lstat` does not follow links, so a junctioned/symlinked `runtime` reports as a link
    // and NOT a directory here — which is what keeps the copy from walking through it.
    if (!st.isDirectory()) {
      out.skipped.push(`${sub} (not a real directory)`);
      continue;
    }
    await mkdir(join(dest, sub), { recursive: true });
    await copyTree(src, join(dest, sub), sub, out);
  }

  await copyLogSlice(join(stateDirAbs, CONDUCTOR_LOG), join(dest, ARCHIVED_LOG_SLICE), req.logFromByte, out);

  out.copied.sort();
  out.skipped.sort();
  return out;
}
