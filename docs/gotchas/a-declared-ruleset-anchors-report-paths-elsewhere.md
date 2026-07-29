# `[gate/declared-ruleset-anchors-paths-elsewhere]` — a project-declared ruleset moves the report's frame of reference

**Tag:** `[gate/declared-ruleset-anchors-paths-elsewhere]`
**Found:** s63 (observed), s64 (reproduced, fixed) — #155, `adr/010`.

## The measurement

The same file, the same gate command, two rulesets, run in a real worktree of the
operator's `woodev-base-theme`:

| ruleset | reported path |
|---|---|
| the profile's `gates/phpcs.xml` (no `basepath`) | `D:\...\worktrees\s64-probe\woodev-base-theme\inc\s64-probe.php` — **absolute** |
| the project's `phpcs.xml.dist` (`<arg name="basepath" value="."/>`) | `.autodev\worktrees\s64-probe\woodev-base-theme\inc\s64-probe.php` — **relative to the trusted root** |

PHPCS resolves a ruleset's relative `basepath` against **the directory of the ruleset
file**, not the process cwd. `adr/010` reads a project-declared ruleset from the TRUSTED
ROOT (correctly — a worktree copy would be worker-writable), while the gate runs with the
worktree as cwd. The two frames differ by exactly the `.autodev/worktrees/<task>/` prefix.

## Why it mattered

`filterFindings` only accepted a path under the worktree, so every finding from a
project-declared ruleset was flagged `unattributed`. Unattributed findings are KEPT
(fail-closed, correct) but **are not line-scoped** — they are judged over the whole file.
That is precisely the defect `profile-gates-must-be-diff-scoped.md` exists to prevent,
reopened by `adr/010`'s own mechanism: on a legacy file the worker inherits the entire
file's debt and cannot converge.

It did not bite in s63 only because the theme is clean under its own standard, so the one
finding happened to sit on an added line anyway.

## The rule this came from, and the one it leaves

`finding-filter.ts`'s own doc comment had already anticipated it: *"if a tool is ever found
to emit a relative path, add that case explicitly, pinned on a captured example."* That is
what was done — the fixture `__fixtures__/phpcs-checkstyle-project-basepath.xml` is the real
capture, not a self-authored one (`[gate/agent-ci-ndjson-keyed-by-event-not-type]` is what
happens otherwise).

- **A tool's report paths are anchored wherever its CONFIG says, which is not necessarily
  where you ran it.** Before matching tool output against your own paths, measure what the
  tool actually prints — with the config that will really be in force, not the default one.
- Anchoring is a one-anchor decision, deliberately: the worktree is NOT also tried, because
  a relative path resolves under it trivially, which would make the real case ambiguous
  (two contained candidates) and send the finding straight back to `unattributed`.
- Five review rounds on this fix produced five path-shape defects, four of them inside the
  previous round's fix. Their common root: **the report path was normalized while the anchor
  it is measured against was not.** State the normal form once and put BOTH sides through it.

## Related

- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — the guarantee this defect suspended.
- `docs/gotchas/validated-one-string-used-another.md` — the family; this is an instance
  created by `adr/010` itself.
- `docs/gotchas/a-validator-placed-after-its-normalizer.md` — found in the same review.
- `docs/adr/010-a-project-may-declare-the-ruleset-its-profile-gate-judges-by.md`
