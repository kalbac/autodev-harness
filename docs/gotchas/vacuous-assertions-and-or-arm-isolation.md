# `[test/vacuous-assert]` — assert the value, not an always-present label; isolate one OR-arm per test

**Tag:** `[test/vacuous-assert]`
**Found:** s08 (2026-07-01), Task 28 parity harness (both flagged by the codex GPT-5.5 gate, one on the first pass, one on the re-critic).

Two related ways a test can be GREEN while proving nothing. The parity harness hit both.

## 1. Passes for the wrong reason (unisolated OR-arm)

The conductor computes `contractRisk = task.touches_contract_zone || actualZones.length > 0
|| critic.broken_contracts.length > 0`. The original "contract-zone" scenario set BOTH
`touches_contract_zone: true` AND a non-empty `broken_contracts` — so the test would still
pass even if the frontmatter-flag arm were completely broken, because the critic-verdict
arm alone tripped the OR.

**Fix:** one test per arm. `2a`: flag only (`broken_contracts: []`, `zonesTouchedInDiff:
[]`) → proves the flag arm. `2b`: `broken_contracts` only (`touches_contract_zone: false`)
→ proves the verdict arm. Same trap in the dirty-fence: put the forbidden path INSIDE
`file_set` so the **stray** arm can't trip, isolating **forbidden**.

## 2. Vacuous label assertion

The dirty-file escalation evidence is `stray: ${stray.join(", ")}\nforbidden:
${forbidden.join(", ")}` — **both labels are ALWAYS emitted**, even when a list is empty.
So `expect(artifact).toContain("stray:")` is vacuous: it passes whether or not the stray
path is actually there.

**Fix:** assert the **value**, not the label — `toContain("stray: stray.ts")`,
`toContain("forbidden: secret.ts")` — and assert the other arm is empty
(`not.toContain("stray: secret.ts")`) to prove isolation.

## Lesson

For any branch reachable through an OR (or any always-present template field), a test
must (a) drive exactly ONE cause at a time, and (b) assert the specific evidence that
distinguishes the arm — never a label/marker the code emits unconditionally. This matters
double in a **parity harness**, whose whole job is to prove behavior, not merely reach it.

## Related
- `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` §2 — the conductor decision routing the harness pins.
- The re-critic discipline (`CLAUDE.md`): never self-certify a fix — the second codex pass caught the vacuous label assertions the first pass's fixes introduced.
