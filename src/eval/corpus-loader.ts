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
  // Keyed by the CASE-FOLDED id, because the id names a directory and Windows/macOS
  // filesystems are case-insensitive: `Fix-A` and `fix-a` are two distinct cases by this
  // check but ONE directory on disk, so the second case's archive would clear the first's
  // and both manifest entries would point at the same diagnostics (codex R1). Comparing
  // ids in one normalization while USING them in another is the recurring defect shape of
  // docs/gotchas/validated-one-string-used-another.md — so the comparison is folded here,
  // once, rather than at each use site. Folding is deliberately stricter than any single
  // platform: a corpus must load identically everywhere, so a collision is refused even on
  // a case-SENSITIVE filesystem where it would technically work.
  const seenIds = new Map<string, { id: string; file: string }>();

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

    const folded = c.id.toLowerCase();
    const prior = seenIds.get(folded);
    if (prior !== undefined) {
      const how = prior.id === c.id ? "duplicate" : `case-insensitive collision with '${prior.id}'`;
      throw new Error(`corpus case ${name}: ${how} id '${c.id}' (already declared in ${prior.file})`);
    }
    seenIds.set(folded, { id: c.id, file: name });
    cases.push(c);
  }

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cases;
}
