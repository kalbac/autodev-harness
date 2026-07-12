/**
 * Res-decoupled CORE of the `POST /orchestrate` / `POST /chat/confirm` launch
 * path (extracted from `launchOrchestrate` in `src/api/server.ts`, R1 boundary
 * per adr/003 -- the only enforcement touch remains `onOrchestrate`). This
 * module has NO knowledge of `http.ServerResponse`: it decides accept/reject,
 * performs the single-flight `inFlight` bookkeeping, and fires the
 * fire-and-forget background run -- so a non-HTTP caller (e.g. a "launch by
 * word" chat-turn trigger) can reach the SAME launch semantics without a
 * `ServerResponse` to write to. `src/api/server.ts`'s `launchOrchestrate`
 * becomes a thin wrapper: it calls `performLaunch`, then maps the
 * `LaunchResult` onto the EXACT status codes / error bodies the original
 * inline implementation sent.
 */

export type LaunchResult = { accepted: true } | { accepted: false; reason: "in_flight" | "unsupported" };

export interface PerformLaunchInput {
  pid: string;
  intent: string;
  /** Matches `ProjectView.onOrchestrate?: (intent: string) => Promise<unknown>` --
   *  widened to `Promise<unknown> | void` so both the real server closure and a
   *  bare `async () => {}` test stub satisfy it. */
  onOrchestrate: ((intent: string) => Promise<unknown> | void) | undefined;
  inFlight: Set<string>;
  log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
}

/** Flatten a value for single-line logging: collapse CR/LF/control chars to spaces
 *  and truncate, so an operator-supplied `intent` cannot forge extra log lines or
 *  bloat the log. Deliberately duplicated from `src/api/server.ts`'s helper of the
 *  same name (rather than imported) so this module stays free of an import edge
 *  back into `api/server.ts` -- it is meant to be reusable by non-HTTP callers. */
function flattenForLog(s: string, max = 200): string {
  const flat = Array.from(s, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f ? " " : ch;
  })
    .join("")
    .replace(/ {2,}/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Fail-closed error -> string: never throws, even on an `Error` whose `message`
 *  getter or a value whose `toString` throws (gotcha `[ts/fail-closed]`). Duplicated
 *  from `src/api/server.ts`'s helper of the same name for the same reason as
 *  `flattenForLog` above. */
function safeErrorText(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return "<unstringifiable error>";
  }
}

/**
 * Decides whether a launch is accepted, and if so fires it in the background.
 *
 * Single-flight (per project id): `pid` is added to `inFlight` synchronously
 * before returning `{accepted:true}`, so a concurrent call for the SAME `pid`
 * gets `{accepted:false, reason:"in_flight"}`. `pid` is removed in the
 * background chain's `finally`, regardless of success, rejection, or a
 * SYNCHRONOUS throw from `onOrchestrate` -- the `Promise.resolve().then(...)`
 * wrapper normalizes a sync throw into a rejection so it can never escape this
 * function's synchronous frame. `log` calls are wrapped fail-closed (a broken
 * logger must never crash the post-accept background path), and a terminal
 * `.catch` backstops the whole chain so nothing from it can ever surface as an
 * unhandled rejection.
 */
export async function performLaunch(input: PerformLaunchInput): Promise<LaunchResult> {
  const { pid, intent, onOrchestrate, inFlight, log } = input;

  if (!onOrchestrate) {
    return { accepted: false, reason: "unsupported" };
  }
  if (inFlight.has(pid)) {
    return { accepted: false, reason: "in_flight" };
  }
  inFlight.add(pid);

  const safeIntent = flattenForLog(intent);
  const safeLog = (level: "INFO" | "WARN" | "ERROR", message: string): void => {
    try {
      log(level, message);
    } catch {
      /* a broken logger must never crash the post-accept background path */
    }
  };

  void Promise.resolve()
    .then(() => onOrchestrate(intent))
    .then(() => safeLog("INFO", `api: orchestrate run completed for intent: ${safeIntent}`))
    .catch((err: unknown) =>
      safeLog("ERROR", `api: orchestrate run failed for intent "${safeIntent}": ${safeErrorText(err)}`),
    )
    .finally(() => {
      inFlight.delete(pid);
    })
    .catch(() => {
      /* terminal backstop: nothing from this chain may surface as an unhandled rejection */
    });

  return { accepted: true };
}
