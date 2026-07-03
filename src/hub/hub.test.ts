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
