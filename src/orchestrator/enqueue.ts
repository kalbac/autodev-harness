import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPathSafeId, serializeTask, validateTaskSpec, type TaskSpec } from "./task-spec.js";

export interface WriteTaskDeps {
  repoRoot: string;
  stateDir: string;
  /** Ids across ALL queue states (pending/active/escalated/quarantine/done) —
   *  a duplicate id must not be able to shadow an in-flight task. */
  existingIds: () => Promise<string[]>;
}

/**
 * Author a new task into `queue/pending/`. This is a STANDALONE function, not
 * a `BlackboardRepository` method — the repository is a frozen seam (see
 * file-repository.ts) and does not grow an "enqueue" concept. It must NOT
 * claim, trigger, or run anything: it only writes the pending file.
 */
export async function writeTaskToPending(
  spec: TaskSpec,
  deps: WriteTaskDeps,
): Promise<{ id: string; path: string }> {
  const validated = validateTaskSpec(spec);

  // Defense in depth: TaskSpecSchema already rejects a path-unsafe id, but the
  // id is re-guarded here (mirroring FileBlackboardRepository's private
  // `safePathSegment` pattern) immediately before it is used to build a path.
  if (!isPathSafeId(validated.id)) {
    throw new Error(`unsafe task id: ${JSON.stringify(validated.id)}`);
  }

  const existing = await deps.existingIds();
  if (existing.includes(validated.id)) {
    throw new Error(`task id already exists: ${validated.id}`);
  }

  const dir = join(deps.repoRoot, deps.stateDir, "queue", "pending");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${validated.id}.md`);

  // The `existingIds()` pre-check above catches an id colliding in
  // active/done/escalated/quarantine, which this write cannot see — but it
  // cannot catch a CONCURRENT create of the same pending file racing this
  // one. `flag: "wx"` makes the write itself exclusive (fails if the file
  // already exists), closing that race instead of silently overwriting.
  try {
    await writeFile(path, serializeTask(validated), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`task id already exists: ${validated.id}`);
    }
    throw err;
  }

  return { id: validated.id, path };
}
