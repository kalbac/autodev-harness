import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, posix, sep, win32 } from "node:path";
import { assertArtifactsRootSafe, toRepoRelativePathspec } from "./artifacts-root.js";

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
    // The subcommand is not args[0] any more: every invocation is prefixed with
    // `--literal-pathspecs`, so the fake finds the first arg that is not a global flag. This
    // mirrors how the real git CLI reads it, rather than assuming a position.
    const sub = args.find((a) => !a.startsWith("-"))!;
    const r = script[sub] ?? { exitCode: 1 };
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
    // `ls-files --error-unmatch` exit 1 IS "nothing tracked here" — measured against real git.
    const { git, asked } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 1 } });

    await assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, ".autodev", "art"), git });

    expect(asked.map((a) => a.find((x) => !x.startsWith("-")))).toEqual(["check-ignore", "ls-files"]);

    // The invocation shapes are pinned EXACTLY, because the two commands do not accept the
    // same flags and the difference is load-bearing (#135, second half — found by running
    // the corpus, not by a test):
    //   - `ls-files` takes `--literal-pathspecs`: a path is data, never a pattern (codex R6).
    //   - `check-ignore` REJECTS it outright -- `fatal: pathspec magic not supported by this
    //     command: 'literal'`, exit 128, measured on a colon-free relative path -- so passing
    //     it made this guard unanswerable on every platform, not just Windows.
    // Both are protected instead by the `./` prefix `toRepoRelativePathspec` emits.
    const [ignoreArgs, lsArgs] = asked;
    expect(ignoreArgs).toEqual(["check-ignore", "--quiet", "--", "./.autodev/art"]);
    expect(lsArgs).toEqual(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", "./.autodev/art"]);
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

  // MEASURED against real git: `--error-unmatch` exits 1 when nothing matches (the normal,
  // safe answer) and 128 on a fatal error. Exit 1 must pass.
  it("treats ls-files exit 1 as the normal 'nothing tracked here' answer", async () => {
    writeFileSync(join(repo, "unrelated.txt"), "x");
    const { git } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 1, stderr: "did not match" } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).resolves.toBeUndefined();
  });

  // codex R4: folding 128 into "nothing tracked" let a BROKEN repository authorize writing
  // inside its own work tree -- the third appearance of fold-cannot-determine-into-no in this
  // review cycle. Only exit 1 is an answer; 128 is a refusal.
  it("refuses when ls-files fails fatally rather than reading it as 'nothing tracked'", async () => {
    const { git } = fakeGit({
      "check-ignore": { exitCode: 0 },
      "ls-files": { exitCode: 128, stderr: "fatal: not a git repository" },
    });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/ls-files could not answer.*exit 128/s);
  });

  it("refuses an ignored root whose only tracked entry is the manifest itself", async () => {
    const { git } = fakeGit({
      "check-ignore": { exitCode: 0 },
      "ls-files": { exitCode: 0, stdout: "art/corpus-run.json\n" },
    });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/contains 1 TRACKED file/);
  });

  // codex R5: the earlier version ALLOWED this, and the test that "proved" it fed fakeGit a
  // state real git never emits (MEASURED: an untracked or absent directory exits 1, never
  // 0-with-nothing). A self-contradictory answer is a refusal, not a pass — the fourth
  // appearance of fold-cannot-determine-into-no in this review cycle.
  it("refuses a self-contradictory ls-files answer (exit 0 but nothing listed)", async () => {
    const { git } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 0, stdout: "  \n" } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/exited 0 \(matched\) but listed nothing/);
  });

  // codex R5: resolving for the containment decision and then asking git about the
  // UNRESOLVED path is validated-one-string-used-another, and it had a real exploit — with a
  // junction, `check-ignore link` and `ls-files -- link` both answer about `link` while the
  // writes land in the junction's TARGET, where tracked files may live.
  it("asks git about the RESOLVED path, not the path as written", async () => {
    const real = join(repo, "real-artifacts");
    mkdirSync(real, { recursive: true });
    const link = join(repo, "link");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // unprivileged Windows cannot create links; proven on POSIX/CI
    }
    const { git, asked } = fakeGit({ "check-ignore": { exitCode: 0 }, "ls-files": { exitCode: 1 } });

    await assertArtifactsRootSafe({ repoRoot: repo, artifactsRoot: link, git });

    // The EXACT pathspec, not merely "contains the target and is not the link" (codex R7:
    // that looser assertion would also pass for `join(canonicalArtifacts, "wrong")`, so it
    // did not pin what it claimed to). `realpathSync.native` because plain `realpathSync`
    // does NOT expand an 8.3 short path while the code's async `realpath` does, which is
    // green locally and red on a Windows CI runner
    // (docs/gotchas/win-83-shortpath-realpath-divergence.md).
    //
    // Repo-relative, not the resolved ABSOLUTE path (issue #135 / [git/check-ignore-windows-drive-colon]):
    // a Windows absolute path handed to a git pathspec dies on the drive-letter colon, so
    // the resolved path is converted to a repo-relative one before it ever reaches git.
    const expectedAbs = realpathSync.native(real);
    const expectedRepo = realpathSync.native(repo);
    const expected = toRepoRelativePathspec(expectedRepo, expectedAbs);
    expect(asked.length).toBe(2);
    for (const args of asked) {
      const pathspec = args[args.length - 1]!;
      expect(pathspec).toBe(expected);
      expect(isAbsolute(pathspec)).toBe(false);
    }
  });

  // Issue #135 / gotcha [git/check-ignore-windows-drive-colon]: git pathspecs treat a
  // leading `:` as magic, and a Windows absolute path carries a colon in position 2 --
  // `git check-ignore D:\...` dies `fatal: pathspec magic not supported`, unconditionally,
  // for every absolute path on the platform. The bug shipped because every prior fixture
  // was POSIX-shaped, so CI (which runs on Linux) never exercised the string shape the
  // real Windows caller actually produces. This test pins the fix at the STRING level --
  // real `path.win32.relative`, not the host's own `path.relative` -- so it catches a
  // regression on ANY CI platform, not only when this suite happens to run on Windows.
  it("never hands git a Windows drive-colon absolute path -- always a repo-relative, forward-slash pathspec", () => {
    const pathspec = toRepoRelativePathspec("D:\\work\\repo", "D:\\work\\repo\\.autodev\\corpus-artifacts", win32.relative, win32.sep);

    expect(pathspec).toBe("./.autodev/corpus-artifacts");
    expect(pathspec).not.toMatch(/^[A-Za-z]:/);
    expect(pathspec).not.toContain("\\");
  });

  // The artifacts root can legitimately BE the repo root itself (e.g. `--artifacts .`).
  // `path.relative` between two identical paths returns `""`, and an empty git pathspec's
  // meaning is not something this code wants to gamble on -- it must become an EXPLICIT
  // "." (the repo root itself), never a silently-empty argument.
  it("maps the artifacts-root-is-the-repo-root case to an explicit '.' pathspec, never an empty string", () => {
    const pathspec = toRepoRelativePathspec("D:\\work\\repo", "D:\\work\\repo", win32.relative, win32.sep);

    expect(pathspec).toBe(".");
  });

  // Review gate, s61 (blocker): the first fix folded EVERY backslash to a slash,
  // unconditionally. On POSIX a backslash is an ordinary filename byte, so a directory
  // genuinely named `artifacts\raw` would have been described to git as `artifacts/raw` --
  // a different path -- and the safety question would then have been answered about
  // something other than the directory about to be written to. Only the host's own
  // separator may be folded, and only when it is a backslash.
  it("leaves a literal backslash in a POSIX path alone -- it is a filename byte there, not a separator", () => {
    const pathspec = toRepoRelativePathspec("/tmp/repo", "/tmp/repo/artifacts\\raw", posix.relative, posix.sep);

    expect(pathspec).toBe("./artifacts\\raw");
  });

  // codex R4: `canonicalPathContains` answers `false` for an all-separator root as a
  // deliberate fail-CLOSED for its ORIGINAL callers, where refusing is safe. Here the
  // polarity is inverted -- `false` means "outside the repo, go ahead" -- so a repo rooted at
  // the filesystem root would have skipped every git check. A filesystem root contains
  // everything, so the git checks must still run.
  it("does not treat a filesystem-root repo as containing nothing", async () => {
    const fsRoot = parse(repo).root;
    const { git, asked } = fakeGit({ "check-ignore": { exitCode: 1 } });

    await expect(
      assertArtifactsRootSafe({ repoRoot: fsRoot, artifactsRoot: join(repo, "art"), git }),
    ).rejects.toThrow(/is NOT ignored/);
    expect(asked.map((a) => a.find((x) => !x.startsWith("-")))).toContain("check-ignore");
  });
});
