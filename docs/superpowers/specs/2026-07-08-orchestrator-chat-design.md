# Orchestrator Chat — a real pre-launch conversation, not a fire-and-forget submit

> Design spec. Authored 2026-07-08 (s33). Resolves the `adr/003` open question flagged in
> `FUTURE-BACKLOG.md` "Orchestrator CHAT" and `next-session-promt.md`. Discipline: DAEMON
> changes → TDD + typecheck + `npm test` + **mandatory codex GPT-5.5 critic gate**; UI is
> shadcn-composition, review-only (per `AGENTS.md` shadcn-first rule).

## 1. Problem

Launching a run today is submit-and-silence: the operator types free text into
`NewRunComposer`, hits Launch, and `POST /orchestrate` returns 202 immediately
(fire-and-forget by design). The real outcome — decompose, dedup-skip, validation
reject — surfaces only as a toast (s32, PR #60) after the fact. The operator's
long-standing vision (pre-dates this session) is that launching a run should feel like
**talking to an agent** — back-and-forth, refine the ask, see the proposed plan, then
launch — not filling in a form and hoping. The narrower "was this a silent no-op"
complaint is already closed by the s32 toast; this spec is the bigger piece: an actual
conversation before the run starts.

**The load-bearing constraint (resolved this session, confirmed with the operator):**
`adr/003` R1 grants the LLM orchestrator exactly four capabilities — `enqueue` /
`trigger` / `read` / `report` — and no `run_worker`/`run_critic`/`run_gate`/`commit`
tool, so it "cannot sequence, skip, or reorder enforcement." R4 explicitly deferred the
orchestrator's "window/session/transcript model" to the P2 UI layer — i.e. to now. A
chat is compatible with `adr/003` as long as it stays a UI/preview layer over the same
four capabilities and never gains a new power. Concretely: the chat conversation is
**advisory only**; the one and only write into the enforcement path is the existing,
unchanged `handleIntent()` (`src/orchestrator/orchestrator.ts`), invoked exactly once
when the operator explicitly confirms — identical to today's single-shot orchestrate.

## 2. Goals / Non-goals

**Goals**
- Replace the "type intent → Launch → silence/toast" flow with a real conversational
  exchange: the operator can refine, ask questions, and see a live proposed task
  breakdown before anything is enqueued.
- The orchestrator's replies are genuine conversational text (not a bare rendered
  `TaskSpec[]` list), backed by a live, resumable model session for the duration of one
  chat (spawn-once, multi-turn — not a fresh spawn with re-stuffed history per turn).
- Confirming launches the run through the exact same `handleIntent` path as today's
  `POST /orchestrate` — zero changes to the conductor/orchestrator core pipeline.
- Cancelling discards the conversation with zero side effects (nothing was ever
  enqueued during the chat).

**Non-goals (this spec — explicitly out of scope for v1)**
- **Mid-run chat.** The chat is available only **before the first enqueue** for a given
  intent. Once "Confirm & Launch" fires, the chat session closes and the operator drops
  back into the existing run UI (digest/toast/escalation cards) — no re-prioritize,
  no abandon-mid-flight, no follow-up-task-via-chat while a run is active. (Flagged in
  `next-session-promt.md` as the largest scope/risk fork; deliberately deferred.)
- **Any new enforcement capability.** The chat can never commit, skip the gate, or
  reorder conductor steps — that remains `apply-on-accept`'s (choice C, s32) job via its
  own explicit, separately-gated UI action.
- **Cross-session / cross-restart chat persistence.** A chat that outlives a daemon
  restart or a browser refresh is not supported — see §5 Error handling.
- **Multiple concurrent chats per project.** One active chat session per project at a
  time (mirrors the existing in-flight-run 409 guard).

## 3. Behavior

### 3a. Entry point — `NewRunComposer`

Today's textarea + "Launch run" button becomes the **first message** of a chat, not a
direct `POST /orchestrate` call. Submitting opens a modal (shadcn `Dialog`) over Home;
`NewRunComposer` itself is otherwise unchanged (project switcher, role badges stay).

### 3b. The chat

```
┌─ ChatModal ─────────────────────────────────────────────┐
│ operator: add rate limiting to /api                     │
│ orchestrator: I'd split this into 2 tasks — a           │
│   middleware module and wiring it into the router.      │
│   ┌─ Proposed plan ─────────────────────┐               │
│   │ ☐ rate-limit-middleware  src/mw/...  │               │
│   │ ☐ wire-rate-limit-router src/api/... │               │
│   └───────────────────────────────────────┘             │
│ operator: also cover the webhook endpoint                │
│ orchestrator: updated — added a 3rd task for the         │
│   webhook route. ...                                     │
│                                                           │
│ [Cancel]                          [Confirm & Launch]    │
└──────────────────────────────────────────────────────────┘
```

- Orchestrator replies stream in (token-by-token) over a live, multi-turn model
  session held open for the lifetime of the chat.
- The "Proposed plan" panel is **advisory** — a live-updating preview rendered from
  whatever `proposedSpecs` the current turn returned. It is not authoritative and is
  never enqueued directly.
- **Confirm & Launch:** our own code (not the LLM) joins every operator message in the
  conversation into one `finalIntent` string, closes the chat session, and calls the
  existing `POST /orchestrate` (i.e. `handleIntent(finalIntent)`) — completely
  unchanged. The existing s32 toast/digest-watch behavior on `NewRunComposer` still
  applies from this point, since it is the same endpoint.
- **Cancel:** closes/kills the chat session; nothing was ever enqueued; the textarea
  keeps the last-typed text for editing, same as today's error path.

### 3c. Backend shape

- New `OrchestratorChatAdapter` interface (`src/orchestrator/chat-adapter.ts`),
  sibling to today's `OrchestratorAdapter` (`decompose`-only): `startSession` /
  `send` / `close`, each returning `{ reply: string; proposedSpecs?: TaskSpec[] }`.
  The Claude implementation holds one live child process for the chat's duration
  (streaming stdin/stdout), prompted to emit both free text and an optional
  structured plan block — same "ask the model for structured output alongside prose"
  pattern the critic-verdict schema already uses.
- New `ChatSessionManager`: an in-memory `Map<sessionId, session>` (child process
  handle, project binding, last-activity timestamp). An idle-timeout reaper
  (SIGTERM → grace → SIGKILL, mirrors the existing `util/native.ts` pattern already
  used for the M1b agent-extensions scan) kills abandoned sessions; all live sessions
  are killed on daemon shutdown. One active session per project (409 otherwise).
- New endpoints under the project's admin API: start / stream (SSE) / send-message /
  confirm / cancel. `confirm` is a thin wrapper: close the session, then call the
  exact existing orchestrate handler with the assembled `finalIntent` — no new code
  path into `handleIntent`.
- `handleIntent`, `OrchestratorCapabilities`, and the conductor are **untouched**. The
  chat adapter has no `enqueue`/`trigger` access at all — only the confirm handler
  does, and only by calling the pre-existing orchestrate entrypoint.

## 4. Data flow (happy path)

1. Operator types intent, submits → `POST /chat` starts a session (builds the same
   `ReadSnapshot` `handleIntent` would) → live process spawned → first reply streams
   over SSE.
2. Zero or more turns: `POST /chat/:id/message` → adapter `send()` → reply +
   optional `proposedSpecs` stream back; UI updates the transcript and the plan panel.
3. Confirm → UI joins the operator's own messages into `finalIntent` → `POST
   /chat/:id/confirm` → session closed → existing `api.postOrchestrate(projectId,
   finalIntent)` fires exactly as today → modal closes → operator is back on Home
   watching the existing digest/toast behavior.
4. Cancel (at any point before confirm) → `DELETE /chat/:id` → process killed →
   nothing enqueued → modal closes.

## 5. Error handling

- **Child process crash mid-chat:** SSE stream emits an error event; UI offers
  "Restart chat" (fresh session, prior conversation lost — acceptable, since nothing
  before confirm has a real side effect).
- **Idle abandonment** (operator closes the tab without cancel): the daemon-side
  reaper kills the process after an idle timeout; there is nothing to reconcile
  client-side since the browser is simply gone.
- **SSE disconnect** (network blip): UI retries the stream against the same
  `sessionId`; if the session was already reaped, show "session expired, start over."
- **Confirm-time 409** (another run already in flight): identical to today's
  `NewRunComposer` error path — surfaced in the modal, chat stays open so the
  operator can retry confirm without retyping the conversation.
- **Second chat attempt while one is open:** 409, same shape as the existing
  in-flight-run guard.

## 6. Testing / verification

- `ChatSessionManager`: unit tests with an injectable fake process + clock (idle
  reap, kill-all, one-session-per-project 409) — same injectable-time/log/spawn
  style already used throughout this codebase.
- `OrchestratorChatAdapter`: unit-tested against a fake child-process harness, no
  real `claude` spawn in unit tests (matches how `decompose`/critic adapters are
  tested today).
- API routes: HTTP integration tests over a fake adapter (start/message/confirm/
  cancel transitions + the 409 guards).
- **Live-prove required before merge**, not just unit tests: this feature touches
  LLM-generated conversational output in a new way, and gotcha
  `[orchestrator/llm-retitle-breaks-task-level-dedup]` already burned us once on
  "unit tests with controlled fixtures can't see LLM-output drift" for a
  gate-adjacent feature. A real chat session against a real `claude` spawn, through
  to a real confirm → real `handleIntent` → real enqueue, is required.
- Mandatory codex GPT-5.5 gate on the new adapter + session-manager + API surface
  (new daemon-side process/resource-lifecycle code is exactly the class of change
  this project's critic discipline exists for).

## 7. Open questions carried into the implementation plan (not blocking this spec)

- Whether the Claude Code CLI supports a genuine multi-turn `stream-json` bidirectional
  session in one process, or whether the "live process" needs to be built as repeated
  `--resume <session-id>` spawns under the hood (same external behavior, different
  internal plumbing) — verify against the actual CLI during planning, not here.
- Exact idle-timeout duration for the reaper — pick a reasonable default (e.g. 10
  minutes) during implementation; not a product decision.

## Related

- `adr/003-roles-are-a-configurable-vendor-matrix.md` — the R1/R4 constraint this
  design satisfies.
- `docs/FUTURE-BACKLOG.md` "Orchestrator CHAT" — the backlog entry this spec closes.
- `docs/gotchas/fire-and-forget-action-needs-feedback-at-point-of-action.md` — the s32
  toast fix this design supersedes for the "silent no-op" case specifically (the toast
  behavior is preserved post-confirm, unchanged).
- `src/orchestrator/orchestrator.ts`, `src/orchestrator/capabilities.ts`,
  `src/orchestrator/adapter.ts` — the existing, unchanged enforcement path this design
  is built strictly on top of.
