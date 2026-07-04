import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdmin } from "./admin.js";
import { loadRegistry } from "./registry.js";

let base: string;
let registryFile: string;

/** A minimal fake git repo dir. */
function makeRepo(name: string): string {
  const p = join(base, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "adh-admin-"));
  registryFile = join(base, "registry", "projects.json");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("createProjectAdmin / register", () => {
  it("registers a valid git repo: entry saved, .autodev scaffolded by default", async () => {
    const repo = makeRepo("app");
    const admin = createProjectAdmin({ registryFile });

    const res = await admin.register({ path: repo });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.id).toBe("app");
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);

    const reg = await loadRegistry(registryFile);
    expect(reg.projects.map((p) => p.id)).toEqual(["app"]);
  });

  it("scaffold: false registers without touching the repo", async () => {
    const repo = makeRepo("bare");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, scaffold: false });
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo, ".autodev"))).toBe(false);
  });

  it("passes the config form through to the scaffolded config.yaml", async () => {
    const repo = makeRepo("cfg");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { gate: { checkCommand: "npm test" } } });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toContain("npm test");
  });

  it("rejects a nonexistent path with invalid_path", async () => {
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: join(base, "nope") });
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a non-git dir with not_a_git_repo", async () => {
    const p = join(base, "plain");
    mkdirSync(p);
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: p });
    expect(res).toMatchObject({ ok: false, code: "not_a_git_repo" });
  });

  it("rejects a duplicate path with already_registered (second call, same canonical path)", async () => {
    const repo = makeRepo("dup");
    const admin = createProjectAdmin({ registryFile });
    expect((await admin.register({ path: repo })).ok).toBe(true);
    const res = await admin.register({ path: repo });
    expect(res).toMatchObject({ ok: false, code: "already_registered" });
  });

  it("rejects an invalid config form with invalid_config and does NOT register", async () => {
    const repo = makeRepo("badcfg");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { roles: { worker: { ladder: [] } } } });
    expect(res).toMatchObject({ ok: false, code: "invalid_config" });
    expect((await loadRegistry(registryFile)).projects).toEqual([]);
    expect(existsSync(join(repo, ".autodev"))).toBe(false); // scaffold wrote nothing
  });

  it("rejects an unknown config key with invalid_config (strict form)", async () => {
    const repo = makeRepo("unknownkey");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { totallyUnknown: 1 } });
    expect(res).toMatchObject({ ok: false, code: "invalid_config" });
  });

  it("registers a repo that already has .autodev/config.yaml WITHOUT clobbering it (scaffold self-skips)", async () => {
    const repo = makeRepo("existing");
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "# mine\n");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toBe("# mine\n");
  });

  it("two CONCURRENT registers of different repos both land (mutex — no lost write)", async () => {
    const r1 = makeRepo("one");
    const r2 = makeRepo("two");
    const admin = createProjectAdmin({ registryFile });
    const [a, b] = await Promise.all([admin.register({ path: r1 }), admin.register({ path: r2 })]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const reg = await loadRegistry(registryFile);
    expect(reg.projects.map((p) => p.id).sort()).toEqual(["one", "two"]);
  });

  it("two CONCURRENT registers of the SAME repo: exactly one wins", async () => {
    const repo = makeRepo("race");
    const admin = createProjectAdmin({ registryFile });
    const results = await Promise.all([admin.register({ path: repo }), admin.register({ path: repo })]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.code === "already_registered").length).toBe(1);
    expect((await loadRegistry(registryFile)).projects.length).toBe(1);
  });
});

describe("createProjectAdmin / unregister", () => {
  it("removes the entry and returns true; the project folder is untouched", async () => {
    const repo = makeRepo("gone");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");

    expect(await admin.unregister(reg.entry.id)).toBe(true);
    expect((await loadRegistry(registryFile)).projects).toEqual([]);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true); // folder untouched
  });

  it("returns false for an unknown id", async () => {
    const admin = createProjectAdmin({ registryFile });
    expect(await admin.unregister("nope")).toBe(false);
  });
});

describe("createProjectAdmin / rename", () => {
  it("renames a registered project: ok+entry, on-disk name updated, id/path preserved", async () => {
    const repo = makeRepo("ren");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");

    const res = await admin.rename(reg.entry.id, "My Renamed Project");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry).toMatchObject({ id: reg.entry.id, name: "My Renamed Project", path: reg.entry.path });

    const onDisk = await loadRegistry(registryFile);
    expect(onDisk.projects).toEqual([{ id: reg.entry.id, name: "My Renamed Project", path: reg.entry.path }]);
  });

  it("trims surrounding whitespace before storing", async () => {
    const repo = makeRepo("trim");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");

    const res = await admin.rename(reg.entry.id, "  spaced  ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.name).toBe("spaced");
    expect((await loadRegistry(registryFile)).projects[0]!.name).toBe("spaced");
  });

  it("empty/whitespace-only name -> invalid_name, on-disk name unchanged", async () => {
    const repo = makeRepo("empty");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");
    const before = (await loadRegistry(registryFile)).projects[0]!.name;

    const res = await admin.rename(reg.entry.id, "   ");
    expect(res).toMatchObject({ ok: false, code: "invalid_name" });
    expect((await loadRegistry(registryFile)).projects[0]!.name).toBe(before);
  });

  it("unknown id -> not_found, registry unchanged", async () => {
    const repo = makeRepo("known");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");
    const before = await loadRegistry(registryFile);

    const res = await admin.rename("nope", "Whatever");
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(await loadRegistry(registryFile)).toEqual(before);
  });

  it("a name over 200 chars -> invalid_name", async () => {
    const repo = makeRepo("toolong");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");

    const res = await admin.rename(reg.entry.id, "x".repeat(201));
    expect(res).toMatchObject({ ok: false, code: "invalid_name" });
  });
});

describe("createProjectAdmin / isRegistered", () => {
  it("reflects registry membership by canonical path", async () => {
    const repo = makeRepo("member");
    const admin = createProjectAdmin({ registryFile });
    expect(await admin.isRegistered(repo)).toBe(false);
    await admin.register({ path: repo });
    expect(await admin.isRegistered(repo)).toBe(true);
  });
});
