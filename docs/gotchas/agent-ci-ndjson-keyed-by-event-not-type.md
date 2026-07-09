# `[gate/agent-ci-ndjson-keyed-by-event-not-type]`

> Found s37 (2026-07-10), in the agent-ci gate-hardening live-prove. Detail file for
> the `docs/GOTCHAS.md` index. A textbook "don't ship a parser built on a guessed wire
> shape" catch — the live-prove earned its keep exactly as the s32 dedup lesson predicted.

## The gotcha

The `agent-ci.ts` NDJSON parser (`parseWorkflowOutcome`) was first written **defensively
against a GUESSED event shape** — it keyed the terminal event off `obj["type"]`
(`type === "run.finish"`), because the real wire format hadn't been captured yet (the plan
deliberately flagged this as "confirm via a real `--json` probe, do not hardcode").

The REAL `@redwoodjs/agent-ci@0.16.2` stream (captured live under WSL+Docker) keys every
event by **`event`, NOT `type`**:

```json
{"event":"run.start","ts":"...","schemaVersion":1,"runId":"run-..."}
{"event":"step.finish","ts":"...","step":"Run node","index":3,"status":"passed","durationMs":272}
{"event":"job.finish","ts":"...","job":"check","workflow":"ci.yml","status":"passed"}
{"event":"run.finish","ts":"...","status":"passed"}      // terminal; "failed" on a red run
```

Had this shipped keyed on `type`, **every real agent-ci run — pass OR fail — would have
carried no `type` field, so the parser would have found no terminal event → returned
`"infra"` → the module would THROW → the gate would ESCALATE on literally every run.** The
feature would have looked "safe" (all unit tests green: they used the guessed `type` shape)
but been 100% useless in production — it could never return a real pass/fail, only escalate.

## The fix

- Terminal-event detection keys off `obj["event"] ?? obj["type"]` (real `event` first,
  `type` kept as a defensive fallback for a future/alternate build).
- The verdict is read from the `status` field (`"passed"` / `"failed"`), which
  `terminalVerdict` already handled — that half of the guess happened to be right.
- Two VERBATIM real-NDJSON regression tests (one passing stream, one failing stream, copied
  byte-for-byte from the live capture) now lock the real shape so a refactor can't silently
  regress to the wrong key.

## Rule / lesson

- **Never ship a parser for an external tool's/LLM's wire format on a guessed shape.** Unit
  tests written against the guess are vacuously green — they prove the parser matches the
  guess, not reality. Capture the REAL output once and pin a verbatim fixture. (Same class as
  `[orchestrator/llm-retitle-breaks-task-level-dedup]`: a heuristic tested only with
  self-authored fixtures passes while missing what production actually emits.)
- The defensive-parser instinct (tolerate extra/unknown fields, fail-closed) was still
  correct and made the fix a one-line key change rather than a rewrite — but defensiveness is
  not a substitute for one real capture.
- This is why the plan mandated a live-prove BEFORE merge even for an off-by-default feature.
  It paid for itself: a passing-tests-but-always-escalates feature would otherwise have merged.

## Related

- `src/gate/agent-ci.ts` — `parseWorkflowOutcome` / `terminalVerdict`.
- `docs/superpowers/plans/2026-07-10-agent-ci-gate-hardening.md` — flagged this risk up front.
- `[gate/agent-ci-not-runnable-on-native-windows]` — sibling live-prove finding.
- `[orchestrator/llm-retitle-breaks-task-level-dedup]` — the same "test-against-your-own-guess" trap.
