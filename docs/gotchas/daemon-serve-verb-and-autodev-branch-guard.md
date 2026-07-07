# `[ops/daemon-run]` — the `serve` verb, the `^autodev/` branch guard, and running the UI

Operational facts hit during the s29 live check. These stay true regardless of the s30 scaffold auto-branch fix.

## Run the daemon with the `serve` verb — the bare binary is the conductor
`node dist/index.js` **with no verb** defaults to conductor **`run`** mode (decompose → enqueue → bounded trigger),
which immediately dies with:
```
[ERROR] conductor: refusing to run on branch 'main' (must match ^autodev/, never main)
```
To start the **HTTP daemon + dashboard**, pass `serve`:
```
node dist/index.js serve            # binds 127.0.0.1:4319
```
Symptom of the mistake: "the daemon won't start, it errors" — they ran the bare binary, not `serve`.

## `:4319/` serves the built UI directly — no vite needed to *look*
The `serve` verb serves `dist/ui/` as the SPA at `http://127.0.0.1:4319/`. So after `npm run build:ui`, just run the
daemon and open `:4319/` — vite (`cd ui && npm run dev`, :5173) is only for hot-reload dev, and it needs the daemon on
:4319 in parallel for data (its `/projects` proxy target). For a plain visual check, one process (`serve`) is enough.

## The conductor only runs on an `^autodev/` branch
Guard: `src/conductor/conductor.ts:517` — `git.currentBranch()` of the MAIN repo must match `cfg.allowedBranchPattern`
(default `^autodev/`, `src/config/schema.ts:45`) and never be `main`. So a run only proceeds when the **project repo**
is checked out to an `autodev/*` branch (the conductor branches per-task worktrees off it). A project sitting on
`master`/`main` is refused. Manual unblock: `git -C <project> checkout -b autodev/work`.

**Onboarding trap (being fixed in s30):** New Project scaffold (`src/registry/scaffold.ts`) writes `.autodev/` but does
NOT switch the repo to an `^autodev/` branch, so the *first* run always trips this guard. Also note decompose+enqueue
run BEFORE the trigger/guard, so a guard-failed launch leaves an **orphaned PENDING task** (re-launching stacks dupes) —
clean via `.autodev/queue/pending/*`.

## Related
- [[project-autodev-harness]] · guard: `conductor.ts:517` · scaffold: `registry/scaffold.ts` · pattern default: `config/schema.ts:45`
- s30 fix brief: `next-session-promt.md` (gitignored).
