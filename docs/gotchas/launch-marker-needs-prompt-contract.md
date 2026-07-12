# `[chat/launch-marker-needs-prompt-contract]` — a control marker the backend DETECTS is dead unless the PROMPT teaches the model to EMIT it

**Found:** s40 live-prove (through the real daemon + browser).

## What happened

s40 added "launch by word": the operator can type "go" and the orchestrator emits a `[[LAUNCH]]` control marker that the backend (`ThreadChatService.sendMessage`) detects (as a standalone line in fenced-code-stripped prose, guarded by "a plan exists / not yet launched / live session") and treats as consent to launch. The backend detection was fully implemented and unit-tested (`launch-marker.ts` + guard tests). **But the feature was DEAD in production:** the orchestrator chat prompt (`buildChatOpeningPrompt` in `chat-prompt.ts`) was never updated to tell the model the marker exists — it even said "you ... cannot ... trigger a run yourself." So the model never emitted `[[LAUNCH]]`; it just narrated ("handing off to the launch step") while the backend saw no marker and never launched. Every unit test passed; the live run silently stayed `chatting`.

## The trap

A feature split across two halves — **DETECT** (deterministic code) and **EMIT** (an instruction in an LLM prompt) — is only half-built if you test the detect half in isolation. Self-authored unit tests feed the marker in directly, so they're green regardless of whether any real model would ever produce it. Same class as `[orchestrator/llm-retitle-breaks-task-level-dedup]` and `[gate/agent-ci-ndjson-keyed-by-event-not-type]`: a contract between code and an LLM must be verified END-TO-END with a real model, not just on the code side.

## Fix / rule

- Whenever backend code keys off a token/shape an LLM is supposed to produce, the SAME change set must add the instruction to the prompt that produces it — and a test that pins the prompt actually contains the contract (`chat-prompt.test.ts` now asserts the prompt teaches `[[LAUNCH]]`, "only after a plan," "only on an explicit request").
- Live-prove any code↔LLM contract with a real model; a green detect-side unit test proves nothing about emission.

## Related
- `[orchestrator/llm-retitle-breaks-task-level-dedup]`, `[gate/agent-ci-ndjson-keyed-by-event-not-type]` — same "don't trust self-authored fixtures for an LLM contract" class.
- `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — the attended-presence feature this belongs to.
