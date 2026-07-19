import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countOptedIn } from "./opt-in-count.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-optin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(name: string, yaml: string | null): Promise<string> {
  const p = join(dir, name);
  await mkdir(join(p, ".autodev"), { recursive: true });
  if (yaml !== null) await writeFile(join(p, ".autodev", "config.yaml"), yaml, "utf8");
  return p;
}

describe("countOptedIn", () => {
  it("counts only projects whose config opts in", async () => {
    const a = await project("a", "autonomy:\n  overnight:\n    enabled: true\n");
    const b = await project("b", "autonomy:\n  overnight:\n    enabled: false\n");
    const c = await project("c", "stateDir: .autodev\n");
    expect(await countOptedIn([a, b, c])).toEqual({ optedIn: 1, total: 3 });
  });

  it("counts an unreadable or missing config as NOT opted in, without throwing", async () => {
    const a = await project("a", "autonomy:\n  overnight:\n    enabled: true\n");
    const b = await project("b", null);
    const c = await project("c", "\t: not: valid: yaml\n");
    expect(await countOptedIn([a, b, c])).toEqual({ optedIn: 1, total: 3 });
  });

  it("returns zeroes for an empty registry", async () => {
    expect(await countOptedIn([])).toEqual({ optedIn: 0, total: 0 });
  });
});
