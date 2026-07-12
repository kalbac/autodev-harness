/**
 * Fail-closed logging helpers for best-effort paths (gotcha [ts/fail-closed]).
 *
 * A catch block that stringifies an error via `String((err as Error).message)`
 * can itself throw when `message` (or `toString`) is a hostile getter; and a
 * logger passed in from outside can throw too. Both would turn a best-effort
 * cleanup path into a hard failure. These helpers coerce and log defensively so
 * nothing escapes the catch.
 */

/** Coerce any thrown value to a string without ever throwing. */
export function safeErrorText(err: unknown): string {
  try {
    if (err && typeof err === "object" && "message" in err) {
      const m = (err as { message: unknown }).message;
      return typeof m === "string" ? m : String(m);
    }
    return String(err);
  } catch {
    return "<unprintable error>";
  }
}

/** Invoke `log` swallowing any throw — a logger that throws must never break a
 *  best-effort path. */
export function safeLog(
  log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void,
  level: "INFO" | "WARN" | "ERROR",
  msg: string,
): void {
  try {
    log(level, msg);
  } catch {
    /* a logger that throws must never break a best-effort path */
  }
}
