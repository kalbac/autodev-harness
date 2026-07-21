# Spec — `adr/006` Phase 1: oracle **definition integrity**

> Session s49 · 2026-07-21 · implements the first enforcement increment of
> `adr/006-capability-based-authority-model.md`, justified by
> `wiki/authority-model-audit-2026-07.md` (Findings 1, 2, 3, 5).
> Principle 14 ("the worker does not write its own oracle") + Principle 10
> (fail toward the safe state).

## The rule this encodes

> **Oracle *definitions* are read from a trusted root; oracle *execution* runs
> against the worktree; a configured-but-unreadable oracle fails CLOSED.**

Trusted root = `repoRoot` (the main repo working tree — the worker only ever
writes a per-task git worktree, never the main tree). This is the same root
`zonesTouchedInDiff` already uses (`root.ts:293`), so the change makes the gate
*symmetric* with the conductor's routing.

Out of scope (Phase 2): the **contents of executable oracle inputs** — guard test
files, `success_command` scripts, agent-ci workflow implementations. Those are
run from the worktree by design and stay worker-writable-if-in-`file_set`.

## Changes

### 1. `src/config/config.ts` — raw-presence signal

Add, mirroring `isPlannerExplicitlyConfigured`:

```ts
export function isContractFileConfigured(
  raw: Record<string, unknown>,
  key: "invariantsFile" | "guardsFile",
): boolean
```

`true` iff `raw.contract` is a plain object and `raw.contract[key] !== undefined`.
Needed because `HarnessConfigSchema` always defaults `contract.invariantsFile` to
`"INVARIANTS.md"` — the parsed config cannot distinguish "operator configured an
oracle file" from "the schema filled in a default", and the fail-closed rule
hinges on exactly that distinction.

### 2. `src/composition/root.ts` — fail-closed loaders

`loadInvariantsFrom(root)` / `loadGuardPairsFrom(root)`: when the file is **absent**,

- **not** explicitly configured in the raw config → return `EMPTY_INVARIANTS` / `[]`
  (today's behavior — most projects declare no oracle and that is legitimate);
- explicitly configured → **throw** a typed, actionable error, e.g.
  `contract.invariantsFile is configured ('<rel>') but is not readable at the
  trusted root '<repoRoot>' -- the gate cannot judge against a missing oracle
  (adr/006 Phase 1)`.

A throw from a loader already means ESCALATE: `runGate` deliberately rejects on a
loader throw (`gate.ts:74-88`) and the conductor treats a gate throw as
`broken -- operator config`. No new escalation plumbing is needed.

An **unparseable** file already throws today (`parseInvariants`) — unchanged.

A guard row whose **recipe JSON** is missing/unparseable keeps its current
`continue` (skip): dropping a guard makes the zone read as *uncovered*, which
already escalates. That direction is fail-safe; do not change it.

### 3. `src/composition/root.ts` — `gateDeps(wt)` reads definitions from `repoRoot`

| Dep | Before | After |
|---|---|---|
| `loadInvariants` | `loadInvariantsFrom(wt.path)` | `loadInvariantsFrom(repoRoot)` |
| `loadGuardPairs` | `loadGuardPairsFrom(wt.path)` | `loadGuardPairsFrom(repoRoot)` |
| `guardStillRed` guard-pair **selection** (`root.ts:413`) | `loadGuardPairsFrom(wt.path)` | `loadGuardPairsFrom(repoRoot)` |
| `guardStillRed` mutation **run** (`mutationCheck` + `runGuardTest`) | `wt.path` | **`wt.path` (unchanged)** |
| `runCheck` / `runSuccessCommand` / `runAgentCi` | `wt.path` | **`wt.path` (unchanged)** |

The `guardStillRed` reload is load-bearing: a loader-only refactor leaves it as a
worktree bypass (codex-flagged in the audit).

### 4. Wire `contract.constitutionPaths` (Finding 2 — dead config)

`GateDeps` gains an optional trusted-root list:

```ts
/** Config-level (trusted-root, worker-inaccessible) human-only path globs.
 *  Unioned with the INVARIANTS constitution globs. Omit in unit tests. */
constitutionPaths?: string[];
```

`gate.ts` step 2 matches a changed file against **the union** of
`inv.constitution.path_globs` and `deps.constitutionPaths ?? []`, and
`constitution_touched` is **de-duplicated** (a file matching both lists appears
once). `root.ts` passes `cfg.contract.constitutionPaths`.

### 5. `src/registry/scaffold.ts` — write a `GUARDS.md` stub

The scaffold configures `guardsFile: .autodev/GUARDS.md` but never writes it
(`scaffold.ts:358-359` writes only `GOAL.md` + `INVARIANTS.md`). Under the new
fail-closed rule that combination escalates every task. Add a `GUARDS_STUB` (the
7-column header row + separator, no data rows) written with the same
`writeIfAbsent` discipline, and add it to the `written` list.

**Migration:** an already-scaffolded project (e.g. `woodev-shipping-plugin-test`)
has no `GUARDS.md` on disk — it must be created once, by hand or by re-running the
scaffold. The error message in §2 must name the missing path so this is
self-diagnosing.

## Behavior change to record as a gotcha

A task that **adds** a contract zone or guard no longer self-enforces it in the
same run: the gate judges the diff against the *previous, trusted* oracle, and the
new zone governs only after the operator blesses it into the main tree. This is
`adr/006` §4 — the removal of a reward-hacking surface, not a regression.

Second-order: for a **scaffolded** project the gate's zone/constitution checks stop
being vacuous (Finding 3 — `.autodev/INVARIANTS.md` is git-excluded, so the
worktree copy was always absent). Projects that declared zones and silently got a
vacuous gate will now actually enforce them.

## Tests (TDD — write first, watch fail)

`src/config/config.test.ts`
1. `isContractFileConfigured` true when `contract.invariantsFile` is set in raw; false for a bare `{}`; false for a non-object `contract`.

`src/gate/gate.test.ts`
2. `constitutionPaths` alone (empty INVARIANTS constitution) flags a changed file → `ESCALATE` + `constitution_touched`.
3. A file matching BOTH the INVARIANTS glob and `constitutionPaths` appears **once** in `constitution_touched`.
4. `constitutionPaths` omitted → identical verdict to today (no regression).

`src/composition/root.test.ts` (or a focused loader test)
5. Definition reads come from the trusted root: with INVARIANTS present at `repoRoot` declaring a zone and an INVARIANTS at the worktree declaring **none**, the gate sees the zone (assert on the produced verdict/zone list, not on a spy).
6. `guardStillRed` selects its pair from the trusted root's `GUARDS.md`, not the worktree's.
7. Fail-closed: `contract.invariantsFile` configured + absent at the trusted root → the loader rejects; error message names the path.
8. Not configured + absent → resolves to zero zones (no throw).
9. Same pair for `guardsFile`.

`src/registry/scaffold.test.ts`
10. Scaffold writes `.autodev/GUARDS.md`, it parses to zero rows, and the scaffolded config loads.

Avoid the vacuous-assert traps in `[test/vacuous-assert]`: one cause per test,
assert the specific value (the zone id / the path in the message), never just a label.

## Verification

- `npm run typecheck` + full `npm test` green.
- codex `gpt-5.6-luna` critic on the diff (pin the model; embed the diff inline).
- **Live-prove**, operator-observable: on `woodev-shipping-plugin-test`, create
  `.autodev/GUARDS.md`, add a real contract zone to the main-root
  `.autodev/INVARIANTS.md`, and run a task whose `file_set` includes a worktree
  copy of an INVARIANTS file — the verdict must still reflect the **trusted-root**
  zone. Also prove the fail-closed path (rename `GUARDS.md` → task escalates with
  the actionable reason).

## Related

- `adr/006-capability-based-authority-model.md` — the decision (Phase 1 bullet).
- `wiki/authority-model-audit-2026-07.md` — Findings 1/2/3/5 with file:line evidence.
- `PRINCIPLES.md` — #14 (worker doesn't write its own oracle), #10 (fail safe).
- `gotchas/gate-reads-oracle-definitions-from-worktree.md` — the gotcha this closes.
