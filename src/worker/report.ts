/**
 * harvestWorkerReport: move the worker's report out of the worktree into the
 * runtime dir (parity: the report lives at runtime/<id>/worker-report.md, and
 * .autodev/runtime/ is in DirtyFenceIgnore, so it must not sit in the worktree
 * where the dirty-file fence would flag it as stray).
 */
import { mkdir, rename, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function harvestWorkerReport(worktreePath: string, runtimeDir: string): Promise<boolean> {
  const src = join(worktreePath, "worker-report.md");
  const dest = join(runtimeDir, "worker-report.md");
  await mkdir(runtimeDir, { recursive: true });

  // Clear any stale report from a prior critic-retry round or a prior claim of
  // this task id FIRST -- the runtime dir persists across both, so a leftover
  // report (e.g. `status: TOO_BIG`) would otherwise be re-read and mis-route
  // the task. After this unlink, an absent source guarantees an absent dest
  // (no carry-over).
  await rm(dest, { force: true });

  if (!existsSync(src)) return false;

  try {
    await rename(src, dest);
  } catch (err) {
    // Cross-device rename (e.g. worktree and runtime dir on different mounts)
    // -- fall back to copy + delete.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(src, dest);
      try {
        await rm(src);
      } catch (rmErr) {
        // Copy succeeded but we could not remove the worktree source. Roll the
        // dest back so we never leave BOTH a stale dest AND a live worktree
        // source (which the dirty-file fence would then flag as stray).
        await rm(dest, { force: true });
        throw rmErr;
      }
    } else {
      throw err;
    }
  }
  return true;
}
