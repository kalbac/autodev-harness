/**
 * Daemon-global settings (spec 2026-07-19). Operator PRESENCE lives here, not in
 * any project's config: presence is a property of the operator (ADR-004 tenet 5),
 * while `autonomy.overnight.enabled` in a project's `.autodev/config.yaml` stays
 * the per-project opt-in. Overnight autonomy runs on the AND of the two.
 *
 * Sibling of `~/.autodev/projects.json`; same never-throws discipline as
 * `registry.ts` -- a daemon must not die over a bad settings file, and every
 * ambiguity resolves toward PRESENCE (attended), i.e. toward LESS unattended spend.
 */
import { readFile, writeFile, mkdir, rename, lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

type Log = (level: string, message: string) => void;

/** `.strict()` at every level: an unknown/misspelled key must fail LOUDLY rather
 *  than load clean while silently reverting every real field to a default
 *  (gotcha [config/zod-strict]). An object (not a bare boolean) leaves room for a
 *  later `until` field as an ADDITIVE change. */
export const GlobalSettingsSchema = z
  .object({
    overnight: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
  })
  .strict();

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const DEFAULT_SETTINGS: GlobalSettings = { overnight: { enabled: false } };

/** Default location, mirroring the registry's `AUTODEV_REGISTRY` escape hatch
 *  (`src/index.ts`) so tests can point at a temp dir. */
export function defaultSettingsFile(homeDir: string): string {
  return process.env["AUTODEV_SETTINGS"] ?? join(homeDir, ".autodev", "settings.json");
}

/**
 * Load global settings. NEVER throws. A missing file is the normal first-run case
 * -> silent defaults. Anything else (unreadable, corrupt JSON, schema violation)
 * -> defaults + one ERROR log, so the daemon keeps serving and the operator can
 * see why the toggle reads off.
 */
export async function loadSettings(file: string, log?: Log): Promise<GlobalSettings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.("ERROR", `settings: failed reading ${file}: ${String(err)} — using defaults`);
    }
    return DEFAULT_SETTINGS;
  }
  try {
    return GlobalSettingsSchema.parse(JSON.parse(text));
  } catch (err) {
    log?.("ERROR", `settings: invalid ${file} — using defaults (${String(err)})`);
    return DEFAULT_SETTINGS;
  }
}

/** Serializes writes so two concurrent PATCHes cannot interleave. One daemon,
 *  one tiny file -- a promise chain is the same primitive `ProjectAdmin` uses. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Write settings atomically (tmp + rename). Refuses when the target exists and is
 * not a regular file -- a symlinked/directory `settings.json` would otherwise be
 * followed transparently ([scaffold/config-file-symlink]: a dir-level guard does
 * not transfer to a single-file write shape).
 */
export async function saveSettings(file: string, settings: GlobalSettings): Promise<void> {
  const run = async (): Promise<void> => {
    const stats = await lstat(file).catch(() => null);
    if (stats !== null && !stats.isFile()) {
      throw new Error(`settings: ${file} exists but is not a regular file — refusing to write`);
    }
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // The tmp path needs the SAME guard as the target: a stale `.tmp` symlink
    // would be followed transparently and clobber whatever it points at. `rm`
    // unlinks the symlink itself (it does not follow), which also clears a stale
    // tmp left by a crashed write; `wx` then refuses to write through anything
    // that reappeared in between. Deliberately NOT `recursive`: a directory
    // sitting at the tmp path is an anomaly that must fail LOUDLY, not get
    // silently deleted -- recursive removal is destructive behaviour this write
    // path has no business performing.
    await rm(tmp, { force: true });
    await writeFile(tmp, JSON.stringify(GlobalSettingsSchema.parse(settings), null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tmp, file);
  };
  const next = writeChain.then(run, run);
  // Keep the chain alive after a rejection so one failed write can't wedge later ones.
  writeChain = next.catch(() => undefined);
  return next;
}
