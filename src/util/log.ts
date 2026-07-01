import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Minimal structured logger: `(level, message) => void`. Never throws. */
export type Logger = (level: string, message: string) => void;

/**
 * Tees `[<ISO timestamp>] [<LEVEL>] <message>` lines to console + best-effort
 * appends them to `logFilePath`. A logging I/O failure (missing dir, locked
 * file, full disk, ...) must NEVER throw and break the caller's control flow.
 */
export function createLogger(logFilePath: string): Logger {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
  } catch {
    // best-effort — an unwritable log dir must not block startup
  }

  return (level: string, message: string): void => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    console.log(line);
    try {
      appendFileSync(logFilePath, line + "\n");
    } catch {
      // best-effort — a logging I/O failure must never throw
    }
  };
}
