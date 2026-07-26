# A boolean whose "no" means two things — the defect shape that appeared four times in one review cycle

**Tag:** `[logic/ambiguous-false]` · Found s57 (2026-07-26, codex R3–R6 on #126)

## What happens

A predicate answers `false` for two different reasons — "the answer is no" and "I could not
determine the answer" — and a caller reads that single `false` as the first. Whether that is
safe depends entirely on the caller's **polarity**, which is invisible at the call site.

Four instances in ONE seven-round review of a single ~200-line module, three of them inside a
fix written to remove the previous one:

1. **`realpathContains(repoRoot, artifactsRoot)`** returns `false` for "outside the root" AND
   for "could not resolve" (EACCES, a dangling link, a path that does not exist). The caller
   read `false` as "outside the repo, therefore safe to write there".
2. **The fix for (1)** asked `git check-ignore` and discriminated its exit codes correctly —
   then asked `git ls-files --error-unmatch` right beside it and folded **every** non-zero
   into "nothing tracked here". Exit 1 means that; exit 128 means *fatal*. A corrupt index or
   a missing `.git` therefore AUTHORIZED writing inside the work tree.
3. **The fix for (2)** allowed `exit 0` with an empty listing. Measured: real git never emits
   that pair (a directory with tracked files exits 0 *with paths*; untracked, absent, and
   empty directories all exit 1). A combination the code cannot explain is not a pass.
4. **`canonicalPathContains("/", x)`** returns `false` because the helper deliberately fails
   **closed** for an all-separator root — correct for its original callers, where refusing is
   the safe answer. This caller had the **opposite polarity**: `false` meant "outside the
   repo, go ahead". A repo rooted at `/` skipped every safety check.

## Why it kept coming back

Because the fix was always written at the *instance* — the specific function, the specific
exit code — while the shape lives one level up. Two distinct rules, and (4) is the one that is
easy to miss:

- **Never let one boolean carry "no" and "I don't know".** Return them separately, or throw
  for the second. A `try { return await realpath(p) } catch { return null }` helper is fine
  *if* every caller treats `null` as a refusal; the moment one caller treats it as data, it is
  a fail-open waiting for the right input.
- **A shared predicate's failure DIRECTION is part of its contract, and it was chosen for
  someone else's polarity.** `canonicalPathContains` is right to answer `false` for a
  degenerate root when `false` means "refuse". Reusing it where `false` means "proceed"
  inverts a deliberate fail-closed into a fail-open, without changing a line of the helper.
  Before reusing a predicate across a polarity boundary, ask: *what does its `false` mean for
  MY branch, and is that what its author chose it to mean?*

This is the sibling of [[validated-one-string-used-another]], which is about a value CHECKED
in one normalization and USED in another. Same family — the check and the use disagree — but
the disagreement here is about the MEANING of the answer, not the shape of the input, so
grepping for normalization mismatches will not find it.

## What to do

- Make the tri-state explicit: `"yes" | "no" | "unknown"`, or a nullable result the type system
  forces every caller to handle. Do not encode it as a boolean and a comment.
- When shelling out, **discriminate every exit code you rely on, and MEASURE the mapping**
  rather than assuming it. Instance (2) cost a round because the codes were assumed; the fix
  measured them (`0` matched with paths / `1` no match / `128` fatal) and named the measurement
  in a comment so the next reader does not have to re-derive it.
- Refuse the combinations you cannot explain, and say so in the message. "I do not understand
  this answer" is a refusal, not a pass (Principle 10).
- Ask the critic for this shape **by name** — the same tactic that works for
  [[validated-one-string-used-another]]. It found instances 2–4 only because each round was
  explicitly told to hunt the previous round's shape.

## Related

- `docs/gotchas/validated-one-string-used-another.md` — the sibling shape (normalization, not
  meaning); the most recurring defect in this repo's gate code.
- `docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md` — "never fold 'could not
  determine' into 'no'", the errno-allowlist instance that established the rule.
- `docs/gotchas/codex-quota-exit-zero-blocks-gate-and-corpus.md` — the same class in our own
  PROCESS: an exit code that means two things, believed to mean the good one.
- `docs/PRINCIPLES.md` #10 (when unsure, fail toward the safe state) — this gotcha is what
  #10 looks like when the code cannot tell that it is unsure.
