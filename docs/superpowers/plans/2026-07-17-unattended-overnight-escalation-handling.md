# Unattended Overnight Escalation Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution mode (operator-set, s45): **subagent-driven, Sonnet 5 workers; mandatory codex `gpt-5.6-luna` critic gate per module; re-critic in-place fixes; live-prove operator-observable at the end.**

**Goal:** An above-gate, fully deterministic overnight supervisor that resolves escalations the way the operator's reply-B does — auto-reworking retryable escalations (bounded by a budget) and parking the rest, journaling every action — without ever touching the critic/gate/commit.

**Architecture:** A new `src/autonomy/` module runs a bounded loop-until-dry around the existing `conductor.run({drain})`: after each drain it sweeps `queue/escalated/`, reason-routes each escalation by its `EscalationType`, auto-reworks the retryable ones via the s42/s44 reply-B triple (`setAttempts(0)` + move `escalated→pending`, then the next loop drain re-runs them), parks the rest, and appends every decision to `.autodev/decision-journal.ndjson`. Inert unless `autonomy.overnight.enabled`. It calls only `conductor.run`, `repo`, an escalation-type reader, and a journal appender — never the gate (ADR-004 tenet 6).

**Tech Stack:** TypeScript (Node ESM), Zod config, Vitest, the existing `FileBlackboardRepository` + `Conductor` + `parseEscalation`.

**Spec:** `docs/superpowers/specs/2026-07-17-unattended-overnight-escalation-handling-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/config/schema.ts` (modify) | Add the `autonomy.overnight` config block (inert by default). |
| `src/autonomy/decision-journal.ts` (create) | The `DecisionJournalEntry` type + NDJSON serializer. One responsibility: the journal record shape. |
| `src/autonomy/overnight-supervisor.ts` (create) | The routing predicate (`isRetryable`) + the `superviseOvernight` control loop. Pure logic over injected deps. |
| `src/composition/root.ts` (modify) | Wire `superviseOvernight`'s deps (drain closure, escalation-type reader, rework-count read/write, requeue, journal appender) and expose a `runOrSupervise` entry. |
| `src/index.ts` (modify) | Route the CLI `run` drain through `runOrSupervise`. |
| `src/autonomy/decision-journal.test.ts` (create) | Serializer unit tests. |
| `src/autonomy/overnight-supervisor.test.ts` (create) | Routing + loop unit tests (fakes) AND a real repo+scheduler integration test. |

All new production code lives under `src/autonomy/` so the slice is isolated (fork-hygiene + easy to reason about).

---

## Task 1: Config — `autonomy.overnight` block (inert by default)

**Files:**
- Modify: `src/config/schema.ts` (add a block inside `HarnessConfigSchema`, alongside `loop`)
- Test: `src/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/config/schema.test.ts`:

```ts
it("defaults autonomy.overnight to inert (disabled, budget 2)", () => {
  const cfg = HarnessConfigSchema.parse({});
  expect(cfg.autonomy.overnight.enabled).toBe(false);
  expect(cfg.autonomy.overnight.maxAutoReworks).toBe(2);
});

it("accepts an explicit autonomy.overnight block", () => {
  const cfg = HarnessConfigSchema.parse({ autonomy: { overnight: { enabled: true, maxAutoReworks: 3 } } });
  expect(cfg.autonomy.overnight.enabled).toBe(true);
  expect(cfg.autonomy.overnight.maxAutoReworks).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/schema.test.ts -t "autonomy"`
Expected: FAIL — `cfg.autonomy` is undefined.

- [ ] **Step 3: Add the config block**

In `src/config/schema.ts`, inside `HarnessConfigSchema = z.object({ ... })`, add this key immediately after the `loop: z.object({...}).default({})` block:

```ts
  // Unattended overnight autonomy (spec 2026-07-17). Fully inert unless
  // `overnight.enabled` -- attended (the default) behaves exactly as before:
  // escalations park and wait for the operator. When enabled, the overnight
  // supervisor auto-reworks retryable escalations (reply-B) up to
  // `maxAutoReworks` times, then parks. Above the gate only (ADR-004 tenet 6).
  autonomy: z
    .object({
      overnight: z
        .object({
          enabled: z.boolean().default(false),
          maxAutoReworks: z.number().int().nonnegative().default(2),
        })
        .default({ enabled: false, maxAutoReworks: 2 }),
    })
    .default({ overnight: { enabled: false, maxAutoReworks: 2 } }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/schema.test.ts -t "autonomy"`
Expected: PASS (both).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): add inert autonomy.overnight block (enabled=false, maxAutoReworks=2)"
```

---

## Task 2: Decision-journal record + serializer

**Files:**
- Create: `src/autonomy/decision-journal.ts`
- Test: `src/autonomy/decision-journal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/autonomy/decision-journal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serializeDecision, type DecisionJournalEntry } from "./decision-journal.js";

describe("serializeDecision", () => {
  it("emits one JSON object per line, newline-terminated", () => {
    const entry: DecisionJournalEntry = {
      ts: "2026-07-17T00:00:00.000Z",
      taskId: "t-1",
      escalationType: "disagreement",
      decision: "auto-rework",
      reworkCount: 1,
      reason: "disagreement: re-running with critic feedback",
      reversible: true,
    };
    const line = serializeDecision(entry);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual(entry);
  });

  it("includes runId only when present (best-effort field)", () => {
    const withRun = serializeDecision({
      ts: "2026-07-17T00:00:00.000Z", taskId: "t-2", runId: "run-9",
      escalationType: "blocked", decision: "park", reworkCount: 0,
      reason: "blocked: needs operator -- parked for morning review", reversible: true,
    });
    expect(JSON.parse(withRun.trimEnd()).runId).toBe("run-9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/autonomy/decision-journal.test.ts`
Expected: FAIL — module `./decision-journal.js` not found.

- [ ] **Step 3: Write the module**

Create `src/autonomy/decision-journal.ts`:

```ts
import type { EscalationType } from "../escalate/escalate.js";

/** What the overnight supervisor did at one escalation fork. */
export type DecisionKind = "auto-rework" | "park";

/** One append-only line in `.autodev/decision-journal.ndjson`. Shared schema for
 *  the future morning report + later class-2 "decide-and-flag" entries. */
export interface DecisionJournalEntry {
  /** ISO timestamp. */
  ts: string;
  /** Always present -- the stable key the morning report groups on. */
  taskId: string;
  /** Best-effort: the originating run id when the escalation carries one. */
  runId?: string;
  escalationType: EscalationType;
  decision: DecisionKind;
  /** The supervisor's per-task auto-rework count AFTER this decision (park entries
   *  report the count at park time). */
  reworkCount: number;
  reason: string;
  /** Always true in v1 -- both rework and park are cheap to undo (the safety argument). */
  reversible: true;
}

/** Serialize one entry as an NDJSON line (newline-terminated). `JSON.stringify`
 *  omits an absent optional `runId`, so the field appears only when present. */
export function serializeDecision(entry: DecisionJournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/autonomy/decision-journal.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/autonomy/decision-journal.ts src/autonomy/decision-journal.test.ts
git commit -m "feat(autonomy): decision-journal entry type + NDJSON serializer"
```

---

## Task 3: Reason-routing predicate (`isRetryable`)

**Files:**
- Create: `src/autonomy/overnight-supervisor.ts` (routing predicate first; the loop is added in Task 4)
- Test: `src/autonomy/overnight-supervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/autonomy/overnight-supervisor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isRetryable } from "./overnight-supervisor.js";
import type { EscalationType } from "../escalate/escalate.js";

describe("isRetryable (reason-routing table)", () => {
  const retryable: EscalationType[] = ["disagreement", "uncertain", "poison"];
  const park: EscalationType[] = ["constitution", "needs-guard", "blocked", "dirty-file", "drift"];

  for (const t of retryable) it(`routes ${t} -> auto-rework`, () => expect(isRetryable(t)).toBe(true));
  for (const t of park) it(`routes ${t} -> park`, () => expect(isRetryable(t)).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/autonomy/overnight-supervisor.test.ts -t "isRetryable"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the predicate**

Create `src/autonomy/overnight-supervisor.ts`:

```ts
import type { EscalationType } from "../escalate/escalate.js";

/** Reason-routing table (spec 2026-07-17). Litmus: "can a re-run with the critic's
 *  feedback plausibly fix this?" -- yes => auto-rework, no => park. Retryable are the
 *  correctness-verdict + circuit-breaker types; everything contract/operator/transient
 *  (constitution, needs-guard, blocked, dirty-file, drift) parks for a morning decision. */
const RETRYABLE: ReadonlySet<EscalationType> = new Set<EscalationType>(["disagreement", "uncertain", "poison"]);

export function isRetryable(type: EscalationType): boolean {
  return RETRYABLE.has(type);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/autonomy/overnight-supervisor.test.ts -t "isRetryable"`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add src/autonomy/overnight-supervisor.ts src/autonomy/overnight-supervisor.test.ts
git commit -m "feat(autonomy): EscalationType reason-routing predicate (isRetryable)"
```

---

## Task 4: The `superviseOvernight` control loop

**Files:**
- Modify: `src/autonomy/overnight-supervisor.ts` (add the deps interface + loop)
- Test: `src/autonomy/overnight-supervisor.test.ts` (add loop tests with fakes)

- [ ] **Step 1: Write the failing tests**

Extend the EXISTING import of `./overnight-supervisor.js` (added in Task 3) to also pull in `superviseOvernight` and the `OvernightSupervisorDeps` type, and add the two new type imports, then append the test block:

```ts
// Extend the Task-3 import line to:
//   import { isRetryable, superviseOvernight, type OvernightSupervisorDeps } from "./overnight-supervisor.js";
import type { EscalationType } from "../escalate/escalate.js";
import type { DecisionJournalEntry } from "./decision-journal.js";

/** A scriptable fake: `escalatedByDrain[i]` is the escalated-id list returned AFTER the
 *  i-th drain (the last entry repeats if more drains happen). `types` maps id ->
 *  EscalationType. Rework-counts + requeues are recorded for assertions. */
function makeDeps(opts: {
  enabled?: boolean;
  maxAutoReworks?: number;
  escalatedByDrain: string[][];
  types: Record<string, EscalationType>;
}): { deps: OvernightSupervisorDeps; journal: DecisionJournalEntry[]; requeued: string[] } {
  const journal: DecisionJournalEntry[] = [];
  const requeued: string[] = [];
  const counts = new Map<string, number>();
  let drainIdx = -1;
  const deps: OvernightSupervisorDeps = {
    enabled: opts.enabled ?? true,
    maxAutoReworks: opts.maxAutoReworks ?? 2,
    drain: async () => { drainIdx += 1; },
    listEscalated: async () => (opts.escalatedByDrain[Math.min(drainIdx, opts.escalatedByDrain.length - 1)] ?? []).map((id) => ({ id })),
    readEscalationType: async (id) => opts.types[id] ?? null,
    getReworkCount: async (id) => counts.get(id) ?? 0,
    setReworkCount: async (id, n) => void counts.set(id, n),
    requeueForRework: async (id) => void requeued.push(id),
    writeDecision: async (e) => void journal.push(e),
    now: () => "2026-07-17T00:00:00.000Z",
  };
  return { deps, journal, requeued };
}

describe("superviseOvernight", () => {
  it("does nothing when disabled (no drain, no journal)", async () => {
    const { deps, journal, requeued } = makeDeps({ enabled: false, escalatedByDrain: [["a"]], types: { a: "disagreement" } });
    let drained = 0;
    await superviseOvernight({ ...deps, drain: async () => void drained++ });
    expect(drained).toBe(0);
    expect(journal).toEqual([]);
    expect(requeued).toEqual([]);
  });

  it("auto-reworks a disagreement escalation, journals it, then parks it once the budget is spent", async () => {
    // Drain 1 -> [x] still escalated; drain 2 -> [x]; drain 3 -> [x]. maxAutoReworks=2.
    const { deps, journal, requeued } = makeDeps({
      maxAutoReworks: 2,
      escalatedByDrain: [["x"], ["x"], ["x"]],
      types: { x: "disagreement" },
    });
    await superviseOvernight(deps);
    // Two auto-reworks (count 1 then 2), then one park entry.
    expect(requeued).toEqual(["x", "x"]);
    const kinds = journal.map((e) => e.decision);
    expect(kinds).toEqual(["auto-rework", "auto-rework", "park"]);
    expect(journal[0]!.reworkCount).toBe(1);
    expect(journal[1]!.reworkCount).toBe(2);
    expect(journal[2]!.decision).toBe("park");
    expect(journal[2]!.reason).toMatch(/budget exhausted/);
  });

  it("parks a blocked escalation immediately (no rework, one park entry)", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["b"]], types: { b: "blocked" } });
    await superviseOvernight(deps);
    expect(requeued).toEqual([]);
    expect(journal.map((e) => e.decision)).toEqual(["park"]);
    expect(journal[0]!.escalationType).toBe("blocked");
    expect(journal[0]!.reason).toMatch(/needs operator/);
  });

  it("leaves an unclassifiable escalation (null type) untouched and unjournaled", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["u"]], types: {} });
    await superviseOvernight(deps);
    expect(requeued).toEqual([]);
    expect(journal).toEqual([]);
  });

  it("re-runs the loop after an escalation clears (drain 2 empties the queue)", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["y"], []], types: { y: "disagreement" } });
    await superviseOvernight(deps);
    expect(requeued).toEqual(["y"]);            // one rework
    expect(journal.map((e) => e.decision)).toEqual(["auto-rework"]); // cleared -> no park
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/autonomy/overnight-supervisor.test.ts -t "superviseOvernight"`
Expected: FAIL — `superviseOvernight` / `OvernightSupervisorDeps` not exported.

- [ ] **Step 3: Implement the loop**

Append to `src/autonomy/overnight-supervisor.ts`:

```ts
import type { DecisionJournalEntry } from "./decision-journal.js";

export interface OvernightSupervisorDeps {
  /** From cfg.autonomy.overnight -- when false, superviseOvernight is a no-op. */
  enabled: boolean;
  maxAutoReworks: number;
  /** One bounded drain of the whole project queue (`() => conductor.run({drain:true})`). */
  drain: () => Promise<void>;
  /** Ids currently in `queue/escalated/` (`repo.listTasks("escalated")` -> ids). */
  listEscalated: () => Promise<{ id: string }[]>;
  /** The escalation's type (parse `<escalationsDir>/<id>.md`); null if missing/unparseable. */
  readEscalationType: (taskId: string) => Promise<EscalationType | null>;
  getReworkCount: (taskId: string) => Promise<number>;
  setReworkCount: (taskId: string, n: number) => Promise<void>;
  /** The reply-B requeue (setAttempts(0) + move escalated->pending). The next loop
   *  drain re-runs the task, which reads the critic's persisted feedback (s42). */
  requeueForRework: (taskId: string) => Promise<void>;
  writeDecision: (entry: DecisionJournalEntry) => Promise<void>;
  /** ISO timestamp source (injected for deterministic tests). */
  now: () => string;
  log?: (level: string, message: string) => void;
}

/**
 * Bounded loop-until-dry over the project's escalations, ABOVE the gate. Each
 * iteration drains, then reason-routes every escalation: retryable + under budget
 * => auto-rework (journal + requeue), otherwise leave it. Terminates when no
 * actionable escalation remains (each auto-rework consumes finite per-task budget).
 * On exit, every still-escalated task is parked -> one park journal entry each.
 * Never touches the critic/gate/commit -- only the operator-equivalent reply-B path.
 */
export async function superviseOvernight(deps: OvernightSupervisorDeps): Promise<void> {
  if (!deps.enabled) return;

  for (;;) {
    await deps.drain();
    const escalated = await deps.listEscalated();
    const actionable: { id: string; type: EscalationType }[] = [];
    for (const { id } of escalated) {
      const type = await deps.readEscalationType(id);
      if (type === null || !isRetryable(type)) continue;
      if ((await deps.getReworkCount(id)) >= deps.maxAutoReworks) continue;
      actionable.push({ id, type });
    }
    if (actionable.length === 0) break;

    for (const { id, type } of actionable) {
      const next = (await deps.getReworkCount(id)) + 1;
      await deps.writeDecision({
        ts: deps.now(),
        taskId: id,
        escalationType: type,
        decision: "auto-rework",
        reworkCount: next,
        reason: `${type}: re-running with critic feedback`,
        reversible: true,
      });
      await deps.setReworkCount(id, next);
      await deps.requeueForRework(id);
    }
  }

  // Loop exit: every remaining escalated task is parked (park-type OR budget-exhausted).
  const parked = new Set<string>();
  for (const { id } of await deps.listEscalated()) {
    if (parked.has(id)) continue;
    const type = await deps.readEscalationType(id);
    if (type === null) continue; // can't classify -> leave it as-is, do not journal a guess
    await deps.writeDecision({
      ts: deps.now(),
      taskId: id,
      escalationType: type,
      decision: "park",
      reworkCount: await deps.getReworkCount(id),
      reason: isRetryable(type)
        ? `${type}: auto-rework budget exhausted -- parked for morning review`
        : `${type}: needs operator -- parked for morning review`,
      reversible: true,
    });
    parked.add(id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/autonomy/overnight-supervisor.test.ts`
Expected: PASS (all — routing + loop).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/autonomy/overnight-supervisor.ts src/autonomy/overnight-supervisor.test.ts
git commit -m "feat(autonomy): superviseOvernight bounded loop-until-dry (rework+journal / park)"
```

---

## Task 5: Integration test — real repo + escalation files

Proves the supervisor's deps compose correctly against the REAL `FileBlackboardRepository` and the REAL `parseEscalation`, which fakes cannot: rework-count survives in the runtime dir, requeue actually moves the task `escalated→pending` and resets attempts, and the escalation type is read from a real `escalations/<id>.md`.

**Files:**
- Test: `src/autonomy/overnight-supervisor.integration.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `src/autonomy/overnight-supervisor.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import { parseEscalation } from "../escalate/escalate.js";
import { superviseOvernight, type OvernightSupervisorDeps } from "./overnight-supervisor.js";
import { serializeDecision } from "./decision-journal.js";
import { appendFile, readFile } from "node:fs/promises";

let root: string;
let stateDir: string;
let repo: FileBlackboardRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-overnight-"));
  stateDir = join(root, ".autodev");
  mkdirSync(join(stateDir, "escalations"), { recursive: true });
  repo = new FileBlackboardRepository(stateDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Seed a task in queue/<state>/<id>.md (minimal valid front-matter). */
function seedTask(state: "pending" | "escalated", id: string): void {
  const dir = join(stateDir, "queue", state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`);
}

/** Seed an escalation artifact escalations/<id>.md with the given Type. */
function seedEscalation(id: string, type: string): void {
  writeFileSync(
    join(stateDir, "escalations", `${id}.md`),
    [
      `# ESCALATION ${id} -- seeded`,
      `**Type:** ${type}`,
      `**Task:** ${id} -- t`,
      `**What:** seeded`,
      `**Decision:** seeded`,
      `**Option A:** a`,
      `**Option B:** b`,
      `**Cost of wrong:** c`,
      `**Evidence:** e`,
    ].join("\n\n"),
  );
}

function realDeps(over: Partial<OvernightSupervisorDeps> = {}): OvernightSupervisorDeps {
  const journalPath = join(stateDir, "decision-journal.ndjson");
  const escalationsDir = join(stateDir, "escalations");
  return {
    enabled: true,
    maxAutoReworks: 2,
    drain: async () => {}, // no conductor in this test -- we drive the sweep directly
    listEscalated: async () => (await repo.listTasks("escalated")).map((t) => ({ id: t.id })),
    readEscalationType: async (id) => {
      const md = await readFile(join(escalationsDir, `${id}.md`), "utf8").catch(() => null);
      return md ? (parseEscalation(md)?.type ?? null) : null;
    },
    getReworkCount: async (id) => {
      const s = await repo.readRuntimeFile(id, "auto-rework-count");
      const n = s === null ? 0 : Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },
    setReworkCount: async (id, n) => repo.writeRuntimeFile(id, "auto-rework-count", String(n)),
    requeueForRework: async (id) => {
      await repo.setAttempts(id, 0);
      await repo.moveTask(id, "escalated", "pending");
    },
    writeDecision: async (e) => appendFile(journalPath, serializeDecision(e), "utf8"),
    now: () => "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("superviseOvernight (real repo + parseEscalation)", () => {
  it("auto-reworks a real disagreement escalation once: attempts reset, task moved to pending, journal + count persisted", async () => {
    seedTask("escalated", "esc-dis");
    seedEscalation("esc-dis", "disagreement");
    await repo.setAttempts("esc-dis", 3);
    // Drain empties the (now-pending) queue on the 2nd sweep so the loop terminates after one rework.
    let sweeps = 0;
    await superviseOvernight(realDeps({ drain: async () => { sweeps += 1; } }));
    expect(existsSync(join(stateDir, "queue", "pending", "esc-dis.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-dis.md"))).toBe(false);
    expect(await repo.getAttempts("esc-dis")).toBe(0);
    expect(await repo.readRuntimeFile("esc-dis", "auto-rework-count")).toBe("1");
    const journal = readFileSync(join(stateDir, "decision-journal.ndjson"), "utf8").trim().split("\n");
    expect(JSON.parse(journal[0]!).decision).toBe("auto-rework");
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  it("parks a real blocked escalation: stays escalated, one park journal line, no requeue", async () => {
    seedTask("escalated", "esc-blk");
    seedEscalation("esc-blk", "blocked");
    await superviseOvernight(realDeps());
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-blk.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-blk.md"))).toBe(false);
    const journal = readFileSync(join(stateDir, "decision-journal.ndjson"), "utf8").trim().split("\n");
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!).decision).toBe("park");
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `npx vitest run src/autonomy/overnight-supervisor.integration.test.ts`
Expected: FAIL first ONLY if a dep contract is wrong; if the loop + deps are correct it PASSES. If it fails, fix the dep wiring in the test's `realDeps` to match the real `FileBlackboardRepository` signatures (do NOT change the supervisor to accommodate a test bug). Re-run until PASS.

> Note: the first test seeds `escalated` then the sweep moves it to `pending`; because `drain` is a no-op here, the task never re-escalates, so the loop's 2nd `listEscalated` is empty and it terminates after ONE rework (no park). This isolates the requeue mechanics from a live worker.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/autonomy/overnight-supervisor.integration.test.ts
git commit -m "test(autonomy): real repo+parseEscalation integration (requeue + park mechanics)"
```

---

## Task 6: Composition wiring — build the deps + `runOrSupervise`

**Files:**
- Modify: `src/composition/root.ts` (build a `superviseOvernight` deps bundle + expose `runOrSupervise`)

Read `src/composition/root.ts` first to find: the `FileBlackboardRepository` instance, the `Conductor` instance, `cfg`, `repoRoot`, `cfg.stateDir`, and the object the root factory RETURNS (where `conductor`, `applyOnAccept`, `rearmNarratorForTask`, etc. are exposed). Add the new capability to that returned object.

- [ ] **Step 1: Add the imports**

At the top of `src/composition/root.ts`, add:

```ts
import { superviseOvernight } from "../autonomy/overnight-supervisor.js";
import { serializeDecision } from "../autonomy/decision-journal.js";
import { parseEscalation } from "../escalate/escalate.js";
import { appendFile, readFile } from "node:fs/promises";
```

(If any of these are already imported, do not duplicate — reuse the existing import.)

- [ ] **Step 2: Build the deps + `runOrSupervise`, near where `conductor` is finalized**

In the composition where `conductor`, `repo`, `cfg`, `repoRoot` are all in scope (just before the root factory's `return { ... }`), add:

```ts
  // Overnight escalation supervisor (spec 2026-07-17). Above-gate: it only drives the
  // reply-B triple (setAttempts + move) and reads escalation artifacts -- never the gate.
  const escalationsDir = join(repoRoot, cfg.stateDir, "escalations");
  const decisionJournalPath = join(repoRoot, cfg.stateDir, "decision-journal.ndjson");
  const buildSupervisorDeps = () => ({
    enabled: cfg.autonomy.overnight.enabled,
    maxAutoReworks: cfg.autonomy.overnight.maxAutoReworks,
    drain: () => conductor.run({ drain: true }).then(() => undefined),
    listEscalated: async () => (await repo.listTasks("escalated")).map((t) => ({ id: t.id })),
    readEscalationType: async (taskId: string) => {
      const md = await readFile(join(escalationsDir, `${taskId}.md`), "utf8").catch(() => null);
      return md ? (parseEscalation(md)?.type ?? null) : null;
    },
    getReworkCount: async (taskId: string) => {
      const s = await repo.readRuntimeFile(taskId, "auto-rework-count");
      const n = s === null ? 0 : Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },
    setReworkCount: (taskId: string, n: number) => repo.writeRuntimeFile(taskId, "auto-rework-count", String(n)),
    requeueForRework: async (taskId: string) => {
      await repo.setAttempts(taskId, 0);
      await repo.moveTask(taskId, "escalated", "pending");
    },
    writeDecision: (entry: Parameters<typeof serializeDecision>[0]) => appendFile(decisionJournalPath, serializeDecision(entry), "utf8"),
    now: () => new Date().toISOString(),
    log,
  });

  /** Overnight-aware run entry: when overnight autonomy is on, drive the supervisor
   *  loop (which internally drains + sweeps escalations); otherwise a plain drain. */
  const runOrSupervise = async (): Promise<void> => {
    if (cfg.autonomy.overnight.enabled) {
      await superviseOvernight(buildSupervisorDeps());
    } else {
      await conductor.run({ drain: true });
    }
  };
```

- [ ] **Step 3: Expose `runOrSupervise` on the returned root object**

Find the root factory's `return { ... }` (the object that already exposes `conductor`, `applyOnAccept`, `rearmNarratorForTask`, ...). Add `runOrSupervise,` to it.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean (this compiles the new wiring into `dist/`).

- [ ] **Step 5: Commit**

```bash
git add src/composition/root.ts
git commit -m "feat(autonomy): wire superviseOvernight deps + runOrSupervise at the composition root"
```

---

## Task 7: Daemon integration — route the CLI `run` drain through `runOrSupervise`

**Files:**
- Modify: `src/index.ts` (the `run` command path — currently `await root.conductor.run(command.runOpts)`)

- [ ] **Step 1: Route the run command**

In `src/index.ts`, find `await root.conductor.run(command.runOpts);` (the `run` verb). Replace it with an overnight-aware branch:

```ts
  // Overnight autonomy (spec 2026-07-17): when enabled, the run drives the escalation
  // supervisor (drain + auto-rework/park sweep); otherwise the plain bounded run as before.
  if (config.autonomy.overnight.enabled) {
    await root.runOrSupervise();
  } else {
    await root.conductor.run(command.runOpts);
  }
```

(Use the same `config`/`cfg` identifier already in scope at that point in `index.ts`; if the loaded config is named differently there, match it.)

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Full test suite (no regressions)**

Run: `npx vitest run`
Expected: all pass (prior count + the new autonomy tests), 3 skipped.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(autonomy): route the CLI run through runOrSupervise when overnight is enabled"
```

---

## Task 8: Full gate + codex(luna) critic

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npx vitest run && npm run build && npm run build:ui`
Expected: typecheck clean; all tests pass (3 skip); both bundles build.

- [ ] **Step 2: codex `gpt-5.6-luna` critic gate (per the module)**

Produce the full diff of the `src/autonomy/**` + config + composition + index changes and submit it to the codex `gpt-5.6-luna` critic (pin `--model gpt-5.6-luna`; inline-embedded diff, watch the `[critic/codex]` quote-stripping false-positive). Verify each finding against the real source; re-critic in-place fixes; declines allowed WITH rationale. Do NOT self-certify.

- [ ] **Step 3: Address findings + re-critic, then commit any fixes**

```bash
git add -A
git commit -m "fix(autonomy): address codex gpt-5.6-luna gate findings"
```

---

## Task 9: Live-prove (operator-observable, deterministic)

Not a coded task — the project's mandatory end-to-end verification through the real daemon. Deterministic (no reliance on a live worker converging): seed escalated tasks and observe the supervisor's routing + journal + requeue.

- [ ] **Step 1: Enable overnight on the test repo**

In `woodev-shipping-plugin-test`'s `.autodev/config.yaml`, set `autonomy.overnight.enabled: true`, `autonomy.overnight.maxAutoReworks: 2`. (`.autodev` is git-excluded, so this does not dirty the tree.)

- [ ] **Step 2: Seed two escalated tasks (s44 seeding recipe)**

Seed `queue/escalated/esc-dis.md` (valid front-matter; YAML-safe single-line bullets) + `escalations/esc-dis.md` with `**Type:** disagreement`; and `queue/escalated/esc-blk.md` + `escalations/esc-blk.md` with `**Type:** blocked`. Set `runtime/esc-dis/attempts` to `3`.

- [ ] **Step 3: Run the supervisor through the daemon**

Start the daemon build and invoke the run path with overnight enabled (`node dist/index.js run` in the test repo, or the API drive used in s44). Observe via the files/logs (drive the API via PowerShell `Invoke-RestMethod`; a foreground Bash kills the background daemon):

Expected, deterministically:
- **esc-dis** → `decision-journal.ndjson` gains an `auto-rework` line; `runtime/esc-dis/attempts` reset to `0`; `runtime/esc-dis/auto-rework-count` = `1`; the task moved `escalated → pending` (then the real drain re-runs it — convergence is a bonus, not required for the proof).
- **esc-blk** → a `park` line in the journal; the task stays in `queue/escalated/`; no requeue.

- [ ] **Step 4: Record the live-prove evidence + clean up**

Capture the journal lines + file states as the evidence. Reset the test repo (`git` clean is unaffected — `.autodev` is excluded) and set `autonomy.overnight.enabled` back to `false`.

- [ ] **Step 5: Final commit / PR readiness**

Ensure the branch is green (gate + live-prove evidence recorded). The slice is ready to fold into the s45 batch PR.

---

## Self-review notes (author)

- **Spec coverage:** config (Task 1) · journal (Task 2) · routing table (Task 3) · loop/budget/park (Task 4) · reply-B reuse via requeue (Tasks 4/6) · above-gate boundary (deps expose only reply-B + read, Task 6) · inert-when-disabled (Tasks 1/4/7) · testing incl. real-repo integration (Task 5) + live-prove (Task 9). All spec sections map to a task.
- **Type consistency:** `DecisionJournalEntry`/`DecisionKind`/`serializeDecision` (Task 2) reused verbatim in Tasks 4/5/6; `OvernightSupervisorDeps`/`superviseOvernight`/`isRetryable` (Tasks 3/4) reused in 5/6; `parseEscalation`/`EscalationType`/`repo.{listTasks,setAttempts,moveTask,read/writeRuntimeFile,getAttempts}` are the real existing signatures verified against source.
- **Deferred (later slices, per spec non-goals):** morning report, top-bar presence toggle, north-star, anti-drift, LLM decisions, re-plan, splitting the overloaded `blocked` type.
