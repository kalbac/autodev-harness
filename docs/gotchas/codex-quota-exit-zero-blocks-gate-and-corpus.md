# A codex quota refusal exits 0 with no verdict — and takes the evaluation corpus down with the review gate

**Tag:** `[ops/codex-quota-exit-zero]` · Found s57 (2026-07-26)

## What happens

`codex exec` refused every call with:

```
ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex, or try
again at Aug 24th, 2026 11:50 PM.
```

Two things about that are traps, and the second is worse than the first.

## 1. The refusal exits 0 — a review that produced NOTHING looks like a review that found nothing

The run echoed the whole 87 KB prompt to stdout, printed the limit error twice at the
very end, and **exited 0**. A backgrounded review therefore reports "completed (exit code
0)" and leaves an 86 KB output file that *looks* like a full session transcript. Nothing
in the exit code, the size, or the shape of the output distinguishes it from a real
review.

This is a live hazard for this project specifically, because the whole discipline is "an
independent critic gated it". Recording SAFE from an output that contains no verdict would
be **critique theater with a receipt** — precisely the failure `PRINCIPLES.md` #5 exists
to prevent, arrived at by accident rather than by argument.

**Rule: a codex gate run is only a gate run if its output contains an actual verdict.**
Grep the output for the verdict line (`VERDICT:` / the findings' severity labels) before
believing it. Absence of findings is never evidence of a clean review — the same
"could-not-determine is not a no" rule the code paths already follow
(`[gate/oracle-protected-paths-must-be-worktree-relative]`), applied to our own process.

## 2. One provider outage takes out BOTH the review gate and the measurement

Non-obvious, and it is the expensive half. Two things that read as independent share a
single provider:

- the **review gate** on the harness's own work (codex `gpt-5.6-luna`, pinned since s44);
- the **Evaluation Corpus**, whose runs drive the *harness's* critic — which is the same
  `codex exec`.

So a single account quota simultaneously blocks (a) merging anything, and (b) *measuring*
whether the harness improved. In s57 that killed the session's entire deliverable: #123's
fix is only meaningful as a before/after `first_pass_commit_rate`, and neither the fix nor
the measurement could be run.

The critic model is also **calibrated** (s44: `sol` false-blocks correct work, `terra`
misses a real bug ~1 in 3, `luna` 12/12), so swapping in whatever other CLI is on PATH is
not a drop-in substitute — an uncalibrated critic changes the gate's quality silently.
That makes the substitution an ORACLE-level decision for the operator, not a mechanical
workaround. `adr/003` permits any vendor in the critic role; s44 is why it still has to be
calibrated first.

## What to do

- Check quota BEFORE planning a session around either a gate pass or a corpus run:
  `printf 'Reply with exactly: PONG' | codex exec --model gpt-5.6-luna --skip-git-repo-check -`
  costs almost nothing and fails in seconds.
- Ungated work is **committed on a branch, never merged** — mechanical verification (tests,
  typecheck, CI) is not the gate and does not substitute for it (`PRINCIPLES.md` #2, #6).
- The durable fix is a second calibrated critic in the roles matrix so the gate is not a
  single point of failure. Not a workaround to improvise mid-session.

## Related

- `docs/gotchas/gpt-5-6-critic-variants-sol-blocks-terra-misses.md` — why the critic model
  is pinned, and why an uncalibrated substitute is not free.
- `docs/gotchas/codex-cancel-broken-under-git-bash.md` — the other reason not to trust a
  codex job's *status* over its actual output.
- `docs/PRINCIPLES.md` #2 (the worker has no authority over acceptance), #5 (self-critique
  is never the gate), #13 (evidence, not assertion).
