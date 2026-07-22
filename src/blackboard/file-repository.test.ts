import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlackboardRepository } from "./file-repository.js";

let root: string;
let repo: FileBlackboardRepository;
function seedPending(id: string): void {
  const p = join(root, ".autodev", "queue", "pending");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, `${id}.md`), `---\nid: ${id}\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-bb-"));
  repo = new FileBlackboardRepository(root, ".autodev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("FileBlackboardRepository", () => {
  it("lists pending tasks parsed from files", async () => {
    seedPending("t1");
    const tasks = await repo.listTasks("pending");
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(tasks[0]!.file_set).toEqual(["src/x.ts"]);
  });

  it("moves a task atomically between queue states", async () => {
    seedPending("t1");
    await repo.moveTask("t1", "pending", "active");
    expect(existsSync(join(root, ".autodev", "queue", "pending", "t1.md"))).toBe(false);
    expect(existsSync(join(root, ".autodev", "queue", "active", "t1.md"))).toBe(true);
  });

  it("round-trips attempts counter", async () => {
    expect(await repo.getAttempts("t1")).toBe(0);
    await repo.setAttempts("t1", 2);
    expect(await repo.getAttempts("t1")).toBe(2);
  });

  it("markDone appends the committed marker to the done file", async () => {
    seedPending("t1");
    await repo.moveTask("t1", "pending", "done");
    await repo.markDone("t1", "abc1234");
    const txt = readFileSync(join(root, ".autodev", "queue", "done", "t1.md"), "utf8");
    expect(txt).toContain("<!-- committed: abc1234 -->");
  });

  it("appendDigest adds a line to digest.md", async () => {
    await repo.appendDigest("[anti-drift] ON-TRACK: fine");
    const txt = readFileSync(join(root, ".autodev", "digest.md"), "utf8");
    expect(txt).toContain("ON-TRACK: fine");
  });

  it("rejects task ids that attempt path traversal", async () => {
    // seed a file OUTSIDE the pending queue dir that a malicious id could reach
    const outside = join(root, ".autodev", "victim.md");
    mkdirSync(join(root, ".autodev"), { recursive: true });
    writeFileSync(outside, "---\nid: victim\n---\nbody");
    await expect(repo.moveTask("../../victim", "pending", "active")).rejects.toThrow(/unsafe task id/);
    expect(existsSync(outside)).toBe(true); // never moved out from under us

    // a normal id still works
    seedPending("t1");
    await repo.moveTask("t1", "pending", "active");
    expect(existsSync(join(root, ".autodev", "queue", "active", "t1.md"))).toBe(true);
  });

  it("rejects runtime file names that attempt path traversal, round-trips flat names", async () => {
    await expect(repo.writeRuntimeFile("t1", "../escape", "x")).rejects.toThrow();
    await repo.writeRuntimeFile("t1", "worker-report.md", "hello");
    expect(await repo.readRuntimeFile("t1", "worker-report.md")).toBe("hello");
  });

  it("listTasks returns [] when the queue dir was never created (no throw)", async () => {
    expect(await repo.listTasks("done")).toEqual([]);
  });

  describe("removeRuntimeFile", () => {
    it("removes an existing runtime file -- readRuntimeFile sees it gone (the CLEAR case)", async () => {
      await repo.writeRuntimeFile("t1", "gate-feedback.md", "some feedback");
      await repo.removeRuntimeFile("t1", "gate-feedback.md");
      expect(await repo.readRuntimeFile("t1", "gate-feedback.md")).toBeNull();
    });

    it("is a no-op when the file was never written (idempotent CLEAR, swallows ENOENT)", async () => {
      await expect(repo.removeRuntimeFile("t1", "never-written.md")).resolves.toBeUndefined();
    });

    it("propagates a non-ENOENT fs error instead of treating it as already-gone", async () => {
      // unlink() on a DIRECTORY is not ENOENT on any platform (EISDIR on Linux/Mac,
      // EPERM on Windows) -- this must NOT be swallowed the way a genuinely-absent
      // file is. Folding "could not delete it" into "it is already gone" is exactly
      // the fail-open this repo's errno discipline (oracle-paths.ts) exists to avoid.
      await repo.writeRuntimeFile("t1", "placeholder", "x"); // ensures runtimeDir exists
      mkdirSync(join(root, ".autodev", "runtime", "t1", "a-directory"));
      await expect(repo.removeRuntimeFile("t1", "a-directory")).rejects.toThrow();
    });

    it("rejects an unsafe runtime file name the same way writeRuntimeFile does", async () => {
      await expect(repo.removeRuntimeFile("t1", "../escape")).rejects.toThrow();
    });
  });
});
