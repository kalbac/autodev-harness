import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CorpusCaseSchema } from "./corpus-case.js";
import type { CorpusCase } from "./corpus-case.js";

/**
 * Load and validate every `*.json` case in a corpus directory, sorted by id. Fail-closed
 * (mirrors the schema's own doctrine): a malformed case DEFINITION — invalid JSON, a schema
 * violation, or a duplicate id — throws and aborts the load, because a corpus you cannot
 * fully trust must not be measured against. (This is distinct from a case EXECUTION failure
 * at run time, which the runner turns into a null-evidence result rather than an abort.)
 * Non-`.json` entries (seed fixtures, READMEs) are ignored.
 */
export async function loadCorpus(dir: string): Promise<CorpusCase[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name)
    .sort();

  const cases: CorpusCase[] = [];
  const seenIds = new Map<string, string>(); // id -> file that first declared it

  for (const name of files) {
    const raw = await readFile(join(dir, name), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`corpus case ${name}: invalid JSON -- ${detail}`);
    }

    let c: CorpusCase;
    try {
      c = CorpusCaseSchema.parse(parsed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`corpus case ${name}: schema validation failed -- ${detail}`);
    }

    const prior = seenIds.get(c.id);
    if (prior !== undefined) {
      throw new Error(`corpus case ${name}: duplicate id '${c.id}' (already declared in ${prior})`);
    }
    seenIds.set(c.id, name);
    cases.push(c);
  }

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cases;
}
