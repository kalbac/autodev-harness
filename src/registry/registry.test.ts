import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, addProject, removeProject, renameProject, slugForName, isPathRegistered, type Registry } from "./registry.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adh-registry-"));
  file = join(dir, "sub", "projects.json"); // parent dir does NOT exist yet
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadRegistry", () => {
  it("missing file -> empty registry, no throw", async () => {
    expect(await loadRegistry(file)).toEqual({ projects: [] });
  });

  it("round-trips through saveRegistry (creates parent dirs)", async () => {
    const reg = { projects: [{ id: "aurora", name: "aurora", path: "D:/Projects/aurora" }] };
    await saveRegistry(file, reg);
    expect(await loadRegistry(file)).toEqual(reg);
  });

  it("missing file logs NOTHING (ENOENT is the normal no-registry case)", async () => {
    const logs: string[] = [];
    const reg = await loadRegistry(file, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg).toEqual({ projects: [] });
    expect(logs).toEqual([]);
  });

  it("a non-ENOENT read failure -> empty registry + WARN log (readFile on a directory -> EISDIR)", async () => {
    // Point loadRegistry at a DIRECTORY: readFile on a dir fails with EISDIR on all
    // platforms -- a non-ENOENT error that must be logged, not silently empty.
    const logs: string[] = [];
    const reg = await loadRegistry(dir, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg).toEqual({ projects: [] });
    expect(logs.some((l) => l.startsWith("WARN:") && l.includes("failed reading"))).toBe(true);
  });

  it("corrupt JSON -> empty registry + loud log, no throw", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, "{ nope", "utf8");
    const logs: string[] = [];
    const reg = await loadRegistry(file, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg).toEqual({ projects: [] });
    expect(logs.some((l) => l.startsWith("ERROR:"))).toBe(true);
  });

  it("valid JSON with wrong shape (entries missing fields) -> those entries dropped", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, JSON.stringify({ projects: [{ id: "ok", name: "ok", path: "/p" }, { id: 5 }, "x"] }), "utf8");
    const reg = await loadRegistry(file);
    expect(reg.projects).toEqual([{ id: "ok", name: "ok", path: "/p" }]);
  });

  it("drops an entry whose id is malformed (unroutable) and logs a WARN", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ projects: [{ id: "../x", name: "evil", path: "/p" }, { id: "ok", name: "ok", path: "/q" }] }),
      "utf8",
    );
    const logs: string[] = [];
    const reg = await loadRegistry(file, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg.projects).toEqual([{ id: "ok", name: "ok", path: "/q" }]);
    expect(logs.some((l) => l.startsWith("WARN:") && l.includes("invalid id"))).toBe(true);
  });

  it("drops a duplicate id (first entry wins) and logs a WARN", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        projects: [
          { id: "app", name: "first", path: "/first" },
          { id: "app", name: "second", path: "/second" },
        ],
      }),
      "utf8",
    );
    const logs: string[] = [];
    const reg = await loadRegistry(file, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg.projects).toEqual([{ id: "app", name: "first", path: "/first" }]);
    expect(logs.some((l) => l.startsWith("WARN:") && l.includes("duplicate id"))).toBe(true);
  });
});

describe("slugForName", () => {
  it("kebab-cases and strips non-alphanumerics", () => {
    expect(slugForName("Woodev Framework!", [])).toBe("woodev-framework");
  });

  it("uniquifies with a numeric suffix on collision", () => {
    expect(slugForName("aurora", ["aurora"])).toBe("aurora-2");
    expect(slugForName("aurora", ["aurora", "aurora-2"])).toBe("aurora-3");
  });

  it("falls back to 'project' for a name with no usable characters", () => {
    expect(slugForName("!!!", [])).toBe("project");
  });
});

describe("addProject / removeProject (pure)", () => {
  it("addProject derives id from the folder name and appends", () => {
    const { registry, entry } = addProject({ projects: [] }, { path: "D:/Projects/My App" });
    expect(entry).toEqual({ id: "my-app", name: "My App", path: "D:/Projects/My App" });
    expect(registry.projects).toEqual([entry]);
  });

  it("addProject rejects an already-registered path", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "D:/Projects/a" }] };
    expect(() => addProject(reg, { path: "D:/Projects/a" })).toThrow(/already registered/);
  });

  // Duplicate-path detection canonicalizes the path (resolve + win32 case-fold),
  // so different spellings of the SAME repo can't register twice.
  const caseFoldIt = process.platform === "win32" ? it : it.skip;
  caseFoldIt("win32: rejects a case-differing spelling of an already-registered path", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "D:\\Projects\\App" }] };
    expect(() => addProject(reg, { path: "d:\\projects\\app" })).toThrow(/already registered/);
  });

  it("rejects a resolve-differing spelling of the same path on all platforms (redundant './' segment)", () => {
    const base = process.platform === "win32" ? "C:\\Projects\\App" : "/proj/app";
    const dupWithDot = process.platform === "win32" ? "C:\\Projects\\.\\App" : "/proj/./app";
    const reg = { projects: [{ id: "a", name: "a", path: base }] };
    expect(() => addProject(reg, { path: dupWithDot })).toThrow(/already registered/);
  });

  it("removeProject removes by id and is a no-op for unknown ids", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "/a" }] };
    expect(removeProject(reg, "a").projects).toEqual([]);
    expect(removeProject(reg, "zz").projects).toEqual(reg.projects);
  });
});

describe("renameProject (pure)", () => {
  it("renames the matching entry's name; id+path preserved, other entries untouched, input not mutated", () => {
    const reg: Registry = {
      projects: [
        { id: "a", name: "Alpha", path: "/a" },
        { id: "b", name: "Beta", path: "/b" },
      ],
    };
    const result = renameProject(reg, "a", "Alpha Renamed");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.entry).toEqual({ id: "a", name: "Alpha Renamed", path: "/a" });
    expect(result.registry.projects).toEqual([
      { id: "a", name: "Alpha Renamed", path: "/a" },
      { id: "b", name: "Beta", path: "/b" },
    ]);
    // input not mutated
    expect(reg.projects[0]).toEqual({ id: "a", name: "Alpha", path: "/a" });
    expect(result.registry).not.toBe(reg);
    expect(result.registry.projects).not.toBe(reg.projects);
  });

  it("returns null for an unknown id", () => {
    const reg: Registry = { projects: [{ id: "a", name: "Alpha", path: "/a" }] };
    expect(renameProject(reg, "zz", "Nope")).toBeNull();
    // input untouched
    expect(reg.projects).toEqual([{ id: "a", name: "Alpha", path: "/a" }]);
  });
});

describe("isPathRegistered", () => {
  it("is true for an exact registered path and false for an unregistered one", () => {
    const registry: Registry = { projects: [{ id: "a", name: "a", path: join(dir, "a") }] };
    expect(isPathRegistered(registry, join(dir, "a"))).toBe(true);
    expect(isPathRegistered(registry, join(dir, "b"))).toBe(false);
  });

  it("normalizes redundant path segments before comparing", () => {
    const p = join(dir, "a");
    const registry: Registry = { projects: [{ id: "a", name: "a", path: p }] };
    expect(isPathRegistered(registry, join(dir, ".", "a"))).toBe(true);
  });

  it("case-folds on win32 only", () => {
    const p = join(dir, "CaseDir");
    const registry: Registry = { projects: [{ id: "a", name: "a", path: p }] };
    const flipped = p.toLowerCase();
    expect(isPathRegistered(registry, flipped)).toBe(process.platform === "win32");
  });
});
