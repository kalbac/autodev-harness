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
});
