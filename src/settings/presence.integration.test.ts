import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "./settings.js";
import { shouldSupervise } from "../composition/root.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-presence-int-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("presence read-through", () => {
  it("a toggle written to disk is visible to the very next read (no cache)", async () => {
    const file = join(dir, "settings.json");
    const presence = async () => (await loadSettings(file)).overnight.enabled;

    expect(await shouldSupervise(presence, true)).toBe(false); // no file yet
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await shouldSupervise(presence, true)).toBe(true); // same reader, no rebuild
    await saveSettings(file, { overnight: { enabled: false } });
    expect(await shouldSupervise(presence, true)).toBe(false);
  });

  it("a project that has not opted in never supervises, whatever the global flag says", async () => {
    const file = join(dir, "settings.json");
    await saveSettings(file, { overnight: { enabled: true } });
    const presence = async () => (await loadSettings(file)).overnight.enabled;
    expect(await shouldSupervise(presence, false)).toBe(false);
  });

  it("a corrupt settings file degrades to attended rather than autonomous", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, "{corrupt", "utf8");
    const presence = async () => (await loadSettings(file)).overnight.enabled;
    expect(await shouldSupervise(presence, true)).toBe(false);
  });
});
