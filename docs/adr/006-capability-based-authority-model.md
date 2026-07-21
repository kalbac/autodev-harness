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

- **Phase 1 — definition integrity. ✅ SHIPPED s49 (2026-07-21).** Built, four codex
  `gpt-5.6-luna` review rounds, live-proven on `woodev-shipping-plugin-test` (a zone
  declared only at the trusted root escalated a real task whose worktree contained no
  INVARIANTS file at all). Two things the plan below did not anticipate: (a) "read it
  from `repoRoot`" is not a guarantee until the path is **realpath-contained** — a
  lexical `join` clamps neither `..` nor an intermediate symlinked ancestor
  (`src/util/path-contain.ts`); (b) fail-closed alone would have bricked every
  already-scaffolded project, because the scaffold always configured `guardsFile` but
  never wrote it — hence `ensureContractStubs`, which heals `GUARDS.md` only and never
  `INVARIANTS.md` (missing guards escalate; missing invariants would pass vacuously).
  Behaviour changes recorded in `gotchas/oracle-definitions-trusted-root-behavior-changes.md`.
  The original plan, for the record:
  Move the gate's
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
- **Phase 2 — executable-input integrity. ✅ SHIPPED s50 (2026-07-22).** Built as
  `src/gate/oracle-paths.ts` + a conductor fence that runs **before** the critic (so an
  oracle touch costs no critic tokens) and **before** the stray/forbidden fence (so the
  operator gets "the worker edited the oracle", not a generic "out of scope"). Escalates
  the existing `constitution` type — semantically identical and already non-retryable in
  the overnight supervisor, so no new plumbing. The set is derived from the trusted root:
  `contract.invariantsFile`/`guardsFile`, **every** GUARDS.md row's `recipe` and
  `guard_test` (all rows, not only mutation-verified ones — an unverified row's test file
  is still an oracle input), the `gate.agentCi.workflows` files plus `.github/workflows/**`
  when agent-ci is enabled, and `contract.constitutionPaths`. `recipe.file` is
  deliberately NOT protected: it is the code under test, and protecting it would make
  every guarded zone's own source unwritable.

  Two arms with deliberately different guarantees: **literals** are fingerprinted
  directly on the filesystem (pre/post worker), which is what covers a **git-ignored**
  oracle file the porcelain fence cannot see (SOUND #3 scope) — every *derived* entry is
  a literal, so the concrete hole the audit named is closed; **globs** are matched only
  against the git-visible touched set, leaving a gitignored path matching *only* an
  operator-declared glob as a documented residual (closing it needs a bounded,
  junction-safe worktree walk — `FUTURE-BACKLOG.md`).

  **Six** codex `gpt-5.6-luna` rounds, each closing a narrower fail-open inside the
  previous round's own fix — the same convergence shape as Phase 1's four, and worth
  budgeting for on anything touching this contour. The through-line was one invariant
  that took five rounds to state properly: *every entry is worktree-relative,
  `/`-separated, and names a real regular file*. See the gotcha for the specific leaks.
  Live-proven end-to-end on `woodev-shipping-plugin-test`: a task whose `file_set`
  contained `.github/workflows/ci.yml` escalated `constitution` with oracle evidence and
  never reached the critic (no `critic-verdict.json` written), while a control task
  touching a non-oracle file passed the fence, the critic and the gate and committed
  (`dd79ef4`). Closes Finding 4 and the executable-input residual Phase 1 left open.

  **Still open after Phase 2:** `success_command` scripts and the `checkCommand` are
  commands, not declared paths, so their *implementations* are only protected when the
  operator lists them in `constitutionPaths`. Deriving a path set from a command string
  is not reliably decidable; naming the gap is honest, closing it is not attempted here.

  The original plan, for the record: a mechanical **protected-paths fence**:
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
