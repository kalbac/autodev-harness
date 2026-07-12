import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathSafeId } from "../orchestrator/task-spec.js";
import {
  threadEntrySchema, threadMetaSchema,
  type ThreadEntry, type ThreadEntryInput, type ThreadMeta,
} from "./thread-types.js";
import { safeErrorText, safeLog } from "../util/safe-log.js";

type Logger = (level: "INFO" | "WARN" | "ERROR", msg: string) => void;

export interface ThreadStoreDeps {
  threadsRoot: string;
  log: Logger;
  now?: () => number;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4_000_000;
const TRUNC_MARKER = JSON.stringify({ ts: 0, type: "activity", kind: "run", ref: {}, summary: "thread log truncated (size cap)", status: "warn" }) + "\n";

interface Sizes { bytes: number; capped: boolean }

export class ThreadStore {
  private readonly root: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly sizes = new Map<string, Sizes>();

  constructor(deps: ThreadStoreDeps) {
    this.root = deps.threadsRoot;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private dir(id: string): string { return join(this.root, id); }
  private ndjsonPath(id: string): string { return join(this.dir(id), "thread.ndjson"); }
  private metaPath(id: string): string { return join(this.dir(id), "meta.json"); }

  private assertId(id: string): void {
    if (!isPathSafeId(id)) throw new Error(`unsafe thread id: ${id}`);
  }

  async create(input: { id: string; title: string }): Promise<ThreadMeta> {
    this.assertId(input.id);
    await mkdir(this.root, { recursive: true });
    const d = this.dir(input.id);
    if (existsSync(d) && lstatSync(d).isSymbolicLink()) throw new Error(`thread dir is a symlink: ${input.id}`);
    if (existsSync(this.metaPath(input.id))) throw new Error(`thread already exists: ${input.id}`);
    await mkdir(d, { recursive: true });
    const meta: ThreadMeta = { id: input.id, title: input.title, created_at: this.now(), status: "chatting" };
    await writeFile(this.metaPath(input.id), JSON.stringify(meta, null, 2));
    this.sizes.set(input.id, { bytes: 0, capped: false });
    return meta;
  }

  async append(id: string, entry: ThreadEntryInput): Promise<void> {
    try {
      if (!existsSync(this.dir(id))) return;
      const full = { ts: this.now(), ...entry } as ThreadEntry;
      const parsed = threadEntrySchema.parse(full);
      const line = JSON.stringify(parsed) + "\n";
      const s = await this.sizeOf(id);
      if (s.capped) return;
      if (s.bytes + line.length > this.maxBytes - TRUNC_MARKER.length) {
        s.capped = true;
        await appendFile(this.ndjsonPath(id), TRUNC_MARKER);
        s.bytes += TRUNC_MARKER.length;
        this.log("WARN", `thread ${id} exceeded ${this.maxBytes} bytes -- truncating persisted log`);
        return;
      }
      await appendFile(this.ndjsonPath(id), line);
      s.bytes += line.length;
    } catch (err) {
      safeLog(this.log, "WARN", `thread append failed for ${id}: ${safeErrorText(err)}`);
    }
  }

  private async sizeOf(id: string): Promise<Sizes> {
    let s = this.sizes.get(id);
    if (!s) {
      let bytes = 0;
      try { bytes = existsSync(this.ndjsonPath(id)) ? (await stat(this.ndjsonPath(id))).size : 0; } catch { bytes = 0; }
      s = { bytes, capped: false };
      this.sizes.set(id, s);
    }
    return s;
  }

  async readNdjson(id: string): Promise<string> {
    try { return existsSync(this.ndjsonPath(id)) ? await readFile(this.ndjsonPath(id), "utf8") : ""; }
    catch { return ""; }
  }

  async read(id: string): Promise<{ meta: ThreadMeta; entries: ThreadEntry[] } | null> {
    try {
      if (!existsSync(this.metaPath(id))) return null;
      const meta = threadMetaSchema.parse(JSON.parse(await readFile(this.metaPath(id), "utf8")));
      const raw = await this.readNdjson(id);
      const entries: ThreadEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { entries.push(threadEntrySchema.parse(JSON.parse(t))); } catch { /* skip corrupt line */ }
      }
      return { meta, entries };
    } catch { return null; }
  }

  async setMeta(id: string, patch: Partial<Pick<ThreadMeta, "run_id" | "status" | "title">>): Promise<void> {
    try {
      const cur = await this.read(id);
      if (!cur) return;
      const next: ThreadMeta = threadMetaSchema.parse({ ...cur.meta, ...patch });
      await writeFile(this.metaPath(id), JSON.stringify(next, null, 2));
    } catch (err) {
      safeLog(this.log, "WARN", `thread setMeta failed for ${id}: ${safeErrorText(err)}`);
    }
  }

  async list(): Promise<ThreadMeta[]> {
    try {
      if (!existsSync(this.root)) return [];
      const ids = await readdir(this.root);
      const metas: ThreadMeta[] = [];
      for (const id of ids) {
        if (!isPathSafeId(id)) continue;
        const r = await this.read(id);
        if (r) metas.push(r.meta);
      }
      return metas.sort((a, b) => b.created_at - a.created_at);
    } catch { return []; }
  }
}
