import { readFile, writeFile, rename, mkdir, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseTask } from "./task.js";
import type { Task } from "./types.js";
import type { BlackboardRepository, QueueState } from "./repository.js";

export class FileBlackboardRepository implements BlackboardRepository {
  constructor(private readonly repoRoot: string, private readonly stateDir: string) {}

  private queueDir(state: QueueState): string {
    return join(this.repoRoot, this.stateDir, "queue", state);
  }
  runtimeDir(id: string): string {
    return join(this.repoRoot, this.stateDir, "runtime", id);
  }

  async listTasks(state: QueueState): Promise<Task[]> {
    const dir = this.queueDir(state);
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const tasks: Task[] = [];
    for (const f of files) {
      const rel = join("queue", state, f);
      tasks.push(parseTask(await readFile(join(dir, f), "utf8"), rel));
    }
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  async moveTask(id: string, from: QueueState, to: QueueState): Promise<void> {
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
    await mkdir(this.runtimeDir(id), { recursive: true });
    await writeFile(join(this.runtimeDir(id), name), content);
  }
  async readRuntimeFile(id: string, name: string): Promise<string | null> {
    const p = join(this.runtimeDir(id), name);
    return existsSync(p) ? readFile(p, "utf8") : null;
  }

  async markDone(id: string, commitHash: string): Promise<void> {
    const p = join(this.queueDir("done"), `${id}.md`);
    await appendFile(p, `\n<!-- committed: ${commitHash} -->\n`);
  }

  async appendDigest(line: string): Promise<void> {
    const p = join(this.repoRoot, this.stateDir, "digest.md");
    await mkdir(join(this.repoRoot, this.stateDir), { recursive: true });
    await appendFile(p, `${line}\n`);
  }
}
