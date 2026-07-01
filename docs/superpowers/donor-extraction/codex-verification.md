# Codex GPT-5.5 Verification — 🔴 Donor Claims + Parity-Spec

> Independent (non-Claude) adversarial verification of the architecture-shaping
> claims in `decision-matrix.md`, run read-only against the actual code in
> `references/` and our PowerShell loop. Codex session `019f1b7c-bef0-7c53-af70-67a52c4aba87`,
> duration ~8m. Codex confirmed all repo paths were accessible; it could NOT write
> this file itself (read-only sandbox) — persisted by the orchestrator.
> Date: 2026-07-01.

## Result: 17/18 CONFIRMED, 1 PARTIAL. No 🔴 fact refuted.

| Claim | Verdict | Note |
|---|---|---|
| A1 — AO SQLite durable + trigger-based append-only `change_log` (CDC), no derived status | ✅ CONFIRMED | |
| A2 — AO 6-method `ports.Agent` interface, ~23 adapters | ✅ CONFIRMED | |
| A3 — AO daemon "never runs git/gh"; worker does commit/push/PR; daemon polls SCM | ⚠️ PARTIAL | **Corrected below** |
| A4 — AO per-session `git worktree`, non-destructive teardown, `ErrWorkspaceDirty` | ✅ CONFIRMED | |
| A5 — AO reviewer = 2nd worker-adapter instance, stricter allowlist, CLI-cooperative (not OS sandbox) | ✅ CONFIRMED | |
| A6 — AO has no chat UI; tmux terminal is the conversation, `scrollback:0` | ✅ CONFIRMED | "chat-scroll bug" is a phantom |
| O1 — OpenHands risk enum + fail-closed ensemble, max-severity fusion | ✅ CONFIRMED | |
| O2 — OpenHands `ACPAgent` delegates to any ACP server | ✅ CONFIRMED | |
| O3 — OpenHands one JSON file per event, file-locked, verdict embedded on record | ✅ CONFIRMED | |
| O4 — OpenHands in-loop self-refinement critic (worker retries vs own grader) | ✅ CONFIRMED | anti-pattern we AVOID |
| O5 — OpenHands LiteLLM under thin `RouterLLM.select_llm()` | ✅ CONFIRMED | |
| D1 — Open Design multi-tier PATH scan; `resolvePathDirs()` supplements stripped GUI PATH | ✅ CONFIRMED | |
| D2 — Open Design AMR does NOT do complexity routing; BYOK proxy SSRF-hardened | ✅ CONFIRMED | "no donor does complexity routing" holds |
| D3 — Open Design "Critique Theater" = same-session multi-panelist self-critique | ✅ CONFIRMED | anti-pattern we AVOID |
| P1 — our loop: no worktrees, shared tree + file_set serialization, conductor commits after gate | ✅ CONFIRMED | |
| P2 — our loop: per-VALUE contract-guard coverage (not per-zone) | ✅ CONFIRMED | |
| P3 — our loop: declared `model:` → cheaper-only sub-ladder; contract-zone pinned opus; no auto-complexity scoring | ✅ CONFIRMED | |
| P4 — our loop: gate RETRY → pending/; dirty-fence via SHA256 fingerprints | ✅ CONFIRMED | |

## The one correction (A3)

AO does **not** "never run git/gh." Accurate picture:
- **Code checkpoint** (commit / push / open-PR) IS agent-driven — the worker adapter does it, not the daemon.
- **BUT** the daemon's **workspace layer runs `git`** for worktree lifecycle/preservation, and the CLI doctor probes `git` + `gh auth token`.

Impact: none on recommendations. It refines the axis-3 description (checkpoint is agent-driven; worktree git is daemon-driven) and mildly **reinforces axis-4** (the daemon manages worktrees via git — a proven pattern to adopt).

## Standing
All draft recommendations in `decision-matrix.md` survive independent verification.
The matrix is promoted from DRAFT to **VERIFIED**.
