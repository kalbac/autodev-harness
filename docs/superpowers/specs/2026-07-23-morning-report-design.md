# Morning Report — Design

> Spec authored 2026-07-23 (s53). The third report type, closing an `adr/004`
> unattended-autonomy slice (`docs/CURRENT-STATE.md`: "Morning report — batch-narrate
> `.autodev/decision-journal.ndjson`, reuses the s40 narrator"). Anchors: `adr/004`
> (live-orchestrator presence), `PRINCIPLES.md` #11 (SSOT), #13 (evidence).

## Purpose

When the operator was away, the overnight supervisor (`adr/004` slices 1-2) made
autonomous decisions at escalation forks — **auto-rework** or **park** — and journaled
each to `.autodev/decision-journal.ndjson`. The **Morning Report** turns that journal
into an operator-facing summary: *"here is what I did while you were gone, and where
those tasks stand now."* It is the orchestrator's morning greeting — the presence-half
of `adr/004` applied to the autonomy-half's output.

It is the **third report type**, alongside the s52 pair, and deliberately shares their
architecture: a pure function over a ledger, surfaced on-demand via CLI + a loopback
endpoint, reconciled against the live blackboard (Principle 11), honest about gaps.

- **Harness Execution Report** — per-run, "how did the machine perform".
- **Product Qualification Report** — per-commit-range, "is the product good".
- **Morning Report** (new) — per-decision-journal, "what did the autonomy decide while
  unattended, and where did those tasks land".

## Surface

Mirrors `report run` / `report qualify` exactly:

- **CLI:** `report morning [--since <ISO>]` — prints the rendered report (structured
  digest + narrated prose) to stdout.
- **HTTP:** `GET /morning-report[?since=<ISO>]` — loopback-only, like the other report
  endpoints. Returns the `MorningReport` JSON.

`--since` / `?since=` is an ISO timestamp; entries strictly before it are excluded.
Omitted → the whole journal. No "since last report" state tracking in v1 (YAGNI); the
operator narrows the window explicitly when they want to.

## Data flow

### 1. Parse the journal (fail-soft, honest — H1)

A new tolerant parser lives beside `serializeDecision` in
`src/autonomy/decision-journal.ts`:

```ts
export function parseDecisionJournal(text: string): { entries: DecisionJournalEntry[]; skipped: number };
```

- Splits on newlines, `JSON.parse`s each non-empty line, validates the shape
  (`ts`, `taskId`, `escalationType`, `decision`, `reworkCount`, `reason` present and
  well-typed).
- A line that fails to parse or validate is **skipped and counted**, never thrown on —
  one corrupt line must not sink the whole report. `skipped` is surfaced in the report's
  completeness block ("N unparseable line(s) skipped"), so a silently-shorter report is
  impossible.
- An **absent** journal file is not an error: the caller passes `""`, which yields
  `{ entries: [], skipped: 0 }`, and the report renders an explicit "no overnight
  decisions recorded" — never a blank.

### 2. Build the report (pure function + Principle-11 reconciliation)

`src/report/morning-report.ts`:

```ts
export type QueueLookup = (taskId: string) => string | null; // reused shape from execution-report.ts

export interface MorningTaskLine {
  task_id: string;
  /** How many auto-rework decisions this task received overnight. */
  auto_reworks: number;
  /** True if the task's LAST overnight decision was a park. */
  parked: boolean;
  /** The last decision's reason (the most recent, most relevant one). */
  last_reason: string;
  /** The last decision's escalation type. */
  escalation_type: string;
  /** Current live queue state (`done`/`escalated`/`pending`/`active`/`quarantine`),
   *  or null when the task cannot be located. Principle 11: this is the TRUTH; the
   *  journal only records what was DECIDED, not where the task ended up. */
  current_state: string | null;
  /** True when the task still needs the operator: it is live-`escalated` (parked and
   *  not yet resolved). Drives the report's "needs you" section. */
  needs_you: boolean;
}

export interface MorningReport {
  kind: "morning";
  window: { since: string | null; generated_at: string };
  completeness: { entries: number; skipped: number; tasks: number };
  rollups: {
    tasks_touched: number;
    auto_reworks: number;   // total auto-rework decisions across all tasks
    parks: number;          // tasks whose last decision was a park
    still_needs_you: number;// tasks currently live-escalated
  };
  tasks: MorningTaskLine[];
  /** Filled by the narration step (below); null when narration was unavailable. */
  narration: string | null;
}

export function buildMorningReport(
  entries: DecisionJournalEntry[],
  liveState: QueueLookup,
  now: () => number,
  opts?: { since?: string | null },
): MorningReport;
```

- **Group by `taskId`.** A task can appear multiple times (auto-reworked twice, then
  parked). Per task: count `auto-rework` decisions; `parked` = the LAST entry's decision
  is `park`; carry the LAST entry's `reason`/`escalationType` (most recent = most
  relevant). Entries are ordered by `ts` before grouping so "last" is well-defined even
  if the file is out of order.
- **Reconcile (Principle 11).** `current_state = liveState(taskId)`. The report shows
  the live state as the current truth. `needs_you = current_state === "escalated"` — a
  parked task the operator has not yet answered. A task the journal parked that is now
  `done` (a later attended reply-B reworked it to green) correctly reads as `done`, not
  parked — the live blackboard wins.
- `buildMorningReport` sets `narration: null`; the narration is attached by the wiring
  layer (step 3), so the pure function stays deterministic and trivially testable.
- `since` filtering happens here (drop entries with `ts < since`), before grouping.

### 3. Narrate (reuse the s40 narrator, fail-closed — H-invariant)

A new prompt builder beside the existing ones, `src/report/morning-report.ts`:

```ts
export function buildMorningReportPrompt(report: MorningReport): string;
```

It renders the structured `report` (rollups + per-task lines) into a compact block and
asks the narrator model (the same model/preamble family as
`src/orchestrator/narrator/narration-prompt.ts`) for ONE warm, first-person paragraph:
*"Overnight I processed 5 tasks — 3 auto-reworked to green, 2 I parked for you: X
(needs a guard) and Y (a contract disagreement)…"*.

The wiring layer runs the model with this prompt and sets `report.narration`. **Fail-closed
(Principle 10):** if the model call fails or returns empty, `narration` stays `null` and
the renderer prints "(narration unavailable — showing the structured summary)". The
structured digest is ALWAYS present and is the source of truth; the narration is a
convenience layer over it, never a replacement.

### 4. Render

`renderMorningReport(report: MorningReport): string` — a deterministic text renderer
(the narration paragraph on top when present, then the rollups, then the per-task table,
then a "Needs you" section listing the `needs_you` tasks). Used by the CLI; the endpoint
returns the JSON object.

## Modules (isolation)

- **`src/autonomy/decision-journal.ts`** (extend) — add `parseDecisionJournal` beside
  `serializeDecision`. One file owns the journal's on-disk format, both directions.
- **`src/report/morning-report.ts`** (new) — `buildMorningReport` (pure),
  `renderMorningReport`, `buildMorningReportPrompt`. No I/O, no model calls: it takes
  parsed entries + a `QueueLookup` + a clock and returns/renders data.
- **`src/report/report-service.ts`** (extend) — a `buildMorningReportFor(deps)` that
  reads the journal file, builds the `QueueLookup` from the blackboard, calls
  `buildMorningReport`, then runs the narrator (fail-closed) and attaches `narration`.
  Reuses the same `QueueLookup` construction the execution report already uses (scan the
  queues once, map taskId → state).
- **`src/index.ts`** (extend) — the `report` verb gains a `morning` subcommand; a
  `GET /morning-report` route on the loopback server, beside the existing report routes.

## Error handling (Principle 10 — fail toward the honest state)

- Malformed journal line → skipped + counted (never thrown).
- Absent journal → empty report with an explicit "no decisions recorded".
- Narrator model failure → `narration: null`, structured digest still emitted.
- A task the `QueueLookup` cannot locate → `current_state: null`, rendered as "unknown"
  — reported, never dropped.

## Testing

Pure-function unit tests (`src/report/morning-report.test.ts`):
1. Empty entries → "no decisions recorded", zero rollups.
2. Mixed decisions (a task auto-reworked twice then done; a task parked and still
   escalated; a task parked but now done) → correct `auto_reworks`, `parked`,
   `current_state`, `needs_you`, and rollups. Asserts Principle-11 reconciliation (the
   parked-but-now-done task reads `done`, `needs_you: false`).
3. `--since` filter excludes older entries.
4. Out-of-order entries → "last decision" is the latest by `ts`.
5. A task the `QueueLookup` returns `null` for → `current_state: null`.

Parser tests (`src/autonomy/decision-journal.test.ts`, extend): a valid multi-line
journal parses all entries; a corrupt line is skipped and counted; a blank/absent input
→ empty, zero skipped.

Prompt test (`morning-report.test.ts`): `buildMorningReportPrompt` includes the task
lines and asks for one paragraph (pins the prompt contract).

Wiring test: `report morning` CLI and `GET /morning-report` return the report; the
narrator failing leaves `narration: null` and still returns the digest (fail-closed).

## Non-goals (YAGNI)

- No scheduled auto-generation (the endpoint covers "the UI fetches it on the first
  attended load"; a timer is a separate concern and not needed to close this slice).
- No "since last report" persistence — `--since` is explicit.
- No new decision-journal fields — the v1 schema (`DecisionJournalEntry`) is sufficient;
  the report is a pure reader.
- Not merged with the Execution/Qualification renderers — a distinct report with its own
  vocabulary (the H5 separation the two reports already keep).

## Related

- `docs/superpowers/specs/2026-07-22-two-reports-design.md` — the report architecture
  this extends.
- `src/report/execution-report.ts` — the `QueueLookup` + Principle-11 reconciliation
  pattern reused here.
- `src/autonomy/decision-journal.ts` / `src/autonomy/overnight-supervisor.ts` — the
  journal this reads.
- `adr/004` — live-orchestrator presence + post-review autonomy.
- `PRINCIPLES.md` #10 (fail safe), #11 (SSOT), #13 (evidence).
