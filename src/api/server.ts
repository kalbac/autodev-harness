/**
 * Thin `http` + `ws` server over `BlackboardRepository` -- the P2 seam
 * (plan Task 27). Deliberately kept read-only plus one reply endpoint for
 * P1: it does not claim, move, or write tasks, and it never adds methods
 * to `BlackboardRepository` (a frozen seam shared with the conductor's
 * test-fakes -- see `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`
 * Task 27). `digest.md` and `escalations/` are read/written directly under
 * `stateDir` via `node:fs/promises`, exactly like `src/index.ts` wires the
 * escalate module. The one deliberate exception: applying an escalation
 * reply moves the replied task out of `queue/escalated/` (A -> quarantine,
 * B -> pending) via `repo.moveTask`, to release its scheduler file-lock
 * (gotcha `[escalate/replied-holds-filelock]`).
 *
 * Escalation replies are a STRUCTURED A/B choice ONLY (parity spec §8): the
 * `choice` field is the sole executable signal this endpoint accepts. The
 * `note` free text is recorded to the reply file for operator CONTEXT ONLY
 * and MUST NEVER be surfaced to a worker as an instruction -- Telegram/API
 * reply is a named injection surface (parity spec §8, `src/escalate/escalate.ts`
 * buildBody's "Reply:" line carries the same warning).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { open, stat, lstat, realpath, writeFile, mkdir, readdir, type FileHandle } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { watch as chokidarWatch } from "chokidar";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";
import { parseEscalation } from "../escalate/escalate.js";
import type { RegisterInput, RegisterResult, RenameResult, ConfigUpdateResult } from "../registry/admin.js";
import type { FsDirsResult } from "../fsbrowse/fsbrowse.js";
import type { DetectedAgent } from "../detect/detect-agents.js";
import { buildRunUsageSummary, isTokenUsageDoc, type TokenUsageDoc } from "../usage/usage.js";

const QUEUE_STATES: readonly QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

/** How many trailing lines of `digest.md` are surfaced in `GET /state`. */
const DIGEST_TAIL_LINES = 50;

/**
 * Cap on how many trailing bytes of `digest.md` are read for the tail. `digest.md`
 * is append-only and grows unboundedly over a long conductor session; `/state` may
 * be polled frequently, so we read only the tail window from the end of the file
 * (positioned read) instead of loading the whole file into memory.
 */
const MAX_DIGEST_READ_BYTES = 64 * 1024;

/**
 * Hard cap on the `POST /escalations/:id/reply` body. The reply endpoint is a named
 * injection surface (parity spec §8) and `note` is free text -- an unbounded body is
 * both a memory-DoS and a `close()`-hang risk (a never-ending request keeps the
 * connection open, which `http.Server#close` waits on). Overflow -> 413 + socket
 * destroy.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Hard cap on how many bytes of a `GET /tasks/:id/runtime/:name` file are read into
 * memory. Runtime files (worker reports, gate verdicts) are written by agents and can
 * grow large; mirrors the digest-tail bounding philosophy above -- read only a bounded
 * prefix via a positioned read rather than loading an unbounded file whole. A file over
 * the cap is served truncated with `TRUNCATION_MARKER` appended, never a 500.
 */
const MAX_RUNTIME_FILE_READ_BYTES = 1_000_000;

/** Appended to a runtime file's content when it exceeds `MAX_RUNTIME_FILE_READ_BYTES`. */
const TRUNCATION_MARKER = "\n...[truncated]";

/**
 * Hard cap on a single static UI-bundle asset read (production-convenience serving,
 * `ApiServerDeps.uiDir`). Unlike the runtime-file endpoint, assets can be binary
 * (png/woff2), so an oversized file is never served truncated (that would silently
 * corrupt binary content) -- it is simply treated as unservable (404) and logged.
 * A few MB comfortably covers a built dashboard's JS/CSS chunks and small images.
 */
const MAX_STATIC_ASSET_READ_BYTES = 8 * 1024 * 1024;

/** Content-type by lowercased file extension for static UI-bundle assets. Unlisted
 *  extensions fall back to `application/octet-stream`. */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/**
 * Hard cap on a single `<stateDir>/runs/*.json` manifest read. A manifest is our own
 * small index ({runId,intent,taskIds,at}); a file over this cap is corrupt/hostile and
 * is SKIPPED (best-effort) rather than read whole -- bounding memory before `JSON.parse`
 * so `GET /runs` can never be OOM'd by a poisoned oversized manifest.
 */
const MAX_RUN_MANIFEST_BYTES = 256 * 1024;

/**
 * Hard cap on `GET /escalations/:id` reads of `<stateDir>/escalations/<id>.md` and
 * `<id>.reply.json`. Like `MAX_RUN_MANIFEST_BYTES`, both are our own small structured
 * writes (`buildBody`'s markdown / the reply JSON `handleReply` writes) -- a file over
 * this cap is corrupt/hostile and is treated as absent (-> 404), never truncated or
 * parsed.
 */
const MAX_ESCALATION_READ_BYTES = 256 * 1024;

/**
 * Soft cap on `POST /orchestrate`'s `intent` string, tighter than the 1MB
 * `MAX_BODY_BYTES` body cap. The body cap alone already bounds memory, but an
 * operator intent is meant to be a short instruction (a few sentences at
 * most) -- a multi-hundred-KB "intent" is almost certainly a mistake or abuse,
 * not a legitimate request, so it is rejected with a clear 400 rather than
 * silently accepted and handed to the LLM decomposer.
 */
const MAX_INTENT_LENGTH = 4000;

/** Signals that a request body exceeded `MAX_BODY_BYTES` (mapped to HTTP 413). */
class PayloadTooLargeError extends Error {}

/**
 * Positive allowlist for a bare id segment -- an escalation id, a task id (`:id` in
 * `/tasks/:id/runtime...`), or a run id (`:id` in `/runs/:id`). Real ids are
 * kebab/underscore slugs (e.g. `s7-t1-model-tiering`, `run-1234-build-the-thing`) or
 * `drift-<ms>` -- all within this set. Stricter than a traversal denylist: it also
 * blocks `:` (Windows alternate-data-stream syntax), control characters, and newlines
 * (log forging), which a `/`+`\`+`..`+NUL denylist would let through.
 */
const VALID_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Positive allowlist for a runtime file NAME (`:name` in `/tasks/:id/runtime/:name`).
 * Unlike a bare id, a runtime file name legitimately contains a `.` (`worker-report.md`,
 * `gate-verdict.json`), so the charset is widened to include it -- but `/`, `\`, `:`,
 * control chars, and newlines stay forbidden, and a name containing `..` anywhere
 * (e.g. `worker..report`, not just the bare `..` segment) is explicitly rejected so a
 * widened charset can't be abused for traversal.
 */
const VALID_RUNTIME_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** Curated, read-only projection of a project's HarnessConfig for the UI shell
 *  (top bar + inspector rail). A safe subset — no secrets live in config, but we
 *  still expose only what the shell renders rather than the whole object. */
export interface ProjectConfigView {
  stateDir: string;
  allowedBranchPattern: string;
  gate: { checkCommand: string | null };
  worktree: { provision: string[] };
  roles: {
    orchestrator: { adapter: string; model: string; effort?: string };
    worker: { adapter: string; ladder: string[] };
    critic: { adapter: string; model: string; effort: string };
    /** Present ONLY when the operator explicitly set `roles.planner` in the raw
     *  config (planner is optional — omitted, the orchestrator plans). Values are
     *  the resolved/defaulted ones, mirroring orchestrator. */
    planner?: { adapter: string; model: string; effort?: string };
  };
  /** Worker ambient-extension isolation, always projected as plain booleans
   *  (all false = current inherit-everything behavior). The UI renders these as
   *  the clean-room / MCP / skills toggles. */
  isolation: { worker: { cleanRoom: boolean; mcp: boolean; skills: boolean } };
  /** Wire-time policy toggles the UI shows read-only (not writable via the form). */
  policy: { heterogeneity: "warn" | "off" };
  /** The heterogeneity warnings the daemon computes at wire-time (empty when
   *  policy=off or worker/critic families differ) — the UI renders these verbatim. */
  heterogeneityWarnings: string[];
}

/** Per-project view the server needs — a narrow slice of the hub's ProjectRoot. */
export interface ProjectView {
  repo: BlackboardRepository;
  /** Absolute `<repoRoot>/<stateDir>` for this project. digest.md + escalations/ live under here. */
  stateDir: string;
  /**
   * OPTIONAL launcher for `POST /projects/:id/orchestrate` for THIS project.
   * When unset, that route -> 404 (read-only deployment). The callback receives
   * the operator intent and MUST only enqueue+trigger via the orchestrator (R1) --
   * the server never sees a gate/worker/critic/commit handle. It is invoked in the
   * BACKGROUND (202-async); its promise rejection is logged, never surfaced to the
   * already-sent response. R1-thin callback, unchanged semantics.
   */
  onOrchestrate?: (intent: string) => Promise<unknown>;
  /** OPTIONAL curated config for `GET /projects/:id/config`. Absent → that route 404s. */
  config?: ProjectConfigView;
}

export interface ApiServerDeps {
  projects: {
    /** Sidebar list: registry + build status. Must never throw (an empty daemon lists []). */
    list(): Promise<Array<{ id: string; name: string; path: string; status: string; error?: string }>>;
    /** Resolve one project. null = unknown id; {error} = registered but failed to build. */
    get(id: string): Promise<{ view: ProjectView } | { error: string } | null>;
  };
  /**
   * OPTIONAL absolute path to a built UI bundle dir (production convenience only --
   * dev mode runs `vite` separately and proxies to this API). When unset, behavior is
   * completely unchanged: API-only, unknown GET routes still 404. When set, static
   * serving is added as the LAST fallback in `handleRequest`, AFTER every API route,
   * so the API always wins. This is daemon-global (not per-project). See module header /
   * `resolveStaticPath` / `tryServeStaticFile`.
   */
  uiDir?: string;
  /**
   * OPTIONAL project-admin port (New Project flow, spec §3c/§5). When unset the
   * admin routes (`GET /fs/dirs`, `GET /agents/detect`, `POST /projects`,
   * `DELETE /projects/:id`) respond 404 — a read-only deployment, mirroring
   * `onOrchestrate`'s pattern. The server never touches the registry or the
   * filesystem itself; it only validates request shape and maps the port's
   * typed results to HTTP statuses.
   */
  admin?: {
    register(input: RegisterInput): Promise<RegisterResult>;
    unregister(id: string): Promise<boolean>;
    rename(id: string, name: string): Promise<RenameResult>;
    updateConfig(id: string, rawForm: unknown): Promise<ConfigUpdateResult>;
    listDirs(path?: string): Promise<FsDirsResult>;
    /** PATH-scan auto-detect of installed CLI agents (read-only, best-effort, never throws). */
    detectAgents(): Promise<DetectedAgent[]>;
  };
  /** Injected watcher factory so tests can drive change events without a real fs watch.
   *  Default (production) uses chokidar watching a project's `stateDir`. Must be swappable. */
  watchFactory?: (stateDir: string, onChange: (path: string) => void) => { close(): Promise<void> | void };
  /** Injected clock for the reply timestamp (default () => Date.now()). Keeps tests deterministic. */
  now?: () => number;
  log?: (level: string, message: string) => void;
}

export interface ApiServerHandle {
  /** Starts listening; resolves with the actual bound port (0 => OS-assigned ephemeral port).
   *  `host` defaults to Node's normal `http.Server#listen` default (all interfaces) when
   *  omitted -- pass `"127.0.0.1"` to bind loopback-only (used by the `serve` CLI verb). */
  listen(port?: number, host?: string): Promise<number>;
  /** Closes the http server, the ws server (+ all connected clients), and the watcher. */
  close(): Promise<void>;
  readonly port: number;
}

interface EscalationReply {
  id: string;
  choice: "A" | "B";
  /** Free-form operator context -- NEVER an executable instruction. See module header. */
  note: string;
  at: number;
}

/** Shape written by `createRecordRunCapability` (`src/orchestrator/capabilities.ts`) to
 *  `<stateDir>/runs/<runId>.json`. `name`/`archived_at` are OPTIONAL operator edits
 *  applied via `PATCH /runs/:id` — `recordRun` never writes them, so a freshly recorded
 *  manifest simply omits both (backward-compatible). */
interface RunManifest {
  runId: string;
  intent: string;
  taskIds: string[];
  at: number;
  /** Operator display override; when set the UI shows it instead of `intent`. */
  name?: string;
  /** Soft-archive timestamp (ms). Present = archived (reversible); absent = active. */
  archived_at?: number;
}

/** A partial run edit accepted by `PATCH /runs/:id`. */
export interface RunPatch {
  name?: string;
  archived?: boolean;
}

/**
 * Pure merge of a `RunPatch` onto a manifest (the write handler validates shape/policy
 * first, then calls this). `name`: trimmed; empty string CLEARS it (un-rename back to
 * `intent`). `archived`: true stamps `archived_at = now`, false CLEARS it (unarchive).
 * Uses `delete` on a copy so a cleared field is OMITTED, never set to explicit
 * `undefined` (exactOptionalPropertyTypes). Never mutates the input.
 */
export function applyRunPatch(manifest: RunManifest, patch: RunPatch, now: number): RunManifest {
  const next: RunManifest = { ...manifest };
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (trimmed === "") delete next.name;
    else next.name = trimmed;
  }
  if (patch.archived !== undefined) {
    if (patch.archived) next.archived_at = now;
    else delete next.archived_at;
  }
  return next;
}

/** Narrow, best-effort validation of a parsed run manifest -- a file that parses as
 *  JSON but doesn't have this shape is treated the same as unparseable: skipped. */
function isRunManifest(value: unknown): value is RunManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === "string" &&
    // A poisoned manifest with an unsafe runId (separators, `..`) must not be
    // surfaced to the UI as an openable run -- hold it to the same allowlist the
    // `/runs/:id` route enforces. (Defense in depth; the orchestrator writes safe
    // ids, but a hand-edited/corrupt file must not leak an unusable id.)
    safeIdSegment(v.runId) &&
    typeof v.intent === "string" &&
    Array.isArray(v.taskIds) &&
    v.taskIds.every((t) => typeof t === "string") &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    // Optional operator edits: when PRESENT they must be well-typed, else the
    // manifest is treated as corrupt (a hand-edited `name: 123` / non-finite
    // `archived_at` must never surface to the UI or a PATCH read).
    (v.name === undefined || typeof v.name === "string") &&
    (v.archived_at === undefined || (typeof v.archived_at === "number" && Number.isFinite(v.archived_at)))
  );
}

/**
 * Read-only open flags that do NOT follow a final-component symlink on POSIX
 * (`O_NOFOLLOW` -> `ELOOP`). Windows has no reliable `O_NOFOLLOW`, so it opens
 * normally there -- a STATIC symlink is still caught by the caller's `lstat`/
 * `fstat` `isFile()` guard, and concurrent symlink creation on Windows is
 * privilege-gated. Reading from this one fd (fstat + read on the same handle)
 * also closes the `stat`->`read` TOCTOU where a file is swapped after the check.
 */
const READ_NO_FOLLOW_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * Read-write open flags that do NOT follow a symlink on POSIX (`O_NOFOLLOW` ->
 * `ELOOP`) and do NOT create (`O_RDWR` only, no `O_CREAT`/`O_TRUNC`): the target
 * MUST already exist — a raced delete/symlink-swap fails the open (ENOENT/ELOOP),
 * which the caller maps to 404 rather than writing a stray/followed file. The
 * caller truncates via `fh.truncate(0)` after the open (Windows rejects a bare
 * `O_WRONLY|O_TRUNC` without `O_CREAT` with EINVAL, so truncation is a separate
 * step). Mirrors `READ_NO_FOLLOW_FLAGS` for the write direction; Windows has no
 * reliable `O_NOFOLLOW`, so a static symlink there is caught by the caller's
 * `lstat` pre-check and concurrent symlink creation is privilege-gated.
 */
const WRITE_NO_FOLLOW_FLAGS =
  process.platform === "win32" ? constants.O_RDWR : constants.O_RDWR | constants.O_NOFOLLOW;

/**
 * Best-effort bounded read of one run manifest, hardened against TOCTOU: opens a
 * single no-follow fd, `fstat`s THAT handle (256 KiB size cap + regular-file
 * check), and reads from the same handle -- so a concurrent size-swap or
 * symlink-swap can neither bypass the cap nor escape `runs/`. Returns `null`
 * (never throws) for a missing / oversized / non-file / malformed / poisoned
 * manifest.
 */
async function readBoundedManifest(path: string): Promise<RunManifest | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, READ_NO_FOLLOW_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_RUN_MANIFEST_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const parsed: unknown = JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
    return isRunManifest(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Best-effort bounded read of one file's full text content, TOCTOU-hardened exactly
 * like `handleReadRuntimeFile`: a cheap `lstat` pre-check rejects a static symlink /
 * dir up front, then a single no-follow fd is opened and BOTH the size check
 * (`fstat` on that handle) and the read happen on it -- closing the lstat->read
 * TOCTOU. Returns `null` (never throws) for a missing / non-file / oversized file or
 * a raced symlink swap; callers (`handleGetEscalation`) treat `null` uniformly as
 * "this file doesn't exist; try elsewhere / 404".
 */
async function readBoundedFileText(path: string, maxBytes: number): Promise<string | null> {
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

/** Narrow, best-effort validation of a parsed `<id>.reply.json` -- a file that
 *  parses as JSON but doesn't have this shape (or a hand-edited/corrupt one) is
 *  treated the same as unparseable: `GET /escalations/:id` degrades to `reply: null`
 *  rather than failing the whole endpoint. */
function isEscalationReply(value: unknown): value is EscalationReply {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.choice === "A" || v.choice === "B") &&
    typeof v.note === "string" &&
    typeof v.at === "number" &&
    Number.isFinite(v.at)
  );
}

/** Default (production) watcher: chokidar over the whole stateDir tree. */
function defaultWatchFactory(
  stateDir: string,
  onChange: (path: string) => void,
): { close(): Promise<void> | void } {
  const watcher = chokidarWatch(stateDir, { ignoreInitial: true });
  watcher.on("all", (_event, changedPath) => onChange(changedPath));
  return { close: () => watcher.close() };
}

/** Last `n` lines of `text`, dropping a single trailing empty line from a final newline. */
function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * Read at most the last `MAX_DIGEST_READ_BYTES` of `digest.md` via a positioned read,
 * then keep the last `DIGEST_TAIL_LINES` lines. Bounds memory regardless of digest
 * size. When the window starts mid-file, the first (possibly partial) line is dropped
 * so the tail never contains a truncated line.
 */
async function readDigestTail(digestPath: string): Promise<string> {
  const st = await stat(digestPath);
  const start = Math.max(0, st.size - MAX_DIGEST_READ_BYTES);
  // Over-read one byte BEFORE the window when start>0. buf[0] is then the byte
  // preceding the window: if it is a newline, the window began at a clean line
  // boundary (so `slice(firstNewline+1)` keeps the first full line intact); if
  // it is mid-line, that same slice drops only the partial remainder. This
  // avoids spuriously dropping a valid first line on an exact-boundary window.
  const readStart = start > 0 ? start - 1 : 0;
  const length = st.size - readStart;
  const fh = await open(digestPath, "r");
  try {
    const buf = Buffer.alloc(length);
    if (length > 0) await fh.read(buf, 0, length, readStart);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return tailLines(text, DIGEST_TAIL_LINES);
  } finally {
    await fh.close();
  }
}

/**
 * Guard against path traversal / separator injection in a bare id segment (escalation
 * id, task id, or run id) -- mirrors `FileBlackboardRepository.safePathSegment`.
 * Checked AFTER percent-decoding so an encoded `..` or `/` cannot slip past the
 * route's single-segment match.
 */
function safeIdSegment(id: string): boolean {
  return VALID_ID_SEGMENT.test(id);
}

/** Kept as a named alias at the escalation-reply call site for readability. */
const safeEscalationId = safeIdSegment;

/**
 * Guard against path traversal / separator injection in a runtime file name. Wider
 * charset than `safeIdSegment` (permits `.`) but explicitly rejects any name
 * containing `..` -- see `VALID_RUNTIME_FILE_NAME` doc comment.
 */
function safeRuntimeFileName(name: string): boolean {
  return VALID_RUNTIME_FILE_NAME.test(name) && !name.includes("..");
}

/** Percent-decode a raw URL path segment; `null` on malformed encoding. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve a request pathname (raw, percent-encoded, e.g. `url.pathname`) to an
 * absolute path INSIDE `uiDir`, or `null` if the request is malformed or attempts
 * to escape `uiDir`. This is the sole traversal guard for static serving -- mirrors
 * the `decodeSegment` + positive-allowlist rigor used elsewhere in this file, but
 * static paths are multi-segment so the guard works segment-by-segment instead of
 * a single-segment regex allowlist.
 *
 * Decodes the WHOLE pathname first (so an encoded separator like `%2f` or an
 * encoded dot like `%2e` is caught, not just a literal `..`), then walks the
 * decoded path split on `/`: empty and `.` segments are dropped, a `..` segment
 * is rejected outright (never resolved away), and any segment containing a NUL
 * byte, backslash, or colon (Windows separator / drive / ADS syntax) is rejected.
 * `path.resolve` + an explicit prefix check is kept as defense-in-depth even
 * though the `..` rejection alone already prevents escaping `uiDir`.
 */
function resolveStaticPath(uiDir: string, rawPathname: string): string | null {
  const decoded = decodeSegment(rawPathname);
  if (decoded === null) return null;
  if (decoded.includes("\u0000")) return null;

  const segments: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.includes("\\") || seg.includes(":") || seg.includes("\u0000")) return null;
    segments.push(seg);
  }

  const resolved = resolve(uiDir, ...segments);
  if (resolved !== uiDir && !resolved.startsWith(uiDir + sep)) return null;
  return resolved;
}

/** `realpath` that returns `null` instead of throwing (missing path, broken link,
 *  permission error). Used to canonicalize both `uiDir` and a candidate asset so an
 *  INTERMEDIATE symlink dir (e.g. `uiDir/assets -> /outside`) cannot escape `uiDir`
 *  -- a lexical prefix check + a final-component no-follow open do NOT catch that. */
async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Content-type for a static asset by extension; unknown extensions get the safe
 *  binary default rather than being sniffed. */
function staticContentType(absPath: string): string {
  return STATIC_CONTENT_TYPES[extname(absPath).toLowerCase()] ?? "application/octet-stream";
}

/** Flatten a value for single-line logging: collapse CR/LF/control chars to spaces and
 *  truncate, so an operator-supplied string (e.g. a POST /orchestrate `intent`) cannot
 *  forge extra log lines or bloat the log. Mirrors the CR/LF flattening the orchestrator's
 *  `report` capability does before writing the shared digest. */
function flattenForLog(s: string, max = 200): string {
  const flat = Array.from(s, (ch) => { const c = ch.codePointAt(0) ?? 0; return c < 0x20 || c === 0x7f ? " " : ch; }).join("").replace(/ {2,}/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Fail-closed error -> string: never throws, even on an `Error` whose `message` getter
 *  or a value whose `toString` throws (gotcha [ts/fail-closed]). Used in best-effort
 *  background chains where a throwing error-format must not become an unhandled rejection. */
function safeErrorText(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return "<unstringifiable error>";
  }
}

/**
 * `"served"` -- response sent (200). `"missing"` -- nothing at this path (ENOENT);
 * eligible for SPA fallback. `"blocked"` -- something exists at this path but it is
 * NOT servable (a directory, a symlink, an oversized file, ...); NEVER eligible for
 * SPA fallback, because falling back to `index.html` for a real directory would
 * silently mask it as a client-side route instead of 404ing.
 */
type StaticServeResult = "served" | "missing" | "blocked";

/**
 * Attempts to serve one static file at a lexically-checked absolute path. Two
 * layers of containment: (1) `absPath` already passed `resolveStaticPath`'s lexical
 * `..`/prefix check; (2) here we `realpath` the target and re-verify it is STILL
 * inside `canonicalUiDir` -- this is what stops an INTERMEDIATE symlink directory
 * (`uiDir/assets -> /outside`) from escaping, which `lstat`+`O_NOFOLLOW` (final
 * component only) do NOT catch. Then the fd-open + fstat + isFile TOCTOU-hardened
 * read pattern from `handleReadRuntimeFile` serves the canonical path.
 *
 * `lstat`/`realpath` failures are mapped precisely: only `ENOENT` (truly nothing
 * there) is `"missing"` (SPA-fallback-eligible); every other error (`ENOTDIR` for a
 * path under a file, `EACCES`, a symlink escape, oversize) is `"blocked"` so it can
 * NEVER be masked as a client-side route by the SPA fallback.
 */
async function tryServeStaticFile(
  absPath: string,
  canonicalUiDir: string,
  res: ServerResponse,
  log: (level: string, message: string) => void,
): Promise<StaticServeResult> {
  let lst;
  try {
    lst = await lstat(absPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "blocked";
  }
  if (!lst.isFile()) return "blocked"; // directory / (final) symlink / fifo / etc.

  // Canonicalize and re-check containment: catches an intermediate symlink dir that
  // the lexical check and the final-component no-follow open both miss.
  //
  // ACCEPTED RESIDUAL (documented): a realpath->open gap remains for a concurrent
  // adversary who swaps an intermediate dir INSIDE canonicalUiDir to a symlink
  // between this realpath and the open below. Fully closing it needs per-component
  // no-follow resolution (openat2 RESOLVE_BENEATH) which Node exposes on no platform
  // portably; realpath containment is exactly what industry static servers
  // (serve-static lineage) do and is accepted for this threat model -- a localhost,
  // single-operator, no-auth daemon serving its OWN build output (`<repoRoot>/dist/ui`).
  // Such an adversary already has same-user FS access and can read any file directly,
  // so the gap grants no new capability.
  const canonical = await realpathSafe(absPath);
  if (canonical === null) return "blocked";
  if (canonical !== canonicalUiDir && !canonical.startsWith(canonicalUiDir + sep)) return "blocked";

  let fh: FileHandle;
  try {
    fh = await open(canonical, READ_NO_FOLLOW_FLAGS);
  } catch {
    // ELOOP / raced delete after the checks above -- blocked (never SPA fallback).
    return "blocked";
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return "blocked";
    if (st.size > MAX_STATIC_ASSET_READ_BYTES) {
      // Never serve a truncated binary asset (would silently corrupt it) -- log and
      // treat as unservable instead.
      log("WARN", `api: static asset over ${MAX_STATIC_ASSET_READ_BYTES} bytes, refusing to serve: ${canonical}`);
      return "blocked";
    }
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    res.writeHead(200, { "content-type": staticContentType(canonical) });
    res.end(buf.subarray(0, bytesRead));
    return "served";
  } finally {
    await fh.close();
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating (memory stays bounded) and reject. We do NOT destroy
        // the socket here -- the caller still needs to flush a 413 response first;
        // it tears the connection down after that. reject is idempotent, and
        // further discarded chunks never grow `raw`.
        if (!overflowed) {
          overflowed = true;
          reject(new PayloadTooLargeError("request body too large"));
        }
        return;
      }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** Creates (but does not start) the thin API server. Call `.listen()` to bind. */
export function createApiServer(deps: ApiServerDeps): ApiServerHandle {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((): void => {});
  const watchFactory = deps.watchFactory ?? defaultWatchFactory;

  // Single-flight guard for POST /projects/:id/orchestrate: an orchestrate run
  // (LLM decompose + bounded conductor loop) takes minutes, and only one may run
  // per project at a time. The project id is `.add`ed synchronously before the 202
  // response is sent so a concurrent request for the SAME project can never race
  // past it; cleared in the background chain's `finally` once the (unawaited) run
  // settles. Different projects run independently.
  const orchestrateInFlight = new Set<string>();

  // One fs-watcher per BUILT project, attached the first time the project resolves.
  // Every project's changes broadcast on the single WS stream, tagged with the
  // projectId of the project whose stateDir changed. The stateDir is stored with
  // the handle so a project re-registered to a NEW path gets its watcher re-attached
  // to the new stateDir (the old one is closed) -- otherwise the old stateDir would
  // keep broadcasting under this projectId and the new one would never be watched.
  //
  // ACCEPTED (documented): a watcher for a project that is UNREGISTERED but never
  // re-resolved lingers until daemon shutdown; it broadcasts events for a stateDir
  // the UI no longer lists, which the UI simply ignores. Reconciling removals would
  // need the server to observe registry deletions, which it deliberately does not.
  const watchers = new Map<string, { stateDir: string; handle: { close(): Promise<void> | void } }>();
  function ensureWatcher(projectId: string, projectStateDir: string): void {
    const existing = watchers.get(projectId);
    if (existing) {
      if (existing.stateDir === projectStateDir) return; // same project, same path -- keep it
      // Re-registered to a different path: close the stale watcher best-effort
      // (ensureWatcher is sync; the close may be async), then attach the new one.
      // The close is fire-and-forget -- until it settles (or if it never does) the
      // OLD stateDir's callback could still fire. The identity guard below (closing
      // over `record`) silences it even so: it only broadcasts while it is STILL the
      // current map entry for this id, which stops being true the moment we `delete`
      // it here and `set` the replacement below.
      void Promise.resolve(existing.handle.close()).catch(() => {});
      watchers.delete(projectId);
    }
    const record: { stateDir: string; handle: { close(): Promise<void> | void } } = {
      stateDir: projectStateDir,
      handle: { close: () => {} }, // placeholder, replaced below before any event can fire
    };
    record.handle = watchFactory(projectStateDir, (changedPath) => {
      // Identity guard: a retired watcher (re-register race / failed close) must
      // never broadcast under the reused project id.
      if (watchers.get(projectId) === record) broadcastChange(projectId, changedPath);
    });
    watchers.set(projectId, record);
  }

  async function handleState(p: ProjectView, res: ServerResponse): Promise<void> {
    const queues = {} as Record<QueueState, Awaited<ReturnType<BlackboardRepository["listTasks"]>>>;
    for (const state of QUEUE_STATES) {
      queues[state] = await p.repo.listTasks(state);
    }

    const digestPath = join(p.stateDir, "digest.md");
    let digestTail = "";
    if (existsSync(digestPath)) {
      try {
        digestTail = await readDigestTail(digestPath);
      } catch (err) {
        // digest.md is a best-effort convenience surface -- never fail /state over it.
        log("WARN", `api: failed reading digest.md: ${String(err)}`);
      }
    }

    sendJson(res, 200, { queues, digestTail });
  }

  async function handleReply(p: ProjectView, rawId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null) {
      sendJson(res, 400, { error: "invalid escalation id encoding" });
      return;
    }
    if (!safeEscalationId(id)) {
      sendJson(res, 400, { error: "invalid escalation id" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Flush the 413 with `connection: close`, then destroy the socket once the
        // response is on the wire -- so a never-ending upload cannot keep the
        // connection (and therefore close()) alive, while the client still gets
        // a clean 413 rather than a reset.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { choice?: unknown; note?: unknown } | null;
    const choice = parsed?.choice;
    if (choice !== "A" && choice !== "B") {
      // The ONLY executable signal this endpoint accepts. See module header (parity spec §8).
      sendJson(res, 400, { error: 'choice must be "A" or "B"' });
      return;
    }
    const note = typeof parsed?.note === "string" ? parsed.note : "";

    const reply: EscalationReply = { id, choice, note, at: now() };
    const escalationsDir = join(p.stateDir, "escalations");
    await mkdir(escalationsDir, { recursive: true });
    await writeFile(join(escalationsDir, `${id}.reply.json`), JSON.stringify(reply, null, 2), "utf8");
    log("INFO", `api: recorded escalation reply ${id} -> ${choice}`);

    // A replied escalation must not keep holding its file_set as a scheduler lock
    // (gotcha [escalate/replied-holds-filelock], found live s25). The A/B choice
    // releases the lock by transitioning the task out of queue/escalated/:
    //   B (rework) -> pending    (re-queued for another run).
    //   A (accept) -> quarantine (NOT done): the escalated worker's work was never
    //     committed (the gate escalated instead of committing) and the harness has
    //     no apply-on-accept machinery, so `done` would falsely satisfy a dependent
    //     task's depends_on (doneIds) on work that is absent from the repo. quarantine
    //     releases the lock without claiming repo-completion (it is not in doneIds and
    //     not in the scheduler lock set, which is active+escalated only).
    const target: QueueState = choice === "A" ? "quarantine" : "pending";
    try {
      await p.repo.moveTask(id, "escalated", target);
      log("INFO", `api: escalation ${id} reply ${choice} -> moved escalated/ -> ${target}/`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        // No queue task in escalated/ (a drift-* escalation has an artifact but no
        // queue file; or a double-reply already moved it) -- benign: the reply is
        // recorded and there is no lock to release.
        log("INFO", `api: escalation ${id} reply recorded; no escalated queue task to release`);
      } else {
        // The lock is still held -- surface it, do not silently 200.
        log("ERROR", `api: escalation ${id} reply recorded but lock release failed: ${String(err)}`);
        sendJson(res, 500, { error: "reply recorded but failed to release the escalation lock", id, choice });
        return;
      }
    }

    sendJson(res, 200, reply);
  }

  /**
   * Read one escalation's body (+ reply status, if any) for the dashboard's A/B
   * decision card. The escalation id == the task id (`buildEscalation` in
   * `src/conductor/conductor.ts` sets `id: task.id`); the UI already knows which
   * ids exist from the `escalated` queue in `GET /state`, so this is deliberately
   * a single-item read, not a list endpoint.
   *
   * Mirrors `handleReadRuntimeFile`'s TOCTOU-hardened bounded-read discipline via
   * `readBoundedFileText`. A missing / oversized / non-file / symlink-escaped /
   * unparseable markdown file is ALWAYS a 404 -- never a 500 over a file the
   * conductor may still be writing. The reply file is read the same way but is
   * best-effort ON TOP of that: missing or malformed -> `reply: null`, never a
   * failure of the whole request (parity with the `digest.md` / run-manifest
   * best-effort philosophy used elsewhere in this file).
   */
  async function handleGetEscalation(p: ProjectView, rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid escalation id" });
      return;
    }

    const escalationsDir = join(p.stateDir, "escalations");
    const markdownText = await readBoundedFileText(join(escalationsDir, `${id}.md`), MAX_ESCALATION_READ_BYTES);
    if (markdownText === null) {
      sendJson(res, 404, { error: "escalation not found" });
      return;
    }
    // The filename and the internal `# ESCALATION <id> -- ...` header are expected
    // to agree (both are always written together by `escalate()`); a stale or
    // hand-edited file where they diverge is treated the same as "not found" --
    // never surfaced as someone else's escalation under this id.
    const parsed = parseEscalation(markdownText);
    if (parsed === null || parsed.id !== id) {
      sendJson(res, 404, { error: "escalation not found" });
      return;
    }

    let reply: { choice: "A" | "B"; note: string; at: number } | null = null;
    const replyText = await readBoundedFileText(join(escalationsDir, `${id}.reply.json`), MAX_ESCALATION_READ_BYTES);
    if (replyText !== null) {
      try {
        const parsedReply: unknown = JSON.parse(replyText);
        // Same filename/internal-id agreement as above, but best-effort: a mismatch
        // here degrades only the reply to null, it never fails the whole request.
        if (isEscalationReply(parsedReply) && parsedReply.id === id) {
          reply = { choice: parsedReply.choice, note: parsedReply.note, at: parsedReply.at };
        }
      } catch {
        // Malformed reply JSON -- degrade to null, never fail the endpoint.
      }
    }

    sendJson(res, 200, {
      id: parsed.id,
      reason: parsed.reason,
      type: parsed.type,
      taskId: parsed.taskId,
      title: parsed.title,
      what: parsed.what,
      decision: parsed.decision,
      optionA: parsed.optionA,
      optionB: parsed.optionB,
      costOfWrong: parsed.costOfWrong,
      evidence: parsed.evidence,
      reply,
    });
  }

  /** GET /fs/dirs?path=<abs> — folder browser (spec §3e). Whole-listing failures
   *  are 400 (typed invalid_path from the port), never 500 (spec §6). */
  async function handleFsDirs(url: URL, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const pathParam = url.searchParams.get("path");
    const result = await deps.admin.listDirs(pathParam === null || pathParam === "" ? undefined : pathParam);
    if (!result.ok) {
      sendJson(res, 400, { error: result.message });
      return;
    }
    sendJson(res, 200, { path: result.path, parent: result.parent, entries: result.entries });
  }

  /** GET /agents/detect — PATH-scan auto-detect of installed CLI agents.
   *  Best-effort/never-throws by contract (see `detectAgents`), so no typed
   *  failure union is needed here -- only the admin-port gate. */
  async function handleDetectAgents(res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, { agents: await deps.admin.detectAgents() });
  }

  /** POST /projects — register (+ optional scaffold). Validation beyond request
   *  SHAPE lives in the admin port; this handler only maps typed codes to HTTP. */
  async function handleRegisterProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { path?: unknown; name?: unknown; scaffold?: unknown; config?: unknown } | null;
    if (typeof parsed?.path !== "string" || parsed.path.trim() === "") {
      sendJson(res, 400, { error: "path must be a non-empty string" });
      return;
    }
    if (parsed.name !== undefined && typeof parsed.name !== "string") {
      sendJson(res, 400, { error: "name must be a string" });
      return;
    }
    if (parsed.scaffold !== undefined && typeof parsed.scaffold !== "boolean") {
      sendJson(res, 400, { error: "scaffold must be a boolean" });
      return;
    }
    // `config` stays unknown here — the admin port validates it (ScaffoldFormSchema)
    // and reports a typed invalid_config, keeping one source of truth for the form.

    const result = await deps.admin.register({
      path: parsed.path,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.scaffold !== undefined ? { scaffold: parsed.scaffold } : {}),
      ...(parsed.config !== undefined ? { config: parsed.config } : {}),
    });
    if (result.ok) {
      log("INFO", `api: registered project '${result.entry.id}' at ${flattenForLog(result.entry.path)}`);
      sendJson(res, 201, result.entry);
      return;
    }
    sendJson(res, result.code === "already_registered" ? 409 : 400, {
      error: result.message,
      code: result.code,
    });
  }

  /** PATCH /projects/:id — rename the display `name` (registry entry only; id and
   *  path stay put). Validation beyond request SHAPE lives in the admin port; this
   *  handler only maps typed codes to HTTP. `pid` is already the decoded+validated id. */
  async function handlePatchProject(pid: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { name?: unknown } | null;
    if (typeof parsed?.name !== "string") {
      sendJson(res, 400, { error: "name must be a string" });
      return;
    }

    const result = await deps.admin.rename(pid, parsed.name);
    if (result.ok) {
      log("INFO", `api: renamed project '${pid}'`);
      sendJson(res, 200, result.entry);
      return;
    }
    sendJson(res, result.code === "not_found" ? 404 : 400, {
      error: result.message,
      code: result.code,
    });
  }

  /** PATCH /projects/:id/config — merge a curated form into `.autodev/config.yaml`
   *  (the write counterpart of `GET /projects/:id/config`). Unlike
   *  `handlePatchProject`, the body shape is NOT validated here -- the admin port
   *  owns `ScaffoldFormSchema` validation, exactly like `POST /projects`'s `config`
   *  field already does ("config stays unknown here, the admin port validates it").
   *  `pid` is already the decoded+validated id. */
  async function handlePatchConfig(pid: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const result = await deps.admin.updateConfig(pid, body);
    if (!result.ok) {
      sendJson(res, result.code === "not_found" ? 404 : 400, { error: result.message, code: result.code });
      return;
    }

    // The write succeeded -- re-resolve so the response reflects the FRESH
    // on-disk config. index.ts's wiring evicts the hub cache before this handler
    // runs, so this `get` triggers a rebuild rather than serving a stale root.
    const resolved = await deps.projects.get(pid);
    if (resolved === null) {
      sendJson(res, 404, { error: "project not found" });
      return;
    }
    if ("error" in resolved) {
      sendJson(res, 503, { error: `project failed to load: ${resolved.error}` });
      return;
    }
    if (!resolved.view.config) {
      sendJson(res, 200, { updated: true }); // defensive fallback -- config unset on the view
      return;
    }
    log("INFO", `api: updated config for project '${pid}'`);
    sendJson(res, 200, resolved.view.config);
  }

  /**
   * 202-async launcher for `POST /orchestrate` (R1 boundary): reads+validates the
   * body, then -- WITHOUT awaiting it -- kicks off `p.onOrchestrate(intent)` in
   * the background and returns `202 {accepted:true,intent}` immediately. The
   * orchestration itself (LLM decompose + bounded conductor loop) can take
   * minutes; this handler's job is only to validate and enqueue+trigger via the
   * injected closure, never to hold the connection open.
   *
   * Single-flight (per project): the project id is added to `orchestrateInFlight`
   * synchronously before the 202 is sent, so a second POST for the SAME project
   * received before the run finishes gets `409`. The id is removed in the
   * background chain's `finally`, regardless of success, rejection, or a
   * SYNCHRONOUS throw from `p.onOrchestrate` -- the `Promise.resolve().then(...)`
   * wrapper normalizes a sync throw into a rejection so it can never leak an
   * unhandled exception or a second (500) response after the 202 has already been
   * sent.
   */
  async function handleOrchestrate(
    pid: string,
    p: ProjectView,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!p.onOrchestrate) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { intent?: unknown } | null;
    const rawIntent = parsed?.intent;
    if (typeof rawIntent !== "string") {
      sendJson(res, 400, { error: "intent must be a string" });
      return;
    }
    const intent = rawIntent.trim();
    if (intent === "") {
      sendJson(res, 400, { error: "intent must not be empty" });
      return;
    }
    if (intent.length > MAX_INTENT_LENGTH) {
      sendJson(res, 400, { error: `intent must be at most ${MAX_INTENT_LENGTH} characters` });
      return;
    }

    if (orchestrateInFlight.has(pid)) {
      sendJson(res, 409, { error: "an orchestrate run is already in progress" });
      return;
    }
    orchestrateInFlight.add(pid);

    // Fire-and-forget: NOT awaited, so the 202 below is sent before the run
    // (which can take minutes) does anything. `Promise.resolve().then(...)`
    // wraps the call so a SYNCHRONOUS throw from `p.onOrchestrate` becomes a
    // rejection here rather than escaping this function's synchronous frame
    // (which would otherwise crash out of the request handler after a 202 was
    // already queued).
    const onOrchestrate = p.onOrchestrate;
    // `safeIntent` is flattened (control chars -> spaces, truncated) so an operator
    // intent can never forge extra log lines. `safeLog` + `safeErrorText` keep this
    // best-effort background chain from EVER producing an unhandled rejection after the
    // 202 has been sent -- a throwing logger or a hostile error whose stringify throws
    // must not escape (gotcha [ts/fail-closed]); the terminal `.catch` is the backstop.
    const safeIntent = flattenForLog(intent);
    const safeLog = (level: string, message: string): void => {
      try {
        log(level, message);
      } catch {
        /* a broken logger must never crash the post-202 background path */
      }
    };
    Promise.resolve()
      .then(() => onOrchestrate(intent))
      .then(() => safeLog("INFO", `api: orchestrate run completed for intent: ${safeIntent}`))
      .catch((err: unknown) =>
        safeLog("ERROR", `api: orchestrate run failed for intent "${safeIntent}": ${safeErrorText(err)}`),
      )
      .finally(() => {
        orchestrateInFlight.delete(pid);
      })
      .catch(() => {
        /* terminal backstop: nothing from this chain may surface as an unhandled rejection */
      });

    sendJson(res, 202, { accepted: true, intent });
  }

  /**
   * Reads and best-effort parses every `*.json` manifest under `<stateDir>/runs/`.
   * A malformed or unreadable manifest is logged at WARN and SKIPPED -- it never
   * fails the whole listing (mirrors the `digest.md` best-effort philosophy above).
   * Missing `runs/` (no orchestrator run recorded yet) yields `[]`, not an error.
   * Sorted newest-first by `at`; ties keep filesystem-directory-listing order
   * (Array#sort is a stable sort, so equal `at` values preserve their relative order
   * from the pre-sorted file list).
   */
  async function listRunManifests(stateDir: string): Promise<RunManifest[]> {
    const runsDir = join(stateDir, "runs");
    let files: string[];
    try {
      files = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      // Best-effort: a missing runs/ dir is the normal "no run yet" case (-> []).
      // Any OTHER readdir failure (ENOTDIR if runs/ is a file, EACCES, ...) must
      // also degrade to [] rather than 500 the dashboard's run list.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", `api: cannot list run manifests: ${String(err)}`);
      }
      return [];
    }
    files.sort(); // deterministic base order before the stable sort-by-at below
    const manifests: RunManifest[] = [];
    for (const f of files) {
      // readBoundedManifest is TOCTOU-hardened + best-effort: it returns null
      // (never throws) for an oversized/malformed/poisoned/non-file manifest,
      // which we simply skip so one bad file can't fail the whole listing.
      const manifest = await readBoundedManifest(join(runsDir, f));
      if (manifest) manifests.push(manifest);
      else log("WARN", `api: skipping unreadable/invalid run manifest ${f}`);
    }
    manifests.sort((a, b) => b.at - a.at);
    return manifests;
  }

  async function handleListRuns(p: ProjectView, url: URL, res: ServerResponse): Promise<void> {
    const includeArchived = ["1", "true"].includes((url.searchParams.get("includeArchived") ?? "").toLowerCase());
    const all = await listRunManifests(p.stateDir);
    // Archived runs are hidden from the default list (a reversible soft-flag) but
    // remain directly openable via GET /runs/:id and re-includable via the query.
    sendJson(res, 200, includeArchived ? all : all.filter((m) => m.archived_at === undefined));
  }

  /**
   * PATCH /projects/:id/runs/:runId — rename (`name`) and/or archive (`archived`)
   * one run MANIFEST. The manifest is a non-authoritative INDEX: this touches only
   * `<stateDir>/runs/<runId>.json`, never the blackboard queue / tasks / worktrees /
   * gate. Mirrors `handleReply`/`handlePatchConfig`: bounded read (404 on missing/
   * corrupt), symlink-guard the file before writing (`[scaffold/config-file-symlink]`
   * class), plain overwrite, return the fresh manifest.
   */
  async function handlePatchRun(p: ProjectView, rawId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { name?: unknown; archived?: unknown } | null;
    const patch: RunPatch = {};
    if (parsed?.name !== undefined) {
      if (typeof parsed.name !== "string") {
        sendJson(res, 400, { error: "name must be a string" });
        return;
      }
      // RAW length, before any trim: a >200 name (even whitespace-only) must be
      // rejected outright, never silently trimmed-to-empty and cleared (which would
      // MUTATE a manifest the request should have been rejected for).
      if (parsed.name.length > 200) {
        sendJson(res, 400, { error: "name must be at most 200 characters" });
        return;
      }
      patch.name = parsed.name;
    }
    if (parsed?.archived !== undefined) {
      if (typeof parsed.archived !== "boolean") {
        sendJson(res, 400, { error: "archived must be a boolean" });
        return;
      }
      patch.archived = parsed.archived;
    }
    if (patch.name === undefined && patch.archived === undefined) {
      sendJson(res, 400, { error: "nothing to update (expected name and/or archived)" });
      return;
    }

    const manifestPath = join(p.stateDir, "runs", `${id}.json`);
    const manifest = await readBoundedManifest(manifestPath);
    if (manifest === null) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }

    const updated = applyRunPatch(manifest, patch, now());

    // Hardened no-follow WRITE (closes the lstat->write TOCTOU: a symlink swapped
    // in AFTER the read must not be followed on write -- `[scaffold/config-file-symlink]`
    // class). Cheap cross-platform lstat pre-check rejects a STATIC symlink/dir up
    // front (the only guard on Windows, where O_NOFOLLOW is unavailable), then a
    // single no-follow, truncating fd is opened (ELOOP on a POSIX symlink swapped in
    // after the lstat; ENOENT on a raced delete) and an fstat on THAT handle
    // re-verifies a regular file before writing -- mirroring handleReadRuntimeFile's
    // read discipline for the write direction. No O_CREAT: a vanished target 404s
    // rather than resurrecting a stray manifest.
    let lst;
    try {
      lst = await lstat(manifestPath);
    } catch {
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    if (!lst.isFile()) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }

    let fh: FileHandle;
    try {
      fh = await open(manifestPath, WRITE_NO_FOLLOW_FLAGS);
    } catch {
      // ELOOP (symlink swapped in after the lstat, POSIX) or a raced delete.
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        sendJson(res, 404, { error: "run not found" });
        return;
      }
      // Truncate THEN writeFile from offset 0: the fd was opened O_RDWR without
      // O_TRUNC (see WRITE_NO_FOLLOW_FLAGS), so the old (possibly longer) content
      // must be cleared explicitly or its tail would survive past the new JSON.
      // `fh.writeFile` (not `fh.write`) LOOPS until every byte is flushed — a bare
      // `fh.write` can short-write near ENOSPC/quota/network-FS and silently leave
      // a truncated, corrupt manifest.
      await fh.truncate(0);
      await fh.writeFile(JSON.stringify(updated, null, 2), "utf8");
    } finally {
      await fh.close();
    }
    log("INFO", `api: patched run '${id}' (${patch.name !== undefined ? "rename " : ""}${patch.archived !== undefined ? `archived=${patch.archived}` : ""})`);
    sendJson(res, 200, updated);
  }

  async function handleGetRun(p: ProjectView, rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    // Same TOCTOU-hardened bounded read as the list path. A missing / oversized /
    // malformed / poisoned manifest is treated as absent (-> 404), never a 500 over
    // an on-disk file the orchestrator (or an operator) may still be writing.
    const manifest = await readBoundedManifest(join(p.stateDir, "runs", `${id}.json`));
    if (!manifest) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    sendJson(res, 200, manifest);
  }

  /**
   * Server-side per-run token-usage aggregation (s25): reads the run manifest, then
   * best-effort reads each task's `token-usage.json` with the same TOCTOU-hardened
   * bounded reader as `handleReadRuntimeFile` (`readBoundedFileText`), and sums them
   * via the pure `buildRunUsageSummary`. This is the clean server-side path that lets
   * a future cross-run "today" total avoid N x M client fetches (s22 only aggregated
   * client-side, per open run). READ-ONLY; no new file-reading security code -- every
   * read goes through an existing hardened reader.
   */
  async function handleGetRunUsage(p: ProjectView, rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const manifest = await readBoundedManifest(join(p.stateDir, "runs", `${id}.json`));
    if (!manifest) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    // Read each task's token-usage.json server-side with the same hardened bounded
    // reader as the runtime-file endpoint. The manifest is an on-disk, hand-editable
    // file, so up front: DROP any path-unsafe task id (`safeIdSegment` is strictly
    // narrower than `runtimeDir`'s guard, so a surviving id can never make it throw)
    // and DEDUPE, so a duplicate id can't double-count one task's usage and `taskCount`
    // reflects the run's unique, legitimate tasks. Each per-task read is fully wrapped:
    // a missing / malformed / non-usage file -- or ANY unexpected reader error -- yields
    // `null` and is skipped (best-effort, mirrors the s22 client aggregate) instead of
    // rejecting the whole request. Returning from the map (not pushing) also keeps the
    // sum in manifest order -> deterministic totals.
    // Accepted residual: dedupe is by string identity, so on a case-INSENSITIVE fs a
    // pathological manifest listing `["t1","T1"]` would read one on-disk task twice. Not
    // guarded because (a) orchestrator-generated ids are unique and never case-variant,
    // (b) on such a fs two case-variant tasks can't even coexist -- their queue `.md`
    // files and runtime dirs collide, so only a hand-corrupted manifest hits it, (c) the
    // impact is a bounded over-count in a read-only display number (no traversal -- both
    // resolve inside runtime/), and (d) a portable fix (case-fold) would WRONGLY merge
    // legitimately-distinct ids on a case-sensitive fs (Linux/CI). Not worth an fs-realpath.
    const ids = [...new Set(manifest.taskIds.filter((t) => safeIdSegment(t)))];
    const results = await Promise.all(
      ids.map(async (taskId): Promise<TokenUsageDoc | null> => {
        try {
          const text = await readBoundedFileText(
            join(p.repo.runtimeDir(taskId), "token-usage.json"),
            MAX_RUNTIME_FILE_READ_BYTES,
          );
          if (text === null) return null;
          const parsed: unknown = JSON.parse(text);
          return isTokenUsageDoc(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }),
    );
    const docs = results.filter((d): d is TokenUsageDoc => d !== null);
    sendJson(res, 200, buildRunUsageSummary(docs, ids.length));
  }

  async function handleListRuntimeFiles(p: ProjectView, rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid task id" });
      return;
    }
    const dir = p.repo.runtimeDir(id);
    try {
      const names = await readdir(dir);
      sendJson(res, 200, names);
    } catch (err) {
      // Best-effort (mirrors `/runs`): a missing runtime dir is the normal
      // "task not started" case (-> []); any other readdir failure (ENOTDIR,
      // EACCES, ...) also degrades to [] rather than a 500.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", `api: cannot list runtime files for ${id}: ${String(err)}`);
      }
      sendJson(res, 200, []);
    }
  }

  async function handleReadRuntimeFile(
    p: ProjectView,
    rawId: string,
    rawName: string,
    res: ServerResponse,
  ): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid task id" });
      return;
    }
    const name = decodeSegment(rawName);
    if (name === null || !safeRuntimeFileName(name)) {
      sendJson(res, 400, { error: "invalid runtime file name" });
      return;
    }

    const filePath = join(p.repo.runtimeDir(id), name);

    // Cheap cross-platform pre-check: reject a STATIC symlink / dir / fifo up
    // front (lstat describes the link itself). On Windows, where the no-follow
    // open below has no O_NOFOLLOW, this is what catches a pre-existing symlink.
    let lst;
    try {
      lst = await lstat(filePath);
    } catch {
      sendJson(res, 404, { error: "runtime file not found" });
      return;
    }
    if (!lst.isFile()) {
      sendJson(res, 404, { error: "runtime file not found" });
      return;
    }

    // Open a single no-follow fd and do BOTH the size check (fstat on this
    // handle) and the read from it -- closing the lstat->read TOCTOU (a swap to a
    // symlink after the lstat fails the O_NOFOLLOW open with ELOOP on POSIX; a
    // swap to a dir is caught by the fstat isFile() re-check).
    let fh: FileHandle;
    try {
      fh = await open(filePath, READ_NO_FOLLOW_FLAGS);
    } catch {
      // ELOOP (symlink swapped in after the lstat, POSIX) or a raced delete.
      sendJson(res, 404, { error: "runtime file not found" });
      return;
    }
    let text: string;
    let truncated = false;
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        sendJson(res, 404, { error: "runtime file not found" });
        return;
      }
      // Never load more than the cap. `bytesRead` guards against a short read /
      // concurrent shrink emitting trailing NUL padding from the alloc'd buffer.
      const readLen = Math.min(st.size, MAX_RUNTIME_FILE_READ_BYTES);
      const buf = Buffer.alloc(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, 0);
      text = buf.subarray(0, bytesRead).toString("utf8");
      if (st.size > MAX_RUNTIME_FILE_READ_BYTES) {
        text += TRUNCATION_MARKER;
        truncated = true;
      }
    } finally {
      await fh.close();
    }

    // A truncated body is prefix + marker -- no longer valid JSON -- so it must
    // never be labelled application/json. Serve truncated content as text with an
    // explicit `x-truncated` header; only an untruncated `.json` file is JSON.
    const headers: Record<string, string> = truncated
      ? { "content-type": "text/plain; charset=utf-8", "x-truncated": "true" }
      : { "content-type": name.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" };
    res.writeHead(200, headers);
    res.end(text);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Daemon-global: the sidebar project list. Never per-project.
    if (req.method === "GET" && (url.pathname === "/projects" || url.pathname === "/projects/")) {
      sendJson(res, 200, { projects: await deps.projects.list() });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/projects" || url.pathname === "/projects/")) {
      return void (await handleRegisterProject(req, res));
    }
    if (req.method === "GET" && (url.pathname === "/fs/dirs" || url.pathname === "/fs/dirs/")) {
      return void (await handleFsDirs(url, res));
    }
    if (req.method === "GET" && (url.pathname === "/agents/detect" || url.pathname === "/agents/detect/")) {
      return void (await handleDetectAgents(res));
    }

    // Every project-scoped route lives under `/projects/:id/...`. Resolve the
    // project ONCE here, then dispatch the sub-path against the resolved
    // ProjectView -- each handler operates purely on that view (its own repo +
    // stateDir), so two projects never cross-bleed.
    const projMatch = /^\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (projMatch) {
      const rawPid = decodeSegment(projMatch[1]!);
      if (rawPid === null || !safeIdSegment(rawPid)) {
        sendJson(res, 400, { error: "invalid project id" });
        return;
      }
      const sub = projMatch[2] ?? "/";

      // DELETE /projects/:id — registry-entry removal only (spec §3a: never touches
      // the folder). Handled BEFORE the root resolve: a project whose config fails
      // to build (hub {error} -> 503 on GET routes) must still be deletable. Also
      // closes this id's live watcher so a later re-registration under the same id
      // can never receive stale broadcasts ([multiproject/id-keyed-caches]).
      if (req.method === "DELETE" && (sub === "/" || sub === "")) {
        if (!deps.admin) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const removed = await deps.admin.unregister(rawPid);
        if (!removed) {
          sendJson(res, 404, { error: "project not found" });
          return;
        }
        const w = watchers.get(rawPid);
        if (w) {
          void Promise.resolve(w.handle.close()).catch(() => {});
          watchers.delete(rawPid);
        }
        log("INFO", `api: unregistered project '${rawPid}'`);
        sendJson(res, 200, { removed: rawPid });
        return;
      }

      // PATCH /projects/:id — rename (registry entry only). Handled BEFORE the root
      // resolve for the same reason as DELETE: a project whose config fails to build
      // must still be renameable. id stays stable -> id-keyed caches remain valid.
      if (req.method === "PATCH" && (sub === "/" || sub === "")) {
        return void (await handlePatchProject(rawPid, req, res));
      }

      // PATCH /projects/:id/config — config-write endpoint. Handled BEFORE the root
      // resolve for the same reason as DELETE/rename: a project whose CURRENT config
      // fails to build must still be fixable from here.
      if (req.method === "PATCH" && (sub === "/config" || sub === "/config/")) {
        return void (await handlePatchConfig(rawPid, req, res));
      }

      const resolved = await deps.projects.get(rawPid);
      if (resolved === null) {
        sendJson(res, 404, { error: "project not found" });
        return;
      }
      if ("error" in resolved) {
        sendJson(res, 503, { error: `project failed to load: ${resolved.error}` });
        return;
      }
      const p = resolved.view;
      ensureWatcher(rawPid, p.stateDir);

      if (req.method === "GET" && (sub === "/state" || sub === "/state/")) return void (await handleState(p, res));
      if (req.method === "GET" && (sub === "/config" || sub === "/config/")) {
        if (!p.config) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, p.config);
        return;
      }
      if (req.method === "GET" && (sub === "/runs" || sub === "/runs/")) return void (await handleListRuns(p, url, res));
      const runMatch = /^\/runs\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && runMatch) return void (await handleGetRun(p, runMatch[1]!, res));
      if (req.method === "PATCH" && runMatch) return void (await handlePatchRun(p, runMatch[1]!, req, res));
      const runUsageMatch = /^\/runs\/([^/]+)\/usage\/?$/.exec(sub);
      if (req.method === "GET" && runUsageMatch) return void (await handleGetRunUsage(p, runUsageMatch[1]!, res));
      const runtimeFileMatch = /^\/tasks\/([^/]+)\/runtime\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && runtimeFileMatch)
        return void (await handleReadRuntimeFile(p, runtimeFileMatch[1]!, runtimeFileMatch[2]!, res));
      const runtimeListMatch = /^\/tasks\/([^/]+)\/runtime\/?$/.exec(sub);
      if (req.method === "GET" && runtimeListMatch) return void (await handleListRuntimeFiles(p, runtimeListMatch[1]!, res));
      // Single-segment match (`[^/]+` with no trailing path) -- distinct from, and
      // checked independently of, the POST .../reply route below (different method
      // AND an extra path segment), so neither can ever shadow the other.
      const escGetMatch = /^\/escalations\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && escGetMatch) return void (await handleGetEscalation(p, escGetMatch[1]!, res));
      const replyMatch = /^\/escalations\/([^/]+)\/reply\/?$/.exec(sub);
      if (req.method === "POST" && replyMatch) return void (await handleReply(p, replyMatch[1]!, req, res));
      if (req.method === "POST" && (sub === "/orchestrate" || sub === "/orchestrate/"))
        return void (await handleOrchestrate(rawPid, p, req, res));

      sendJson(res, 404, { error: "not found" });
      return;
    }

    // Static UI-bundle serving -- LAST fallback, only when uiDir is configured, and
    // only for GET (a non-GET that matched no API route above still falls through
    // to the plain 404 below, unchanged). See ApiServerDeps.uiDir doc comment.
    if (req.method === "GET" && deps.uiDir) {
      // Canonicalize uiDir ONCE per request: every containment check below is against
      // the real (symlink-resolved) uiDir, so an intermediate symlink dir can't escape.
      const canonicalUiDir = await realpathSafe(deps.uiDir);
      if (canonicalUiDir !== null) {
        const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;

        const resolved = resolveStaticPath(canonicalUiDir, requestPath);
        if (resolved === null) {
          sendJson(res, 400, { error: "invalid path" });
          return;
        }

        const result = await tryServeStaticFile(resolved, canonicalUiDir, res, log);
        if (result === "served") return;

        // SPA fallback: serve index.html only for a truly-missing path that looks
        // like a client route -- i.e. NO segment of the resolved-relative path carries
        // a file extension. Checking EVERY segment on the DECODED, resolved path (not
        // errno, not just the last segment) is deliberately cross-platform: it treats
        // `/missing.js`, `/missing%2ejs` (decoded), AND `/assets/app.js/foo` (a path
        // under a file -- ENOTDIR on POSIX but ENOENT on Windows) all as assets -> 404,
        // never a route. A "blocked" result (dir, symlink escape, oversize) is never
        // eligible either.
        const relSegments = resolved.slice(canonicalUiDir.length).split(sep);
        if (result === "missing" && !relSegments.some((s) => s.includes("."))) {
          const indexPath = resolveStaticPath(canonicalUiDir, "/index.html");
          if (indexPath !== null && (await tryServeStaticFile(indexPath, canonicalUiDir, res, log)) === "served") {
            return;
          }
        }
      }
    }

    sendJson(res, 404, { error: "not found" });
  }

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      log("ERROR", `api: unhandled error for ${req.method ?? "?"} ${req.url ?? "?"}: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  function broadcastChange(projectId: string, changedPath: string): void {
    const message = JSON.stringify({ type: "change", projectId, path: changedPath });
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }

  let boundPort = 0;

  return {
    get port(): number {
      return boundPort;
    },

    listen(port = 0, host?: string): Promise<number> {
      return new Promise((resolvePromise, reject) => {
        httpServer.once("error", reject);
        const onListening = (): void => {
          const addr = httpServer.address() as AddressInfo;
          boundPort = addr.port;
          resolvePromise(boundPort);
        };
        // Preserve exact prior behavior when host is omitted (tests rely on this):
        // call the 1-arg overload rather than passing `undefined` as a second arg.
        if (host !== undefined) httpServer.listen(port, host, onListening);
        else httpServer.listen(port, onListening);
      });
    },

    async close(): Promise<void> {
      // Terminate live WS connections first: http.Server#close only stops
      // accepting NEW connections and its callback waits for every existing
      // connection (including upgraded WS sockets) to end -- without this,
      // close() can hang the test runner (`[ts/test-hang]`).
      for (const client of clients) client.terminate();
      clients.clear();

      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      for (const w of watchers.values()) await w.handle.close();
      watchers.clear();
    },
  };
}
