# The machine gate reads oracle DEFINITIONS from the worktree, not a trusted root

**Tag:** `[gate/oracle-read-from-worktree]`
**Found:** s48 (2026-07-21), Authority Model audit. Full analysis + evidence:
`docs/wiki/authority-model-audit-2026-07.md`. Decision: `docs/adr/006`.

## The trap

Do NOT assume the deterministic gate is worktree-immune. `gateDeps(wt)`
(`composition/root.ts:299-441`) binds **every** oracle input to the per-task
worktree (`wt.path`): `loadInvariants`, `loadGuardPairs`, `guardStillRed`'s own
guard-pair reload, `runCheck`, `runSuccessCommand`, `runAgentCi`. So the gate reads
INVARIANTS.md / GUARDS.md **from the tree the worker just wrote its diff into**.

This is asymmetric with the conductor's contract-risk *routing*, which reads INVARIANTS
from the trusted **main root** (`zonesTouchedInDiff → loadInvariantsFrom(repoRoot)`,
`root.ts:293`). Routing is worker-immune; the gate verdict is not.

Two consequences, both non-obvious:

1. **Tamperable:** if a tracked oracle file (INVARIANTS.md/GUARDS.md at repo root, a
   guard test, `.github/workflows/*`) is in a task's `file_set`, the worker can
   weaken it in the same diff and the gate trusts the weakened copy. The only barrier
   is the per-task dirty-file fence, which is LLM-authored and never required to
   exclude oracle files.
2. **Absent → vacuous (latent):** the New Project scaffold points
   `contract.invariantsFile` at `.autodev/INVARIANTS.md` (`scaffold.ts:138`), and
   `.autodev/` is git-excluded → **not in the worktree**. So `loadInvariantsFrom(wt.path)`
   hits `!existsSync` → returns `EMPTY_INVARIANTS` (`root.ts:82,262`) → the gate's zone
   + constitution checks are **silently vacuous** for scaffolded projects. Verified
   live s48 (`.autodev/INVARIANTS.md` is `git check-ignore`-matched + untracked in
   `woodev-shipping-plugin-test`). Latent only because that project declares no zones.

Also: `contract.constitutionPaths` (a trusted main-root config field) is **dead** —
declared in `schema.ts:133`, used nowhere; the constitution check reads the worktree
INVARIANTS' `path_globs` instead. And a missing oracle **fails open** (`EMPTY_INVARIANTS`,
not an escalation), contra Principle 10.

## The rule (until `adr/006` Phase 1 lands)

When touching the gate: oracle *definitions* should come from a trusted root, oracle
*execution* from the worktree, and a configured-but-unreadable oracle must fail
*closed*. A change that only moves `deps.loadGuardPairs` is incomplete — `guardStillRed`
reloads guard pairs from `wt.path` directly and would remain a bypass. Note the behavior
change the fix introduces: a task that *adds* a contract zone no longer self-enforces
that zone in the same run (it governs after an operator bless).

## Related

- `docs/wiki/authority-model-audit-2026-07.md` — full audit (Findings 1–5, evidence).
- `docs/adr/006-capability-based-authority-model.md` — the capability model + phased fix.
- `docs/gotchas/conductor-wiring-deferred-limitations.md` — the sibling note that
  `zonesTouchedInDiff` reads main-root.
