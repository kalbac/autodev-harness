import { readFile, writeFile, rename, mkdir, readdir, appendFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseTask } from "./task.js";
import type { Task } from "./types.js";
import type { BlackboardRepository, QueueState } from "./repository.js";

export class FileBlackboardRepository implements BlackboardRepository {
  constructor(private readonly repoRoot: string, private readonly stateDir: string) {}

  /** Guard against path traversal / separator injection via task ids or runtime file names. */
  private safePathSegment(segment: string, label: string): string {
    if (!segment || segment.includes("/") || segment.includes("\\") || segment.includes("..") || segment.includes("\0")) {
      throw new Error(`unsafe ${label}: ${JSON.stringify(segment)}`);
    }
    return segment;
  }

  private queueDir(state: QueueState): string {
    return join(this.repoRoot, this.stateDir, "queue", state);
  }
  runtimeDir(id: string): string {
    return join(this.repoRoot, this.stateDir, "runtime", this.safePathSegment(id, "task id"));
  }

  async listTasks(state: QueueState): Promise<Task[]> {
    const dir = this.queueDir(state);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const tasks: Task[] = [];
    for (const f of files) {
      const rel = join("queue", state, f);
      tasks.push(parseTask(await readFile(join(dir, f), "utf8"), rel));
    }
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  async moveTask(id: string, from: QueueState, to: QueueState): Promise<void> {
    this.safePathSegment(id, "task id");
    const src = join(this.queueDir(from), `${id}.md`);
    const dstDir = this.queueDir(to);
    await mkdir(dstDir, { recursive: true });
    await rename(src, join(dstDir, `${id}.md`)); // atomic within a filesystem
  }

  async getAttempts(id: string): Promise<number> {
    const p = join(this.runtimeDir(id), "attempts");
    if (!existsSync(p)) return 0;
    return Number((await readFile(p, "utf8")).trim()) || 0;
  }
  async setAttempts(id: string, n: number): Promise<void> {
    await mkdir(this.runtimeDir(id), { recursive: true });
    await writeFile(join(this.runtimeDir(id), "attempts"), String(n));
  }

  async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
    this.safePathSegment(name, "runtime file name");
    await mkdir(this.runtimeDir(id), { recursive: true });
    await writeFile(join(this.runtimeDir(id), name), content);
  }
  async readRuntimeFile(id: string, name: string): Promise<string | null> {
    this.safePathSegment(name, "runtime file name");
    const p = join(this.runtimeDir(id), name);
    return existsSync(p) ? readFile(p, "utf8") : null;
  }

  /**
   * Delete a runtime file -- used to CLEAR a "latest value" artifact (e.g.
   * `gate-feedback.md`) when the producing run has nothing to report
   * (docs/gotchas/per-round-overwrite-artifact-stale.md). `content === null` from
   * the caller means CLEAR, not "write an empty file": an empty-but-present file
   * would still read as a present (if blank) feedback section downstream, which
   * defeats the whole anti-staleness point.
   *
   * Errno discipline mirrors `gate/oracle-paths.ts`: ONLY `ENOENT` (the file is
   * already gone) is swallowed, so a write-or-clear caller that does not track
   * whether a previous round left a file behind can call this unconditionally.
   * Any OTHER failure -- EACCES/EPERM/EISDIR/... -- propagates. Folding "I was
   * not allowed to delete it" into "it is already gone" would be a silent
   * fail-open: the stale document would survive on disk while every caller
   * believed it had been cleared.
   */
  async removeRuntimeFile(id: string, name: string): Promise<void> {
    this.safePathSegment(name, "runtime file name");
    const p = join(this.runtimeDir(id), name);
    try {
      await unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async markDone(id: string, commitHash: string): Promise<void> {
    const p = join(this.queueDir("done"), `${this.safePathSegment(id, "task id")}.md`);
    await appendFile(p, `\n<!-- committed: ${commitHash} -->\n`);
  }

  async appendDigest(line: string): Promise<void> {
    const p = join(this.repoRoot, this.stateDir, "digest.md");
    await mkdir(join(this.repoRoot, this.stateDir), { recursive: true });
    await appendFile(p, `${line}\n`);
  }
}
