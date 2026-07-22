# `[critic/validated-one-string-used-another]`

> The single most recurring defect shape in this repo's gate code: a value is
> **checked in one form and then used in another**. Every instance is invisible to
> tests written from the same assumption, and every instance fails silently.
> Named after s51, where it surfaced in **five separate critic rounds** of one
> ten-round review — each time in a narrower form, inside the previous fix.

## The shape

Some value (a path, a token, a key) passes a check in one normalization, and a
*different* normalization is what actually gets used downstream. The check
succeeds, so nothing looks wrong; the use misses, so the result is silently empty
or wrong.

## Every instance found so far

| Where | Checked as | Used as | What was lost |
|---|---|---|---|
| `adr/006` Phase 2 (s50) | `resolve`d oracle path at the trusted root | `join`ed against the worktree | An absolute entry became a nonsense path — protected nothing, both fingerprints `<absent>` |
| Profiles v1 (s51) | `--standard=<dir>/x` probed as the suffix from `<dir>` on | the WHOLE token shipped to the runner | `prefix{profile}/x` validated fine and ran malformed |
| Line-scoping R2 | path contained case-**insensitively** | `Map.get(path)` case-**sensitively** | `C:\REPO\SRC\FOO.PHP` passed containment, missed key `src/Foo.php` — finding dropped |
| Line-scoping R6 | the same fold, one key space over | `newFiles.has(path)` exact-case | A new binary/empty file's file-level finding dropped |
| Line-scoping R9 | first `line` attribute | last `line` attribute (last-one-wins) | A finding on line 1 relocated to line 999 and filtered out |

## Why tests do not catch it

The test author holds ONE mental model of the value's shape and writes both the
input and the expectation from it. Both sides of the comparison agree, so the test
passes — while production supplies a value in the *other* shape. This is the same
root cause as `agent-ci-ndjson-keyed-by-event-not-type.md` (a parser green against
a guessed format) and `llm-retitle-breaks-task-level-dedup.md` (matched fixtures
hiding LLM drift).

## What actually prevents it

1. **State the normal form ONCE, at the entry point, and enforce it there.** Not
   at each use site — that is how the narrower instances keep appearing. If a
   module has an invariant ("worktree-relative, `/`-separated, a real regular
   file"), one function establishes it and everything downstream may assume it.
2. **The check and the use must share the same function.** If containment folds
   case, the lookup must fold case *through the same code*, not through a
   coincidentally-similar expression.
3. **When the input cannot answer the question, say so.** Two keys folding to one
   value is genuine ambiguity: neither picking one nor unioning them is right (s51
   tried both — the first dropped findings, the second mis-attributed them). Mark
   it and keep it.
4. **Ask the critic for it by name.** The reviews that found these were the ones
   whose brief said "hunt for a value validated in one form and used in another".

## Related

- `gotchas/oracle-protected-paths-must-be-worktree-relative.md` — the s50 instance,
  where five of six rounds restated the same invariant in different places.
- `gotchas/profile-gates-must-be-diff-scoped.md` — the line-scoping work these came from.
- `gotchas/agent-ci-ndjson-keyed-by-event-not-type.md` — the same blindness, applied
  to an external wire format.
