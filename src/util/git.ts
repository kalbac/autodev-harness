import { runNative } from "./native.js";

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
}

export interface Git {
  currentBranch(): Promise<string>;
  changedFiles(scope?: string[]): Promise<string[]>;
  diffText(scope?: string[]): Promise<string>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;
  worktreeAdd(path: string, branch: string, base: string): Promise<void>;
  worktreeRemove(path: string): Promise<void>;
  merge(branch: string): Promise<MergeResult>;
}

function fail(cmd: string, args: string[], result: { exitCode: number; stderr: string }): never {
  throw new Error(`git ${cmd} failed (exit ${result.exitCode}): ${result.stderr.trim()}\n(args: ${args.join(" ")})`);
}

/** Create a `Git` helper bound to a repo (or worktree) root, shelling out to the real `git` CLI. */
export function createGit(repoRoot: string): Git {
  async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runNative("git", args, { cwd: repoRoot });
  }

  return {
    async currentBranch(): Promise<string> {
      const r = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (r.exitCode !== 0) fail("rev-parse --abbrev-ref HEAD", [], r);
      return r.stdout.trim();
    },

    async changedFiles(scope?: string[]): Promise<string[]> {
      const args = ["diff", "--name-only", "HEAD"];
      if (scope && scope.length > 0) args.push("--", ...scope);
      const r = await run(args);
      if (r.exitCode !== 0) fail("diff --name-only", args, r);
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    async diffText(scope?: string[]): Promise<string> {
      const args = ["diff"];
      if (scope && scope.length > 0) args.push("--", ...scope);
      const r = await run(args);
      if (r.exitCode !== 0) fail("diff", args, r);
      return r.stdout;
    },

    async add(paths: string[]): Promise<void> {
      const args = ["add", "--", ...paths];
      const r = await run(args);
      if (r.exitCode !== 0) fail("add", args, r);
    },

    async commit(message: string): Promise<string> {
      const r = await run(["commit", "-m", message]);
      if (r.exitCode !== 0) fail("commit", ["-m", message], r);
      const h = await run(["rev-parse", "HEAD"]);
      if (h.exitCode !== 0) fail("rev-parse HEAD", [], h);
      return h.stdout.trim();
    },

    async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
      const args = ["worktree", "add", "-b", branch, path, base];
      const r = await run(args);
      if (r.exitCode !== 0) fail("worktree add", args, r);
    },

    async worktreeRemove(path: string): Promise<void> {
      const args = ["worktree", "remove", "--force", path];
      const r = await run(args);
      if (r.exitCode !== 0) fail("worktree remove", args, r);
    },

    async merge(branch: string): Promise<MergeResult> {
      const r = await run(["merge", "--no-edit", branch]);
      if (r.exitCode === 0) {
        return { ok: true, conflict: false };
      }
      const output = `${r.stdout}\n${r.stderr}`;
      const isConflict = /CONFLICT/i.test(output) || /Automatic merge failed/i.test(output);
      // Whether it's a real conflict or some other merge failure, abort to
      // leave the tree clean (fail-closed — never leave a half-merged state).
      await run(["merge", "--abort"]);
      if (isConflict) {
        return { ok: false, conflict: true };
      }
      fail("merge", [branch], r);
    },
  };
}
