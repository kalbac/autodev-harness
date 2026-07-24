# Mandatory Anti-Drift + North-Star — Design

> Spec authored 2026-07-23 (s53). The last `adr/004` unattended-autonomy slice
> (`docs/CURRENT-STATE.md`: "Per-project north-star concept doc" + "Mandatory anti-drift
> critic"). Anchors: `adr/004` tenets 4-5, `PRINCIPLES.md` #8 (autonomy lives above the
> gate), #10 (fail toward the safe state), #12 (anti-drift).
>
> **Implementation is deferred to the next session** — this spec is the handoff artifact.

## The problem

`adr/004` tenet 4: every project gets a **north-star** concept anchor ("what it is, why,
what it must do, what it must never do"), and the run-level anti-drift check
(intent-vs-cumulative-diff) "becomes **mandatory** once unattended operation ships — it
is what catches 'confidently building the wrong thing' over a long night."

What exists today:
- `.autodev/GOAL.md` is **already scaffolded** (`GOAL_STUB` in `src/registry/scaffold.ts`),
  but it is a generic "(describe the project goal here)" placeholder.
- The anti-drift critic (`src/anti-drift/anti-drift.ts`) is **already built and wired**:
  the conductor runs it every `cfg.antiDrift.everyCommits` committed tasks
  (`conductor.ts:985-995`); a `DRIFT:` verdict escalates the current task and the drain
  continues.
- But `cfg.antiDrift.intentSource` **defaults to `null`** → `getIntent` returns
  "(no intent source configured)" → the critic degrades to UNCERTAIN and never fires
  DRIFT. **It is toothless.**
- Attended and unattended behave identically: a DRIFT parks one task and keeps draining.

Three gaps: (1) the scaffolded north-star does not feed anti-drift; (2) an unattended
run against a project with **no written intent** runs blind — no drift protection; (3) a
DRIFT overnight parks one task and keeps building, so cumulative drift wastes the night.

## Decisions (operator, s53)

- **A DRIFT in unattended mode HALTS the overnight drain** (not just parks one task).
  Rationale: cumulative drift means the whole direction is off; continuing burns the
  night on more wrong code. Park + stop draining + surface in the morning report. This is
  exactly "catch confidently building the wrong thing over a night". **Attended mode is
  unchanged** — a DRIFT escalates the task and the run continues (the operator is present).
- **An empty/stub north-star FAILS CLOSED in unattended mode** — the overnight run
  refuses to start (parks with a clear "no north-star; cannot run unattended" signal).
  Rationale: `adr/004` tenet 4 ("if the north star is silent → escalate to class 3") +
  Principle 10. You must not autonomously build a project whose intent is not written
  down. **Attended is unchanged** — the operator can run a project whose GOAL is still a
  stub; they are there to steer.

Both enforcements live **above** the gate (`adr/003` R1, Principle 8): they park / stop /
refuse; they never skip the critic or force a commit.

## Architecture

### 1. North-star = `.autodev/GOAL.md`, structured and wired

- **Restructure `GOAL_STUB`** (`src/registry/scaffold.ts`) to the `adr/004` four-part
  shape, each a fill-in section: **What it is · Why · What it must do · What it must never
  do**. It keeps a recognizable "unfilled" sentinel so silence is detectable (see §2).
- **Default `cfg.antiDrift.intentSource` to `.autodev/GOAL.md`** (`src/config/schema.ts`,
  change the default from `null`). The scaffold always creates `GOAL.md`; a project
  missing it degrades to UNCERTAIN (`getIntent` returns "(intent source not found)"),
  never a crash. Anti-drift now works out of the box. `headers` default stays `[]` (feed
  the whole GOAL.md, which is short by design).

### 2. "North-star is silent" — a pure predicate

New pure module `src/anti-drift/north-star.ts`:

```ts
/** The sentinel line the scaffolded GOAL_STUB carries in every unfilled section. Shared
 *  with scaffold.ts so the two never drift. */
export const NORTH_STAR_UNFILLED_SENTINEL = "<!-- north-star: unfilled -->";

/**
 * Is the north-star effectively SILENT — nothing an anti-drift critic could check work
 * against? True when the extracted intent is absent, empty/whitespace, or still carries
 * the scaffold's unfilled sentinel (i.e. the operator never replaced the stub). Used
 * ONLY to gate unattended autonomy (§3); attended runs never consult it.
 */
export function isNorthStarSilent(intentText: string | null): boolean;
```

- Absent (`null`), empty/whitespace, or containing `NORTH_STAR_UNFILLED_SENTINEL` → silent.
- The scaffolded `GOAL_STUB` embeds `NORTH_STAR_UNFILLED_SENTINEL` in each section, so a
  freshly-scaffolded, never-edited GOAL.md reads as silent. Once the operator writes real
  content (removing the sentinels), it reads as present.

### 3. Anti-drift POLICY in the conductor (parameterize the response, don't fork the check)

The conductor already OWNS the anti-drift check. Rather than duplicate it, add an
anti-drift **policy** to the conductor's run options (defaulting to today's behavior):

```ts
interface AntiDriftPolicy {
  /** What a DRIFT verdict does. "escalate-task" (attended, default) escalates the
   *  current task and continues; "halt-drain" (unattended) escalates AND stops the
   *  drain. */
  onDrift: "escalate-task" | "halt-drain";
  /** When true (unattended), the run refuses to process tasks if the north-star is
   *  silent (§2) -- a fail-closed preflight. Default false (attended). */
  requireNorthStar: boolean;
}
```

Wired into `ConductorRunOptions` (optional; omitted = `{ onDrift: "escalate-task",
requireNorthStar: false }` = today's behavior, so every existing test/caller is untouched).

- **Preflight (requireNorthStar):** before the drain processes its first task, the
  conductor reads the north-star (`intentSource` via the existing anti-drift `readFile` +
  `getIntent` path) and, if `isNorthStarSilent`, escalates a distinct `blocked`
  "no north-star" escalation + journals it and returns WITHOUT draining. This burns no
  worker tokens. (A run with `requireNorthStar: false` skips this entirely.)
- **On DRIFT:** the existing check (`conductor.ts:985-995`) keeps escalating the drift.
  When `onDrift === "halt-drain"`, it ALSO breaks the drain loop after the escalation (no
  further tasks claimed). When `"escalate-task"` (attended), it continues as today.

### 4. The supervisor sets the unattended policy

`src/autonomy/overnight-supervisor.ts` (the unattended entry, `superviseOvernight`) passes
`{ onDrift: "halt-drain", requireNorthStar: true }` into the drain it drives. The
attended / plain-`run` path passes nothing → the default → unchanged behavior. This keeps
all unattended-specific policy in the one place that knows presence, and leaves the
conductor's attended path byte-for-byte as it was.

### 5. Observability

Both new outcomes are ordinary park/escalate + a decision-journal entry, so the **morning
report** (shipped this session) surfaces them: a north-star refusal and a drift-halt each
appear as a parked task in the operator's morning summary. The DRIFT escalation carries
the critic's verdict line as evidence (already does). No new report or artifact.

## Error handling (Principle 10)

- North-star read fails (not ENOENT) in the preflight → treat as silent (fail-closed:
  cannot confirm intent → refuse unattended), never as "present".
- `runAntiDrift` already degrades a model/parse failure to UNCERTAIN (never a false
  ON-TRACK); UNCERTAIN never halts the drain — only an explicit `DRIFT:` does. So a flaky
  anti-drift model cannot strand an overnight run; it just fails to catch drift that round
  (the next window retries).
- The halt-drain break is best-effort about STOPPING more work; the task that drifted is
  already parked by the existing escalation, so a halt that races a final claim degrades
  to "one more task ran" — safe (Principle 10).

## Testing

- `north-star.test.ts`: absent/empty/whitespace/sentinel → silent; real content → not
  silent; the actual scaffolded `GOAL_STUB` → silent (pins the sentinel contract).
- Conductor tests: `requireNorthStar` + silent north-star → no task claimed, a
  `blocked`/"no north-star" escalation, drain returns immediately; `onDrift: "halt-drain"`
  + a DRIFT verdict → the escalation fires AND no further task is claimed (a second
  pending task stays pending); the DEFAULT policy (omitted) reproduces today's
  escalate-and-continue exactly (regression pin).
- Supervisor test: `superviseOvernight` passes `halt-drain` + `requireNorthStar` into the
  drain; the plain run path passes the default.
- Scaffold test: the new `GOAL_STUB` contains the four sections + the sentinel, and
  `isNorthStarSilent(GOAL_STUB)` is true.
- Live proof (next session): on the polygon, (1) a stub GOAL.md + an unattended run →
  refused with "no north-star", no tasks run; (2) a filled GOAL.md + a task whose diff
  contradicts it → DRIFT halts the drain (a second queued task stays pending), both
  visible in the morning report.

## Non-goals (YAGNI)

- **Decision-granularity north-star check** (`adr/004` tenet 4's per-fork check) — that is
  a separate future slice; this is the run-level intent-vs-cumulative-diff check only.
- **Attended anti-drift behavior** — unchanged (escalate one task, continue).
- **Clamping `everyCommits`** in unattended — the operator owns their own risk window; a
  cap is a separate hardening if a need appears.
- **A new north-star editor/UI** — the operator fills `.autodev/GOAL.md` directly; a UI
  is out of scope.

## Files

- New: `src/anti-drift/north-star.ts` + `src/anti-drift/north-star.test.ts`.
- Edit: `src/config/schema.ts` (intentSource default), `src/registry/scaffold.ts`
  (GOAL_STUB), `src/conductor/conductor.ts` (policy: preflight + halt-on-drift),
  `src/autonomy/overnight-supervisor.ts` (set the unattended policy), plus their tests.

## Related

- `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — tenets 4-5.
- `src/anti-drift/anti-drift.ts` — the existing (toothless-without-intent) critic this arms.
- `docs/superpowers/specs/2026-07-23-morning-report-design.md` — the observability surface.
- `PRINCIPLES.md` #8, #10, #12.
