import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * Read-only open flags that do NOT follow a final-component symlink on POSIX
 * (`O_NOFOLLOW` -> `ELOOP`). Windows has no reliable `O_NOFOLLOW`, so it opens
 * normally there -- a STATIC symlink is still caught by the caller's `lstat`/
 * `fstat` `isFile()` guard, and concurrent symlink creation on Windows is
 * privilege-gated. Reading from this one fd (fstat + read on the same handle)
 * also closes the `stat`->`read` TOCTOU where a file is swapped after the check.
 */
export const READ_NO_FOLLOW_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * Hard cap on how many bytes of an agent-written artifact are read into memory.
 * Runtime files, reports and gate verdicts are written by agents and can grow
 * large; read a bounded amount rather than loading an unbounded file whole.
 */
export const MAX_BOUNDED_READ_BYTES = 1_000_000;

/**
 * Best-effort bounded read of one file's full text content, TOCTOU-hardened: a
 * cheap `lstat` pre-check rejects a static symlink / dir up front, then a single
 * no-follow fd is opened and BOTH the size check (`fstat` on that handle) and the
 * read happen on it -- closing the lstat->read TOCTOU. Returns `null` (never
 * throws) for a missing / non-file / oversized file or a raced symlink swap;
 * callers treat `null` uniformly as "this file doesn't exist; try elsewhere / 404".
 *
 * Lives in `util/` rather than in the HTTP layer because the composition root
 * reads the same class of artifact (the stored execution report) and must do it
 * with the same hardening -- a second, softer reader is how two behaviours for one
 * read appear (docs/gotchas/validated-one-string-used-another.md).
 */
export async function readBoundedFileText(path: string, maxBytes: number): Promise<string | null> {
  let lst;
  try {
    lst = await lstat(path);
  } catch {
    return null;
  }
  if (!lst.isFile()) return null;

  let fh: FileHandle;
  try {
    fh = await open(path, READ_NO_FOLLOW_FLAGS);
  } catch {
    // ELOOP (symlink swapped in after the lstat, POSIX) or a raced delete.
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
