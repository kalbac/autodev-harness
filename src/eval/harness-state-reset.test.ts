import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { resetHarnessState, PURGED_SUBDIRS } from "./harness-state-reset.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "adh-state-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

function seedState(): void {
  mkdirSync(join(stateDir, "queue", "escalated"), { recursive: true });
  writeFileSync(join(stateDir, "queue", "escalated", "leftover.md"), "# leftover");
  mkdirSync(join(stateDir, "runtime", "task-1"), { recursive: true });
  writeFileSync(join(stateDir, "runtime", "task-1", "evidence.json"), "{}");
  mkdirSync(join(stateDir, "escalations"), { recursive: true });
  writeFileSync(join(stateDir, "escalations", "task-1.md"), "# ESCALATION task-1");
  mkdirSync(join(stateDir, "runs"), { recursive: true });
  writeFileSync(join(stateDir, "runs", "run-1.json"), "{}");
  writeFileSync(join(stateDir, "digest.md"), "history\n");
}

describe("resetHarnessState", () => {
  it("removes the queue, runtime, and escalations subdirectories", async () => {
    seedState();

    const purged = await resetHarnessState(stateDir);

    expect(purged.sort()).toEqual([...PURGED_SUBDIRS].sort());
    expect(existsSync(join(stateDir, "queue"))).toBe(false);
    expect(existsSync(join(stateDir, "runtime"))).toBe(false);
    expect(existsSync(join(stateDir, "escalations"))).toBe(false);
  });

  // #131: a diagnostician reading one case's archive must never see another case's
  // escalation bodies mixed in -- the whole point of resetting the blackboard per case.
  it("purges the escalations subdirectory specifically, not just queue/runtime", async () => {
    seedState();

    await resetHarnessState(stateDir);

    expect(existsSync(join(stateDir, "escalations", "task-1.md"))).toBe(false);
  });

  it("leaves the history artifacts (digest, runs) alone", async () => {
    seedState();

    await resetHarnessState(stateDir);

    expect(existsSync(join(stateDir, "digest.md"))).toBe(true);
    expect(existsSync(join(stateDir, "runs", "run-1.json"))).toBe(true);
  });

  it("never removes the state directory itself", async () => {
    seedState();
    await resetHarnessState(stateDir);
    expect(existsSync(stateDir)).toBe(true);
  });

  it("is idempotent — an absent subdirectory is not an error", async () => {
    const purged = await resetHarnessState(stateDir);
    expect(purged).toEqual([]);
    await expect(resetHarnessState(stateDir)).resolves.toEqual([]);
  });

  it("unlinks a reparse point instead of recursing into its real target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-state-out-"));
    writeFileSync(join(outside, "precious.txt"), "do not delete");
    // 'junction' works without admin rights on Windows; a plain dir symlink on POSIX.
    symlinkSync(outside, join(stateDir, "runtime"), "junction");

    const purged = await resetHarnessState(stateDir);

    expect(purged).toEqual(["runtime"]);
    expect(existsSync(join(stateDir, "runtime"))).toBe(false);
    expect(readdirSync(outside)).toEqual(["precious.txt"]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a relative path", async () => {
    await expect(resetHarnessState(".autodev")).rejects.toThrow(/not an absolute path/);
  });

  it("refuses an empty path", async () => {
    await expect(resetHarnessState("   ")).rejects.toThrow(/not an absolute path/);
  });

  it("refuses a filesystem root", async () => {
    await expect(resetHarnessState(parse(stateDir).root)).rejects.toThrow(/filesystem root/);
  });

  it("refuses a path that only NORMALIZES to a filesystem root", async () => {
    const root = parse(stateDir).root;
    // `C:\work\..` is absolute and is not literally the root, but resolves to it — so a
    // check on the raw string would pass while `join` later targets `C:\queue`.
    await expect(resetHarnessState(join(root, "work", ".."))).rejects.toThrow(/filesystem root/);
  });

  it("refuses when the state directory itself is a reparse point", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-state-link-"));
    mkdirSync(join(outside, "queue"), { recursive: true });
    writeFileSync(join(outside, "queue", "precious.md"), "not ours");
    const linkParent = mkdtempSync(join(tmpdir(), "adh-state-lp-"));
    const link = join(linkParent, ".autodev");
    symlinkSync(outside, link, "junction");

    await expect(resetHarnessState(link)).rejects.toThrow(/not a real directory/);
    expect(existsSync(join(outside, "queue", "precious.md"))).toBe(true);

    rmSync(linkParent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses an absent state directory rather than treating it as nothing to do", async () => {
    await expect(resetHarnessState(join(stateDir, "does-not-exist"))).rejects.toThrow(/not a real directory/);
  });
});
