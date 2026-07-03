# P3 sub-project 2 — Multi-project daemon + product shell (UI/UX)

> Design spec. Status: **design APPROVED in discussion** (operator, s16, 2026-07-03);
> spec pending operator review.
> Second slice of P3 (product phase). This is the operator's explicitly-reserved topic
> (UI/UX design) — every skeleton fork below was resolved WITH him, not assumed.
> Visual companion: `s16-shell-mockup.html` (session scratchpad; two frames — app shell
> + New Project screen). Reference screenshots (Codex/Claude desktop) in `screenshots/`
> (git-ignored, local working material).

## 1. Problem & goal

The daemon is single-project: `src/index.ts:159` binds the whole composition root
(config, blackboard, worktree manager, conductor, orchestrator, `dist/ui`) to
`detectRepoRoot(process.cwd())` at `serve` launch. The UI cannot pick a project, does
not even show which project it drives, and the UI bundle is looked up under the
*project's* repoRoot (gotcha `[ui/serve-uidir-reporoot]` — an external project has no
bundle unless one is copied in, which dirties its tree).

**Goal:** make the daemon **fully multi-project** (operator decision) and grow the
dashboard into a product shell: project registry + sidebar, "New Project" registration
flow with a server-side folder browser and `.autodev/` scaffolding, per-project routes,
a session-inspector right rail, settings surface (global / project / theme).

**Operator-resolved forks (s16):**
1. **Full multi-project daemon** — several projects live concurrently, runs may execute
   in parallel across projects (rejected: registry+single-active rebind; status quo).
2. **Browser now, desktop wrap later** — UI stays browser+localhost this slice; an
   Electron/Tauri wrap is a future slice added ON TOP (AO/OD recon: renderer talks to
   the daemon over loopback HTTP/WS either way, so nothing here is throwaway).
3. **Server-side folder browser** for picking the project directory (rejected:
   scan-plus-manual-path; manual path only).

## 2. Grounding facts (verified in-code, s16)

- `buildOrchestrator` already exists as a factory (`src/index.ts`); generalizing to one
  composition root per project is an extension, not a rewrite.
- Run manifests are per-project already (`<repoRoot>/<stateDir>/runs/<id>.json`,
  `recordRun` = `{runId, intent, taskIds, at}` — best-effort hint, never authority).
- **No token/usage tracking exists anywhere** (`grep -i usage|tokens|cost` over `src/`:
  only watchdog rate-limit regex). Token stats therefore need new worker/critic adapter
  instrumentation → explicitly **phase 2**, not this slice.
- UI design tokens (`ui/src/styles.css` `@theme`) are dark-only; all colors are already
  CSS variables, so a light variant is a token-set addition, not a component rewrite.
- CLI verbs `run` / `orchestrate` stay cwd-bound single-project (unchanged contract for
  scripts/parity); multi-project is the `serve`/UI surface.

## 3. Architecture

### 3a. Project registry (global, thin)

`~/.autodev/projects.json` (`%USERPROFILE%\.autodev\` on Windows):

```json
{ "projects": [ { "id": "aurora", "name": "aurora", "path": "D:/Projects/aurora" } ] }
```

`id` is a kebab-case slug of the folder name, uniquified with a numeric suffix on
collision (`aurora`, `aurora-2`); it is stable after registration (rename changes
`name` only, never `id` — ids appear in URLs/WS events).
**The registry stores identity only** (id, display name, absolute path). Everything
else — roles, gate, provision, branch pattern — stays in the project's own
`.autodev/config.yaml`. The file-blackboard remains the single source of truth per
frozen skeleton axis 1; the registry is an index, never authority. Corrupt/missing
registry → empty list + loud log (fail-open to an empty shell, never crash `serve`).
Unregistering removes the entry only — never touches the project folder.

### 3b. Per-project composition roots

`serve` no longer binds to cwd. A `ProjectHub` holds `Map<projectId, CompositionRoot>`
built **lazily** on first use from the registry entry's path (config load, blackboard
repo, worktree manager, orchestrator via the generalized `buildOrchestrator`). Config
load failure for one project surfaces as that project's error state in the UI — it must
not take down the daemon or other projects. Single-flight orchestrate stays **per
project** (the existing guard, keyed by project); different projects may run
concurrently. Watch/WS change feeds are per project root.

### 3c. API & WS

All existing project-scoped endpoints move under a prefix — old top-level routes are
**removed in the same change** (the bundled UI is the only consumer; no migration
layer):

```
GET  /projects                          → registry + per-project daemon status (active run?)
POST /projects                          → register {path, name, scaffold?: bool, config?: {...}}
DELETE /projects/:id                    → unregister (registry entry only)
GET  /projects/:id/state|runs|runs/:rid|tasks/:tid/runtime[/:name]|escalations/:eid
POST /projects/:id/escalations/:eid/reply
POST /projects/:id/orchestrate
GET  /fs/dirs?path=<abs>                → folder browser (see 3e)
WS   change events now carry {projectId}
```

`GET /projects` powers the sidebar: projects + last-5 runs each come from the run
manifests + queue state of each (lazily built) root; a project that fails to load
reports `{error}` instead of counts.

### 3d. UI bundle serving

`serve` resolves `dist/ui` **relative to the harness install** (its own module path),
not the project repoRoot. Closes `[ui/serve-uidir-reporoot]` by construction; external
projects need nothing copied into their trees.

### 3e. Folder-browser endpoint (new FS surface — gated code)

`GET /fs/dirs?path=<abs>` returns `{ parent, entries: [{name, isGitRepo, isRegistered}] }`;
no `path` param → drive roots on Windows / `/` on POSIX. Directories only — file names
are never listed. Each entry is annotated: `isGitRepo` (has `.git`), `isRegistered`
(in the registry). Hardening per `[api/static-traversal]`: canonicalize via `realpath`,
`lstat` before descend, reject non-directories, never follow into reparse points
silently (annotate, resolve real target). Trust model: full-disk *directory-name*
browsing is by design — the daemon is a localhost, single-operator tool that already
runs `git`/`composer`/workers with the operator's rights; the endpoint stays bound to
loopback like everything else.

## 4. UI shell (mockup Frame 1)

Agent-desktop IA (unchanged philosophy from s14): sidebar → transcript-forward main →
inspector rail. The **critic verdict stays first-class** — verdict seals appear in the
sidebar run list, run cards, and the rail.

- **Left sidebar:** `+ New Project` button; **Projects** section — each registered
  project expands to its last 5 runs (verdict seal + title + relative time), `show
  more…` → full run list; active-run projects get a pulsing working dot. Footer: daemon
  status + gear → popover: **Global settings**, **Project settings** (current project),
  theme segmented control **System · Dark · Light**.
- **Main area:** per-project Home = composer-first hero (codex-style chips under the
  input: project switcher, worker/critic roles read-only → click opens project
  settings). Recent-runs cards with verdict seals below. Existing Run-transcript and
  Task screens become project-scoped routes (`/p/:id/runs/:rid` …).
- **Board (kanban) is kept as the secondary lens** — a chip in the project top bar
  opens the s14 five-queue board, now scoped to the selected project. It remains a
  lens, never the hero (operator's standing IA rule).
- **Right rail — session inspector** (per selected project/run):
  - **Now:** live pipeline of the active run — decompose → per-task worker → gate →
    critic → commit, current step highlighted (from WS + runtime files).
  - **Queue:** pending / active / escalated / done counters (escalated in amber).
  - **Session:** branch, gate command, worktree path, provision list.
  - **Roles:** orchestrator/worker/critic — adapter · model · effort. (This replaces
    the operator's "which MCPs" wish: the harness's analog of MCPs is its role
    adapters.)
  - **Tokens:** rendered block with honest "—" placeholders + "phase 2" badge until
    adapter usage instrumentation exists.
- **Settings screens:** Global = registry management (rename/unregister), theme,
  daemon info; Project = form view over the project's `.autodev/config.yaml` (same
  fields as registration). Both are full-screen routes (codex-style), reachable from
  the footer popover.
- **Theming:** light token set alongside dark (ink/panel/surface/line/text remapped;
  status+verdict hues shared), `class` strategy on the root element, preference
  persisted client-side (`localStorage`), "System" follows `prefers-color-scheme`.

## 5. "New Project" flow (mockup Frame 2)

Folder browser (3e) → pick a git repo → registration form:

- Display name (prefilled from folder name).
- Roles: orchestrator / worker / critic (adapter · model · effort dropdowns, prefilled
  with the current schema defaults).
- Gate check command; worktree provision list; branch pattern (`^autodev/` default).
- **Scaffold `.autodev/`** checkbox (default ON for repos without one): writes
  `config.yaml` from the form + the blackboard skeleton (GOAL.md / INVARIANTS.md stubs,
  queue dirs — exact layout mirrors what `FileBlackboardRepository` expects; the
  implementer derives it from `src/blackboard/`, not from this spec) and appends
  `.autodev/` to `.git/info/exclude`. One checkbox closes all three
  `[conductor/real-repo-run]` prerequisites' config half (deps/clean-tree remain ops).
- Form writes `.autodev/config.yaml` **into the project**; only `{id, name, path}` goes
  to the registry. Registering a repo that already has `.autodev/config.yaml` skips the
  scaffold and shows the existing values read-only-first (edit via Project settings).

## 6. Error handling

- Registry read/write: best-effort with loud logs; `serve` never crashes on a bad
  registry (empty shell + error banner).
- Per-project root build failure (bad config.yaml, missing path): project renders in an
  error state in the sidebar; other projects unaffected.
- `POST /projects` validates: path exists, is a git repo, not already registered;
  scaffold is transactional-ish (config.yaml written last, `wx` semantics like
  `enqueue.ts`/`recordRun`), and never overwrites existing blackboard files.
- `/fs/dirs`: unreadable dirs → entry-level skip; invalid path → 400, never 500.

## 7. Testing plan (TDD per module; typecheck after subagents)

1. Registry: load/save round-trip, corrupt file → empty+log, unregister keeps folder.
2. ProjectHub: lazy build, per-project isolation (one bad config doesn't poison the
   map), single-flight per project, two projects orchestrating concurrently (fixture).
3. Routing: every moved endpoint under `/projects/:id`, unknown id → 404, WS events
   carry projectId; old top-level routes are gone.
4. UI-bundle path: resolved from harness install regardless of registered projects.
5. `/fs/dirs`: dirs-only, git/registered annotation, symlink/reparse handling,
   traversal cases from `[api/static-traversal]` re-applied.
6. Register+scaffold: fresh repo gets full skeleton + git-exclude line; existing
   `.autodev/` never clobbered; form→yaml→`loadConfig` round-trip (`.strict()` passes).
7. UI: component/behavior review as in s14 (presentation is reviewed, not codex-gated).

## 8. Slicing & discipline

Modules, each: worker (Sonnet 5 / Opus 4.8 by complexity) TDD → Fable spec-check →
**codex GPT-5.5 gate → re-critic every fix** (backend modules are enforcement-adjacent);
UI shell module is review-only (presentation):

1. **M1** registry + ProjectHub (per-project composition roots, single-flight map).
2. **M2** API re-rooting + WS projectId + UI-bundle-from-install.
3. **M3** `/fs/dirs` + `POST/DELETE /projects` + scaffold.
4. **M4** UI shell: sidebar, project Home, project-scoped routes, right rail, settings
   screens, popover.
5. **M5** theming (light tokens + switcher).

s16 realistically lands the spec/plan + M1–M2; the rest rides the same conveyor in
follow-up sessions. Branch `autodev/s16-multiproject-shell`; per-module commits; PR +
gated merge per AGENTS.md batch rule.

## 9. Out of scope (deliberate)

- **Token/usage stats (phase 2):** needs worker/critic adapter instrumentation
  (claude/codex CLIs can emit usage) + per-run aggregation — separate gated slice; the
  rail block ships with honest placeholders.
- **Desktop wrap (Electron/Tauri):** future slice on top of the same loopback API
  (native folder dialog, tray, daemon child-process spawn — AO/OD patterns).
- **Cross-project search, run archiving/rename/fork** (codex/claude niceties) — backlog.
- **Ops live-proof of deps-provisioning on a woodev clone** — still the deferred s15
  item, orthogonal to this slice (CURRENT-STATE next-action #2).

## Related

- `docs/superpowers/specs/2026-07-02-p2-dashboard-design.md` — the s13/s14 dashboard this extends.
- `docs/gotchas/ui-serve-uidir-reporoot.md`, `docs/gotchas/static-file-serving-symlink-traversal.md`,
  `docs/gotchas/harness-on-real-repo-prerequisites.md` — closed/reused by this design.
- `docs/CURRENT-STATE.md` — NEXT ACTIONS (s16); `adr/003` — roles registry the settings UI surfaces.
