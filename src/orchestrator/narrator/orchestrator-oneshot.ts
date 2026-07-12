import spawn from "cross-spawn";
import { parseChatWireLine } from "../chat-wire.js";

/** Defensive cap on an un-newlined stdout remainder — mirrors
 *  `claude-chat-process.ts`'s MAX_REMAINDER_BYTES, but a one-shot run is
 *  short-lived (not killed on overflow, just prevents unbounded buffer
 *  growth from a single runaway line — the run keeps going to completion). */
const MAX_REMAINDER_BYTES = 1_000_000;

// A plain callable matching cross-spawn's call signature (not `typeof spawn`,
// which also carries `.spawn`/`.sync` static properties that a test's bare
// fake-child factory has no need to implement).
export type OneShotSpawnFn = (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>;

export interface RunOneShotInput {
  exe: string;
  cwd: string;
  /** Caller-supplied model + isolation flags; this fn appends the stream-json
   *  output flags and the prompt itself. */
  args: string[];
  prompt: string;
  /** Invoked for every intermediate text token of the run (live-typing UI). */
  onToken: (text: string) => void;
  /** Injectable for tests; production uses cross-spawn (Windows `.cmd`-shim safe). */
  spawnFn?: OneShotSpawnFn;
}

/**
 * Spawns ONE `claude -p` streaming child, forwards text deltas to `onToken`,
 * and resolves with the full reply once the run finishes. Unlike
 * `ClaudeChatProcess` (a long-lived multi-turn session), this is a single
 * fire-and-forget call: the process is expected to exit on its own once the
 * turn completes, so a `close` with no `turn-done` event still resolves
 * (with whatever text was accumulated) instead of being treated as an error.
 */
export function runOrchestratorOneShot(input: RunOneShotInput): Promise<string> {
  const spawnFn = input.spawnFn ?? spawn;
  const args = [...input.args, "-p", "--output-format", "stream-json", "--verbose", input.prompt];

  return new Promise<string>((resolve, reject) => {
    const child = spawnFn(input.exe, args, { cwd: input.cwd, env: process.env });

    let remainder = "";
    let full = "";
    let settled = false;

    const settle = (text: string): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };

    child.stdout?.on("data", (chunk: string | Buffer) => {
      remainder += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl: number;
      while ((nl = remainder.indexOf("\n")) !== -1) {
        const line = remainder.slice(0, nl).trim();
        remainder = remainder.slice(nl + 1);
        if (line.length === 0) continue;
        const event = parseChatWireLine(line);
        if (event.kind === "token") {
          full += event.text;
          input.onToken(event.text);
        } else if (event.kind === "turn-done") {
          settle(event.replyText || full);
        }
      }
      if (remainder.length > MAX_REMAINDER_BYTES) {
        remainder = "";
      }
    });

    child.stderr?.on("data", () => {});

    // EPIPE guard, same as claude-chat-process.ts: a fast-exiting child can
    // close its stdin read end before a write lands.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", () => {
      settle(full);
    });
  });
}
