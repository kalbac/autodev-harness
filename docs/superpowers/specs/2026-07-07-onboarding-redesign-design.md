# Onboarding Redesign — any-folder picker + auto git-init/branch + git-not-installed guard

> Design spec. Authored 2026-07-07 (s30). Supersedes the git-only New Project flow.
> Folds in the s30 Task 1 (conductor `^autodev/` branch-guard onboarding fix) as its
> shared `ensureAutodevBranch` mechanism. Discipline: DAEMON code → TDD + typecheck +
> `npm test` + **mandatory codex GPT-5.5 critic gate** per backend module; UI review-only.

## 1. Problem

Today "New Project" only lets the operator select folders that are **already git
repos**: `FolderBrowser` shows a "select" pill only on `isGitRepo && !isRegistered`
rows, and `admin.register` hard-rejects a non-git path with `not_a_git_repo`. Two
consequences:

1. A folder the operator wants to turn into a project but hasn't `git init`-ed is
   **unpickable** — no path forward from the UI.
2. Even for a valid git repo, the first run trips the conductor branch guard
   (`conductor.ts:517`, pattern `^autodev/`, default `schema.ts:45`): the New Project
   scaffold writes `.autodev/` but never puts the repo on an `^autodev/` branch, so a
   fresh project's first run dies `refusing to run on branch 'master'` and tasks hang
   PENDING (this is the s30 Task 1 bug; gotcha `[ops/daemon-run]`).

Additionally the folder browser lists **system/hidden** directories (noise, and a
foot-gun — nothing stops the operator registering `C:\Windows`), and there is **no
signal when `git` itself is not installed** — every git operation then fails opaquely.

### Why not a native OS folder dialog

A browser page **cannot** open a native folder picker that returns an absolute
filesystem path (browser sandbox: `File System Access API` yields opaque handles,
`webkitdirectory` uploads file contents — neither gives a path the daemon can act on).
That is exactly why the daemon-served `GET /fs/dirs` browser exists. A daemon-spawned
native dialog was considered and **rejected for now**: GUI-from-detached-daemon is
fragile on Windows (focus/z-order), a headless/remote daemon still needs the in-browser
fallback (so it is really two implementations), and the genuinely-native experience
comes for free from the DEFERRED desktop wrap (Electron/Tauri `showOpenDialog`). Decision
recorded 2026-07-07 with the operator.

## 2. Goals / Non-goals

**Goals**
- Register **any** folder as a project (git repo or not) from the existing in-browser
  folder browser.
- Hide system/hidden directories from the browser (protection-from-mistakes).
- For a non-git folder, an inline **"init git"** action that makes it a usable autodev
  project root: `git init` → empty initial commit → on an `^autodev/` branch.
- For an existing git repo not on an `^autodev/` branch, **silently** put it on one at
  register time AND defensively at daemon startup (fixes already-registered projects —
  the s30 Task 1 fix).
- Detect a missing `git` binary and surface a banner + an **"Install it now"** action.

**Non-goals (this spec)**
- Native OS folder dialog (deferred to the desktop wrap).
- Auto-installing git from the daemon ("Install it now" opens the download page + shows
  the package-manager command; it never runs an install).
- Committing the operator's existing files (`git init` leaves them **untracked** — the
  operator commits their own baseline).
- The s30 orphan-task (B) and dedup (C) follow-ups from `next-session-promt.md` — those
  remain separate, tracked in `CURRENT-STATE.md`.

## 3. Behavior

### 3a. Any-folder picker + hidden-folder filtering

- **`src/fsbrowse/fsbrowse.ts` — hide system/hidden entries.** Node's `Stats` does NOT
  expose Windows `HIDDEN`/`SYSTEM` attributes without a native dependency, so filtering is
  **name-based** (dependency-free) in `listDirs`: skip any entry whose name starts with `.`
  (all platforms — hides `.git`, `.vscode`, POSIX dotfiles) and, on win32 additionally,
  any name starting with `$` plus a small curated denylist of known system dirs
  (`System Volume Information`, `$Recycle.Bin`, `Config.Msi`, `Recovery`). This is
  protection-from-mistakes, not a security boundary (the operator can still type a path
  the daemon serves). Filtering in `listDirs` means the endpoint and any future consumer
  inherit it. No "show hidden" toggle (YAGNI — add later if asked). `.git` being hidden
  does NOT affect the `isGitRepo` badge — the badge derives from `existsSync(join(path,
  ".git"))` on the PARENT row, independent of child-entry filtering.
- **`FolderBrowser.tsx` — any folder selectable.** The "select" pill shows on **every**
  not-yet-registered folder, not only git repos. `isGitRepo` becomes a pure badge.
- **`admin.register` — drop the git gate.** Remove the `not_a_git_repo` rejection. A
  non-git folder registers fine; the scaffold + branch-ensure below make it runnable.
  (A non-git folder that is never init-ed simply cannot run until it has git — surfaced
  in the UI, not blocked at register.)

### 3b. Inline "init git" for non-git folders

- **UI:** a non-git row renders `no git · [init git]` where **init git** is a
  button/link. On success the row refreshes (now a git repo on `autodev/main`, so the
  normal "select" path is available). While git is not installed (3c) the action is
  disabled with the banner explaining why.
- **Endpoint:** `POST /fs/git-init` (admin-port-gated, mirrors the other admin routes;
  404 when no admin port). Body `{ path }`. Validates the path like `register` (realpath,
  is a directory, not already a git repo). Delegates to a new admin method `initGit(path)`.
- **`admin.initGit(path)`** (inside the registry lock, like `register`):
  1. `git init` in `path`.
  2. Empty initial commit so `HEAD` exists (a zero-commit repo cannot create a worktree):
     `git -c user.name=… -c user.email=… commit --allow-empty -m "chore: initialize autodev project"`.
     The inline `-c` identity avoids a failure on a machine with no global `user.email`;
     it is used **only** for this bootstrap commit, never for the operator's own commits.
  3. `ensureAutodevBranch` (3d) → creates/switches to `autodev/main`.
  Existing files in the folder stay **untracked** (we never `git add` them). Returns the
  new branch + an `untrackedCount` so the UI can hint "N untracked files — commit your
  baseline before the first run".
- **Failure** → typed error → 400/500 (no half-init left registered; init happens
  entirely before any registry write, same ordering discipline as scaffold-before-append).

### 3c. git-not-installed detection + "Install it now"

- **Detection:** reuse the executable-probe pattern (`src/detect/detect-agents.ts`,
  gotcha `[detect/executable-probe]`): walk PATH×PATHEXT for a real executable `git`,
  best-effort `git --version`. New daemon-global `GET /system/git` → `{ installed:
  boolean, version?: string }` (mirrors `GET /agents/detect`).
- **UI:** `NewProjectView` fetches it on load. When `installed === false`, a banner:
  "git is not installed — the harness needs it to initialize and orchestrate projects."
  with an **Install it now** button. The button opens `https://git-scm.com/downloads`
  in a new tab and shows the OS package-manager command (`winget install Git.Git` /
  `brew install git` / distro hint). It does **not** run an install. While git is
  absent, "init git" and "select"→register are disabled.

### 3d. `ensureAutodevBranch` — the shared branch mechanism (s30 Task 1)

A single helper used by BOTH the init-git path (3b) and the defensive startup path
below, so there is one implementation of "make this repo be on an `^autodev/` branch".

Signature (sketch): `ensureAutodevBranch(git: Git, pattern: RegExp, log?): Promise<{ switched: boolean; branch: string }>`.

Logic:
1. `cur = git.currentBranch()`. If `cur` matches `pattern` → **no-op** (already good).
2. Else list local branches (`git.listBranches()`); if any matches `pattern` → **switch**
   to it (`git checkout <branch>`), do NOT recreate.
3. Else **create** the canonical default `autodev/main` from current HEAD
   (`git checkout -b autodev/main`). The name is a fixed default — we do NOT reverse the
   regex (per Task 1 brief).

Edge cases (from the Task 1 brief):
- Already on a matching branch → no-op.
- Matching branch exists but not checked out → switch, don't recreate.
- **Dirty tree → carry over** (`git checkout -b`/`checkout` carries uncommitted changes;
  we do **not** stash and do **not** require a clean tree at branch time — clean-tree is
  only a *merge*-time requirement, `mergeAfterGate`).
- Non-git dir → clear operator-facing error (only reachable via the defensive path if a
  registered project lost its `.git`; the init path guarantees git first).

**Where it runs:**
- **Register** (`admin.register`, after `scaffoldProject`): a newly-registered EXISTING
  repo on `master`/`main` is put on `autodev/main` immediately.
- **Init-git** (`admin.initGit`, step 3): the just-init-ed repo lands on `autodev/main`.
- **Defensive startup** (serve/run composition root): iterate registered projects and
  best-effort `ensureAutodevBranch` each, so **already-registered** projects (e.g. the
  operator's `woodev-shipping-plugin-test`, currently on `master`) are fixed without
  re-registering. Best-effort + never-throws (a broken project must not crash the daemon;
  log and continue).

### 3e. `Git` abstraction additions (`src/util/git.ts`)

New methods (shell out to the real `git`, same `runNative` + `fail` pattern):
- `init(): Promise<void>` — `git init`.
- `listBranches(): Promise<string[]>` — `git branch --format=%(refname:short)`.
- `checkoutBranch(name: string): Promise<void>` — `git checkout <name>` (switch existing).
- `createBranch(name: string): Promise<void>` — `git checkout -b <name>` (create + switch).
- `commitEmpty(message: string): Promise<string>` — `git -c user.name/email commit
  --allow-empty` (bootstrap identity baked in).
- `countUntracked(): Promise<number>` — `git status --porcelain` count of `??` lines (for
  the UI hint).

`currentBranch()` already exists. Existing methods are untouched.

## 4. Data flow

```
New Project screen load
  └─ GET /system/git ──────────────► { installed, version }
        └─ not installed → banner + "Install it now" (opens git-scm.com), actions disabled

Folder browser (GET /fs/dirs, now hides hidden/system; every unregistered row selectable)
  ├─ non-git row → [init git] → POST /fs/git-init { path }
  │       └─ admin.initGit: git init → empty commit → ensureAutodevBranch → { branch, untrackedCount }
  │            └─ row refreshes: now git repo on autodev/main → selectable
  └─ select row → RegisterForm → POST /projects
          └─ admin.register: (no git gate) → scaffoldProject(.autodev/) → ensureAutodevBranch → registry append

Daemon startup (serve/run)
  └─ for each registered project: ensureAutodevBranch (best-effort, never-throws)  ← fixes pre-existing projects
```

## 5. Modules touched

| Module | Change | Gate |
|---|---|---|
| `src/util/git.ts` | +`init`/`listBranches`/`checkoutBranch`/`createBranch`/`commitEmpty`/`countUntracked` | codex |
| `src/util/ensure-branch.ts` (new) | `ensureAutodevBranch` helper | codex |
| `src/fsbrowse/fsbrowse.ts` | hide system/hidden dirs in `listDirs` | codex |
| `src/registry/admin.ts` | drop `not_a_git_repo` gate; +`initGit`; call `ensureAutodevBranch` in `register` | codex |
| `src/api/server.ts` | +`POST /fs/git-init`, +`GET /system/git`; admin-port-gated | codex |
| `src/detect/*` (or new `src/detect/detect-git.ts`) | git executable probe | codex |
| composition root (`src/index.ts`) | defensive startup `ensureAutodevBranch` over registered projects | codex |
| `ui/src/components/FolderBrowser.tsx` | any-folder select + inline "init git" | review-only |
| `ui/src/views/NewProjectView.tsx` | git-not-installed banner + "Install it now"; untracked hint | review-only |
| `ui/src/lib/{api,queries}.ts` | `postGitInit`, `getSystemGit` clients + hooks | review-only |

## 6. Error handling

- All new endpoints admin-port-gated: **404** when no admin port (read-only deploy),
  matching `handleFsDirs`/`handleDetectAgents`.
- `POST /fs/git-init`: invalid/existing-git path → typed **400**; real fs/git failure →
  **500**; git-not-installed → typed **400** with an actionable message (UI already
  guards, but the endpoint stays honest).
- `admin.initGit` does all git work **before** any registry mutation (init is a separate
  step from register anyway) — no half-registered state.
- Defensive-startup `ensureAutodevBranch` is **best-effort/never-throws** (`safeLog`
  pattern, gotcha `[ts/fail-closed]`): a single broken project logs a WARN and does not
  abort startup or the other projects.
- `ensureAutodevBranch` never stashes or discards operator changes; a dirty tree carries
  over untouched.

## 7. Testing

- **`git.ts`**: unit-test each new verb against a real temp repo (init → empty commit →
  branch create/switch → untracked count). Reuse the `git.test.ts` temp-repo harness.
- **`ensureAutodevBranch`**: table of start-states → expected end-branch: on-`autodev/*`
  (no-op), on-`master` with no autodev branch (creates `autodev/main`), on-`master` with
  an existing `autodev/x` (switches, no recreate), dirty tree (carries over), fresh
  init-ed repo (lands on `autodev/main`).
- **`fsbrowse`**: hidden/system entries filtered (win32 attribute + POSIX dotfile);
  non-hidden entries and the `isGitRepo` badge unaffected.
- **`admin.initGit`**: non-git folder → git repo on `autodev/main` + files stay
  untracked (`untrackedCount` > 0); already-git path → typed rejection.
- **`admin.register`**: non-git folder now registers; existing-repo-on-master ends on
  `autodev/main`.
- **server**: `POST /fs/git-init` + `GET /system/git` happy paths, 404-without-admin,
  typed 400s.
- **detect-git**: PATHEXT probe finds `git.exe`/`git`; absent → `{ installed: false }`.
- **Live-verify (operator)**: after merge, register a fresh non-git folder → init git →
  run; and confirm the already-registered `woodev-shipping-plugin-test` (on `master`)
  auto-switches to `autodev/main` at startup and its first run no longer trips the guard.

## 8. Sequencing note

The s30 Task 1 branch-guard fix is delivered by 3d + the defensive-startup wiring. The
manual meanwhile-unblock stays available (`git -C <project> checkout -b autodev/work`).
Once this ships, the defensive startup pass fixes pre-existing projects automatically.
The orphan (B) and dedup (C) follow-ups remain out of scope here.

## Related

- `next-session-promt.md` (gitignored) — s30 Task 1/B/C brief.
- `docs/CURRENT-STATE.md` — s30 priority block.
- gotchas: `[ops/daemon-run]` (branch guard), `[detect/executable-probe]` (probe),
  `[ts/fail-closed]` (never-throws), `[conductor/real-repo-run]` (clean-tree at merge),
  `[scaffold/symlink-escape]` (scaffold guards to preserve).
