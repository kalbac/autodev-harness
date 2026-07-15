# `[gate/critic-before-ci-blocks-testless-repos]`

**The agent-ci CI step is downstream of a critic-clean verdict, and the critic hard-demands a guard/test for any behavioral change — so in a repo with no reachable test infra, no FEATURE task can ever reach (let alone pass) CI.**

Two facts combine:

1. **Gate ordering.** In `conductor.ts` the round loop runs the CRITIC first; only a `clean` verdict `break`s out to `runGate` (checkCommand + `agent-ci`). A non-clean critic verdict escalates (or retries then escalates) and NEVER reaches the gate. So `gate.agentCi` CI only ever runs on work the critic already blessed.

2. **The critic prompt hard-codes a coverage demand** (`src/critic/prompt.ts:46,65`): "conclude `clean` if you cannot find a broken contract, **a missing guard**, or a fabricated proof" + "For each touched zone, is there a guard/test that actually covers it?". At `effort: high`, codex GPT-5.5 treats a new public method with no test in the diff as a broken contract ("fails the requested adversarial review standard"). This is prompt-level, NOT tunable via `roles.critic.effort`.

**Consequence, proven live s41 on `woodev-shipping-plugin-test` (WooCommerce plugin, tests/ is empty scaffolding, phpunit needs wp-env → no reachable test infra):**
- A `WC_Integration` feature → critic `broken` (load-order + no coverage) → escalate.
- Even a trivial, correct `get_shipping_settings_url()` getter → critic `broken 0.73` ("missing coverage/guard for a new public contract") → escalate.
- Only a **behavior-neutral change** (a class-level PHPDoc docblock — nothing to guard) passed the critic clean → reached the gate → **agent-ci ran the real `ci.yml` green (5/5) → COMMIT → DONE** (`3609a2c`).

So the ONLY way to demonstrate/exercise CI end-to-end on such a repo today is a docs/comment-only change. Any real feature is blocked before CI by the critic's coverage demand.

**Open product question (raised by operator s41):** the ordering (critic → CI) plus the critic's absolute coverage demand means CI is unreachable for features in test-less repos. Options to discuss: run CI as an EARLIER/independent gate step (not gated behind critic-clean); make the critic's "missing guard" demand context-aware (soften when the repo has no test harness); or treat "add a test" as part of the task contract. Not yet decided.

Found s41.

## Related
- [[reply-b-rework-drops-critic-feedback]] — same session; the rework loop that couldn't recover from these escalations.
- [[agent-ci-workflow-container-no-checkout]] — how the CI workflow itself must be shaped for agent-ci.
- [[agent-ci-ndjson-keyed-by-event-not-type]] — the agent-ci event stream.
