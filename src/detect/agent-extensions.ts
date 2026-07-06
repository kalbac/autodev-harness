/**
 * Read-only, best-effort visibility probe: what does the WORKER `claude -p` child
 * inherit under the project's CURRENT saved isolation config? Spawns the real
 * `claude` in the project repoRoot with the effective isolation flags, STREAMS
 * stdout, captures the FIRST stream-json `system/init` event, then KILLS the child
 * before any model turn fires (zero model cost). Pure extraction (`extractExtensions`)
 * sits behind an injectable `SpawnInit` dep so it is testable WITHOUT a real spawn,
 * same never-throws shape as `detect-agents.ts`.
 *
 * The default `SpawnInit` mirrors `util/native.ts`'s SIGTERM→grace→SIGKILL kill
 * deadline + EPIPE stdin guard, but STREAMS line-by-line and kills EARLY on the
 * init event instead of buffering to `close`.
 */
import spawn from "cross-spawn";

/** Grace between SIGTERM and the escalated SIGKILL (POSIX; Windows kills forcefully
 *  on the first signal). Mirrors `util/native.ts`. */
const SIGKILL_GRACE_MS = 2000;

/** Default overall deadline for the streaming probe. The init event arrives well
 *  before any model turn, so this only bounds a hung/never-initializing child. */
const DEFAULT_TIMEOUT_MS = 20000;

/** Hard cap on the un-newlined stdout remainder. The init event is one modest
 *  line that arrives near-immediately, so a remainder that grows past this means
 *  a child streaming a huge line without a newline (real runaway or hostile) —
 *  bail out (null + kill) rather than let the buffer grow unbounded until the
 *  timeout. The `timeoutMs` deadline bounds it in TIME; this bounds it in MEMORY. */
export const MAX_REMAINDER_BYTES = 1_000_000;

/** A trivial prompt: the child never reaches a model turn (we kill on init), but
 *  `-p` still requires stdin, and closing it lets a read-to-EOF child proceed. */
const PROBE_PROMPT = "Reply with exactly: OK";

export interface McpServerStatus {
  name: string;
  status: string;
}

export interface AgentExtensions {
  /** `init.model` when present; OMITTED (exactOptional) when absent/non-string. */
  model?: string;
  /** The cwd the probe ran in — echoed from INPUT, never trusted from `init.cwd`. */
  cwd: string;
  /** `init.mcp_servers` -> `{name,status}`; entries lacking a string `name` dropped. */
  mcp: McpServerStatus[];
  /** `init.skills` (string entries only). */
  skills: string[];
  /** `init.slash_commands` (string entries only). */
  slashCommands: string[];
  /** `init.agents` (string entries only). */
  agents: string[];
}

/** Keep only string members of a possibly-malformed array field. */
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

/** Coerce `init.mcp_servers` into `{name,status}`. Requires a string `name`
 *  (else the entry is meaningless and is dropped); `status` defaults to
 *  `"unknown"` when missing/non-string. */
function toMcp(v: unknown): McpServerStatus[] {
  if (!Array.isArray(v)) return [];
  const out: McpServerStatus[] = [];
  for (const entry of v) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["name"] !== "string") continue;
    out.push({ name: rec["name"], status: typeof rec["status"] === "string" ? rec["status"] : "unknown" });
  }
  return out;
}

/**
 * Pure, defensive read of a `system/init` object into `AgentExtensions`. Every
 * field may be missing/malformed → default to `[]` (or omit `model`); NEVER throws.
 * `cwd` is echoed from the caller (the cwd the probe ran in), NOT read from
 * `init.cwd` (the CLI may report a normalized/different path).
 */
export function extractExtensions(init: unknown, cwd: string): AgentExtensions {
  const obj: Record<string, unknown> = init !== null && typeof init === "object" ? (init as Record<string, unknown>) : {};
  const model = typeof obj["model"] === "string" ? obj["model"] : undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    cwd,
    mcp: toMcp(obj["mcp_servers"]),
    skills: toStringArray(obj["skills"]),
    slashCommands: toStringArray(obj["slash_commands"]),
    agents: toStringArray(obj["agents"]),
  };
}

/**
 * The spawner seam: run the CLI and resolve the PARSED `system/init` object, or
 * `null` if none was seen. Injected in unit tests (a fixture object, or null); the
 * default is the streaming spawner below. MUST never reject.
 */
export type SpawnInit = (opts: { exe: string; cwd: string; args: string[]; stdin: string }) => Promise<unknown | null>;

export interface ProbeExtensionsInput {
  exe: string;
  cwd: string;
  model: string;
  isolationFlags: string[];
  /** Injected in tests; default is the real streaming spawner. */
  spawnInit?: SpawnInit;
  /** Overall deadline for the DEFAULT spawner (ignored by an injected one). */
  timeoutMs?: number;
}

/** Is this parsed line the stream-json `system/init` event? */
function isInitEvent(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  return o["type"] === "system" && o["subtype"] === "init";
}

/** The spawn primitive (cross-spawn's signature); injectable so the default
 *  spawner's streaming/kill/cap logic is unit-testable with a fake child. */
export type SpawnFn = typeof spawn;

/**
 * Default `SpawnInit`: spawn via cross-spawn (Windows `.cmd`-shim safe, see
 * `util/native.ts`), stream stdout, split on `\n`, JSON.parse each COMPLETE line,
 * and on the FIRST `system/init` event resolve THAT object and kill the child
 * (SIGTERM→grace→SIGKILL) — before any model turn. A partial-line remainder is
 * held across data chunks (the init line may arrive split) but capped at
 * `MAX_REMAINDER_BYTES` (a child streaming a huge un-newlined line bails to null +
 * kill instead of growing the buffer unbounded). If the child closes with no init
 * seen, resolve null. An overall `timeoutMs` deadline also resolves null (and reaps
 * the child). Resolves AT MOST once (settled flag); NEVER rejects — a synchronous
 * spawn/setup failure resolves null too, so the `SpawnInit` contract holds even in
 * isolation (not only via `probeAgentExtensions`'s outer guard). `spawnFn` is
 * injectable for tests; production uses cross-spawn.
 */
export function makeStreamingSpawnInit(timeoutMs: number, spawnFn: SpawnFn = spawn): SpawnInit {
  return ({ exe, cwd, args, stdin }) =>
    new Promise<unknown | null>((resolve) => {
      let settled = false;
      let remainder = "";

      let deadline: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
      };

      // Resolve the promise exactly once. Stops the timeout deadline, but does NOT
      // touch `killTimer`: a SIGKILL escalation already scheduled must still fire so
      // a child that ignores SIGTERM cannot leak — `killTimer` is cleared only when
      // the child's 'close'/'error' actually lands (clearTimers below).
      const settle = (value: unknown | null): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        resolve(value);
      };

      try {
        // `env: process.env` — same pass-through as native.ts/watchdog.ts: the probe
        // must see the SAME ambient config the real worker spawn would.
        const child = spawnFn(exe, args, { cwd, env: process.env });

        // SIGTERM, then escalate to SIGKILL after a grace — a child trapping SIGTERM
        // must still die (POSIX; on Windows the first signal already terminates).
        const killChild = (): void => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, SIGKILL_GRACE_MS);
        };

        deadline = setTimeout(() => {
          // Hung / never-initialized: give up (null) and reap the child.
          settle(null);
          killChild();
        }, timeoutMs);

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (settled) return;
          remainder += chunk;
          // The init event is one line but may arrive split across chunks; process
          // only COMPLETE lines and carry the trailing partial in `remainder`.
          let nl: number;
          while ((nl = remainder.indexOf("\n")) !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            if (line.length === 0) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue; // a non-JSON line (e.g. a log line) — keep scanning
            }
            if (isInitEvent(parsed)) {
              settle(parsed);
              killChild();
              return;
            }
          }
          // Un-newlined runaway: a child streaming a huge line without ever emitting
          // `\n` would grow `remainder` unbounded (a per-request memory-exhaustion
          // amplified across repeated endpoint hits). Bail once past the cap.
          if (remainder.length > MAX_REMAINDER_BYTES) {
            settle(null);
            killChild();
          }
        });

        // Spawn failure (ENOENT) and normal/early close both resolve null; the
        // settled guard makes the post-kill 'close' a no-op after an init hit.
        child.on("error", () => {
          clearTimers();
          settle(null);
        });
        child.on("close", () => {
          clearTimers();
          settle(null);
        });

        // EPIPE guard: a fast-exiting child can close its stdin read end before our
        // write lands (gotcha `[node/stdin-epipe]`) — swallow it, then close stdin so
        // a read-to-EOF child does not hang.
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdin);
      } catch {
        // A synchronous spawn/setup failure must NOT reject (SpawnInit contract).
        clearTimers();
        settle(null);
      }
    });
}

/**
 * Probe the worker's inherited extension set under `isolationFlags`. Builds the
 * `claude -p … stream-json` arg array, spawns (via `spawnInit`), and extracts the
 * captured init — or `null` when no init was seen. MUST never reject (wrapped).
 */
export async function probeAgentExtensions(input: ProbeExtensionsInput): Promise<AgentExtensions | null> {
  try {
    const spawnInit = input.spawnInit ?? makeStreamingSpawnInit(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const args = [
      "-p",
      "--model",
      input.model,
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "1",
      "--verbose",
      "--output-format",
      "stream-json",
      ...input.isolationFlags,
    ];
    const init = await spawnInit({ exe: input.exe, cwd: input.cwd, args, stdin: PROBE_PROMPT });
    if (init === null || init === undefined) return null;
    return extractExtensions(init, input.cwd);
  } catch {
    return null;
  }
}
