import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArtifactsRootSafe } from "./artifacts-root.js";

let repo: string;
let outside: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adh-ar-repo-"));
  outside = mkdtempSync(join(tmpdir(), "adh-ar-out-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** A scripted git: maps the first arg to a canned result, records what was asked. */
function fakeGit(script: Partial<Record<string, { exitCode: number; stdout?: string; stderr?: string }>>) {
  const asked: string[][] = [];
  const git = async (args: string[]) => {
    asked.push(args);
    const r = script[args[0]!] ?? { exitCode: 1 };
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { git, asked };
}

describe("assertArtifactsRootSafe", () => {
  it("accepts a root outside the repo without asking git anything", async () => {
    const { git, asked } = fakeGit({});

    await assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(outside, "artifacts"), git });

    expect(asked).toEqual([]);
  });

  it("creates the root so the containment question has a determinate answer", async () => {
    const target = join(outside, "deep", "artifacts");
    const { git } = fakeGit({});

    await assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: target, git });

    expect(existsSync(target)).toBe(true);
  });

  it("accepts a root inside the repo when git reports it ignored and untracked", async () => {
    const { git, asked } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 0, stdout: "" } });

    await assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, ".autodev", "art"), git });

    expect(asked.map((a) => a[0])).toEqual(["check-ignore", "ls-files"]);
  });

  it("refuses a root inside the repo that git does not ignore", async () => {
    const { git } = fakeGit({ "check-ignore": { exitCode: 1 } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "some-data"), git }),
    ).rejects.toThrow(/is NOT ignored/);
  });

  // codex R2: the first version ASSUMED anything under `.autodev` was git-excluded because
  // the harness "requires" it, and never verified. Being under the state directory earns no
  // exemption here — the question is always put to git.
  it("gives the state directory no exemption from the ignore check", async () => {
    const { git } = fakeGit({ "check-ignore": { exitCode: 1 } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, ".autodev", "corpus-artifacts"), git }),
    ).rejects.toThrow(/is NOT ignored/);
  });

  // "git could not answer" is a refusal, not a pass (Principle 10).
  it("refuses when git check-ignore cannot answer", async () => {
    const { git } = fakeGit({ "check-ignore": { exitCode: 128, stderr: "fatal: not a git repository" } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/could not answer \(exit 128/);
  });

  // codex R3: an ignored directory does not untrack what is already tracked inside it, and
  // git reports a tracked file as modified regardless of ignore rules — so "ignored" alone
  // was not the whole question.
  it("refuses an ignored root that already contains tracked files", async () => {
    const { git } = fakeGit({
      "check-ignore": { exitCode: 0 },
      "ls-files": { exitCode: 0, stdout: "art/corpus-run.json\nart/keep.txt\n" },
    });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/contains 2 TRACKED file\(s\).*corpus-run\.json/s);
  });

  // codex R3: `realpathContains` folds "outside the root" and "could not resolve" into one
  // `false`, and the first version read that as "outside the repo, therefore safe" — the
  // fold-cannot-determine-into-no fail-open. Resolution failure must be a refusal.
  it("refuses when the repo root cannot be resolved at all", async () => {
    const { git } = fakeGit({});

    await expect(
      assertArtifactsRootSafe({
        repoRoot: join(repo, "does-not-exist"),
        artifactsRoot: join(outside, "art"),
        git,
      }),
    ).rejects.toThrow(/cannot resolve the repo root/);
  });

  // A junction/symlink root must be judged by where it REALLY lands, not by how its path
  // reads — otherwise it looks outside the repo while writing inside it.
  it("follows a symlinked root to its real location before judging it", async () => {
    const realInside = join(repo, "real-artifacts");
    mkdirSync(realInside, { recursive: true });
    const link = join(outside, "looks-outside");
    try {
      symlinkSync(realInside, link, "junction");
    } catch {
      return; // unprivileged Windows cannot create links; proven on POSIX/CI
    }
    const { git } = fakeGit({ "check-ignore": { exitCode: 1 } });

    await expect(assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: link, git })).rejects.toThrow(
      /is NOT ignored/,
    );
  });

  it("treats a tracked-file listing that git could not produce as no listing", async () => {
    // `ls-files --error-unmatch` exits non-zero when nothing matches; that is the NORMAL
    // "no tracked files here" answer, not an error to refuse on.
    writeFileSync(join(repo, "unrelated.txt"), "x");
    const { git } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 1, stderr: "did not match" } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).resolves.toBeUndefined();
  });
});
