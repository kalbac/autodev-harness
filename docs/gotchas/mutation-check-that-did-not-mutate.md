# Gotcha — a mutation check that never mutated (and reported the guard as verified)

**Tag:** `[test/mutation-check-noop]` · **Found:** s63 (2026-07-29), verifying a regression
test written for an `adr/010` review finding.

## What happened

A regression test was written for a real defect (three fields describing one ruleset, one of
them left at a stale seed). Before trusting it, the fix line was removed and the suite re-run
— the standard mutation check this repo requires of any guard.

```bash
perl -0pi -e 's/    g\.ruleset = relativeEntry;\n//' src/profile/profile.ts
npx vitest run src/profile/profile.test.ts     # -> 120 passed
```

**120 passed.** Read naively, that says the new test does not guard the fix at all — a
vacuous test, to be rewritten.

It said nothing of the kind. The file is stored with **CRLF** line endings (this repo's
`git` config rewrites LF on checkout, and warns about it on every `git add`). The pattern
ended in `;\n`, the file contained `;\r\n`, so **nothing was removed**. The suite was green
because the code was unchanged — the mutation check had verified nothing whatsoever, and its
output was shaped exactly like a successful one.

Redone with a CRLF-aware removal that ASSERTS it changed the file, the guard behaved
correctly: `1 failed | 119 passed`, and exactly the intended test failed.

## Why this is dangerous rather than merely annoying

A mutation check exists to answer one question: *would this test notice if the behaviour
came back?* Both possible answers look different in the suite output — but a **no-op**
mutation produces the same output as "the test does not guard it", and the natural reaction
to that output is to weaken or rewrite a test that was in fact correct. The failure mode is
therefore not "you learn nothing", it is **"you are told the opposite of the truth, and act
on it."**

It also belongs to the shape this repository keeps paying for: a check whose passing
condition can be satisfied without the thing it checks ever happening. Siblings:
`[eval/corpus-lock-survives-a-killed-run]` (a pre-flight glob that could only ever print
"clean"), `[ops/codex-quota-exit-zero]` (a verdict grep that matched the echoed prompt), and
`[test/vacuous-assert]` (an assertion driven by both arms of an OR).

## The rule

**A mutation step must PROVE it mutated, before the suite is allowed to mean anything.**

```python
s = open(path, 'rb').read()
for cand in (b"    <line>;\r\n", b"    <line>;\n"):     # try both endings
    if cand in s:
        s = s.replace(cand, b"", 1); break
else:
    raise SystemExit("PATTERN NOT FOUND - mutation would be a no-op")
```

Concretely:

- Operate on **bytes** and try both `\r\n` and `\n`, or match on the line's content and
  rebuild the file line-wise — never assume `\n` on a repository that checks out CRLF.
- **Fail loudly when the pattern does not match.** A mutation script that silently does
  nothing is worse than one that crashes.
- **Verify the edit landed** (`grep -c` the removed text: expect 0) before running the
  suite, and verify it is restored afterwards (expect 1).
- Read the run's shape, not just its colour: an unchanged-looking failure count after a
  supposedly destructive edit is a reason to check the edit, not the test.

`sed -i` and `perl -0pi -e` on Windows checkouts are the two usual culprits, because both
happily match nothing and exit 0.

## Related

- `docs/gotchas/vacuous-assertions-and-or-arm-isolation.md` — `[test/vacuous-assert]`, the
  same family: green while proving nothing.
- `docs/gotchas/corpus-lock-survives-a-killed-run.md` — a pre-flight check that could only
  ever pass.
- `docs/gotchas/codex-quota-exit-zero-blocks-gate-and-corpus.md` — the s63 half of that
  entry, where a verdict poll matched the prompt's own instruction text.
- `docs/PRINCIPLES.md` #13 — evidence, not assertion; this is that principle applied to the
  evidence-gathering step itself.
