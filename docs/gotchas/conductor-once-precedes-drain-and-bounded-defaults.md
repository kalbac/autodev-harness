# `[conductor/once-precedes-drain]` — `once` short-circuits `drain`, and a "bounded default" guarded by `??` is not bounded

Found s46 (overnight presence toggle), during the wiring of the overnight
supervisor into the daemon's run paths.

## 1. `once` is evaluated BEFORE `drain`

`conductor.run` breaks on `once` at `conductor.ts:705`, ten lines before it ever
looks at `drain` (`conductor.ts:719`):

```ts
iterations++;
if (opts?.once || (opts?.maxIterations !== undefined && iterations >= opts.maxIterations)) {
  break;                                     // :705 — wins
}
// ...
if (opts?.drain && (res.claimedTaskId === null || res.rateLimited)) {
  break;                                     // :719 — never reached when once:true
}
```

So `{once: true, drain: true}` runs **exactly one iteration**, silently. The two
flags read like independent bounds; they are not. `once` is absolute.

This matters the moment run options are *inherited* rather than authored. The
overnight supervisor wants a queue-wide drain, but it is reached through the same
`runOrSupervise` entry that a `once: true` CLI invocation uses — inheriting that
`once` would have collapsed every overnight drain into a single task, and nothing
would have failed loudly.

**Fix shape:** strip the flag at the boundary that changes the run's meaning, not
by reordering the conductor. `supervisorRunOpts()` (`composition/root.ts`) drops
`once` and preserves every other bound. Reordering `conductor.ts` would have
changed the semantics of every existing caller to fix one of them.

## 2. A bounded default guarded by `??` (or by key count) is not bounded

The orchestrator's `trigger` capability carried this, with a comment promising
"no caller can accidentally launch an unbounded run through this handle":

```ts
trigger: (opts) => runEntry(opts ?? { once: true }),
```

`??` guards only `undefined`. `trigger({})` sails past it, and `{}` means
run-until-session-cap. The comment was false for as long as it existed.

The obvious repair is also wrong:

```ts
opts && Object.keys(opts).length > 0 ? opts : { once: true }   // still broken
```

That only rules out a *literally* empty object. `{once: false, drain: false}` has
two keys, is type-valid, and is just as unbounded. Key presence is not a bound.

**Fix shape:** an explicit allow-list over the bounding fields, testing the
**value**:

```ts
export function hasBound(opts: ConductorRunOptions | undefined): boolean {
  if (!opts) return false;
  return opts.once === true || opts.drain === true || Number.isFinite(opts.maxIterations);
}
```

Note `Number.isFinite`, not `typeof === "number"`. The conductor bounds a run with
`iterations >= opts.maxIterations`, and that comparison is **always false for
`NaN`** and **never true for `Infinity`** — both type-check as `number` and both
run unbounded. `0` and negatives, by contrast, are genuinely bounded (the
comparison holds on the first iteration), so rejecting them would be wrong. The
correct predicate follows from how the value is *consumed*, not from its type.

`exactOptionalPropertyTypes` closes the `{maxIterations: undefined}` shape for
typed callers, but the allow-list must not depend on that — an untyped or
JSON-decoded caller has no such protection.

## Generalisation

Both halves are the same failure: **a guard written against the shape the author
imagined, not against the values the type actually permits.** When the guarded
thing is spend (here: an unattended run loop), write the guard as an allow-list of
known-safe values and let everything else fall to the safe side.

Both were caught by the codex gate, not by tests or typecheck. It took **four**
codex rounds to converge, and rounds 2, 3 and 4 were all findings on the *fix for
the previous round's finding* — `??` → key-count → `typeof number` → `isFinite`,
each repair leaking a narrower version of the same hole. Self-certifying at any
round would have shipped an unbounded unattended run.

## Related

- [[budget-saga-order-on-file-blackboard]] — same fail-direction discipline (pick
  the ordering that spends LESS when unattended), also 4 codex rounds to converge
- [[codex-exec-windows-sandbox-review-inline-diff]] — how the gate that caught
  this has to be invoked on Windows
- [[gpt-5-6-critic-variants-sol-blocks-terra-misses]] — why the critic model is
  pinned to `luna`
