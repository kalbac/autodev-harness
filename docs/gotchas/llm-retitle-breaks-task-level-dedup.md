# `[orchestrator/llm-retitle-breaks-task-level-dedup]` — a task-level (file_set+title) dedup heuristic misses a real relaunch because the LLM re-titles identical work every decompose

**Symptom (s32, live-found).** Shipped a relaunch-intent dedup guard (`isDuplicateTask`) requiring BOTH a `file_set`
overlap AND a normalized-title match. 6 unit tests passed (all built with controlled, identical titles). Live-proving
on a real orchestrate — the exact scenario the feature exists for — found it missed a genuine relaunch: launching the
SAME intent twice produced two tasks with the same `file_set: [DEDUP-PROOF.md]` but DIFFERENT titles ("...verifying
relaunch-intent deduplication" vs "...verification note at repo root"), because opus (the decompose adapter) freely
re-titles identical work on every call. The AND-title-match failed, dedup fail-opened, the duplicate enqueued.

**Cause.** Task-level identity (title, id) is LLM OUTPUT, not stable across two decompositions of the same operator
intent. A dedup heuristic keyed on LLM-generated fields will drift exactly when it matters most (a relaunch), because
nothing constrains the LLM to phrase the same work identically twice. Unit tests that hand-construct BOTH sides with
the same title can never catch this — the fixture accidentally holds constant the one thing that varies in reality.

**Fix (shipped, PR #58):** dedup on the OPERATOR's intent TEXT instead (normalized, case/whitespace-folded), checked
BEFORE the expensive decompose call. `caps.read.recentRuns()` reads persisted run manifests
(`<stateDir>/runs/*.json`, written by `recordRun`); if the same intent was already orchestrated and that run's task
ids are still `pending`/`active`/`escalated`, skip decompose entirely, enqueue nothing, re-trigger the pool, WARN.
The task-level heuristic was KEPT as a secondary layer (catches other duplicate shapes; harmless when redundant).

**Lesson — test with adversarial/varying inputs, not matched fixtures, when the two sides of a comparison originate
from an LLM.** More generally: proportional live-proving on a feature that interacts with LLM-generated identity
(titles, ids, decomposition shape) is disproportionately valuable — it is exactly where hand-written fixtures
structurally can't reproduce real drift. This is the second time in the project a live run found something 800+
green tests didn't (see also the s31 real-repo prerequisites) — trust the live proof over the green suite for any
change that touches LLM output shape.

## Related
- [[harness-on-real-repo-prerequisites]] — s09, the first time a real run surfaced gaps a fixture couldn't.
- `docs/wiki/agency-agents-analysis.md` — unrelated pivot from the same session, for context only.
