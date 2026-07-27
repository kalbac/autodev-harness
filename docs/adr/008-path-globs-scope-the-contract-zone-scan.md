# 008 — `path_globs` is a contract zone's SCOPE, and a declared doc path is outside zone checking

**Status:** accepted (operator decision, s60 2026-07-27 — options (a) and (b) chosen
together from the four presented in #140)
**Date:** 2026-07-27
**Refines:** `005-critic-is-a-correctness-gate-coverage-is-mechanical.md` and
`007-critic-judges-the-diff-not-unverifiable-claims-about-untouched-code.md` — the same
move, one layer lower. adr/005 and adr/007 narrowed what the *critic* is asked to certify;
this narrows what the *mechanical gate* treats as touching a contract.
**Resolves:** #140.

## Context

`adr/007` shipped in s59 and worked. On the corpus case `good-docs-overview-note` — whose
whole task is "append a section to `docs/OVERVIEW.md` documenting that the plugin registers
`test_pickup` and `test_courier`" — the critic returned `clean` @0.99, naming the
unverifiable assertions in `notes`, against `uncertain` @0.84 in s58.

The case still failed, and `first_pass_commit_rate` stayed at 50%. The blocker had moved one
layer down, into the machine gate:

```
decision: ESCALATE
reasons:
  zone 'shipping-method-ids': contract value 'test_pickup' touched but NO
  mutation-verified guard covers THAT value (needs guard)
  zone 'shipping-method-ids': contract value 'test_courier' touched ...
changed_files: ["docs/OVERVIEW.md"]
```

The only changed file is a Markdown document. It contains no code. It *mentions*
`test_pickup` and `test_courier` because documenting them was the assignment.

The cause is one line of `zoneTouched` (`src/gate/invariants.ts`). `path_globs` was used as
**one arm of an OR**, not as a scope:

```ts
if (zone.path_globs.length > 0) {
  for (const f of changedFiles) ... if (globMatch(glob, f)) return true;
}
// path did not match -> scan the value STRINGS against EVERY diff line anyway,
// whatever file that line came from
```

The polygon's zone declares `path_globs: ["includes/class-test-shipping-method-*.php"]`.
The operator had already said where that contract lives. The gate scanned everywhere
regardless, so **documenting a contract value counted as touching the contract**, and the
gate then demanded a mutation-verified guard for a sentence of prose.

This changes what "pass" means, so it went to the operator rather than being fixed in place.

## Decision

Both narrowings from #140, taken together:

**(a) `path_globs` is the SCOPE of the string scan.** A zone that declares where its
contract lives has its `grep_patterns`/`exact_strings` matched only against diff lines from
files those globs match. A zone that declares **no** `path_globs` has not said where it
lives, so it keeps the repository-wide scan unchanged — an absent scope is "not stated", not
"empty".

**(b) A path declared in `contract.docPaths` is outside contract-zone checking.** This is
`adr/007`'s operator declaration, reused one layer down. It closes the same hole for a zone
with no `path_globs` at all, which (a) cannot reach.

The two are independent: (a) fixes the semantics of a field that already claimed to mean
this; (b) is a new exemption that rests on an existing declaration.

### What the gate keeps

- **The constitution fence is untouched.** `inv.constitution.path_globs` and
  `contract.constitutionPaths` still escalate on a declared doc path. A project that fences
  a file outright still needs a human for it, and this is pinned by a test: declaring
  `docs/**` in BOTH lists escalates on the constitution reason and reports zero zones.
- **A zone whose files really are touched still catches its values**, including in a mixed
  docs-plus-code diff — the code file's lines are in scope, so the value is enumerated and
  the missing guard still escalates.
- **Both sides of a diff decide scope, because a hunk has two files.** A section's `-` lines
  belong to the pre-image file and its `+` lines to the post-image one, and for a rename those
  are different files. So a section is IN SCOPE for a zone when **any** of its paths matches
  (union), and EXEMPT from the declaration only when **every** one of them is declared
  (intersection). Both readings are the one that grants less.

  This is not hypothetical, and it is not something the tests caught — the review gate broke
  the first implementation twice with a single input shape. Attributing lines to the
  post-image path alone would have made `git mv includes/class-x.php docs/x.md` a way to
  carry a zone's contract values out of the zone that governs them, and (b) would then have
  dropped the removals entirely. A deletion (`+++ /dev/null`) has the mirror problem: its
  only real path is the pre-image one, and a post-image-only reading loses exactly the file
  whose contract just changed.

- **"Which files did this diff touch" is a different question from "whose lines are these",
  and must be read off the diff, not off the attributed lines.** The next review round broke
  the fix again through the other end: a **100%-similarity rename, a mode-only change and a
  binary change each name a file while emitting no `+`/`-` line at all**. A touched-file list
  derived from the content buckets is therefore EMPTY for them, so `zonesTouchedInDiff`
  reported a zone clean that the gate — whose list comes from `git diff --name-only` —
  reported touched. `diffNamedPaths` answers the file question directly from the headers
  (`--- `/`+++ `, `rename from`/`rename to`, `copy from`/`copy to`, and a `diff --git` line
  whose two sides are equal), so a section with no body is still a section that names files.

- **Both layers now build that list the same way, and the gate gained a check it never had.**
  The round after found the two layers still disagreeing, because `git diff --name-only` —
  the gate's source — reports POST-IMAGE paths. So `git mv` of a zone file OUT of its zone at
  100% similarity named only the destination, and with no hunk body there were no lines to
  scan either: the gate reported the zone untouched *for a change that physically moved a
  contract value out of it*. The gate's list is now git's list UNIONED with the paths the
  diff names (`unionDiffNamedPaths`) — strictly more files, never fewer — which closes that
  hole and makes the two answers identical by construction.

- **"Unreadable" is not "names no files".** The same round found the last shape of the same
  bug: an unparseable diff made the path list empty, which silently dropped the path arm of
  the conductor's check while the gate still had git's list. `scanDiffPaths` returns
  `{readable: false}` instead, and each caller states its own fallback — the gate keeps git's
  list, and the conductor reports EVERY zone as touched, because nothing has been ruled out.

### Every uncertainty resolves toward the old, stricter behaviour

Both narrowings are leniency, so Principle 10 governs each failure path:

| Situation | Answer |
|---|---|
| The diff cannot be walked (truncated, malformed) | Fall back to ONE unattributed bucket = the pre-adr/008 whole-diff scan. A diff the harness cannot read never buys leniency — and never crashes the gate either, which is what letting the parser's throw escape would have done. |
| A section names no path at all (neither header seen) | In scope for every zone, and exempt from nothing. |
| A section names two different paths (rename, copy) | In scope if EITHER matches the zone; exempt only if BOTH are declared docs. |
| A section names files but carries no `+`/`-` line (100% rename, mode-only, binary) | It has no lines to scan, but it still COUNTS AS TOUCHING its files — the paths come from the headers, so the conductor's answer matches the gate's. |
| The diff cannot be walked, at the GATE | Keep git's `--name-only` list alone — the pre-adr/008 file list, so unreadable input never removes a file from the check. |
| The diff cannot be walked, at the CONDUCTOR (no git list to fall back on) | Report EVERY contract zone as touched. Nothing has been ruled out, and `contractRisk` only chooses escalate-now over retry on a change the critic already declined to call clean. |
| A path with `..`, a drive letter or a root anchor | NOT a declared doc. `globMatch` is textual, so `docs/**` matches the string `docs/../includes/class-foo.php`; the shape test refuses rather than normalizes. |
| `contract.docPaths` is empty (the shipped default) | (b) is inert; behaviour is byte-identical to s59. |

## The risk the operator accepted

`contract.docPaths` was introduced for the critic's mandate. Option (b) makes one
declaration buy an exemption in a **second** mechanism — a field's blast radius growing
after the operator blessed it, which is the drift `adr/006` exists to prevent. The counter,
and the reason (b) was taken anyway: the declaration is read from the **trusted root**, so a
worker still cannot grant itself either exemption, and the two exemptions are the same
statement ("these paths are documentation") applied to the two components that were both
wrong about it. What makes it safe to *state* rather than *hide* is that the dashboard now
names both effects on the same row (#138), so the widening is visible where the declaration
is read, not only in this ADR.

The residual is real and stated rather than discovered later: **a project that declares a
path as documentation, and later starts generating code from it, has silently removed both
that file's critic mandate and its contract-zone checking.** The remedy is the same one
`adr/007` names — do not declare it, or fence it via `contract.constitutionPaths`, which
neither narrowing can touch.

## What this is NOT

- Not a claim that documentation cannot break anything. It is a claim that the *mechanical*
  gate cannot prove it (Principle 15), and that a check whose only possible answer on a whole
  class of change is "escalate" is not protection, it is refusal — the same argument adr/005
  and adr/007 already made one layer up.
- Not detection. Nothing sniffs file content or extensions; s59's parked attempt proved that
  road unclosable (`adr/007`, "Why a declaration, and not a detection").
- Not a change to the enforcement substrate: worktree isolation, the dirty-file fence,
  commit-after-gate, oracle definitions read from the trusted root (`adr/003` R1, `adr/006`).

## A deliberate parity divergence

`zoneTouched` was a faithful port of `_common.ps1 Test-ZoneTouched`, which has the OR-arm
behaviour. The port is now deliberately **not** at parity: the PowerShell original ran in
one repository whose zones and file layout were known to its author, and the defect never
surfaced there. Parity was a means of trusting the port, not a goal in itself. The function
itself is unchanged — the *callers* now decide which lines it may see — so the parity note in
`invariants.ts` still describes the matching, and points here for the scope.

## Consequences

- `src/gate/zone-scope.ts` (new) holds both narrowings and their fail-closed reasoning:
  `attributeDiffLines`, `zoneScopedLines` (a), `excludeDeclaredDocs` / `excludeDeclaredDocPaths`
  (b), `isDeclaredDoc`.
- `src/gate/diff-lines.ts` gains `diffContentLinesByFile`, which shares the existing
  battle-hardened positional walker rather than adding a second diff parser. That walker
  already distinguishes a `+++ b/path` header from an added line whose own content begins
  with `++` — undecidable by text, decidable only from the hunk headers' declared counts. A
  second parser answering the same question a different way is this repo's most recurring
  defect shape (`[critic/validated-one-string-used-another]`).
- One consequence of using the strict walker: the flat reader
  (`diffAddedRemovedLines`) DROPS a content line whose text starts with `+++`/`---`, because
  it can only guess. The attributed reading keeps it. Strictly more lines are scanned, i.e.
  the safe direction.
- `isPlainRelativePath` moved to `src/util/path-shape.ts` and is now shared by
  `critic/evidence.ts` (adr/007) and `gate/zone-scope.ts` — the same values, checked by the
  same function, in both places.
- `GateDeps.docPaths` is wired from `cfg.contract.docPaths` at the composition root, i.e.
  from the trusted root (`adr/006` Phase 1). It is NOT unioned into the constitution check.
- `zonesTouchedInDiff` (the conductor's `contractRisk` input) is scoped identically, because
  the two answers to "does this diff touch a contract zone" must not disagree — the gate
  would commit a change this call flagged as contract risk, and the task would escalate for a
  reason the gate had already cleared. Two side effects, both deliberate: its changed-file
  list is now derived from the diff instead of being passed empty, so a zone's `path_globs`
  arm actually fires there for the first time (strictly MORE zones reported — the safe
  direction), and declared doc paths are excluded there too (per path, so a rename with one
  declared side keeps its undeclared side). That list is built by `diffPaths` → 
  `diffNamedPaths`, straight off the diff headers and from BOTH sides of every section. Both
  review rounds landed here, on the same invariant: a post-image-only version disagreed with
  the gate for every deletion and rename (R1); a version derived from the attributed content
  lines disagreed for every section with no hunk body — a 100% rename, a mode-only change, a
  binary change (R2); and a version that reported an unreadable diff as an empty list dropped
  the path arm entirely while the gate still had git's (R3). The gate meanwhile unions the
  same header-derived paths into ITS list, so the two are now the same list by construction.
- The dashboard's "Contract (oracle)" section states both effects of a `docPaths`
  declaration on the same row it is read from (#138, operator rule s59: a capability that
  lives only in YAML is invisible).
- **Not measured yet.** This ADR is expected to take `good-docs-overview-note` to a commit,
  and that expectation is worth exactly nothing until the corpus is re-run. The operator
  deliberately scoped s60 to the docs audit plus this fix, without a corpus run; the next
  session's number is the one that counts. Anything else written here about
  `first_pass_commit_rate` would be a projection, not a measurement.

## Related

- `007-critic-judges-the-diff-not-unverifiable-claims-about-untouched-code.md` — the same
  narrowing for the critic, and the source of the `contract.docPaths` declaration (b) reuses.
- `005-critic-is-a-correctness-gate-coverage-is-mechanical.md` — coverage is the machine
  gate's job; this ADR bounds *which files* that job covers for a given zone.
- `006-capability-based-authority-model.md` — why `contract.*` is read from the trusted root,
  and why growing a blessed field's blast radius is a risk worth naming.
- `docs/PRINCIPLES.md` #10 (fail toward the safe state), #15 (the gate proves only formalized
  properties).
- `docs/gotchas/documenting-a-contract-value-is-not-touching-it.md` — the finding.
- `docs/CURRENT-STATE.md` — where this sits in the corpus-driven loop.
