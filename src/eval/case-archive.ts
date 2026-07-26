import { copyFile, lstat, mkdir, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import { PURGED_SUBDIRS } from "./harness-state-reset.js";
import { isCorpusCaseId } from "./corpus-case.js";
import { safeErrorText, safeLog } from "../util/safe-log.js";

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

/**
 * What happened to one case's artifact archive. `failed` is load-bearing: it tells the reader
 * that whatever sits in this case's archive directory is NOT this run's diagnostics.
 *
 * Deliberately carries NO path. An earlier version did, and it was both redundant and unsafe:
 * the manifest already names `artifacts_dir` plus the per-case segment (a third copy is a
 * third thing that can disagree), and the failure branch had to build that path from a
 * `caseId` the archive may have just REJECTED as unsafe -- reporting a path outside the
 * artifacts root in the very status that says the write did not happen (codex R3). Dropping
 * the field deletes the problem instead of patching it.
 */
export interface CaseArchiveStatus {
  status: "ok" | "failed";
  copied: number;
  skipped: string[];
  error: string | null;
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
  // The SAME predicate the corpus-case schema enforces, not a weaker approximation of it:
  // this barrier used to check only path-safety while the schema also refused a trailing dot,
  // so a direct caller could hand it `case.` after `case` and clear the wrong archive
  // (codex R4).
  if (!isCorpusCaseId(caseId)) {
    throw new Error(
      `corpus archive: case id ${JSON.stringify(caseId)} is not a usable directory name ` +
        `(path-safe, 1-64 chars, not ending in a dot)`,
    );
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
  // The SECOND barrier, and it is genuinely reachable — do not mark it unreachable.
  // `isPathSafeId` admits `"."`, for which `join(root, ".")` collapses to `root` ITSELF;
  // without this check `clearPreviousArchive` would then recursively delete every case's
  // archive and the manifest with them (codex R1). The corpus-case schema now refuses a
  // dot-only id at the entry point, which is the real fix — this stays as the barrier for
  // any future caller that does not come through that schema, and is tested directly.
  const rootPrefix = artifactsRoot.endsWith(sep) ? artifactsRoot : artifactsRoot + sep;
  if (!dest.startsWith(rootPrefix)) {
    throw new Error(
      `corpus archive: case id ${JSON.stringify(caseId)} does not name a directory inside the artifacts ` +
        `root ${artifactsRoot} (it resolves to ${dest})`,
    );
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

/**
 * Archive one case and report WHAT HAPPENED, in that order, with neither step able to
 * corrupt the other. Extracted from the harness environment specifically because the
 * ordering is the fix for a defect the critic found twice (R1, then a narrower version in
 * R2), and a fix that lives only in untested integration glue is a fix nobody can prove:
 *
 *  - the outcome is DECIDED first and REPORTED second, so a throwing sink cannot make a
 *    successful archive read as `failed`;
 *  - the sink is invoked inside its own guard, so a throw from it neither propagates nor
 *    leaves the status unreported (which would read as "this case never archived");
 *  - it NEVER throws, because nothing here measures anything — the caller's own swallow
 *    remains as a backstop, not as the only line of defence.
 *
 * Returns the status it reported, so a caller (and a test) can assert on it directly.
 */
export async function archiveAndReport(
  req: ArchiveCaseRequest,
  deps: {
    archive: (req: ArchiveCaseRequest) => Promise<ArchiveCaseResult>;
    report?: (status: CaseArchiveStatus) => void;
    log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
  },
): Promise<CaseArchiveStatus> {
  const { caseId } = req;
  let status: CaseArchiveStatus;
  try {
    const archived = await deps.archive(req);
    safeLog(deps.log, "INFO", `corpus case '${caseId}': archived ${archived.copied.length} artifact(s) to ${archived.dest}`);
    // A skip is logged as loudly as a failure: an archive that quietly omitted something
    // reads exactly like a case that never produced it.
    if (archived.skipped.length > 0) {
      safeLog(
        deps.log,
        "WARN",
        `corpus case '${caseId}': archive skipped ${archived.skipped.length}: ${archived.skipped.join("; ")}`,
      );
    }
    status = { status: "ok", copied: archived.copied.length, skipped: archived.skipped, error: null };
  } catch (err) {
    const detail = safeErrorText(err);
    safeLog(deps.log, "WARN", `corpus case '${caseId}': archiving failed (ignored): ${detail}`);
    status = { status: "failed", copied: 0, skipped: [], error: detail };
  }

  try {
    deps.report?.(status);
  } catch (err) {
    safeLog(
      deps.log,
      "WARN",
      `corpus case '${caseId}': reporting the archive status failed (ignored): ${safeErrorText(err)}`,
    );
  }
  return status;
}
