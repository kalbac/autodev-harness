import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import {
  archiveCaseArtifacts,
  conductorLogOffset,
  ARCHIVED_SUBDIRS,
  ARCHIVED_LOG_SLICE,
} from "./case-archive.js";
import { PURGED_SUBDIRS } from "./harness-state-reset.js";

let stateDir: string;
let artifacts: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "adh-arch-state-"));
  artifacts = mkdtempSync(join(tmpdir(), "adh-arch-out-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(artifacts, { recursive: true, force: true });
});

function seedState(): void {
  mkdirSync(join(stateDir, "runtime", "task-1"), { recursive: true });
  writeFileSync(join(stateDir, "runtime", "task-1", "evidence.json"), '{"outcome":"escalated"}');
  writeFileSync(join(stateDir, "runtime", "task-1", "critic-verdict.json"), '{"verdict":"uncertain"}');
  mkdirSync(join(stateDir, "queue", "escalated"), { recursive: true });
  writeFileSync(join(stateDir, "queue", "escalated", "task-1.md"), "# task-1");
  mkdirSync(join(stateDir, "runs"), { recursive: true });
  writeFileSync(join(stateDir, "runs", "run-1.json"), "{}");
  writeFileSync(join(stateDir, "digest.md"), "history\n");
}

const req = (over: Partial<Parameters<typeof archiveCaseArtifacts>[0]> = {}) => ({
  stateDirAbs: stateDir,
  artifactsRoot: artifacts,
  caseId: "good-bugfix",
  logFromByte: 0,
  ...over,
});

describe("archiveCaseArtifacts", () => {
  it("copies every purged subdirectory into the case's archive directory", async () => {
    seedState();

    const result = await archiveCaseArtifacts(req());

    expect(result.dest).toBe(join(artifacts, "good-bugfix"));
    expect(result.copied).toContain("runtime/task-1/evidence.json");
    expect(result.copied).toContain("runtime/task-1/critic-verdict.json");
    expect(result.copied).toContain("queue/escalated/task-1.md");
    expect(readFileSync(join(result.dest, "runtime", "task-1", "evidence.json"), "utf8")).toBe(
      '{"outcome":"escalated"}',
    );
  });

  // The archive list is DERIVED from the purge list rather than restated, so extending the
  // purge cannot silently start destroying something the archive never learned to keep.
  it("archives exactly what the purge destroys", () => {
    expect([...ARCHIVED_SUBDIRS]).toEqual([...PURGED_SUBDIRS]);
  });

  it("does not copy state the purge leaves alone", async () => {
    seedState();

    const result = await archiveCaseArtifacts(req());

    expect(existsSync(join(result.dest, "runs"))).toBe(false);
    expect(existsSync(join(result.dest, "digest.md"))).toBe(false);
  });

  it("archives only the conductor.log slice written since the case began", async () => {
    seedState();
    writeFileSync(join(stateDir, "conductor.log"), "PREVIOUS CASE\n");
    const offset = await conductorLogOffset(stateDir);
    writeFileSync(join(stateDir, "conductor.log"), "PREVIOUS CASE\nTHIS CASE\n");

    const result = await archiveCaseArtifacts(req({ logFromByte: offset }));

    expect(readFileSync(join(result.dest, ARCHIVED_LOG_SLICE), "utf8")).toBe("THIS CASE\n");
    expect(result.copied).toContain(ARCHIVED_LOG_SLICE);
  });

  it("reports a zero offset for a state directory with no log yet", async () => {
    expect(await conductorLogOffset(stateDir)).toBe(0);
  });

  // A clamped offset would archive an EMPTY slice, which reads exactly like a case that
  // produced no log at all. Diagnostics fail toward more information, and the substitution
  // is named rather than silent.
  it("archives the whole log and says so when it was truncated below the offset", async () => {
    writeFileSync(join(stateDir, "conductor.log"), "short\n");

    const result = await archiveCaseArtifacts(req({ logFromByte: 9999 }));

    expect(readFileSync(join(result.dest, ARCHIVED_LOG_SLICE), "utf8")).toBe("short\n");
    expect(result.skipped.join(" ")).toMatch(/truncated below the 9999-byte start offset/);
  });

  it("skips a symlinked entry instead of following it out of the state directory", async () => {
    seedState();
    const outside = mkdtempSync(join(tmpdir(), "adh-arch-outside-"));
    writeFileSync(join(outside, "secret.txt"), "do not copy me");
    try {
      symlinkSync(join(outside, "secret.txt"), join(stateDir, "runtime", "link.txt"), "file");
    } catch {
      return; // unprivileged Windows cannot create symlinks; the guard is proven on POSIX/CI
    }

    const result = await archiveCaseArtifacts(req());

    expect(result.copied).not.toContain("runtime/link.txt");
    expect(result.skipped).toContain("runtime/link.txt (symlink -- not followed)");
    expect(existsSync(join(result.dest, "runtime", "link.txt"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  // A directory carrying half of one run and half of another is worse than no archive:
  // the reader cannot tell which case wrote which file.
  it("replaces a previous run's archive for the same case", async () => {
    mkdirSync(join(artifacts, "good-bugfix", "runtime"), { recursive: true });
    writeFileSync(join(artifacts, "good-bugfix", "runtime", "stale.json"), "{}");
    seedState();

    const result = await archiveCaseArtifacts(req());

    expect(existsSync(join(result.dest, "runtime", "stale.json"))).toBe(false);
    expect(existsSync(join(result.dest, "runtime", "task-1", "evidence.json"))).toBe(true);
  });

  it("creates an empty archive rather than failing when the case produced nothing", async () => {
    const result = await archiveCaseArtifacts(req());

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(result.dest)).toBe(true);
  });

  it("refuses a case id that is not a path-safe segment", async () => {
    await expect(archiveCaseArtifacts(req({ caseId: "../escape" }))).rejects.toThrow(/not a path-safe segment/);
    await expect(archiveCaseArtifacts(req({ caseId: `a${sep}b` }))).rejects.toThrow(/not a path-safe segment/);
  });

  it("refuses a relative or empty artifacts root", async () => {
    await expect(archiveCaseArtifacts(req({ artifactsRoot: "relative/out" }))).rejects.toThrow(
      /not an absolute path/,
    );
    await expect(archiveCaseArtifacts(req({ artifactsRoot: "   " }))).rejects.toThrow(/not an absolute path/);
  });

  it("refuses the filesystem root as the artifacts root", async () => {
    await expect(archiveCaseArtifacts(req({ artifactsRoot: parse(artifacts).root }))).rejects.toThrow(
      /filesystem root/,
    );
  });

  it("refuses a relative state directory", async () => {
    await expect(archiveCaseArtifacts(req({ stateDirAbs: ".autodev" }))).rejects.toThrow(/not an absolute path/);
  });
});
