import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./settings.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-settings-"));
  file = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("returns defaults for a missing file, without logging", async () => {
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs).toEqual([]);
  });

  it("returns defaults + an ERROR log for corrupt JSON", async () => {
    await writeFile(file, "{not json", "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("returns defaults + an ERROR log when the shape violates the schema", async () => {
    await writeFile(file, JSON.stringify({ overnight: { enabled: "yes" } }), "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("rejects an unknown top-level key loudly instead of silently reverting", async () => {
    await writeFile(file, JSON.stringify({ overnite: { enabled: true } }), "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("round-trips a saved value", async () => {
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });
});

describe("saveSettings", () => {
  it("creates parent directories", async () => {
    const nested = join(dir, "deep", "settings.json");
    await saveSettings(nested, { overnight: { enabled: true } });
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual({ overnight: { enabled: true } });
  });

  it("refuses to write when the target exists but is not a regular file", async () => {
    await mkdir(file);
    await expect(saveSettings(file, { overnight: { enabled: true } })).rejects.toThrow(/not a regular file/i);
  });

  it("overwrites a stale tmp file left behind by a crashed write", async () => {
    await writeFile(`${file}.tmp`, "junk from a crashed write", "utf8");
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });

  it("never follows a symlinked tmp path (the guard covers tmp, not just the target)", async () => {
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "do not clobber", "utf8");
    try {
      symlinkSync(victim, `${file}.tmp`, "file");
    } catch {
      // Windows without Developer Mode cannot create file symlinks; the guard is
      // still proven on POSIX CI (the matrix runs ubuntu-latest too).
      return;
    }
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await readFile(victim, "utf8")).toBe("do not clobber");
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });

  it("serializes concurrent writes (last write wins, no interleaving)", async () => {
    await Promise.all([
      saveSettings(file, { overnight: { enabled: true } }),
      saveSettings(file, { overnight: { enabled: false } }),
      saveSettings(file, { overnight: { enabled: true } }),
    ]);
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });
});
