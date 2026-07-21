# Spec — `adr/006` Phase 2: executable-input **protected paths**

> Session s50 · 2026-07-22 · implements the second enforcement increment of
> `adr/006-capability-based-authority-model.md`, closing audit **Finding 4** (no
> capability model / no global protected-paths declaration) and the
> **executable-input residual** Phase 1 deliberately left open
> (`wiki/authority-model-audit-2026-07.md` Finding 1, sub-class 2 + SOUND #3 scope).
> Principle 14 ("the worker does not write its own oracle") + Principle 10
> (fail toward the safe state).

## The rule this encodes

> **The oracle artifact class is declared at a trusted root and is mechanically
> excluded from every worker's effective write scope — regardless of what the
> orchestrator put in `file_set`. A worker touch of an oracle artifact escalates
> to an operator bless; it is never silently trusted.**

Phase 1 moved oracle *definition reads* to the trusted root, so no worker diff can
change **what the gate checks**. It did not protect the *contents of executable
oracle inputs* — the guard **test files** the mutation-check runs, the agent-ci
**workflow implementations**, and any operator-declared human-only path — because
those are executed from the worktree by design. Phase 2 protects them.

### What is NOT in scope

- Changing *where* anything is executed. Execution stays against `wt.path`
  (`adr/006` §2 read/execute). This phase adds a **fence**, not a relocation.
- Auto-applying a blessed oracle change. Bless remains the existing
  operator-reply path (A/B on the escalation); no new apply machinery.

## Why the existing mechanisms do not already cover this

| Mechanism | Why it is insufficient |
|---|---|
| Per-task `forbidden_paths` | LLM-authored, best-effort, never *required* to include oracle files (Finding 4). |
| Dirty-file fence (`strayChanged`) | Only catches oracle files **outside** `file_set`. An "update the CI workflow" / "add a guard" decompose puts them **inside** it, and the fence passes. |
| Gate constitution check (Phase 1) | Runs **after** a critic-clean verdict, is scoped to `git changedFiles(fileSet)` (git-visible only), and its set is a hand-written `constitutionPaths` that defaults to `[]` and is never derived from the actual oracle. |

All three are **git-visible only**: `git status --porcelain` and `git diff` do not
list paths the *target repo* gitignores, so a gitignored oracle file can be
rewritten with no trace at all (audit SOUND #3 scope).

## Design

### 1. New module `src/gate/oracle-paths.ts`

Pure + one trusted-root read. Two arms, because the two have genuinely different
guarantees and conflating them would overclaim:

```ts
export interface OracleSet {
  /** Glob-free worktree-relative paths. Fingerprinted DIRECTLY on the filesystem
   *  (pre/post worker), so a git-IGNORED oracle file is still covered. */
  literals: string[];
  /** Glob patterns. Matched against the git-visible touched set only. */
  globs: string[];
  /** entry -> human-readable reason it is protected (escalation evidence). */
  sources: Map<string, string>;
}

/** An entry is a glob iff it contains `*` or `?` (the matcher's only metachars). */
export function classifyOracleEntry(entry: string): "glob" | "literal";

/** Build the set from the TRUSTED ROOT. Fails CLOSED (throws) — see §4. */
export function resolveOracleSet(cfg, raw, repoRoot): Promise<OracleSet>;

/** Glob arm: which git-visible touched paths match a protected glob? */
export function oracleGlobTouches(touched: string[], globs: string[]): string[];
```

The literal arm reuses the existing pure primitives verbatim —
`snapshot(wt.path, set.literals)` before/after + `workerTouched(baseline, now)`.
`snapshot` already maps an absent file to `"<absent>"`, so **creating** a
previously-absent oracle file registers as drift (correct: planting an oracle
file in the worktree is a tamper attempt even when Phase 1 makes it ineffective
for definitions).

### 2. What the set contains

| Source | Entries | Condition |
|---|---|---|
| `contract.invariantsFile` | the configured path | always |
| `contract.guardsFile` | the configured path | always |
| trusted-root `GUARDS.md` rows | every row's `recipe` **and** `guard_test` | always; **all** rows, not only `mutation_verified` ones |
| `gate.agentCi.workflows` | each entry, **plus** `.github/workflows/<entry>` when the entry is a bare filename, **plus** the `.github/workflows/` directory prefix as a glob `.github/workflows/**` | only when `gate.agentCi.enabled` |
| `contract.constitutionPaths` | each entry, classified literal-or-glob | always |

Notes that are load-bearing:

- **All GUARDS rows, not just mutation-verified ones.** `loadGuardPairsFrom`
  filters to `isMutationVerified` because an unverified guard cannot *cover* a
  zone. But an unverified row's test file is still an oracle input the operator
  is working toward blessing — a worker must not edit it either. Use a separate
  `loadGuardRowsFrom` that parses the table and filters nothing.
- **`guard_test` may carry a selector suffix** (`tests/FooTest.php::testBar`);
  strip everything from the first `::` before using it as a path.
- **`recipe.file`** (the file a mutation recipe mutates) is the **code under
  test**, not the oracle — do **not** protect it. Protecting it would make every
  guarded zone's own source file unwritable, which is the opposite of the point.
- **`.github/workflows/**` only when agent-ci is enabled.** With agent-ci off,
  those files are not this harness's oracle, and protecting them would escalate
  ordinary CI-maintenance tasks in every project for no gain.

### 3. Conductor wiring (`src/conductor/conductor.ts`)

New injected dep, built once at the composition root against `repoRoot`:

```ts
resolveOracleSet: () => Promise<OracleSet>;
```

- **Pre-worker** (next to the existing baseline at `conductor.ts:288-290`):
  `const oracleSet = await resolveOracleSet();`
  `const oracleBaseline = snapshotFingerprints(wt.path, oracleSet.literals);`
- **Post-worker, BEFORE the existing stray/forbidden fence** (`:392`):

```ts
const oracleDrift = workerTouched(oracleBaseline, snapshotFingerprints(wt.path, oracleSet.literals));
const oracleGlobHits = oracleGlobTouches(touched, oracleSet.globs);
if (oracleDrift.length > 0 || oracleGlobHits.length > 0) -> escalate
```

**Order matters:** the oracle check runs *before* `strayChanged`/`forbiddenTouches`
so the operator gets the most specific reason ("the worker edited the oracle")
rather than the generic "out of scope" — an oracle file outside `file_set` would
otherwise be reported as a plain `dirty-file`.

Escalation: **reuse the existing `constitution` type** — semantically identical
("a human-only path changed"), already non-retryable in the overnight
supervisor's `RETRYABLE` set (`disagreement`/`uncertain`/`poison` only), and it
needs no new plumbing through the journal, the UI, or the reply path. Do **not**
add a new `EscalationType`.

Escalation body:

- reason: `worker touched a protected oracle path`
- what: `Task <id> modified <n> oracle artifact(s) -- the files that define what "pass" means.`
- decision: `Bless the oracle change explicitly, or reject it.`
- option A: `Bless: apply the oracle change yourself at the trusted root, then re-queue the task without it in file_set.`
- option B: `Reject the change.`
- cost of wrong: `A worker-authored oracle edit lets the next run be judged against a standard the worker chose.`
- evidence: one line per hit — `<path>  (<source reason>)  [fs-fingerprint|glob]`

### 4. Fail closed (Principle 10)

- `resolveOracleSet` inherits Phase 1's semantics for the contract files: a file
  **explicitly configured in the RAW config** (`isContractFileConfigured`) but
  absent/unreadable/escaping the trusted root → **throw**. Not configured +
  absent → contribute nothing.
- Every literal entry is realpath-contained against `wt.path` before it is
  fingerprinted (`util/path-contain.ts`, the Phase 1 util). An entry that escapes
  the worktree is **not silently dropped** — it throws.
- A throw from `resolveOracleSet` in the conductor must **escalate**, never
  commit and never crash the drain. Wrap the call and escalate `constitution`
  with the error text as evidence.

### 5. Accepted residuals (documented, not silently dropped)

- **Glob entries are git-visible only.** A `constitutionPaths` *glob* that
  matches a path the target repo gitignores is not seen. Every entry in the
  **derived** set (invariants, guards, recipes, guard tests, workflow files) is a
  **literal** and therefore fs-fingerprinted, so the concrete hole the audit named
  is closed. Closing it for arbitrary globs needs a bounded worktree walk
  (symlink/junction-safe per `[worktree/win-junction-follow]`) — deferred, and
  recorded in `FUTURE-BACKLOG.md`.
- **TOCTOU on the fingerprint read** — same accepted residual as Phase 1.
- **Restore-after-edit is not detected.** A worker that edits an oracle file and
  restores it byte-for-byte before finishing leaves no fingerprint drift. It also
  leaves no effect, so this is not a gap in the guarantee.

## Test plan (TDD — write these first)

`src/gate/oracle-paths.test.ts`
1. `classifyOracleEntry` — `*`/`?` → glob; plain path → literal; `**` → glob.
2. Derived set includes `invariantsFile`, `guardsFile`, every row's `recipe` and
   `guard_test` — including a row with `mutation_verified: no`.
3. `guard_test` with a `::selector` suffix contributes the bare path.
4. `recipe.file` is NOT in the set.
5. agent-ci disabled → no workflow entries; enabled → the entry, the
   `.github/workflows/<entry>` form, and the `.github/workflows/**` glob.
6. `constitutionPaths` entries land in the correct arm.
7. Configured-but-absent contract file → throws; not-configured + absent → no throw.
8. A literal entry escaping the worktree (`../x`, symlinked ancestor) → throws.
9. `oracleGlobTouches` normalizes both sides (parity with `forbiddenTouches`).

`src/conductor/conductor.test.ts` (extend)
10. Worker edits a guard **test file** that IS in `file_set` → escalates
    `constitution`, **before** the critic runs (assert the critic fake was never
    called).
11. Worker edits a **gitignored** oracle literal (invisible to `gitChangedPaths`)
    → still escalates (the fs-fingerprint arm).
12. Worker creates a previously-absent oracle literal → escalates.
13. Worker touches nothing oracle → unchanged behavior, reaches the critic.
14. An oracle file outside `file_set` reports `constitution`, **not** `dirty-file`.
15. `resolveOracleSet` throws → escalate, drain survives, no commit.

## Verification bar

1. `npm run typecheck` + full suite green.
2. `npm run build` + `npm run build:ui`.
3. **codex `gpt-5.6-luna` critic** (PIN the model; inline diff — codex cannot read
   the repo). Budget for ≥2 rounds; Phase 1 needed four, each finding a narrower
   leak in the previous fix. Re-critic every in-place fix.
4. **Live-prove** on `woodev-shipping-plugin-test`, operator-observable: enqueue a
   task whose `file_set` includes an oracle file, watch it escalate `constitution`
   with the oracle evidence, and confirm a control task still reaches the critic.

## Related

- `adr/006-capability-based-authority-model.md` — Phase 2 consequence bullet.
- `wiki/authority-model-audit-2026-07.md` — Findings 1 (sub-class 2), 4; SOUND #3 scope.
- `2026-07-21-adr006-phase1-definition-integrity.md` — the phase this builds on.
- `gotchas/oracle-definitions-trusted-root-behavior-changes.md` — Phase 1's behaviour surprises.
- `PRINCIPLES.md` — #14, #10.
