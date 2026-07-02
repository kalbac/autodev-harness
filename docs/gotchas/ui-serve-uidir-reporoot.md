# `[ui/serve-uidir-reporoot]` — `serve` finds the UI bundle under the *project* repoRoot, and running it for a live browser-driven run needs a detached process

**Tag:** `[ui/serve-uidir-reporoot]`
**Discovered:** s14 (2026-07-02), setting up the aurora live browser proof.

## What

`node dist/index.js serve` resolves the UI bundle at `join(repoRoot, "dist", "ui")`
where `repoRoot = detectRepoRoot(process.cwd())` — the **git root of wherever the
daemon is launched**, not the harness install directory. Consequences:

1. **An external project has no bundle.** When you `serve` from a project other
   than the harness repo (e.g. the aurora sandbox), `<project>/dist/ui` does not
   exist → the API runs but logs "API only — no UI bundle found" and serves no UI.
2. **Dropping the bundle into the project tree dirties git.** Copying `dist/ui`
   into `<project>/dist/ui` makes the working tree dirty → the conductor's
   `mergeAfterGate` throws (main tree must be clean — see
   `[conductor/real-repo-run]`). You must exclude it.
3. **`serve` must be DETACHED for a browser-driven live orchestrate.** A run
   launched from the UI calls `orchestrator.handleIntent`, which spawns `opus`
   for the decompose as a nested child of the `serve` process. If `serve` runs as
   a **bash-background** command, that nested spawn is silently killed at
   "decomposing intent" — the exact failure of `[orchestrator/bg-spawn-killed]`,
   which applies to `serve` too, not just the `orchestrate` CLI verb.

## Fix / how we did the s14 live proof

- Checkout an `autodev/*` branch in the project (commits require
  `allowedBranchPattern` `^autodev/`).
- `cp -r <harness>/dist/ui <project>/dist/ui` **and** `echo 'dist/' >>
  <project>/.git/info/exclude` (local exclude, like `.autodev/`) so the bundle
  never dirties the tree.
- Launch `serve` **detached** so its process tree is independent of the shell
  job: PowerShell `Start-Process -FilePath node -ArgumentList '<harness>/dist/index.js','serve'
  -WorkingDirectory '<project>' -RedirectStandardOutput out.log -WindowStyle Hidden`.
  The nested `opus` decompose then completes.

## Open design question (P3)

Where should the bundle live for an external project? Options: ship `dist/ui`
alongside the daemon and resolve it relative to the harness install (not cwd);
or a per-project `serve --ui-dir <path>`. Deferred to P3 (see NEXT ACTIONS).

## Related

- `[conductor/real-repo-run]` — main tree must be clean; branch must match `^autodev/`.
- `[orchestrator/bg-spawn-killed]` — background nested LLM spawn gets killed; run foreground/detached.
- [[CURRENT-STATE]] — P3 serving story.
