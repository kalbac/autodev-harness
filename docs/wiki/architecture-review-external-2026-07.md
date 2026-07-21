# Architecture Review — External (2026-07)

> **Provenance.** An external LLM agent (GPT) studied the repository and produced a
> product/architecture critique. This note is an **English summary** of that review
> plus **our disposition** on each point (English-only per `AGENTS.md`; the original
> was in Russian). Captured 2026-07-21 (s47). It is the seed for `adr/006` (Authority
> Model) and the profiles/qualification-layer thrust — kept for traceability of *why*
> those decisions were made.
>
> This is an **Architecture Note** (rationale — *why*, not API). See `PRINCIPLES.md`
> for the invariants it feeds.

## One-line verdict from the review

> The harness — not the model — is the durable asset. The strategic goal is **not a
> smarter model**, but to increase the number of product properties the harness can
> **independently and mechanically prove**.

## Risks raised — and our disposition

| # | Risk | Our disposition |
|---|---|---|
| 1 | Docs must have a single source of truth; history must not compete with current architecture. | **Done (s47).** Achieved via file-roles (VISION/PRINCIPLES/CURRENT-STATE/SESSION-LOG/adr), not a `current/history/adr` folder split — the split was judged unnecessary churn. |
| 2 | `CURRENT-STATE` must not become a dev journal — only "what is true right now". | **Done (s47).** Slimmed 139 KB → ~8 KB; replace-not-append discipline recorded in `DOCS-SCHEMA`. |
| 3 | Mechanical gates prove only *formalized* properties (not business-logic correctness, requirements, completeness, UX). Corollary: the better the spec + acceptance oracle, the stronger the harness. | **Accept as a principle** — to be added to `PRINCIPLES.md`. Also the core argument for profiles (a profile = more formalized properties). |
| 4 | Critic monoculture — one universal critic will over-generalize; split by domain (correctness / security / architecture / WP-WC / product-requirements), selected by change risk. | **Forward-looking.** Partly subsumed by profiles (a WP/WC profile introduces the first "domain critic" via a critic-rubric). Not a near-term standalone. |
| 5 | Reward hacking shifts to the checks once the worker can no longer self-declare DONE: weakening tests/assertions/fixtures/CI/gate-config, disabling analyzers, editing acceptance criteria. **"Worker must never control its own oracle."** | **Highest-priority gap.** Acceptance criteria, hidden tests, gate config, CI, protected paths, release config must sit **outside the worker's write authority**, by capability not role name. We have pieces (orchestrator forbidden-paths, contract-zones) but no unified, audited Authority Model → **`adr/006` + an audit**. |
| 6 | A local worker model becomes an operational constraint at factory scale (inference queue, memory contention, retry storms, long autonomous runs). The model router should weigh expected completion time, queue depth, context size, error history, retry cost. | **Forward-looking.** Only matters at factory scale; defer. |
| 7 | A Plugin Factory needs a separate **Qualification Layer** — a universal SDLC engine and a WooCommerce Plugin Factory are different levels. Harness proves the *process*; the Qualification Layer proves the *product*. | **Accept — this is the "profiles" thrust.** Concrete WP/WC gate set below. Our `gate.agentCi` is the substrate; a profile productizes it (reusable per project-type pack + hidden-tests + critic-rubrics the repo's own CI lacks). |

### The WP/WC Qualification Layer (risk 7, concretely)

A production-ready WooCommerce plugin needs, at minimum: PHP lint · `composer validate`
· PHPCS/WPCS · PHPStan/Psalm · PHPUnit · wp-env · WooCommerce compatibility matrix ·
HPOS · Plugin Check · REST permission tests · nonce/capability checks · activation
tests · migration tests · package inspection.

## Priorities proposed — and our order

1. **Fix the Authority Model.** Formally define who may modify: task contract,
   acceptance criteria, hidden tests, gate policies, CI config, protected paths,
   release config — by **capabilities, not role name**. *(Our s48 priority.)*
2. **Build the WP/WC Qualification Layer** as a reusable profile:
   ```text
   profiles/wordpress-woocommerce/
     ├── policies/  ├── gates/  ├── hidden-tests/  ├── compatibility/
     ├── critic-rubrics/  ├── environment/  └── release/
   ```
3. **Separate a successful Run from a successful Product** — two independent reports:
   a **Harness Execution Report** (orchestration/critic/gates/budgets) and a **Product
   Qualification Report** (requirements/compatibility/security/release artifact). Do
   not mix them.
4. **Build an Evaluation Corpus** — real tasks (feature/bugfix/migration/integration/
   security/WC-compat) with metrics: first-pass gate rate, critic precision, rework
   count, escaped defects, human interventions, wall-clock, cloud cost, local tokens,
   post-release defects.

## The coherent architecture (our synthesis)

These are not independent — they chain, and the order is load-bearing:

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
(oracle outside     (per-project-type proof pack,      (Run vs         (metrics on real
 worker authority)   e.g. WP/WC)                        Product)        tasks)
```

Authority Model is first because without it a profile's gates are gameable (risk 5) — a
profile over an unprotected oracle is theater.

**Relation to `adr/004`:** the per-project **north-star** doc (an anti-drift anchor for
one repo) and a **profile** (an anchor + oracle for a project *type*) are relatives —
north-star may be **folded into** the profile concept rather than built separately.

## Also validated (already implemented, per the review)

Independent critic · fail-closed · anti-drift · contract guards · bounded rework ·
escalation handling · deterministic supervision · worktree isolation · mutation checks ·
invariant checking · agent-CI · role/model separation. (I.e. materially more than an
"LLM wrapper".)

## Related

- `PRINCIPLES.md` — the invariants (risk 3 + "worker never controls its oracle" feed it).
- `adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — north-star ↔ profile relation.
- `CURRENT-STATE.md` — where the Authority-Model → Profiles thrust sits in the plan.
- (planned) `adr/006` — the Authority Model.
