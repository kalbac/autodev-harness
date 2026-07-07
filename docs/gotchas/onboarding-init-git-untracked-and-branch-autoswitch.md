# `[onboarding/init-untracked-and-branch-autoswitch]`

**Tag:** `[onboarding/init-untracked-and-branch-autoswitch]`
**Added:** s30 (2026-07-07)

## The gotcha

The s30 onboarding redesign introduced two behaviors that are correct-by-design but
surprising, and both can bite the FIRST run of a freshly-onboarded project.

### 1. `init git` leaves existing files UNTRACKED → the first merge is blocked

`admin.initGit` (the New Project "init git" button, `POST /fs/git-init`) does
`git init` → an **empty** bootstrap commit (`git -c user.name/email commit
--allow-empty`, so it never fails on a machine with no global git identity) →
`ensureAutodevBranch` → lands on `autodev/main`. It **deliberately does NOT
`git add` the operator's existing files** — they stay untracked (we never commit a
folder's contents blind: no `.gitignore` yet could sweep in `node_modules`, secrets,
etc.). `initGit` returns `untrackedCount` purely so the UI can hint.

The trap: `worktree.mergeAfterGate` refuses to merge when the main tree is not clean,
and it checks `git status --porcelain`, **which counts untracked (`??`) entries**. So
a just-init-ed project with existing files is "dirty" from git's view → the first
task's post-gate merge throws `main working tree is not clean; refusing to merge`.
This is NOT a bug in init — it's repo hygiene: the operator must commit a baseline
(their own `.gitignore` + `git add` + commit) before the first run can merge. The UI
hint ("N untracked files — commit your baseline before the first run") says exactly this.

### 2. Register / startup AUTO-SWITCHES the checked-out branch (no stash)

`ensureAutodevBranch` runs (a) on register when `.git` is present and (b) defensively
at every `serve` startup over each registered project. If the repo is on `master`/`main`
(or any non-`^autodev/` branch), it **switches the working branch** — to an existing
`autodev/*` branch if one exists (never recreated), else it creates `autodev/main` from
the current HEAD. A **dirty tree carries over** (git `checkout`/`checkout -b` preserve
uncommitted changes; we do NOT stash). So an operator who had uncommitted work on `main`
will find themselves on `autodev/main` with that work intact — intended (the conductor
refuses to run off `^autodev/`), but a surprise if unexpected.

### 3. A zero-commit existing repo → typed `branch_ensure_failed` at register

On an UNBORN repo (existing `.git`, zero commits), `git rev-parse --abbrev-ref HEAD`
**exits 128**, so `Git.currentBranch()` throws. `register` no longer swallows this — it
returns a typed `branch_ensure_failed` and does NOT append to the registry (an honest
error instead of a silently-broken registration). The daemon-STARTUP bulk pass still
swallows (best-effort, logs a WARN) — that asymmetry is deliberate.

## Rule

- After "init git", tell the operator to commit a baseline before the first run — an
  all-untracked tree blocks `mergeAfterGate` even though the branch/HEAD are fine.
- Don't add auto-`git add` to `initGit` to "fix" this — committing a folder's contents
  blind is the worse footgun. If a future need arises, scaffold a `.gitignore` first.
- Registering / serving a project can change its checked-out branch. That's the whole
  point of the branch-guard fix; just don't be surprised the working branch moved.

## Related

- Spec: `docs/superpowers/specs/2026-07-07-onboarding-redesign-design.md`
- `[conductor/real-repo-run]` — "main tree must be CLEAN or mergeAfterGate throws" (the mechanism this trips).
- `[ops/daemon-run]` — the `^autodev/` branch guard this fix satisfies.
- `src/util/ensure-branch.ts` (`ensureAutodevBranch`/`initAutodevRepo`/`isInsideWorkTree`), `src/registry/admin.ts`.
