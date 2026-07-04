# `[conductor/per-round-overwrite-stale]` — a per-round "latest value" runtime artifact goes stale when a later round yields nothing to write

**Tag:** `[conductor/per-round-overwrite-stale]`
**Discovered:** s24 (critic-verdict.json persistence, codex gate finding).

## The trap

When the conductor persists a per-task runtime artifact that represents a **latest single value** (not an accumulation) by writing it **on every round of the retry loop**, a later round that produces **no value to write** leaves the *previous* round's value on disk — now stale and contradicting the task's actual decisive outcome.

Concretely, the first-cut `critic-verdict.json` persistence wrote the verdict on every round guarded by `if (cr.verdict)`. Sequence that breaks it:

1. Round 0: critic returns a parseable `uncertain` (non-contract, rounds remain) → persisted → retry.
2. Round 1: critic returns `null`/unparseable → escalates. The `if (cr.verdict)` guard skips the write.
3. On disk: the round-0 `uncertain` survives. The dashboard shows `uncertain` for a task whose **final** critic run produced no parseable verdict — a stale, misleading artifact.

This is subtle because the sibling `token-usage.json` (s22) uses the SAME "write every round" shape and is **safe** — it *accumulates* (monotonic sum across rounds), so there is no "later round unwrites an earlier value" case. The overwrite-latest semantics is what introduces staleness; the accumulate semantics does not. Copying the token-usage pattern verbatim for a latest-value artifact imports the bug.

## The rule

For a **latest-value** overwrite artifact, persist **only at the loop's DECISIVE points** — the exit that commits (clean break) and the exit that ends the task (escalation) — and only when there is a real value:

```ts
// clean → commit:
if (cr.verdict?.verdict === "clean") { await persistCriticVerdict(cr.verdict); break; }
// escalate:
if (contractRisk || round >= maxRounds) {
  if (cr.verdict) await persistCriticVerdict(cr.verdict); // parseable only; null writes nothing
  ...escalate/return...
}
// intermediate retry rounds: do NOT persist.
```

Because intermediate rounds never write, a final valueless (null) round leaves **no** artifact at all (honest — "no parseable decisive verdict") rather than a stale earlier one. No delete/clear capability is needed. Regression-test the multi-round `parseable → retry → null → escalate` sequence and assert the file is **absent**.

Contrast: an **accumulate** artifact (token-usage) is safe to write every round — a later round only adds to the sum, never invalidates it.

## Related
- `never-throws-catch-block-logging.md` (`[ts/fail-closed]`) — the best-effort/never-throws discipline both artifacts share.
- `ui-verdict-not-persisted.md` (`[ui/verdict-not-persisted]`) — the gap this persistence closes.
