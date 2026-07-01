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
import { open, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** Signals that a request body exceeded `MAX_BODY_BYTES` (mapped to HTTP 413). */
class PayloadTooLargeError extends Error {}

/**
 * Positive allowlist for an escalation id. Real ids are kebab/underscore task slugs
 * (e.g. `s7-t1-model-tiering`) or `drift-<ms>` -- all within this set. Stricter than a
 * traversal denylist: it also blocks `:` (Windows alternate-data-stream syntax),
 * control characters, and newlines (log forging), which a `/`+`\`+`..`+NUL denylist
 * would let through.
 */
const VALID_ESCALATION_ID = /^[A-Za-z0-9_-]+$/;

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
 * Guard against path traversal / separator injection in an escalation id --
 * mirrors `FileBlackboardRepository.safePathSegment`. Checked AFTER
 * percent-decoding so an encoded `..` or `/` cannot slip past the route's
 * single-segment match.
 */
function safeEscalationId(id: string): boolean {
  return VALID_ESCALATION_ID.test(id);
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
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
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

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/state") {
      await handleState(res);
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
