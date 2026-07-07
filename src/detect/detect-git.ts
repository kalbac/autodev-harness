/**
 * Read-only PATH-scan for the `git` binary + a best-effort version. Reuses the
 * PATHEXT-aware executable probe from `detect-agents` (the flip side of
 * `[node/win-cmd-spawn]`/`[detect/executable-probe]`): a bare `existsSync`
 * both misses `git.exe` and false-positives a same-named dir. Powers the New
 * Project screen's git-not-installed banner (spec §3c).
 */
import { computeExts, defaultPathDirs, defaultProbeVersion, resolveBinary } from "./detect-agents.js";

export interface DetectGitResult {
  installed: boolean;
  /** Best-effort first stdout line of `git --version`; present iff probed. */
  version?: string;
}

export interface DetectGitDeps {
  platform?: NodeJS.Platform;
  pathDirs?: string[];
  pathext?: string;
  /** Best-effort version probe; MUST never reject (default spawns `git --version`). */
  probeVersion?: (exePath: string, args: string[]) => Promise<string | null>;
}

export async function detectGit(deps: DetectGitDeps = {}): Promise<DetectGitResult> {
  const platform = deps.platform ?? process.platform;
  const pathDirs = deps.pathDirs ?? defaultPathDirs(platform);
  const exts = computeExts(platform, deps.pathext);
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;

  const resolved = resolveBinary(["git"], pathDirs, exts, platform);
  if (resolved === null) return { installed: false };

  let version: string | null;
  try {
    version = await probeVersion(resolved, ["--version"]);
  } catch {
    version = null;
  }
  return { installed: true, ...(version !== null ? { version } : {}) };
}
