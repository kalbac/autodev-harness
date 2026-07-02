# `[config/zod-strict]` — zod strips unknown keys → a stale config silently reverts to defaults

**Tag:** `[config/zod-strict]`
**Discovered:** s11 (2026-07-02), during the R3 `worker:`/`critic:` → `roles:` config hard-cut.

## The trap

A `z.object({...})` schema **strips unknown keys by default** (does NOT error on them).
So when you rename or remove a top-level config block, an OLD config file using the removed
key **loads successfully** — the stale block is silently dropped and every field it set
reverts to the schema default. No error, no warning.

Concretely: after `worker:`/`critic:` were replaced by `roles:`, a pre-R3 config like
```yaml
worker: { ladder: [sonnet] }
critic: { retryMax: 3 }
```
parsed clean but ran with `roles.worker.ladder = [opus,sonnet,haiku]` and
`roles.critic.retryMax = 1` — a silent behavior change on a real, in-use file
(this was exactly the aurora `.autodev/config.yaml` situation). The independent codex
critic caught it (High) before merge.

## The fix

Put `.strict()` on the ROOT config schema so unknown top-level keys fail LOUD:
```ts
export const HarnessConfigSchema = z.object({ ... }).strict();
```
Then migrate every existing config file (repo fixtures AND real on-disk ones like aurora's)
to the new shape in the same change. A stale key now throws a clear
`Unrecognized key(s) in object: 'worker'` at load instead of silently reverting.

## Broader rule

Any hard-cut of a config shape (rename/remove/move a block) MUST either (a) make the root
schema `.strict()` so old files fail loud, or (b) ship an explicit back-compat/migration
path. Silent-strip + revert-to-defaults is the worst outcome: the daemon runs with settings
the operator did not choose and cannot see. This is a fail-loud-over-silent-default instance
of the same discipline as the fail-closed gotchas.

## Related
- `[ts/zod]` (`zod-optional-exactoptional-derive-types.md`) — the other zod gotcha (derive types via `z.infer`).
- adr/003 R3 — the role-registry config generalization where this surfaced.
