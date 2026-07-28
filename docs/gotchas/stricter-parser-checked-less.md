# A stricter parser checked LESS than the sloppy one it replaced

**Tag:** `[gate/stricter-parser-checked-less]` · Found s60 (28.07.2026), by the review gate, twice

## What happens

A check reads its input through a deliberately sloppy reader:

```ts
// diffAddedRemovedLines: any line starting with + or -, minus the two header shapes
if (/^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)) lines.push(l);
```

It is replaced by a strict, correct parser — one that tells a `+++ b/path` HEADER from an
added line whose content starts with `++` by the hunk's declared counts, which is the only
way to tell them apart. Every test passes, and the parser really is more correct.

And the check gets WEAKER, because the two readers disagree about what to *ignore*. The
sloppy reader takes anything that looks like a changed line, wherever it appears. The strict
one only takes what a hunk accounts for, and silently drops the rest:

```text
+test_pickup                      <- no diff --git, no file header, no hunk: DROPPED
```

```text
@@ -3,0 +4,1 @@
+ordinary documentation
+test_pickup                      <- one past the hunk's declared count: DROPPED,
                                     or worse, filed under the PREVIOUS file's path
```

In this repository both shapes reached `COMMIT` on a diff naming a protected contract value
— the exact thing the gate exists to catch. Neither was found by a test; both were found by
the review gate, one round apart, and both were blockers.

## Why it hides

The old reader's sloppiness *was* its coverage. Nobody wrote down "and it scans lines no
hunk accounts for", because that was an accident of a three-line regex, not a decision. So
the replacement was reviewed against what the new parser gets RIGHT, and the property that
quietly disappeared — *everything that looks like a change is looked at* — was never on the
list.

The second shape is nastier than the first: the line was not dropped but ATTRIBUTED, to
whatever file section it happened to follow. A hunk header states exactly how many lines it
covers; one past that count is not covered by the section's file header. Filing it there put
a contract value inside a declared documentation path, where a zone scoped elsewhere never
looks. **A guess in a leniency path is a hole.**

## What to do

- **Before replacing a parser, enumerate what the old one ACCEPTED that the new one drops**,
  not just what the new one gets right. That list is the regression surface.
- **Make it structural, not a patch per shape.** Two rounds found two shapes; a third was
  only a matter of time. The fix that closed the class is a comparison at the end of the
  walk: every line the old reader produces must appear in the new one's output, and whatever
  is missing is added back as unattributed — in scope for every check, exempt from nothing.
  Multiset, so duplicates are counted rather than deduplicated.
- **Then delete the shape-specific branches**, and measure that the guarantee alone keeps
  their tests green. Two mechanisms for one property is how the next reader learns the wrong
  rule.
- **Never attribute an input to the section it merely FOLLOWS.** Unattributed — checked
  everywhere, exempt from nothing — is the honest answer, and it is the answer the sloppy
  reader gave.
- This is the s59 lesson again: *when each round finds a narrower variant, remove the WAY to
  be wrong, not the instance.*

## Related

- `docs/gotchas/documenting-a-contract-value-is-not-touching-it.md` — the change that
  introduced this, and the eight other findings the same review produced.
- `docs/gotchas/validated-one-string-used-another.md` — the sibling shape: two readers of the
  same input disagreeing about normalization rather than about coverage.
- `docs/gotchas/boolean-whose-no-means-two-things.md` — "unreadable" encoded as an empty
  result, found in the same review.
- `docs/adr/008-path-globs-scope-the-contract-zone-scan.md` — the decision this hardened.
- `docs/PRINCIPLES.md` #10 (fail toward the safe state).
