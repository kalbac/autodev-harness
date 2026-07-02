# P2 Localhost Dashboard — Design Spec (adr/003 R4)

> Status: **APPROVED — all forks resolved with the operator (s13, 2026-07-02). Building backend-first.**
> Anchor: `docs/adr/003-roles-are-a-configurable-vendor-matrix.md` R4 (the deferred window/
> session/transcript model) + R1 (orchestrator's 4 caps; gate un-bypassable).
> Builds on the existing read seam `src/api/server.ts` and the frozen `BlackboardRepository`.

## 0. Reference basis (why these choices)

The stack + transport were chosen from three real codebases (operator's request, s13):

| Source | Frontend | Transport | Run/session model |
|---|---|---|---|
| **open-warehouse** (`d:/projects/laravel/open-warehouse`) | React 19 + Vite + TanStack Router/Query/Table + shadcn/@base-ui + Tailwind 4 + zustand + axios | React Query over HTTP (Laravel API) | n/a (CRUD app) |
| **AO** (`references/agent-orchestrator`) | React 19 + Vite + TanStack Router/Query + zustand + radix/Tailwind 4 (shadcn-style) + `openapi-fetch` | HTTP `/api/v1` (go-chi) + **SSE** live; WS only for the terminal | SQLite session rows; **NO transcript** (tmux scrollback only — our gotcha `[ao/ui]`); kanban derived from `attentionZone`, not stored |
| **OD** (`references/open-design`) | Next.js 16 + React 18 | HTTP `/api/*` (Express) + **SSE** live | `run.id` + per-run `runs/<runId>/events.jsonl` + conversation in SQLite; correlation by `conversationId` |

**Takeaways:** (1) open-warehouse ∩ AO converge on **React 19 + Vite + TanStack Query + shadcn/Tailwind + zustand** — that is our stack. (2) Both donors push live via SSE + React-Query invalidation; **we keep our already-gated WS `{type:"change"}`** (functionally identical for invalidate-on-change; zero backend churn — operator decision). (3) The transcript/run view comes from **OD's per-run artifact** pattern (AO has none); we use a file-native JSON manifest instead of SQLite, keeping the file-blackboard the single source of truth.

## 1. What this layer is

A **localhost web dashboard** giving the single operator the R4 window/session/transcript view
over the `api` seam. Hard constraints: **(a)** the enforcement substrate is un-bypassable (R1) —
the dashboard is a VIEW plus a small set of blessed write surfaces (escalation A/B reply; launching
an `orchestrate` run). Launching a run only **enqueues + triggers** through the same validated path
the CLI uses; it **cannot** run/skip/reorder any gate/worker/commit step. **(b)** `BlackboardRepository`
is a **frozen seam** — no new methods; new reads go through new `api/server.ts` endpoints that call
existing repo methods or read directly under `stateDir`. **(c)** the file-blackboard stays the single
source of truth — the dashboard holds no authoritative state; it renders server state and re-fetches
on change.

## 2. Seam map

| Dashboard capability | Seam status | Notes |
|---|---|---|
| List queues (kanban) | ✅ exists | `GET /state` → `{queues, digestTail}` over `repo.listTasks`. |
| Per-task detail / runtime report | ⚠️ new endpoint | `/state` exposes **no** per-task runtime reports. Add `GET /tasks/:id/runtime` (readdir `repo.runtimeDir(id)` — frozen repo has no list method) + `GET /tasks/:id/runtime/:name` → `repo.readRuntimeFile`. Reuse the `VALID_ESCALATION_ID` allowlist for `:id`/`:name`. |
| Runs (R4 correlation) | ⚠️ new artifact + endpoint | Orchestrator writes a per-run manifest (§3); dashboard lists via `GET /runs` + `GET /runs/:id` (direct fs under `stateDir/runs/`, like `escalations/`). |
| Live updates | ✅ exists (keep WS) | chokidar→WS `{type:"change", path}`. The React-Query client invalidates on any event and re-fetches. **No SSE** (operator decision — reuse the gated WS). |
| Digest / transcript | ✅ (partial) | `digestTail` (last 50 lines) in `/state`. Full run transcript assembled client-side from the run manifest + digest lines + per-task runtime files (§3). |
| Escalation reply | ✅ exists | `POST /escalations/:id/reply` — structured A/B `choice` + `note`-as-context-only (injection-safe; `note` NEVER executed). 1 MB cap → 413. |
| **Start an `orchestrate` run** | ⚠️ new endpoint + wiring | **IN SCOPE (operator).** `POST /orchestrate {intent}` → `runOrchestrate` closure (enqueue+trigger only; no gate/worker/commit handle — R1). Its own codex gate; rate/size-bounded like the reply endpoint. |
| **Serve the dashboard** | ⚠️ new wiring | `index.ts` starts neither the api server nor a UI — only `run`/`orchestrate` modes. New `serve` verb: build `ConductorDeps` (reuse the composition root), `createApiServer(...).listen(port)` bound to **127.0.0.1**, add a static-bundle `GET /` route (prod). Dev = `vite` dev-server proxying `/api`/`/ws` to the daemon (the open-warehouse laravel-vite pattern ≈ AO `dev:web`). |

## 3. The R4 model mapped onto the flat blackboard

The blackboard is flat files; there is **no native run/session grouping**. Definitions (MVP):

- **Run** = the N task files produced by one `orchestrate "<intent>"` decomposition.
- **Session** = the daemon's per-project lifetime (one long-lived orchestrator, R4).
- **Window** = one dashboard page (kanban, run view, or per-task detail).
- **Transcript** = a time-ordered run timeline (NOT a chat — A1 is one-shot decompose): operator
  intent → decomposed task list → per-task lifecycle events assembled from `digest.md` lines +
  per-task runtime files (`worker-report.md`, `gate-verdict.json`).

**Correlation — resolved via the OD-style per-run manifest (operator + donor-confirmed):** the
`[orchestrator]` digest line carries a task **count**, not the ids (verified in `orchestrator.ts`),
so runs are NOT reconstructable from flat state. Fix: the orchestrator writes a small, additive
manifest at enqueue time — it does **not** touch the frozen repo or the gate:

```jsonc
// <stateDir>/runs/<run-id>.json   (run-id = path-safe, clock+intent derived)
{ "runId": "20260702-...-<slug>", "intent": "<operator intent>",
  "taskIds": ["s13-t1-...", "s13-t2-..."], "at": 1751430000000 }
```

The manifest is written **after** the all-or-nothing enqueue succeeds (ids known: `handleIntent`'s
`enqueued[]`), before/around `trigger`. If the manifest write fails it is best-effort logged and
does NOT fail the run (the blackboard remains truth; the manifest is a convenience index). The
dashboard groups a run's tasks by reading the manifest; the transcript joins manifest.taskIds →
runtime files + digest lines.

## 4. Resolved forks (operator sign-off, s13)

| # | Fork | Decision | Basis |
|---|---|---|---|
| 1 | Serving model | **Vite build served as a static bundle by `api/server.ts`** (prod); `vite` dev-server + proxy in dev | one daemon/port; matches open-warehouse laravel-vite + AO `dev:web` |
| 2 | Framework | **React 19 + Vite + TanStack Router/Query + shadcn/@base-ui + Tailwind 4 + zustand** | open-warehouse's value here = the **shadcn/Tailwind visual layer** (operator's explicit interest), NOT its axios→Laravel coupling; AO's near-identical stack confirms it. Data client = a thin fetch wrapper under React Query (transport chosen for OUR `api` seam, not copied from open-warehouse). |
| 3 | Read vs. read-write | **Read + escalation A/B reply + `POST /orchestrate`** | operator wants to launch runs from the UI (closer to the R4 vision); still gate-un-bypassable |
| 4 | R4 run/session mapping | **OD-style per-run manifest `runs/<run-id>.json`** (orchestrator-side write) | runs genuinely not reconstructable from flat state; donor-proven; file-native (no SQLite) |
| 5 | Auth / binding | **Bind 127.0.0.1 only, no auth (MVP)** | single-operator daemon; token auth a reversible follow-up |
| 6 | Live transport | **Keep the existing WS `{type:"change"}`** + React-Query invalidation | already built+gated; functionally == SSE for invalidate-on-change; zero backend churn |

## 5. Build order (each backend chunk gets the FULL gate; static UI is reviewed, not gated)

1. **[backend, full gate]** Run manifest: orchestrator writes `<stateDir>/runs/<run-id>.json` at enqueue (injected clock + path-safe run-id; best-effort, never fails the run). Touches `src/orchestrator/` only — NOT the frozen repo, NOT the gate. R1 trip-wire must still pass.
2. **[backend, full gate]** Read endpoints in `api/server.ts`: `GET /runs`, `GET /runs/:id`, `GET /tasks/:id/runtime`, `GET /tasks/:id/runtime/:name` (id/name allowlisted; reuse `[api/413-teardown]`/`[ts/test-hang]` disciplines; no new repo method).
3. **[backend, full gate]** `serve` CLI verb in `index.ts`: reuse the composition root, `createApiServer(...).listen(127.0.0.1:port)`, static-bundle `GET /` route (fork 1).
4. **[backend, full gate]** `POST /orchestrate {intent}` → bounded `runOrchestrate` closure (enqueue+trigger only — no gate/worker/commit handle; R1). Size/shape-validated like the reply endpoint.
5. **[static UI, reviewed]** React/Vite app: kanban (queues) + per-task detail (+ **critic verdict surfaced first-class** — the "never merge bullshit" signal) + run/transcript timeline + escalation-reply form + "new run" intent box; WS-driven React-Query invalidation. Pure static assets.

## 6. Non-goals / scope fence (P2 MVP)

Out of scope: driving the gate/worker/commit from the UI; an Electron/Tauri desktop wrap (P3); a
live conversational tool-loop orchestrator (A1 is one-shot; the C-fork tool-use adapter is P2+);
SSE (WS kept); SQLite (file manifest kept); multi-project (one daemon per project assumed); **any
new `BlackboardRepository` method**; any authoritative dashboard-side state.

## Related
- [[003-roles-are-a-configurable-vendor-matrix]] — R4 (this dashboard) + R1 (gate un-bypassable).
- [[2026-07-02-orchestrator-layer-design]] — the read seam + `orchestrate` verb this builds on.
- [[VISION]] — file-blackboard single source of truth; two-layer split.
- [[CURRENT-STATE]] — phase status + next actions.
