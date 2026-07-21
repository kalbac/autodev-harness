# Authority Model Audit — worker write-scope vs the oracle (2026-07)

> **What this is.** An evidence-based audit (s48, 2026-07-21) of the external
> review's sharpest finding (`architecture-review-external-2026-07.md`, risk 5):
> *"the worker must never control its own oracle."* It traces what a worker can
> actually write into its diff versus the artifacts that decide whether that diff
> passes. It is the justification and seed for `adr/006` (capability-based
> Authority Model) and the `PRINCIPLES.md` hardening done the same session.
>
> This is an **Architecture Note** (rationale — *why*, with code evidence, not
> API). Findings are current as of commit `6b36c3f`; every claim cites the file
> and line it was read from. Where a finding is static-only (not live-reproduced),
> it says so.

## Method

Traced the enforcement path end-to-end: `conductor.ts` (the spine) →
`composition/root.ts` (the wiring that decides *which root* each oracle is read
from) → `gate/gate.ts` + `gate/invariants.ts` (the decision) → `util/fingerprint.ts`
(the dirty-file fence) → `worktree/worktree.ts` (what a worktree contains) →
`orchestrator/task-spec.ts` + `config/schema.ts` + `registry/scaffold.ts` (what
authors and protects the task contract). No enforcement code was changed.

## The threat model in one sentence

Once a worker can no longer self-declare DONE (Principles 1–2), the next
reward-hacking target is **the checks themselves** — weaken a test/assertion,
gut a contract zone, soften `ci.yml`, drop a protected path from the "human-only"
list. The question this audit answers: *for each oracle artifact, is it inside or
outside the worker's write authority, and is the boundary mechanical?*

## What is already SOUND (the audit is not all-holes)

These hold by construction today — do not "harden" them, they are already closed:

1. **The task contract / acceptance criteria are outside worker write authority.**
   `file_set`, `forbidden_paths`, `success_commands`, `contract_zones_touched`,
   `max_rounds` live on the `Task` in the blackboard (`.autodev/queue/**`). The
   conductor reads the task from the **main repo** (`FileBlackboardRepository(repoRoot, …)`,
   `root.ts:222`); the worker runs in a per-task **git worktree** (`worktree.create`,
   `worktree.ts:295`) that is a clean checkout of the branch's *tracked* tree.
   `.autodev/` is git-excluded (`scaffold.ts:255` `ensureGitExclude`), so it is
   **not materialized in the worktree** — the same fact the vendor/junction
   provisioning exists to work around. Therefore the worker cannot see, let alone
   rewrite, its own task spec. **The "edit acceptance criteria" half of risk 5 is
   structurally closed.**

2. **The gate configuration itself is outside worker write authority.** `cfg` is
   loaded once from the main repo's `.autodev/config.yaml` (`loadConfigWithRaw(repoRoot)`,
   `root.ts:208`). Everything that says *which* command is the check, *which* files
   are the invariants/guards, *which* workflows agent-ci may run, and the
   `dirtyFenceIgnore` prefixes — all live in that git-excluded file. The worker
   cannot re-point the gate.

3. **The dirty-file fence mechanically bounds writes to `file_set`.** After the
   worker runs, `workerTouched → strayChanged → forbiddenTouches`
   (`conductor.ts:395-397`, `fingerprint.ts`) escalate any touch outside
   `task.file_set` (minus `dirtyFenceIgnore`) or inside `task.forbidden_paths`,
   **before** the critic or gate. An oracle file that is **not** in the task's
   `file_set` is therefore protected. **Scope (codex-flagged):** the fence sees
   only *git-visible* touches — `workerTouched` diffs the paths from
   `git status --porcelain` (`root.ts:489`), which does **not** list files
   gitignored in the *target* repo. A path the target repo gitignores can be
   written without appearing in `touched`, so the fence's guarantee is "no
   git-visible write outside `file_set`," not "no write at all." (In practice the
   oracle files at issue are tracked, so they are git-visible; but a Phase-2
   protected-paths model must not rely on the fence alone for ignored paths.)

4. **Escalation *routing* reads the trusted root.** `zonesTouchedInDiff`
   (`root.ts:292`) loads INVARIANTS from **`repoRoot`** (`loadInvariantsFrom(repoRoot)`,
   `root.ts:293`). So the conductor's contract-risk routing (`conductor.ts:442`)
   cannot be fooled by a worker gutting a worktree copy of INVARIANTS.

5. **The orchestrator R1 boundary is intact.** The LLM orchestrator holds exactly
   `enqueue / trigger / read / report / recordRun` and no `run_gate`/`skip`/`reorder`
   (`buildOrchestratorCapabilities`, `root.ts:877`), per `adr/003`.

## The real holes (design-level; confirmed against code)

The gap is narrow and specific: it is about **oracle file *contents* that are
tracked in the repo tree** — tests, `INVARIANTS.md`/`GUARDS.md` when repo-rooted,
`.github/workflows/*`, guard recipe JSON, guard test files. These are read by the
**gate** from the **worktree**, protected only by the per-task fence.

### Finding 1 — the deciding gate reads every oracle artifact from the worktree

`gateDeps(wt)` (`root.ts:299-441`) binds the gate's oracle inputs to `wt.path`:

| Gate input | Bound to | Line |
|---|---|---|
| `loadInvariants` (contract zones + constitution path_globs) | `loadInvariantsFrom(wt.path)` | `root.ts:303` |
| `loadGuardPairs` (GUARDS.md + recipe JSON) | `loadGuardPairsFrom(wt.path)` | `root.ts:304` |
| `guardStillRed` (mutation-check) | `loadGuardPairsFrom(wt.path)` + `mutationCheck(repoRoot: wt.path)` | `root.ts:412-434` |
| `runAgentCi` (CI replay) | `runAgentCiWorkflows({ cwd: wt.path, … })` | `root.ts:390` |
| `runCheck` / `runSuccessCommand` | `runNative(…, { cwd: wt.path })` | `root.ts:311-319` |

This is the exact asymmetry: the conductor's *routing* trusts `repoRoot`
(SOUND #4), but the gate's *verdict* trusts the worktree — the very tree the
worker just wrote its diff into. If an oracle file is in the task's `file_set`,
the worker edits it freely (fence passes, SOUND #3 gives no protection), and the
gate reads the **weakened** version. Running the *code under test* against the
worktree is correct (that is the point); reading the *oracle definition* from the
worktree is the hole.

Two sub-classes must be kept distinct (codex-flagged, else the fix is misjudged):

- **Oracle *definitions* read from the worktree** — `INVARIANTS.md` (zones +
  constitution path list) and `GUARDS.md` + recipes. A worker edit changes *what
  the gate checks*. Fixable by reading definitions from the trusted root.
- **Executable oracle *inputs* run from the worktree** — the check/`success_command`
  target code, the guard *test files* run by the mutation-check, and the agent-ci
  *workflow implementation*. Here the CI **allowlist** (`gate.agentCi.workflows` —
  *which* workflows may run) is trusted (main-root `cfg`), but the workflow file
  *contents* and the test/script code they execute run from the worktree. A worker
  weakening a *test file* that a `success_command` runs is **not** closed by moving
  definitions to a trusted root — that file is executed, not read-as-definition. It
  is closed only by a protected-paths model (Phase 2) whose set includes every
  executable oracle input, not just `INVARIANTS.md`/`GUARDS.md`.

The only thing between a worker and its own oracle is the per-task fence, which is
(a) authored by the LLM orchestrator, (b) has no rule excluding oracle files, and
(c) is not a capability model. Nothing rejects a decompose that legitimately or
mistakenly places `.github/workflows/ci.yml` or `INVARIANTS.md` into a `file_set`
(e.g. an "update the CI workflow" or "add a contract zone" task).

### Finding 2 — the one worktree-immune protection field is dead

`contract.constitutionPaths` exists in the schema (`schema.ts:133`) — a
config-level (main-root, worker-inaccessible) list of human-only paths. A grep of
`src/**` finds **zero** enforcement uses: it is referenced only by the schema
default and the design docs. The gate's constitution check instead uses
`inv.constitution.path_globs` (`gate.ts:155`) read from the **worktree** INVARIANTS
— self-referential: the list of "files a worker must not touch" is itself in the
worker's write surface, so a diff can drop its own file from that list. The single
field that could have provided worktree-immune protection is orphaned.

### Finding 3 — the scaffold split makes zone/constitution checks inert (latent)

The New Project scaffold points the contract files **inside** `.autodev/`:
`contract: { invariantsFile: ".autodev/INVARIANTS.md", guardsFile: ".autodev/GUARDS.md" }`
(`scaffold.ts:138`). But `.autodev/` is git-excluded → **absent from the worktree**.
So `loadInvariantsFrom(wt.path)` resolves `wt.path/.autodev/INVARIANTS.md`, hits
`!existsSync` (`root.ts:262`), and returns `EMPTY_INVARIANTS` (zero zones, empty
constitution, `root.ts:82`). For a **scaffolded** project the gate's zone and
constitution coverage is therefore **vacuous**, while the conductor's main-root
`zonesTouchedInDiff` still sees the real file — enforcement diverges from routing.
The exclusion is **verified on the real target repo** (s48): in
`woodev-shipping-plugin-test` (on `autodev/main`), `.autodev/INVARIANTS.md` exists on
disk in the main tree but `git check-ignore` matches it against `.autodev/` in
`.git/info/exclude` and `git ls-files` shows it untracked — so a fresh
`git worktree add` (a checkout of the tracked tree) cannot contain it. The *vacuous
gate* consequence is latent only because that project declares no zones. Same root
cause as Finding 1 (oracle resolved relative to the worktree): here the worktree copy
is *absent* rather than *tamperable*, and neither is what you want.

### Finding 4 — there is no capability model / global protected-paths

Nowhere is there a config-level, worker-inaccessible declaration of "these paths
are the oracle; they are never in any worker's effective write scope." Protection
is entirely per-task `forbidden_paths` — LLM-authored, best-effort, glob-only
(`*`/`?`/`**`, no negation — `task-spec.ts` superRefine), and never *required* to
include oracle files. Rights are implied by role and per-task scope, not defined by
capability over a named class of artifacts. This is the "no unified, audited
Authority Model" the external review named.

### Finding 5 — a missing oracle fails OPEN, contra Principle 10

`loadInvariantsFrom` returns `EMPTY_INVARIANTS` (zero zones, empty constitution)
whenever the invariants file is absent (`root.ts:262`); `loadGuardPairsFrom` returns
`[]` likewise. This is *correct* for a project that genuinely declares no zones (most
projects), but it makes "the oracle could not be found" **indistinguishable** from
"there is no oracle" — both yield a vacuous, always-pass gate. So the mispath in
Finding 3 degrades silently instead of erroring, and even after the Phase-1 fix a
configured-but-unreadable oracle at the trusted root would still fail open. Principle
10 ("when unsure, fail toward the safe state") wants the opposite: *no file
configured* → empty (fine); *a file configured but unreadable/mispathed* → fail
closed (escalate), not empty. The Phase-1 fix must draw that distinction, not merely
change the root. (codex-flagged.)

## The shape of the fix (for `adr/006`)

The clean decomposition the findings point to:

- **Oracle *definitions*** (INVARIANTS/GUARDS/constitution path list / CI allowlist)
  → read from a **trusted root** the worker cannot write (main repo / git-excluded
  `.autodev`), never the worktree. Closes Findings 1 (for INVARIANTS/GUARDS), 2, 3.
- **Oracle *execution*** (run the check / success commands / agent-ci / mutation)
  → against the **worktree** (unchanged — that is the code under test). Trusted-root
  *definition* reads do **not** protect the *contents* of executed oracle inputs
  (test files, `success_command` scripts, workflow implementations); those stay
  worker-writable-if-in-`file_set` until the protected-paths model closes them.
- **Oracle *changes*** (a legitimate new zone, guard, or CI edit) → gated by an
  explicit **operator capability** ("bless"), not silently trusted because they
  rode in on a feature diff.
- **A capability-based protected-paths model** → a **trusted-root, worker-immutable**
  declaration of the oracle artifact class — covering executable oracle inputs
  (tests/scripts/workflow implementations) as well as definitions — mechanically
  excluded from every worker's effective write scope regardless of what the
  orchestrator puts in `file_set`, and covering ignored paths the git-visible fence
  misses (Finding 4 + SOUND #3 scope).

Enforcement is **not** built in s48 (operator scoped s48 to docs + audit). The
first enforcement increment — move the gate's oracle-definition reads to the
trusted root (including `guardStillRed`'s own guard-pair reload), wire
`constitutionPaths`, and fail closed on a configured-but-unreadable oracle
(Finding 5) — is a change to the contract-zone contour and gets its own TDD → codex
`gpt-5.6-luna` critic → live-prove cycle. It closes only *definition* tampering;
executable-input tampering is closed by the Phase-2 protected-paths model.

## Related

- `architecture-review-external-2026-07.md` — risk 5 (the seed) + risk 3.
- `adr/006-capability-based-authority-model.md` — the decision this justifies.
- `PRINCIPLES.md` — the "worker doesn't write its own oracle" + "gate proves only
  formalized properties" invariants hardened from this audit.
- `gotchas/conductor-wiring-deferred-limitations.md` — the original note that
  `zonesTouchedInDiff` reads main-root (SOUND #4).
- `CURRENT-STATE.md` — where the Authority-Model → Profiles thrust sits.
