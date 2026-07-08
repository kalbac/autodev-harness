# `[ui/fire-and-forget-action-needs-feedback-at-point-of-action]` — a background action's real outcome must be surfaced where the operator took the action, not only on a page they'd have to know to visit

**Symptom (s32, live-found by the operator).** `POST /orchestrate` is fire-and-forget by design (202 immediately;
R1-safe — see `handleOrchestrate`'s doc comment). The real outcome (a new task enqueued / a relaunch-dedup skip /
a 0-task decomposition / a rejected batch) is decided in the background and reported ONLY as a
`[orchestrator] [LEVEL]` line appended to `digest.md`. The composer (`NewRunComposer`, rendered on `Home`) showed a
static "Run accepted — decomposing intent…" message that never updated once the background outcome was known. The
ONE place that renders the digest tail (`DigestStrip`) lives on `RunView` — a *different page*, reached by clicking
into a specific run. When the outcome was "nothing enqueued" (a dedup skip), there is no NEW run to click into at
all. Net result: the operator saw the accepted-message and then nothing, ever — indistinguishable from a silent
failure, even though the backend behaved exactly as designed and logged its reasoning correctly.

**Cause.** The backend's async/fire-and-forget contract and the frontend's feedback surface were designed and
built independently, at different times (the orchestrate endpoint pre-dates `DigestStrip`, which itself was built
for `RunView` specifically). No one asked "where does the operator find out what happened to THIS action, from
the page where they took it" for the no-op paths — the happy path (a new run appears in "Recent runs") accidentally
covers for the gap, so it was never noticed until a real duplicate-intent scenario made it and its escalation-lifecycle
state ambiguous side-effects visible together.

**Fix (PR #60):** reused the SAME live data (`digestTail`, already WS-invalidated on every digest write — no new
backend needed) directly on the page the action was taken from, watching for the first new outcome line after the
action and surfacing it as a toast.

**Lesson:** for any fire-and-forget / background-resolved action, ask explicitly at design time: "if this
does nothing (a legitimate no-op, not an error), how does the operator find out, from the exact screen where they
clicked?" A background action whose only feedback channel lives on a page reachable ONLY via a side-effect the
no-op path doesn't produce (here: a new run to click into) is a silent failure in practice, however correct the
backend logic is. This generalizes beyond orchestrate — any future action ported to the same fire-and-forget
pattern needs the same check before shipping.

## Related
- [[replied-escalation-holds-filelock]] — a different flavor of "a state transition happened but nothing told anyone" from s25/s26.
