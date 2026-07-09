# agent-ci observability — cross-platform invocation + live CI-run visibility in the harness UI

> Design spec. Authored 2026-07-10 (s37). Follow-up to the shipped **agent-ci gate
> hardening** (PR #69, `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md`).
> That v1 was **config-file-only, buffered, and Windows-broken by design's silence**. The
> operator battle-tested it and asked, correctly, to *see the whole thing run inside the
> harness UI* — not take a module-level live-prove on faith. This spec is that second half:
> make agent-ci **actually runnable from the harness the operator runs** (native Windows,
> via WSL), and make a CI replay **observable live** in the dashboard. Discipline unchanged:
> this still touches `gate.ts`'s orbit → TDD + typecheck + `npm test` + **mandatory codex
> GPT-5.5 critic gate** + a real live-prove (through the daemon + browser this time, not a
> standalone script).

## 1. Problem

v1 (`gate.agentCi`) proved out at the module level and under WSL via a throwaway script, but
three real gaps remain before it is a usable *product* feature:

1. **It doesn't run from the harness the operator actually uses.** agent-ci cannot run on
   native Windows (`[gate/agent-ci-not-runnable-on-native-windows]`: it shells `tar -czf
   C:\...` to a POSIX tar → "Cannot connect to C:"). The operator runs the harness on native
   Windows; today enabling `gate.agentCi` there makes every task ESCALATE with the generic
   `gate threw -- broken operator config` — technically a correct fail-safe, but opaque, and
   it means the feature is unusable on his box. This is a **product** (Windows/Mac/Linux
   users, later a Tauri/Electron desktop wrap), so "Linux-only, silently" is not acceptable.
2. **It's invisible.** No UI surface at all (v1 was config-file-only). The operator cannot
   see a CI replay happen, cannot tell a running gate from a stuck one, and a failure is a
   one-line digest string.
3. **It's buffered.** `runAgentCiWorkflows` uses `runNative` (whole-stdout-then-parse), so
   even if surfaced there is nothing to stream — no "what is happening right now."

## 2. Goals / Non-goals

**Goals**
- **Cross-platform invocation with honest capability reporting.** Linux/Mac: run agent-ci
  natively. Windows: detect WSL and transparently proxy the whole agent-ci process *into*
  WSL (where its POSIX tar + Docker work), mapping the worktree path to `/mnt/<drive>/...`.
  No WSL on Windows: a **specific, actionable** signal ("agent-ci gate requires WSL on
  Windows") surfaced BOTH in Project Settings (before a run) AND as the gate/escalation
  reason (not the generic broken-config string).
- **Live observability.** A CI replay streams event-by-event (`run.start` / `job.start` /
  `step.start` / `step.finish{status,durationMs}` / `job.finish` / `run.finish`) to the UI:
  a compact **CI block in the Session inspector** and a dedicated **CI Run screen** showing
  the live workflow → job → step tree (Approach A — status tree, no raw step logs).
- **Durable + live transport (hybrid).** Persist every event to
  `runtime/<taskId>/agent-ci-events.ndjson` (source of truth; the screen renders a finished
  run from it) AND push live increments over SSE for the active run.
- **Richer failure signal.** On a red run the gate `reason` names the **failing step(s)**
  (from `step.finish{status:"failed"}`), not just "workflow FAILED" — more actionable for
  the worker's RETRY and for the human.
- **shadcn-first UI** (AGENTS.md): the rail block and the CI screen are compositions of
  shadcn/Base UI primitives; only a genuinely-novel widget (the step tree) is custom, and
  even then wrapped in shadcn chrome.
- **Still off by default, still never mandatory, still never replaces the critic.** The
  verdict/decision semantics from v1 are unchanged — this adds visibility + reach, not new
  gate power.

**Non-goals (this spec)**
- **Raw per-step logs** in the UI (Approach B). agent-ci's `--json` stream carries no log
  bodies (only status + duration); logs live in `~/.local/state/agent-ci/logs/...` files.
  Tailing them cross-WSL is a fragile side-channel — deferred to a **v2 follow-up**, added
  only if step-status proves insufficient.
- **A Settings *toggle*** for enabling agent-ci (config-file still enables it; Settings only
  *reports capability* this round). A full enable/allowlist editor is a later follow-up.
- **Auto-installing agent-ci or WSL.** We detect and report; the operator installs.
- **Speeding up the `/mnt` 9p mount.** Running agent-ci in WSL against a Windows-filesystem
  worktree (`/mnt/d/...`) is correct but slower than a native-WSL path; acceptable for v1.
- **Any change to the pass/fail/infra verdict semantics or the RETRY/ESCALATE/COMMIT
  machinery** — unchanged from v1.

## 3. Behavior

### 3a. Cross-platform invocation (the capability layer)

A new pure-ish module decides HOW to spawn agent-ci and can report capability WITHOUT
running a workflow:

```
detectAgentCiCapability(deps) -> {
  mode: "native" | "wsl" | "unavailable",
  reason?: "needs-wsl-on-windows" | "agent-ci-not-found",
  detail: string,          // human string for the UI + escalation
}
```
- **Linux/Mac** (`process.platform !== "win32"`): `mode: "native"` (agent-ci is invoked
  directly; a missing binary surfaces at run time as an infra failure, same as v1).
- **Windows**: probe WSL (`wsl.exe --status` exit 0, or `wsl.exe -l -q` yields ≥1 distro).
  - WSL present → `mode: "wsl"`.
  - WSL absent → `mode: "unavailable", reason: "needs-wsl-on-windows"`.

`buildAgentCiCommand(mode, { cwd, workflow })` returns the `{ command, args }` to spawn:
- native: `npx ["@redwoodjs/agent-ci","run","--workflow",wf,"--json"]`, cwd = worktree.
- wsl: `wsl.exe ["-e","bash","-lc", <script>]`, where `<script>` = `cd '<posixCwd>' && npx
  @redwoodjs/agent-ci run --workflow '<wf>' --json`, `posixCwd` = `winToWslPath(worktree)`
  (`D:\a\b` → `/mnt/d/a/b`, drive lowercased, backslashes → `/`, single-quotes escaped).
  cwd stays the Windows worktree (harmless; the `cd` inside the script is authoritative).

Security note (this is a new spawn-into-WSL surface): the only interpolated values are the
harness's own worktree path and the **operator-allowlisted** workflow paths — never worker
or model output. `winToWslPath` rejects a path it cannot map (UNC, no drive letter) →
treated as `unavailable`. The workflow strings are already the explicit `gate.agentCi.workflows`
allowlist (no auto-discovery), single-quote-escaped for the `bash -lc` script.

### 3b. Where `unavailable` goes

When capability is `unavailable` at gate time, `runAgentCiWorkflows` **throws a typed
`AgentCiUnavailableError`** carrying `reason`+`detail`. It still propagates out of `runGate`
into the existing conductor try/catch (v1 contract) — but the conductor's escalation `reason`
becomes the SPECIFIC detail (`agent-ci gate requires WSL on Windows -- install WSL or run the
daemon on Linux/Mac`), not the generic broken-config line. (Small, contained change in the
conductor's gate-throw branch: if the thrown error is an `AgentCiUnavailableError`, use its
detail as the escalation reason.)

### 3c. Streaming execution (refactor of `agent-ci.ts`)

`runAgentCiWorkflows` changes from buffered to **streaming**, but keeps its exact return
contract (`{green, reasons}` | throw-on-infra):
- It spawns via the capability layer (native or wsl), reads stdout **line-by-line as it
  arrives** (a remainder buffer over `data` chunks, mirroring `claude-chat-process.ts` /
  `detect/agent-extensions.ts`), and parses each line into a typed `AgentCiEvent`.
- For every parsed event it invokes an injected **`onEvent(workflow, event)`** callback
  (the caller wires this to persist + publish — the module itself owns no I/O beyond the
  spawn, staying unit-testable).
- It accumulates events to derive the terminal verdict per workflow (the existing
  fail-closed, last-`run.finish`-wins, `event ?? type` keyed logic — now fed the parsed
  event objects instead of a re-split of buffered stdout) and, on failure, collects the
  names of `step.finish` events with `status:"failed"` for the enriched `reason`.
- Timeout (own child-kill via the exec layer) and "no terminal event" infra semantics are
  unchanged.

New event type (verified against the real captured stream):
```
type AgentCiEvent =
  | { kind: "run-start"; runId?: string }
  | { kind: "job-start"; job: string; runner?: string; workflow?: string }
  | { kind: "step-start"; job: string; step: string; index: number }
  | { kind: "step-finish"; job: string; step: string; index: number; status: string; durationMs?: number }
  | { kind: "job-finish"; job: string; status: string; durationMs?: number }
  | { kind: "run-finish"; status: string }
  | { kind: "other" }   // ignored for verdict; still persisted/streamed verbatim
```
`parseAgentCiEvent(line)` keys off `obj.event ?? obj.type` (real shape = `event`).

### 3d. Transport (hybrid: persist + SSE)

- **Persist:** the gate's `onEvent` closure (built in `root.ts`, has `repo`) appends each
  event as one JSON line to `runtime/<taskId>/agent-ci-events.ndjson` (best-effort, never
  throws into the gate — a persist failure must not fail a real CI verdict). It also writes a
  small `agent-ci-status.json` summary (current phase / workflow / counts / verdict) that the
  rail block and a finished-run screen read cheaply without replaying the whole ndjson.
- **Live:** a per-`(projectId, taskId)` **CI event bus** (a tiny in-memory registry, sibling
  to `ChatSessionManager`'s shape but far simpler — no child lifecycle, just fan-out) that
  `onEvent` publishes to. A new SSE route streams it:
  `GET /projects/:id/ci/:taskId/stream` — on connect, replays the persisted ndjson so far
  (history), then forwards live bus events; `res.flushHeaders()` up front (chat-SSE gotcha
  `[chat/onToken-bound-once]`'s sibling: flush or the client sees nothing). Detaches cleanly
  on client disconnect; bounded, and closed on daemon shutdown.
- The route sits on the existing `ProjectView` seam as an optional capability
  (`onCiStream?`), 404 when unset — mirrors `onScanExtensions` / the chat routes.

### 3e. UI (shadcn-first)

- **Session inspector `CI` block** (`ui/src/components/SessionRail.tsx`, a new `<Block
  title="CI">`, shown ONLY when `cfg.gate.agentCi.enabled`): compact status per the approved
  mockup — `status ● running` / `✓ passed` / `✗ failed (step "…")` / `⚠ unavailable (needs
  WSL)`, the workflow + `N/M steps · elapsed`, and an `open CI run →` link. Reads
  `agent-ci-status.json` (via the existing runtime-file query) refreshed on the root WS +
  the SSE hook while a run is live. Built from the existing `Block`/`Badge`/`Dot`/`Spinner`
  primitives (no new widget).
- **CI Run screen** (`ui/src/screens/CiRunView.tsx`, new route reachable from the block's
  link AND a button/tab on `RunView`): the live workflow → job → step tree per the approved
  mockup. Composition: shadcn `Card` (frame), `Collapsible` (job groups), `Badge` + status
  `Dot`/`Spinner`/check/cross glyphs (per-step + per-run status), a footer line mapping the
  verdict → the gate decision (`agent_ci_green ✓ → COMMIT unaffected` / `✗ → RETRY`). The
  tree rows themselves are the one custom part (no shadcn "CI tree" primitive) — but each row
  is shadcn chrome. Live via a new `useCiEvents(projectId, taskId)` SSE hook (mirrors the
  chat stream hook); renders from the persisted ndjson for a finished/reloaded run.
- **Project Settings capability line** (`ui/src/screens/ProjectSettingsView.tsx`, in/near the
  gate section): a read-only "agent-ci: native / via WSL / **needs WSL on Windows**" status
  from a new `GET /projects/:id/ci/capability` (calls `detectAgentCiCapability`). Honest,
  before a run. shadcn `Badge` + helper text; no toggle this round.

### 3f. Pipeline position + "Now" block

Unchanged gate position (still step "1c"). The SessionRail "Now" block's inferred pipeline
gains an agent-ci sub-note when a CI replay is live for the active task (`gate (CI ● 3/5) →
critic → commit`) so the existing pipeline view stays honest.

## 4. Components (new/changed)

**Backend**
- `src/gate/agent-ci-exec.ts` (new) — `detectAgentCiCapability`, `winToWslPath`,
  `buildAgentCiCommand`, and the streaming spawner (native/wsl), injectable for tests.
- `src/gate/agent-ci-events.ts` (new) — `AgentCiEvent` + `parseAgentCiEvent` (extracted +
  extended from v1's `parseWorkflowOutcome`, which becomes a thin consumer of parsed events).
- `src/gate/agent-ci.ts` (changed) — streaming `runAgentCiWorkflows` with `onEvent` +
  `exec`/capability injection; verdict derivation over parsed events; failing-step reasons;
  typed `AgentCiUnavailableError`.
- `src/api/ci-events.ts` (new) — the per-task CI event bus + the SSE handler.
- `src/api/server.ts` / `src/index.ts` (changed) — wire `GET /projects/:id/ci/:taskId/stream`
  and `GET /projects/:id/ci/capability` behind optional `ProjectView` capabilities.
- `src/composition/root.ts` (changed) — build `runAgentCi` with the capability-aware exec +
  the `onEvent` persist/publish closure (append ndjson + write status summary + bus publish).
- `src/conductor/conductor.ts` (small change) — gate-throw branch uses an
  `AgentCiUnavailableError`'s detail as the escalation reason.
- `src/config/schema.ts` — unchanged (v1 block suffices).

**UI (shadcn-first)**
- `ui/src/components/SessionRail.tsx` — new `CI` block + "Now" sub-note.
- `ui/src/screens/CiRunView.tsx` (new) — the step-tree screen + route.
- `ui/src/lib/queries.ts` / `api.ts` — `useCiEvents` SSE hook, `useCiStatus`, `useCiCapability`.
- `ui/src/screens/ProjectSettingsView.tsx` — capability status line.

## 5. Error handling

- **WSL absent on Windows** → `AgentCiUnavailableError("needs-wsl-on-windows")` → specific
  escalation reason + Settings shows "needs WSL"; NEVER the generic broken-config string.
- **`winToWslPath` can't map the worktree** (UNC/no drive) → `unavailable` with that detail.
- **Persist/SSE failure** is best-effort and MUST NOT fail a real CI verdict — the gate
  decision derives from the in-process event accumulation, not from a successful write/stream.
- **SSE client disconnect / daemon shutdown** → detach + close the bus subscription (bounded,
  no leak); a reconnect replays the persisted ndjson.
- **Timeout / no-terminal-event / Docker-down** → infra throw, unchanged from v1.
- **Empty allowlist while enabled** → WARN + skip, unchanged from v1.

## 6. Testing / verification

- `agent-ci-exec.test.ts`: `winToWslPath` cases (drive map, backslashes, quote-escape, UNC
  reject); `detectAgentCiCapability` (posix→native; win+WSL→wsl; win+no-WSL→unavailable) with
  a faked platform + WSL probe; `buildAgentCiCommand` shape for native vs wsl.
- `agent-ci-events.test.ts`: `parseAgentCiEvent` over the **verbatim real captured lines**
  (run/job/step/finish, `event`-keyed) → correct typed events; unknown line → `other`.
- `agent-ci.test.ts` (extended): streaming `runAgentCiWorkflows` with a fake exec emitting a
  scripted event sequence → asserts `onEvent` fired per event, final `{green,reasons}` correct
  (incl. failing-step names in `reasons`), and the throw-vs-return + infra + timeout contracts
  all still hold. Keep the existing verbatim pass/fail fixtures.
- `ci-events.test.ts`: bus fan-out + SSE handler (history replay then live, flush, detach).
- `gate.test.ts`: unchanged v1 tests stay green (the verdict contract is identical); add one
  asserting an `AgentCiUnavailableError` propagates out of `runGate`.
- **Mandatory codex GPT-5.5 gate** on the `gate.ts` + `agent-ci*.ts` diff.
- **Live-prove THROUGH the daemon + browser this time** (the operator's core ask): run the
  harness with a project on `gate.agentCi`, drive a real task, and watch in the actual UI —
  the CI block go running→passed, the CI screen stream the step tree live, a failing workflow
  drive RETRY with the failing-step reason, and (on native Windows w/o the WSL bridge active)
  the Settings capability line + escalation show the honest "needs WSL" message. On the
  operator's Windows box this exercises the **WSL-proxy happy path end-to-end** (daemon on
  Windows, agent-ci in WSL) — the thing v1 never showed.

## 7. Open questions (carried into the plan, not blocking)

- **WSL distro selection** — default distro (`wsl -e`) vs an operator-pinned one
  (`gate.agentCi.wslDistro?`). Default-distro for v1; add the config knob only if needed.
- **Node/agent-ci presence inside WSL** — the WSL distro must have node + a resolvable
  agent-ci (via `npx`/project install). Capability detection can optionally probe
  `wsl -e bash -lc "node -v"`; decide depth in the plan (a shallow "WSL present" vs a deep
  "WSL has node + agent-ci" probe — the deep one gives a better Settings message).
- **Status-summary vs ndjson-tail for the rail block** — whether `agent-ci-status.json` is
  worth it or the block can cheaply read the ndjson tail; settle in the plan.
- **One CI screen route shape** — `/p/:id/ci/:taskId` standalone vs a tab inside `RunView`;
  settle when wiring the router.

## Related

- `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` — v1 (the gate).
- `docs/superpowers/plans/2026-07-10-agent-ci-gate-hardening.md` — v1 plan.
- `[gate/agent-ci-not-runnable-on-native-windows]`, `[gate/agent-ci-ndjson-keyed-by-event-not-type]`
  — the two live-prove gotchas this design builds on.
- `src/orchestrator/claude-chat-process.ts` / `chat-session-manager.ts` — the streaming-spawn
  + SSE patterns this mirrors. `src/gate/gate.ts`, `src/composition/root.ts`, `src/conductor/conductor.ts`.
