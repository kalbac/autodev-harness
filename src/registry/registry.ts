import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** One registered project. Identity ONLY — all project truth (roles, gate,
 *  provision, …) stays in the project's own `.autodev/config.yaml`
 *  (spec §3a; frozen-skeleton axis 1: file-blackboard = truth). */
export interface RegistryEntry {
  /** Stable kebab-case slug; appears in URLs and WS events. Never changes after registration. */
  id: string;
  /** Display name (renameable). */
  name: string;
  /** Absolute path to the project repo root. */
  path: string;
}

export interface Registry {
  projects: RegistryEntry[];
}

type Log = (level: string, message: string) => void;

/** Allowed id charset -- mirrors the API's `VALID_ID_SEGMENT` so an id from a
 *  hand-edited file is always route-matchable (a weird id would otherwise become
 *  unreachable/ambiguous once `safeIdSegment` filters it at the HTTP layer). */
const VALID_ID = /^[A-Za-z0-9_-]+$/;

function isEntry(v: unknown): v is RegistryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.name === "string" && typeof e.path === "string";
}

/**
 * Load the registry. NEVER throws: a missing file is an empty registry; a
 * corrupt file is an empty registry + a loud ERROR log (`serve` must not crash
 * over a bad registry); malformed entries are dropped individually so one bad
 * entry can't hide the rest.
 */
export async function loadRegistry(file: string, log?: Log): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { projects: [] }; // missing (or unreadable) -> empty; registration recreates it
  }
  try {
    const parsed = JSON.parse(text) as { projects?: unknown };
    const raw = Array.isArray(parsed.projects) ? parsed.projects : [];
    // Harden against a hand-edited file: drop entries whose id is malformed
    // (unroutable) or duplicated (would collide in hub/watcher/single-flight
    // state). First entry wins; every drop is logged so the operator sees why.
    const seen = new Set<string>();
    const projects: RegistryEntry[] = [];
    for (const entry of raw) {
      if (!isEntry(entry)) continue;
      if (!VALID_ID.test(entry.id)) {
        log?.("WARN", `registry: dropping entry with invalid id ${JSON.stringify(entry.id)} (must match ${VALID_ID.source})`);
        continue;
      }
      if (seen.has(entry.id)) {
        log?.("WARN", `registry: dropping duplicate id ${JSON.stringify(entry.id)} (first entry wins)`);
        continue;
      }
      seen.add(entry.id);
      projects.push(entry);
    }
    return { projects };
  } catch (err) {
    log?.("ERROR", `registry: corrupt ${file} — starting with an empty registry (${String(err)})`);
    return { projects: [] };
  }
}

/** Write the registry, creating parent dirs. Plain overwrite — the registry is
 *  tiny, single-writer (the daemon), and identity-only; losing it is recoverable
 *  by re-registering. */
export async function saveRegistry(file: string, registry: Registry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/** Kebab-case slug of `name`, uniquified against `taken` with `-2`, `-3`, …. */
export function slugForName(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Pure: append a new project (id derived from the folder name). Throws on a duplicate path. */
export function addProject(registry: Registry, input: { path: string; name?: string }): { registry: Registry; entry: RegistryEntry } {
  if (registry.projects.some((p) => p.path === input.path)) {
    throw new Error(`registry: path already registered: ${input.path}`);
  }
  const name = input.name ?? basename(input.path);
  const id = slugForName(name, registry.projects.map((p) => p.id));
  const entry: RegistryEntry = { id, name, path: input.path };
  return { registry: { projects: [...registry.projects, entry] }, entry };
}

/** Pure: remove by id (no-op for unknown ids). Never touches the project folder. */
export function removeProject(registry: Registry, id: string): Registry {
  return { projects: registry.projects.filter((p) => p.id !== id) };
}
