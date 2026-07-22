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
