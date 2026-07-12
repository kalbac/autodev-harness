# Live orchestrator — attended presence: thread-chat as the main screen + event-driven narrator

> Design spec. Authored 2026-07-12 (s39, direction session with the operator; every design
> decision below is operator-picked). Implements the **attended half** of
> `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md`. The unattended half
> (overnight mode, decision classes, journal, morning report, north-star doc) is explicitly
> OUT of scope here — it gets its own brainstorm → spec in s41+. Discipline unchanged:
> TDD on backend modules + typecheck + `npm test` + **mandatory codex GPT-5.5 critic gate**
> per module + a live-prove through the real daemon + browser, judged by the operator on the
> *felt* criterion (no dead air; the run reads as a story), not just "no crash".

## 1. Problem

The engine works and the gate catches real bugs (s37/s38), but the product feels dead:

1. **Dead air.** Submitting an intent → 10–15 s of silence (the s34 chat's opening turn is
   intentionally non-streaming — the first reply arrives only with the HTTP response), then
   again after "Launch & Run" until the inspector shows anything.
2. **A transactional modal.** The s34 `ChatModal` is a launch dialog, not a conversation:
   no sense of *who* you talk to, it evaporates on confirm, and it leaks raw ```json
   decompose output + its plan chip overflows the viewport (two of the three s38 polish bugs).
3. **Nothing narrates.** After launch, the run is visible only as state (rail blocks, board
   columns, digest lines). Nobody *tells* the operator what is happening and why. The
   original autodev-loop had a live narrating orchestrator; the harness lost it (adr/004).

## 2. Goals / Non-goals

**Goals**
- **Chat is the project's main screen.** A thread-based conversation with the orchestrator
  (Claude Code / Codex Desktop IA: sidebar threads + transcript-forward main + inspector
  rail). The modal dies.
- **Thread = intent/run.** Each new intent opens a thread; the thread carries the pre-launch
  discussion, the launch, the run's live narration, and any mid-run Q&A — one story in one
  place. Threads persist on the blackboard and survive daemon restarts.
- **Prose + activity cells.** Machine events (worker/gate/CI/critic/merge) render instantly
  as compact collapsible cells (zero LLM cost, zero lag); the orchestrator adds short prose
  at milestones and forks. Cells deep-link into the existing screens (RunView, CiRunView,
  TaskDetail).
- **No dead air.** The orchestrator's first tokens appear within seconds of Enter — the
  opening turn streams like every other turn.
- **Launch by button AND by word.** The plan chip carries a `Launch` button; a plain
  conversational "launch it" / "drop task 3 and go" works too. Both routes end in the same
  unchanged confirmed-launch path (adr/003 R1: nothing is enqueued without explicit operator
  consent).
- **Rail = status, chat = voice.** SessionRail stays a silent glanceable status column
  (Plan/Tokens/CI/Verdict, unchanged); deep screens stay as routes.
- **shadcn-first** (AGENTS.md): transcript, cells, chip, composer are compositions of
  shadcn/Base UI primitives; check the live shadcn MCP catalog for purpose-built chat/thread
  blocks before building anything custom.

**Non-goals (this spec)**
- **Overnight mode** — no toggle is built (no dead buttons); placement (global, top bar) is
  recorded in adr/004 for the s41+ spec.
- **Decision classes / decision journal / morning report / north-star document** — adr/004,
  s41+.
- **Any change to enforcement** — gate, critic, escalation semantics, `launchOrchestrate`,
  decompose semantics: all unchanged. This is presence, not power.
- **i18n, desktop wrap** — parked as before.
- **Board/RunView/TaskDetail/CiRunView redesign** — they stay; only their *entry points*
  gain links from chat cells.

## 3. Design decisions (operator-picked, s39)

| Fork | Decision |
|---|---|
| Where the chat lives | Main screen of the project (transcript-forward); modal dies |
| Conversation model | Thread per intent/run; sidebar thread list per project |
| Run narration | Hybrid: instant machine activity-cells + LLM prose at milestones |
| Launch confirmation | Plan chip with `Launch` button AND conversational confirm; same R1 path |
| SessionRail / deep screens | Rail unchanged (status); deep screens unchanged (detail); cells link into them |
| Narrator architecture | Hybrid A+B: live `ClaudeChatProcess` pre-launch (s34 machinery, proven); event-driven one-shot narration post-launch (no long-lived process) |
| Scope | Attended presence only; autonomy = s41+ |

## 4. Architecture

### 4.1 Thread model (blackboard = truth)

```
.autodev/threads/<threadId>/
  thread.ndjson     # append-only typed entries (the transcript)
  meta.json         # { id, title, created_at, run_id? , status }
```

`thread.ndjson` entry types (one JSON object per line, `{ts, type, ...}`):
- `operator_msg { text }` — an operator turn.
- `orchestrator_msg { text, milestone? }` — orchestrator prose (streamed live, persisted whole).
- `activity { kind, ref, summary, status }` — machine event cell; `kind` ∈
  `worker | gate | agent_ci | critic | merge | escalation | run`; `ref` carries ids needed to
  deep-link (taskId, runId); rendered without LLM.
- `plan { specs[] }` — the proposed-plan chip (parsed specs only — never raw fenced JSON).
- `run_link { runId }` — written at confirm; binds thread ↔ run.

Threads are project-scoped; ids follow the existing path-safe id rules. Append via the same
never-throws best-effort persistence idiom as `agent-ci-events.ndjson` (size-capped, fail
logged, never blocks the run).

### 4.2 Pre-launch (reuse s34 machinery — "A")

`ChatSessionManager` / `ClaudeChatProcess` stay the conversational brain for the pre-launch
phase, with three changes:
1. **Bound to a thread**: every turn (operator + orchestrator + plan preview) is mirrored
   into `thread.ndjson` as it happens.
2. **The opening turn streams.** Today the first reply intentionally arrives only via the
   HTTP response (s34 Task-9 note). That design is reversed: the session starts, the SSE
   channel attaches first, and the opening reply streams token-by-token like any other turn.
   This single change kills the biggest dead-air window.
3. **The raw decompose JSON never reaches the transcript**: fenced ```json blocks are
   stripped server-side from the persisted/streamed prose (they are already parsed into the
   `plan` entry). Closes s38 polish bug #1 structurally.

### 4.3 Confirm — button and word, one path

- **Button:** the plan chip's `Launch` calls the existing confirm endpoint (today's
  `POST /chat/confirm` path → `launchOrchestrate`, unchanged).
- **Word:** the orchestrator chat prompt gains a control-marker contract (same idiom as the
  existing proposed-plan marker): when — and only when — the operator's latest message asks
  to launch, the model emits a `LAUNCH` marker. The backend accepts the marker as confirm
  **only if** it directly follows an operator turn in the same session and a `plan` entry
  exists; otherwise it is ignored and logged. The operator's own message is the explicit
  consent (R1 holds); the LLM is merely the parser of that consent. Misfire risk is bounded:
  a wrong launch is immediately visible in-thread and the existing cancel/reply machinery
  applies. Regression tests: marker-without-operator-turn ignored; marker-without-plan
  ignored; plain "launch it" launches.
- On confirm: `run_link` appended, the live chat process is **released** (its job is done),
  and the thread switches to narrated-run mode.

### 4.4 Post-launch narrator (event-driven one-shots — "B")

A new `NarratorService` (daemon-side, per active run):
- **Subscribes to existing sources only** — task status transitions on the blackboard, gate
  step outcomes, `CiEventBus` (s38), critic verdicts, digest `[orchestrator]` lines. No new
  hooks inside the conductor's enforcement path (read-only, adr/003 R1 capability 3).
- **Writes `activity` entries immediately** (no LLM) for every material event.
- **Triggers one-shot narration at milestones**: run started · task claimed by worker ·
  worker report harvested · gate verdict (RETRY with reasons / commit) · agent-ci
  green/red · critic verdict · escalation raised · merge/DONE · run finished · infra error.
  A narration call = the configured `orchestrator` role adapter invoked once (`claude -p`
  one-shot) with a compacted replay of the thread + the triggering event; output streams
  into the thread as `orchestrator_msg { milestone }`. Bursts coalesce (events within a
  short window → one call). **Best-effort:** narrator failure or slowness never affects the
  run — cells keep flowing; a failed narration is a logged skip.
- **Mid-run operator messages** use the same one-shot pattern (replayed thread context +
  read-only state snapshot → streamed reply). No long-lived process after launch, so a
  daemon restart loses nothing: the thread file IS the memory.

### 4.5 Transport + API

Mirrors the proven s38 CI-stream pattern (history-replay → live):
- `GET  /projects/:id/threads` · `POST /projects/:id/threads` (create = start chat session)
- `GET  /projects/:id/threads/:threadId` (meta + full transcript)
- `GET  /projects/:id/threads/:threadId/stream` — SSE: replay persisted entries, then live
  (new entries + token frames for the currently-streaming prose turn)
- `POST /projects/:id/threads/:threadId/message` — operator turn (pre-launch → live chat
  process; post-launch → narrator one-shot)
- Confirm/cancel: existing chat endpoints, now thread-addressed.
Existing WS invalidation continues to serve list-level updates.

### 4.6 UI composition (shadcn-first)

- **Routes:** `/p/:id` → newest thread (or a fresh-thread empty state with an orchestrator
  greeting — not an empty form); `/p/:id/t/:threadId`. Deep screens keep their routes.
- **Sidebar:** per-project thread list (`SidebarMenu` items: status glyph + title) + "New
  thread". Projects section unchanged.
- **Transcript:** `MessageScroller` (auto-follow, already vendored) + `Bubble` variants for
  operator/orchestrator prose.
- **Activity cells:** `Collapsible` + `Badge` + existing status glyphs; collapsed = one-line
  summary (kind · status · duration), expanded = key fields; click-through deep-links
  (gate/agent-ci cell → CiRunView, task cell → TaskDetail, run cell → RunView).
- **Plan chip:** ported from the modal; `max-w-full` + wrap/truncate-with-title (closes s38
  polish bug #2); `Launch` button inside the chip.
- **Composer:** the `NewRunComposer` textarea + `kbd` hint moves to the thread footer; on a
  fresh thread its submit starts the session (= today's intent submit), afterwards it sends
  turns.
- Before building, verify against the live shadcn MCP catalog whether purpose-built
  chat/thread/timeline blocks exist (per `[shadcn component currency]`); state in the PR
  what was checked.

### 4.7 What dies / migrates

- `ui/src/components/ChatModal.tsx` — deleted (its lifecycle hardening lessons — attempt
  counters, stale-token gating — move into the thread view where still relevant).
- `HomeView` — becomes the thread view host; the standalone composer screen goes away.
- s38 polish bugs #1 (raw JSON) and #2 (chip overflow) die with the modal (fixed
  structurally in 4.2/4.6); bug #3 (CI-link contrast in SessionRail) remains a separate
  one-line polish, unrelated to this spec.
- FUTURE-BACKLOG "Orchestrator CHAT" item — superseded by this spec + adr/004.

## 5. Error handling

- **Narrator is best-effort everywhere**: one-shot failure/timeout → logged skip, cells
  unaffected, run unaffected.
- **Thread persistence is best-effort + capped** (same idiom and caps discipline as the s38
  ndjson persist; codex found the unbounded variant — don't repeat it).
- **SSE lifecycle** copies the s38 fixes: replay-then-live without the replay-disconnect
  leak; dead-socket writes guarded.
- **Chat process lifecycle** keeps every s34 codex-hardened behavior (stale-attempt
  counters, idle reaper, one-per-project guard, cancel teardown); binding to threads must
  not reintroduce the `[chat/onToken-bound-once]` class — token routing is per-turn.
- **Restart:** a daemon restart mid-run loses the in-flight one-shot at most; the thread
  file replays fully; the narrator resumes on the next event.

## 6. Testing & live-prove

- **TDD** on: thread store (append/replay/caps), narrator event→cell mapping, milestone
  coalescing, LAUNCH-marker guards, stream replay→live, strip-fenced-json.
- **codex GPT-5.5 gate per module** (backend modules independently; UI review-only per
  established convention), re-critic in-place fixes.
- **Live-prove through the real daemon + Chrome, operator-judged:** type an intent → first
  orchestrator tokens within seconds (no dead air) → discuss → "запускай" by word → watch
  the run narrate itself (cells streaming instantly, prose at milestones) → click a gate
  cell into CiRunView → mid-run "как дела?" gets a contextual answer → DONE with a real
  commit; then a red path (critic RETRY or failing CI) reads as a story too. Felt criterion:
  **the thread reads like the original autodev-loop session did.**

## Related

- `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — the doctrine this implements (attended half).
- `docs/adr/003-roles-are-a-configurable-vendor-matrix.md` — R1 boundary (re-affirmed, untouched).
- `docs/superpowers/specs/2026-07-08-orchestrator-chat-design.md` + the s34 build — the pre-launch machinery reused here.
- `docs/superpowers/specs/2026-07-10-agent-ci-observability-design.md` — the ndjson+SSE transport pattern copied here.
- `docs/FUTURE-BACKLOG.md` — items absorbed/superseded (Orchestrator CHAT; s38 polish bugs #1/#2).
