# Spec — Run rename + archive (+ UI re-run) (s23)

> Status: APPROVED (operator design-gate s23, after donor recon AO/OD/OpenHands).
> Backlog item from CURRENT-STATE NEXT ACTIONS #3 (was unscoped — this is the design pass).

## Decisions (operator-gated)

1. **Scope:** Rename + Archive as backend verbs; **Fork → UI-only "re-run intent"** (pre-fill
   the composer with a run's intent — NO backend fork). Donor recon: AO has no run fork; OD/OpenHands
   fork a *conversation/event-stream* (which we don't have). Our run manifest is a **re-derivable index**
   over the blackboard queue (the source of truth), so a real "fork" ≈ re-orchestrating the same intent —
   which is what POST /orchestrate already does. Re-run = pre-fill + launch, no new semantics.
2. **Archive = reversible soft-flag** `archived_at` (AO's proven project-level pattern). `GET /runs` hides
   archived by default; `?includeArchived=1` includes them; unarchive clears the flag. **No hard-delete.**
3. **The manifest is a pure INDEX.** Rename/archive touch ONLY the manifest file — never the blackboard
   queue, tasks, worktrees, or gate. runId stays the immutable key (donor-unanimous: rename never touches id).

## Backend (full TDD → codex GPT-5.5 gate → re-critic — new mutation surface)

All in `src/api/server.ts` (mirrors `handleReply`/`handleGetRun`/`handlePatchConfig` — project-scoped state
under `p.stateDir/runs`, no admin port; the manifest write is like the escalation-reply write).

- **`RunManifest` interface** (+ the `api.ts` UI mirror): add `name?: string`, `archived_at?: number`.
- **`isRunManifest`:** validate the new optional fields' TYPES when present (`name` string, `archived_at`
  finite number) so a corrupt manifest can't leak a bad value. Absent fields stay backward-compatible —
  `recordRun` (unchanged) writes manifests without them.
- **`applyRunPatch(manifest, {name?, archived?}, now): RunManifest`** — exported PURE merge (unit-tested):
  `name` trimmed, empty → delete (un-rename back to intent); `archived` true → `archived_at = now`, false →
  delete. Never assigns explicit `undefined` (exactOptionalPropertyTypes) — uses `delete` on the copy.
- **`GET /runs`** gains `?includeArchived=1|true`: default filters `archived_at !== undefined` out.
- **`PATCH /projects/:id/runs/:runId`** (new `handlePatchRun`): validate id (`safeIdSegment`) + body
  (`name` string ≤200 / `archived` boolean; at least one; else 400) → bounded read (`readBoundedManifest`,
  null → 404) → **lstat symlink-guard the manifest file** (`[scaffold/config-file-symlink]` class — a
  symlinked `runs/<id>.json` must not be followed on write) → `applyRunPatch` → plain overwrite → return the
  fresh manifest. 413 body-cap teardown pattern like the other write handlers.
- Route it in the dispatcher's project block, AFTER the root-resolve (project-scoped, needs `p.stateDir`),
  next to the `GET /runs/:id` match.

## UI (review-only, static)

- `RunManifest` mirror in `api.ts` (+`name?`/`archived_at?`); `api.patchRun(projectId, runId, patch)`;
  `api.getRuns` gains an `includeArchived` option.
- `usePatchRun` mutation (invalidates the runs list); `useRuns` default (archived hidden server-side).
- **Display `name ?? intent`** everywhere a run is labelled: `HomeView` RunCard, `ProjectRow` sidebar,
  `RunView` header.
- **`RunView` actions bar:** inline Rename, Archive/Unarchive toggle, Re-run (seed the composer intent →
  navigate to `/p/:id`). Re-run seeds via a tiny zustand store (`useComposerSeed`), read+cleared by
  `NewRunComposer` on mount.
- **`HomeView`:** a "Show archived" toggle (flips `useRuns` to `includeArchived`) so an archived run stays
  reachable (to unarchive); archived cards get a muted `archived` tag.

## Non-goals / dropped
- Backend fork/duplicate (dubious semantics on a re-derivable index — re-run covers the 80%).
- Hard-delete of a run manifest (archive is reversible; add later only if asked).
- `forkedFrom` lineage (only meaningful with a real backend fork).

## Related
- Donor recon (this session): AO `display_name` + project `archived_at`; OD/OpenHands conversation fork.
- `src/orchestrator/capabilities.ts` `recordRun` (the manifest writer — UNCHANGED, forward-compatible).
- gotchas `[scaffold/config-file-symlink]`, `[api/413-teardown]`, `[api/static-traversal]`.
