/**
 * How many registered projects have opted in to overnight autonomy.
 *
 * Reads each project's `.autodev/config.yaml` DIRECTLY rather than building
 * composition roots: `hub.list()` deliberately never forces a build (hub.ts:16-18),
 * and forcing N roots just to render a count would be a real cost. The narrow
 * duplication is deliberate -- it reads one field and treats EVERY failure as
 * not-opted-in, so drift can only ever under-report, never claim autonomy that
 * is not armed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface OptInCount {
  optedIn: number;
  total: number;
}

async function optedIn(repoRoot: string): Promise<boolean> {
  try {
    const text = await readFile(join(repoRoot, ".autodev", "config.yaml"), "utf8");
    const doc = parseYaml(text) as { autonomy?: { overnight?: { enabled?: unknown } } } | null;
    return doc?.autonomy?.overnight?.enabled === true;
  } catch {
    return false;
  }
}

export async function countOptedIn(repoRoots: readonly string[]): Promise<OptInCount> {
  const flags = await Promise.all(repoRoots.map(optedIn));
  return { optedIn: flags.filter(Boolean).length, total: repoRoots.length };
}
