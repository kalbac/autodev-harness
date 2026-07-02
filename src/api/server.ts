/**
 * Thin `http` + `ws` server over `BlackboardRepository` -- the P2 seam
 * (plan Task 27). Deliberately kept read-only plus one reply endpoint for
 * P1: it does not claim, move, or write tasks, and it never adds methods
 * to `BlackboardRepository` (a frozen seam shared with the conductor's
 * test-fakes -- see `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`
 * Task 27). `digest.md` and `escalations/` are read/written directly under
 * `stateDir` via `node:fs/promises`, exactly like `src/index.ts` wires the
 * escalate module.
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
import { open, stat, lstat, writeFile, mkdir, readdir, type FileHandle } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { watch as chokidarWatch } from "chokidar";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";

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
 * Hard cap on a single `<stateDir>/runs/*.json` manifest read. A manifest is our own
 * small index ({runId,intent,taskIds,at}); a file over this cap is corrupt/hostile and
 * is SKIPPED (best-effort) rather than read whole -- bounding memory before `JSON.parse`
 * so `GET /runs` can never be OOM'd by a poisoned oversized manifest.
 */
const MAX_RUN_MANIFEST_BYTES = 256 * 1024;

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

export interface ApiServerDeps {
  repo: BlackboardRepository;
  /** Absolute path to the stateDir (e.g. <repoRoot>/.autodev). digest.md + escalations/ live under here. */
  stateDir: string;
  /** Injected watcher factory so tests can drive change events without a real fs watch.
   *  Default (production) uses chokidar watching `stateDir`. Must be swappable. */
  watchFactory?: (stateDir: string, onChange: (path: string) => void) => { close(): Promise<void> | void };
  /** Injected clock for the reply timestamp (default () => Date.now()). Keeps tests deterministic. */
  now?: () => number;
  log?: (level: string, message: string) => void;
}

export interface ApiServerHandle {
  /** Starts listening; resolves with the actual bound port (0 => OS-assigned ephemeral port). */
  listen(port?: number): Promise<number>;
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
 *  `<stateDir>/runs/<runId>.json`. */
interface RunManifest {
  runId: string;
  intent: string;
  taskIds: string[];
  at: number;
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
    Number.isFinite(v.at)
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

  async function handleState(res: ServerResponse): Promise<void> {
    const queues = {} as Record<QueueState, Awaited<ReturnType<BlackboardRepository["listTasks"]>>>;
    for (const state of QUEUE_STATES) {
      queues[state] = await deps.repo.listTasks(state);
    }

    const digestPath = join(deps.stateDir, "digest.md");
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

  async function handleReply(rawId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const escalationsDir = join(deps.stateDir, "escalations");
    await mkdir(escalationsDir, { recursive: true });
    await writeFile(join(escalationsDir, `${id}.reply.json`), JSON.stringify(reply, null, 2), "utf8");
    log("INFO", `api: recorded escalation reply ${id} -> ${choice}`);

    sendJson(res, 200, reply);
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
  async function listRunManifests(): Promise<RunManifest[]> {
    const runsDir = join(deps.stateDir, "runs");
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

  async function handleListRuns(res: ServerResponse): Promise<void> {
    sendJson(res, 200, await listRunManifests());
  }

  async function handleGetRun(rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    // Same TOCTOU-hardened bounded read as the list path. A missing / oversized /
    // malformed / poisoned manifest is treated as absent (-> 404), never a 500 over
    // an on-disk file the orchestrator (or an operator) may still be writing.
    const manifest = await readBoundedManifest(join(deps.stateDir, "runs", `${id}.json`));
    if (!manifest) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    sendJson(res, 200, manifest);
  }

  async function handleListRuntimeFiles(rawId: string, res: ServerResponse): Promise<void> {
    const id = decodeSegment(rawId);
    if (id === null || !safeIdSegment(id)) {
      sendJson(res, 400, { error: "invalid task id" });
      return;
    }
    const dir = deps.repo.runtimeDir(id);
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

  async function handleReadRuntimeFile(rawId: string, rawName: string, res: ServerResponse): Promise<void> {
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

    const filePath = join(deps.repo.runtimeDir(id), name);

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

    if (req.method === "GET" && url.pathname === "/state") {
      await handleState(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      await handleListRuns(res);
      return;
    }

    const runMatch = /^\/runs\/([^/]+)\/?$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      await handleGetRun(runMatch[1]!, res);
      return;
    }

    const runtimeFileMatch = /^\/tasks\/([^/]+)\/runtime\/([^/]+)\/?$/.exec(url.pathname);
    if (req.method === "GET" && runtimeFileMatch) {
      await handleReadRuntimeFile(runtimeFileMatch[1]!, runtimeFileMatch[2]!, res);
      return;
    }

    const runtimeListMatch = /^\/tasks\/([^/]+)\/runtime\/?$/.exec(url.pathname);
    if (req.method === "GET" && runtimeListMatch) {
      await handleListRuntimeFiles(runtimeListMatch[1]!, res);
      return;
    }

    const replyMatch = /^\/escalations\/([^/]+)\/reply\/?$/.exec(url.pathname);
    if (req.method === "POST" && replyMatch) {
      await handleReply(replyMatch[1]!, req, res);
      return;
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

  function broadcastChange(changedPath: string): void {
    const message = JSON.stringify({ type: "change", path: changedPath });
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }

  const watcher = watchFactory(deps.stateDir, broadcastChange);

  let boundPort = 0;

  return {
    get port(): number {
      return boundPort;
    },

    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          const addr = httpServer.address() as AddressInfo;
          boundPort = addr.port;
          resolve(boundPort);
        });
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
      await watcher.close();
    },
  };
}
