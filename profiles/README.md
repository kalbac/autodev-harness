# Profiles — per-project-type qualification packs

A profile is a **named, versioned proof pack for a project type**. The harness
proves the *process* (an independent critic plus a mechanical gate decided this
diff may pass); a profile proves the *product* (this artifact meets its type's
bar).

Attach one from a project's `.autodev/config.yaml`:

```yaml
profile: "wordpress-woocommerce@1"
```

`profile: null` (the default) makes the whole contour inert — no extra gate step,
no extra oracle paths, no extra provisioning.

## Why profiles live here and not in the project

The worker only ever writes a per-task worktree of the *target* repository. This
directory is in the *harness* repository, so the two trees never intersect and a
profile is worker-immutable by construction — the Phase-3 requirement of
`docs/adr/006-capability-based-authority-model.md`. A profile over an oracle the
worker can edit would be theater.

**One consequence to remember:** if the harness is ever run *on itself*, this
directory stops being unreachable and becomes an ordinary project directory the
worker can write. It must then be listed in `contract.constitutionPaths`, or the
authority model becomes self-authorizing.

## Contract

- **`gates[]`** — executable product checks, run in the worktree. A RED gate is
  worker-fixable and folds into the verdict as RETRY; a gate that could not RUN
  (missing tool, absent `vendor`) throws, and the conductor escalates it as broken
  operator config. Rulesets ship *inside* the profile and are referenced through
  `{profile}`, which expands to this directory's absolute path. Never invoke a
  project script: that would hand the standard of quality to the repo under
  judgement.
  - **`files`** / **`{files}`** — the glob selecting which of this task's changed
    files the gate applies to, and the placeholder `run` substitutes with that
    (space-joined, quoted) file list. Required together: a gate whose `run`
    contains `{files}` must declare `files`, checked at profile load. A gate
    WITHOUT `files` is whole-project by design (e.g. `composer validate`, which
    judges a manifest, not a file set) and always runs, unscoped. This is what
    makes a gate diff-scoped at the FILE level: on the real polygon, the WPCS
    ruleset used by `wordpress-woocommerce` reports 7069 pre-existing errors
    tree-wide against 8 on the one file a task actually changed — a whole-tree
    gate would be red on every run regardless of the diff.
  - **`redExitCodes`** — the exit codes that mean "this gate ran and found
    something worker-fixable" (a genuine RED, worker-fixable → RETRY). Any OTHER
    non-zero exit is "unrunnable" — the gate step throws and the conductor
    escalates it as broken operator config, rather than looping the worker
    against, say, a missing binary or a malformed ruleset. Optional; omitted
    defaults to `[1]`. Must be non-empty when declared: `redExitCodes: []` would
    silently mean "no exit code is ever red", which no author writing it could
    plausibly have intended.
  - **`report`** — declares the machine-readable report format this gate's
    stdout emits, narrowing scoping from the FILE level down to the LINE level
    (`docs/superpowers/plans/2026-07-22-line-scoped-profile-gates.md`). A closed
    enum; `"checkstyle"` is the only member today, because
    `src/gate/checkstyle.ts` is the only parser this harness has — add a member
    exactly when a second parser is built, never speculatively. When declared,
    the harness parses the tool's output, keeps only the findings that land on
    lines the diff **added** (`src/gate/finding-filter.ts`), and decides the
    verdict from that filtered count instead of from `redExitCodes` — so a gate
    can legitimately report `green: true` alongside a non-zero exit code, when
    every finding sits outside the diff. A finding whose path cannot be
    attributed to any changed file is kept and flagged `unattributed` rather
    than silently dropped (fail-closed), and rendered in its own group in
    `gate-feedback.md` rather than the tool's raw XML, which the worker must
    never see directly. Cross-checked against `run` at profile load: a gate
    declaring `report: checkstyle` whose `run` never mentions `checkstyle` (the
    tool's own report flag, e.g. `--report=checkstyle`) fails to load — the
    author almost certainly forgot the flag. Optional; a gate without `report`
    behaves exactly as before: whole-file scoping (via `files`), verdict from
    `redExitCodes` alone.
- **`protectedPaths[]`** — oracle paths, fed into the `adr/006` Phase-2 fence as
  its fifth source. Entries are worktree-relative and `/`-separated.
- **`requires.provision[]`** — top-level directories to link into each worktree,
  unioned with the project's own `worktree.provision`.
- **Union only, no selective disable.** A profile with gates plucked out is not
  that profile, and "qualified by `<id>@<version>`" would stop meaning anything.
  The escape hatch is blunt on purpose: don't attach the profile, or pin a
  different version.

## Related

- `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md`
- `docs/adr/006-capability-based-authority-model.md`
- `docs/PRINCIPLES.md` — #14 (the worker does not write its own oracle), #15 (the
  gate proves only formalized properties)
