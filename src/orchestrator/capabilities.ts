import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { Logger } from "../util/log.js";
import type { ReadSnapshot } from "./adapter.js";
import { writeTaskToPending, type WriteTaskDeps } from "./enqueue.js";
import { isPathSafeId, type TaskSpec } from "./task-spec.js";

const ALL_QUEUE_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

/**
 * The full orchestrator capability surface. R1 boundary: this interface is
 * the ONLY thing an orchestrator agent is allowed to touch — no direct repo,
 * no gate, no worktree, no git. `enqueue`/`read`/`report` are implemented
 * here (no open design fork). `trigger` is an INTERFACE MEMBER ONLY — its
 * implementation is blocked on an operator-approved design (fork B/C).
 */
export interface OrchestratorCapabilities {
  enqueue(spec: TaskSpec): Promise<{ id: string; path: string }>;
  trigger(opts?: { once?: boolean; maxIterations?: number; drain?: boolean }): Promise<unknown>;
  read: {
    queues(): Promise<Record<QueueState, Task[]>>;
    runtimeReport(id: string, name: string): Promise<string | null>;
    digestTail(): Promise<string>;
    /** Recent run manifests (newest first, bounded), for intent-level dedup —
     *  a relaunch of an already-orchestrated intent whose tasks are still
     *  in-flight. Best-effort: unreadable/corrupt manifests are skipped. */
    recentRuns(): Promise<RunManifestSummary[]>;
  };
  report(entry: { level: string; message: string }): Promise<void>;
  /**
   * Part of the `report` capability family, not a new power: writes a small
   * JSON "run manifest" (`<runsDir>/<run-id>.json`) that indexes a completed
   * decomposition's task ids for the (later) dashboard's run-correlation
   * view. This is a CONVENIENCE INDEX, NOT authoritative state — the
   * blackboard's queue files remain the single source of truth; a caller
   * must never treat this manifest as anything more than a hint. It carries
   * no gate/worker/critic/worktree/commit power — it is a plain fs write,
   * exactly like `report`'s digest append.
   *
   * Best-effort by design: it must NEVER throw. On any failure (unwritable
   * runsDir, `wx` collision, etc.) it logs a WARN and returns `null`, so a
   * manifest-write failure can never fail a real orchestrated run.
   */
  recordRun(run: { intent: string; taskIds: string[] }): Promise<{ runId: string; path: string } | null>;
}

/** The subset of a run manifest the orchestrator's intent-level dedup needs
 *  (mirrors what `recordRun` writes; the API layer has its own richer type). */
export interface RunManifestSummary {
  runId: string;
  intent: string;
  taskIds: string[];
  at: number;
}

function isRunManifestSummary(v: unknown): v is RunManifestSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.runId === "string" &&
    typeof o.intent === "string" &&
    Array.isArray(o.taskIds) &&
    o.taskIds.every((x) => typeof x === "string") &&
    typeof o.at === "number" &&
    Number.isFinite(o.at)
  );
}

/** Cap on how many recent run manifests intent-level dedup scans — bounds the
 *  per-orchestrate read cost even for a project with a long run history. */
const MAX_RECENT_RUNS = 50;

/** Size cap per manifest read (a manifest is tiny: id/intent/taskIds/at). Guards
 *  against reading a huge file that happens to sit in runsDir. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** `<repoRoot>/<stateDir>/runs` — derived from `repo.runtimeDir` the same way
 *  `digestPath` recovers `<repoRoot>/<stateDir>` (frozen seam has no direct getter). */
function runsDirOf(repo: BlackboardRepository): string {
  const probe = repo.runtimeDir("__runs_dir_probe__");
  return join(dirname(dirname(probe)), "runs");
}

/** Number of trailing lines `read.digestTail()` returns (undocumented in the
 *  spec beyond "the digest tail" — chosen to keep an orchestrator prompt's
 *  context bounded even if digest.md grows large over a long session). */
const DIGEST_TAIL_LINES = 50;

/**
 * `BlackboardRepository` exposes no direct digest-read method (frozen seam),
 * only `appendDigest` + `runtimeDir(id)`. `runtimeDir(id)` deterministically
 * returns `<repoRoot>/<stateDir>/runtime/<id>` (see file-repository.ts), so
 * walking up two segments from any (non-filesystem-touching) call recovers
 * `<repoRoot>/<stateDir>`, matching `appendDigest`'s own path construction.
 */
function digestPath(repo: BlackboardRepository): string {
  const runtimeDirForProbeId = repo.runtimeDir("__digest_tail_probe__");
  return join(dirname(dirname(runtimeDirForProbeId)), "digest.md");
}

/** Read-only: wraps `repo.listTasks` (looped across all `QueueState`s),
 *  `repo.readRuntimeFile`, and a bounded tail of `digest.md`. */
export function createReadCapability(repo: BlackboardRepository): OrchestratorCapabilities["read"] {
  return {
    async queues(): Promise<Record<QueueState, Task[]>> {
      const entries = await Promise.all(
        ALL_QUEUE_STATES.map(async (state) => [state, await repo.listTasks(state)] as const),
      );
      return Object.fromEntries(entries) as Record<QueueState, Task[]>;
    },
    async runtimeReport(id: string, name: string): Promise<string | null> {
      return repo.readRuntimeFile(id, name);
    },
    async digestTail(): Promise<string> {
      const path = digestPath(repo);
      if (!existsSync(path)) return "";
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      if (lines.length <= DIGEST_TAIL_LINES) return content;
      return lines.slice(-DIGEST_TAIL_LINES).join("\n");
    },
    async recentRuns(): Promise<RunManifestSummary[]> {
      const dir = runsDirOf(repo);
      if (!existsSync(dir)) return [];
      let candidates: string[];
      try {
        // Bound the work BEFORE any file read (codex Sev-2): recordRun names its
        // manifests `run-<at>-<slug>.json`, so a lexical desc sort ≈ newest-first
        // (the ms-epoch prefix is fixed width); take only the newest MAX_RECENT_RUNS
        // filenames, so a huge runs dir never makes an orchestrate read/parse them all.
        candidates = (await readdir(dir))
          .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, MAX_RECENT_RUNS);
      } catch {
        return []; // best-effort — an unreadable runs dir must not fail an orchestrate
      }
      const manifests: RunManifestSummary[] = [];
      for (const f of candidates) {
        try {
          const full = join(dir, f);
          const st = await lstat(full); // lstat: never follow a symlink into a huge/foreign file
          if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) continue;
          const parsed: unknown = JSON.parse(await readFile(full, "utf8"));
          if (isRunManifestSummary(parsed)) manifests.push(parsed);
        } catch {
          /* skip an unreadable/corrupt manifest — never fail the read */
        }
      }
      manifests.sort((a, b) => b.at - a.at); // exact newest-first by parsed `at`
      return manifests;
    },
  };
}

/**
 * Builds the exact `ReadSnapshot` shape `handleIntent` uses (every queue +
 * the flattened `existingIds` across ALL queue states), from the `read`
 * capability. Extracted here so `handleIntent` and the chat wiring's opening
 * turn (`ChatSessionManager.start`) share ONE definition of "current queue
 * state" rather than maintaining two independently-drifting copies.
 */
export async function buildReadSnapshot(read: OrchestratorCapabilities["read"]): Promise<ReadSnapshot> {
  const queues = await read.queues();
  const existingIds = ALL_QUEUE_STATES.flatMap((state) => queues[state].map((t) => t.id));
  return { existingIds, queues };
}

/**
 * Appends a `[orchestrator] `-prefixed line to the shared digest (also
 * written by the conductor — the prefix keeps digest.md parseable per-writer)
 * AND logs via the injected logger. Never throws on its own: `appendDigest`'s
 * I/O failure mode is inherited from the repo implementation, not masked here.
 */
export function createReportCapability(repo: BlackboardRepository, log: Logger): OrchestratorCapabilities["report"] {
  return async (entry: { level: string; message: string }): Promise<void> => {
    // Collapse any CR/LF runs before writing to the digest so a crafted
    // `level`/`message` can never forge extra digest lines (each digest
    // entry must stay exactly one line). The raw, unflattened message is
    // still passed to the injected logger below.
    const flatLevel = entry.level.replace(/[\r\n]+/g, " ");
    const flatMessage = entry.message.replace(/[\r\n]+/g, " ");
    await repo.appendDigest(`[orchestrator] [${flatLevel}] ${flatMessage}`);
    log(entry.level, entry.message);
  };
}

/** Closure over `writeTaskToPending` — the only way an orchestrator can add work. */
export function createEnqueueCapability(deps: WriteTaskDeps): OrchestratorCapabilities["enqueue"] {
  return (spec: TaskSpec) => writeTaskToPending(spec, deps);
}

/** Cap on the slug portion of a generated run-id, keeping filenames short even
 *  for a very long operator intent. */
const RUN_SLUG_MAX_LEN = 40;

/**
 * Best-effort, human-skimmable slug of an intent for a run-id. Deliberately
 * loose (any run of characters outside the `isPathSafeId` allowlist collapses
 * to a single `-`): the CALLER is responsible for re-validating the final
 * assembled run-id with `isPathSafeId` and falling back if this still
 * produces something unsafe (e.g. an intent built entirely of literal `.`
 * characters can slip a `..` past this collapse step).
 */
function slugifyIntent(intent: string): string {
  const collapsed = intent
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return collapsed.slice(0, RUN_SLUG_MAX_LEN);
}

/**
 * Fail-closed error → string. Never throws, even on an `err` that is an
 * `Error` whose `message` getter throws, or a value whose `toString`/`String`
 * coercion throws (gotcha [ts/fail-closed]): the ONLY guarantee that
 * `recordRun` never rejects is its `catch`, and formatting the caught error
 * for the log must not itself be able to re-throw out of that `catch`.
 */
function safeErrorMessage(err: unknown): string {
  try {
    // Coerce INSIDE the try: a hostile `err.message` getter can return a
    // non-string whose own `toString` throws, so the `String(...)` must run
    // here (fail-closed), never at the interpolation site outside this catch.
    if (err instanceof Error) return String(err.message);
    return String(err);
  } catch {
    return "<unstringifiable error>";
  }
}

/**
 * Implements `OrchestratorCapabilities["recordRun"]` (see the interface
 * doc-comment — this is a `report`-family convenience index, not a new
 * power). Generates a clock-derived, path-safe run-id (`run-<now>` optionally
 * suffixed with a sanitized slug of the intent), `mkdir -p`s `runsDir`, and
 * writes the manifest with an exclusive `wx` flag — matching `enqueue.ts`'s
 * own id-safety + exclusive-write style. Never throws: any failure (bad
 * runsDir, `wx` collision, …) is logged at WARN and yields `null`.
 */
export function createRecordRunCapability(deps: {
  runsDir: string;
  now: () => number;
  log: Logger;
}): OrchestratorCapabilities["recordRun"] {
  // safeLog swallows a throwing injected logger so the best-effort/never-throws
  // contract holds even on the failure path: the `catch` below is the ONLY
  // guarantee that a manifest failure can't fail a real run, and a raw
  // `deps.log` there would re-throw a broken logger straight out of `recordRun`
  // (gotcha [ts/fail-closed]).
  const safeLog = (level: string, message: string): void => {
    try {
      deps.log(level, message);
    } catch {
      /* a broken logger must never break the fail-closed path */
    }
  };
  return async (run: { intent: string; taskIds: string[] }) => {
    try {
      const at = deps.now();
      const baseId = `run-${at}`;
      const slug = slugifyIntent(run.intent);
      const candidateId = slug ? `${baseId}-${slug}` : baseId;
      const runId = isPathSafeId(candidateId) ? candidateId : baseId;
      if (!isPathSafeId(runId)) {
        // Defense in depth: `at` is always a finite number, so `baseId`
        // should always be path-safe — but never write outside runsDir on
        // an unforeseen clock value instead of guaranteeing it here.
        throw new Error(`generated run-id is not path-safe: ${JSON.stringify(runId)}`);
      }

      await mkdir(deps.runsDir, { recursive: true });
      const path = join(deps.runsDir, `${runId}.json`);
      const manifest = { runId, intent: run.intent, taskIds: run.taskIds, at };
      await writeFile(path, JSON.stringify(manifest, null, 2), { flag: "wx" });

      return { runId, path };
    } catch (err) {
      safeLog(
        "WARN",
        `orchestrator: recordRun failed (best-effort, run continues unaffected): ${safeErrorMessage(err)}`,
      );
      return null;
    }
  };
}
