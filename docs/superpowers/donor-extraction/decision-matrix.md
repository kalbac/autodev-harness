# Donor Decision Matrix — Autodev Harness

> Synthesis of the 5 donor-extraction briefs (AO, OpenHands, Open Design, Aider +
> our own autodev-loop parity-spec). Classifies every notable "steal" as
> 🔴 architecture-shaping (decide before freezing the skeleton) / 🟡 graftable-later
> (backlog, behind a seam) / ⚪ reject.
> Status: **VERIFIED** — all 🔴 claims passed independent codex GPT-5.5 verification
> (17/18 CONFIRMED, 1 PARTIAL, none refuted). See `./codex-verification.md`.
> Source briefs: `./{ao,openhands,opendesign,aider}-brief.md`,
> `./autodev-loop-parity-spec.md`.

## Licenses (all permit code reuse)

| Donor | License | Reuse |
|---|---|---|
| AO | Apache-2.0 | code reusable (attribution/NOTICE) |
| OpenHands + software-agent-sdk | MIT | code reusable (avoid `enterprise/`) |
| Open Design | Apache-2.0 | code reusable |
| Aider | Apache-2.0 | code reusable (value is ideas, not edit machinery) |

## The six skeleton axes — synthesized positions

Legend: **BASE** = our proven autodev-loop's as-built position (the default we depart
from only with reason).

### Axis 1 — STATE MODEL 🔴
- **BASE:** pure file-blackboard (`.autodev/queue|runtime|…`), git-tracked, proven.
- AO: SQLite durable facts + DB-trigger `change_log` append-only CDC; never stores derived status. 🔴
- OpenHands: one JSON file per event, file-locked, append-only, risk+critic embedded on the action record. 🟡 (structurally near a blackboard)
- Open Design: SQLite metadata index + filesystem owns content. 🟡
- **Draft recommendation:** **hybrid** — file-blackboard stays authoritative & git-tracked; add a *derived* SQLite read-model (projection) for UI queries + an append-only event/change log for audit and anti-drift trajectories. Blackboard is truth; SQLite is a rebuildable view.

### Axis 2 — WORKER-BACKEND INTERFACE 🔴
- **BASE:** hardcoded `claude -p` ladder.
- AO: 6-method `ports.Agent` interface, 23 adapters. 🔴
- OpenHands: `AgentBase.step()` + `ACPAgent` (Agent Client Protocol → Claude Code, Gemini CLI). 🔴
- Open Design: PATH-scan 4-tier detection + `RuntimeAgentDef` registry. 🔴 (detection 🟡)
- **Strong 3-donor convergence.** Draft recommendation: define a **pluggable worker-backend adapter interface** from day one (port AO's `ports.Agent` shape); MVP implements the `claude -p` adapter + `codex exec` critic adapter. ACP = candidate protocol later; PATH-scan auto-detect = 🟡 (the seam enables it).

### Axis 3 — CHECKPOINT 🔴
- **BASE:** conductor commits to branch **after** the gate; worker never commits (gate-before-commit is a safety property).
- AO: PR-based, **agent-driven** — worker commits/pushes/PRs; daemon observes SCM by polling (~30s). (codex A3 correction: the *code checkpoint* is agent-driven, but the daemon's workspace layer DOES run `git` for worktree lifecycle.) 🔴
- OpenHands: conversation snapshot. ⚪ (weaker)
- Aider: per-edit auto-commit ⚪; WIP-checkpoint inside a session 🟡.
- **Draft recommendation:** keep **commit-after-gate** as default (offline, low-friction, gate stays a true pre-commit lock); put checkpoint behind an interface so a **PR-based adapter** can be added for repos with GitHub+CI. Keep **conductor commits, not worker** (safer than AO's agent-driven commit). Genuine user tradeoff — commit-to-branch vs PR-based as MVP default.

### Axis 4 — WORKER ISOLATION 🔴
- **BASE:** shared working tree + `file_set`-disjoint serialization (NO per-task worktree); dirty-fence via SHA256 fingerprints. Parity-spec flagged this as a pragmatic divergence #1, not a principled choice.
- AO: per-session `git worktree`, non-destructive teardown, typed `ErrWorkspaceDirty`. 🔴
- OpenHands: pluggable `SandboxService` (Docker/process/remote). 🟡 pattern
- Open Design: env-redirect only, **not** real isolation. ⚪ anti-pattern
- **Draft recommendation:** **adopt per-worktree isolation (AO pattern)** — true parallel isolation, removes the fragile shared-tree dirty-fence + file_set-as-lock. A case where a donor improves on our base. Docker sandbox = 🟡 for risky tasks later.

### Axis 5 — GATE LEVEL 🔴/🟡
- **BASE:** independent diff-level critic (`codex exec` GPT-5.5, fenced) + machine gate (success_commands + per-value contract-guard coverage). No action-level gate. **This independent critic is the project's whole point — non-negotiable.**
- OpenHands: risk enum + fail-closed **ensemble** analyzer (max-severity fusion), action-level; ReDoS-hardened regex corpus. 🔴 (adopt the *shape* as a complementary action-level gate)
- Open Design: "Critique Theater" 5-panelist **same-session self-critique**. ⚠️ self-certify → conflicts with our doctrine.
- OpenHands in-loop refinement critic: worker retries against its own grader before external review. ⚠️ **anti-pattern** (never self-certify).
- **Draft recommendation:** MVP = keep our **independent diff-level critic + machine gate** (proven). Design the gate so an **action-level risk pass** (OpenHands ensemble shape, portable as data) can slot in as a fast-follow. **Reject all self-critique-as-gate** (Critique Theater, in-loop refinement) — they are the exact failure mode we exist to prevent.

### Axis 6 — MODEL-ROUTING ENGINE ⚪/🟡 (largely settled)
- **BASE:** declarative per-task `model:` + cheaper-only sub-ladder; contract-zone pinned to opus; critic fixed `gpt-5.5/high`; anti-drift fixed `sonnet`. **No auto-complexity scoring** (operator/planner assigns).
- AO: static per-project `--model`. ⚪ (ours is better)
- OpenHands: LiteLLM + thin `RouterLLM.select_llm()` abstraction. 🟡 (steal the *shape*, not LiteLLM)
- Open Design: BYOK proxy (SSRF-hardened) 🟡; **AMR "smart router" = ⚪ myth** (zero complexity logic, `grep complexity`=0).
- **Key finding:** NO donor does task-complexity routing — **our declarative per-task model is already state-of-the-art.** Draft recommendation: keep it; wrap in a thin routing abstraction (RouterLLM shape) as the seam; BYOK proxy = 🟡 product-phase.

## Graftable-later backlog (🟡, behind seams)
PATH-scan agent auto-detect · action-level risk-ensemble gate · Docker sandbox for
risky tasks · repo-map (PageRank) context accelerator · BYOK/SSRF proxy ·
Aider-as-alternative-worker-backend · WIP-checkpoint inside worker session ·
microagents (keyword contract-zone knowledge) · cost-accounting/model-metadata config.

## Reject (⚪)
AO static model routing · OpenHands conversation-snapshot checkpoint · Aider edit-format/
apply machinery (claude -p owns edits) · Open Design AMR "smart router" · Open Design
env-redirect "sandbox" · any same-session self-critique as a merge gate.

## Anti-patterns to actively avoid (evidence in briefs)
1. Self-critique masquerading as a gate — Open Design Critique Theater, OpenHands in-loop
   refinement critic. Violates "never self-certify / independent critic."
2. Self-reported-only risk analyzer (acting LLM grades its own risk) — worthless outside an ensemble.
3. CLI-cooperative "read-only reviewer" with no real sandbox (AO) — confirm `codex exec` is
   actually isolated or add independent verification.
4. Manual review trigger (AO's UI button) — our critic must auto-invoke on every worker diff.
5. Mislabeling env-var redirection as sandboxing (Open Design).

## Correction to project docs
The **"AO chat-scroll bug"** (listed as a known first target in `VISION.md` /
`CURRENT-STATE.md`) does **not exist**: AO has no chat UI — the tmux terminal *is* the
conversation (`scrollback:0` deliberately delegates scroll to tmux). We design autoscroll
from scratch; remove this from the target list.

## 🔴 claims queued for proportional codex verification
See the session's codex verification dispatch. Focus set = the axis-gating claims above
(AO SQLite+CDC, AO ports.Agent, AO per-worktree, AO agent-driven checkpoint, OpenHands
risk-ensemble, OpenHands ACP, Open Design PATH-scan, Open Design AMR-myth) + the
parity-spec's as-built core facts + the two self-critique anti-patterns.
