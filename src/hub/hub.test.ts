import { describe, it, expect } from "vitest";
import { createProjectHub } from "./hub.js";
import type { RegistryEntry } from "../registry/registry.js";

const entries: RegistryEntry[] = [
  { id: "a", name: "A", path: "/proj/a" },
  { id: "b", name: "B", path: "/proj/b" },
];

function makeHub(buildRoot: (e: RegistryEntry) => Promise<unknown>) {
  return createProjectHub({
    loadEntries: async () => entries,
    // The hub is generic over the root type; tests use a plain marker object.
    buildRoot: buildRoot as never,
  });
}

describe("createProjectHub", () => {
  it("get() builds lazily and caches: one build per project across calls", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      return { marker: e.id };
    });
    const r1 = await hub.get("a");
    const r2 = await hub.get("a");
    expect(r1).toEqual({ root: { marker: "a" } });
    expect(r2).toEqual({ root: { marker: "a" } });
    expect(builds).toBe(1);
  });

  it("evict() drops the cached root so the NEXT get() rebuilds -- contrast with the no-evict case above", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      return { marker: e.id };
    });
    expect(await hub.get("a")).toEqual({ root: { marker: "a" } });
    expect(builds).toBe(1);

    hub.evict("a");

    expect(await hub.get("a")).toEqual({ root: { marker: "a" } });
    expect(builds).toBe(2); // rebuilt, even though the path didn't change
  });

  it("get() on an unknown id -> null (never builds)", async () => {
    let builds = 0;
    const hub = makeHub(async () => {
      builds++;
      return {};
    });
    expect(await hub.get("zz")).toBeNull();
    expect(builds).toBe(0);
  });

  it("a failing build isolates to that project and is retried on the next get()", async () => {
    let attempts = 0;
    const hub = makeHub(async (e) => {
      if (e.id === "a") {
        attempts++;
        if (attempts === 1) throw new Error("bad config.yaml");
        return { marker: "a-fixed" };
      }
      return { marker: e.id };
    });
    const fail = await hub.get("a");
    expect(fail).toEqual({ error: expect.stringContaining("bad config.yaml") as string });
    // Sibling project unaffected:
    expect(await hub.get("b")).toEqual({ root: { marker: "b" } });
    // Retry after the config is fixed:
    expect(await hub.get("a")).toEqual({ root: { marker: "a-fixed" } });
  });

  it("concurrent get() for the same id builds once (in-flight promise is shared)", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      await new Promise((r) => setTimeout(r, 10));
      return { marker: e.id };
    });
    const [r1, r2] = await Promise.all([hub.get("a"), hub.get("a")]);
    expect(r1).toEqual(r2);
    expect(builds).toBe(1);
  });

  it("concurrent callers of a failing build all receive {error}, never an escaped rejection", async () => {
    let attempts = 0;
    const hub = makeHub(async (e) => {
      if (e.id === "a") {
        attempts++;
        await new Promise((r) => setTimeout(r, 10)); // both callers are in-flight together
        throw new Error("build blew up");
      }
      return { marker: e.id };
    });
    // Two concurrent get()s: the first starts the build, the second piggy-backs on
    // the in-flight promise via the cached branch. BOTH must resolve to {error} --
    // the second's await must NOT reject out of get() (that would 500 instead of 503).
    const [r1, r2] = await Promise.all([hub.get("a"), hub.get("a")]);
    expect(r1).toEqual({ error: expect.stringContaining("build blew up") as string });
    expect(r2).toEqual({ error: expect.stringContaining("build blew up") as string });
    expect(attempts).toBe(1); // the two concurrent callers shared ONE build

    // The failed build is not cached -> a later get() retries (build attempted again).
    const r3 = await hub.get("a");
    expect(r3).toEqual({ error: expect.stringContaining("build blew up") as string });
    expect(attempts).toBe(2);
  });

  it("invalidates a cached root when the registry entry's path changes", async () => {
    // A MUTABLE entries array simulates a hand-edited registry: the same id "a"
    // is later pointed at a different path.
    const mutable: RegistryEntry[] = [{ id: "a", name: "A", path: "/proj/a-old" }];
    let builds = 0;
    const hub = createProjectHub({
      loadEntries: async () => mutable,
      buildRoot: (async (e: RegistryEntry) => {
        builds++;
        return { marker: e.path };
      }) as never,
    });

    expect(await hub.get("a")).toEqual({ root: { marker: "/proj/a-old" } });
    expect(builds).toBe(1);
    expect(await hub.list()).toEqual([{ id: "a", name: "A", path: "/proj/a-old", status: "ready" }]);

    // Registry edited: id "a" now points at a different repo.
    mutable[0] = { id: "a", name: "A", path: "/proj/a-new" };
    // Before the rebuild, the moved project shows "unbuilt" -- NOT "ready" for the old root.
    expect(await hub.list()).toEqual([{ id: "a", name: "A", path: "/proj/a-new", status: "unbuilt" }]);

    // Next get() rebuilds for the NEW path (build count increments, marker reflects it).
    expect(await hub.get("a")).toEqual({ root: { marker: "/proj/a-new" } });
    expect(builds).toBe(2);
  });

  it("a moved project does not inherit the old path's error -- lastError is keyed by path, not just id", async () => {
    // A MUTABLE entries array simulates a hand-edited registry: id "a" fails to
    // build at its original path, then the registry re-points it elsewhere.
    const mutable: RegistryEntry[] = [{ id: "a", name: "A", path: "/proj/a" }];
    const hub = createProjectHub({
      loadEntries: async () => mutable,
      buildRoot: (async (e: RegistryEntry) => {
        if (e.path === "/proj/a") throw new Error("bad config at /proj/a");
        return { marker: e.path };
      }) as never,
    });

    // Build fails at /proj/a -> lastError set for "a", tagged with that path.
    const fail = await hub.get("a");
    expect(fail).toEqual({ error: expect.stringContaining("bad config at /proj/a") as string });
    expect(await hub.list()).toEqual([{ id: "a", name: "A", path: "/proj/a", status: "error", error: "bad config at /proj/a" }]);

    // Registry edited: id "a" now points at a different (working) path -- BEFORE
    // any rebuild is attempted. list() must show "unbuilt", NOT "error" carrying
    // the old path's message under the new path.
    mutable[0] = { id: "a", name: "A", path: "/proj/a-new" };
    expect(await hub.list()).toEqual([{ id: "a", name: "A", path: "/proj/a-new", status: "unbuilt" }]);

    // A successful get() at the new path yields the root and list() reports "ready".
    expect(await hub.get("a")).toEqual({ root: { marker: "/proj/a-new" } });
    expect(await hub.list()).toEqual([{ id: "a", name: "A", path: "/proj/a-new", status: "ready" }]);
  });

  it("list() returns entries + build status without forcing builds", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      return { marker: e.id };
    });
    expect(await hub.list()).toEqual([
      { id: "a", name: "A", path: "/proj/a", status: "unbuilt" },
      { id: "b", name: "B", path: "/proj/b", status: "unbuilt" },
    ]);
    expect(builds).toBe(0);
    await hub.get("a");
    expect(await hub.list()).toEqual([
      { id: "a", name: "A", path: "/proj/a", status: "ready" },
      { id: "b", name: "B", path: "/proj/b", status: "unbuilt" },
    ]);
  });
});
