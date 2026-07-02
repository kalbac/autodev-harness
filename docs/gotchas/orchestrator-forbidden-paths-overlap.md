# Gotcha: LLM decompose can emit `forbidden_paths` that overlap `file_set` (impossible spec)

**Tag:** `[orchestrator/forbidden-paths]`
**Found:** s12 (2026-07-02), first live `orchestrate` run on aurora.

## Symptom

A live `orchestrate` run escalated `dirty-file` BEFORE the gate, even though the worker touched
exactly the one file in `file_set` and reported `DONE`. The escalation evidence read:

```
stray:
forbidden: server/app/Services/Llm/LlmServiceFactory.php
```

i.e. the fence flagged the task's OWN required file as a forbidden touch.

## Root cause

The opus decompose emitted a self-contradictory task spec:

```yaml
file_set:
  - server/app/Services/Llm/LlmServiceFactory.php
forbidden_paths:
  - server/app/Services/Llm/*
  - "!server/app/Services/Llm/LlmServiceFactory.php"   # gitignore-style negation
```

The LLM tried to express "forbid everything in the Llm dir EXCEPT the target file" using a
gitignore-style `!` negation. **The harness glob matcher (`src/util/glob.ts` `globMatch`) supports
only `*`, `?`, `**` — no `!` negation, no gitignore semantics.** So the `!…` line was matched as a
literal glob (never matches anything), while `…/Llm/*` matched the very file `file_set` required. The
dirty-file fence (`forbiddenTouches`, `src/util/fingerprint.ts`) correctly flagged it. **Enforcement
was right; the decompose output was impossible to satisfy** — and `validateTaskSpec` had ACCEPTED it,
because the strict schema validated each field in isolation and never cross-checked `file_set` against
`forbidden_paths`.

## Fix (commit `e7dbb46`, branch `autodev/s12-orch-liveproof`)

Two layers:

1. **Trust-boundary guard** — `src/orchestrator/task-spec.ts`: a `.superRefine` on `TaskSpecSchema`
   rejects any spec where a `forbidden_paths` glob matches a `file_set` entry, reusing the fence's
   EXACT normalize-then-`globMatch` semantics (`normalizePath` was moved to `util/glob.ts` and exported
   so validator and fence share one implementation and can never diverge). A contradictory spec now
   fails LOUD at `validate-all-or-nothing`, before a worker is ever spawned.
2. **Prompt doc** — `src/orchestrator/decompose-prompt.ts` now tells the orchestrator LLM: globs support
   only `*`/`?`/`**` (no `!`/gitignore); NEVER list a `forbidden_paths` entry that overlaps `file_set`
   (`file_set` already scopes what may be touched; anything outside it is auto-rejected by the fence);
   leave `forbidden_paths` empty for a "touch only these files" task.

## Lesson

`forbidden_paths` is redundant for the common "touch only these files" task — the stray-file fence
already rejects anything outside `file_set`. Reserve `forbidden_paths` for extra-sensitive siblings NOT
in `file_set`. When adding an LLM-authored field to the harness, spell out its exact matching semantics
in the prompt AND cross-validate it at the trust boundary — an LLM will otherwise assume the most common
ecosystem semantics (gitignore), which the harness may not implement.

## Related

- `[config/zod-strict]` — the other s11/s12 class of "a spec passed validation but meant something else".
- `docs/superpowers/specs/2026-07-02-orchestrator-layer-design.md` §3 (`validateTaskSpec` = sole trust boundary).
- `docs/gotchas/orchestrate-background-run-killed.md` — the other s12 live-run gotcha.
