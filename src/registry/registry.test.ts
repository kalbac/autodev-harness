import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, addProject, removeProject, slugForName } from "./registry.js";

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

  it("removeProject removes by id and is a no-op for unknown ids", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "/a" }] };
    expect(removeProject(reg, "a").projects).toEqual([]);
    expect(removeProject(reg, "zz").projects).toEqual(reg.projects);
  });
});
