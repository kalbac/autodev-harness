# Live Orchestrator — Attended Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the project's main screen into a persistent thread-based conversation with the orchestrator — the opening turn streams (no dead air), the pre-launch chat and the running task's live narration live in one blackboard-persisted thread, launch works by button AND by word, and machine events render instantly as deep-linking activity cells while the orchestrator adds prose at milestones.

**Architecture:** Threads are append-only blackboard files (`.autodev/threads/<id>/thread.ndjson` + `meta.json`). Pre-launch reuses the proven s34 `ChatSessionManager`/`ClaudeChatProcess` machinery bridged to a thread (one surgical change: `start` accepts an optional SSE sink so the opening turn streams from session creation). A `StreamingFenceStripper` keeps raw decompose JSON out of the transcript live and on replay. Post-launch a read-only `NarratorService` (adr/003 R1: enqueue/trigger/read/report only) diffs run state into instant `activity` cells and fires one-shot `claude -p` narration at milestones. Transport copies the s38 CI-stream pattern (ndjson persist → `ThreadEventBus` → SSE replay→live). UI: TanStack Router routes `/p/:id` (newest thread) and `/p/:id/t/:threadId`, a sidebar thread list, transcript on `MessageScroller`+`Bubble`, cells on `Collapsible`+`Badge`; `ChatModal` is deleted and `HomeView` becomes the thread host.

**Tech Stack:** Node LTS + TypeScript daemon (vitest, zod), React 19 + Vite 6 + TanStack Router + react-query 5 UI, shadcn on Base UI (`base-nova` style). Orchestrator role = `claude -p` stream-json (isolated: `--safe-mode --strict-mcp-config --tools ""`). codex GPT-5.5 critic gate per backend module.

---

## Scope, discipline & non-goals

- **This is the ATTENDED half of adr/004 only.** NON-goals (do not build, do not add dead buttons): overnight toggle/semantics, decision classes, decision journal, morning report, north-star doc, anti-drift, i18n, desktop wrap, ANY enforcement/gate/critic/escalation-semantics change. This is presence, not power.
- **R1 is inviolable (adr/003):** the orchestrator touches enforcement only via enqueue / trigger / read / report. Every new path either reuses the unchanged `onOrchestrate` launch or reads the blackboard. No new hooks inside the conductor's enforcement path.
- **Discipline:** TDD every backend module (test fails → minimal impl → passes → commit). Root: `npm test`, `npm run typecheck`, `npm run build`. UI is **review-only** (no test infra — confirmed: `ui/package.json` has no test deps): `cd ui && npm run typecheck && npm run build`. Per-module **codex GPT-5.5 gate**, re-critic in-place fixes. One PR at the end.
- **Gotchas to respect** (scan before the tagged tasks): `[chat/onToken-bound-once]` (token routing must be per-turn/live-looked-up — never capture a sink at bind time), `[api/run-id-dot-validation-mismatch]` (use `isPathSafeId`, which allows dots, for thread ids on BOTH write and read), the s38 ndjson **cap** + SSE **replay-disconnect-leak** fix + `flushHeaders()`, `[build/stale-dist-backend]` + `[ui/serve-uidir-reporoot]` (rebuild BOTH bundles + copy `dist/ui` before any live smoke), `[ts/zod]` (derive types via `z.infer`), `[ts/fail-closed]` (guard catch-block loggers in never-throws paths).

---

## File Structure

**New backend files**

| File | Responsibility |
|---|---|
| `src/thread/thread-types.ts` | `ThreadEntry` union, `ThreadMeta`, `ActivityKind/Status/Ref`, `PlanSpecPreview`, zod schemas + `z.infer` types. |
| `src/thread/plan-preview.ts` | `toPlanPreview(specs: TaskSpec[]): PlanSpecPreview[]` — TaskSpec → `{id,title,type,file_set}`. |
| `src/thread/thread-store.ts` | `ThreadStore` — create/append/read/readNdjson/list/setMeta over `.autodev/threads/<id>/`. Best-effort, size-capped, `appendFile` + in-memory byte counter, path-safe ids, symlink-guarded create. |
| `src/thread/strip-fenced-json.ts` | `stripFencedJson(text)` (batch) + `StreamingFenceStripper` (incremental, same rule) — keep ```json blocks out of transcript prose. |
| `src/thread/launch-marker.ts` | `LAUNCH_MARKER`, `containsLaunchMarker(text)`, `stripLaunchMarker(text)`. |
| `src/api/thread-events.ts` | `ThreadEventBus` (copy `CiEventBus`) + `handleThreadStream` (copy `handleCiStream`: replay→live, disconnect-leak guarded, `flushHeaders`). |
| `src/orchestrator/thread-chat-service.ts` | `ThreadChatService` — bridges `ThreadStore`+`ThreadEventBus`+`ChatSessionManager` for the pre-launch phase; owns thread↔session map, per-turn strip+persist, LAUNCH-by-word, and confirm. |
| `src/orchestrator/launch.ts` | `performLaunch(pid, p, intent): LaunchResult` — res-decoupled core of today's `launchOrchestrate` (still just `onOrchestrate` + in-flight guard). |
| `src/orchestrator/narrator/activity-map.ts` | Pure: `diffRunSnapshot(prev, next): { cells: ActivityEntry[]; milestones: Milestone[] }`. |
| `src/orchestrator/narrator/milestone.ts` | Pure: `coalesceMilestones(pending, now, windowMs): { fire: Milestone[]; keep: Milestone[] }`. |
| `src/orchestrator/narrator/narration-prompt.ts` | `buildNarrationPrompt(entries, trigger)` + `buildMidRunReplyPrompt(entries, snapshot, question)`. |
| `src/orchestrator/narrator/orchestrator-oneshot.ts` | `runOrchestratorOneShot({exe,cwd,args,prompt,onToken,spawnFn?}): Promise<string>` — single `claude -p` stream-json call. |
| `src/orchestrator/narrator/narrator-service.ts` | `NarratorService` — run discovery, tick/diff → instant cells, CI subscription, milestone one-shot narration, mid-run Q&A, lifecycle. |

**Modified backend files**

| File | Change |
|---|---|
| `src/orchestrator/chat-session-manager.ts` | `start` input gains optional `sink?: ChatStreamSink`; set `s.sseRes = input.sink ?? null` at session creation (opening turn streams). |
| `src/api/server.ts` | Refactor `launchOrchestrate` to call `performLaunch`; add `ProjectView.threads` capability + 7 thread routes/handlers. |
| `src/composition/root.ts` | Construct `ThreadStore`, `ThreadEventBus`, `ThreadChatService`, narrator factory; expose on `ProjectRoot`. |
| `src/index.ts` | Wire `ProjectView.threads` from `root`. |

**New UI files**

| File | Responsibility |
|---|---|
| `ui/src/lib/useThreadStream.ts` | `useThreadStream(projectId, threadId)` — EventSource hook (model on `useCiEvents`), returns `{ entries, streamingText }`. |
| `ui/src/views/ThreadView.tsx` | The project main screen: transcript + cells + plan chip + composer footer. |
| `ui/src/components/ThreadTranscript.tsx` | `MessageScroller`+`Bubble` transcript rendering entries (prose + cells inline, ordered by ts). |
| `ui/src/components/ActivityCell.tsx` | `Collapsible`+`Badge` cell; collapsed one-liner, expanded fields, deep-link per kind. |
| `ui/src/components/PlanChip.tsx` | Ported plan chip: `max-w-full` wrap fix + inline `Launch` button. |
| `ui/src/components/ThreadList.tsx` | Sidebar per-project thread list (`SidebarMenu`) + "New thread". |

**Modified UI files**

| File | Change |
|---|---|
| `ui/src/lib/api.ts` | Thread client fns (list/create/get/message/confirm/cancel + `threadStreamUrl`); drop chat-modal-only fns if unused elsewhere. |
| `ui/src/lib/queries.ts` | `useThreads`, `useThread`, `useCreateThread`, `useThreadMessage`, `useThreadConfirm`, `useThreadCancel`; add `qk.threads`. |
| `ui/src/router.tsx` | Add `projectThreadRoute` (`/t/$threadId`); `projectHomeRoute` renders the thread host. |
| `ui/src/views/HomeView.tsx` | Becomes the thread host (newest thread or fresh-thread greeting state). |
| `ui/src/components/NewRunComposer.tsx` | Submit starts a thread (`POST /threads`) and navigates; footer variant sends turns. |
| `ui/src/components/SessionRail.tsx` | Polish bug #3: CI "open CI run →" link contrast (`text-accent` → readable token). |
| `ui/src/components/AppShell.tsx` / `Sidebar.tsx` | Mount `ThreadList`; ensure rail predicate covers `/t/` intentionally. |
| `ui/src/components/ChatModal.tsx` | **Deleted.** |

---

# PHASE A — Thread primitives (store, bus, strippers)

## Task A1: Thread types

**Files:**
- Create: `src/thread/thread-types.ts`
- Test: `src/thread/thread-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { threadEntrySchema, threadMetaSchema, type ThreadEntry } from "./thread-types.js";

describe("thread schemas", () => {
  it("accepts each entry type", () => {
    const now = 1_000;
    const entries: ThreadEntry[] = [
      { ts: now, type: "operator_msg", text: "build X" },
      { ts: now, type: "orchestrator_msg", text: "on it", milestone: "run_started" },
      { ts: now, type: "activity", kind: "gate", ref: { taskId: "t1" }, summary: "gate: commit", status: "ok" },
      { ts: now, type: "plan", specs: [{ id: "t1", title: "T", type: "feature", file_set: ["a.ts"] }] },
      { ts: now, type: "run_link", runId: "run-x" },
    ];
    for (const e of entries) expect(threadEntrySchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown entry type", () => {
    expect(() => threadEntrySchema.parse({ ts: 1, type: "nope" })).toThrow();
  });

  it("parses meta with optional run_id", () => {
    const m = threadMetaSchema.parse({ id: "th-1", title: "X", created_at: 1, status: "chatting" });
    expect(m.run_id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/thread/thread-types.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from "zod";

export const activityKindSchema = z.enum([
  "worker", "gate", "agent_ci", "critic", "merge", "escalation", "run",
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityStatusSchema = z.enum(["running", "ok", "warn", "error"]);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

export const activityRefSchema = z
  .object({ taskId: z.string().optional(), runId: z.string().optional() })
  .strict();
export type ActivityRef = z.infer<typeof activityRefSchema>;

export const planSpecPreviewSchema = z
  .object({ id: z.string(), title: z.string(), type: z.string(), file_set: z.array(z.string()) })
  .strict();
export type PlanSpecPreview = z.infer<typeof planSpecPreviewSchema>;

const base = { ts: z.number() };

export const threadEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("operator_msg"), text: z.string() }).strict(),
  z.object({ ...base, type: z.literal("orchestrator_msg"), text: z.string(), milestone: z.string().optional() }).strict(),
  z.object({ ...base, type: z.literal("activity"), kind: activityKindSchema, ref: activityRefSchema, summary: z.string(), status: activityStatusSchema }).strict(),
  z.object({ ...base, type: z.literal("plan"), specs: z.array(planSpecPreviewSchema) }).strict(),
  z.object({ ...base, type: z.literal("run_link"), runId: z.string() }).strict(),
]);
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

/** An entry minus `ts` — the store stamps `ts` on append. */
export type ThreadEntryInput =
  | Omit<Extract<ThreadEntry, { type: "operator_msg" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "orchestrator_msg" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "activity" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "plan" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "run_link" }>, "ts">;

export const threadStatusSchema = z.enum(["chatting", "running", "done", "error"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const threadMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    created_at: z.number(),
    run_id: z.string().optional(),
    status: threadStatusSchema,
  })
  .strict();
export type ThreadMeta = z.infer<typeof threadMetaSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/thread/thread-types.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/thread/thread-types.ts src/thread/thread-types.test.ts
git commit -m "feat(thread): thread entry + meta schemas"
```

## Task A2: Plan preview projection

**Files:**
- Create: `src/thread/plan-preview.ts`
- Test: `src/thread/plan-preview.test.ts`

> Reuse the exact `{id,title,type,file_set}` projection the s34 chat response already sends the UI (`ChatTaskSpecPreview`). Grep `server.ts` for where `proposedSpecs` are projected for the chat response and mirror it so the preview shape never drifts.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toPlanPreview } from "./plan-preview.js";

describe("toPlanPreview", () => {
  it("projects TaskSpec to {id,title,type,file_set} and drops other fields", () => {
    const specs = [
      { id: "t1", title: "Build", type: "feature", file_set: ["a.ts", "b.ts"], depends_on: ["t0"], model: "sonnet" },
    ] as any;
    expect(toPlanPreview(specs)).toEqual([{ id: "t1", title: "Build", type: "feature", file_set: ["a.ts", "b.ts"] }]);
  });

  it("returns [] for undefined", () => {
    expect(toPlanPreview(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/thread/plan-preview.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { TaskSpec } from "../orchestrator/task-spec.js";
import type { PlanSpecPreview } from "./thread-types.js";

export function toPlanPreview(specs: TaskSpec[] | undefined): PlanSpecPreview[] {
  if (!specs) return [];
  return specs.map((s) => ({ id: s.id, title: s.title, type: s.type, file_set: [...s.file_set] }));
}
```

> Verify the real `TaskSpec` field names (`type`, `file_set`) against `src/orchestrator/task-spec.ts`; adjust if the source uses different keys.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thread): TaskSpec -> plan preview projection`.

## Task A3: Fenced-JSON strippers (batch + streaming)

**Files:**
- Create: `src/thread/strip-fenced-json.ts`
- Test: `src/thread/strip-fenced-json.test.ts`

> Closes s38 polish bug #1 structurally. The batch and streaming versions implement the SAME rule; the test asserts they agree so live-stream and replay never diverge.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { stripFencedJson, StreamingFenceStripper } from "./strip-fenced-json.js";

describe("stripFencedJson (batch)", () => {
  it("removes a ```json fenced block, keeps surrounding prose", () => {
    const input = "Here is the plan:\n```json\n[{\"id\":\"t1\"}]\n```\nLaunch when ready.";
    expect(stripFencedJson(input)).toBe("Here is the plan:\nLaunch when ready.");
  });
  it("leaves prose without a json fence untouched", () => {
    expect(stripFencedJson("Just a question for you?")).toBe("Just a question for you?");
  });
  it("only strips ```json, not other fenced code", () => {
    const input = "```ts\nconst x = 1;\n```";
    expect(stripFencedJson(input)).toBe(input);
  });
});

describe("StreamingFenceStripper agrees with batch", () => {
  const cases = [
    "Here is the plan:\n```json\n[{\"id\":\"t1\"}]\n```\nGo.",
    "no fence here",
    "```json\n[]\n``` trailing",
    "pre ```json\n{a}\n``` mid ```json\n{b}\n``` post",
  ];
  for (const [i, text] of cases.entries()) {
    it(`case ${i}: char-by-char stream equals batch`, () => {
      const s = new StreamingFenceStripper();
      let out = "";
      for (const ch of text) out += s.push(ch);
      out += s.end();
      expect(out).toBe(stripFencedJson(text));
    });
  }
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

/** Remove ```json ... ``` fenced blocks and collapse the blank line they leave. */
export function stripFencedJson(text: string): string {
  const out = text.replace(/```json[\s\S]*?```/g, "");
  // collapse a doubled newline the removed block leaves between two prose lines
  return out.replace(/\n{3,}/g, "\n\n").replace(/([^\n])\n\n([^\n])/g, "$1\n$2").trimEnd();
}

/**
 * Incremental version of stripFencedJson: forwards prose, suppresses the content of
 * a ```json fence (and the fence markers). Buffers only enough tail to detect a fence
 * boundary. `push` returns forwardable text (possibly "").
 */
export class StreamingFenceStripper {
  private buf = "";
  private inFence = false;

  push(chunk: string): string {
    this.buf += chunk;
    let emit = "";
    // Emit everything that cannot be part of a fence marker; keep a short tail.
    for (;;) {
      if (!this.inFence) {
        const open = this.buf.indexOf(FENCE_OPEN);
        if (open === -1) {
          // hold back the longest suffix that could be a partial FENCE_OPEN
          const safe = this.buf.length - (FENCE_OPEN.length - 1);
          if (safe > 0) { emit += this.buf.slice(0, safe); this.buf = this.buf.slice(safe); }
          break;
        }
        emit += this.buf.slice(0, open);
        this.buf = this.buf.slice(open + FENCE_OPEN.length);
        this.inFence = true;
      } else {
        const close = this.buf.indexOf(FENCE_CLOSE);
        if (close === -1) {
          const safe = this.buf.length - (FENCE_CLOSE.length - 1);
          if (safe > 0) this.buf = this.buf.slice(safe); // drop fenced content
          break;
        }
        this.buf = this.buf.slice(close + FENCE_CLOSE.length);
        this.inFence = false;
      }
    }
    return emit;
  }

  end(): string {
    const rest = this.inFence ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}
```

> If the agreement test exposes edge cases (partial marker at `end`, whitespace collapsing), adjust BOTH functions to keep them in lockstep — the test is the contract. The batch newline-collapse is cosmetic; if it complicates agreement, simplify `stripFencedJson` to a plain `.replace(/```json[\s\S]*?```/g, "")` and align the streaming `end()`/whitespace handling to match, then relax the whitespace expectation in the batch test.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thread): batch + streaming fenced-json strippers`.

## Task A4: Launch marker

**Files:**
- Create: `src/thread/launch-marker.ts`
- Test: `src/thread/launch-marker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { LAUNCH_MARKER, containsLaunchMarker, stripLaunchMarker } from "./launch-marker.js";

describe("launch marker", () => {
  it("detects the marker anywhere in the text", () => {
    expect(containsLaunchMarker(`Sure, launching now. ${LAUNCH_MARKER}`)).toBe(true);
    expect(containsLaunchMarker("let me clarify one thing first")).toBe(false);
  });
  it("strips the marker (and a lone trailing line) from prose", () => {
    expect(stripLaunchMarker(`Launching now.\n${LAUNCH_MARKER}`)).toBe("Launching now.");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
export const LAUNCH_MARKER = "[[LAUNCH]]";

export function containsLaunchMarker(text: string): boolean {
  return text.includes(LAUNCH_MARKER);
}

export function stripLaunchMarker(text: string): string {
  return text.split(LAUNCH_MARKER).join("").trimEnd();
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(thread): launch control-marker helpers`.

## Task A5: ThreadStore

**Files:**
- Create: `src/thread/thread-store.ts`
- Test: `src/thread/thread-store.test.ts`

> Blackboard = truth. Best-effort + capped (s38 idiom) but uses real `appendFile` + an in-memory byte counter (O(1) appends, unlike CI's whole-file rewrite). Thread ids validated with `isPathSafeId` (allows dots — `[api/run-id-dot-validation-mismatch]`). Symlink-guarded create (`[scaffold/symlink-escape]`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./thread-store.js";

const noopLog = () => {};
let dir: string;
let store: ThreadStore;
let t = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threads-"));
  t = 1_000;
  store = new ThreadStore({ threadsRoot: join(dir, "threads"), log: noopLog, now: () => ++t });
});

describe("ThreadStore", () => {
  it("creates a thread with meta and lists it", async () => {
    const meta = await store.create({ id: "th-a", title: "Build X" });
    expect(meta.status).toBe("chatting");
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(["th-a"]);
  });

  it("appends entries and replays them in order with stamped ts", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "operator_msg", text: "hi" });
    await store.append("th-a", { type: "orchestrator_msg", text: "hello" });
    const read = await store.read("th-a");
    expect(read?.entries.map((e) => e.type)).toEqual(["operator_msg", "orchestrator_msg"]);
    expect(read!.entries[0]!.ts).toBeLessThan(read!.entries[1]!.ts);
  });

  it("readNdjson returns raw lines for SSE replay", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "run_link", runId: "run-1" });
    const raw = await store.readNdjson("th-a");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ type: "run_link", runId: "run-1" });
  });

  it("setMeta patches run_id + status", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.setMeta("th-a", { run_id: "run-1", status: "running" });
    const read = await store.read("th-a");
    expect(read?.meta).toMatchObject({ run_id: "run-1", status: "running" });
  });

  it("caps ndjson and appends exactly one truncation marker, then stops", async () => {
    const small = new ThreadStore({ threadsRoot: join(dir, "threads"), log: noopLog, now: () => ++t, maxBytes: 400 });
    await small.create({ id: "th-b", title: "X" });
    for (let i = 0; i < 50; i++) await small.append("th-b", { type: "operator_msg", text: `line ${i}` });
    const raw = await small.readNdjson("th-b");
    expect(raw).toContain("truncated");
    // capped: further appends do not grow the file
    const before = raw.length;
    await small.append("th-b", { type: "operator_msg", text: "after cap" });
    expect((await small.readNdjson("th-b")).length).toBe(before);
  });

  it("append/read never throw on a missing thread (best-effort)", async () => {
    await expect(store.append("missing", { type: "operator_msg", text: "x" })).resolves.toBeUndefined();
    expect(await store.read("missing")).toBeNull();
  });

  it("rejects a path-unsafe id at create", async () => {
    await expect(store.create({ id: "../evil", title: "X" })).rejects.toThrow();
  });

  it("tolerates a corrupt ndjson line on replay (skips it)", async () => {
    await store.create({ id: "th-a", title: "X" });
    await store.append("th-a", { type: "operator_msg", text: "ok" });
    // manually corrupt
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "threads", "th-a", "thread.ndjson"), "{not json}\n");
    const read = await store.read("th-a");
    expect(read?.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathSafeId } from "../orchestrator/task-spec.js";
import {
  threadEntrySchema, threadMetaSchema,
  type ThreadEntry, type ThreadEntryInput, type ThreadMeta, type ThreadStatus,
} from "./thread-types.js";

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
    // symlink guard: an attacker-planted threads/<id> symlink must not let writes escape
    const d = this.dir(input.id);
    if (existsSync(d) && lstatSync(d).isSymbolicLink()) throw new Error(`thread dir is a symlink: ${input.id}`);
    await mkdir(d, { recursive: true });
    const meta: ThreadMeta = { id: input.id, title: input.title, created_at: this.now(), status: "chatting" };
    await writeFile(this.metaPath(input.id), JSON.stringify(meta, null, 2));
    this.sizes.set(input.id, { bytes: 0, capped: false });
    return meta;
  }

  async append(id: string, entry: ThreadEntryInput): Promise<void> {
    try {
      if (!existsSync(this.dir(id))) return; // best-effort: no such thread
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
      this.log("WARN", `thread append failed for ${id}: ${String((err as Error)?.message ?? err)}`);
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
      this.log("WARN", `thread setMeta failed for ${id}: ${String((err as Error)?.message ?? err)}`);
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
```

> The truncation marker's `ts:0` is cosmetic; if the agreement/status parse is strict about ts on replay, that's fine (it parses). Adjust `maxBytes` default if the operator later wants larger threads.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thread): append-only capped thread store`.

## Task A6: ThreadEventBus + SSE handler

**Files:**
- Create: `src/api/thread-events.ts`
- Test: `src/api/thread-events.test.ts`

> Direct copy of `src/api/ci-events.ts` structure (`CiEventBus` + `handleCiStream`), including the **replay-disconnect-leak fix** (register `res.on("close")` synchronously before the async replay; `.finally` subscribes only `if (!closed)`) and `flushHeaders()`. Difference: threads stream two frame kinds — full entries and token frames — so the bus broadcasts pre-serialized strings.

- [ ] **Step 1: Write the failing test** (mirror `ci-events.test.ts`, including the two load-bearing cases)

```ts
import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { ThreadEventBus, handleThreadStream } from "./thread-events.js";

function fakeRes() {
  const chunks: string[] = [];
  let onClose: (() => void) | undefined;
  const res = {
    writeHead() { return res; },
    flushHeaders() {},
    write(c: string) { chunks.push(c); return true; },
    end() {},
    on(ev: string, cb: () => void) { if (ev === "close") onClose = cb; return res; },
  } as unknown as ServerResponse;
  return { res, chunks, close: () => onClose?.() };
}

describe("ThreadEventBus", () => {
  it("broadcasts entries and tokens to subscribers as SSE frames", () => {
    const bus = new ThreadEventBus();
    const { res, chunks } = fakeRes();
    handleThreadStream({ bus, readNdjson: async () => "" }, "th-1", res);
    return new Promise((r) => setImmediate(r)).then(() => {
      bus.broadcast("th-1", JSON.stringify({ type: "operator_msg", ts: 1, text: "hi" }));
      bus.broadcast("th-1", JSON.stringify({ type: "token", text: "he" }));
      expect(chunks.some((c) => c.includes("operator_msg"))).toBe(true);
      expect(chunks.some((c) => c.includes('"token"'))).toBe(true);
    });
  });

  it("replays history then goes live", async () => {
    const bus = new ThreadEventBus();
    const { res, chunks } = fakeRes();
    handleThreadStream({ bus, readNdjson: async () => JSON.stringify({ type: "run_link", ts: 1, runId: "r" }) + "\n" }, "th-1", res);
    await new Promise((r) => setImmediate(r));
    expect(chunks.some((c) => c.includes("run_link"))).toBe(true);
  });

  it("does not leak a subscription when the client disconnects during replay", async () => {
    const bus = new ThreadEventBus();
    const { res, close } = fakeRes();
    let resolveReplay: (v: string) => void;
    handleThreadStream({ bus, readNdjson: () => new Promise<string>((r) => { resolveReplay = r; }) }, "th-1", res);
    close(); // disconnect DURING replay
    resolveReplay!("");
    await new Promise((r) => setImmediate(r));
    expect((bus as any).subs.get("th-1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** (adapt `ci-events.ts` verbatim)

```ts
import type { ServerResponse } from "node:http";

export interface ThreadStreamSink { write(chunk: string): void; end(): void; }

export class ThreadEventBus {
  private readonly subs = new Map<string, Set<ThreadStreamSink>>();
  subscribe(threadId: string, sink: ThreadStreamSink): void {
    let set = this.subs.get(threadId);
    if (!set) { set = new Set(); this.subs.set(threadId, set); }
    set.add(sink);
  }
  unsubscribe(threadId: string, sink: ThreadStreamSink): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.subs.delete(threadId);
  }
  /** Fan out a pre-serialized frame string (entry JSON or token frame JSON). */
  broadcast(threadId: string, payload: string): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const sink of set) {
      try { sink.write(payload); } catch { /* dead socket must not crash broadcast */ }
    }
  }
  closeAll(): void {
    for (const set of this.subs.values()) for (const s of set) { try { s.end(); } catch { /* */ } }
    this.subs.clear();
  }
}

export interface ThreadStreamProvider {
  bus: ThreadEventBus;
  readNdjson: (threadId: string) => Promise<string>;
}

export function handleThreadStream(tp: ThreadStreamProvider | undefined, threadId: string, res: ServerResponse): void {
  if (!tp) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders();
  const sink: ThreadStreamSink = {
    write: (chunk) => { try { res.write(`data: ${chunk}\n\n`); } catch { /* client gone */ } },
    end: () => { try { res.end(); } catch { /* already closed */ } },
  };
  let closed = false;
  res.on("close", () => { closed = true; tp.bus.unsubscribe(threadId, sink); });
  void tp.readNdjson(threadId)
    .then((ndjson) => {
      if (closed) return;
      for (const line of ndjson.split(/\r?\n/)) { const t = line.trim(); if (t) sink.write(t); }
    })
    .catch(() => { /* no history yet */ })
    .finally(() => { if (!closed) tp.bus.subscribe(threadId, sink); });
}
```

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thread): ThreadEventBus + replay-then-live SSE handler`.

---

# PHASE B — Pre-launch thread chat + confirm

## Task B1: ChatSessionManager streams the opening turn

**Files:**
- Modify: `src/orchestrator/chat-session-manager.ts` (`start` input + session creation)
- Test: `src/orchestrator/chat-session-manager.test.ts` (add a case)

> The only change to the proven s34 manager: `start` accepts an optional `sink`, set as `s.sseRes` at session creation, so the opening turn's tokens stream to it. Existing callers pass no sink → `null` → byte-identical behavior. This does NOT reintroduce `[chat/onToken-bound-once]`: token routing still flows through the existing `forwardToken` closure that re-looks-up `s.sseRes` fresh per token.

- [ ] **Step 1: Add a failing test**

```ts
it("streams the opening turn to a sink provided at start", async () => {
  const tokens: string[] = [];
  const sink = { write: (c: string) => tokens.push(c), end: () => {} };
  const adapter = makeFakeAdapter({ openingTokens: ["He", "llo"], openingReply: "Hello" }); // fake emits onToken during startSession
  const mgr = new ChatSessionManager({ adapter, log: () => {} });
  await mgr.start({ projectId: "p", intent: "hi", state: fakeSnapshot(), onToken: () => {}, sink });
  expect(tokens.join("")).toContain("token");
});
```

> Use/extend the existing fake adapter in the test file so `startSession` invokes its `onToken` for each opening token (the manager wraps that into `forwardToken` which writes to `s.sseRes`). If the current fake doesn't emit opening tokens, extend it minimally.

- [ ] **Step 2: Run** the new case → FAIL.

- [ ] **Step 3: Implement** — in `start(input)`:
  1. Add `sink?: ChatStreamSink` to the `start` input type.
  2. Where the `ManagedSession` is created (currently `sseRes: null`), set `sseRes: input.sink ?? null`.

```ts
// start input type
async start(input: {
  projectId: string;
  intent: string;
  state: ReadSnapshot;
  onToken: (text: string) => void;
  sink?: ChatStreamSink;   // NEW: attach at creation so the opening turn streams
}): Promise<{ sessionId: string; turn: ChatTurnResult }> {
  // ... existing guard + startSession race ...
  const session: ManagedSession = {
    projectId: input.projectId,
    handle,
    lastActivityAt: this.now(),
    sseRes: input.sink ?? null,   // was: null
    turnInFlight: false,
  };
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run** the whole chat-session-manager suite → all PASS (existing cases unaffected); `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(chat): optional start sink so the opening turn can stream`.

## Task B2: `performLaunch` — res-decoupled launch core

**Files:**
- Create: `src/orchestrator/launch.ts`
- Modify: `src/api/server.ts` (`launchOrchestrate` calls `performLaunch`; `handleChatConfirm` unchanged behavior)
- Test: `src/orchestrator/launch.test.ts`

> Extracts the R1-safe core (`onOrchestrate` + in-flight guard) from today's HTTP-coupled `launchOrchestrate` so BOTH the confirm button and the LAUNCH-by-word path can trigger a run without a `ServerResponse`. Still just `onOrchestrate` — R1 intact.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { performLaunch } from "./launch.js";

describe("performLaunch", () => {
  it("fires onOrchestrate once and marks in-flight", async () => {
    const inFlight = new Set<string>();
    const onOrchestrate = vi.fn(async () => {});
    const r = await performLaunch({ pid: "p", intent: "build X", onOrchestrate, inFlight, log: () => {} });
    expect(r).toEqual({ accepted: true });
    expect(onOrchestrate).toHaveBeenCalledWith("build X");
  });

  it("rejects a concurrent launch for the same project", async () => {
    const inFlight = new Set<string>(["p"]);
    const r = await performLaunch({ pid: "p", intent: "x", onOrchestrate: async () => {}, inFlight, log: () => {} });
    expect(r).toEqual({ accepted: false, reason: "in_flight" });
  });

  it("rejects when onOrchestrate is undefined", async () => {
    const r = await performLaunch({ pid: "p", intent: "x", onOrchestrate: undefined, inFlight: new Set(), log: () => {} });
    expect(r).toEqual({ accepted: false, reason: "unsupported" });
  });

  it("clears in-flight after the fire-and-forget run settles", async () => {
    const inFlight = new Set<string>();
    let resolveRun: () => void;
    const onOrchestrate = () => new Promise<void>((res) => { resolveRun = res; });
    await performLaunch({ pid: "p", intent: "x", onOrchestrate, inFlight, log: () => {} });
    expect(inFlight.has("p")).toBe(true);
    resolveRun!();
    await new Promise((r) => setImmediate(r));
    expect(inFlight.has("p")).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
export type LaunchResult = { accepted: true } | { accepted: false; reason: "in_flight" | "unsupported" };

export interface PerformLaunchInput {
  pid: string;
  intent: string;
  onOrchestrate: ((intent: string) => Promise<void> | void) | undefined;
  inFlight: Set<string>;
  log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
}

export async function performLaunch(input: PerformLaunchInput): Promise<LaunchResult> {
  const { pid, intent, onOrchestrate, inFlight, log } = input;
  if (!onOrchestrate) return { accepted: false, reason: "unsupported" };
  if (inFlight.has(pid)) return { accepted: false, reason: "in_flight" };
  inFlight.add(pid);
  void Promise.resolve()
    .then(() => onOrchestrate(intent))
    .catch((err) => { try { log("ERROR", `orchestrate failed for ${pid}: ${String((err as Error)?.message ?? err)}`); } catch { /* fail-closed */ } })
    .finally(() => { inFlight.delete(pid); });
  return { accepted: true };
}
```

- [ ] **Step 4: Refactor `launchOrchestrate` in `server.ts`** to delegate, preserving its exact HTTP status codes:

```ts
async function launchOrchestrate(pid: string, p: ProjectView, intent: string, res: ServerResponse): Promise<void> {
  const r = await performLaunch({ pid, intent, onOrchestrate: p.onOrchestrate, inFlight: orchestrateInFlight, log: safeLog });
  if (!r.accepted && r.reason === "unsupported") { res.writeHead(404, jsonHeaders); res.end(JSON.stringify({ error: "not found" })); return; }
  if (!r.accepted && r.reason === "in_flight") { res.writeHead(409, jsonHeaders); res.end(JSON.stringify({ error: "a run is already starting for this project" })); return; }
  res.writeHead(202, jsonHeaders); res.end(JSON.stringify({ accepted: true, intent }));
}
```

> Match the exact error strings/headers currently in `launchOrchestrate` (grep it first). Run `src/api/server.test.ts` to confirm `/orchestrate` + `/chat/confirm` behavior is unchanged.

- [ ] **Step 5: Run** `npx vitest run src/orchestrator/launch.test.ts src/api/server.test.ts` → PASS; `npm run typecheck`.
- [ ] **Step 6: Commit** `refactor(orchestrate): extract res-decoupled performLaunch`.

## Task B3: ThreadChatService — bridge chat ↔ thread (pre-launch)

**Files:**
- Create: `src/orchestrator/thread-chat-service.ts`
- Test: `src/orchestrator/thread-chat-service.test.ts`

> Owns the pre-launch phase: starts a thread + chat session, mirrors every turn into the thread (streaming tokens via the fence stripper → bus; persisting stripped `orchestrator_msg` + `plan`), and handles confirm (button) + LAUNCH-by-word, both via `performLaunch`. Holds the `thread → sessionId` map so the UI only ever addresses threads. On confirm it releases the chat session, writes `run_link`, sets meta, and hands off to the narrator (injected `startNarrator` callback).

Design contract (encode as tests):
- `startThread(intent)` → creates thread `th`, appends `operator_msg{intent}`, kicks `manager.start` in the background with a **thread-bus filtering sink** (parses `{type:"token",text}` frames, runs text through a per-turn `StreamingFenceStripper`, broadcasts filtered token frames, accumulates stripped text), stores sessionId when start resolves, then persists `orchestrator_msg{stripped}` (+ `plan` if specs) and broadcasts those entries. Returns `{ threadId }` immediately.
- `sendMessage(threadId, text)` (pre-launch) → append+broadcast `operator_msg`; reset stripper; `manager.send`; persist+broadcast `orchestrator_msg`(+`plan`); then **LAUNCH-by-word check**: if `containsLaunchMarker(reply)` AND the thread has a `plan` entry AND no `run_link` yet → call `confirm(threadId)`.
- `confirm(threadId)` → assemble `finalIntent` from the thread's `operator_msg` texts joined with "; "; `performLaunch`; on accept: `manager.cancel(sessionId)`, append `run_link` (runId discovered later by narrator — see note), set meta `status:"running"`, call `startNarrator({ threadId, finalIntent, launchedAt })`. Returns `{accepted}`.

> **run_link runId:** `onOrchestrate` is fire-and-forget and mints the runId asynchronously; the service does NOT know it at confirm time. So `confirm` sets meta `status:"running"` and hands `finalIntent`+`launchedAt` to the narrator, which discovers the run and writes the `run_link` entry + meta.run_id (Task C6). Do NOT append a `run_link` with a guessed id here.

- [ ] **Step 1: Write the failing test** (use fakes for manager, store, bus, performLaunch via an injected `launch` fn, and a `startNarrator` spy)

```ts
import { describe, it, expect, vi } from "vitest";
import { ThreadChatService } from "./thread-chat-service.js";
import { LAUNCH_MARKER } from "../thread/launch-marker.js";

function makeDeps(overrides: any = {}) {
  const appended: any[] = [];
  const store = {
    create: vi.fn(async ({ id, title }: any) => ({ id, title, created_at: 1, status: "chatting" })),
    append: vi.fn(async (_id: string, e: any) => { appended.push(e); }),
    read: vi.fn(async () => ({ meta: { id: "th", title: "t", created_at: 1, status: "chatting" }, entries: appended.map((e, i) => ({ ts: i, ...e })) })),
    setMeta: vi.fn(async () => {}),
    readNdjson: vi.fn(async () => ""),
    list: vi.fn(async () => []),
  };
  const bus = { broadcast: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), closeAll: vi.fn() };
  const manager = {
    start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "Hello", proposedSpecs: undefined } })),
    send: vi.fn(async () => ({ reply: "ok", proposedSpecs: undefined })),
    cancel: vi.fn(async () => true),
    hasSession: vi.fn(() => true),
    ...overrides.manager,
  };
  const launch = vi.fn(async () => ({ accepted: true }));
  const startNarrator = vi.fn();
  const svc = new ThreadChatService({
    store, bus, manager, log: () => {}, now: (() => { let t = 0; return () => ++t; })(),
    buildSnapshot: async () => ({} as any),
    launch, startNarrator, mintThreadId: (intent: string) => "th",
    ...overrides.deps,
  } as any);
  return { svc, store, bus, manager, launch, startNarrator, appended };
}

describe("ThreadChatService", () => {
  it("startThread creates a thread, persists operator + orchestrator turns", async () => {
    const { svc, store, appended } = makeDeps();
    const { threadId } = await svc.startThread("p", "build X");
    await svc.waitIdle?.(); // if the impl kicks start in the background, expose a test hook to await it
    expect(threadId).toBe("th");
    expect(store.create).toHaveBeenCalled();
    expect(appended.some((e) => e.type === "operator_msg")).toBe(true);
    expect(appended.some((e) => e.type === "orchestrator_msg")).toBe(true);
  });

  it("persists a plan entry when the turn proposes specs", async () => {
    const { svc, appended } = makeDeps({ manager: { start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan ready", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })) } });
    await svc.startThread("p", "x");
    await svc.waitIdle?.();
    expect(appended.some((e) => e.type === "plan")).toBe(true);
  });

  it("strips fenced json from the persisted orchestrator prose", async () => {
    const reply = "Here:\n```json\n[{\"id\":\"t1\"}]\n```\nready";
    const { svc, appended } = makeDeps({ manager: { start: vi.fn(async () => ({ sessionId: "s1", turn: { reply, proposedSpecs: [] } })) } });
    await svc.startThread("p", "x");
    await svc.waitIdle?.();
    const om = appended.find((e) => e.type === "orchestrator_msg");
    expect(om.text).not.toContain("```json");
  });

  it("LAUNCH-by-word launches only with a plan and no run_link", async () => {
    // seed: startThread produced a plan
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
      send: vi.fn(async () => ({ reply: `Launching ${LAUNCH_MARKER}`, proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle?.();
    await svc.sendMessage("th", "go");
    expect(launch).toHaveBeenCalled();
  });

  it("ignores LAUNCH marker when there is no plan entry", async () => {
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "let me ask", proposedSpecs: undefined } })),
      send: vi.fn(async () => ({ reply: `sure ${LAUNCH_MARKER}`, proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle?.();
    await svc.sendMessage("th", "go");
    expect(launch).not.toHaveBeenCalled();
  });

  it("confirm launches, cancels the session, sets meta running, starts narrator", async () => {
    const { svc, launch, manager, store, startNarrator } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle?.();
    const r = await svc.confirm("th");
    expect(r).toEqual({ accepted: true });
    expect(launch).toHaveBeenCalled();
    expect(manager.cancel).toHaveBeenCalledWith("s1");
    expect(store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ status: "running" }));
    expect(startNarrator).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `ThreadChatService`. Key points:
  - Deps: `{ store: ThreadStore; bus: ThreadEventBus; manager: ChatSessionManager; log; now; buildSnapshot: () => Promise<ReadSnapshot>; launch: (pid, intent) => Promise<LaunchResult>; startNarrator: (a: { projectId; threadId; finalIntent; launchedAt }) => void; mintThreadId: (intent) => string }`.
  - Internal `threadSessions = new Map<string, { projectId: string; sessionId: string }>()` and `pending = new Map<string, Promise<void>>()` for the background opening turn (expose `waitIdle(threadId?)` for tests).
  - `makeSink(threadId)` returns a `ChatStreamSink` whose `write(frame)` JSON-parses `{type:"token",text}`, feeds `text` to the turn's `StreamingFenceStripper`, and `bus.broadcast(threadId, JSON.stringify({ type: "token", text: emitted }))` when the stripper emits non-empty; `end()` = noop (bus subscription outlives the chat session).
  - Per-turn: create a fresh `StreamingFenceStripper`; after the turn resolves, `stripper.end()` and persist `orchestrator_msg { text: stripFencedJson(result.reply) }` (authoritative persisted text) + broadcast that entry; if `result.proposedSpecs?.length` persist+broadcast `plan { specs: toPlanPreview(result.proposedSpecs) }`. (Live stream shows the incrementally-stripped tokens; the persisted entry uses batch `stripFencedJson` — Task A3 proved they agree.)
  - `mintThreadId`: `slugifyIntent(intent)` + a collision suffix if `store.read(id)` exists (loop `-2`, `-3`, ...). Inject for tests.
  - Guard-check for LAUNCH-by-word: read the thread, require an existing `plan` entry and no `run_link`, and that the current turn is the immediate reply to the just-appended `operator_msg` (inherent — it's the same `sendMessage` call).
  - `confirm`: look up `sessionId`; assemble `finalIntent`; `await launch(projectId, finalIntent)`; on accept `manager.cancel(sessionId)` + `store.setMeta(threadId, { status: "running" })` + `startNarrator(...)` + drop from `threadSessions`.

```ts
// sketch of the load-bearing pieces
async startThread(projectId: string, intent: string): Promise<{ threadId: string }> {
  const threadId = await this.uniqueId(intent);
  await this.store.create({ id: threadId, title: intent.slice(0, 80) });
  await this.persist(threadId, { type: "operator_msg", text: intent });
  const p = (async () => {
    try {
      const sink = this.makeSink(threadId);
      const stripper = this.turnStripper(threadId);
      const state = await this.buildSnapshot();
      const { sessionId, turn } = await this.manager.start({ projectId, intent, state, onToken: () => {}, sink });
      this.threadSessions.set(threadId, { projectId, sessionId });
      stripper.done();
      await this.persistTurn(threadId, turn);
    } catch (err) {
      this.safeLog("ERROR", `thread ${threadId} opening turn failed: ${String((err as Error)?.message ?? err)}`);
      await this.persist(threadId, { type: "orchestrator_msg", text: "(the orchestrator could not start — see logs)" });
    } finally { this.pending.delete(threadId); }
  })();
  this.pending.set(threadId, p);
  return { threadId };
}
```

> `makeSink` + `turnStripper` coordinate: keep the active stripper for a thread in a small per-thread state object so the sink and the turn-finalizer share it. Model the session-lifecycle care (one-per-project guard, cancel teardown) on the s34 `ChatModal`/manager lessons — but there is no long-lived process after confirm, so no reaper concerns beyond the manager's own.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thread): pre-launch chat<->thread bridge (stream, strip, launch-by-word, confirm)`.

---

# PHASE C — Post-launch narrator

## Task C1: Activity diff (pure)

**Files:**
- Create: `src/orchestrator/narrator/activity-map.ts`
- Test: `src/orchestrator/narrator/activity-map.test.ts`

> Pure function: given the previous and next read-snapshot of a run (task statuses + presence of gate/verdict artifacts), return the new `activity` cells to append and the milestones to (maybe) narrate. No I/O. This is the read-only heart (adr/003 R1: read).

Define a minimal `RunSnapshot` shape the narrator will build from the read capability:

```ts
export interface TaskSnapshot { taskId: string; status: "pending" | "active" | "escalated" | "quarantine" | "done"; title: string; }
export interface RunSnapshot { runId: string; tasks: TaskSnapshot[]; }
export type Milestone =
  | { kind: "run_started"; runId: string }
  | { kind: "task_active"; taskId: string; title: string }
  | { kind: "task_done"; taskId: string; title: string }
  | { kind: "task_escalated"; taskId: string; title: string }
  | { kind: "run_finished"; runId: string };
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { diffRunSnapshot } from "./activity-map.js";

const T = (taskId: string, status: any, title = taskId) => ({ taskId, status, title });

describe("diffRunSnapshot", () => {
  it("emits run_started + a run cell on first snapshot", () => {
    const { cells, milestones } = diffRunSnapshot(null, { runId: "r", tasks: [T("t1", "pending")] });
    expect(milestones).toContainEqual({ kind: "run_started", runId: "r" });
    expect(cells.some((c) => c.kind === "run")).toBe(true);
  });
  it("emits task_active on pending->active", () => {
    const prev = { runId: "r", tasks: [T("t1", "pending")] };
    const next = { runId: "r", tasks: [T("t1", "active")] };
    const { cells, milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_active", taskId: "t1", title: "t1" });
    expect(cells).toContainEqual(expect.objectContaining({ kind: "worker", status: "running", ref: { taskId: "t1" } }));
  });
  it("emits task_done + run_finished when the last task completes", () => {
    const prev = { runId: "r", tasks: [T("t1", "active")] };
    const next = { runId: "r", tasks: [T("t1", "done")] };
    const { milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_done", taskId: "t1", title: "t1" });
    expect(milestones).toContainEqual({ kind: "run_finished", runId: "r" });
  });
  it("emits task_escalated on ->escalated with an error-status cell", () => {
    const prev = { runId: "r", tasks: [T("t1", "active")] };
    const next = { runId: "r", tasks: [T("t1", "escalated")] };
    const { cells, milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_escalated", taskId: "t1", title: "t1" });
    expect(cells).toContainEqual(expect.objectContaining({ kind: "escalation", status: "error" }));
  });
  it("no cells/milestones when nothing changed", () => {
    const s = { runId: "r", tasks: [T("t1", "active")] };
    expect(diffRunSnapshot(s, s)).toEqual({ cells: [], milestones: [] });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `diffRunSnapshot(prev, next)`:
  - If `prev === null`: push `run_started` milestone + a `run` cell (status running).
  - For each task, compare prev status → next status; map transitions to cells + milestones:
    - `* -> active`: `worker` cell (running) + `task_active`.
    - `* -> done`: `merge` cell (ok) + `task_done`.
    - `* -> escalated`: `escalation` cell (error) + `task_escalated`.
    - `* -> quarantine`: `escalation` cell (warn) (no milestone or a light one).
  - New task appearing (in next, not prev) at `pending`: no cell (avoid noise) — or a light `worker` pending cell; keep it quiet.
  - If all next tasks are terminal (`done`/`quarantine`) and not all were terminal in prev: push `run_finished`.
  - Return `{ cells: ActivityEntry[], milestones }` where `ActivityEntry = Omit<Extract<ThreadEntry,{type:"activity"}>, "ts">`.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(narrator): pure run-snapshot diff -> cells + milestones`.

## Task C2: Milestone coalescing (pure)

**Files:**
- Create: `src/orchestrator/narrator/milestone.ts`
- Test: `src/orchestrator/narrator/milestone.test.ts`

> Bursts of milestones within a short window collapse into one narration call. Pure: given pending milestones each with an enqueued-at time, `now`, and a window, decide which to fire (oldest is older than the window → flush all pending) vs keep.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { coalesceMilestones } from "./milestone.js";

const M = (at: number, kind = "task_active") => ({ at, milestone: { kind } as any });

describe("coalesceMilestones", () => {
  it("keeps recent pending milestones (still coalescing)", () => {
    const r = coalesceMilestones([M(100), M(120)], 130, 50);
    expect(r.fire).toEqual([]);
    expect(r.keep).toHaveLength(2);
  });
  it("fires all pending once the oldest exceeds the window", () => {
    const r = coalesceMilestones([M(100), M(120)], 160, 50);
    expect(r.fire).toHaveLength(2);
    expect(r.keep).toEqual([]);
  });
  it("always fires a terminal milestone immediately", () => {
    const r = coalesceMilestones([{ at: 100, milestone: { kind: "run_finished", runId: "r" } as any }], 105, 50);
    expect(r.fire).toHaveLength(1);
  });
  it("nothing pending -> nothing fires", () => {
    expect(coalesceMilestones([], 100, 50)).toEqual({ fire: [], keep: [] });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Milestone } from "./activity-map.js";

export interface PendingMilestone { at: number; milestone: Milestone; }
const TERMINAL = new Set(["run_finished", "task_escalated"]);

export function coalesceMilestones(pending: PendingMilestone[], now: number, windowMs: number): { fire: PendingMilestone[]; keep: PendingMilestone[] } {
  if (pending.length === 0) return { fire: [], keep: [] };
  const hasTerminal = pending.some((p) => TERMINAL.has(p.milestone.kind));
  const oldest = Math.min(...pending.map((p) => p.at));
  if (hasTerminal || now - oldest >= windowMs) return { fire: pending, keep: [] };
  return { fire: [], keep: pending };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(narrator): milestone burst coalescing`.

## Task C3: Narration prompt builders

**Files:**
- Create: `src/orchestrator/narrator/narration-prompt.ts`
- Test: `src/orchestrator/narrator/narration-prompt.test.ts`

> Build the one-shot prompt. Feed a compacted replay of the thread (recent prose + cells) + the triggering milestone(s); instruct the model to narrate in one short paragraph, no tools, no JSON, first person as the project's orchestrator. Separate builder for mid-run operator Q&A (thread replay + a read-only state snapshot + the question).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildNarrationPrompt, buildMidRunReplyPrompt } from "./narration-prompt.js";

describe("narration prompts", () => {
  it("includes the trigger and asks for short prose without JSON", () => {
    const p = buildNarrationPrompt(
      [{ ts: 1, type: "operator_msg", text: "build X" } as any],
      [{ kind: "task_done", taskId: "t1", title: "add endpoint" } as any],
    );
    expect(p).toContain("add endpoint");
    expect(p.toLowerCase()).toContain("short");
    expect(p).toContain("build X");
  });
  it("mid-run reply includes the operator question and state", () => {
    const p = buildMidRunReplyPrompt([{ ts: 1, type: "operator_msg", text: "build X" } as any], "1 task active, gate pending", "how is it going?");
    expect(p).toContain("how is it going?");
    expect(p).toContain("gate pending");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — plain string builders. Include: a compact system-ish preamble ("You are the orchestrator narrating a live run to the operator. Reply with ONE short paragraph of plain prose. No JSON, no code fences, no tool use."), a bounded replay (last N entries → `role: text` / `[cell kind status] summary` lines), and the trigger/question. Keep replay bounded (e.g. last 20 entries, truncate long text).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(narrator): one-shot narration + mid-run reply prompts`.

## Task C4: Orchestrator one-shot adapter

**Files:**
- Create: `src/orchestrator/narrator/orchestrator-oneshot.ts`
- Test: `src/orchestrator/narrator/orchestrator-oneshot.test.ts`

> A single `claude -p` stream-json call that streams text deltas via `onToken` and resolves with the full reply on the `result` event, then the process exits. Reuses `parseChatWireLine` (`src/orchestrator/chat-wire.ts`) for token/turn-done extraction and `cross-spawn` (Windows `.cmd`-safe). Same isolation flags as the chat adapter (`--safe-mode --strict-mcp-config --tools ""`). Injectable `spawnFn` for tests.

- [ ] **Step 1: Write the failing test** (fake spawn emitting stream-json lines; assert tokens + resolved text)

```ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runOrchestratorOneShot } from "./orchestrator-oneshot.js";

function fakeSpawn(lines: string[]) {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    setImmediate(() => {
      for (const l of lines) child.stdout.emit("data", Buffer.from(l + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
}

describe("runOrchestratorOneShot", () => {
  it("streams tokens and resolves the full reply", async () => {
    const lines = [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }),
      JSON.stringify({ type: "result", is_error: false, result: "Hello" }),
    ];
    const tokens: string[] = [];
    const reply = await runOrchestratorOneShot({
      exe: "claude", cwd: ".", args: [], prompt: "narrate", onToken: (t) => tokens.push(t), spawnFn: fakeSpawn(lines) as any,
    });
    expect(tokens.join("")).toBe("Hello");
    expect(reply).toBe("Hello");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — spawn `exe` with `[...args, "-p", "--output-format", "stream-json", "--verbose", prompt]` (add the isolation flags at the call site or here — keep consistent with the chat adapter), line-buffer stdout, run each line through `parseChatWireLine`, call `onToken` on `token` events, accumulate, resolve on `turn-done`/`close`. Swallow stdin EPIPE (`[node/stdin-epipe]`). Best-effort timeout optional.

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(narrator): claude -p one-shot streaming adapter`.

## Task C5: NarratorService (assembly + lifecycle)

**Files:**
- Create: `src/orchestrator/narrator/narrator-service.ts`
- Test: `src/orchestrator/narrator/narrator-service.test.ts`

> Ties it together per active thread/run: discovers the run, ticks the read snapshot, appends instant cells, subscribes to `CiEventBus`, coalesces + fires one-shot narration (streamed into the thread), answers mid-run operator messages, and stops on terminal state. Best-effort throughout — narrator failure never touches the run (adr/003 R1: read + report only).

Deps (all injected for tests):

```ts
export interface NarratorDeps {
  projectId: string;
  threadId: string;
  finalIntent: string;
  launchedAt: number;
  store: ThreadStore;
  bus: ThreadEventBus;
  ciBus: CiEventBus;
  read: {
    recentRuns: () => Promise<Array<{ runId: string; created_at: number; intent?: string }>>;
    runSnapshot: (runId: string) => Promise<RunSnapshot | null>;
  };
  narrate: (prompt: string, onToken: (t: string) => void) => Promise<string>; // wraps runOrchestratorOneShot
  log: Logger;
  now: () => number;
  tickMs?: number;      // default 1500
  windowMs?: number;    // default 1200 (coalescing)
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}
```

- [ ] **Step 1: Write the failing test** (drive scripted snapshots through injected `read`, fake `narrate`, manual tick via injected timers)

```ts
import { describe, it, expect, vi } from "vitest";
import { NarratorService } from "./narrator-service.js";

function harness(snaps: any[]) {
  const appended: any[] = [];
  const store = { append: vi.fn(async (_id: string, e: any) => { appended.push(e); }), setMeta: vi.fn(async () => {}), read: vi.fn(async () => ({ meta: {}, entries: appended })) };
  const bus = { broadcast: vi.fn() };
  const ciBus = { subscribe: vi.fn(), unsubscribe: vi.fn() };
  let i = 0;
  const read = {
    recentRuns: vi.fn(async () => [{ runId: "r", created_at: 5000, intent: "x" }]),
    runSnapshot: vi.fn(async () => snaps[Math.min(i, snaps.length - 1)] ?? null),
  };
  const narrate = vi.fn(async (_p: string, onToken: (t: string) => void) => { onToken("narrated"); return "narrated"; });
  let tick: () => void = () => {};
  const svc = new NarratorService({
    projectId: "p", threadId: "th", finalIntent: "x", launchedAt: 1000,
    store, bus, ciBus, read, narrate, log: () => {}, now: (() => { let t = 6000; return () => (t += 1000); })(),
    tickMs: 10, windowMs: 5,
    setInterval: ((fn: any) => { tick = fn; return 1 as any; }) as any,
    clearInterval: (() => {}) as any,
  } as any);
  return { svc, appended, store, read, narrate, advance: async () => { i++; tick(); await new Promise((r) => setImmediate(r)); } };
}

describe("NarratorService", () => {
  it("discovers the run and writes run_link + meta on first tick", async () => {
    const h = harness([{ runId: "r", tasks: [{ taskId: "t1", status: "pending", title: "T" }] }]);
    h.svc.start();
    await h.advance();
    expect(h.appended.some((e) => e.type === "run_link" && e.runId === "r")).toBe(true);
    expect(h.store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ run_id: "r" }));
  });

  it("appends instant activity cells for a transition and narrates the milestone", async () => {
    const h = harness([
      { runId: "r", tasks: [{ taskId: "t1", status: "pending", title: "T" }] },
      { runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] },
    ]);
    h.svc.start();
    await h.advance(); // discover + first snapshot
    await h.advance(); // transition pending->active
    expect(h.appended.some((e) => e.type === "activity" && e.kind === "worker")).toBe(true);
    // after coalescing window, narration fires
    await h.advance();
    expect(h.narrate).toHaveBeenCalled();
    expect(h.appended.some((e) => e.type === "orchestrator_msg" && e.milestone)).toBe(true);
  });

  it("stops and sets meta done when the run finishes", async () => {
    const h = harness([
      { runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] },
      { runId: "r", tasks: [{ taskId: "t1", status: "done", title: "T" }] },
    ]);
    h.svc.start();
    await h.advance();
    await h.advance();
    await h.advance();
    expect(h.store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ status: "done" }));
  });

  it("mid-run message: one-shot reply streamed into the thread", async () => {
    const h = harness([{ runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] }]);
    h.svc.start();
    await h.advance();
    await h.svc.handleOperatorMessage("как дела?");
    expect(h.narrate).toHaveBeenCalled();
    expect(h.appended.some((e) => e.type === "operator_msg" && e.text === "как дела?")).toBe(true);
    expect(h.appended.some((e) => e.type === "orchestrator_msg")).toBe(true);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `NarratorService`:
  - State: `runId: string | null`, `lastSnapshot: RunSnapshot | null`, `pendingMilestones: PendingMilestone[]`, `stopped: boolean`, `timer`.
  - `start()`: seed `lastSnapshot`/`pendingMilestones` from the thread's existing entries if resuming (restart-safe — read the thread, treat already-present cells as seen); set the interval → `tick()`.
  - `tick()` (guard reentrancy with an `inTick` flag):
    1. If no `runId`: `recentRuns()` → newest run with `created_at >= launchedAt` (fallback: newest) → set `runId`; append `run_link{runId}` + broadcast; `setMeta(threadId,{run_id, status:"running"})`; subscribe CI (see below).
    2. `runSnapshot(runId)`; `diffRunSnapshot(lastSnapshot, snap)` → append+broadcast each cell immediately; push milestones to `pendingMilestones` with `at: now()`; `lastSnapshot = snap`.
    3. `coalesceMilestones(pending, now(), windowMs)` → for the `fire` set: build the prompt (`buildNarrationPrompt(recentEntries, firedMilestones)`), `narrate(prompt, onToken→bus.broadcast token frame)`, then append+broadcast `orchestrator_msg{ text: reply, milestone: firedKinds.join(",") }`. `keep` stays pending. Wrap narration in try/catch (best-effort logged skip).
    4. If snapshot shows all-terminal → append a final `run` cell if desired, `setMeta(status: allDone ? "done" : "error")`, `stop()`.
  - CI subscription: when `runId` is known, subscribe a sink per the run's taskIds to `ciBus` mapping `AgentCiEvent` → `activity{kind:"agent_ci"}` cells (best-effort; subscribe as tasks appear, unsubscribe on stop).
  - `handleOperatorMessage(text)`: append+broadcast `operator_msg{text}`; build a state summary from `lastSnapshot`; `buildMidRunReplyPrompt(entries, summary, text)`; `narrate(...)` streaming to the bus; append+broadcast `orchestrator_msg{text: reply}`.
  - `stop()`: `stopped=true`, clear interval, unsubscribe CI. Idempotent.

> Keep every external call best-effort; a narrator throw must never bubble. Guard catch-block loggers (`[ts/fail-closed]`).

- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(narrator): read-only run narrator service`.

## Task C6: `runSnapshot` + `recentRuns` read capability

**Files:**
- Modify: `src/composition/root.ts` (add a `runSnapshot(runId)` read that lists the run's tasks + statuses; reuse existing `recentRuns()` from s32)
- Test: extend an existing capabilities test OR add `src/orchestrator/narrator/run-read.test.ts` if a pure helper is factored.

> The narrator needs a read-only `runSnapshot(runId): RunSnapshot` built from the blackboard: the run manifest's `taskIds` → each task's status (which queue dir it sits in) + title. Reuse the existing read capability (`caps.read`) used by the UI/`useTaskIndex`. `recentRuns()` already exists (s32, `caps.read.recentRuns()`). Factor `buildRunSnapshot(read, runId)` as a thin, testable function if it eases TDD; otherwise wire directly in root.

- [ ] **Step 1:** Write a focused test for `buildRunSnapshot` with a fake read returning a manifest + task statuses; assert the `RunSnapshot` shape.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildRunSnapshot` using the existing manifest reader + task-status reader (grep `root.ts` / capabilities for how the board/`useTaskIndex` derives task status per queue dir). Map to `TaskSnapshot[]`.
- [ ] **Step 4:** Run → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(narrator): read-only run snapshot capability`.

---

# PHASE D — Transport wiring

## Task D1: Thread routes + ProjectView capability + composition

**Files:**
- Modify: `src/api/server.ts` (add `ProjectView.threads`; add 7 routes + handlers)
- Modify: `src/composition/root.ts` (construct `ThreadStore`, `ThreadEventBus`, `ThreadChatService`, narrator factory; expose on `ProjectRoot`)
- Modify: `src/index.ts` (wire `ProjectView.threads`)
- Test: `src/api/server.test.ts` (add thread-route cases with a fake `threads` capability)

> Mirror the s34 chat-route wiring and the s38 CI-stream route. Thread ids validated with `isPathSafeId` on BOTH write and read (`[api/run-id-dot-validation-mismatch]`).

`ProjectView.threads` capability shape:

```ts
threads?: {
  store: ThreadStore;
  bus: ThreadEventBus;
  chat: ThreadChatService;  // startThread / sendMessage(pre) / confirm / cancel
  narratorMessage: (threadId: string, text: string) => Promise<boolean>; // post-launch mid-run turn (routes to the live narrator)
};
```

Routes (under `/projects/:id`, dispatched in the existing sub-path block near the chat routes):

| Method | Path | Handler |
|---|---|---|
| GET | `/threads` | `handleThreadList` → `store.list()` → `200 { threads }` |
| POST | `/threads` | `handleThreadCreate` → validate `{intent}` (reuse MAX_INTENT_LENGTH) → `chat.startThread(pid, intent)` → `201 { threadId }` (409 if one open per project — reuse the manager's one-per-project guard) |
| GET | `/threads/:tid` | `handleThreadGet` → `store.read(tid)` → `200 { meta, entries }` / 404 |
| GET | `/threads/:tid/stream` | `handleThreadStream({ bus, readNdjson: store.readNdjson }, tid, res)` (from Task A6) |
| POST | `/threads/:tid/message` | `handleThreadMessage` → validate `{message}` → if thread meta has `run_id`/status running → `narratorMessage(tid, msg)`; else `chat.sendMessage(tid, msg)` → `200 { ok }` |
| POST | `/threads/:tid/confirm` | `handleThreadConfirm` → `chat.confirm(tid)` → `202 {accepted}` / 404 / 409 |
| DELETE | `/threads/:tid` | `handleThreadCancel` → `chat.cancel(tid)` → `200 {cancelled}` |

- [ ] **Step 1:** Add server.test.ts cases: create→list→get roundtrip; stream replays a persisted entry; message pre-launch routes to `chat.sendMessage`, post-launch (meta has run_id) routes to `narratorMessage`; confirm returns 202; unsafe tid → 400. Use a fake `threads` capability. → FAIL.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the routes + handlers (model on `handleChat*`), add regex/id validation with `isPathSafeId` (via the existing `safeRunId`-style validator; do NOT use the dot-free `safeIdSegment`). Add `ProjectView.threads` to the interface.
- [ ] **Step 4:** In `root.ts`: lazily construct `threadStore = new ThreadStore({ threadsRoot: join(stateDir, "threads"), log })`, `threadBus = new ThreadEventBus()`, and a `threadChat = new ThreadChatService({ store, bus, manager: getChatManager(), buildSnapshot, launch: (pid, intent) => performLaunch({ pid, intent, onOrchestrate, inFlight, log }), startNarrator, ... })` where `startNarrator` builds a `NarratorService` (wired with `read.recentRuns`/`buildRunSnapshot`, `ciBus = getCiBus()`, and `narrate` = a closure over `runOrchestratorOneShot` with the orchestrator exe/args) and keeps it in a `Map<threadId, NarratorService>` so `narratorMessage` can route to it. Expose `get threads()` on `ProjectRoot`.
- [ ] **Step 5:** In `index.ts`, wire `threads: root.threads` into the HTTP `ProjectView` (near the existing `chat:` wiring). Add narrator/thread teardown to daemon shutdown (mirror `chatManagersByProject` → `closeAll`; `threadBus.closeAll()`; stop narrators).
- [ ] **Step 6:** Run `npx vitest run src/api/server.test.ts` + `npm test` + `npm run typecheck` + `npm run build` → all green.
- [ ] **Step 7: Commit** `feat(thread): HTTP routes + composition wiring for threads + narrator`.

## Task D2: codex gate — backend

- [ ] Run the full backend codex GPT-5.5 gate over the Phase A–D diff (rescue subagent submits inline diff; poll from MAIN). Fix findings in place; **re-critic** the fixes with a regression test each. Do not self-certify. Record findings + resolutions for the session log.
- [ ] After CLEAN: `npm test && npm run typecheck && npm run build` green. Commit any fixes.

---

# PHASE E — UI (review-only: typecheck + build, no test infra)

> Before building: **query the live shadcn MCP** (`.mcp.json` → `shadcn`) for purpose-built chat/thread/timeline/conversation blocks. If a block fits better than a hand-composition, use it and note in the PR what was checked (`[shadcn component currency]`). Otherwise compose the vendored `MessageScroller`/`Bubble`/`Collapsible`/`Badge`/`SidebarMenu` per below.

## Task E1: Thread API client + query hooks + SSE hook

**Files:**
- Modify: `ui/src/lib/api.ts`
- Modify: `ui/src/lib/queries.ts`
- Create: `ui/src/lib/useThreadStream.ts`

- [ ] Add to `api.ts` (mirror the chat fns' idiom + `projectPath`):
  - `getThreads(projectId): Promise<{ threads: ThreadMeta[] }>` → `GET /threads`
  - `createThread(projectId, intent): Promise<{ threadId: string }>` → `POST /threads`
  - `getThread(projectId, threadId): Promise<{ meta: ThreadMeta; entries: ThreadEntry[] }>` → `GET /threads/:tid`
  - `postThreadMessage(projectId, threadId, message)` → `POST /threads/:tid/message`
  - `postThreadConfirm(projectId, threadId)` → `POST /threads/:tid/confirm`
  - `deleteThread(projectId, threadId)` → `DELETE /threads/:tid`
  - `threadStreamUrl(projectId, threadId): string` → `…/threads/:tid/stream`
  - Add TS mirror types `ThreadMeta`, `ThreadEntry` (structural copies of the backend zod types).
- [ ] Add to `queries.ts`: `qk.threads(projectId)` / `qk.thread(projectId, threadId)`; hooks `useThreads`, `useThread`, mutations `useCreateThread`, `useThreadMessage`, `useThreadConfirm`, `useThreadCancel` (invalidate `qk.threads` + `qk.thread` appropriately; `useThreadConfirm` also invalidates `qk.runs`+`qk.state` as the chat confirm did).
- [ ] Create `useThreadStream.ts` modeled on `useCiEvents` (`queries.ts:200`): open `new EventSource(api.threadStreamUrl(...))`, parse each `data:` frame as JSON; accumulate `entries: ThreadEntry[]` for non-token frames and a live `streamingText` string for `{type:"token",text}` frames (reset `streamingText` when a new `orchestrator_msg` entry arrives — that entry is the finalized prose). Return `{ entries, streamingText }`. Close on unmount. **Do not** reintroduce a captured-once sink — read state fresh per frame.
- [ ] Run `cd ui && npm run typecheck` → green.
- [ ] Commit `feat(ui): thread api client + query hooks + SSE stream hook`.

## Task E2: ActivityCell + PlanChip + ThreadTranscript

**Files:**
- Create: `ui/src/components/ActivityCell.tsx`, `ui/src/components/PlanChip.tsx`, `ui/src/components/ThreadTranscript.tsx`

- [ ] `ActivityCell`: `Collapsible`+`Badge`+existing status glyphs. Collapsed = one line (`kind · status · summary`); expanded = ref fields. Deep-link per kind via TanStack `Link`: `agent_ci`/`gate` → `/p/$projectId/ci/$taskId`; `worker`/`escalation`/`merge` → `/p/$projectId/tasks/$taskId`; `run` → `/p/$projectId/runs/$runId`. Status → badge tone (running/ok/warn/error).
- [ ] `PlanChip`: ported from `ChatModal`'s plan render (`ChatModal.tsx:267-280`) — "Proposed plan — preview only" label + a `Badge variant="outline"` per spec (`{title} · {type}`), **`max-w-full` + wrap/truncate-with-title** (closes s38 polish bug #2), and an inline **`Launch`** `Button` calling `useThreadConfirm`.
- [ ] `ThreadTranscript`: takes `entries: ThreadEntry[]` + `streamingText`. Renders in ts order inside `MessageScrollerProvider autoScroll` → `MessageScroller` → viewport/content: `operator_msg`/`orchestrator_msg` → `Bubble` (operator=`default`, orchestrator=`outline`, reuse `ChatBubble` shape from the modal); `activity` → `ActivityCell`; `plan` → `PlanChip`; `run_link` → a subtle inline "run started" marker linking to RunView. Append a live streaming bubble for `streamingText` when non-empty. `scrollAnchor` on operator items (as the modal did).
- [ ] Run `cd ui && npm run typecheck` → green.
- [ ] Commit `feat(ui): activity cell, plan chip, thread transcript`.

## Task E3: ThreadView + composer footer + routes + ThreadList

**Files:**
- Create: `ui/src/views/ThreadView.tsx`, `ui/src/components/ThreadList.tsx`
- Modify: `ui/src/router.tsx`, `ui/src/views/HomeView.tsx`, `ui/src/components/NewRunComposer.tsx`, `ui/src/components/AppShell.tsx`

- [ ] `router.tsx`: add `projectThreadRoute` (`path: "/t/$threadId"`, component `ThreadView`) under `projectRoute`; register in `routeTree`. `projectHomeRoute` (`/`) renders the thread host (ThreadView bound to the newest thread, or a fresh-thread greeting empty state). Ensure `AppShell` rail predicate (`AppShell.tsx:52-56`) intentionally includes `/t/` (rail stays status-only — keep it shown).
- [ ] `ThreadView`: reads `threadId` from params (or newest from `useThreads` on the home route); loads `useThread` for initial entries + `useThreadStream` for live; renders `ThreadTranscript` + a footer `NewRunComposer` (send-turn variant). If no threads exist, show an orchestrator greeting + the composer as a fresh-thread starter (not an empty form).
- [ ] `NewRunComposer`: add a mode — on the home/fresh state, `submit()` calls `useCreateThread` then navigates to `/p/$projectId/t/$threadId`; in a thread footer, `submit()` calls `useThreadMessage`. Remove the ChatModal open path + `chatIntent`/`chatOpen` state. The `armDigestWatch` toast machinery is superseded by in-thread narration — remove it (and its digest-watch effect) since the thread now surfaces outcomes.
- [ ] `ThreadList`: `SidebarMenu` of `useThreads` items (status glyph + title, `Link to="/p/$projectId/t/$threadId"`) + a "New thread" action (navigates to `/p/$projectId` fresh state). Mount in `AppShell`/`Sidebar` (below or beside the Projects section).
- [ ] `HomeView`: becomes the thread host (delegate to `ThreadView` newest-thread logic) OR is replaced by `ThreadView` at the home route — pick the smaller diff; the composer-first hero is removed.
- [ ] Run `cd ui && npm run typecheck && npm run build` → green.
- [ ] Commit `feat(ui): thread view as project main screen + sidebar thread list`.

## Task E4: Delete ChatModal + SessionRail contrast fix

**Files:**
- Delete: `ui/src/components/ChatModal.tsx`
- Modify: `ui/src/components/SessionRail.tsx`

- [ ] Delete `ChatModal.tsx`; remove all imports/usages (should be only `NewRunComposer` after E3). `grep` the `ui/` tree for `ChatModal` → zero refs.
- [ ] SessionRail polish bug #3 (`SessionRail.tsx:170-176`): change the CI "open CI run →" `Link` class from `text-accent` to a readable token on the card surface (e.g. `text-foreground underline underline-offset-2` or `text-primary`), matching the zinc contrast rules (`[ui/shadcn-zinc]`).
- [ ] Run `cd ui && npm run typecheck && npm run build` → green.
- [ ] Commit `refactor(ui): remove ChatModal; fix SessionRail CI-link contrast (polish #3)`.

---

# PHASE F — Live-prove + finish

## Task F1: Build both bundles + prepare a live-prove project

- [ ] `npm run build && npm run build:ui` (root daemon + UI — `[build/stale-dist-backend]`).
- [ ] Prepare/refresh a throwaway live-prove project (per s37/s38 recipe): git init on `autodev/main`, a workflow yml (with a `sleep` to make CI watchable), `.autodev/config.yaml`, a fake-but-valid remote, `.git/info/exclude` listing `.autodev/`, `dist/`, `.serena/`; copy `dist/ui` into the project (`[ui/serve-uidir-reporoot]`); run `serve` DETACHED (`Start-Process`).

## Task F2: Live-prove through the real daemon + Chrome (operator-judged, FELT criterion)

- [ ] **Happy path, judged on felt-liveness, not "no crash":** open the project → type an intent → **first orchestrator tokens within seconds** (no dead air; opening turn streams) → discuss (a follow-up turn streams) → the plan chip appears with NO raw JSON in the transcript → launch **by word** ("запускай") → the run **narrates itself**: instant activity cells + milestone prose → click a gate/CI cell → lands on CiRunView/TaskDetail → mid-run "как дела?" → contextual answer → **DONE with a real commit**.
- [ ] **Red path reads as a story too:** a failing workflow or a critic RETRY → the thread shows the escalation/RETRY cell + a prose explanation; the run doesn't stall silently.
- [ ] **Confirm-by-button** path too (plan chip `Launch`).
- [ ] Capture evidence (real commit hash, screenshots/gif of the streamed opening + cells). Present to the operator for the FELT judgement ("does the thread read like the original autodev-loop session?").
- [ ] Any live-only bug found (the s37/s38 pattern: live-prove earns its keep) → root-cause → fix → re-gate the fix → new gotcha if non-obvious.

## Task F3: Finish the branch

- [ ] `superpowers:finishing-a-development-branch`: full green (`npm test`, root+ui typecheck+build), codex CLEAN, live-proven → open ONE PR `autodev/s40-live-orchestrator-attended-presence` → merge after CI green (agent owns the merge per AGENTS.md; gate = codex-clean + green CI).
- [ ] Session-end docs (per CLAUDE.md): CURRENT-STATE + SESSION-LOG + any new gotchas + GOTCHAS count; note s41+ = the unattended-half brainstorm on adr/004.

---

## Self-review notes (author checklist run)

- **Spec §4.1 thread model** → A1/A5. **§4.2 pre-launch (stream opening, strip json, bind thread)** → B1/A3/B3. **§4.3 confirm button+word** → B2/B3 + D1 (routes) + E2 (chip button). **§4.4 narrator (subscribe read-only, instant cells, one-shot milestones, mid-run Q&A, restart-safe)** → C1–C6 + D1. **§4.5 transport** → A6 + D1. **§4.6 UI (routes, sidebar, transcript, cells, plan chip, composer)** → E1–E3. **§4.7 dies/migrates (ChatModal, HomeView, polish #1/#2/#3)** → #1 A3/B3, #2 E2, #3 E4, ChatModal E4, HomeView E3.
- **R1 preserved:** every launch goes through `performLaunch`→`onOrchestrate` (B2); the narrator is read-only (C-phase reads snapshots + subscribes to the existing CiEventBus; no enforcement hooks).
- **Gotchas wired into tasks:** `[chat/onToken-bound-once]` (B1 note + E1), ndjson cap (A5), SSE replay-leak + flushHeaders (A6), run-id dot validation (A5/D1), stale-dist + serve-uidir (F1), fail-closed (A5/C5).
- **Type consistency:** `PlanSpecPreview` (A1) used by `toPlanPreview` (A2), plan entries (A5/B3), and `PlanChip` (E2). `RunSnapshot`/`Milestone` defined in C1, consumed by C2/C5/C6. `ThreadEntryInput` (A1) is the append shape everywhere.
- **Open implementation choice flagged in-plan:** thread↔run binding is done by narrator run-discovery (C5/C6), not a guessed runId at confirm (B3 note) — keeps the fire-and-forget R1 boundary untouched.
