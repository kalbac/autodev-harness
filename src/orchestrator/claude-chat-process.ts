import spawn from "cross-spawn";
import { parseChatWireLine } from "./chat-wire.js";

/** Grace between SIGTERM and the escalated SIGKILL (POSIX; Windows kills
 *  forcefully on the first signal). Mirrors `util/native.ts`. */
const SIGKILL_GRACE_MS = 2000;

/** Defensive cap on an un-newlined stdout remainder — mirrors
 *  `detect/agent-extensions.ts`'s MAX_REMAINDER_BYTES, but a chat session is
 *  long-lived (not killed on overflow, just prevents unbounded buffer growth
 *  from a single runaway line — the session keeps running). */
const MAX_REMAINDER_BYTES = 1_000_000;

// A plain callable matching cross-spawn's call signature (not `typeof spawn`,
// which also carries `.spawn`/`.sync` static properties that a test's bare
// fake-child factory has no need to implement).
export type SpawnFn = (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>;

export interface ClaudeChatProcessDeps {
  exe: string;
  cwd: string;
  args: string[];
  /** Invoked for every intermediate text token of the CURRENT turn (live-typing UI). */
  onToken: (text: string) => void;
  /** Injectable for tests; production uses cross-spawn (Windows `.cmd`-shim safe). */
  spawnFn?: SpawnFn;
}

export interface ChatTurnOutcome {
  replyText: string;
  isError: boolean;
}

/**
 * Wraps ONE live `claude -p --input-format stream-json --output-format
 * stream-json --replay-user-messages` child for a chat session's whole
 * lifetime. Verified live (2026-07-08, see plan header): the process accepts
 * multiple sequential user turns written to stdin and streams
 * `content_block_delta` tokens + a terminal `result` event per turn, keeping
 * the same `session_id` throughout; it only exits when stdin is closed or
 * killed.
 *
 * Exactly one `send()` may be in flight at a time — the chat is
 * single-threaded per session by construction (the UI disables input while
 * awaiting a reply), so a concurrent `send()` is a caller bug, not a race to
 * handle gracefully.
 */
export class ClaudeChatProcess {
  private readonly child: ReturnType<SpawnFn>;
  private readonly onToken: (text: string) => void;
  private remainder = "";
  private pending: { resolve: (o: ChatTurnOutcome) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(deps: ClaudeChatProcessDeps) {
    this.onToken = deps.onToken;
    const spawnFn = deps.spawnFn ?? spawn;
    this.child = spawnFn(deps.exe, deps.args, { cwd: deps.cwd, env: process.env });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.handleChunk(chunk));
    // EPIPE guard, same as util/native.ts: a fast-exiting child can close its
    // stdin read end before a write lands.
    this.child.stdin?.on("error", () => {});
    this.child.on("error", (err: Error) => this.failPending(err));
    this.child.on("close", () => this.failPending(new Error("chat process exited unexpectedly")));
  }

  private handleChunk(chunk: string): void {
    this.remainder += chunk;
    let nl: number;
    while ((nl = this.remainder.indexOf("\n")) !== -1) {
      const line = this.remainder.slice(0, nl).trim();
      this.remainder = this.remainder.slice(nl + 1);
      if (line.length === 0) continue;
      const event = parseChatWireLine(line);
      if (event.kind === "token") {
        this.onToken(event.text);
      } else if (event.kind === "turn-done") {
        const p = this.pending;
        this.pending = null;
        p?.resolve({ replyText: event.replyText, isError: event.isError });
      }
    }
    // A single un-newlined runaway line must not grow this buffer forever —
    // unlike the kill-on-overflow probe in agent-extensions.ts, a long-lived
    // chat session just drops the overflowed partial line and keeps running
    // (dropping one malformed line is preferable to killing an otherwise-live
    // conversation).
    if (this.remainder.length > MAX_REMAINDER_BYTES) {
      this.remainder = "";
    }
  }

  private failPending(err: Error): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  /** Send one operator turn. Rejects if a turn is already in flight or the
   *  process has been closed. Resolves with the full reply once the matching
   *  `result` event arrives (intermediate tokens go to `onToken`, not here). */
  send(text: string): Promise<ChatTurnOutcome> {
    if (this.closed) return Promise.reject(new Error("chat process is closed"));
    if (this.pending) return Promise.reject(new Error("a turn is already in flight"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      const line = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      this.child.stdin?.write(`${line}\n`, (err?: Error | null) => {
        if (err) this.failPending(err);
      });
    });
  }

  /** Tear the process down: SIGTERM, escalate to SIGKILL after a grace period
   *  if it ignores that (mirrors `util/native.ts`), and end stdin. Any turn
   *  still in flight is rejected immediately (the caller must not be left
   *  hanging on a session that is being torn down). Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error("chat session closed"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, SIGKILL_GRACE_MS);
    try {
      this.child.stdin?.end();
    } catch {
      /* already gone */
    }
  }
}
