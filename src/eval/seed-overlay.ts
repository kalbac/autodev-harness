import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * A corpus case's SEED is an overlay: a directory of files copied verbatim over the
 * target repo before the run, establishing the case's premise (the legacy file a bugfix
 * case must repair, the subtly-wrong helper an adversarial case plants for the gate to
 * catch). A case whose premise IS the pristine baseline ships an empty overlay.
 *
 * Everything here is fail-CLOSED, because a seed is authored data that lands, by
 * construction, OUTSIDE the repo it is copied into. The two escapes this module refuses
 * are the ones that have already bitten this codebase:
 *  - a SYMLINK inside the seed, or a symlinked destination already in the repo:
 *    `copyFile` follows both, so either would write through the link to a path the
 *    overlay never named (docs/gotchas/scaffold-symlink-escape.md, and its file-level
 *    sibling docs/gotchas/config-write-must-guard-the-file-not-just-its-parent-dir.md);
 *  - a relative path that climbs out of the repo root.
 * A refusal throws — a partially-applied seed would run the case against a premise
 * nobody authored.
 */

/** Present only to let git track an otherwise-empty seed directory; never copied. */
const SEED_PLACEHOLDER = ".gitkeep";

/**
 * Every file in `seedDir`, as `/`-separated paths relative to it, sorted. Directories
 * are walked; a symlink, device node, or anything else that is not a regular file makes
 * the whole seed unusable.
 */
export async function collectSeedFiles(seedDir: string): Promise<string[]> {
  const rootStat = await lstat(seedDir).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error(`seed '${seedDir}': not a directory (a seed is an overlay directory of files to copy)`);
  }

  const files: string[] = [];
  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const e of entries) {
      const rel = relPrefix === "" ? e.name : `${relPrefix}/${e.name}`;
      // `withFileTypes` reports the entry itself (it does NOT follow links), so a
      // symlink is visible here rather than silently presenting as its target.
      if (e.isSymbolicLink()) {
        throw new Error(`seed '${seedDir}': '${rel}' is a symlink -- a seed overlay may only contain regular files`);
      }
      if (e.isDirectory()) {
        await walk(join(dirAbs, e.name), rel);
        continue;
      }
      if (!e.isFile()) {
        throw new Error(`seed '${seedDir}': '${rel}' is not a regular file`);
      }
      if (e.name === SEED_PLACEHOLDER) continue;
      files.push(rel);
    }
  }
  await walk(seedDir, "");
  files.sort();
  return files;
}

/** `lstat`, mapping only a positive "no such path" to `null`. An EACCES/ELOOP is NOT
 *  evidence of absence and must propagate rather than read as "safe to create"
 *  (docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md). */
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
 * Refuse a destination whose ANCESTOR is a symlink, BEFORE anything is written. A leaf
 * check alone is not enough: `mkdir -p` and `copyFile` both walk through a symlinked
 * intermediate directory, so a repo containing `includes -> /outside` would take
 * `includes/x.php` straight out of the repo while the leaf itself looked fine — the same
 * last-segment-only blind spot as docs/gotchas/static-file-serving-symlink-traversal.md.
 * Walking the segments we are about to create is exact and needs no `realpath`: the first
 * ancestor that does not exist ends the walk (everything below it will be created as real
 * directories).
 */
async function assertNoSymlinkedAncestor(seedDir: string, rootResolved: string, rel: string): Promise<void> {
  const segments = rel.split("/");
  let cur = rootResolved;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = join(cur, segments[i]!);
    const st = await lstatOrNull(cur);
    if (st === null) return; // nothing exists from here down
    if (!st.isDirectory()) {
      throw new Error(`seed '${seedDir}': ancestor '${segments.slice(0, i + 1).join("/")}' of '${rel}' is not a real directory`);
    }
  }
}

/**
 * Copy every seed file into `repoRoot`, creating parent directories as needed, and
 * return the repo-relative paths written (sorted, `/`-separated — ready to hand to
 * `git add`). An empty seed writes nothing and returns `[]`, which the caller reads as
 * "run this case against the pristine baseline".
 */
export async function applySeedOverlay(seedDir: string, repoRoot: string): Promise<string[]> {
  const files = await collectSeedFiles(seedDir);
  const rootResolved = resolve(repoRoot);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;

  for (const rel of files) {
    const dest = resolve(rootResolved, rel);
    // The relative paths are built from our own walk, so they cannot contain `..` —
    // this re-checks the invariant at the point of USE rather than trusting where the
    // value came from (docs/gotchas/validated-one-string-used-another.md).
    if (!dest.startsWith(rootPrefix)) {
      throw new Error(`seed '${seedDir}': '${rel}' resolves outside the target repo`);
    }

    await assertNoSymlinkedAncestor(seedDir, rootResolved, rel);

    // Refuse to write THROUGH an existing symlink at the destination itself: `copyFile`
    // follows it, so a repo containing `wp-config.php -> /etc/passwd` would have the
    // seed land outside the repo entirely. Only an absent path or an existing regular
    // file is a legal destination.
    const existing = await lstatOrNull(dest);
    if (existing !== null && !existing.isFile()) {
      throw new Error(`seed '${seedDir}': destination '${rel}' exists and is not a regular file`);
    }

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(seedDir, rel), dest);
  }

  return files;
}
