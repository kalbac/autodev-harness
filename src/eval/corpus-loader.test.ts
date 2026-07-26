import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "./corpus-loader.js";
import type { CorpusCase } from "./corpus-case.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempCorpus(): string {
  const d = mkdtempSync(join(tmpdir(), "corpus-"));
  dirs.push(d);
  return d;
}

function validCase(id: string, over: Partial<CorpusCase> = {}): CorpusCase {
  return {
    schema: 1,
    id,
    type: "feature",
    intent: `do ${id}`,
    seed: "seeds/x",
    adversarial: false,
    expected: { outcome: "committed", escalation_type: null },
    rationale: "why",
    ...over,
  };
}

function write(dir: string, name: string, content: unknown): void {
  writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
}

describe("loadCorpus", () => {
  it("loads and validates every .json case, sorted by id", async () => {
    const dir = tempCorpus();
    write(dir, "b.json", validCase("bravo"));
    write(dir, "a.json", validCase("alpha"));

    const cases = await loadCorpus(dir);

    expect(cases.map((c) => c.id)).toEqual(["alpha", "bravo"]);
  });

  it("ignores non-.json files", async () => {
    const dir = tempCorpus();
    write(dir, "case.json", validCase("only"));
    write(dir, "README.md", "not a case");
    mkdirSync(join(dir, "seeds"));

    const cases = await loadCorpus(dir);

    expect(cases.map((c) => c.id)).toEqual(["only"]);
  });

  it("throws (fail-closed) on a schema-invalid case rather than skipping it", async () => {
    const dir = tempCorpus();
    write(dir, "bad.json", { ...validCase("bad"), type: "refactor" }); // unknown type

    await expect(loadCorpus(dir)).rejects.toThrow();
  });

  it("throws with the filename on invalid JSON", async () => {
    const dir = tempCorpus();
    write(dir, "broken.json", "{ not valid json ");

    await expect(loadCorpus(dir)).rejects.toThrow(/broken\.json/);
  });

  it("rejects duplicate case ids across files", async () => {
    const dir = tempCorpus();
    write(dir, "one.json", validCase("dup"));
    write(dir, "two.json", validCase("dup"));

    await expect(loadCorpus(dir)).rejects.toThrow(/duplicate id 'dup'/);
  });

  // codex R1: the ids are DIFFERENT strings but ONE directory on a case-insensitive
  // filesystem (Windows/macOS), which the per-case artifact archive names by id — the
  // second case's archive would clear the first's and both manifest entries would point at
  // the same diagnostics. Refused on every platform so a corpus loads identically
  // everywhere, not just where it happens to break.
  it("rejects two ids that collide case-insensitively", async () => {
    const dir = tempCorpus();
    write(dir, "one.json", validCase("Fix-A"));
    write(dir, "two.json", validCase("fix-a"));

    await expect(loadCorpus(dir)).rejects.toThrow(/case-insensitive collision with 'Fix-A'/);
  });

  it("returns an empty array for a corpus dir with no case files", async () => {
    const dir = tempCorpus();
    const cases = await loadCorpus(dir);
    expect(cases).toEqual([]);
  });
});
