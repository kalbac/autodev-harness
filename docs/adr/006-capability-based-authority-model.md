# 006 — A capability-based Authority Model: the worker never controls its own oracle

**Status:** accepted (operator delegated the s48 priority + decision to the agent,
2026-07-21; s48 scoped to docs + audit — enforcement is phased, not built this session)
**Date:** 2026-07-21
**Refines:** `003-roles-are-a-configurable-vendor-matrix.md` (R1 — the mechanical
enforcement boundary) and `005` (which oracle is the *critic's* remit vs the machine
gate's). Formalizes the write-authority axis those left implicit. Driven by
`wiki/architecture-review-external-2026-07.md` risk 5 and the code audit in
`wiki/authority-model-audit-2026-07.md`.

## Context

The harness's guarantee is "never merge bullshit," enforced by moving acceptance
off the worker's word onto a mechanical gate (Principles 1–3). Principle 2 says the
worker cannot self-*certify*. But certification is only half of authority: the other
half is **who may modify the oracle** — the tests, assertions, contract zones, CI
config, protected-path list, and release config that *define* what "pass" means.
Once a worker cannot say DONE, the rational reward-hacking target shifts to the
checks themselves. The external review named this risk 5: **"the worker must never
control its own oracle."**

The s48 audit (`wiki/authority-model-audit-2026-07.md`) traced this in code and
found the boundary is **half-closed**:

- **Closed by construction:** the *task contract* (`file_set`, `forbidden_paths`,
  `success_commands`, contract-zone flags) and the *gate config* (`.autodev/config.yaml`)
  live in the git-excluded blackboard, which is not materialized in the worker's
  worktree. The worker cannot rewrite either. The escalation *router* reads
  INVARIANTS from the trusted main root.
- **Open:** the deciding **machine gate reads every oracle *definition* from the
  worktree** — `INVARIANTS.md`, `GUARDS.md`, guard recipes, `.github/workflows/*`,
  guard test files (`gateDeps(wt)`, `composition/root.ts:299-441`). Whenever such a
  tracked file is in a task's `file_set`, the worker edits it and the gate trusts
  the weakened copy. The one config-level protected-path field
  (`contract.constitutionPaths`) is **unused**. There is **no capability model** —
  protection is per-task, LLM-authored `forbidden_paths`, never required to cover
  oracle files.

Rights today are implied by **role** (worker writes the worktree; orchestrator
enqueues) and by **per-task scope** (the fence). Neither is a statement of *who may
modify each class of oracle artifact*. That statement is what this ADR establishes.

## Decision

**Authority in the harness is defined by capability over a named class of
artifacts, not by role name. The worker holds no capability to modify any oracle
artifact. Every oracle definition the gate trusts is read from a root the worker
cannot write; every legitimate oracle change is gated by an explicit operator
capability.**

### 1. The protected artifact classes (the oracle)

These artifacts define what "pass" means. They are the oracle:

| Class | Concretely | Today's home |
|---|---|---|
| **Task contract** | `file_set`, `forbidden_paths`, `success_commands`, `depends_on`, contract-zone flags | blackboard `.autodev/queue/**` |
| **Acceptance criteria** | `acceptance`, and (future) hidden tests | task spec / (future) profile |
| **Contract zones** | `INVARIANTS.md` MACHINE-INVARIANTS: zones + constitution path_globs | `contract.invariantsFile` |
| **Guards** | `GUARDS.md` + mutation recipe JSON | `contract.guardsFile` |
| **CI config** | agent-ci workflow files + the workflow allowlist | `.github/workflows/*` + `gate.agentCi.workflows` |
| **Gate policy** | check command, gate/critic model pins, `dirtyFenceIgnore` | `.autodev/config.yaml` |
| **Protected paths** | the declaration of *this very list* | `contract.constitutionPaths` (to be wired) |
| **Release config** | (future) packaging/publish config a profile adds | profile `release/` |

### 2. The three capabilities over each class

- **read/execute** — run the oracle against the code under test. Held by the
  **gate** (deterministic substrate). The gate *executes* checks/CI/mutations
  against the **worktree** — that is the code being judged and does not change.
- **define** — read the oracle *definition* (what the zones/guards/protected-paths/
  CI-allowlist *are*). Bound to a **trusted root** the worker cannot write (main
  repo / git-excluded `.autodev`) — **never the worktree**.
- **modify** — change an oracle definition. Held **only by the operator** (a
  "bless" capability), never granted to the worker or the LLM orchestrator. A
  change to an oracle artifact that rides in on a worker diff is not silently
  trusted; it is surfaced for an explicit operator decision.

The **worker** holds none of these over any oracle class. It holds exactly one
capability: *write non-oracle files within its task's `file_set`, in an isolated
worktree, proposing a diff it cannot commit.*

### 3. The load-bearing rule

> **Oracle definitions are read from a trusted root; oracle execution runs against
> the worktree; oracle modifications require an operator capability.**

This closes the audit's Findings 1–3 as a single rule rather than a pile of
patches, and it is worktree-immune *for definitions*: no diff a worker writes can
reach the definition the gate reads. It does **not**, on its own, protect the
*contents* of executed oracle inputs (test files, `success_command` scripts,
workflow implementations) — those are run from the worktree by design, so their
integrity is a separate obligation of the protected-paths model (below). Naming the
two obligations separately is what keeps the word "sound" honest.

### 4. Legitimate oracle changes are blessed, not blocked

Tasks that *should* change the oracle (introduce a contract zone, add a guard,
update `ci.yml`) are real. Under this model such a change does not weaken the run
that produces it (the gate judged it against the *previous, trusted* oracle) and
does not silently take effect (it governs only after an operator blesses it, the
same shape as the existing `GUARDS.md` operator-bless in `gate.ts:262`). "New zone
self-enforces in the same run" was convenience and is exactly the reward-hacking
surface; dropping it is the point, not a regression.

## What this does NOT change

- **Enforcement stays mechanical** (`adr/003` R1). This ADR moves *which root* the
  gate reads its definitions from and adds a capability vocabulary; it does not add
  an LLM to the gate.
- **The critic's remit** (`adr/005`) — correctness + fabrication, not coverage —
  is untouched. This ADR is about *write authority over the oracle*, an orthogonal
  axis to *what the critic judges*.
- **s48 ships no enforcement code.** Operator scoped s48 to the audit + this ADR +
  the `PRINCIPLES.md` hardening. The schema, gate, and conductor are unchanged this
  session.

## Consequences (phased; each phase is its own gated task)

- **Phase 1 (first enforcement increment) — definition integrity.** Move the gate's
  oracle-*definition* reads to the trusted root: `gateDeps` reads
  `loadInvariants`/`loadGuardPairs` from `repoRoot` (as `zonesTouchedInDiff`
  already does), keeping mutation/CI/check *execution* against `wt.path`.
  **Critically, `guardStillRed` reloads guard pairs directly via
  `loadGuardPairsFrom(wt.path)` (`root.ts:413`)** — move that guard-pair
  *selection* to the trusted root too, or it is a worktree bypass that a
  loader-only refactor leaves open (codex-flagged); the mutation *test run* stays in
  the worktree. Wire `contract.constitutionPaths` (main-root) into `gate.ts`'s
  constitution check so the protected-path list is worker-immune. **Fail closed on a
  configured-but-unreadable oracle** (Finding 5): distinguish "no file configured"
  (→ empty, fine) from "configured but absent/unparseable at the trusted root"
  (→ escalate, not `EMPTY_INVARIANTS`), per Principle 10. This touches the
  contract-zone contour → full TDD → codex `gpt-5.6-luna` critic → live-prove (a
  diff that edits its own INVARIANTS/GUARDS must not weaken the verdict). Records a
  gotcha for the "new zone no longer self-enforces in the same run" behavior change.
  **Scope: Phase 1 closes only *definition* tampering** — executable-input tampering
  stays open until Phase 2.
- **Phase 2 — executable-input integrity.** A mechanical **protected-paths fence**:
  a **trusted-root, worker-immutable** declaration of the oracle artifact class,
  checked against the worker's touched set independent of (and in addition to) the
  LLM-authored `forbidden_paths`, so an oracle file in a `file_set` escalates to an
  operator bless instead of being trusted. Its set MUST cover **executable oracle
  inputs** (test files, `success_command` scripts, workflow implementations), not
  just `INVARIANTS.md`/`GUARDS.md`, and must cover **git-ignored paths** the
  git-visible fence (`git status --porcelain`) does not see (SOUND #3 scope). Closes
  Finding 4 and the executable-input residual Phase 1 leaves open.
- **Phase 3 (folds into Profiles, s49+).** A profile carries its own protected
  oracle (hidden tests, critic-rubrics, release config) under this same model —
  **and the profile itself plus its protected-path declaration must live at a
  trusted, worker-unwritable root**, or the model becomes self-authorizing (a worker
  that can edit the profile can re-permit itself — codex-flagged). The Authority
  Model is the prerequisite the profiles thrust depends on (a profile over an
  unprotected oracle is theater — `architecture-review-external-2026-07.md`).
- **Metrics.** Once Phase 1–2 land, "oracle-tamper attempts caught" becomes a
  measurable gate property for the Evaluation Corpus.

## Related

- `wiki/authority-model-audit-2026-07.md` — the code audit that justifies this
  (Findings 1–4, with file:line evidence).
- `wiki/architecture-review-external-2026-07.md` — risk 5 (the seed) + risk 3.
- `PRINCIPLES.md` — invariants "the worker does not write its own oracle" and "the
  gate proves only formalized properties," hardened the same session.
- `003-roles-are-a-configurable-vendor-matrix.md` — the R1 mechanical boundary.
- `005-critic-is-a-correctness-gate-coverage-is-mechanical.md` — the orthogonal
  "what the critic judges" axis.
- `CURRENT-STATE.md` — Authority-Model → Profiles thrust ordering.
