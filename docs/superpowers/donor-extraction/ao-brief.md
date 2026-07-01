# Donor-Extraction Brief: Agent Orchestrator (AO)

> Source clone: `D:/Projects/autodev-harness/references/agent-orchestrator/`
> Analyzed: Go backend rewrite (`backend/`, Cobra `ao` CLI + loopback HTTP daemon +
> SQLite) and Electron/React frontend (`frontend/`). All claims below are grounded
> in `path:line` pointers into that clone — no claims from training-data memory.
>
> Classification tags (emoji avoided per project convention):
> `[RED]` = architecture-shaping, decide before we freeze our skeleton.
> `[YELLOW]` = clean graftable addition, backlog for later.
> `[WHITE]` = reject, not our case.

---

## License verdict

`D:/Projects/autodev-harness/references/agent-orchestrator/LICENSE` — **Apache
License 2.0** (standard header, `TERMS AND CONDITIONS ... Version 2.0, January
2004`). Confirmed again in `README.md:13` (`License: Apache-2.0` badge) and
`README.md:207-209` ("Apache License 2.0 - see LICENSE for details").

**Verdict:** Apache-2.0 is a permissive, patent-granting license. Autodev-harness
**can vendor/copy AO's actual source code** (not just ideas), provided we preserve
the license/copyright notice and note any changes (standard Apache-2.0 obligations
— NOTICE file, attribution, no additional restrictions). Straight lift of a file or
function is legally fine; a clean-room reimplementation is not required. (We are
building in TypeScript/Node while AO's backend is Go, so most "steals" will be
port-and-adapt rather than verbatim copy-paste regardless of license.)

---

## Per-axis findings

### 1. STATE MODEL — file-blackboard vs event-stream vs hybrid

**AO's mechanism:** SQLite is the single source of truth, storing only durable
facts; a DB-trigger-driven `change_log` table functions as an append-only
event-stream layered *on top of* the row store (hybrid: relational state +
CDC event log, not a pure blackboard and not a pure event-stream).

- Schema: `backend/internal/storage/sqlite/migrations/0001_init.sql:8-49` —
  `projects` and `sessions` tables. `sessions` persists only
  `activity_state` (enum: active/idle/waiting_input/blocked/exited),
  `activity_last_at`, `activity_source`, `is_terminated`, plus workspace/runtime
  handles (`0001_init.sql:31-41`). Comment at `0001_init.sql:17-20`: "The only
  persisted status-like facts are activity_state and is_terminated; display
  status is derived on read from this row plus PR facts."
- PR facts: `pr` table keyed by normalized URL, `session_id` FK
  (`0001_init.sql:54-60`), plus `pr_checks`/`pr_review_threads`/`pr_comments`
  (per `docs/architecture.md:345-398` ER diagram, confirmed against the same
  migration file's later CREATE TABLEs).
  Note: 0001_init.sql:29 records the harness CHECK constraint literally listing only 
  `claude-code, codex, aider, opencode` — the README's "23+ agent adapters" claim
  is broader than what this migration enforces; newer harnesses are likely added
  in later migrations we did not fully enumerate.
- CDC: triggers on `sessions` UPDATE append JSON rows into `change_log`
  (`0001_init.sql:128-141`, `json_object('id', NEW.id, 'activity',
  NEW.activity_state, ...)`), a poller tails `change_log` and a broadcaster
  fans out to SSE subscribers (`docs/architecture.md:400-416`, package
  `backend/internal/cdc/`).
- **Never-store-display-status is a stated load-bearing rule:**
  `docs/architecture.md:832` ("Never store display status — Status is derived
  from durable facts at read time") and repeated in `AGENTS.md:82-83`.

**Classification: [RED].** This is a foundational modeling decision that shapes
everything else (status derivation, UI polling/SSE, event replay). Our own
file-based blackboard plan should explicitly decide: do we store only durable
facts + derive display state at read time (AO's approach, cleaner but requires a
derivation layer), or do we store derived state directly (simpler, more drift
risk)? AO's answer is unambiguous and worth adopting as a principle even if our
storage substrate (files vs SQLite) differs.

---

### 2. WORKER-BACKEND INTERFACE — hardcoded CLI vs pluggable adapter

**AO's mechanism:** A real pluggable adapter interface, not a hardcoded CLI call.
`ports.Agent` (`backend/internal/ports/agent.go:20-43`) is the contract every
coding-agent adapter implements:
- `GetLaunchCommand(ctx, LaunchConfig) (argv []string, err error)` — builds the
  argv AO execs (`agent.go:26`).
- `GetPromptDeliveryStrategy` — in-command vs after-start prompt delivery
  (`agent.go:29-30`, `agent.go:172-178`).
- `GetAgentHooks` — installs workspace-local hooks (`agent.go:32-34`).
- `GetRestoreCommand` / `SessionInfo` — resume support (`agent.go:36-42`).
- `AgentResolver.Agent(harness)` maps a session's `harness` string to the
  adapter (`agent.go:49-51`) — this is the `--harness`-equivalent dynamic
  dispatch (concretely, the "harness" column in the `sessions` table,
  `0001_init.sql:28-29`).

23 adapter packages live under `backend/internal/adapters/agent/` (claudecode,
codex, aider, amp, auggie, cline, continueagent, copilot, crush, cursor, devin,
droid, goose, grok, kilocode, kimi, kiro, opencode, pi, qwen, vibe, autohand,
agy — confirmed via directory listing). Concretely, `claudecode.go:129-168`
builds `claude [--session-id uuid] [--permission-mode mode]
[--append-system-prompt ...] [--model ...] [-- prompt]`; `PermissionMode` is a
typed enum (`agent.go:156-169`) mapped per-adapter onto each CLI's own
approval-mode flags — AO does not implement its own generic action gate here,
it re-exposes each agent's native permission vocabulary.

**Classification: [RED].** This is exactly our "worker=`claude -p`" boundary
question. AO's adapter interface is a genuinely clean, small, well-factored
seam (6 methods) that has scaled to 23 backends without leaking adapter
concerns into core (`AGENTS.md:78-88`: "Adapters are leaves — Adapters never
import core packages, only ports and domain"). Strongly recommend adopting
this shape (or a TS equivalent) rather than hardcoding `claude -p` directly
into the daemon, even if we only ship one adapter at launch — it costs little
and buys the `codex exec` critic + future-backend flexibility for free.

---

### 3. CHECKPOINT — PR-based vs commit-to-branch

**AO's mechanism:** PR-based, and — critically — **AO itself never runs `git
commit`/`git push`/`gh pr create`**. Checked: no such CLI command exists
(`backend/internal/cli/*.go` file listing has no commit/push/pr-create
command; grep for `"git commit"`, `"git push"`, `"gh pr create"` across
`internal/cli` and `internal/adapters/scm` returns zero hits). Checkpointing is
fully **delegated to the worker agent itself**, which runs those git/gh
commands as its own tool calls inside its tmux/conpty pane. AO's daemon side
is purely **observational**:
- `backend/internal/observe/scm/observer.go:27` —
  `DefaultTickInterval = 30 * time.Second`, a poll loop (not a webhook) that
  lists PRs via the SCM adapter, diffs against the local `pr`/`pr_checks`
  table, and writes changes (`docs/architecture.md:585-610` flow, matching the
  observer package).
- Reviews are a **separate, AO-internal, second-agent code-review pass** (see
  Gate axis below and the `ao review submit` special) — this is not GitHub's
  PR review UI, though the reviewer can also post an actual GitHub review via
  `gh` (`reviewer/claudecode/claudecode.go:46`: `Bash(gh:*)` is allow-listed).

**Classification: [RED].** The "checkpoint = PR + CI, agent does its own git
ops, daemon only observes" split is a strong, simple architecture: it avoids
AO ever needing write credentials/logic for git, and it composes cleanly with
any CI provider since AO just polls the SCM API. This maps directly onto our
worker=`claude -p` + critic=`codex exec` design: our worker can be trusted to
commit/push/PR itself (already how `claude -p` with bash tool access works),
and our daemon's job is to observe + gate, not to perform git operations. Worth
adopting as-is.

---

### 4. WORKER ISOLATION — per-worktree vs shared-tree

**AO's mechanism:** Per-session `git worktree`, real `exec.CommandContext`
calls, with careful safety guarantees.
- `Workspace.Create` (`backend/internal/adapters/workspace/gitworktree/workspace.go:120-144`)
  validates config, resolves the repo path, validates the branch, computes a
  managed path under `~/.ao`, and calls `addWorktree`.
- `addWorktree` (`workspace.go:468-508`): refuses if the branch is already
  checked out elsewhere (typed sentinel `ErrBranchCheckedOutElsewhere`,
  `workspace.go:476-478`, avoiding an opaque 500); for a new branch it runs
  `git worktree add -b <branch> <path> <base>` via `worktreeAddNewBranchArgs`
  (`workspace.go:504-505`), resolving the base ref through
  `origin/<branch>` → default branch → tag (`workspace.go:491-503`).
- **Destroy is deliberately non-destructive by default:**
  `Workspace.Destroy` (`workspace.go:148-193`) runs `git worktree remove`
  WITHOUT `--force`; if the worktree is dirty, removal fails and the method
  returns `ports.ErrWorkspaceDirty` rather than deleting agent work
  (`workspace.go:163-187`). A separate `ForceDestroy` (`workspace.go:203-231`)
  exists but its doc comment explicitly warns: "only safe to call AFTER the
  session's uncommitted work has been captured via StashUncommitted... Calling
  it before capture silently discards agent work" (`workspace.go:198-202`).
  There is also a `StashUncommitted` capture-to-ref mechanism
  (`workspace.go:233-...`, commits uncommitted work to
  `refs/ao/preserved/<session-id>` without touching the working tree).
- This is a stated load-bearing rule: `docs/architecture.md:834` /
  `AGENTS.md:84` — "Do not force-delete dirty registered worktrees."

**Classification: [RED].** Per-worktree isolation is close to a foregone
conclusion for any parallel-agent tool, but the specific safety discipline here
(refuse-by-default destroy, typed dirty-worktree error, a preserve-before-force
path) is a genuinely valuable, non-obvious pattern worth stealing wholesale —
it is exactly the kind of "agent almost destroyed my work" bug class we'd
otherwise discover the hard way.

---

### 5. GATE LEVEL — PR/diff-level vs action-level

**AO's mechanism:** Two distinct, asymmetric layers — worth flagging because
they are easy to conflate.

1. **Worker sessions have NO AO-level action gate.** A worker's approval
   behavior is whatever the underlying CLI's own permission mode does
   (`default`/`accept-edits`/`auto`/`bypass-permissions`,
   `backend/internal/ports/agent.go:164-169`), configured per-project
   (`domain/agentconfig.go:25-31`, a single `Permissions` string). AO does not
   intercept or approve individual tool calls for workers; "auto"/"bypass"
   modes give the worker unrestricted execution with no daemon-side check.
2. **The reviewer session DOES get an AO-enforced action-level gate**, but only
   the reviewer. `reviewer/claudecode/claudecode.go:34-63`: the reviewer is
   launched with `Permissions: ports.PermissionModeAuto` (explicitly NOT
   bypass, `claudecode.go:73-76`) plus an allow-list
   (`Read`, `Grep`, `Glob`, `Bash(gh:*)`, `Bash(git diff/log/show/status:*)`,
   `Bash(ao review submit:*)`, `claudecode.go:42-52`) and a deny-list
   (`Edit`, `Write`, `NotebookEdit`, `Bash(git push:*)`, `Bash(git commit:*)`,
   `claudecode.go:57-63`), explicitly to keep the reviewer read-only. Comment
   at `claudecode.go:34-41` states this in AO's own words: "defense in depth,
   so a misbehaving model cannot edit files or move the branch even if a
   future allowlist entry would otherwise admit it." This is enforced by the
   underlying Claude Code CLI's own allow/deny engine (AO relies on the CLI
   honoring it — it is not process-level sandboxing on AO's side).
3. **PR-level gate:** the actual approve/changes-requested decision is
   recorded via `ao review submit` (see Special (c) below) and is manually
   triggered — see next paragraph.

**Classification: [RED]** for the worker/reviewer asymmetry pattern (adopt: no
gate for the trusted worker loop, hard read-only tool-allowlist gate for the
critic/reviewer loop — this maps directly onto our worker=`claude -p`
(read-write) vs critic=`codex exec` (should stay read-only/diff-only) split).
**[YELLOW]** for actually wiring an allow/deny tool list if our own worker CLI
supports one — worth doing but not skeleton-blocking.

---

### 6. MODEL-ROUTING ENGINE — static config ladder vs dynamic router

**AO's mechanism: there is no routing engine at all — a single static
string override, no complexity-based ladder.**
- `claudecode.go:96-99` (`GetConfigSpec`): exposes one config field, `"model"`
  ("Model override passed to `claude --model` (e.g. claude-opus-4-5)"), plus a
  `"permissions"` enum. No other adapter exposes a model field (grep across
  `internal/adapters/agent` for `"model"` returns exactly this one hit).
- `domain/agentconfig.go:25-31`: `AgentConfig.Model string` — one field, no
  per-task/per-complexity variants.
- `claudecode.go:155-157`: `if model := strings.TrimSpace(cfg.Config.Model);
  model != "" { cmd = append(cmd, "--model", model) }` — a literal passthrough,
  resolved once per project config, no runtime decision logic.

**Classification: [WHITE].** Nothing to steal here — AO deliberately keeps this
minimal (a per-project static override that just forwards to the CLI's own
`--model` flag). This validates (does not contradict) autodev-loop's existing
model-by-complexity routing idea as an area where **we are more sophisticated
than the donor**, not behind it. No graft needed; if anything, note this in our
own docs as "AO has nothing here, we're extending past the donor."

---

## Ranked list of top steals

1. **[RED] Worker/reviewer permission asymmetry** — no AO-level gate for the
   trusted worker, hard tool-allowlist (allow+deny) for the read-only critic.
   `backend/internal/adapters/reviewer/claudecode/claudecode.go:34-78`. Directly
   answers how to scope `codex exec` as our critic without it accidentally
   mutating the tree.
2. **[RED] Checkpoint = agent-driven git + daemon-observes-only** — AO never
   runs git/gh itself; confirmed by the complete absence of a commit/push/PR
   CLI command (`backend/internal/cli/` file listing) and the 30s SCM poll loop
   (`backend/internal/observe/scm/observer.go:27`). Removes an entire class of
   daemon-side git-credential/state-management complexity from our own design.
3. **[RED] Non-destructive-by-default worktree teardown** —
   `Destroy` refuses on dirty worktrees (`gitworktree/workspace.go:148-193`),
   `ForceDestroy` is a separate, explicitly-dangerous method
   (`workspace.go:195-231`), plus a `StashUncommitted`-to-ref capture path. A
   concrete, provably-safe pattern to port regardless of our exact worktree
   tooling.
4. **[YELLOW] `ports.Agent` 6-method adapter interface** — small enough to
   implement for a single backend today, but shaped correctly for a future
   second worker backend (`backend/internal/ports/agent.go:20-43`).
5. **[YELLOW] CDC-over-SQLite-triggers → SSE, with a polling fallback in the
   client** — see kanban board special below; the pattern (push via SSE when
   healthy, degrade to periodic poll when the stream drops) is a clean, cheap
   resilience story worth copying into our own UI even if our backing store is
   files, not SQLite (`frontend/src/renderer/lib/event-transport.ts:1-127`,
   `frontend/src/renderer/hooks/useWorkspaceQuery.ts:69-78`).

---

## Anti-patterns to avoid

1. **Reviewer read-only enforcement is CLI-cooperative, not sandboxed.**
   `claudecode.go:34-41` is explicit that this is "defense in depth" — AO trusts
   Claude Code's own allow/deny engine to actually refuse `Edit`/`Write`/
   `git push`/`git commit`; there is no OS-level sandbox, container, or
   AO-side interception verifying the reviewer didn't mutate the tree. If our
   critic (`codex exec`) doesn't have an equivalently strict, well-tested
   allow/deny mechanism, this pattern silently degrades to "the critic could
   write files and we wouldn't know until we diffed the tree ourselves." We
   should either verify Codex's own sandboxing is comparably strict, or add an
   independent AO-external check (e.g. diff the worktree hash before/after the
   critic run) rather than trusting the critic's own CLI flags alone.
2. **PR-review trigger is 100% manual (no automatic on-push trigger).**
   `POST /api/v1/sessions/{sessionId}/reviews/trigger`
   (`backend/internal/httpd/apispec/specgen/build.go:380`) is only ever called
   from the frontend UI button (`frontend/src/renderer/components/
   SessionInspector.tsx:403-439`, a `useMutation` wired to an `onTrigger`
   click handler) — there is no lifecycle/observer code path that calls
   `Engine.Trigger` automatically after a push or CI completion (confirmed:
   grepping the whole backend for callers of `.Trigger(ctx, workerID)` only
   turns up the HTTP controller). If autodev-harness wants "critic runs
   automatically after every worker push," we must build that trigger
   ourselves — AO does not have it and this is easy to assume it does from the
   docs' "automatic feedback routing" framing (that framing refers to routing
   *already-observed* SCM facts like CI failures/review comments back to the
   worker as a nudge, `lifecycle/reactions.go:163-172`, not to auto-triggering
   AO's own review pass).

---

## Out-of-axis architecture surprise

**AO's internal code-review engine is itself a second full coding-agent
session, reusing the worker's own adapter code, not a separate lightweight
"linter" component.** `reviewer/claudecode/claudecode.go:23-24` — `New()`
constructs `agent: workeragent.New()`, i.e. the reviewer literally instantiates
the *worker* Claude Code adapter and calls its `GetLaunchCommand` with a
different `Prompt`/`Permissions`/tool-lists (`claudecode.go:67-84`). There is a
parallel `ReviewerHarness` vocabulary and a separate `ports.ReviewerResolver`
registry (`internal/adapters/reviewer/registry.go`), but for claude-code
specifically the reviewer is "the same CLI, stricter flags, different prompt,"
not a distinct implementation. This is a strong argument for our own
worker=`claude -p` / critic=`codex exec` split being architecturally sound —
AO independently arrived at "reuse the same adapter machinery, vary the launch
config" for its worker/reviewer pair, which is close to what a
Claude-worker/Codex-critic split does at the interface level (different
binaries, same launch-config shape).

Also notable: reviews are **AO's own internal pass**, separate from GitHub's
native PR review feature — `githubReviewID` is optional context the reviewer
CLI supplies if it *also* posted a review via `gh` (allow-listed at
`claudecode.go:46`), but AO's own `review_run` rows and verdict are the
authoritative state (`backend/internal/domain` `ReviewRun`,
`internal/service/review/review.go:29`). Don't assume "review" in AO's
vocabulary means "GitHub's review feature" — it's a distinct internal gate that
optionally also talks to GitHub.

---

## The three specials

### (a) Chat-scroll bug

**Finding: there is no chat/message-list UI component in AO at all — confirmed
absent, not merely un-buggy.** Design intent is explicit:
`D:/Projects/autodev-harness/references/agent-orchestrator/DESIGN.md:208`
("The terminal **is** the conversation; no separate chat surface.") The only
scrollable content-feed-like components found are:
- `frontend/src/renderer/components/XtermTerminal.tsx:250` — the terminal is
  built with **`scrollback: 0`**, deliberately. Comment at
  `XtermTerminal.tsx:165-171` explains why: the pane PTY runs tmux in full
  alt-buffer mode which owns its own scrollback via copy-mode, so xterm never
  accumulates local history; mouse-wheel events are translated into SGR mouse
  reports (`sgrWheelReport`, `XtermTerminal.tsx:172-177, 474-492`) and
  forwarded to tmux rather than scrolled locally. This is a deliberate,
  carefully-commented design choice (not a bug) to avoid double-scrollback
  and avoid xterm's alt-buffer wheel→arrow-key fallback hijacking the agent's
  cursor. There is no "pin to bottom on new output" logic anywhere because
  there is no local buffer to pin.
- `frontend/src/renderer/components/TerminalPane.tsx:28` —
  `className="h-full overflow-auto ..."` on the pane's outer container; this is
  ordinary container overflow, not message-list autoscroll.
- `frontend/src/renderer/components/NotificationCenter.tsx:124` —
  `className="max-h-[420px] overflow-y-auto p-1"` on a notification dropdown
  list; a simple bounded scroll area, not an autoscroll-pinned feed.

**Conclusion for our own UI:** if we want a traditional scrolling chat
transcript (rather than embedding the raw agent CLI terminal as AO does), we
will need to design autoscroll-pinning ourselves — AO has no prior art here to
copy from or avoid, because it sidesteps the whole problem by making the
terminal itself the UI.

### (b) Kanban board — state derivation mechanics

**Component:** `frontend/src/renderer/components/SessionsBoard.tsx` — four
static columns (`working` / `needs you` / `in review` / `ready to merge`,
`SessionsBoard.tsx:32-65`), sessions bucketed into columns by
`attentionZone(session)` (`SessionsBoard.tsx:80-84`, from
`../types/workspace`).

**Data path is a hybrid SSE-push + poll-fallback (not pure polling, not pure
websocket):**
1. `useWorkspaceQuery()` (`frontend/src/renderer/hooks/useWorkspaceQuery.ts:76-78`)
   is a TanStack Query hook, `queryFn` fetches `GET /api/v1/projects` +
   `GET /api/v1/sessions` in parallel (`useWorkspaceQuery.ts:37-38`), with
   `refetchInterval: 15_000` (`useWorkspaceQuery.ts:73`) as the baseline poll.
2. `createEventTransport()` (`frontend/src/renderer/lib/event-transport.ts:43-127`)
   opens a browser `EventSource` against `GET /api/v1/events`
   (`event-transport.ts:84`) — the daemon's SSE endpoint fed by the CDC
   broadcaster. It listens for named CDC event types (`session_created`,
   `session_updated`, `pr_created`, `pr_updated`, `pr_check_recorded`,
   `pr_session_changed`, `pr_review_thread_added`, `pr_review_thread_resolved`
   — `event-transport.ts:25-34`) and, debounced 150ms
   (`event-transport.ts:12, 50-56`), calls
   `queryClient.invalidateQueries({ queryKey: workspaceQueryKey })`, forcing an
   immediate refetch. On stream loss it sets connection state to
   `"disconnected"` and retries opening a new `EventSource` every 5s
   (`event-transport.ts:15, 90-96, 58-64`); the 15s poll continues underneath
   as a backstop even while the SSE stream is healthy.

**Classification: [YELLOW].** This SSE-push-with-poll-fallback pattern is
directly reusable for our own UI regardless of whether our backend is SQLite
(AO) or files (ours) — the client-side shape (invalidate-on-event, debounce
bursts, poll as backstop, retry-with-backoff on stream loss) is
backend-agnostic.

### (c) `ao review submit` — exact mechanics

**CLI entry:** `backend/internal/cli/review.go:73-101` — Cobra command
`ao review submit [worker-session-id] --run <id> --verdict
<approved|changes_requested> [--body <text>] [--review_id <id>]` (flag names
normalize underscores to hyphens, `review.go:83-85`, "reviewer agents
routinely spell flags with underscores"). It's a thin HTTP client: builds
`submitReviewRequest` and POSTs to
`POST /api/v1/sessions/{sessionId}/reviews/submit`
(`backend/internal/httpd/apispec/specgen/build.go:392`).

**Server-side (`backend/internal/service/review/review.go`):**
1. `Service.Submit` → `SubmitMany` → `submitOne`
   (`review.go:99-209`) validates the verdict (`Valid()`,
   `review.go:163-165`), requires a body when `changes_requested`
   (`review.go:166-168`), loads the existing `review_run` row by ID
   (`review.go:169-175`), and — the ONLY mutation — calls
   `s.store.UpdateReviewRunResult(ctx, run.ID, domain.ReviewRunComplete,
   verdict, body, githubReviewID)` (`review.go:182`), i.e. **it updates one row
   in the `review_run` SQLite table.** It does not touch git and does not call
   the GitHub API itself.
2. If a lifecycle reducer is wired (`review.go:136-153`,
   `deliverSubmitted`/`deliverableRuns`), and the verdict is
   `changes_requested` and not yet delivered
   (`review.go:255` filter), it calls
   `lifecycle.Manager.ApplyReviewResult`
   (`backend/internal/lifecycle/reactions.go:195-225`). That function composes
   a message — `"[AO reviewer] AO's internal code reviewer submitted a
   review.\n\nPR: %s\nVerdict: %s"` plus, if a `githubReviewID` was supplied, a
   line asking the worker to "reply on GitHub review %s ... then resolve the
   review comment threads" (`reactions.go:209-217`) — and delivers it straight
   into the **worker's own tmux/conpty pane** via `sendOnce`
   (dedup-by-signature, capped retries via `reviewMaxNudge`,
   `reactions.go:220`). This is a terminal message injection, not a database
   write visible anywhere else and not a GitHub API call.
3. Once delivered, the run is marked `domain.ReviewRunDelivered` and stamped
   with `DeliveredAt` (`review.go:232-244`).

**Conclusion:** `ao review submit`'s "verdict recording" is entirely local —
one SQLite row update (`review_run.status/verdict/body/github_review_id`) plus,
conditionally, a nudge message written into the worker's live terminal pane.
Any actual GitHub-side review post (if it happens at all) is something the
reviewer CLI itself did earlier via its own `gh` tool call
(`reviewer/claudecode/claudecode.go:46`, `Bash(gh:*)` is allow-listed) — `ao
review submit` only records AO's own bookkeeping of that verdict and triggers
AO's in-pane feedback loop back to the worker.

---

## Open questions for the harness team

1. **Automatic review triggering:** AO leaves `reviews/trigger` entirely
   manual (UI button only, see Anti-pattern 2). Do we want autodev-harness to
   auto-trigger the critic (`codex exec`) after every worker push/commit, or
   keep it manual/on-demand like AO? This is a product decision AO's code does
   not answer for us.
2. **Sandbox strength for the critic:** AO's reviewer read-only guarantee is
   "trust the CLI's allow/deny engine" (see Anti-pattern 1). Does `codex exec`
   offer an equivalently enforced (ideally more enforced — e.g. actual sandbox/
   container) read-only mode we can rely on, or do we need an independent
   verification step (diff worktree before/after critic run) that AO doesn't
   bother with?
3. **Harness enum growth:** the `sessions.harness` CHECK constraint in the
   inspected migration (`0001_init.sql:28-29`) only lists `claude-code, codex,
   aider, opencode`, but the README claims 23+ adapters and the adapter
   directory has 23 packages. We did not trace the later migrations that must
   widen this constraint — worth checking `0002`-onward migrations if the exact
   harness list matters to any of our own schema decisions.
4. **File-based vs SQLite blackboard:** AO's "durable facts + CDC via DB
   triggers" pattern is elegant specifically because SQLite gives it triggers
   and atomic multi-row transactions for free. If autodev-harness commits to a
   pure file-based blackboard (per `docs/VISION.md`), we should explicitly
   decide how (or whether) to replicate the "never store derived status" rule
   without a database engine to enforce write-time consistency — e.g. do we
   derive status in a read path over files every time, or accept some
   eventual-consistency risk from writing pre-derived status into files
   directly.
