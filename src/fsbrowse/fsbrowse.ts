/**
 * Server-side folder browser for the New Project flow (spec §3e). Directories
 * ONLY — file names are never listed. Hardening per `[api/static-traversal]`:
 * the requested path is canonicalized via `realpath` before listing; a symlink/
 * junction entry is never followed silently — it is included ANNOTATED
 * (`isSymlink: true`) with `path` = its resolved REAL target, so navigation
 * always continues on canonical paths. Trust model (spec §3e): full-disk
 * directory-NAME browsing is by design — the daemon is a localhost,
 * single-operator tool bound to loopback that already runs workers with the
 * operator's rights.
 */
import { readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface FsDirEntry {
  name: string;
  /** Absolute path for the next `?path=` request. For a symlink/junction this is the resolved REAL target. */
  path: string;
  /** Has a `.git` entry (dir or file — worktrees/submodules use a `.git` file). */
  isGitRepo: boolean;
  isRegistered: boolean;
  /** Present (true) only when the entry is a symlink/junction whose target is a directory. */
  isSymlink?: boolean;
}

export type FsDirsResult =
  | { ok: true; path: string | null; parent: string | null; entries: FsDirEntry[] }
  | { ok: false; code: "invalid_path"; message: string };

export interface FsBrowseDeps {
  /** Registry membership check for the `isRegistered` badge (canonical-path compare). */
  isRegistered(absPath: string): Promise<boolean>;
  /** Roots for the no-path view. Default: A:–Z: drive scan on win32; unused elsewhere. */
  listRoots?: () => Promise<string[]>;
  /** Injectable for tests; default `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Drive scan: existsSync per letter — cheap, no child process, no WMI. */
async function defaultListRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (let c = 0x41; c <= 0x5a; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/** Curated win32 system dir names that are not dot/$ prefixed. */
const WIN32_SYSTEM_DIRS = new Set(["System Volume Information", "$Recycle.Bin", "Config.Msi", "Recovery"]);

/** Protection-from-mistakes (NOT a security boundary): dot-dirs everywhere;
 *  `$`-prefixed + curated system dirs on win32. */
function isHiddenEntry(name: string, platform: NodeJS.Platform): boolean {
  if (name.startsWith(".")) return true;
  if (platform === "win32") {
    if (name.startsWith("$")) return true;
    if (WIN32_SYSTEM_DIRS.has(name)) return true;
  }
  return false;
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function annotate(
  name: string,
  absPath: string,
  isSymlink: boolean,
  deps: FsBrowseDeps,
): Promise<FsDirEntry> {
  return {
    name,
    path: absPath,
    isGitRepo: existsSync(join(absPath, ".git")),
    isRegistered: await deps.isRegistered(absPath),
    ...(isSymlink ? { isSymlink: true } : {}),
  };
}

/**
 * List the sub-directories of `rawPath` (absolute), or the roots view when
 * `rawPath` is undefined (win32: drive letters; POSIX: the contents of `/`).
 * Every failure of the WHOLE listing is a typed `invalid_path` (route → 400,
 * never 500 — spec §6); failures of a SINGLE entry skip that entry only.
 */
export async function listDirs(rawPath: string | undefined, deps: FsBrowseDeps): Promise<FsDirsResult> {
  const platform = deps.platform ?? process.platform;

  if (rawPath === undefined) {
    if (platform === "win32") {
      const roots = await (deps.listRoots ?? defaultListRoots)();
      const entries: FsDirEntry[] = [];
      for (const r of roots) {
        entries.push(await annotate(r, r, false, deps));
      }
      return { ok: true, path: null, parent: null, entries };
    }
    rawPath = "/";
  }

  if (!isAbsolute(rawPath)) {
    return { ok: false, code: "invalid_path", message: `path must be absolute: ${rawPath}` };
  }
  const canonical = await realpathSafe(rawPath);
  if (canonical === null) {
    return { ok: false, code: "invalid_path", message: `path does not exist or is not accessible: ${rawPath}` };
  }
  let st;
  try {
    st = await stat(canonical);
  } catch {
    return { ok: false, code: "invalid_path", message: `path is not accessible: ${rawPath}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, code: "invalid_path", message: `not a directory: ${rawPath}` };
  }

  let dirents;
  try {
    dirents = await readdir(canonical, { withFileTypes: true });
  } catch (err) {
    return { ok: false, code: "invalid_path", message: `cannot list directory: ${String(err)}` };
  }

  const entries: FsDirEntry[] = [];
  for (const d of dirents) {
    if (isHiddenEntry(d.name, platform)) continue;
    try {
      if (d.isDirectory()) {
        entries.push(await annotate(d.name, join(canonical, d.name), false, deps));
      } else if (d.isSymbolicLink()) {
        // Never follow silently (§3e): resolve the real target; include dir targets only, annotated.
        const target = await realpathSafe(join(canonical, d.name));
        if (target === null) continue; // dangling link
        const targetStat = await stat(target);
        if (!targetStat.isDirectory()) continue;
        entries.push(await annotate(d.name, target, true, deps));
      }
      // Anything else (file, fifo, socket): never listed.
    } catch {
      continue; // unreadable entry -> entry-level skip (§6)
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = dirname(canonical);
  return { ok: true, path: canonical, parent: parentDir === canonical ? null : parentDir, entries };
}
