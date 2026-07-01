import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestWorkerReport } from "./report.js";

// Real temp dirs (no real-fs faking here -- this module is deliberately
// fs-backed, see report.ts doc comment). Every dir created via mkdtemp is
// tracked and removed in afterEach, even on assertion failure.
const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDirs(): Promise<{ worktreePath: string; runtimeDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "autodev-report-"));
  cleanupDirs.push(base);
  const worktreePath = join(base, "worktree");
  const runtimeDir = join(base, "runtime");
  await mkdir(worktreePath, { recursive: true });
  return { worktreePath, runtimeDir };
}

describe("harvestWorkerReport", () => {
  it("moves an existing report from the worktree to the runtime dir", async () => {
    const { worktreePath, runtimeDir } = await makeTempDirs();
    const src = join(worktreePath, "worker-report.md");
    await writeFile(src, "status: DONE\n", "utf8");

    const moved = await harvestWorkerReport(worktreePath, runtimeDir);

    expect(moved).toBe(true);
    expect(existsSync(src)).toBe(false);
    const dest = join(runtimeDir, "worker-report.md");
    expect(existsSync(dest)).toBe(true);
    expect(await readFile(dest, "utf8")).toBe("status: DONE\n");
  });

  it("returns false and creates no dest file when the worktree has no report", async () => {
    const { worktreePath, runtimeDir } = await makeTempDirs();

    const moved = await harvestWorkerReport(worktreePath, runtimeDir);

    expect(moved).toBe(false);
    expect(existsSync(join(runtimeDir, "worker-report.md"))).toBe(false);
  });

  it("clears a stale runtime report when the worktree has no report (no carry-over)", async () => {
    const { worktreePath, runtimeDir } = await makeTempDirs();
    // A prior round/claim left a report in the runtime dir; this round the
    // worker wrote nothing into the worktree.
    await mkdir(runtimeDir, { recursive: true });
    const dest = join(runtimeDir, "worker-report.md");
    await writeFile(dest, "status: TOO_BIG\n", "utf8");

    const moved = await harvestWorkerReport(worktreePath, runtimeDir);

    expect(moved).toBe(false);
    // The stale dest must be gone -- otherwise the conductor would re-read the
    // prior round's status and mis-route the task.
    expect(existsSync(dest)).toBe(false);
  });

  it("creates the runtime dir if it does not exist yet", async () => {
    const { worktreePath, runtimeDir } = await makeTempDirs();
    await writeFile(join(worktreePath, "worker-report.md"), "status: DONE\n", "utf8");
    expect(existsSync(runtimeDir)).toBe(false);

    const moved = await harvestWorkerReport(worktreePath, runtimeDir);

    expect(moved).toBe(true);
    expect(existsSync(runtimeDir)).toBe(true);
  });
});
