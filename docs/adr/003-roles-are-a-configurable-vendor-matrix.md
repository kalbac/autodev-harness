# 003 — Roles are a configurable model matrix; the orchestrator is an in-harness LLM

**Status:** accepted (operator sign-off, s10 2026-07-02 — all four open questions resolved below)
**Date:** 2026-07-01 (proposed) · 2026-07-02 (accepted)
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

**Framing the operator gave (the intent behind this):** globally, the orchestrator role and
the autodev discipline do not change from autodev-loop — only the packaging does. Before, the
operator launched a Claude Code session in the project terminal and said "use autodev-loop to
implement task X"; now the operator just opens the harness and says "implement task X", and the
orchestrator already knows it is inside autodev. The wiring becomes implicit instead of a manual
instruction. Crucially, the discipline the orchestrator "obeys" is two things: (1) a soft
*protocol* layer it follows as an agent, and (2) a hard, un-bypassable *deterministic gate* —
in autodev-loop the gate ran in PowerShell, not in the operator's Claude session, so the agent
physically could not talk past it. That mechanical guarantee (not the agent's good behavior) is
what makes "never merge bullshit" hold — and it maps directly onto the two-layer split below.

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

## Resolution (s10, 2026-07-02 — operator sign-off)

All four open questions were resolved with the operator in s10. The ADR moves to **accepted**.

### R1 — Orchestrator ↔ deterministic-conductor boundary: **orchestrator sits STRICTLY ABOVE.**
The LLM orchestrator touches the enforcement path through exactly four capabilities and no
others:
1. **enqueue** — write a task file into `queue/pending/*.md` (the scheduler already validates it);
2. **trigger** — kick the deterministic conductor loop (the existing `--once`/run entrypoint);
3. **read** — observe blackboard state (`queue/runtime/done`, reports, digest) read-only;
4. **report** — narrate to the operator and drive the kanban.

Every enforcement step — `claim → worktree → worker → harvestWorkerReport → dirty-file fence →
critic → machine gate → commit-after-gate` — stays inside the pure-code conductor. The
orchestrator has **no** `run_worker`/`run_critic`/`run_gate`/`commit` tool and cannot sequence,
skip, or reorder enforcement. The LLM's *only* write into the enforcement path is a task file the
scheduler independently validates. This preserves the PowerShell-oracle guarantee 1:1: the agent
**physically cannot talk past the gate**, because the gate does not run in the agent's context.
(This is the mechanical guarantee named in the Context section — not the agent's good behavior.)

### R2 — `planner` role scope: **folded into the orchestrator for MVP; reserved in the registry.**
For the MVP the orchestrator itself decomposes operator intent into task files; there is no
separate live planner agent. `planner` is a **reserved role id in the role registry** (R3) so a
future split is a config change, not a refactor: point `planner` at a cheaper/different model and
have the orchestrator delegate decomposition to it. **Output contract (now and after any split):**
`queue/pending/*.md` task files in the exact shape the scheduler already understands — decomposition
never invents a new artifact.

### R3 — Config shape: **a unified `roles:` registry with global defaults + sparse per-project override.**
Global defaults (harness-level config) define every role; `.autodev/config.yaml` carries only
per-project **overrides** (sparse — only the keys that differ). Each role entry is
`{ adapter, model, effort?, exe? }`. The current flat `worker`/`critic` blocks **migrate into**
this registry — this is the axis-2/axis-6 generalization the frozen skeleton anticipated, not a
break of it. A `policy.heterogeneity` key (default `warn`) carries autodev-loop's "critic family
must differ from worker family" as operator-configurable policy, never a hardcoded `critic = codex`.

```yaml
# global defaults (harness-level)
roles:
  orchestrator: { adapter: claude, model: opus }
  worker:       { adapter: claude, model: sonnet }
  critic:       { adapter: codex,  model: gpt-5.5, effort: high }
  planner:      { adapter: claude, model: sonnet }   # reserved; MVP = orchestrator decomposes
policy:
  heterogeneity: warn        # warn when critic family == worker family

# .autodev/config.yaml — per-project OVERRIDE (sparse, only what differs)
roles:
  worker: { model: haiku }
```

### R4 — Where the orchestrator lives: **one long-lived per-project agent session inside the daemon.**
By default the operator has a single window — the orchestrator — and talks only to it; it authors
tasks, triggers the loop, monitors, reports, and manages the kanban. Directly opening a window onto
a running worker/critic/planner, and the "New task" direct-spawn (AO pattern), are **P2 UI**
concerns — the transcript/window/session model is window-shaped and lands with the P2 dashboard
over the read-only `api` seam, not in this design step.

## Consequences

- The plan's `conductor` stays as the deterministic engine, unchanged; the **orchestrator** is an
  additive layer above it (R1), buildable now that this ADR is accepted. Its four capabilities
  (enqueue/trigger/read/report) sit on top of the existing scheduler + run entrypoint + `api`
  read seam — no new hole in the enforcement substrate.
- Next engineering step (a future session): the **role registry + per-adapter config** (R3) —
  generalize the flat `worker`/`critic` blocks into `roles:` with global defaults + sparse
  per-project override, plus a `policy.heterogeneity` key. This is a config/adapter change, not a
  conductor change, and must not break the parity spec or the frozen skeleton (axes 2 + 6).
- `planner` ships as a reserved registry id only (R2); no live planner agent in the MVP.
- The orchestrator's window/session/transcript model (R4) is deferred to **P2** (localhost
  dashboard over the read-only `api` seam), since it is window-shaped.

## Related
- `002-build-own-harness-not-fork-ao.md` — the frozen skeleton this refines.
- `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` — §2 (pure-code conductor,
  the point of divergence), §5/§6 (critic/worker adapters).
- `docs/VISION.md` — mission anchor.
