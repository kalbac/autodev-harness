# 003 — Roles are a configurable model matrix; the orchestrator is an in-harness LLM

**Status:** proposed (operator clarification, s04 2026-07-01 — explicitly "discussable, not a hard rule")
**Date:** 2026-07-01
**Refines:** frozen-skeleton axis 2 (pluggable `WorkerAdapter`/`CriticAdapter`) and axis 6
(routing) from `002-build-own-harness-not-fork-ao.md`. Does not supersede them — extends
the adapter model from a fixed `claude`-worker + `codex`-critic pair into a general
role×model matrix, and adds an LLM orchestrator layer the parity spec does not have.

## Context

The port so far followed the autodev-loop parity spec, which hard-wires **worker = Claude,
critic = codex (non-Claude, heterogeneity "load-bearing"), conductor = pure PowerShell with
zero LLM calls**. Building `ClaudeWorkerAdapter` and `CodexCriticAdapter` first made it look
as though the harness bakes in "codex = critic, Claude = worker."

The operator clarified the intended model (s04): the harness must **not** bind a vendor to a
role. Per project, the operator chooses which model fills each role. Worker could be DeepSeek,
critic could be Claude, orchestrator could be codex. Concretely, as the operator described it:

- Global settings define a **default model per role** (orchestrator, worker, critic, planner, …).
- Creating/opening a **project** exposes the same knobs as **per-project overrides**.
- The operator, by default, has **one window: the orchestrator**, and talks only to it. The
  orchestrator assigns tasks to workers, launches the critic, watches the run, reports back,
  and manages the kanban.
- The operator can also open a window onto an already-running worker/critic/planner and talk
  to it directly, and can spawn a worker directly via "New task" (the AO pattern).

## Decision

**Roles are a first-class, open set (`orchestrator`, `worker`, `critic`, `planner`, …), each
mapped to a configurable model via a global default + per-project override. No vendor is bound
to a role. Adapters are role-interface implementations selected from a registry by config.**

To preserve the project thesis ("never let agents merge bullshit") under an LLM orchestrator,
the system is split into two layers:

1. **Enforcement substrate — deterministic, no LLM judgment.** worktree isolation, the machine
   `gate` + `guards` + `mutation-check`, the dirty-file fence, the critic-gate invocation, and
   commit-after-gate. This is the parity-spec conductor's machinery (plan Tasks 15–26). An LLM
   **cannot talk its way past it.** This layer is vendor- and role-agnostic and is needed in
   every version of the vision — so it is built **now** (gate group is next), unchanged.
2. **Orchestrator layer — an LLM, conversational.** The operator-facing agent that authors and
   prioritizes tasks, **triggers** the enforcement loop, monitors, reports, and drives the
   kanban. New relative to autodev-loop (there the orchestrator was the operator's external
   Claude session). It sits **above** the enforcement substrate but cannot override the gate.

Supporting mechanics:
- **Role registry + config-driven selection.** `worker/critic/…` adapters resolve from a
  registry by a configured vendor id; role→model mapping is config, not code. Introduced when
  the `conductor`/config is wired (plan Task 24 + config), informed by this ADR.
- **Per-adapter config.** Vendor-shaped knobs move under their adapter: today's global
  `worker.ladder = [opus,sonnet,haiku]` (Claude-shaped) and `critic.effort/model` (codex-shaped)
  become per-adapter settings so a DeepSeek worker or a Claude critic each carry their own.
- **Heterogeneity is a policy, not a vendor lock.** autodev-loop's "critic must differ from the
  worker family" becomes an operator-configurable policy (default on; at most a warning when
  worker and critic share a family), never a hardcoded "critic = codex."

## What this does NOT change

- The already-merged `WorkerAdapter`/`CriticAdapter` **interfaces are correct** — they are
  role-based and vendor-agnostic. `ClaudeWorkerAdapter`/`CodexCriticAdapter` remain valid MVP
  role-implementations; they are not a vendor lock, just the first two of a matrix.
- The gate/enforcement work proceeds unchanged and first (it is the substrate).
- The file-blackboard remains the single source of truth (axis 1).

## Open questions (to resolve with the operator before implementing the orchestrator layer)

1. **Orchestrator vs deterministic conductor boundary:** confirm the orchestrator LLM only
   *triggers/oversees* the deterministic loop (recommended — preserves the gate), rather than
   performing loop steps as judgment calls.
2. **Where the orchestrator lives:** a long-lived agent session per project inside the daemon;
   its transcript/window model (ties into the P2 multi-window UI + AO's session model).
3. **`planner` role scope:** what the planner does vs the orchestrator (task decomposition?).
4. **Config shape:** the global-defaults + per-project-override schema for role→model, and how
   it coexists with `.autodev/config.yaml`.

## Consequences

- The plan's `conductor` (Tasks 24–26) stays as the deterministic engine; an **orchestrator**
  layer is added on top (new tasks, likely alongside/after the P2 UI, since it is
  window/session-shaped). CURRENT-STATE tracks this.
- The adapter/role-registry + per-adapter config generalization is scheduled at the config +
  conductor stage, not retrofitted into the gate work.

## Related
- `002-build-own-harness-not-fork-ao.md` — the frozen skeleton this refines.
- `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` — §2 (pure-code conductor,
  the point of divergence), §5/§6 (critic/worker adapters).
- `docs/VISION.md` — mission anchor.
