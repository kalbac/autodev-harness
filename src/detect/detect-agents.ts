/**
 * Read-only PATH-scan auto-detect of installed CLI coding agents. A pure,
 * injectable-deps module (mirrors `src/fsbrowse/fsbrowse.ts`'s shape). Resolution
 * only walks PATH directories checking for an EXECUTABLE FILE (PATHEXT-aware);
 * the version probe is the one place it spawns, best-effort under a kill deadline.
 *
 * Windows landmine `[node/win-cmd-spawn]`: a bare `existsSync(join(dir, "codex"))`
 * MISSES `codex.cmd` -> false "not installed". Detection MUST walk
 * `dirs x extensions` (PATHEXT on win32, a single empty extension on POSIX),
 * exactly like Open Design's `resolveOnPath`. And `existsSync` is TRUE for a
 * directory or a non-executable file of that name -> a false "installed"; so a
 * candidate counts only if it is a real file (and, on POSIX, `X_OK`-executable).
 */
import { statSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { runNative } from "../util/native.js";

export interface AgentModelOption {
  id: string;
  label?: string;
}

export interface AgentCatalogEntry {
  /** Stable identifier, e.g. "claude". */
  id: string;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Primary binary name to resolve on PATH. */
  bin: string;
  /** Alternate binary names tried (in order) if `bin` is not found. */
  fallbackBins?: string[];
  /** True ONLY for adapters with a live TS adapter (claude, codex). */
  supported: boolean;
  /** Static model catalog -- supported agents only. */
  models?: AgentModelOption[];
  /** Effort/reasoning levels -- only adapters that have the concept (e.g. codex). */
  efforts?: string[];
  /** Args used to probe the version; default `["--version"]`. */
  versionArgs?: string[];
  installUrl?: string;
}

export interface DetectedAgent {
  id: string;
  name: string;
  supported: boolean;
  /** Resolved on PATH. */
  available: boolean;
  /** Resolved absolute path (display/diagnostics); present iff `available`. */
  path?: string;
  /** Best-effort first stdout line of the version probe; present iff probed successfully. */
  version?: string;
  models?: AgentModelOption[];
  efforts?: string[];
  installUrl?: string;
}

export interface DetectAgentsDeps {
  /** Injectable for tests; default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; default `process.env.PATH` split on the platform delimiter. */
  pathDirs?: string[];
  /** Injectable for tests; default `process.env.PATHEXT` (win32 only). */
  pathext?: string;
  /** Injectable for tests; default `AGENT_CATALOG`. */
  catalog?: AgentCatalogEntry[];
  /**
   * Best-effort version probe; injectable for tests. Resolves `null` if not
   * invocable / no version. MUST never reject.
   */
  probeVersion?: (exePath: string, args: string[]) => Promise<string | null>;
}

/** Curated catalog of known CLI coding agents. Order is preserved in `detectAgents`'s output. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    fallbackBins: ["openclaude"],
    supported: true,
    models: [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
    ],
    installUrl: "https://docs.anthropic.com/claude-code",
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    supported: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
    ],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    installUrl: "https://developers.openai.com/codex/cli",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    supported: false,
    installUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "aider",
    name: "Aider",
    bin: "aider",
    supported: false,
    installUrl: "https://aider.chat/",
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    supported: false,
    installUrl: "https://opencode.ai/",
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    bin: "cursor-agent",
    supported: false,
    installUrl: "https://docs.cursor.com/cli",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    bin: "qwen",
    supported: false,
    installUrl: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "ollama",
    name: "Ollama",
    bin: "ollama",
    supported: false,
    installUrl: "https://ollama.com/",
  },
  {
    // Kilo Code (a Cline/Roo-family agent) -- CLI binary name not fully settled;
    // try `kilocode` then `kilo`. Detection just reports presence, so a wrong
    // guess only shows "not detected" until corrected.
    id: "kilocode",
    name: "Kilo Code",
    bin: "kilocode",
    fallbackBins: ["kilo"],
    supported: false,
    installUrl: "https://kilocode.ai/",
  },
];

/** PATHEXT-aware extension list: real extensions on win32, a single empty
 *  extension (bare name) elsewhere. */
export function computeExts(platform: NodeJS.Platform, pathext: string | undefined): string[] {
  if (platform !== "win32") return [""];
  const raw = pathext ?? process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT";
  const exts = raw.split(";").filter((e) => e.length > 0);
  return exts.length > 0 ? exts : [".EXE", ".CMD", ".BAT"];
}

export function defaultPathDirs(platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0);
}

/** True iff `p` is a real FILE and (on POSIX) is `X_OK`-executable. On win32 a
 *  PATHEXT match already implies "executable", so a real file is enough. Guards
 *  against `existsSync` returning true for a same-named directory / non-exec file. */
function isExecutableFile(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk `dirs x exts`, returning the first ABSOLUTE path that is an executable
 *  file. `resolve` (not `join`) guarantees an absolute result even for a relative
 *  PATH entry. */
function resolveOnPath(bin: string, dirs: string[], exts: string[], platform: NodeJS.Platform): string | null {
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(dir, bin + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Resolve the first of `names` (primary bin, then fallbacks, in order) found on PATH. */
export function resolveBinary(names: string[], dirs: string[], exts: string[], platform: NodeJS.Platform): string | null {
  for (const name of names) {
    const found = resolveOnPath(name, dirs, exts, platform);
    if (found !== null) return found;
  }
  return null;
}

/** Default version probe: `runNative` under a 3s kill deadline (the child is
 *  reaped on timeout, not leaked — see `NativeOptions.timeoutMs`). `runNative`
 *  rejects on spawn ENOENT, caught here. MUST never reject. */
export async function defaultProbeVersion(exePath: string, args: string[]): Promise<string | null> {
  try {
    const result = await runNative(exePath, args, { timeoutMs: 3000 });
    const firstLine = result.stdout.trim().split(/\r?\n/)[0];
    return firstLine !== undefined && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

/**
 * Probe PATH for every entry in the catalog (default `AGENT_CATALOG`).
 * Catalog order is preserved in the returned array. Each entry's resolution +
 * version probe runs concurrently; a throwing probe for ONE agent degrades
 * that agent's `version` to omitted -- it never collapses the batch.
 */
export async function detectAgents(deps: DetectAgentsDeps = {}): Promise<DetectedAgent[]> {
  const platform = deps.platform ?? process.platform;
  const catalog = deps.catalog ?? AGENT_CATALOG;
  const pathDirs = deps.pathDirs ?? defaultPathDirs(platform);
  const exts = computeExts(platform, deps.pathext);
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;

  return Promise.all(
    catalog.map(async (entry): Promise<DetectedAgent> => {
      const names = [entry.bin, ...(entry.fallbackBins ?? [])];
      const resolved = resolveBinary(names, pathDirs, exts, platform);

      const base: DetectedAgent = {
        id: entry.id,
        name: entry.name,
        supported: entry.supported,
        available: resolved !== null,
        ...(entry.models !== undefined ? { models: entry.models } : {}),
        ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
        ...(entry.installUrl !== undefined ? { installUrl: entry.installUrl } : {}),
      };

      if (resolved === null) return base;

      let version: string | null;
      try {
        version = await probeVersion(resolved, entry.versionArgs ?? ["--version"]);
      } catch {
        // Contract: probeVersion must never reject, but a single bad injected
        // probe (e.g. in tests) must never collapse the whole detection batch.
        version = null;
      }

      return {
        ...base,
        path: resolved,
        ...(version !== null ? { version } : {}),
      };
    }),
  );
}
