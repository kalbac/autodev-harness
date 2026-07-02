# Orchestrator Layer — Design Spec (adr/003 R1/R2)

> Status: **COMPLETE — all 5 forks operator-approved (s11, "да по всем") and BUILT.** Authored s11 (2026-07-02).
> Implements the second half of s11 (the first half, R3 role registry, shipped in PR #21).
> Anchor: `docs/adr/003-roles-are-a-configurable-vendor-matrix.md` (Resolution R1/R2/R4).
>
> **Built:** substrate (PR #22) + logic layer (adapter + staged pipeline, forks A1/C1) + composition-root
> wiring & `orchestrate` CLI verb (fork B). The operator runs `node dist/index.js orchestrate "<intent>"`.
> Forks resolved as recommended: A1 staged pipeline · B1 CLI verb · C1 decompose-only claude/opus adapter ·
> D digest+stdout+return report · E strict validateTaskSpec.

## 1. What this layer is (from adr/003, accepted)

An **additive LLM layer that sits STRICTLY ABOVE the deterministic conductor**, with **exactly four
capabilities and no others**:

1. **enqueue** — write a task file into `queue/pending/*.md` (the scheduler independently validates it).
2. **trigger** — kick the existing deterministic conductor loop (the `--once` / run entrypoint).
3. **read** — observe blackboard state (`queue/runtime/done`, reports, digest) READ-ONLY, over the `api`/repo seam.
4. **report** — narrate to the operator and drive the kanban.

**HARD boundary (R1):** the orchestrator has **no** `run_worker`/`run_critic`/`run_gate`/`commit` tool. Every
enforcement step (`claim→worktree→worker→harvest→fence→critic→gate→commit`) stays inside the pure-code conductor
and is un-bypassable. The LLM's only write into the enforcement path is a task file the scheduler validates. This
preserves the PowerShell-oracle "agent physically cannot talk past the gate" guarantee 1:1.

**R2:** for the MVP the orchestrator **itself** decomposes operator intent into task files (the `planner` role is
folded in — no separate live planner agent). Output contract = `queue/pending/*.md` in the exact shape the
scheduler already understands.

**R4 (scope fence):** the operator's window / session / transcript / conversational model is **P2** (a localhost
dashboard over the read-only `api` seam). **No UI is designed or built here.**

## 2. Seam verification (what already exists vs. what is new)

| Capability | Seam status | Notes |
|---|---|---|
| **read** | ✅ exists | `BlackboardRepository.listTasks/readRuntimeFile/runtimeDir` (`blackboard/repository.ts`); HTTP transport `GET /state` (`api/server.ts`). Headless P1 orchestrator calls `repo.*` directly; the HTTP server is a P2-UI transport, not a dependency. Gap: `/state` exposes queues+digestTail only, not per-task runtime reports — read those via `repo.readRuntimeFile`. |
| **enqueue** | ⚠️ new code | `BlackboardRepository` has NO create/write-task method and is a **frozen seam** (shared with conductor test-fakes) — must NOT grow one. `parseTask` (`blackboard/task.ts`) is **lenient** (defaults every field, never throws); the scheduler validates only deps+disjointness. So the enqueue path needs a **standalone serializer + strict validator** — the sole trust boundary for LLM-authored tasks. |
| **trigger** | ⚠️ wiring not reusable | `createConductor(deps).run(opts)` is a clean library factory, but the composition root that builds `ConductorDeps` lives inside the **un-exported** `main()` in `index.ts`. Triggering requires either refactoring `index.ts` to export a `buildConductor(repoRoot)` factory, or subprocess-spawning `node dist/index.js --once`. |
| **report** | ✅ primitives exist | `repo.appendDigest` + logger + a structured return value. Kanban is P2. |

## 3. The 4 capabilities as a module API

```ts
// src/orchestrator/capabilities.ts — the ONLY power the orchestrator agent gets.
export interface OrchestratorCapabilities {
  enqueue(spec: TaskSpec): Promise<{ id: string; path: string }>;
  trigger(opts?: { once?: boolean; maxIterations?: number }): Promise<unknown>; // impl deferred (fork B/C)
  read: {
    queues(): Promise<Record<QueueState, Task[]>>;
    runtimeReport(id: string, name: string): Promise<string | null>;
    digestTail(): Promise<string>;
  };
  report(entry: { level: string; message: string }): Promise<void>;
}
```

**R1 enforced mechanically, not by convention:** the composition root builds the four members as closures that
capture `conductor`/`repo` in scope; the `OrchestratorCapabilities` type exposes no gate/worker/commit handle, and
`src/orchestrator/**` imports nothing from `gate/`, `worker/`, `critic/`, `worktree/`. A vitest trip-wire
(`r1-boundary.test.ts`) reads the source text and fails if any such import (static or dynamic) appears.

## 4. Substrate — ALREADY LANDED (branch `autodev/s11-orchestrator`, commit `e8b74f0`)

The fork-independent parts (needed under every fork option — A1 ⊂ A2) are built, codex-gated, and committed:

- **`task-spec.ts`** — strict Zod `TaskSpec` + `validateTaskSpec` (fail-loud trust boundary), `isPathSafeId`
  (allowlist), `serializeTask` **proven** inverse of `parseTask` (parses its own output back + fingerprint-compares
  → throws rather than emit a corrupt task file).
- **`enqueue.ts`** — standalone `writeTaskToPending` (not a repo method; cross-state id-collision check + exclusive
  `wx` write; authors the pending file only).
- **`capabilities.ts`** — the interface + read/report/enqueue factories (`trigger` = interface member only).
- **`r1-boundary.test.ts`** — the mechanical R1 trip-wire.

codex GPT-5.5 gate: 6 findings (2 High: id control-chars, serializeTask round-trip proof; 3 Med: max_rounds
validation, enqueue TOCTOU, trip-wire breadth; 1 Low: digest newline injection) — all fixed + regression tests;
re-critic clean. 58 orchestrator tests; full suite 345 pass / 2 live-only skips.

## 5. Open forks — PENDING operator sign-off (🔴 = skeleton-shaping)

| # | Fork | Recommendation | Class |
|---|---|---|---|
| **A** | Execution model: agentic tool-use loop vs. staged pipeline | **A1 staged pipeline** for P1 (LLM one-shot decomposes intent → task files; deterministic code enqueues/triggers/reports). No operator window yet (R4→P2) to justify a live tool-loop; A1 ⊂ A2 so no rework. | 🔴 |
| **B** | Non-UI entry point | **B1** — `index.ts orchestrate "<intent>"` CLI subcommand + refactor `main()`'s wiring into a shared composition-root factory. | 🔴 |
| **C** | Orchestrator adapter | **C1 decompose-only** `claude/opus` (mirrors the `claude -p` worker/anti-drift spawn); register in `assertKnownAdapters`. Tool-use adapter deferred to P2. Forward-compatible (`decompose()` now, add `runLoop()` later). | 🔴 |
| **D** | "report" pre-kanban | structured return value + `[orchestrator]`-prefixed `digest.md` lines + stdout; **no** new kanban artifact (kanban data model is P2). | surface, lean-safe |
| **E** | `validateTaskSpec` strictness | strict gate: required `id`(path-safe)/`title`/`type`/non-empty `file_set`, id uniqueness across queues. Sole trust boundary for LLM-authored tasks. **(Mechanism already built in the substrate; confirm the required-field set.)** | 🔴 |

## 6. Build order — ALL COMPLETE

1. ✅ Substrate (§4) — PR #22.
2. ✅ `OrchestratorAdapter` interface + decompose-only `claude/opus` adapter (fork C1) — `adapter.ts`,
   `claude-orchestrator-adapter.ts`, `decompose-prompt.ts`.
3. ✅ `orchestrator.ts` — `createOrchestrator({caps, adapter, log}).handleIntent(intent)` staged pipeline (fork A1):
   snapshot → decompose → validate-all-or-nothing → transactional enqueue (rollback on partial failure) →
   bounded trigger (skipped on empty) → report.
4. ✅ Composition-root wiring in `index.ts` + `orchestrate "<intent>"` CLI verb (fork B): the orchestrator gets
   exactly the 4 capabilities; `trigger` is a closure over `conductor.run` (bounded default). Adapter selected by
   `cfg.roles.orchestrator.adapter`, fail-loud on unregistered.

Each landed via the full discipline (sonnet impl → controller spec-check → codex GPT-5.5 gate → re-critic). The
orchestrator's window/session model (R4) remains **P2**.

## Related
- `docs/adr/003-roles-are-a-configurable-vendor-matrix.md` — the accepted decision (R1/R2/R4).
- `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` — §2 (pure-code conductor the orchestrator must not bypass).
- `docs/CURRENT-STATE.md` — phase status + next actions.
