# `[gate/profile-gates-must-be-diff-scoped]`

> A qualification-profile gate that scans the whole tree is red on every run
> regardless of the diff — it blocks everything and proves nothing. Found s51,
> by running the tool against a real plugin before writing the profile.

## What happened

The `wordpress-woocommerce@1` profile was first written with a whole-project
PHPCS gate (`phpcs --standard=<profile>/gates/phpcs.xml .`). Measured on the real
polygon (`woodev-shipping-plugin-test`) before shipping it:

| Scope | PHPCS result |
|---|---|
| whole tree | **7069 errors**, 262 warnings, 115 files |
| the one file a task actually changed | **8 errors** |

A whole-tree gate therefore returns RED on every task forever, no matter what the
worker wrote. Its verdict carries **zero information about the diff under
judgement**, and it can never be green, so no task can ever commit. That is not a
strict gate — it is a broken one.

Every other check in this harness is already diff-scoped (`resolveScope`,
`zonesTouchedInDiff`). The whole-tree profile gate was the odd one out.

## The fix

A profile gate may declare a `files:` glob and use a `{files}` placeholder:

```yaml
- id: phpcs
  files: "**/*.php"
  run: "vendor/bin/phpcs -q --report=full --standard={profile}/gates/phpcs.xml {files}"
```

`{files}` expands, per task, to the changed files matching the glob. A gate with
no `files:` is whole-project by design (`composer validate` judges a manifest, not
a file set) and always runs.

Three sub-rules that are not obvious:

1. **No match ⇒ SKIP, never "run with an empty list".** Handing PHPCS an empty
   path list makes it scan the whole tree — reintroducing the exact bug. The skip
   is logged, because a skipped gate is a *bound on what the verdict covers*, and
   an unreported bound reads as coverage.
2. **`{files}` in `run` and a `files:` glob must agree, both directions.**
   `{files}` without a glob ships the literal text to the tool; a glob without
   `{files}` silently runs whole-tree while its author believes it is scoped — the
   original bug, reintroduced by a typo. `loadProfile` refuses both.
3. **`{files}` cannot be expanded at load time** (no task exists yet), so it stays
   a placeholder in `ResolvedGate.run` and is substituted per invocation.

## The second half: per FILE was not enough (RESOLVED s51, profile v2)

File-level scoping made the gate *meaningful* (7069 → 8) but not yet *usable*: a
task touching an existing file still inherited that file's entire pre-existing
debt, and *every* PHP file in the polygon exits non-zero under the ruleset — so any
task modifying existing code was red before the worker wrote a line. v1 was
practically green only for new files.

**Resolved by line-scoping** (`docs/superpowers/specs/2026-07-22-line-scoped-profile-gates-design.md`).
A gate may declare `report: checkstyle`; the harness parses the tool's machine
report, keeps only findings landing on lines the diff **added**, and judges the
gate by that filtered count instead of the exit code. A tool exiting non-zero
because of debt elsewhere in the file is now a **green** gate.

A **baseline file** was rejected on principle rather than taste: a baseline *is* an
oracle, so a worker able to regenerate it could whitewash all debt in one commit —
exactly the reward-hacking Principle 14 and `adr/006` exist to stop. Line-scoping
introduces no new artifact at all.

**Live-proven, all three directions:** a compliant change to a legacy file carrying
10 pre-existing violations → gate **green**, committed `44bb027` (impossible under
v1); a non-compliant addition to that same file → red, listing **only** lines
146–148 with the file's line-1 `InvalidClassFileName` and `InvalidEOLChar`
absent; a brand-new non-compliant file → line-1 findings correctly INCLUDED,
because every line of a new file is added.

**What the parser must never do:** return zero findings for input it could not
parse. Zero findings means "clean" downstream, so a silent parse failure turns a
broken gate into a PASS. The parser throws instead, and `classifyGateExit` runs
BEFORE any parse so an unrunnable tool never reaches it.

## Related

- `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md`
- `gotchas/profile-gate-red-gives-the-worker-no-feedback.md` — the sibling gap: a
  red gate does not tell the worker *why*.
- `gotchas/vendor-junction-composer-autoload-basedir.md` — why the v1 gate set is
  static in the first place.
