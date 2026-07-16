# Unattended overnight escalation handling — design (v1 slice of ADR-004's unattended half)

**Status:** design approved (operator, s45 2026-07-17) — ready for writing-plans.
**Implements:** the FIRST slice of `adr/004`'s unattended half.
**Scope discipline:** ADR-004's unattended half is ~7 subsystems (overnight toggle, three
decision classes, decision journal, park-don't-stall routing, morning report, per-project
north-star, mandatory anti-drift). This spec designs ONE slice — **overnight escalation
handling** — chosen because the escalation is the only fork in today's architecture where
work stalls waiting for the operator. Every other piece hangs off it and gets its own
brainstorm → spec → plan cycle later.

## Context

Today a task that escalates (the gate returned `broken`/`uncertain`, a contract-zone risk, a
worker failure, or the circuit breaker tripped) is moved to `queue/escalated/` and waits for the
operator to reply A (accept→quarantine), B (rework→re-run with the critic's objection), or C
(commit-on-accept override). Overnight, that means real progress halts on the first open question —
the exact pain ADR-004's slogan targets ("stop babysitting"). The `conductor.run({drain})` loop
ALREADY continues to the next claimable pending task after one escalates (an escalated task leaves
`active/`, is no longer claimable, and does not block INDEPENDENT tasks) — so the queue does not
fully stall today; what stalls is the escalated task itself, and no autonomous decision is ever
made on it.

## Goal

When a run is in **overnight mode**, an autonomous supervisor resolves escalations the way the
operator would with reply-B — *without ever going through the gate*: it re-runs the worker (with the
critic's persisted objection) for escalations a retry can plausibly fix, bounded by a small budget,
and parks the rest for a morning decision. Every autonomous action is journaled. When overnight
mode is OFF (attended, the default), behavior is exactly as today — escalations park and wait.

## Non-goals (explicitly out of this slice)

- **No LLM decision-making.** v1 is fully deterministic (reason-routing + a counter). LLM-driven
  re-planning, scope changes, and goal-pursuit are later slices.
- **No accept/commit autonomy.** The supervisor can only rework or park. Choosing A (accept) or C
  (commit-override) autonomously would commit gate-rejected work — forbidden by ADR-004 tenet 6
  ("autonomy lives above the gate, never through it").
- **No morning report, no top-bar presence toggle, no north-star doc, no anti-drift** — later
  slices. v1 signals overnight mode with a config flag and records decisions to a journal file the
  future morning report will read.
- **No new escalation semantics.** Escalation types, the gate, the critic, and commit-after-gate are
  untouched. The supervisor only drives the SAME operator-facing controls (reply-B = move + reset +
  trigger).

## Architecture

A new module **`src/autonomy/overnight-supervisor.ts`**, wired at the composition root, that runs a
**bounded control loop around the existing `conductor.run({drain})`** plus an escalation sweep. It
sits ABOVE the gate: it calls only `trigger` (the `conductor.run` closure), `repo`, a journal
writer, and reads config — never the conductor's internals, the critic, or the commit path. It is
the approved "separate above-gate reactor" (Variant A), realized as a post-drain sweep rather than an
event watcher (simpler, deterministic, no new conductor hooks).

### Control flow (loop-until-dry)

The supervisor operates on the PROJECT's `escalated/` queue (not a single run) — it wraps the
project's drain, mirroring how `conductor.run({drain})` processes the whole project queue.

```
supervise(project):
  if not cfg.autonomy.overnight.enabled: return   # attended default -> today's behavior
  parked = {}                                      # taskIds already journaled as parked (idempotency)
  loop:
    await trigger({ drain: true })                # process all claimable work; some tasks escalate
    escalated = await repo.listTasks("escalated")
    actionable = escalated.filter(t =>
        isRetryable(t.escalationType)             # reason-routing table below
        && reworkCount(t.id) < cfg.autonomy.overnight.maxAutoReworks)
    if actionable is empty: break                 # nothing left to auto-decide -> quiescent
    for t in actionable:
      journal("auto-rework", t)                   # append BEFORE acting
      incrementReworkCount(t.id)
      await repo.setAttempts(t.id, 0)             # s44 reply-B semantics: fresh attempt budget
      await repo.moveTask(t.id, "escalated", "pending")   # re-queue for the next drain
    # loop re-drains, which re-runs the reworked tasks (worker reads critic-feedback.md, s42)
  # loop exit: EVERY remaining escalated task is now parked (park-type OR budget exhausted).
  for t in (await repo.listTasks("escalated")):
    if t.id not in parked: journal("park", t); parked.add(t.id)   # once per task, for the morning report
```

Termination is guaranteed: each iteration either does at least one auto-rework (consuming per-task
budget, which is finite) or breaks. A task is auto-reworked at most `maxAutoReworks` times, so the
loop cannot spin forever. One auto-rework = one re-queue = one re-run (NOT a full `maxAttempts`
cycle — the conductor's `maxAttempts` bounds in-run retries independently). Park journaling is
idempotent per task (guarded by the in-memory `parked` set) so a task cannot be double-logged.

### Reason-routing table (deterministic, keyed on `EscalationType`)

The `EscalationType` union (`src/escalate/escalate.ts`) is the discriminator. Litmus: "can a re-run
with the critic's feedback plausibly fix this?" — yes → auto-rework; no → park.

| `EscalationType` | Route | Rationale |
|---|---|---|
| `disagreement` (critic `broken`) | **auto-rework** | The main case — worker reads `critic-feedback.md`, fixes the flagged code. |
| `uncertain` (critic not confidently clean) | **auto-rework** | Feedback exists; another try is warranted. |
| `poison` (circuit breaker tripped) | **auto-rework** | Exactly the s44 case: reply-B resets the budget → a fresh attempt. Hits the shared budget quickly. |
| `constitution` (contract-zone/constitution) | **park** | A contract decision — expensive to undo, needs the operator. Class-3. |
| `needs-guard` | **park** | Needs a human decision about a guard/contract (rare post ADR-005). |
| `blocked` (worker-blocked / merge-conflict / branch-moved / agent-ci-unavailable / task-too-big) | **park** | Heterogeneous, but nearly every sub-case needs the operator or a re-plan; a retry won't help. Conservatively park all. |
| `dirty-file` (files outside declared scope) | **park** | A contract-scope violation (sibling of `constitution`): likely a too-narrow `file_set` (needs re-plan) or a misbehaving worker — a plain re-run with the same `file_set` would reproduce it. |
| `drift` (anti-drift DRIFT) | **park** | Needs operator review; anti-drift is a later slice and may not fire in v1 anyway. |

Retryable set: `disagreement`, `uncertain`, `poison`. Park set: `constitution`, `needs-guard`,
`blocked`, `dirty-file`, `drift`. The table is a pure function of the escalation type — trivially
unit-testable and easy for the operator to re-tune later.

### Budget & park

- **Budget:** `cfg.autonomy.overnight.maxAutoReworks` (default **2**), tracked per task in a runtime
  file `runtime/<taskId>/auto-rework-count` (alongside the existing per-task `attempts`,
  `critic-feedback.md`, `critic-verdict.json`). At the limit, a retryable escalation is parked.
- **Park** = the task simply stays in `queue/escalated/` — exactly today's state, awaiting the
  operator's A/B/C in the morning — plus a journal `park` entry. No new queue state. Independent
  pending tasks keep draining (already true). When no claimable work and no actionable escalation
  remain, the run is quiescent; the future morning report reads the journal.
- **Budget vs the conductor:** two independent layers — the conductor's `maxAttempts` bounds in-run
  re-claims; the supervisor's `maxAutoReworks` bounds supervisor-driven re-queues. An operator's
  MANUAL reply-B does not reset the supervisor count in v1 (a simplification — manual intervention is
  attended mode; noted as a known edge).

### Decision journal

Append-only NDJSON at **`.autodev/decision-journal.ndjson`** (one per project, mirroring the
`agent-ci-events.ndjson` idiom). One line per autonomous action, appended BEFORE the action so a
crash mid-action still leaves an audit trail:

```json
{"ts":"<iso>","runId":"<id>","taskId":"<id>","escalationType":"disagreement","decision":"auto-rework","reworkCount":1,"reason":"critic broken -- re-running with feedback","reversible":true}
{"ts":"<iso>","runId":"<id>","taskId":"<id>","escalationType":"blocked","decision":"park","reworkCount":0,"reason":"needs operator -- parked for morning review","reversible":true}
```

`reversible` is always `true` in v1 (rework and park are both cheap to undo — the whole safety
argument). The field is present now so the morning report and future class-2 "decide-and-flag"
entries share one schema. `runId` is best-effort — recorded when the escalated task file carries its
originating run, omitted otherwise; `taskId` is always present and is the stable key the morning
report groups on.

### Config (schema addition, inert by default)

Add a top-level `autonomy` block to `HarnessConfigSchema` (`src/config/schema.ts`), defaulted so
existing configs are unaffected and the feature is OFF until explicitly enabled (same pattern as
`gate.agentCi`):

```ts
autonomy: z.object({
  overnight: z.object({
    enabled: z.boolean().default(false),
    maxAutoReworks: z.number().int().nonnegative().default(2),
  }).default({ enabled: false, maxAutoReworks: 2 }),
}).default({ overnight: { enabled: false, maxAutoReworks: 2 } }),
```

The daemon-global top-bar **presence** toggle (ADR-004 tenet 5) is a later slice; when built it will
drive this flag (possibly promoting it to a daemon-global signal). v1 uses the per-project config so
the backend is fully buildable + testable + live-provable now.

## Boundary guarantees (ADR-004 tenet 6 — non-negotiable)

- The supervisor calls ONLY `trigger` (`conductor.run`), `repo.{listTasks,setAttempts,moveTask}`, a
  journal appender, and config reads. It never imports or calls the critic, the gate, or the commit
  path.
- Its only mutation of a task is the reply-B triple (move `escalated→pending` + `setAttempts(0)` +
  re-trigger drain) — identical to the operator's reply-B, which is already gate-safe (the reworked
  task runs through the FULL critic gate again).
- It cannot accept, commit, or bypass the critic. "Stop babysitting" stays honest only because
  "never merge bullshit" stays mechanical.

## Testing

Fully deterministic → unit-testable end to end; no live LLM needed for the core.

- **Unit:** the routing table (each `EscalationType` → rework/park); budget counting (a task
  auto-reworked to `maxAutoReworks` then parked); journal lines written with the right fields and
  BEFORE the action; total inertness when `overnight.enabled=false` (escalations stay put, no
  journal, no reply-B).
- **Integration (real `FileBlackboardRepository` + scheduler, the s44 harness pattern):** seed an
  escalated `disagreement` task in overnight mode → supervisor auto-reply-Bs (attempts reset to 0 +
  moved to pending) → re-drain re-runs it → still `broken` → auto-rework again → at
  `maxAutoReworks` → parked (stays escalated) + two `auto-rework` journal lines + one `park` line.
  Seed a `blocked` task → parked immediately, one `park` line, zero reworks. Prove independent
  pending tasks keep draining alongside a parked task.
- **Live-prove (build-time, operator-observable):** enable overnight on the test repo, launch a task
  that escalates, watch the supervisor auto-rework it through the real daemon and either converge
  (DONE commit) or park with a journal trail — per the project's live-prove discipline. Deferred to
  the build, not this spec.

## Known edges / risks (v1)

- **`blocked` is overloaded** — it bundles transient (branch-moved) and terminal (task-too-big)
  causes; v1 parks all. If a transient `blocked` proves common, a later refinement can split it. A
  structured `blocked` sub-reason is a candidate follow-up.
- **Operator manual reply-B does not reset the supervisor count** — noted above; attended
  intervention is a different mode. Revisit if it bites.
- **Narrator interaction:** a parked overnight run currently shows the s43 `blocked` narrator state
  ("waiting on your reply"). The overnight-specific "N parked, morning report pending" narration is a
  later slice; the interim `blocked` state is acceptable for v1 (backend + journal focus).
- **Escalation detection is a post-drain sweep**, not real-time — fine for a batch overnight loop; a
  real-time reactor is unnecessary complexity here.

## Related

- `adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — the doctrine (tenets 1-6).
- `adr/003-roles-are-a-configurable-vendor-matrix.md` — R1 boundary (autonomy above the gate).
- `gotchas/reply-b-poisons-maxrounds-exhausted-task.md` — the s44 reply-B attempt-budget reset the
  supervisor reuses.
- `gotchas/reply-b-rework-drops-critic-feedback.md` — the s42 `critic-feedback.md` path the
  reworked worker reads.
- `gotchas/escalated-run-not-terminal.md` — the s43 `blocked` narrator state (interim, later slice).
- `src/escalate/escalate.ts` — the `EscalationType` union (routing discriminator).
- `src/api/server.ts` (`handleReply` choice B) — the reply-B triple the supervisor mirrors.
