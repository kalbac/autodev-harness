# PROTOCOL — Mandatory Codex Critic Gate on top of AO (woodev-framework)

> Status: **HISTORICAL** — superseded by `adr/002` (dated the same day, 2026-07-01),
> which demoted AO from fork-base to one donor of four. The **critic-gate policy** this
> document specifies (critic prompt, verdict schema, contract-zone model, re-critic
> discipline) IS what the harness ported and still runs — that is why it stays under
> "what we are porting". The **AO-specific mechanics** (`ao spawn`, `ao review submit`,
> the AO orchestrator session as the driver) were never built and never will be; the
> harness drives the same policy from its own Node conductor.
> Authored 2026-07-01.
> Purpose: port the **adversarial critic gate** from the autodev-loop runbook onto
> the **Agent Orchestrator (AO)** runtime, so that no worker PR merges without an
> independent GPT-5.5 critic pass — the same guarantee we had in autodev-loop, but
> driven by the AO orchestrator session instead of a PowerShell conductor.
>
> Companion docs: `autodev-loop-runbook.md` (the original design — critic prompt,
> contract-zone model, escalation format are reused verbatim from there).

---

## 0. What AO gives us, and what it does NOT

AO replaces the **conductor** and **worktree isolation** of the autodev-loop:

| autodev-loop role | AO equivalent |
|---|---|
| Conductor (PowerShell, immortal, no LLM) | AO daemon + **the orchestrator session (me)** |
| Worker (`claude -p`, disposable, fresh worktree) | `ao spawn` session — each runs a fresh git worktree |
| Critic (`codex exec` GPT-5.5, fenced, read-only) | `/codex:review` run **by the orchestrator** on the worker's PR diff |
| `verdict.json` | codex review output + `ao review submit --verdict` (surfaces in AO UI) |
| Machine gate (`composer check` + guards) | GitHub Actions CI on the PR + orchestrator verification |
| Commit checkpoint | worker PR **merged** (squash) on `approved` + green CI |
| Escalation → Telegram | orchestrator escalates to operator (AskUserQuestion / Telegram) |

**What AO does NOT do for us** — these stay the orchestrator's responsibility:

- It does **not** run any critic. `ao review submit` only *records* a verdict; the
  intelligence (codex GPT-5.5) is wired by us.
- It does **not** auto-route worker model by task complexity. Model is a static
  per-project override (`ao project set-config --model`). See `## 6`.
- It does **not** know our contract zones (`INVARIANTS.md`). The orchestrator must
  apply the contract-zone rules below.

---

## 1. The gate — non-negotiable rule

**No worker PR merges until an independent GPT-5.5 critic has returned a verdict
and (CI is green AND verdict is `approved`).** "Independent" means **not a Claude
model** — Claude reviewing Claude is not an independent check (runbook §4). The
critic is **codex GPT-5.5 high** (this is the explicit operator mandate; the global
"leave model unset" rule is overridden for this gate).

This gate is mandatory in **both** interactive and autonomous modes. The only thing
that changes between modes is *who applies the fixes* (see `## 4`).

---

## 2. Decision flow (per worker PR)

```
worker opens PR  ──►  CI runs  ──►  orchestrator runs codex GPT-5.5 critic on the diff
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────┐
        │ uncertain                            │ broken                          │ clean
        ▼                                      ▼                                  ▼
   ESCALATE to operator              touches contract zone?              CI green + every job CLEAN?
   (never silent pass)                 │ yes ──► ESCALATE                  │ no ──► fix CI first
                                       │ no  ──► send findings back        │ yes ──► ao review submit
                                       │         to worker, re-critic              --verdict approved
                                       │         (max 2 rounds, then               ──► squash-merge
                                       │         ESCALATE)                         ──► delete branch
                                       ▼
                                 ao review submit --verdict changes_requested
```

Mirrors the runbook decision map (§8), re-expressed in AO terms.

---

## 3. Orchestrator procedure — step by step

1. **Spawn the worker** with a clear, scoped task:
   `ao spawn --project woodev_framework --prompt "<task + scope + file_set>"`
   State the file scope and forbid touching contract zones without a guard
   (reuse the WORKER prompt rules from runbook §2).
2. **Track** the session: `ao session ls`, `ao session get <id>`. Steer with
   `ao send --session <id> --message "..."`.
3. **Wait for the worker's PR.** Verify it actually exists and is the right diff —
   do not trust "done" on words (memory: self-verify before merge).
4. **Run the critic** on the PR diff — `/codex:review` (codex GPT-5.5 high),
   **fenced**: the critic reads the diff + repo (read-only) but **not** the worker's
   PR description / rationale (runbook §3 — anti-anchoring).
5. **Apply the decision flow** (`## 2`).
6. **Record the verdict in AO** so it shows in the desktop UI (`## 5`).
7. **Merge only when** CI is green *and* every job is CLEAN (verify per-job, a
   separate step — not an `&&`-grep) *and* the critic verdict is `approved`.
   Squash-merge, delete branch. **Never `gh pr merge --auto`** (it desynced/merged
   at the wrong commit before — memory `feedback_avoid_gh_pr_merge_auto`).
8. **Self-verify** behaviour (e2e + browser on the rig where UI is involved) before
   declaring done (memory `feedback_self_e2e_verify_before_merge`).

---

## 4. Interactive vs Autonomous mode — who fixes

| | **Interactive** (operator at keyboard) | **Autonomous / overnight** |
|---|---|---|
| Critic findings | **Presented verbatim; operator chooses which to fix** (global CLAUDE.md / codex contract). Never auto-fix. | **Fix-if-confident** without draft-review (memory `feedback_autonomous_overnight`). |
| Who applies fix | a fresh worker via `ao send` / re-`spawn`, or operator decides | orchestrator routes a fresh worker; only escalates true judgment calls |
| Re-critic | **Always** re-run codex on the fixes before merge — no self-certify (memory `feedback_recritic_own_fixes`; caught 2 incomplete fixes 2026-06-07) | same — mandatory |

The **re-critic-own-fixes** rule is absolute in both modes: any in-place fix gets a
fresh codex pass before it can satisfy the gate.

---

## 5. Recording the verdict in AO (UI visibility)

This is what makes the critic visible in the AO desktop panel the operator watches.

```bash
ao review submit <worker-session-id> \
  --run <review-run-id> \
  --verdict approved|changes_requested \
  --body review.md \
  --review-id <gh-pr-review-id>
```

- `--body` accepts a **path** or `-` (stdin) so the review text is **never written
  into the worktree** — keep the codex output out of the worker's tree.
- `--review-id` = the `.id` returned by the `gh api` POST that created the PR review.
- `--run <review-run-id>` provenance is **TO CONFIRM on the first real run** — obtain
  it from `ao session get <id>` / the review run AO opens when the PR is claimed. Do
  not fabricate it; verify the source before relying on this step in automation.

---

## 6. Contract zones & model selection (carried over from the runbook)

- **Contract zones** (installed-site data contracts — option keys, license state,
  hooks, cron, REST routes, gateway/instance IDs, meta keys, DB schema) are
  **release-blocking**. A critic `broken`/`uncertain` on a contract zone **always
  escalates** — never auto-retry, never downgrade the worker model. Source of the
  zone list: `CLAUDE.md` → "Backward Compatibility" + runbook `INVARIANTS.md`.
- **Model routing:** AO has no per-task complexity routing. Today the lever is the
  static project override `ao project set-config woodev_framework --model <id>`.
  Until a `--model`-aware spawn wrapper exists, the orchestrator sets a sane default
  and bumps to opus for known-hard / contract-zone tasks by flipping the config
  before that (serialized) spawn. Contract-zone work must **never** land on a
  downgraded model just because a stronger one is busy (runbook §4 fallback 1).

---

## 7. Command cheat-sheet

```bash
# spawn / steer
ao spawn --project woodev_framework --prompt "<task>"
ao session ls
ao session get <session-id>
ao send --session <session-id> --message "<msg>"

# model override (per project/role, static)
ao project set-config woodev_framework --model claude-opus-4-5

# critic (orchestrator)
/codex:review                     # GPT-5.5 high, read-only, fenced from worker rationale
# re-critic the fixes before merge — always

# record verdict in AO UI
ao review submit <session-id> --run <run-id> --verdict approved --body review.md --review-id <gh-id>
```

## Related

- `docs-internal/autodev-loop-runbook.md` — original design; critic prompt (§3),
  contract-zone model (§1 INVARIANTS), escalation format (§6), decision map (§8) are
  reused here verbatim.
- `docs-internal/platform-v2-execution-protocol.md` — operating rules.
- `CLAUDE.md` → "Backward Compatibility — clean-break policy" — contract-zone source.
- `~/.claude/CLAUDE.md` → Codex delegation rule + worker/critic pattern.
