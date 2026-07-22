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

## What is STILL not solved (read before trusting a green gate)

**Diff-scoping is per FILE, not per LINE.** A task that touches an existing file
inherits that file's entire pre-existing debt. Measured: *every* PHP file in the
polygon exits non-zero under the profile ruleset, so any task modifying an
existing file is red before the worker writes a line. v1 is therefore only
practically green for tasks that add new files or touch non-matching files.

That is a real limitation, not a detail. The options — line-scoped filtering
(`phpcs` then intersect with the diff's line ranges), a per-profile baseline file,
or an explicit "you touched it, you clean it" policy — are a design decision, not
a bug fix. See `FUTURE-BACKLOG.md`.

## Related

- `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md`
- `gotchas/profile-gate-red-gives-the-worker-no-feedback.md` — the sibling gap: a
  red gate does not tell the worker *why*.
- `gotchas/vendor-junction-composer-autoload-basedir.md` — why the v1 gate set is
  static in the first place.
