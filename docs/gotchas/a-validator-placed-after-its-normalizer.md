# `[gate/validator-after-normalizer]` — a check that runs after the step which erases what it checks

**Tag:** `[gate/validator-after-normalizer]`
**Found:** s64, review rounds 2→4, in `src/gate/finding-filter.ts` (#155).

## What happened

`relativePathAnchor` refuses a `//`-prefixed anchor that does not name both a server and a
share, because `//server` is not a root and treating it as one makes a path outside the
worktree resolve inside it (fail-open — the finding is then dropped as "a file the diff
never touched").

Round 3 introduced a single canonicalizer and put it **before** that refusal:

```ts
const dir = canonicalize(rawDir);   // "//server" -> "/server"
if (dir.startsWith("//")) { ... }   // never true again
```

`canonicalize("//server")` returns `/server` — a three-segment path has a root floor of 1,
so the empty second segment is consumed. The shape being refused no longer exists by the
time the refusal looks for it. **The validator stopped firing and nothing said so.**

## Why it survived a review round

Its test kept passing. The test used a UNC-shaped worktree (`//x`) while the resolved path
had become POSIX (`/x/a.php`), so containment failed for an unrelated reason and the
assertion (`unattributed: true`) still held. Green **for the wrong reason** — the assertion
was true, the mechanism under test was dead.

A mutation probe found it only because the probe was written to restore the *ordering*, not
to break the refusal: under that probe **both** the round-2 test and the new round-4 test
fail, which is what proved the round-2 test had been vacuous in between.

## Rules

- **A validator must run on the RAW input, before any normalizer that can change the shape
  it discriminates on.** Normalizing first is exactly how a check becomes decorative.
- When a refactor moves a normalization step, re-ask of every nearby guard: *does its input
  still contain the thing it looks for?* Passing tests do not answer this — a guard that
  never fires breaks no assertion.
- If a test asserts a fail-closed outcome (`unattributed`, `refused`, `escalate`), it can be
  satisfied by ANY of several mechanisms. Pin the mechanism with a probe that disables the
  specific one, not just the outcome. Sibling of `[test/vacuous-assert]` and
  `[test/mutation-check-noop]`: a passing condition met without the thing under test ever
  happening.

## Related

- `docs/gotchas/validated-one-string-used-another.md` — normalization mismatch; this is its
  ordering twin (same input, right check, wrong moment).
- `docs/gotchas/mutation-check-that-did-not-mutate.md` — the other way a check silently
  stops checking.
- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — what the refusal ultimately protects.
- `docs/adr/010-a-project-may-declare-the-ruleset-its-profile-gate-judges-by.md`
