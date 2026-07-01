# P1 — Core Loop (headless TS daemon) — Design Spec

> Sub-project 1 of the Autodev Harness. Authored 2026-07-01 via the brainstorming
> flow. Anchors: `docs/superpowers/donor-extraction/decision-matrix.md` (VERIFIED),
> `autodev-loop-parity-spec.md` (behavioral reference), `codex-verification.md`.
> Supersedes the "fork AO" premise of `docs/VISION.md` / `adr/001` (a new ADR will
> record the pivot).

## 1. Purpose & scope

Port our **proven PowerShell autodev-loop** (~2900 LOC, ran s1–s7 on woodev_framework)
into a **project-agnostic Node LTS + TypeScript daemon**. P1 is **headless** — no UI —
but exposes a thin HTTP/WS API that P2 (the web UI) will consume. The "intelligence"
stays external: worker = `claude -p`, critic = `codex exec` (GPT-5.5).

**Definition of done:** behavioral **parity** with the PS loop, demonstrated on a real
project (a fixture repo + at least one live woodev-class workload), under the frozen
skeleton decisions.

**Continuity constraint:** the existing PS loop keeps running our real tasks until P1
reaches parity. P1 is built in the new repo `github.com/kalbac/autodev-harness`; the PS
loop is untouched and serves as the parity oracle.

**Non-goals for P1** (explicitly deferred): web UI (P2); SQLite projection & event-log;
action-level risk gate; PR-based checkpoint; PATH-scan auto-detect; repo-map; BYOK proxy;
Docker sandbox; Electron/Tauri wrap. Each has a named seam below.

## 2. Frozen skeleton (from the verified decision matrix)

| Axis | Decision for P1 |
|---|---|
| State | File-blackboard is the single source of truth; accessed only through a `BlackboardRepository` interface (the seam for a future SQLite projection). |
| Worker interface | Pluggable `WorkerAdapter` / `CriticAdapter`; P1 ships the `claude` and `codex` adapters only. |
| Checkpoint | Conductor commits to the loop branch **after** the gate; behind a `Checkpoint` interface (seam for a PR adapter). Worker never commits to the loop branch. |
| Isolation | **Per-task `git worktree`**, non-destructive teardown; gate runs on the worktree diff; conductor merges after gate. |
| Gate | Independent diff-critic (`codex`) + machine gate (project commands + per-value contract-guard coverage). No self-critique. `GateExtension` seam for action-level risk. |
| Routing | Declarative per-task `model:` + cheaper-only sub-ladder; contract-zone pinned to opus. Thin `Router` abstraction (seam for BYOK). |

## 3. Module architecture (TS port, one responsibility each)

Mapped from the PS modules; kept small and independently testable.

| Module | Responsibility | PS origin |
|---|---|---|
| `config` | Load & validate per-project config (§5). Turns the 10 woodev couplings into settings. | scattered / `_common.ps1` |
| `blackboard` | `BlackboardRepository` interface + file implementation: read/write tasks, reports, verdicts, escalations, digest. **The state seam.** | `.autodev/` layout + `_common.ps1` |
| `scheduler` | Claim next pending task atomically (pending→active); dependency/order rules. **P1 runs one active task at a time (sequential — matches parity);** per-worktree isolation is per-task, not yet concurrent. `file_set` is retained as a scope fence and to enable future concurrent worktrees. | `scheduler.ps1` |
| `worktree` | Per-task `git worktree` lifecycle: create branch+worktree, teardown (non-destructive), merge-after-gate into the loop branch. | *(new — AO pattern)* |
| `worker-runner` | `WorkerAdapter` interface; `claude` adapter: spawn `claude -p`, model ladder, heartbeat, turn/timeout limits, capture report+diff. | `invoke-worker.ps1` |
| `critic-runner` | `CriticAdapter` interface; `codex` adapter: spawn `codex exec` (fenced — no worker rationale), parse `verdict.json`, bounded retry. | `invoke-critic.ps1` |
| `gate` | Machine gate: run project check/success commands; detect contract zones from INVARIANTS; per-value guard coverage; `GateExtension` hook. | `gate.ps1` |
| `guards` | Guard registry lookup (by value / by zone) + `mutation-check`: flip canonical→mutated, assert guard goes RED, revert. | `gate.ps1` + `mutation-check.ps1` |
| `anti-drift` | Periodic (every N commits) intent-vs-diff check against the project's intent source; fixed model. | `anti-drift.ps1` |
| `watchdog` | Heartbeat staleness → kill+respawn; circuit breaker (attempts>max → quarantine+escalate). | `watchdog.ps1` |
| `router` | Resolve model for a task: declared `model:` → cheaper-only sub-ladder; contract-zone → opus pin. Thin abstraction. | conductor tiering (`s7-t1`) |
| `escalate` | Write structured escalation; optional Telegram sink (env-gated). | `escalate.ps1` |
| `conductor` | The main loop: wires all the above; preflight, claim, run, gate, decide, commit, periodic jobs, graceful exit. | `conductor.ps1` |
| `api` | Thin HTTP + WS server over `BlackboardRepository`: read state, stream changes (chokidar file-watch), accept structured escalation replies. **The P2 seam.** | *(new)* |

## 4. The loop — control & data flow

Reconciled lifecycle (axes 3+4 composed):

```
preflight: refuse unless HEAD matches config.allowedBranchPattern (never main/default)
loop:
  task = scheduler.claim()                      # pending → active (atomic)
  if none: sleep; run periodic (anti-drift every N commits); continue
  attempts++ ; if attempts > max: quarantine + escalate("poison"); continue

  model  = router.resolve(task)                 # declared model ↓ ladder; contract-zone → opus
  wt     = worktree.create(task)                # fresh git worktree + branch off loop branch

  report = worker-runner.run(claude, task, wt, model)   # ladder on 429; watchdog on hang
    TOO_BIG    → enqueue decomposition; archive; teardown; continue
    NEEDS_GUARD→ escalate; teardown; continue
    BLOCKED    → escalate; teardown; continue

  diff   = git diff of wt
  verdict= critic-runner.run(codex, diff)        # fenced, read-only, GPT-5.5/high
    not clean & contract-zone         → escalate (never auto-retry); teardown; continue
    not clean & rounds left           → feed findings to a FRESH worker; retry
    not clean & rounds spent          → escalate; teardown; continue

  gate: project check/success commands green?    # else retry / escalate
        constitution touched?          → escalate
        for each contract value touched: blessed + mutation-verified guard?  else escalate
        GateExtension hook (P1: no-op; seam for action-level risk)

  commit: worktree.mergeAfterGate(wt)            # merge branch → loop branch (conductor, not worker)
          blackboard.markDone(task, hash); append digest
          worktree.teardown(wt)
```

Fail-closed: any non-COMMIT decision routes to retry (→pending) or escalate, never a
silent pass. RETRY returns the task to `pending/` (not `active/`).

## 5. Generalization config (the 10 woodev couplings → settings)

Per target project, a config file (e.g. `.autodev/config.yaml` or `harness.config.*`):

| Coupling (PS hardcode) | Config key |
|---|---|
| repo-root via `composer.json`+`woodev/` | `repoRoot.detect` (globs/markers) |
| build/test gate `composer check` | `gate.checkCommand` |
| guard-test runner (PHPUnit) | `guards.testCommand` |
| anti-drift intent source (one doc + headers) | `antiDrift.intentSource`, `antiDrift.headers` |
| constitution paths | `contract.constitutionPaths` |
| INVARIANTS contract-zone WP/PHP idioms | `contract.zones` (patterns/paths per project) |
| worker prompt "Serena for PHP" hint | `worker.promptHints` |
| commit-type mapping | `commit.typeMap` |
| `.autodev/` state-dir name | `stateDir` |
| `^autodev/` branch pattern | `allowedBranchPattern` |

Blackboard task schema is carried over verbatim (parity): frontmatter `id, title, type,
touches_contract_zone, writes_guard, model?, file_set[], forbidden_paths[],
success_commands[], max_rounds, depends_on[], contract_zones_touched[], needs_guard,
acceptance[]`; plus `worker-report.md`, `verdict.json`, escalation `.md`, `digest.md`.

## 6. Seams (named, so later grafts land without rework)

- `WorkerAdapter` — enables PATH-scan auto-detect, ACP backend, Aider-as-worker, repo-map pre-pass (P2-era).
- `CriticAdapter` — alternative critics; keeps "independent, non-Claude" contract.
- `GateExtension` — action-level risk-ensemble gate (P1 fast-follow).
- `Checkpoint` — PR-based adapter for GitHub+CI repos (P3).
- `BlackboardRepository` — SQLite read-model projection + append-only event-log (P3).
- `Router` — BYOK / multi-provider proxy (P3).

## 7. Error handling & safety (parity with proven behavior)

- **Rate-limit/429:** step down the model ladder (ordinary tasks) → return task to
  pending with the **attempt refunded** → backoff `rateLimitBackoffSeconds`. Contract-zone
  tasks **never downgrade** — they pause.
- **Hang:** watchdog on heartbeat staleness → kill + respawn fresh (attempts++).
- **Poison:** attempts > `maxAttempts` → quarantine + escalate.
- **Isolation:** per-worktree removes the shared-tree dirty-fence as a *lock*; keep a
  post-merge conflict guard (fail-closed on merge conflict → escalate).
- **Guards:** a contract value with no machine-checkable mutation recipe stays human-gated
  (never silently "guarded").
- **Fencing:** critic must not read the worker's report/rationale (anti-anchoring).
- **Anti-patterns rejected** (from matrix): no self-critique-as-gate; critic auto-invokes
  on every non-empty diff (never a manual trigger); confirm `codex exec` isolation.

## 8. Testing strategy

- **TDD**, module by module (`superpowers:test-driven-development`).
- **Unit:** scheduler claim atomicity; router ladder resolution (declared/contract-zone);
  gate contract-value coverage; mutation-check RED assertion; worktree create/teardown/merge;
  blackboard repository round-trips; critic verdict parsing & fencing.
- **Adapter contract tests:** `WorkerAdapter`/`CriticAdapter` against fakes (no real LLM
  calls in unit tests); one integration test that really spawns `claude -p`/`codex exec`
  behind a flag.
- **Parity harness:** run the TS loop on a fixture repo with seeded tasks (incl. a
  contract-zone task, a TOO_BIG, a poison, a 429 simulation) and assert the same decisions
  the PS loop's `done/`+`escalations/` show for equivalent inputs.
- **Cross-platform:** CI matrix Windows + Linux (macOS best-effort) — proves the PowerShell
  Windows-lock is gone.

## 9. Tech choices

Node LTS + TypeScript; `child_process` for adapters; git via CLI (`child_process`) for
worktree ops (portable, matches AO); `chokidar` for file-watch → WS push; built-in `http`
+ a small `ws` for the API; a schema validator (e.g. `zod`) for config + blackboard files;
a test runner (`vitest` or `node:test`). Single long-lived daemon process.

## 10. Build order within P1

1. `config` + `blackboard` (repository interface + file impl) — the foundation.
2. `worktree` lifecycle.
3. `worker-runner` (claude adapter) + `router`.
4. `critic-runner` (codex adapter) + fencing.
5. `gate` + `guards` + `mutation-check`.
6. `watchdog` + `escalate` + `anti-drift`.
7. `conductor` wiring.
8. thin `api` (read + change-stream + escalation-reply) for P2.
9. parity harness + cross-platform CI.

## Related
- `../donor-extraction/decision-matrix.md` — the verified basis for every choice here.
- `../donor-extraction/autodev-loop-parity-spec.md` — the behavior this must match.
- Next: `superpowers:writing-plans` → implementation plan for the build order above.
