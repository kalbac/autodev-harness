# Morning Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third report type — the Morning Report — that reads `.autodev/decision-journal.ndjson`, reconciles each overnight decision against the live blackboard (Principle 11), and renders an operator-facing summary with a narrated top-line, surfaced on-demand via `report morning` (CLI) and `GET /projects/:id/morning-report` (endpoint).

**Architecture:** A tolerant NDJSON parser (`parseDecisionJournal`) + a pure builder/renderer/prompt module (`morning-report.ts`, no I/O) + a composition-root method (`morningReport`) that supplies the journal text, a `QueueLookup` built by scanning the queues (reusing the execution report's pattern), and a fail-closed narration step. CLI + endpoint mirror the s52 `report run`/`report qualify` wiring exactly.

**Tech Stack:** TypeScript, ESM, Node ≥20, vitest. Dependency injection for the pure module; the composition root binds real fs/git/model.

**Spec:** `docs/superpowers/specs/2026-07-23-morning-report-design.md`

---

## File Structure

- **Modify** `src/autonomy/decision-journal.ts` — add `parseDecisionJournal(text)` beside `serializeDecision`. One file owns the on-disk format both directions.
- **Create** `src/report/morning-report.ts` — `buildMorningReport` (pure), `renderMorningReport`, `buildMorningReportPrompt`, and the `MorningReport`/`MorningTaskLine`/`QueueLookup` types. No I/O, no model calls.
- **Create** `src/report/morning-report.test.ts` — pure-function unit tests.
- **Modify** `src/autonomy/decision-journal.test.ts` — parser tests.
- **Modify** `src/composition/root.ts` — a `morningReport({since})` method on the ProjectRoot; reuses the queue-scan map (root.ts:1248-1255) for the `QueueLookup` and the `runModel` runner (root.ts:815) for fail-closed narration.
- **Modify** `src/index.ts` — `report morning [--since <ISO>]` CLI subcommand (parse + execute) and the `CliCommand` union.
- **Modify** `src/api/server.ts` — `GET /projects/:id/morning-report[?since=<ISO>]`, beside the run-report route (server.ts:2240).

> NOTE (plan correction vs spec): the spec wrote the endpoint as `GET /morning-report`, but the real report endpoints are project-scoped under the daemon server (`GET /projects/:id/runs/:runId/report`, `POST /projects/:id/qualification-report`). This plan uses the actual convention: `GET /projects/:id/morning-report`.

---

## Task 1: The tolerant journal parser (`parseDecisionJournal`)

**Files:**
- Modify: `src/autonomy/decision-journal.ts`
- Test: `src/autonomy/decision-journal.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/autonomy/decision-journal.test.ts` (create a new `describe` block; keep existing tests):

```ts
import { parseDecisionJournal } from "./decision-journal.js";

describe("parseDecisionJournal", () => {
  const good = (over: Partial<Record<string, unknown>> = {}) =>
    JSON.stringify({
      ts: "2026-07-23T02:00:00.000Z",
      taskId: "t1",
      escalationType: "needs-guard",
      decision: "park",
      reworkCount: 0,
      reason: "needs a guard",
      reversible: true,
      ...over,
    });

  it("parses every valid NDJSON line", () => {
    const text = `${good({ taskId: "a" })}\n${good({ taskId: "b", decision: "auto-rework" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.map((e) => e.taskId)).toEqual(["a", "b"]);
    expect(skipped).toBe(0);
  });

  it("skips and counts a corrupt line without throwing", () => {
    const text = `${good({ taskId: "a" })}\nnot json\n${good({ taskId: "b" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.map((e) => e.taskId)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("skips a JSON line missing a required field", () => {
    const text = `${good()}\n${JSON.stringify({ ts: "x", taskId: "y" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.length).toBe(1);
    expect(skipped).toBe(1);
  });

  it("treats blank/absent input as empty, zero skipped", () => {
    expect(parseDecisionJournal("")).toEqual({ entries: [], skipped: 0 });
    expect(parseDecisionJournal("\n  \n")).toEqual({ entries: [], skipped: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/autonomy/decision-journal.test.ts`
Expected: FAIL — `parseDecisionJournal is not a function`.

- [ ] **Step 3: Implement `parseDecisionJournal`**

Add to `src/autonomy/decision-journal.ts` (after `serializeDecision`):

```ts
/** The set of `decision` values a valid entry may carry. */
const DECISION_KINDS: ReadonlySet<string> = new Set<DecisionKind>(["auto-rework", "park"]);

/** Type guard: is `v` a well-formed `DecisionJournalEntry`? Checks exactly the fields
 *  the morning report reads. `runId` and `reversible` are optional/fixed and not
 *  required for a line to be usable. */
function isDecisionEntry(v: unknown): v is DecisionJournalEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ts"] === "string" &&
    typeof o["taskId"] === "string" &&
    typeof o["escalationType"] === "string" &&
    typeof o["decision"] === "string" &&
    DECISION_KINDS.has(o["decision"]) &&
    typeof o["reworkCount"] === "number" &&
    typeof o["reason"] === "string"
  );
}

/**
 * Parse an NDJSON decision journal tolerantly. Every well-formed line becomes a
 * `DecisionJournalEntry`; a line that is not valid JSON, or is JSON of the wrong
 * shape, is SKIPPED and counted rather than thrown on — one corrupt line must not
 * sink the whole morning report (Principle 10, H1). A blank or absent journal
 * (`""`) yields `{ entries: [], skipped: 0 }`.
 */
export function parseDecisionJournal(text: string): { entries: DecisionJournalEntry[]; skipped: number } {
  const entries: DecisionJournalEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // blank lines are structure, not data
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (isDecisionEntry(parsed)) {
      entries.push(parsed);
    } else {
      skipped++;
    }
  }
  return { entries, skipped };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/autonomy/decision-journal.test.ts`
Expected: PASS (all parser tests + the pre-existing `serializeDecision` tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:
```bash
git add src/autonomy/decision-journal.ts src/autonomy/decision-journal.test.ts
git commit -m "feat(autonomy): tolerant parseDecisionJournal for the morning report"
```

---

## Task 2: The pure morning-report module

**Files:**
- Create: `src/report/morning-report.ts`
- Test: `src/report/morning-report.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/report/morning-report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildMorningReport, renderMorningReport, buildMorningReportPrompt } from "./morning-report.js";
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";

function entry(over: Partial<DecisionJournalEntry> & Pick<DecisionJournalEntry, "taskId" | "ts">): DecisionJournalEntry {
  return {
    escalationType: "needs-guard",
    decision: "park",
    reworkCount: 0,
    reason: "r",
    reversible: true,
    ...over,
  } as DecisionJournalEntry;
}

const now = () => 1_800_000_000_000;

describe("buildMorningReport", () => {
  it("reports 'no decisions' for an empty journal", () => {
    const r = buildMorningReport([], () => null, now);
    expect(r.tasks).toEqual([]);
    expect(r.rollups.tasks_touched).toBe(0);
    expect(renderMorningReport(r)).toMatch(/no overnight decisions/i);
  });

  it("groups by task, counts auto-reworks, and takes the LAST decision by ts", () => {
    const entries = [
      entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 1, reason: "first" }),
      entry({ taskId: "a", ts: "2026-07-23T03:00:00.000Z", decision: "park", reworkCount: 1, reason: "gave up" }),
    ];
    // live state: a is still escalated (parked, unresolved)
    const r = buildMorningReport(entries, (id) => (id === "a" ? "escalated" : null), now);
    const a = r.tasks.find((t) => t.task_id === "a")!;
    expect(a.auto_reworks).toBe(1);
    expect(a.parked).toBe(true);
    expect(a.last_reason).toBe("gave up");
    expect(a.current_state).toBe("escalated");
    expect(a.needs_you).toBe(true);
    expect(r.rollups.still_needs_you).toBe(1);
  });

  it("reconciles against the live blackboard: a parked task now done reads done, not needs-you (Principle 11)", () => {
    const entries = [entry({ taskId: "b", ts: "2026-07-23T02:00:00.000Z", decision: "park", reason: "disagreement" })];
    const r = buildMorningReport(entries, () => "done", now);
    const b = r.tasks[0]!;
    expect(b.parked).toBe(true); // the journal did park it
    expect(b.current_state).toBe("done"); // but the live queue won
    expect(b.needs_you).toBe(false);
    expect(r.rollups.still_needs_you).toBe(0);
  });

  it("filters entries older than `since`", () => {
    const entries = [
      entry({ taskId: "old", ts: "2026-07-22T00:00:00.000Z" }),
      entry({ taskId: "new", ts: "2026-07-23T00:00:00.000Z" }),
    ];
    const r = buildMorningReport(entries, () => null, now, { since: "2026-07-23T00:00:00.000Z" });
    expect(r.tasks.map((t) => t.task_id)).toEqual(["new"]);
    expect(r.window.since).toBe("2026-07-23T00:00:00.000Z");
  });

  it("reports a task the lookup cannot locate as current_state null", () => {
    const entries = [entry({ taskId: "gone", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 2 })];
    const r = buildMorningReport(entries, () => null, now);
    expect(r.tasks[0]!.current_state).toBeNull();
    expect(r.tasks[0]!.needs_you).toBe(false);
  });

  it("counts skipped lines in completeness when provided", () => {
    const r = buildMorningReport([], () => null, now, { skipped: 3 });
    expect(r.completeness.skipped).toBe(3);
  });
});

describe("renderMorningReport / buildMorningReportPrompt", () => {
  it("render includes the narration when present and a fallback when null", () => {
    const entries = [entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 1 })];
    const r = buildMorningReport(entries, () => "done", now);
    expect(renderMorningReport({ ...r, narration: "Overnight I handled one task." })).toMatch(/Overnight I handled one task\./);
    expect(renderMorningReport({ ...r, narration: null })).toMatch(/narration unavailable/i);
  });

  it("prompt asks for one paragraph and includes the task lines", () => {
    const entries = [entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "park", reason: "needs a guard" })];
    const r = buildMorningReport(entries, () => "escalated", now);
    const p = buildMorningReportPrompt(r);
    expect(p).toMatch(/one .*paragraph/i);
    expect(p).toContain("a");
    expect(p).toContain("needs a guard");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/report/morning-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/report/morning-report.ts`**

```ts
/**
 * The Morning Report — the third report type (after the s52 Execution + Qualification
 * pair). It turns the overnight supervisor's decision journal
 * (`.autodev/decision-journal.ndjson`) into an operator-facing summary of what the
 * unattended autonomy DECIDED and where those tasks LANDED, reconciled against the
 * live blackboard (Principle 11: the journal records the decision; the queue is the
 * truth about the current state). This module is PURE — it takes parsed entries, a
 * synchronous `QueueLookup`, and a clock; it does no I/O and calls no model. The
 * composition root supplies the journal text, the lookup, and the narration.
 *
 * Design: `docs/superpowers/specs/2026-07-23-morning-report-design.md`.
 */
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";

/** A task's current queue membership, or `null` when it cannot be located. Same shape
 *  as `execution-report.ts`'s `QueueLookup`, kept independent so `report/` modules do
 *  not couple to each other. */
export type QueueLookup = (taskId: string) => string | null;

export interface MorningTaskLine {
  task_id: string;
  /** How many `auto-rework` decisions this task received overnight. */
  auto_reworks: number;
  /** True if the task's LAST overnight decision (by ts) was a `park`. */
  parked: boolean;
  /** The last decision's reason (most recent = most relevant). */
  last_reason: string;
  /** The last decision's escalation type. */
  escalation_type: string;
  /** Current live queue state, or null when the task cannot be located. Principle 11:
   *  this is the truth about where the task IS now, independent of what was decided. */
  current_state: string | null;
  /** The task still needs the operator: it is live-`escalated`. */
  needs_you: boolean;
}

export interface MorningReport {
  kind: "morning";
  window: { since: string | null; generated_at: string };
  completeness: { entries: number; skipped: number; tasks: number };
  rollups: {
    tasks_touched: number;
    auto_reworks: number;
    parks: number;
    still_needs_you: number;
  };
  tasks: MorningTaskLine[];
  /** Filled by the wiring layer's narration step; null when narration was unavailable. */
  narration: string | null;
}

/**
 * Build the report from journal entries + a live-state lookup. Pure and deterministic.
 * `opts.since` (ISO) drops older entries; `opts.skipped` carries the parser's
 * unparseable-line count into `completeness` (honesty — a shorter report announces why).
 */
export function buildMorningReport(
  entries: DecisionJournalEntry[],
  liveState: QueueLookup,
  now: () => number,
  opts?: { since?: string | null; skipped?: number },
): MorningReport {
  const since = opts?.since ?? null;
  const skipped = opts?.skipped ?? 0;

  // Window filter first (string ISO compares lexicographically for Zulu timestamps).
  const windowed = since === null ? entries : entries.filter((e) => e.ts >= since);

  // Group by taskId, keeping each group's entries ordered by ts so "last" is well-defined.
  const byTask = new Map<string, DecisionJournalEntry[]>();
  for (const e of windowed) {
    const g = byTask.get(e.taskId);
    if (g) g.push(e);
    else byTask.set(e.taskId, [e]);
  }

  const tasks: MorningTaskLine[] = [];
  for (const [taskId, group] of byTask) {
    const ordered = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const last = ordered[ordered.length - 1]!;
    const autoReworks = ordered.filter((e) => e.decision === "auto-rework").length;
    const current = liveState(taskId);
    tasks.push({
      task_id: taskId,
      auto_reworks: autoReworks,
      parked: last.decision === "park",
      last_reason: last.reason,
      escalation_type: last.escalationType,
      current_state: current,
      needs_you: current === "escalated",
    });
  }
  // Stable order: by task id, so the report and its tests are deterministic.
  tasks.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));

  return {
    kind: "morning",
    window: { since, generated_at: new Date(now()).toISOString() },
    completeness: { entries: windowed.length, skipped, tasks: tasks.length },
    rollups: {
      tasks_touched: tasks.length,
      auto_reworks: tasks.reduce((n, t) => n + t.auto_reworks, 0),
      parks: tasks.filter((t) => t.parked).length,
      still_needs_you: tasks.filter((t) => t.needs_you).length,
    },
    tasks,
    narration: null,
  };
}

/** Render the report as operator-facing text: the narration on top (or a fallback),
 *  then rollups, the per-task table, and a "Needs you" section. */
export function renderMorningReport(report: MorningReport): string {
  const lines: string[] = [];
  lines.push("# Morning Report");
  lines.push("");
  lines.push(report.narration ?? "(narration unavailable — showing the structured summary)");
  lines.push("");
  if (report.tasks.length === 0) {
    lines.push("_No overnight decisions recorded._");
    if (report.completeness.skipped > 0) {
      lines.push("");
      lines.push(`(${report.completeness.skipped} unparseable journal line(s) skipped.)`);
    }
    return lines.join("\n");
  }
  lines.push(
    `Tasks touched: ${report.rollups.tasks_touched} · auto-reworks: ${report.rollups.auto_reworks} · ` +
      `parked: ${report.rollups.parks} · still needs you: ${report.rollups.still_needs_you}`,
  );
  if (report.completeness.skipped > 0) {
    lines.push(`(${report.completeness.skipped} unparseable journal line(s) skipped.)`);
  }
  lines.push("");
  for (const t of report.tasks) {
    lines.push(
      `- ${t.task_id}: ${t.auto_reworks} auto-rework(s)${t.parked ? ", then parked" : ""} ` +
        `— now ${t.current_state ?? "unknown"} — ${t.last_reason}`,
    );
  }
  const needy = report.tasks.filter((t) => t.needs_you);
  if (needy.length > 0) {
    lines.push("");
    lines.push("## Needs you");
    for (const t of needy) {
      lines.push(`- ${t.task_id} (${t.escalation_type}): ${t.last_reason}`);
    }
  }
  return lines.join("\n");
}

/** Build the narration prompt: render the structured report compactly and ask the
 *  narrator model for ONE warm, first-person paragraph. Mirrors the preamble style of
 *  `src/orchestrator/narrator/narration-prompt.ts`. */
export function buildMorningReportPrompt(report: MorningReport): string {
  const taskLines = report.tasks
    .map(
      (t) =>
        `- ${t.task_id}: ${t.auto_reworks} auto-rework(s)${t.parked ? ", parked" : ""}, now ` +
        `${t.current_state ?? "unknown"} — ${t.last_reason}`,
    )
    .join("\n");
  return (
    "You are the orchestrator greeting the operator in the morning. Reply with ONE short " +
    "paragraph of plain prose — no JSON, no lists, no code fences — summarizing what the " +
    "unattended autonomy did overnight and what still needs the operator. Be warm and " +
    "first-person.\n\n" +
    `Rollups: ${report.rollups.tasks_touched} task(s) touched, ${report.rollups.auto_reworks} ` +
    `auto-rework(s), ${report.rollups.parks} parked, ${report.rollups.still_needs_you} still need you.\n\n` +
    `Tasks:\n${taskLines || "(none)"}\n\n` +
    "Narrate this to the operator now."
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/report/morning-report.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:
```bash
git add src/report/morning-report.ts src/report/morning-report.test.ts
git commit -m "feat(report): pure Morning Report builder/renderer/prompt"
```

---

## Task 3: Wire into the composition root, CLI, and endpoint

**Files:**
- Modify: `src/composition/root.ts` (a `morningReport` method; reuse the queue-scan map + `runModel`)
- Modify: `src/index.ts` (CLI subcommand + `CliCommand` union)
- Modify: `src/api/server.ts` (`GET /projects/:id/morning-report`)
- Test: `src/composition/root.test.ts` (or the nearest existing wiring test file)

### 3a — Composition root method

- [ ] **Step 1: Read the anchors**

In `src/composition/root.ts`, read: the queue-scan map at ~lines 1248-1256 (`REPORT_QUEUE_STATES` + the `map` build used for `taskState`), the `runModel` runner at ~line 815, `decisionJournalPath` at ~line 1141, and the `readExecutionReport`/`qualificationReport` methods (~1284, and the ProjectRoot interface entries ~395-412) — the morning method is added the same way.

- [ ] **Step 2: Add imports + the `morningReport` method**

Add imports near the other `report/` imports (top of root.ts):
```ts
import { parseDecisionJournal } from "../autonomy/decision-journal.js";
import { buildMorningReport, renderMorningReport, buildMorningReportPrompt, type MorningReport } from "../report/morning-report.js";
import { readFile as fsReadFileRoot } from "node:fs/promises";
```
> VERIFY: `node:fs/promises` `readFile`/`appendFile` may already be imported in root.ts (root.ts:1165 uses `appendFile`). If `readFile` is already imported under a name, reuse it and drop the alias import.

Add the method body near `readExecutionReport` (~line 1284). It reads the journal, builds the live-state map (reuse the exact scan loop already present), builds the report, then narrates fail-closed:
```ts
  const morningReport = async (opts?: { since?: string }): Promise<{ report: MorningReport; markdown: string }> => {
    // 1. Read the journal (absent -> "" -> empty report, never an error).
    let journalText = "";
    try {
      journalText = await fsReadFileRoot(decisionJournalPath, "utf8");
    } catch {
      journalText = ""; // ENOENT (no overnight ran yet) is not an error
    }
    const { entries, skipped } = parseDecisionJournal(journalText);

    // 2. Live-state lookup: scan the queues ONCE into a map, then a sync lookup
    //    (same construction as the execution report's liveByTask, REPORT_QUEUE_STATES).
    const liveMap = new Map<string, string>();
    for (const state of REPORT_QUEUE_STATES) {
      for (const t of await repo.listTasks(state)) liveMap.set(t.id, state);
    }

    // 3. Build the pure report.
    const report = buildMorningReport(
      entries,
      (id) => liveMap.get(id) ?? null,
      () => Date.now(),
      { ...(opts?.since !== undefined ? { since: opts.since } : {}), skipped },
    );

    // 4. Narrate, FAIL-CLOSED: a model failure leaves narration null and the digest stands.
    try {
      const r = await runModel(cfg.roles.orchestrator.model, buildMorningReportPrompt(report));
      if (r.exitCode === 0 && r.output.trim() !== "") {
        report.narration = r.output.trim();
      }
    } catch (err) {
      log("WARN", `morningReport: narration failed (ignored): ${String(err)}`);
    }

    return { report, markdown: renderMorningReport(report) };
  };
```
> VERIFY while implementing: (a) `runModel` is in scope at this point (it is defined ~line 815, same function scope) with signature `(model, prompt) => Promise<{exitCode, output}>`; (b) `cfg.roles.orchestrator.model` is the right narrator tier — confirm `cfg.roles.orchestrator` exists (it does; the polygon config has `roles.orchestrator.model`); (c) `REPORT_QUEUE_STATES`, `repo`, `decisionJournalPath`, `log` are all in scope. If `runModel` is NOT in the same scope, thread it or lift the shared runner — do not duplicate the model-spawn logic.

- [ ] **Step 3: Expose `morningReport` on the `ProjectRoot` interface + return object**

In the `ProjectRoot` interface (~line 395, beside `readExecutionReport`), add:
```ts
  morningReport(opts?: { since?: string }): Promise<{ report: import("../report/morning-report.js").MorningReport; markdown: string }>;
```
> Prefer a top-level `import type { MorningReport }` (already added in Step 2) and write `Promise<{ report: MorningReport; markdown: string }>`.

And add `morningReport,` to the returned ProjectRoot object literal (near `readExecutionReport,` ~line 1385).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

### 3b — CLI `report morning`

- [ ] **Step 5: Extend the `CliCommand` union + parser + usage**

In `src/index.ts`:
- Add to the `CliCommand` union (~line 78): `| { mode: "report-morning"; since?: string }`.
- Update `REPORT_USAGE` (~line 106) to: `"usage: report run <runId> | report qualify [--from <sha>] [--to <sha>] | report morning [--since <ISO>]"`.
- In `parseReportArgs` (~line 148), before the final `throw`, add:
```ts
  if (verb === "morning") {
    const argv2 = argv.slice(1);
    let since: string | undefined;
    for (let i = 0; i < argv2.length; i++) {
      const arg = argv2[i];
      if (arg === "--since") {
        const val = argv2[i + 1];
        if (val === undefined || val.startsWith("-")) throw new Error("--since: missing value (expected an ISO timestamp)");
        since = val;
        i++;
      } else if (arg !== undefined && arg.startsWith("--since=")) {
        since = arg.slice("--since=".length);
      } else {
        throw new Error(`report morning: unexpected argument ${JSON.stringify(arg ?? "")} (${REPORT_USAGE})`);
      }
    }
    return { mode: "report-morning", ...(since !== undefined ? { since } : {}) };
  }
```

- [ ] **Step 6: Execute the command**

In `main()`, after the `report-qualify` block (~line 415), add:
```ts
  if (command.mode === "report-morning") {
    const { markdown } = await root.morningReport({ ...(command.since !== undefined ? { since: command.since } : {}) });
    printMarkdown(markdown);
    return;
  }
```
> VERIFY: `root` is the built ProjectRoot in scope here (the `report-run`/`report-qualify` blocks use it the same way), and `printMarkdown` is the helper those blocks use.

- [ ] **Step 7: Typecheck + a CLI parse test**

Add to the nearest CLI-parse test file (grep for a test importing/using `parseCli` or asserting `report-qualify`; if none, add to `src/index.test.ts` if it exists — otherwise assert via a small unit test of `parseReportArgs` export, exporting it if needed). Test:
```ts
// report morning parses --since in both forms and bare
expect(parseReportArgs(["morning"])).toEqual({ mode: "report-morning" });
expect(parseReportArgs(["morning", "--since", "2026-07-23T00:00:00Z"])).toEqual({ mode: "report-morning", since: "2026-07-23T00:00:00Z" });
expect(parseReportArgs(["morning", "--since=2026-07-23T00:00:00Z"])).toEqual({ mode: "report-morning", since: "2026-07-23T00:00:00Z" });
```
> If `parseReportArgs` is not exported, either export it (preferred — the qualify parser style) or drive the assertion through the public `parseCli(["report","morning",...])`. Match whatever the existing report-CLI tests do.

Run: `npm run typecheck && npx vitest run src/index.test.ts` (or the file you added to)
Expected: clean + PASS.

### 3c — Endpoint `GET /projects/:id/morning-report`

- [ ] **Step 8: Read the run-report route as the template**

In `src/api/server.ts`, read the `GET .../runs/:runId/report` handler (~line 2240 + the `runReportMatch` dispatch ~line 2552) and the `POST /qualification-report` dispatch (~line 2554). The morning route is added in the same `sub` dispatch block, calling `root.morningReport`.

- [ ] **Step 9: Add the route**

In the same dispatch block where `runReportMatch` / `qualification-report` are handled (~line 2552), add a branch:
```ts
      if (req.method === "GET" && /^\/morning-report\/?$/.test(sub.split("?")[0] ?? sub)) {
        const since = url.searchParams.get("since");
        const { report } = await root.morningReport({ ...(since !== null ? { since } : {}) });
        return sendJson(res, 200, report);
      }
```
> VERIFY against the surrounding code: how `sub`, `url`/query params, `root`, and `sendJson` (or the local JSON responder) are named in THIS handler. Match the exact helpers the neighboring `runReportMatch` branch uses (it already parses `:id`/resolves `root` from the hub and sends JSON). Do NOT invent a new response helper. If query parsing uses a pre-split `sub` without the query string, read `req.url` for `since` the same way the other routes read their params.

- [ ] **Step 10: Full typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 11: A wiring test for the endpoint + method**

Add a test near the existing report-endpoint tests (grep `qualification-report` in `src/api/server.test.ts` or the api test file). Assert `GET /projects/:id/morning-report` returns 200 with a `kind: "morning"` body over a seeded journal + a fake queue; and that a narrator failure still returns the report with `narration: null`. Model the harness on the existing run-report endpoint test in that file (reuse its project/hub/root fake setup).

Run: `npx vitest run src/api/server.test.ts src/composition/root.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/composition/root.ts src/index.ts src/api/server.ts src/composition/root.test.ts src/api/server.test.ts src/index.test.ts
git commit -m "feat(report): wire the Morning Report into the CLI, endpoint, and composition root"
```

---

## Task 4: Full suite + independent critic + live smoke (main session drives)

- [ ] **Step 1: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: all green (prior ~1631 + the new tests).

- [ ] **Step 2: Independent codex critic gate (pinned model)**

Per `AGENTS.md`, an independent **codex `gpt-5.6-luna`** review before merge. Run codex DIRECTLY (Windows: paste the diff inline; prompt on STDIN):
```bash
cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -
```
Focus the critic on: the reconciliation logic (does the live queue correctly win?), the fail-closed narration (can a throwing model or logger break the report?), the tolerant parser (can a crafted line throw or mis-validate?), and the endpoint's query/param handling. Fix findings; re-critic in-place fixes; declines allowed with rationale verified against real code.

- [ ] **Step 3: Live smoke (deterministic, no LLM run needed)**

Reuse the deterministic-primitive style from the EOL proof: a small node script (or a `report morning` CLI invocation against a seeded `.autodev/decision-journal.ndjson` on the polygon) that confirms the report renders the seeded decisions, reconciles a task moved to `done`, and lists a still-escalated task under "Needs you". A full LLM run is NOT required — the narration is a fail-closed convenience layer; the structured report is the deterministic core. If the operator wants the narrated prose observed, run `report morning` on the polygon (it invokes the orchestrator model once).

---

## Self-Review (against the spec)

- **Spec coverage:** on-demand CLI + endpoint (Task 3b/3c) ✓; pure function over the journal (Task 2) ✓; tolerant parser, skipped counted, absent→empty (Task 1) ✓; Principle-11 reconciliation, queue wins (Task 2 test + `buildMorningReport`) ✓; group-by-task, last-decision-by-ts, auto-rework count (Task 2) ✓; needs-you = live-escalated (Task 2) ✓; narration reuse + fail-closed (Task 3a step 2 narration block; Task 2 prompt) ✓; `--since` filter (Task 1 parser N/A — filtering is in `buildMorningReport`, Task 2) ✓; completeness/skipped surfaced (Task 2 + renderer) ✓; render fallback when narration null (Task 2 renderer + test) ✓.
- **Placeholder scan:** the wiring steps delegate exact local helper names (`sendJson`, `printMarkdown`, `parseReportArgs` export, the api test harness) to "match the neighboring route/test" — these are real "match the local convention" instructions with named anchors, not vague placeholders. All pure-module code is complete.
- **Type consistency:** `MorningReport`/`MorningTaskLine`/`QueueLookup` names and `buildMorningReport(entries, liveState, now, opts)` / `renderMorningReport(report)` / `buildMorningReportPrompt(report)` signatures are identical across Task 2 and Task 3. `morningReport({since}) -> {report, markdown}` matches between root method, interface, CLI, and endpoint. `parseDecisionJournal(text) -> {entries, skipped}` matches Task 1 and Task 3a.
- **Endpoint correction:** plan uses the real project-scoped `GET /projects/:id/morning-report`, noted above the file structure.

## Related

- Spec: `docs/superpowers/specs/2026-07-23-morning-report-design.md`
- `src/report/execution-report.ts` — the reconciliation pattern reused
- `PRINCIPLES.md` #10 (fail safe), #11 (SSOT), #13 (evidence)
