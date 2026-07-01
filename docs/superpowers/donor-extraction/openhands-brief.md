# Donor-Extraction Brief: OpenHands

> Source clone (as instructed): `D:/Projects/autodev-harness/references/OpenHands/`
> **Critical finding, read first:** this clone is no longer "OpenHands the agent."
> As of this snapshot it is **"Agent Canvas"** — a control-center UI + backend
> (`openhands/app_server/`, `frontend/`) that *talks to* agent runtimes over HTTP.
> The actual agent core — event stream, Action/Observation events, security
> analyzer, agent abstraction, LiteLLM routing, microagents (now "skills") — has
> been extracted into a **separate repo**: `github.com/OpenHands/software-agent-sdk`,
> pulled in as three pinned PyPI packages (`openhands-sdk==1.29.0`,
> `openhands-agent-server==1.29.0`, `openhands-tools==1.29.0`; see
> `pyproject.toml:61-63`). See `README.md:57-61` in the target clone: *"The code in
> this repo is moving! ... The source code for OpenHands Agent and Agent Server
> lives in OpenHands/software-agent-sdk."*
>
> Because the six axes we care about (state model, worker-backend interface,
> checkpoint, isolation, gate, model-routing) live almost entirely in that
> extracted SDK, I shallow-cloned it too (network access confirmed available) to
> `C:\Users\maksi\AppData\Local\Temp\claude\...\scratchpad\sdk\` — **this location
> is ephemeral (session scratchpad) and will not persist.** If the team wants to
> keep referencing SDK source, clone `https://github.com/OpenHands/software-agent-sdk`
> into `references/openhands-sdk/` as a companion to this repo. All `path:line`
> pointers below into `openhands-sdk/`, `openhands-agent-server/`, or
> `openhands-tools/` refer to that repo's internal layout, e.g.
> `openhands-sdk/openhands/sdk/event/base.py:20`.
>
> Classification tags: 🔴 architecture-shaping / 🟡 graftable-later / ⚪ reject.

---

## License verdict

Both repos are MIT:
- Target clone (`Agent Canvas` / "OpenHands" package): `LICENSE:1-4` — MIT for
  everything **except** `enterprise/` which has its own license
  (`LICENSE:1-2`: *"All content that resides under the enterprise/ directory is
  licensed... Content outside... is available under the MIT license"*).
- SDK repo (`software-agent-sdk`): `LICENSE:1-3` — plain MIT,
  `Copyright (c) 2026 OpenHands contributors`.

**Verdict: full code-reuse rights, not ideas-only.** We can vendor/port actual
source (regex pattern lists, risk-fusion logic, event schemas) as long as we keep
the MIT notice. Do not touch anything under `enterprise/` in the Agent Canvas repo
— different license, and it's SaaS-specific control-plane code we don't need
anyway.

---

## Per-axis findings

### 1. STATE MODEL — event-stream vs our file-blackboard (KEY AXIS)

**Schema.** `Event` is a frozen, discriminated-union Pydantic model:
`openhands-sdk/openhands/sdk/event/base.py:20-32` — every event has `id` (UUID),
`timestamp` (ISO string), `source` (`SourceType`). `LLMConvertibleEvent` (same
file, line 58) adds `to_llm_message()` — the event stream doubles as the LLM
context builder, not just an audit log.

Concrete event types (`event/llm_convertible/`):
- `ActionEvent` (`action.py:24-89`): `thought`, `reasoning_content`,
  `thinking_blocks`, `action: Action | None`, `tool_call`, `llm_response_id`,
  **`security_risk: risk.SecurityRisk`** (line 67-70, defaults `UNKNOWN`) and
  **`critic_result: CriticResult | None`** (line 72-75) are fields *on the event
  itself* — risk assessment and critic verdict are first-class, persisted,
  replayable parts of the action record, not side-channel state.
- `ObservationEvent`, `UserRejectObservation` (with `rejection_source:
  Literal["user","hook"]`), `AgentErrorEvent`
  (`observation.py:31-159`).

**Persistence.** `EventLog` (`openhands-sdk/openhands/sdk/conversation/event_store.py:25-270`)
is literally **one JSON file per event** on a `FileStore` (local disk or
in-memory), file-locked for concurrent writers (`append()`, line 131-170, uses
`self._fs.lock(...)` with a 30s timeout and re-syncs from disk if another
process wrote first). Index is `{event_id: idx}` rebuilt by scanning filenames
matching `event-<idx>-<id>.json` (`_scan_and_build_index`, line 219-270). This is
**structurally close to a file-blackboard** — an append-only directory of small
JSON facts with an on-disk index — not a database or a binary log.

**Replay/resume.** `ConversationState.create()`
(`openhands-sdk/openhands/sdk/conversation/state.py:345-460`): reads
`base_state.json` (agent config + workspace + stats); if present, resumes by
validating the *persisted* agent is compatible with the *runtime* agent
(`agent.verify()`, tools may only be added, never removed —
`openhands-sdk/openhands/sdk/agent/base.py:807-873`), then `rebuild_view()`
replays the event log into a cached in-memory view. If absent, starts fresh.
**Checkpoint = conversation-state snapshot, not code-commit** (see axis 3).

**Verdict — hybridize a narrow slice, don't adopt wholesale.** Full adoption of
a Python-Pydantic discriminated-union event stream is not worth the migration
cost for a Node/TS core; it would mean re-deriving our whole schema layer. But
three specific ideas are cheap to graft onto our existing file-blackboard and
meaningfully upgrade it:
1. **Put risk + critic verdict directly on the action record**, not in a
   separate table/file we have to join. (`action.py:67-75`)
2. **One-file-per-event with a locked append + filename-embedded index** is a
   good durability pattern for a file-based blackboard under concurrent
   writers — cheap and battle-tested (`event_store.py:131-270`).
3. **Explicit rejection provenance** (`rejection_source: "user" | "hook"`,
   `observation.py:83-89`) — distinguishing "human said no" from "our own gate
   blocked it" is a distinction our blackboard currently doesn't make and should.

Net: 🟡 graftable-later for the "event-as-envelope-for-risk+critic" pattern and
the per-event-file durability trick; ⚪ reject full event-stream migration.

### 2. WORKER-BACKEND INTERFACE — AgentBase + ACP

`AgentBase` (`openhands-sdk/openhands/sdk/agent/base.py:144-1055`) is the
abstract seam: `llm`, `tools`, `mcp_config`, `condenser`, `critic` as config
fields; `step(conversation, on_event, on_token)` (line 766-787) and `astep()`
(789-805) as the control-loop hook a subclass must implement. Capability flags
let callers branch without `isinstance` checks: `supports_openhands_tools`,
`supports_openhands_mcp`, `supports_condenser`, `agent_kind` (lines 1006-1037).

`ACPAgent` (`openhands-sdk/openhands/sdk/agent/acp_agent.py:1-94`) is a second
`AgentBase` subclass that delegates to any **Agent Client Protocol** server —
docstring at lines 1-15: *"lets OpenHands power conversations using
ACP-compatible servers (Claude Code, Gemini CLI, etc.) instead of direct LLM
calls... one ACP step() maps to one complete remote assistant turn... emits a
terminal FinishAction to delimit that turn."* It imports the official `acp`
Python package (`acp.client.connection.ClientSideConnection`, line 32) — ACP is
Zed's open protocol (agentclientprotocol.com), not OpenHands-proprietary.
`supports_openhands_tools`/`supports_openhands_mcp`/`supports_condenser` are all
`False` for this subclass (docstrings, lines 1006-1031) — correctly modeled: an
external agent owns its own tools/context/MCP, OpenHands just relays messages
and injects prompt-only context (skill catalog).

README confirms this is the flagship feature, not incidental:
`README.md:6-8` *"Run OpenHands, Claude Code, Codex, Gemini, or any
ACP-compatible agent"*; `README.md:35` *"Agent Canvas runs the open source
OpenHands agent out-of-the-box, but can use any third-party agent like Claude
Code and Codex."*

**Verdict:** 🔴 **architecture-shaping, evaluate seriously.** Our worker is
already `claude -p` (a CLI subprocess) and our design explicitly wants
pluggable backends. ACP is a real, protocol-level standard for exactly this
problem — adopting it (or its wire shape) instead of inventing our own
worker-runner interface saves us from re-solving "how do I talk to an
arbitrary external coding agent" and buys interop with Claude Code, Gemini CLI,
etc. for free. Minimum-viable action: read the ACP spec and decide whether our
worker-runner process boundary should speak ACP JSON-RPC directly, vs. our own
thinner subprocess-stdio contract. Do this before freezing the worker-runner
interface.

### 3. CHECKPOINT

There is **no git-commit-based checkpoint abstraction in the SDK**. What OpenHands
calls persistence is conversation-*state* snapshotting: `base_state.json` +
one-JSON-file-per-event (`state.py:392-405`, `event_store.py`) — this lets a
conversation resume mid-task after a crash/restart, but it is not a code-commit
checkpoint. Git operations (add/commit/diff) happen because the agent calls its
own `TerminalTool`/git commands inside the workspace like a human would;
`openhands-sdk/openhands/sdk/git/git_changes.py` and `git_diff.py` only expose
`GitChange`/`GitDiff` read models (`git/models.py:1-27`) for the UI to show a
diff — not an automated commit-per-step service. On the Agent Canvas side,
`openhands/app_server/git/git_router.py` (target clone) is repo/branch
*browsing* for the UI (search installs, repos, branches — `git_router.py:50-273`)
so a user can pick a repo to start a conversation against; no PR-creation
service was found there either.

**Verdict:** ⚪ reject as a checkpoint-axis donor — this is strictly weaker than
our own PR-per-session model (which already treats the git commit/PR as the
checkpoint boundary and gate target). The one adjacent idea worth 🟡 noting: the
*conversation-state resumability* pattern (crash-safe mid-task resume via
event replay) is a different, complementary axis (crash recovery of the
worker's own scratch state) — could be graftable-later if our loop needs to
survive daemon restarts mid-session, but it's not a "checkpoint" in the
commit/PR sense.

### 4. WORKER ISOLATION — pluggable sandbox services, not worktrees

Isolation is a **backend/control-plane concern**, not a language-level construct.
`BaseWorkspace` (`openhands-sdk/openhands/sdk/workspace/base.py:23-69`) is the
abstract "where do commands run" seam (`execute_command`, file read/write,
context-manager for cleanup). `LocalWorkspace` runs directly on the host (no
isolation — `README.md:88-90` warns *"This runs the agent-server directly on the
machine... full access to your filesystem"*); `RemoteWorkspace`
(`workspace/remote/base.py`, 942 lines) talks to a remote **agent-server**
process over HTTP — that agent-server is what actually gets sandboxed.

The sandboxing itself lives in the Agent Canvas control plane:
`openhands/app_server/sandbox/sandbox_service.py:30` — abstract `SandboxService`
(`start_sandbox`, `pause_sandbox`, `resume_sandbox`, `delete_sandbox`,
`archive_conversation_workspace`, lines 34-223) with concrete implementations
selectable at runtime: `docker_sandbox_service.py`, `process_sandbox_service.py`
(bare subprocess, no isolation), `remote_sandbox_service.py` (VM/cloud). Module
README: `openhands/app_server/sandbox/README.md:16-21` — *"Multiple sandbox
backend support (Docker, Remote, Local)"*. The agent-server itself ships a
Dockerfile (`openhands-agent-server/openhands/agent_server/docker/Dockerfile`)
for the container case.

**Verdict:** 🟡 graftable-later, not architecture-shaping for us specifically —
we've already settled on git worktrees for isolation (cheap, no daemon
process to manage), and OpenHands' model solves a different problem (isolating
an *arbitrary long-running agent-server process*, including its OS-level
side-effects, not just its file edits). The one transferable idea: **the
abstract `SandboxService`/backend-selection pattern itself** — if we ever want
"run this worker in Docker instead of a worktree" as an option, model it the
same way (one abstract lifecycle interface, pluggable impls chosen by config),
rather than hard-coding worktree assumptions into the daemon.

### 5. GATE LEVEL — risk-based confirmation (candidate action-level gate)

This is the most directly reusable subsystem found. Layered design:

- **Risk enum**, ordered, `UNKNOWN` deliberately excluded from ordering:
  `openhands-sdk/openhands/sdk/security/risk.py:13-147`. `is_riskier()` is
  reflexive by default (line 69-100); comparing against `UNKNOWN` raises
  `ValueError` by design (forces callers to handle "no assessment" explicitly
  rather than silently treating it as low risk).
- **Confirmation policy**, decoupled from the analyzer:
  `security/confirmation_policy.py:1-62` — `AlwaysConfirm`, `NeverConfirm`,
  `ConfirmRisky(threshold=HIGH, confirm_unknown=True)` (default: confirm on
  `UNKNOWN` too, line 44-45).
- **Analyzer base**, fail-closed on error:
  `security/analyzer.py:85-111` — `analyze_pending_actions()` catches
  exceptions per-action and **defaults to `HIGH` risk on analysis failure**
  (line 108-109, comment: "Default to HIGH risk on analysis error for
  safety"). `should_require_confirmation()` (line 57-83): HIGH always
  confirms; UNKNOWN confirms unless an analyzer is configured.
- **Concrete analyzers, composable via max-severity ensemble:**
  - `LLMSecurityAnalyzer` (`llm_analyzer.py:10-29`) — **self-reported only**:
    just echoes back the `security_risk` field the *acting* LLM itself set on
    its own tool call. No independent check. Worth flagging as a weakness if
    used alone.
  - `PatternSecurityAnalyzer` (`security/defense_in_depth/pattern.py:1-70+`) —
    deterministic regex corpus, ReDoS-hardened by convention (comment block,
    lines 62-68: no unbounded `.*`/`.+` in alternations, bounded spans, `\b`
    anchors), stable detector IDs (`DET_EXEC_DESTRUCT_RM_RF`, `DET_EXEC_CODE_EVAL`,
    `DET_INJECT_OVERRIDE`, etc., lines 41-55) split into an "executable corpus"
    (tool args only) and an "all-field corpus" (+ thought/reasoning, for
    prompt-injection detection).
  - `PolicyRailSecurityAnalyzer` (`defense_in_depth/policy_rails.py`) —
    composed/sequenced threat detection (185 lines, not fully read).
  - `GraySwanAnalyzer` (`security/grayswan/analyzer.py:28-60`) — optional,
    calls a third-party hosted classifier ("Cygnal API") with conversation
    history, maps a violation score to LOW/MEDIUM/HIGH via configurable
    thresholds (`low_threshold=0.3`, lines 57-60).
  - `EnsembleSecurityAnalyzer` (`security/ensemble.py:22-102`) — wires multiple
    analyzers together, **max-severity fusion**: if any child raises, that
    child contributes HIGH (fail-closed, line 84-86); `propagate_unknown` flag
    controls whether "some analyzer couldn't tell" forces UNKNOWN (strict) or
    is filtered out in favor of concrete results (permissive default).

**Verdict:** 🔴 **architecture-shaping candidate — strongly consider adopting
the *shape* of this design as a complementary action-level gate**, sitting
underneath our PR-level critic (which only fires at PR boundary; this fires
per-tool-call, before execution). Concretely stealable even without touching
Python: (a) the 4-level risk enum with UNKNOWN excluded from ordering and
fail-closed defaults; (b) the ensemble/max-severity fusion pattern; (c) the
regex pattern corpus for destructive-shell/prompt-injection detection — these
are just data (regex + risk level + detector ID triples) and translate
directly to TypeScript. Caveat to design around, not copy: the *self-reported*
LLM analyzer alone is weak (worker grades its own risk) — only trustworthy
when combined with the deterministic pattern analyzer in an ensemble, exactly
as OpenHands' own docstring recommends (`ensemble.py:1-7`).

### 6. MODEL-ROUTING ENGINE — LiteLLM + thin RouterLLM abstraction

`LLM` wraps LiteLLM directly: `openhands-sdk/openhands/sdk/llm/llm.py` imports
`litellm.completion`/`acompletion`/`responses` (lines 47-83) and
`get_litellm_model_info` (line 28) — "any model" support is LiteLLM's model
registry, not custom OpenHands code.

On top of that, `RouterLLM` (`openhands-sdk/openhands/sdk/llm/router/base.py:28-135`)
is itself an `LLM` subclass holding `llms_for_routing: dict[str, LLM]`
(line 41-43) and delegating `completion()` (line 57-95) to whichever LLM
`select_llm(messages) -> str` (abstract, line 97-111) picks — genuinely a
**per-call routing hook**, not per-task/per-agent only. `__getattr__` falls back
to the first configured LLM for any attribute the router itself doesn't define
(line 113-117), so a `RouterLLM` is a drop-in `LLM` everywhere else in the
codebase. Two concrete impls: `MultimodalRouter`
(`llm/router/impl/multimodal.py:13-50+`) — routes to a primary (multimodal-
capable) model if any message contains an image or the secondary model's
context window would be exceeded, else routes to a cheaper secondary model;
and `RandomRouter` (`llm/router/impl/random.py`, for eval/testing).

**Verdict:** 🟡 graftable-later, not architecture-shaping. The pattern ("a
router IS-A LLM, `select(messages) -> key`, delegate") is clean and small
enough to reimplement natively in TS on top of whatever model-calling library
we pick (we don't need LiteLLM itself — Node has its own thin multi-provider
wrappers, and pulling in a large Python-native library across the process
boundary isn't worth it). Steal the *shape* for our model-by-complexity
routing (worker vs critic model selection), not the code.

---

## Microagents → Skills (rename + reshape)

Old "microagents" concept survives as **Skills**
(`openhands-sdk/openhands/sdk/skills/`). `BaseTrigger` subclasses:
`KeywordTrigger(keywords: list[str])` and `TaskTrigger(triggers: list[str])`
(`skills/trigger.py:13-33`) — same keyword-triggered knowledge-injection idea as
classic OpenHands microagents, now formalized with `AgentSkills`-format
directories, frontmatter-based metadata (`skill.py` imports `frontmatter`,
`yaml`), and an `InvokeSkillTool` the agent can call explicitly
(`agent/base.py:718-736`, auto-attached when an invocable skill is present).
There's also a full plugin/marketplace layer (`marketplace/registry.py`,
`plugin/fetch.py`) for pulling third-party skill bundles by reference.

**Verdict:** 🟡 graftable-later. Keyword-triggered context injection is a cheap,
high-value pattern for our critic/worker prompting (e.g., auto-inject a gotcha
doc when a keyword like "migration" appears) — worth a lightweight port, not
the full marketplace/plugin resolution machinery.

## Eval harness (SWE-bench etc.)

**Not found in either repo.** `find -iname "*swebench*"` across the full
`software-agent-sdk` clone returned nothing, and the target Agent Canvas repo
has no `evaluation/` directory (confirmed via top-level listing). The
eval/benchmark harness that used to live in classic OpenHands (`evaluation/`)
appears to have been dropped or moved to a repo we haven't located (possibly
`OpenHands/evaluation` or folded into the `.agents/skills/manage-evals` skill
seen in `software-agent-sdk/.agents/skills/manage-evals`, which was not
inspected further). **Classify: unable to verify — do not cite as present.**
If eval-harness parity matters for autodev-harness, this needs a separate,
explicit search pass, not inference from this snapshot.

## Out-of-axis surprise: in-loop self-refinement Critic (contrast, not a steal)

`CriticBase` (`openhands-sdk/openhands/sdk/critic/base.py:57-115`) is attached
directly to `AgentBase` (`agent/base.py:434-442`, field docstring: "EXPERIMENTAL").
It scores `(events, git_patch) -> CriticResult(score: float)` and, if
`IterativeRefinementConfig` is set (`critic/base.py:20-53`), **the same
conversation automatically retries itself** when `score < success_threshold`
(`should_refine()`, line 109-114) — up to `max_iterations` (default 3). Modes:
`finish_and_message` (only score at task end, default) or `all_actions` (score
every action, explicitly flagged as slow). Concrete impls include
`AgentFinishedCritic` (heuristic: last action was `FinishAction` + non-empty git
patch, `critic/impl/agent_finished.py:24-50`) and `APIBasedCritic`
(`critic/impl/api/critic.py:47-70+`, calls a genuinely separate hosted
classifier for "agent behavioral issues").

**This is architecturally the opposite of our critic gate**, worth flagging
explicitly rather than stealing: OpenHands' critic runs *inside* the same
worker session and lets the worker retry/fix itself before a human or
downstream gate ever sees the result — i.e., **the worker can self-certify and
loop until it passes its own (or a semi-independent) grader**, then present a
"critic-approved" result upstream. Our project's stated philosophy
("never let agents merge bullshit," "never self-certify," re-critic in-place
fixes) is explicitly against exactly this pattern when it's the *only* gate.
Even the `APIBasedCritic` variant, while hitting an external model, still
operates in-loop, pre-merge-decision, with no independent PR-level reviewer
step afterward in what we found. ⚪ reject as a substitute for our critic;
🟡 worth noting as a cheap *pre-filter* (let the worker self-correct obvious
misses before spending an expensive external critic pass) — but never as a
replacement for the independent gate.

---

## Summary table

| Axis | OpenHands mechanism | Classification |
|---|---|---|
| 1. State model | Per-event JSON files + risk/critic embedded on ActionEvent | 🟡 hybridize narrow slice |
| 2. Worker-backend interface | `AgentBase.step()` + `ACPAgent` (Agent Client Protocol) | 🔴 evaluate before freeze |
| 3. Checkpoint | Conversation-state snapshot (not commit-based) | ⚪ reject; weaker than our PR model |
| 4. Worker isolation | Pluggable `SandboxService` (Docker/process/remote) | 🟡 pattern only, not the impl |
| 5. Gate level | Risk enum + ensemble analyzers + confirmation policy | 🔴 adopt the shape as action-level gate |
| 6. Model routing | LiteLLM + thin `RouterLLM.select_llm()` | 🟡 steal the shape, not LiteLLM |
| Microagents/Skills | Keyword/task-triggered context injection | 🟡 lightweight port |
| Eval harness | Not found in either repo | — unable to verify |
| In-loop critic (surprise) | Self-refinement before any external review | ⚪ reject as gate substitute |
