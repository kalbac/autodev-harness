import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./thread-store.js";

const noopLog = () => {};
let dir: string;
let store: ThreadStore;
let t = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threads-"));
  t = 1_000;
  store = new ThreadStore({ threadsRoot: join(dir, "threads"), log: noopLog, now: () => ++t });
});

describe("ThreadStore", () => {
  it("creates a thread with meta and lists it", async () => {
    const meta = await store.create({ id: "th-a", title: "Build X" });
    expect(meta.status).toBe("chatting");
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(["th-a"]);
  });

  it("appends entries and replays them in order with stamped ts", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "operator_msg", text: "hi" });
    await store.append("th-a", { type: "orchestrator_msg", text: "hello" });
    const read = await store.read("th-a");
    expect(read?.entries.map((e) => e.type)).toEqual(["operator_msg", "orchestrator_msg"]);
    expect(read!.entries[0]!.ts).toBeLessThan(read!.entries[1]!.ts);
  });

  it("readNdjson returns raw lines for SSE replay", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "run_link", runId: "run-1" });
    const raw = await store.readNdjson("th-a");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ type: "run_link", runId: "run-1" });
  });

  it("setMeta patches run_id + status", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.setMeta("th-a", { run_id: "run-1", status: "running" });
    const read = await store.read("th-a");
    expect(read?.meta).toMatchObject({ run_id: "run-1", status: "running" });
  });

  it("caps ndjson and appends exactly one truncation marker, then stops", async () => {
    const small = new ThreadStore({ threadsRoot: join(dir, "threads"), log: noopLog, now: () => ++t, maxBytes: 400 });
    await small.create({ id: "th-b", title: "X" });
    for (let i = 0; i < 50; i++) await small.append("th-b", { type: "operator_msg", text: `line ${i}` });
    const raw = await small.readNdjson("th-b");
    expect(raw).toContain("truncated");
    const before = raw.length;
    await small.append("th-b", { type: "operator_msg", text: "after cap" });
    expect((await small.readNdjson("th-b")).length).toBe(before);
  });

  it("append/read never throw on a missing thread (best-effort)", async () => {
    await expect(store.append("missing", { type: "operator_msg", text: "x" })).resolves.toBeUndefined();
    expect(await store.read("missing")).toBeNull();
  });

  it("rejects a path-unsafe id at create", async () => {
    await expect(store.create({ id: "../evil", title: "X" })).rejects.toThrow();
  });

  it("tolerates a corrupt ndjson line on replay (skips it)", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "operator_msg", text: "ok" });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "threads", "th-a", "thread.ndjson"), "{not json}\n");
    const read = await store.read("th-a");
    expect(read?.entries).toHaveLength(1);
  });
});
