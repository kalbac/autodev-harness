# A contract zone's `path_globs` was an OR-arm, so documenting a contract value counted as changing it

**Tag:** `[gate/zone-globs-were-not-a-scope]` · Found s59 (27.07.2026), fixed s60 (27.07.2026)

## What happens

A contract zone declares three things: `path_globs` (where the contract lives),
`grep_patterns` and `exact_strings` (what its values look like). `zoneTouched` treated the
first as **one arm of an OR**: when no changed file matched the globs, it scanned the value
strings against every line of the diff anyway — whatever file that line came from.

Measured in the s59 corpus run, on `good-docs-overview-note`, whose task was to document
that the plugin registers `test_pickup` and `test_courier`:

```
decision: ESCALATE
reasons:
  zone 'shipping-method-ids': contract value 'test_pickup' touched but NO
  mutation-verified guard covers THAT value (needs guard)
changed_files: ["docs/OVERVIEW.md"]
```

The zone declares `path_globs: ["includes/class-test-shipping-method-*.php"]`. The only
changed file is a Markdown document containing no code. The gate demanded a
mutation-verified guard for a sentence of prose.

## Why it hid, and why it was the LAST thing standing

It hid because it needs two conditions at once: a zone that declares `path_globs`, and a
change that names a contract value from *outside* them. Every live proof before the corpus
either touched the zone's own files (so the OR-arm's first branch fired, correctly) or named
no contract value at all.

It was invisible for a second reason, and that one is the transferable part: **a change has
to survive the critic before the machine gate is even reached.** In s58 this same case died
at the critic (`uncertain` @0.84 — the critic could not verify a claim about code the diff
does not touch, `adr/007`). Fixing the critic in s59 is what let the case reach the gate for
the first time, where a second, independent defect of the same shape was waiting. The metric
did not move (`first_pass_commit_rate` 50% → 50%) and the naive reading was "adr/007 did not
work"; the correct reading was "adr/007 worked, and uncovered the next layer".

**A defect behind a defect reports as no progress.** When a fix is proven at its own layer
(here: `clean` @0.99, measured on a hashed prompt) and the end-to-end number does not move,
the next question is which layer the failure moved to — not whether the fix worked.

## What to do

- **A declared scope is a scope.** If an oracle field says *where* something lives, do not
  also use it as one arm of a boolean OR. Ask what the field claims to mean, and make the
  code mean that (`adr/008`, option (a) of #140).
- Scope the boolean and the enumeration **together**. `zoneTouched` (is it touched?) and
  `zoneTouchedStrings` (which values?) must read the SAME scoped lines; scoping one and not
  the other reports contract values from a file the zone never covered.
- **Attributing diff lines to files requires the hunk headers, not the line prefixes.** An
  added line whose content starts with `++` is byte-identical on the wire to a `+++ b/path`
  header; only the declared line counts settle it. Reuse `gate/diff-lines.ts`'s walker —
  never write a second parser for the same question
  (`validated-one-string-used-another.md`).
- **A diff hunk belongs to TWO files, and scoping must use both.** The `-` lines are the
  pre-image file's, the `+` lines the post-image file's, and for a rename those differ. The
  first implementation attributed everything to the post-image path, and the review gate
  broke it twice with one input: `git mv includes/class-x.php docs/x.md` carried a zone's
  contract values out of the zone that governs them (and a doc declaration then dropped the
  removals), while a deletion (`+++ /dev/null`) lost the only real path it had. In scope if
  ANY path matches; exempt only if EVERY path is declared — for a leniency rule, always the
  reading that grants less.
- **"Which files did this diff touch" is NOT answerable from the lines it changed.** A
  100%-similarity rename, a mode-only change and a binary change each name a file and emit
  no `+`/`-` line at all, so a touched-file list derived from attributed lines is empty for
  exactly those — and then the conductor calls a zone clean that the gate, reading
  `git diff --name-only`, calls touched. Read the file question off the diff HEADERS
  (`diffNamedPaths`), including `rename from`/`rename to` and a `diff --git` line whose two
  sides are equal. Three review rounds on `adr/008` failed on this one invariant, from three
  different ends: **if two layers answer the same question, derive both answers from the same
  place, and test the shapes that carry no content at all.**
- **`git diff --name-only` reports POST-IMAGE paths**, so it is not by itself "the files this
  diff touched": a 100%-similarity `git mv` OUT of a contract zone names only the destination,
  and with no hunk body there are no lines to scan either — so the gate misses a change that
  physically moved a contract value out of the zone that governs it. Union git's list with the
  paths the diff itself names.
- **"I could not read the input" must never be encoded as an empty result.** Returning `[]`
  for an unparseable diff reads downstream as "this diff touches no files", which silently
  disables the path arm of the check while the other layer still has git's list. Return a
  distinguishable "unreadable" and make every caller state its own fallback — this is
  `boolean-whose-no-means-two-things.md` (`[logic/ambiguous-false]`) in list form.
- **A test whose expected result matches the OLD, buggy behaviour proves nothing.** The
  fallback test here asserted `ESCALATE`, which the pre-`adr/008` code produced on the same
  input; only a paired control — the same content in a WELL-FORMED diff, which must NOT
  escalate — shows the fallback ran at all. Settle it by measurement: revert the fix and watch
  the test go red.
- **A rename’s source is touched; a COPY’s source is not.** Both name two paths, and the
  temptation is one rule for both. A rename removes the file from its old path (the contract
  value physically left the zone); a copy leaves the source byte-identical, so reporting it
  demands a mutation-verified guard for a file nobody edited — the same complaint #140 was
  filed for. Read `copy from`/`copy to` and suppress the pre-image side for that section only.
- **A stricter parser can be a WEAKER check.** The strict walker ignores whatever is neither
  header nor hunk body; the flat reader it replaced took any line starting with + or -. So a
  headerless content line, and a line past a hunk’s declared count, were scanned BEFORE the
  upgrade and dropped after it — the gate committing a diff that names a contract value. Two
  separate review findings, one of them a blocker. When you replace a parser, enumerate what
  the old one accepted that the new one drops, and give every dropped line the old answer.
- **Do not attribute a line to the section it merely FOLLOWS.** A hunk header states how many
  lines it covers; one past that count is not covered by the last file header. Filing it
  under the last-seen path let an extra line after a docs hunk carry a contract value into a
  declared documentation file, invisible to a zone scoped elsewhere. Unattributed — in scope
  for every zone, exempt from nothing — is the only honest answer.
- Every narrowing is leniency, so every unanswerable case must fall back to the OLD, stricter
  reading: an unwalkable diff → one unattributed bucket every zone sees; a section with no
  known path → in scope everywhere and exempt from nothing; a path shape that cannot be
  trusted → not a declared doc. And catch the parser's throw — turning a diff-shape problem
  into a gate crash is strictly worse than the behaviour being replaced.

## Related

- `docs/adr/008-path-globs-scope-the-contract-zone-scan.md` — the decision, and the risk of
  one declaration buying two exemptions.
- `docs/adr/007-critic-judges-the-diff-not-unverifiable-claims-about-untouched-code.md` — the
  same narrowing one layer up; the fix that exposed this one.
- `docs/gotchas/critic-sees-only-the-diff-hunk.md` — #123, the layer above that.
- `docs/gotchas/validated-one-string-used-another.md` — why the diff walker is shared.
- `docs/gotchas/boolean-whose-no-means-two-things.md` — the same defect in list form: an empty
  path list meaning both "names nothing" and "could not read the diff".
- `docs/PRINCIPLES.md` #10 (fail toward the safe state), #15 (the gate proves only formalized
  properties).
