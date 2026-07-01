import { existsSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Worker-report fencing — parity §5. The critic must never read the
 * worker's rationale (`worker-report.md`): for the duration of the codex
 * call, the file is physically moved OUTSIDE the repo tree (to `os.tmpdir()`)
 * and restored in a `finally` block, even if the callback throws. This is a
 * mechanical fence (combined with codex's read-only sandbox), not merely an
 * instruction.
 *
 * If `workerReportPath` is `null` or the file does not currently exist,
 * there is nothing to fence — `fn` just runs as-is.
 */
export async function withWorkerReportFenced<T>(
  workerReportPath: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (workerReportPath === null || !existsSync(workerReportPath)) {
    return fn();
  }

  const tempPath = join(tmpdir(), `adh-fenced-worker-report-${randomBytes(8).toString("hex")}.md`);

  await moveFile(workerReportPath, tempPath);
  try {
    return await fn();
  } finally {
    await moveFile(tempPath, workerReportPath);
  }
}

/** `rename` with a copy+unlink fallback for cross-device moves (EXDEV). */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(from, to);
      await unlink(from);
      return;
    }
    throw err;
  }
}
