# agent-ci observability — cross-platform invocation + live CI-run visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the off-by-default `gate.agentCi` local-CI-replay gate step runnable from the operator's native-Windows harness (via a transparent WSL proxy), stream its run event-by-event to the dashboard (a `CI` block in the SessionRail + a dedicated live step-tree screen), and report capability honestly in Project Settings — without changing v1's pass/fail/infra verdict or RETRY/ESCALATE/COMMIT semantics.

**Architecture:** A new capability layer (`agent-ci-exec.ts`) decides native vs. WSL-proxy invocation and reports capability without running a workflow. `agent-ci.ts` refactors from buffered `runNative` to a line-by-line streaming spawn that parses each stdout line into a typed `AgentCiEvent` (new `agent-ci-events.ts`) and invokes an injected `onEvent` callback; the verdict is derived from the accumulated events (contract `{green,reasons}` | throw-on-infra UNCHANGED, plus a typed `AgentCiUnavailableError` for the WSL-missing case). The composition root wires `onEvent` to persist (`runtime/<taskId>/agent-ci-events.ndjson` + `agent-ci-status.json`) and publish to a per-project in-memory `CiEventBus`; a new SSE route (`GET /projects/:id/ci/:taskId/stream`) replays the persisted ndjson then forwards live bus events. The UI mirrors the existing chat `EventSource` pattern.

**Tech Stack:** Node LTS + TypeScript, zod, cross-spawn, vitest (backend). React + Vite + TanStack Router + TanStack Query + shadcn-on-Base-UI (`base-nova`) for the UI (review-only, no UI test infra per repo convention).

---

## Locked decisions (from the spec's open questions — settled for this plan)

1. **WSL distro** — use the **default distro** (`wsl.exe -e ...`, no `-d`). No `gate.agentCi.wslDistro` config knob this round → `schema.ts` stays unchanged.
2. **Capability probe depth** — **deep**: on Windows, probe WSL present AND `node -v` resolvable inside WSL, so the Settings message is honest. Reasons: `needs-wsl-on-windows` (no distro) and `needs-node-in-wsl` (distro but no node). We do NOT hard-probe agent-ci itself (it resolves at run time via `npx` / project install); a missing binary surfaces at run time as the existing infra-throw, same as v1 native.
3. **Rail block source** — a cheap `agent-ci-status.json` summary written alongside the ndjson (rail reads the summary, not the whole ndjson tail).
4. **CI screen route** — a **standalone** `/p/$projectId/ci/$taskId` route (not a RunView tab).
5. **Persisted/streamed events** — only STRUCTURED events (`kind !== "other"`) are persisted + streamed. Non-JSON log lines and unrecognized shapes are dropped. This is a conscious, minor deviation from the spec's "persist verbatim" wording, justified because the CI screen renders only the typed workflow→job→step tree and raw log bodies are an explicit v2 non-goal. (If the operator wants raw lines retained, that is a one-line change in the `onLine` closure — flag it, don't silently expand scope.)

## File Structure

**Backend (new)**
- `src/gate/agent-ci-events.ts` — `AgentCiEvent` union + `parseAgentCiEvent(line)` + `deriveWorkflowVerdict(events)`. Pure, no I/O.
- `src/gate/agent-ci-exec.ts` — `AgentCiCapability`, `AgentCiUnavailableError`, `winToWslPath`, `buildAgentCiCommand`, `detectAgentCiCapability`, the streaming `AgentCiSpawner` type + real `spawnAgentCiStream`. Capability + spawn; injectable for tests.
- `src/api/ci-events.ts` — `CiStreamSink`, `CiEventBus` (per-project fan-out registry) + `handleCiStream` (SSE: history replay then live) + `handleCiCapability`.

**Backend (changed)**
- `src/gate/agent-ci.ts` — streaming `runAgentCiWorkflows` over injected capability + spawner + `onEvent`; verdict over parsed events; failing-step reasons; throws `AgentCiUnavailableError`.
- `src/gate/gate.ts` — `runGate` threads `taskId` into `runAgentCi(taskId)` (step 1c).
- `src/composition/root.ts` — capability-aware exec + the `onEvent` persist/publish closure; a lazily-built per-project `CiEventBus`; expose `ci` + `onCiCapability` on `ProjectRoot`.
- `src/conductor/conductor.ts` — gate-throw branch captures the error; an `AgentCiUnavailableError`'s `detail` becomes the escalation reason.
- `src/api/server.ts` — `ProjectView.ci?` + `ProjectView.onCiCapability?`; route dispatch for `GET /ci/:taskId/stream` + `GET /ci/capability`; register the bus in the per-project map + close on shutdown/evict.
- `src/index.ts` — wire `ci` + `onCiCapability` into the `ProjectView` in `projects.get`.
- `src/config/schema.ts` — UNCHANGED (v1 block suffices).

**UI (new)**
- `ui/src/views/CiRunView.tsx` — the live workflow→job→step tree screen.

**UI (changed)**
- `ui/src/lib/api.ts` — `CiStatus`/`CiCapability`/`CiEventFrame` types, `getCiStatus`, `getCiCapability`, `ciEventsUrl`.
- `ui/src/lib/queries.ts` — `qk.ciStatus`/`qk.ciCapability`, `useCiStatus`, `useCiCapability`, `useCiEvents` (SSE).
- `ui/src/components/SessionRail.tsx` — a `CI` `<Block>` (only when `cfg.gate.agentCi.enabled`) + a "Now" sub-note.
- `ui/src/views/ProjectSettingsView.tsx` — a read-only CI capability line.
- `ui/src/views/RunView.tsx` — a `Link` to the CI screen in the run-header actions bar.
- `ui/src/router.tsx` — a `ciRunRoute` child of `projectRoute`.

---

## Task 1: `agent-ci-events.ts` — typed events + parser + verdict derivation

**Files:**
- Create: `src/gate/agent-ci-events.ts`
- Test: `src/gate/agent-ci-events.test.ts`

- [ ] **Step 1: Write the failing test** (verbatim real NDJSON shapes from the s37 live-prove — pin them)

```ts
// src/gate/agent-ci-events.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentCiEvent, deriveWorkflowVerdict, type AgentCiEvent } from "./agent-ci-events.js";

describe("parseAgentCiEvent", () => {
  it("parses a run.start line keyed by `event`", () => {
    const ev = parseAgentCiEvent('{"event":"run.start","ts":"2026-07-10T00:00:00Z","runId":"r1"}');
    expect(ev).toEqual({ kind: "run-start", runId: "r1" });
  });

  it("parses a step.finish with status + durationMs", () => {
    const ev = parseAgentCiEvent('{"event":"step.finish","job":"build","step":"npm test","index":2,"status":"passed","durationMs":1234}');
    expect(ev).toEqual({ kind: "step-finish", job: "build", step: "npm test", index: 2, status: "passed", durationMs: 1234 });
  });

  it("parses the terminal run.finish", () => {
    expect(parseAgentCiEvent('{"event":"run.finish","status":"failed"}')).toEqual({ kind: "run-finish", status: "failed" });
  });

  it("falls back to the legacy `type` key when `event` is absent", () => {
    expect(parseAgentCiEvent('{"type":"run.finish","status":"passed"}')).toEqual({ kind: "run-finish", status: "passed" });
  });

  it("maps a non-JSON log line to { kind: 'other' }", () => {
    expect(parseAgentCiEvent("Pulling image ghcr.io/actions/actions-runner...")).toEqual({ kind: "other" });
  });

  it("maps an unrecognized JSON event to { kind: 'other' }", () => {
    expect(parseAgentCiEvent('{"event":"cache.hit","key":"x"}')).toEqual({ kind: "other" });
  });
});

describe("deriveWorkflowVerdict", () => {
  const ev = (e: AgentCiEvent): AgentCiEvent => e;

  it("returns 'infra' when there is no terminal run-finish event", () => {
    const events = [ev({ kind: "run-start" }), ev({ kind: "job-start", job: "build" })];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "infra", failedSteps: [] });
  });

  it("returns 'passed' on a passed run-finish", () => {
    const events = [ev({ kind: "run-finish", status: "passed" })];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "passed", failedSteps: [] });
  });

  it("returns 'failed' with the failing step names on a failed run", () => {
    const events = [
      ev({ kind: "step-finish", job: "build", step: "lint", index: 0, status: "passed" }),
      ev({ kind: "step-finish", job: "build", step: "unit tests", index: 1, status: "failed" }),
      ev({ kind: "run-finish", status: "failed" }),
    ];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "failed", failedSteps: ["unit tests"] });
  });

  it("last run-finish wins (a late 'failed' after a 'passed' reads as failed)", () => {
    const events = [ev({ kind: "run-finish", status: "passed" }), ev({ kind: "run-finish", status: "failed" })];
    expect(deriveWorkflowVerdict(events).outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent-ci-events`
Expected: FAIL — `Cannot find module './agent-ci-events.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/gate/agent-ci-events.ts

/**
 * Typed view of one line of agent-ci's `--json` NDJSON stream.
 * Real shape (verified against @redwoodjs/agent-ci@0.16.2, s37 live-prove): every line
 * is keyed by `event` (NOT `type`); the terminal line is
 * `{"event":"run.finish","status":"passed"|"failed"}`. See gotcha
 * [gate/agent-ci-ndjson-keyed-by-event-not-type].
 */
export type AgentCiEvent =
  | { kind: "run-start"; runId?: string }
  | { kind: "job-start"; job: string; runner?: string; workflow?: string }
  | { kind: "step-start"; job: string; step: string; index: number }
  | { kind: "step-finish"; job: string; step: string; index: number; status: string; durationMs?: number }
  | { kind: "job-finish"; job: string; status: string; durationMs?: number }
  | { kind: "run-finish"; status: string }
  | { kind: "other" };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Parse one raw stdout line into a typed event. Non-JSON / unrecognized → { kind: "other" }. */
export function parseAgentCiEvent(line: string): AgentCiEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "other" };
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "other" };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }

  const kind = str(obj["event"]) ?? str(obj["type"]); // real key = `event`; `type` a defensive fallback
  const job = str(obj["job"]);
  const step = str(obj["step"]);
  const index = num(obj["index"]) ?? 0;
  const status = str(obj["status"]) ?? str(obj["conclusion"]) ?? str(obj["result"]) ?? "";
  const durationMs = num(obj["durationMs"]);

  switch (kind) {
    case "run.start":
      return { kind: "run-start", ...(str(obj["runId"]) ? { runId: str(obj["runId"])! } : {}) };
    case "job.start":
      return { kind: "job-start", job: job ?? "", ...(str(obj["runner"]) ? { runner: str(obj["runner"])! } : {}), ...(str(obj["workflow"]) ? { workflow: str(obj["workflow"])! } : {}) };
    case "step.start":
      return { kind: "step-start", job: job ?? "", step: step ?? "", index };
    case "step.finish":
      return { kind: "step-finish", job: job ?? "", step: step ?? "", index, status, ...(durationMs !== undefined ? { durationMs } : {}) };
    case "job.finish":
      return { kind: "job-finish", job: job ?? "", status, ...(durationMs !== undefined ? { durationMs } : {}) };
    case "run.finish":
    case "run.finished":
    case "run.complete":
      return { kind: "run-finish", status };
    default:
      return { kind: "other" };
  }
}

function isPassed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "passed" || s === "success" || s === "succeeded";
}
function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "failure" || s === "error";
}

export interface WorkflowVerdict {
  outcome: "passed" | "failed" | "infra";
  failedSteps: string[];
}

/**
 * Derive the per-workflow verdict from accumulated events. Fail-closed:
 * no terminal run-finish → "infra" (throw upstream); LAST run-finish wins;
 * a run-finish whose status is neither pass nor fail reads as "failed" (never pass).
 */
export function deriveWorkflowVerdict(events: AgentCiEvent[]): WorkflowVerdict {
  let terminal: "passed" | "failed" | null = null;
  const failedSteps: string[] = [];
  for (const e of events) {
    if (e.kind === "run-finish") {
      terminal = isPassed(e.status) ? "passed" : "failed";
    } else if (e.kind === "step-finish" && isFailed(e.status)) {
      failedSteps.push(e.step);
    }
  }
  if (terminal === null) return { outcome: "infra", failedSteps: [] };
  return { outcome: terminal, failedSteps: terminal === "failed" ? failedSteps : [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent-ci-events`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck** (parallel-subagent safety — vitest doesn't typecheck; note gotcha `[ts/zod]`/`[ts/typecheck-scope]`)

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/gate/agent-ci-events.ts src/gate/agent-ci-events.test.ts
git commit -m "feat(gate): typed agent-ci NDJSON events + verdict derivation"
```

---

## Task 2: `agent-ci-exec.ts` — capability layer + cross-platform command + streaming spawner

**Files:**
- Create: `src/gate/agent-ci-exec.ts`
- Test: `src/gate/agent-ci-exec.test.ts`

- [ ] **Step 1: Write the failing test** (pure helpers + faked platform/WSL probe; the real spawner is exercised in Task 3 via injection)

```ts
// src/gate/agent-ci-exec.test.ts
import { describe, it, expect } from "vitest";
import {
  winToWslPath,
  buildAgentCiCommand,
  detectAgentCiCapability,
  AgentCiUnavailableError,
} from "./agent-ci-exec.js";

describe("winToWslPath", () => {
  it("maps a drive path to /mnt/<drive> with lowercased drive + forward slashes", () => {
    expect(winToWslPath("D:\\a\\b c")).toBe("/mnt/d/a/b c");
  });
  it("returns null for a UNC path (no drive letter)", () => {
    expect(winToWslPath("\\\\server\\share\\x")).toBeNull();
  });
  it("returns null for a path with no drive letter", () => {
    expect(winToWslPath("relative\\path")).toBeNull();
  });
});

describe("buildAgentCiCommand", () => {
  it("native: npx @redwoodjs/agent-ci run --workflow <wf> --json", () => {
    const { command, args } = buildAgentCiCommand("native", { cwd: "/repo", workflow: "ci.yml" });
    expect(command).toBe("npx");
    expect(args).toEqual(["@redwoodjs/agent-ci", "run", "--workflow", "ci.yml", "--json"]);
  });
  it("wsl: wsl.exe -e bash -lc with a cd into the posix cwd + single-quote-escaped workflow", () => {
    const { command, args } = buildAgentCiCommand("wsl", { cwd: "/mnt/d/a", workflow: "ci.yml" });
    expect(command).toBe("wsl.exe");
    expect(args[0]).toBe("-e");
    expect(args[1]).toBe("bash");
    expect(args[2]).toBe("-lc");
    expect(args[3]).toBe("cd '/mnt/d/a' && npx @redwoodjs/agent-ci run --workflow 'ci.yml' --json");
  });
});

describe("detectAgentCiCapability", () => {
  it("posix → native", async () => {
    const cap = await detectAgentCiCapability({ platform: "linux", probeWsl: async () => ({ hasDistro: false, hasNode: false }) });
    expect(cap.mode).toBe("native");
  });
  it("win + WSL distro + node → wsl", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: true, hasNode: true }) });
    expect(cap.mode).toBe("wsl");
  });
  it("win + no WSL distro → unavailable(needs-wsl-on-windows)", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: false, hasNode: false }) });
    expect(cap.mode).toBe("unavailable");
    expect(cap.reason).toBe("needs-wsl-on-windows");
    expect(cap.detail).toMatch(/WSL/i);
  });
  it("win + WSL distro but no node → unavailable(needs-node-in-wsl)", async () => {
    const cap = await detectAgentCiCapability({ platform: "win32", probeWsl: async () => ({ hasDistro: true, hasNode: false }) });
    expect(cap.mode).toBe("unavailable");
    expect(cap.reason).toBe("needs-node-in-wsl");
  });
});

describe("AgentCiUnavailableError", () => {
  it("carries reason + detail", () => {
    const e = new AgentCiUnavailableError("needs-wsl-on-windows", "agent-ci gate requires WSL on Windows");
    expect(e.reason).toBe("needs-wsl-on-windows");
    expect(e.detail).toBe("agent-ci gate requires WSL on Windows");
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent-ci-exec`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/gate/agent-ci-exec.ts
import spawn from "cross-spawn";

const SIGKILL_GRACE_MS = 2000;
const MAX_REMAINDER_BYTES = 1_000_000;
const WSL_PROBE_TIMEOUT_MS = 5000;

export type AgentCiMode = "native" | "wsl" | "unavailable";
export type AgentCiUnavailableReason = "needs-wsl-on-windows" | "needs-node-in-wsl";

export interface AgentCiCapability {
  mode: AgentCiMode;
  reason?: AgentCiUnavailableReason;
  detail: string; // human string for the UI + escalation
}

/** Thrown by runAgentCiWorkflows when capability is `unavailable`. Propagates through
 *  runGate into the conductor, whose escalation reason becomes `detail` (not the generic
 *  "gate threw -- broken operator config"). */
export class AgentCiUnavailableError extends Error {
  constructor(readonly reason: AgentCiUnavailableReason, readonly detail: string) {
    super(detail);
    this.name = "AgentCiUnavailableError";
  }
}

/** Map a Windows path to its WSL `/mnt/<drive>/...` form. Returns null for a path we
 *  cannot map (UNC, no drive letter) — the caller treats null as `unavailable`. */
export function winToWslPath(winPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function shSingleQuote(s: string): string {
  // POSIX single-quote escaping: ' -> '\''
  return s.replace(/'/g, "'\\''");
}

export function buildAgentCiCommand(
  mode: "native" | "wsl",
  opts: { cwd: string; workflow: string },
): { command: string; args: string[] } {
  if (mode === "native") {
    return { command: "npx", args: ["@redwoodjs/agent-ci", "run", "--workflow", opts.workflow, "--json"] };
  }
  const script = `cd '${shSingleQuote(opts.cwd)}' && npx @redwoodjs/agent-ci run --workflow '${shSingleQuote(opts.workflow)}' --json`;
  return { command: "wsl.exe", args: ["-e", "bash", "-lc", script] };
}

export interface WslProbeResult {
  hasDistro: boolean;
  hasNode: boolean;
}

/** Real WSL probe: a distro exists if `wsl.exe -l -q` yields ≥1 non-empty line;
 *  node exists if `wsl.exe -e bash -lc "node -v"` exits 0. Best-effort, bounded. */
export async function probeWslReal(): Promise<WslProbeResult> {
  const listOut = await runProbe("wsl.exe", ["-l", "-q"]);
  // wsl -l -q output is UTF-16LE with NULs; strip them and check for any non-empty line.
  const distros = listOut.stdout.replace(/ /g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const hasDistro = listOut.exitCode === 0 && distros.length > 0;
  if (!hasDistro) return { hasDistro: false, hasNode: false };
  const nodeOut = await runProbe("wsl.exe", ["-e", "bash", "-lc", "node -v"]);
  return { hasDistro: true, hasNode: nodeOut.exitCode === 0 && /v\d/.test(nodeOut.stdout) };
}

function runProbe(command: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: process.env });
    } catch {
      done(-1);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      done(-1);
    }, WSL_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { stdout += c; });
    child.on("error", () => { clearTimeout(timer); done(-1); });
    child.on("close", (code) => { clearTimeout(timer); done(code ?? -1); });
    child.stdin?.on("error", () => {});
    child.stdin?.end("");
  });
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  probeWsl?: () => Promise<WslProbeResult>;
}

export async function detectAgentCiCapability(deps: DetectDeps = {}): Promise<AgentCiCapability> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return { mode: "native", detail: "agent-ci runs natively on this platform" };
  }
  const probe = deps.probeWsl ?? probeWslReal;
  const { hasDistro, hasNode } = await probe();
  if (!hasDistro) {
    return {
      mode: "unavailable",
      reason: "needs-wsl-on-windows",
      detail: "agent-ci gate requires WSL on Windows -- install WSL or run the daemon on Linux/Mac",
    };
  }
  if (!hasNode) {
    return {
      mode: "unavailable",
      reason: "needs-node-in-wsl",
      detail: "agent-ci gate requires Node.js inside your WSL distro -- install node in WSL (e.g. via nvm)",
    };
  }
  return { mode: "wsl", detail: "agent-ci runs via WSL on this Windows host" };
}

// ---- Streaming spawner (native or wsl; the command/args already encode the mode) ----

export interface AgentCiSpawnInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onLine: (line: string) => void;
}

/** Mirrors runNative's / makeStreamingSpawnInit's kill discipline, but streams stdout
 *  line-by-line to `onLine` instead of buffering. Never rejects on non-zero exit;
 *  resolves { exitCode } (a timeout resolves with the killed child's code). */
export type AgentCiSpawner = (input: AgentCiSpawnInput) => Promise<{ exitCode: number }>;

export const spawnAgentCiStream: AgentCiSpawner = (input) =>
  new Promise((resolve) => {
    let remainder = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const resolveOnce = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve({ exitCode });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env });
    } catch {
      resolveOnce(-1);
      return;
    }

    const killChild = (): void => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };
    const deadline = setTimeout(() => {
      killChild();
      resolveOnce(-1);
    }, input.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      remainder += chunk;
      let nl: number;
      while ((nl = remainder.indexOf("\n")) !== -1) {
        const line = remainder.slice(0, nl);
        remainder = remainder.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try { input.onLine(line); } catch { /* a bad consumer must never crash the run */ }
      }
      if (remainder.length > MAX_REMAINDER_BYTES) remainder = ""; // memory bound; time bound = deadline
    });
    child.stderr?.on("data", () => {}); // drain to avoid pipe backpressure

    child.on("error", () => { resolveOnce(-1); });
    child.on("close", (code) => {
      if (remainder.trim().length > 0) {
        try { input.onLine(remainder); } catch { /* ignore */ }
      }
      resolveOnce(code ?? -1);
    });
    child.stdin?.on("error", () => {}); // EPIPE guard
    child.stdin?.end("");
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent-ci-exec`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (Note `exactOptionalPropertyTypes` — the conditional-spread idiom above (`...(x ? {k:x} : {})`) is deliberate to satisfy it; do not switch to `k: x ?? undefined`.)

- [ ] **Step 6: Commit**

```bash
git add src/gate/agent-ci-exec.ts src/gate/agent-ci-exec.test.ts
git commit -m "feat(gate): agent-ci cross-platform capability + WSL-proxy command + streaming spawner"
```

---

## Task 3: refactor `agent-ci.ts` to streaming + capability + onEvent

**Files:**
- Modify: `src/gate/agent-ci.ts` (replace the buffered `runOne`/`parseWorkflowOutcome` internals; keep the module's public role)
- Test: `src/gate/agent-ci.test.ts` (extend; keep any still-relevant fixtures)

- [ ] **Step 1: Write the failing test** (a fake spawner emits a scripted line sequence; assert onEvent fired, verdict, failing-step reasons, unavailable-throw, infra-throw)

```ts
// src/gate/agent-ci.test.ts  (add these; keep existing verbatim-NDJSON fixture tests that still apply)
import { describe, it, expect, vi } from "vitest";
import { runAgentCiWorkflows, type RunAgentCiInput } from "./agent-ci.js";
import { AgentCiUnavailableError, type AgentCiSpawner } from "./agent-ci-exec.js";
import type { AgentCiEvent } from "./agent-ci-events.js";

function fakeSpawnerFromLines(linesByWorkflow: Record<string, string[]>): AgentCiSpawner {
  return async ({ args, onLine }) => {
    // native args: [..., "--workflow", wf, "--json"]; wsl args: the script has the wf too.
    const wfIdx = args.indexOf("--workflow");
    const wf = wfIdx >= 0 ? args[wfIdx + 1]! : Object.keys(linesByWorkflow)[0]!;
    for (const l of linesByWorkflow[wf] ?? []) onLine(l);
    return { exitCode: 0 };
  };
}

const nativeCap = async () => ({ mode: "native" as const, detail: "native" });

function baseInput(over: Partial<RunAgentCiInput>): RunAgentCiInput {
  return {
    cwd: "/repo",
    workflows: ["ci.yml"],
    timeoutMs: 600000,
    detectCapability: nativeCap,
    spawn: fakeSpawnerFromLines({ "ci.yml": ['{"event":"run.finish","status":"passed"}'] }),
    onEvent: () => {},
    ...over,
  };
}

describe("runAgentCiWorkflows (streaming)", () => {
  it("green on a passed workflow; fires onEvent per structured event", async () => {
    const seen: Array<[string, AgentCiEvent]> = [];
    const res = await runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": [
        '{"event":"run.start"}',
        '{"event":"step.finish","job":"build","step":"lint","index":0,"status":"passed"}',
        'Pulling image...',            // non-JSON -> dropped, no onEvent
        '{"event":"run.finish","status":"passed"}',
      ] }),
      onEvent: (wf, ev) => seen.push([wf, ev]),
    }));
    expect(res).toEqual({ green: true, reasons: [] });
    expect(seen.map(([, e]) => e.kind)).toEqual(["run-start", "step-finish", "run-finish"]); // "other" dropped
    expect(seen.every(([wf]) => wf === "ci.yml")).toBe(true);
  });

  it("red on a failed workflow; reason names the failing step", async () => {
    const res = await runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": [
        '{"event":"step.finish","job":"build","step":"unit tests","index":1,"status":"failed"}',
        '{"event":"run.finish","status":"failed"}',
      ] }),
    }));
    expect(res.green).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/ci\.yml/);
    expect(res.reasons.join(" ")).toMatch(/unit tests/);
  });

  it("throws (infra) when a workflow produces no terminal run-finish", async () => {
    await expect(runAgentCiWorkflows(baseInput({
      spawn: fakeSpawnerFromLines({ "ci.yml": ['{"event":"run.start"}'] }),
    }))).rejects.toThrow(/infrastructure|no parseable|run\.finish/i);
  });

  it("throws AgentCiUnavailableError when capability is unavailable (never spawns)", async () => {
    const spawn = vi.fn(fakeSpawnerFromLines({ "ci.yml": [] }));
    await expect(runAgentCiWorkflows(baseInput({
      detectCapability: async () => ({ mode: "unavailable", reason: "needs-wsl-on-windows", detail: "needs WSL" }),
      spawn,
    }))).rejects.toBeInstanceOf(AgentCiUnavailableError);
    expect(spawn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent-ci.test`
Expected: FAIL — new `RunAgentCiInput` fields (`detectCapability`/`spawn`/`onEvent`) don't exist yet; `runAgentCiWorkflows` still buffered.

- [ ] **Step 3: Rewrite `src/gate/agent-ci.ts`**

```ts
// src/gate/agent-ci.ts
import {
  AgentCiUnavailableError,
  buildAgentCiCommand,
  detectAgentCiCapability,
  spawnAgentCiStream,
  type AgentCiCapability,
  type AgentCiSpawner,
} from "./agent-ci-exec.js";
import { deriveWorkflowVerdict, parseAgentCiEvent, type AgentCiEvent } from "./agent-ci-events.js";

export interface RunAgentCiInput {
  cwd: string;
  workflows: string[];
  timeoutMs: number;
  /** Decides native/wsl/unavailable. Injected (defaults to the real probe in root.ts). */
  detectCapability: () => Promise<AgentCiCapability>;
  /** Streaming spawner (native or wsl). Injected; defaults to spawnAgentCiStream in root.ts. */
  spawn: AgentCiSpawner;
  /** Called for every STRUCTURED event (kind !== "other"). The caller persists + publishes. */
  onEvent: (workflow: string, event: AgentCiEvent) => void;
}

export interface AgentCiResult {
  green: boolean;
  reasons: string[];
}

const AGENT_CI_ENV = { AGENT_CI_JSON: "1", AI_AGENT: "1" } as const;

/**
 * Streaming local-CI replay. Contract UNCHANGED from v1: returns { green, reasons } for a
 * clean/failed run; THROWS on an infra failure (no terminal event / timeout) so the conductor
 * escalates. NEW: throws a typed AgentCiUnavailableError when the platform can't run agent-ci
 * (Windows w/o WSL), and streams each parsed event to `onEvent`.
 */
export async function runAgentCiWorkflows(input: RunAgentCiInput): Promise<AgentCiResult> {
  const capability = await input.detectCapability();
  if (capability.mode === "unavailable") {
    throw new AgentCiUnavailableError(capability.reason ?? "needs-wsl-on-windows", capability.detail);
  }

  const reasons: string[] = [];
  let green = true;

  for (const wf of input.workflows) {
    const events: AgentCiEvent[] = [];
    const { command, args } = buildAgentCiCommand(capability.mode, { cwd: input.cwd, workflow: wf });
    const { exitCode } = await input.spawn({
      command,
      args,
      cwd: input.cwd,
      env: { ...process.env, ...AGENT_CI_ENV },
      timeoutMs: input.timeoutMs,
      onLine: (line) => {
        const ev = parseAgentCiEvent(line);
        if (ev.kind === "other") return; // non-structured line: not persisted/streamed (see plan decision 5)
        events.push(ev);
        input.onEvent(wf, ev);
      },
    });

    const verdict = deriveWorkflowVerdict(events);
    if (verdict.outcome === "infra") {
      throw new Error(
        `agent-ci workflow '${wf}' produced no parseable run.finish event (exit ${exitCode}) ` +
          `-- treating as an infrastructure failure`,
      );
    }
    if (verdict.outcome === "failed") {
      green = false;
      const steps = verdict.failedSteps.length > 0 ? ` (failed: ${verdict.failedSteps.join(", ")})` : "";
      reasons.push(`agent-ci workflow '${wf}' FAILED${steps}`);
    }
  }

  return { green, reasons };
}

// Re-export the real defaults so root.ts wires them without importing exec directly.
export { spawnAgentCiStream, detectAgentCiCapability };
export type { AgentCiEvent } from "./agent-ci-events.js";
```

Note: the module-level `Promise.race` timeout of v1 is gone — the spawner (Task 2) owns child-kill + the deadline, and a killed child with no terminal event yields `outcome: "infra"` → throw. The infra semantics are preserved.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent-ci.test`
Expected: PASS. If an old v1 test asserted `parseWorkflowOutcome` (now removed), migrate its verbatim-NDJSON fixture into `agent-ci-events.test.ts` (Task 1) as a `parseAgentCiEvent` + `deriveWorkflowVerdict` assertion, then delete the obsolete test.

- [ ] **Step 5: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: clean; only Task-5..8 wiring may still be red if you jumped ahead — at this point the gate/agent-ci units are green.

- [ ] **Step 6: Commit**

```bash
git add src/gate/agent-ci.ts src/gate/agent-ci.test.ts
git commit -m "refactor(gate): stream agent-ci events, derive verdict from parsed events, typed unavailable error"
```

---

## Task 4: thread `taskId` into the gate's agent-ci call (`gate.ts`)

**Files:**
- Modify: `src/gate/gate.ts` (the `GateDeps.runAgentCi` type + the step-1c call)
- Test: `src/gate/gate.test.ts` (existing v1 tests; update the dep shape; add the unavailable-propagation test)

- [ ] **Step 1: Write the failing test**

```ts
// src/gate/gate.test.ts  (add; and update existing runAgentCi stubs to accept a taskId arg)
import { AgentCiUnavailableError } from "./agent-ci-exec.js";

it("propagates an AgentCiUnavailableError out of runGate (not swallowed)", async () => {
  const deps = makeGateDeps({
    runAgentCi: async (_taskId: string) => {
      throw new AgentCiUnavailableError("needs-wsl-on-windows", "needs WSL");
    },
  });
  await expect(runGate(makeGateInput({ taskId: "t1" }), deps)).rejects.toBeInstanceOf(AgentCiUnavailableError);
});

it("passes the task id into runAgentCi", async () => {
  const seen: string[] = [];
  const deps = makeGateDeps({
    runAgentCi: async (taskId: string) => { seen.push(taskId); return { green: true, reasons: [] }; },
  });
  await runGate(makeGateInput({ taskId: "task-42" }), deps);
  expect(seen).toEqual(["task-42"]);
});
```

(Reuse this file's existing `makeGateDeps`/`makeGateInput` helpers; if `runAgentCi` was previously typed `() => ...`, update every stub in the file to `(_taskId: string) => ...`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gate.test`
Expected: FAIL — `runAgentCi` is currently `() => Promise<...>`; the new tests pass/expect a `taskId` arg.

- [ ] **Step 3: Update `gate.ts`**

In `GateDeps` (around line 66):
```ts
  /** Optional agent-ci replay. null = feature off. May THROW: a genuine infra failure or an
   *  AgentCiUnavailableError (Windows-without-WSL) propagates OUT of runGate on purpose —
   *  do NOT wrap in try/catch here; the conductor escalates a gate throw. */
  runAgentCi: ((taskId: string) => Promise<{ green: boolean; reasons: string[] }>) | null;
```

In step 1c (around line 142):
```ts
  // 1c. optional agent-ci local CI replay (spec 2026-07-08 + observability 2026-07-10). null = off.
  let agentCiGreen = true;
  if (deps.runAgentCi !== null) {
    const ci = await deps.runAgentCi(input.taskId);
    agentCiGreen = ci.green;
    if (!ci.green) reasons.push(...ci.reasons);
  }
```

(`input.taskId` already exists on `GateInput` — it's used by the empty-file_set fast-path and the verdict.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- gate.test`
Expected: PASS.

- [ ] **Step 5: Typecheck** (this changes a shared type — `root.ts` will now be red until Task 6; that's expected)

Run: `npm run typecheck`
Expected: an error only in `src/composition/root.ts` (the `runAgentCi` closure arity). Leave it — Task 6 fixes it. If you want a green typecheck at each commit, do Task 6 immediately after and commit them together.

- [ ] **Step 6: Commit** (co-commit with Task 6 if you need a green tree)

```bash
git add src/gate/gate.ts src/gate/gate.test.ts
git commit -m "feat(gate): thread taskId into runAgentCi for per-task event persistence"
```

---

## Task 5: `ci-events.ts` — CI event bus + SSE handler + capability handler

**Files:**
- Create: `src/api/ci-events.ts`
- Test: `src/api/ci-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/api/ci-events.test.ts
import { describe, it, expect, vi } from "vitest";
import { CiEventBus, type CiStreamSink } from "./ci-events.js";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";

function fakeSink(): CiStreamSink & { chunks: string[]; ended: boolean } {
  const chunks: string[] = [];
  return { chunks, ended: false, write(c) { chunks.push(c); }, end() { (this as { ended: boolean }).ended = true; } };
}
const ev = (e: AgentCiEvent): AgentCiEvent => e;

describe("CiEventBus", () => {
  it("fans a published event out to every subscribed sink for that task", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    const b = fakeSink();
    bus.subscribe("t1", a);
    bus.subscribe("t1", b);
    bus.publish("t1", ev({ kind: "run-finish", status: "passed" }));
    expect(a.chunks).toHaveLength(1);
    expect(JSON.parse(a.chunks[0]!)).toEqual({ kind: "run-finish", status: "passed" });
    expect(b.chunks).toHaveLength(1);
  });

  it("does not deliver to a different task's subscribers", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.publish("t2", ev({ kind: "run-start" }));
    expect(a.chunks).toHaveLength(0);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.unsubscribe("t1", a);
    bus.publish("t1", ev({ kind: "run-start" }));
    expect(a.chunks).toHaveLength(0);
  });

  it("a throwing sink never crashes publish or blocks other sinks", () => {
    const bus = new CiEventBus();
    const bad: CiStreamSink = { write: () => { throw new Error("dead socket"); }, end: () => {} };
    const good = fakeSink();
    bus.subscribe("t1", bad);
    bus.subscribe("t1", good);
    expect(() => bus.publish("t1", ev({ kind: "run-start" }))).not.toThrow();
    expect(good.chunks).toHaveLength(1);
  });

  it("closeAll ends every sink", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.closeAll();
    expect(a.ended).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ci-events`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (the SSE + capability HTTP handlers live here too; unit-test the bus, integration-cover the handlers in Task 7's server tests)

```ts
// src/api/ci-events.ts
import type { ServerResponse } from "node:http";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";

/** Structural sink (mirrors ChatStreamSink) so the bus never touches ServerResponse directly. */
export interface CiStreamSink {
  write(chunk: string): void;
  end(): void;
}

/** Per-project in-memory fan-out of CI events, keyed by taskId. Sibling to ChatSessionManager
 *  but far simpler: no child lifecycle, just subscribe/publish/unsubscribe. */
export class CiEventBus {
  private readonly subs = new Map<string, Set<CiStreamSink>>();

  subscribe(taskId: string, sink: CiStreamSink): void {
    let set = this.subs.get(taskId);
    if (!set) { set = new Set(); this.subs.set(taskId, set); }
    set.add(sink);
  }

  unsubscribe(taskId: string, sink: CiStreamSink): void {
    const set = this.subs.get(taskId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.subs.delete(taskId);
  }

  publish(taskId: string, event: AgentCiEvent): void {
    const set = this.subs.get(taskId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const sink of set) {
      try { sink.write(payload); } catch { /* best-effort: a dead socket must not crash publish */ }
    }
  }

  closeAll(): void {
    for (const set of this.subs.values()) {
      for (const sink of set) { try { sink.end(); } catch { /* already closed */ } }
    }
    this.subs.clear();
  }
}

export interface CiCapabilityProvider {
  bus: CiEventBus;
  /** Reads the persisted ndjson for history replay; "" if none yet. */
  readEvents: (taskId: string) => Promise<string>;
}

/** SSE: replay the persisted ndjson (history) then forward live bus events. Mirrors
 *  handleChatStream but ADDS history replay (chat has none). */
export function handleCiStream(ci: CiCapabilityProvider | undefined, taskId: string, res: ServerResponse): void {
  if (!ci) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders(); // else Node buffers headers until the first write

  const sink: CiStreamSink = {
    write: (chunk) => { try { res.write(`data: ${chunk}\n\n`); } catch { /* client gone */ } },
    end: () => { try { res.end(); } catch { /* already closed */ } },
  };

  // History replay first (best-effort), then go live. A microscopic race (an event landing
  // between replay and subscribe) is covered by persistence — a reconnect replays it.
  void ci.readEvents(taskId)
    .then((ndjson) => {
      for (const line of ndjson.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length > 0) sink.write(t);
      }
    })
    .catch(() => { /* no history yet — stream live only */ })
    .finally(() => {
      ci.bus.subscribe(taskId, sink);
      res.on("close", () => ci.bus.unsubscribe(taskId, sink));
    });
}

export function handleCiCapability(
  onCiCapability: (() => Promise<AgentCiCapability>) | undefined,
  res: ServerResponse,
): void {
  if (!onCiCapability) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
  void onCiCapability()
    .then((cap) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cap)); })
    .catch(() => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "capability probe failed" })); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ci-events`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors from this file (root.ts arity error from Task 4 may still be pending).

- [ ] **Step 6: Commit**

```bash
git add src/api/ci-events.ts src/api/ci-events.test.ts
git commit -m "feat(api): CI event bus + SSE (history replay then live) + capability handler"
```

---

## Task 6: composition root — capability-aware exec + onEvent persist/publish + expose `ci`/`onCiCapability`

**Files:**
- Modify: `src/composition/root.ts` (the `runAgentCi` closure in `gateDeps`; add a lazy `CiEventBus`; add a `ci-status` summary builder; extend `ProjectRoot`)
- Test: covered by `agent-ci.test.ts` (units) + Task 7 server integration + the live-prove. `root.ts` is composition glue (gotcha `[conductor/wiring]` — untested by design); do NOT add a bespoke root.test.

- [ ] **Step 1: Add the CI status summary builder + its test** (this IS testable — keep it pure)

Create `src/gate/ci-status.ts`:
```ts
// src/gate/ci-status.ts
import type { AgentCiEvent } from "./agent-ci-events.js";

export interface CiStatusSummary {
  phase: "running" | "passed" | "failed";
  workflow: string | null;
  steps: { done: number; total: number };
  failedSteps: string[];
}

/** Fold one event into the running summary (used to rewrite agent-ci-status.json cheaply). */
export function foldCiStatus(prev: CiStatusSummary, workflow: string, ev: AgentCiEvent): CiStatusSummary {
  const next: CiStatusSummary = {
    phase: prev.phase,
    workflow: workflow,
    steps: { ...prev.steps },
    failedSteps: [...prev.failedSteps],
  };
  switch (ev.kind) {
    case "step-start":
      next.steps.total = Math.max(next.steps.total, ev.index + 1);
      break;
    case "step-finish":
      next.steps.total = Math.max(next.steps.total, ev.index + 1);
      next.steps.done = Math.max(next.steps.done, ev.index + 1);
      if (/^(failed|failure|error)$/i.test(ev.status)) next.failedSteps.push(ev.step);
      break;
    case "run-finish":
      next.phase = /^(passed|success|succeeded)$/i.test(ev.status) ? "passed" : "failed";
      break;
    default:
      break;
  }
  return next;
}

export function initialCiStatus(): CiStatusSummary {
  return { phase: "running", workflow: null, steps: { done: 0, total: 0 }, failedSteps: [] };
}
```

Create `src/gate/ci-status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { foldCiStatus, initialCiStatus } from "./ci-status.js";

describe("foldCiStatus", () => {
  it("tracks step counts and terminal phase", () => {
    let s = initialCiStatus();
    s = foldCiStatus(s, "ci.yml", { kind: "step-start", job: "b", step: "lint", index: 0 });
    s = foldCiStatus(s, "ci.yml", { kind: "step-finish", job: "b", step: "lint", index: 0, status: "passed" });
    s = foldCiStatus(s, "ci.yml", { kind: "step-finish", job: "b", step: "unit", index: 1, status: "failed" });
    s = foldCiStatus(s, "ci.yml", { kind: "run-finish", status: "failed" });
    expect(s.workflow).toBe("ci.yml");
    expect(s.steps).toEqual({ done: 2, total: 2 });
    expect(s.phase).toBe("failed");
    expect(s.failedSteps).toEqual(["unit"]);
  });
});
```

Run: `npm test -- ci-status` → PASS after writing.

- [ ] **Step 2: Wire the closure in `root.ts`** — replace the `runAgentCi` closure (lines ~209-225)

```ts
      runAgentCi: agentCi.enabled
        ? async (taskId: string) => {
            if (agentCi.workflows.length === 0) {
              log("WARN", "gate.agentCi.enabled but workflows allowlist is empty -- skipping agent-ci this round");
              return { green: true, reasons: [] };
            }
            let ndjson = "";
            let status = initialCiStatus();
            const onEvent = (workflow: string, event: AgentCiEvent): void => {
              // Persist (best-effort; a persist failure must NEVER fail a real CI verdict).
              ndjson += JSON.stringify(event) + "\n";
              status = foldCiStatus(status, workflow, event);
              void repo.writeRuntimeFile(taskId, "agent-ci-events.ndjson", ndjson).catch(() => {});
              void repo.writeRuntimeFile(taskId, "agent-ci-status.json", JSON.stringify(status, null, 2)).catch(() => {});
              // Publish to the live bus (best-effort).
              try { getCiBus().publish(taskId, event); } catch { /* ignore */ }
            };
            return runAgentCiWorkflows({
              cwd: wt.path,
              workflows: agentCi.workflows,
              timeoutMs: agentCi.timeoutMs,
              detectCapability: () => detectAgentCiCapability(),
              spawn: spawnAgentCiStream,
              onEvent,
            });
          }
        : null,
```

Add imports at the top of `root.ts`:
```ts
import { runAgentCiWorkflows, spawnAgentCiStream, detectAgentCiCapability } from "../gate/agent-ci.js";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";
import { detectAgentCiCapability as detectCap, type AgentCiCapability } from "../gate/agent-ci-exec.js";
import { CiEventBus } from "../api/ci-events.js";
import { foldCiStatus, initialCiStatus } from "../gate/ci-status.js";
```
(Deduplicate: `detectAgentCiCapability` is re-exported from `agent-ci.js` in Task 3, so import it from there and drop the second import; import `AgentCiCapability` from `agent-ci-exec.js`.)

- [ ] **Step 3: Add the lazy CI bus + expose it on `ProjectRoot`** (mirror the `getChatManager` pattern at lines ~364-382)

```ts
  let ciBus: CiEventBus | undefined;
  const getCiBus = (): CiEventBus => {
    if (!ciBus) ciBus = new CiEventBus();
    return ciBus;
  };
```

Extend the `ProjectRoot` interface (lines ~74-101) and the returned object:
```ts
  // in the ProjectRoot interface:
  ci: {
    bus: CiEventBus;
    readEvents: (taskId: string) => Promise<string>;
  };
  onCiCapability: () => Promise<AgentCiCapability>;

  // in the returned object:
  get ci() {
    return {
      bus: getCiBus(),
      readEvents: async (taskId: string): Promise<string> => (await repo.readRuntimeFile(taskId, "agent-ci-events.ndjson")) ?? "",
    };
  },
  onCiCapability: () => detectAgentCiCapability(),
```

(Confirm `repo.readRuntimeFile(id, name): Promise<string | null>` — it's on `BlackboardRepository` and used by the conductor/scheduler mocks.)

- [ ] **Step 4: Add bus teardown** — if `ProjectRoot` has a `close()`/dispose path, call `ciBus?.closeAll()` there (grep `getChatManager`'s `closeAll` call site and mirror it). If projects are torn down only via the server's `chatManagersByProject` close, the server (Task 7) owns bus close instead.

- [ ] **Step 5: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: clean; the Task-4 root.ts arity error is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/composition/root.ts src/gate/ci-status.ts src/gate/ci-status.test.ts src/gate/agent-ci.ts
git commit -m "feat(root): wire streaming agent-ci onEvent -> persist ndjson + status + CI bus; expose ci capability"
```

---

## Task 7: server routes — `ProjectView.ci`/`onCiCapability` + dispatch + shutdown

**Files:**
- Modify: `src/api/server.ts` (ProjectView type; route dispatch; per-project bus registration + close)
- Test: `src/api/server.test.ts` (a `ProjectView` with a `ci` stub → SSE 200 + a frame; unset → 404; capability 200/404)

- [ ] **Step 1: Write the failing test**

```ts
// src/api/server.test.ts  (new describe block; reuse the file's existing server-harness helpers)
describe("CI observability routes", () => {
  it("GET /projects/:id/ci/capability returns the capability JSON", async () => {
    const server = await startTestServer({
      ci: { bus: new CiEventBus(), readEvents: async () => "" },
      onCiCapability: async () => ({ mode: "native", detail: "native here" }),
    });
    const res = await fetch(`${server.base}/projects/p1/ci/capability`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "native", detail: "native here" });
    await server.close();
  });

  it("GET /projects/:id/ci/capability 404s when the capability is unset", async () => {
    const server = await startTestServer({}); // no onCiCapability
    const res = await fetch(`${server.base}/projects/p1/ci/capability`);
    expect(res.status).toBe(404);
    await server.close();
  });

  it("GET /projects/:id/ci/:taskId/stream replays persisted history as SSE frames", async () => {
    const bus = new CiEventBus();
    const server = await startTestServer({
      ci: { bus, readEvents: async () => '{"kind":"run-start"}\n{"kind":"run-finish","status":"passed"}\n' },
      onCiCapability: async () => ({ mode: "native", detail: "x" }),
    });
    const res = await fetch(`${server.base}/projects/p1/ci/t1/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: {"kind":"run-start"}');
    await reader.cancel();
    await server.close();
  });
});
```

(Adapt `startTestServer`/`ProjectView` construction to this file's existing harness — the recon shows `ProjectView` is built inline in the test setup; add the two optional fields to the stub.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server.test`
Expected: FAIL — routes not wired; `ProjectView` has no `ci`/`onCiCapability`.

- [ ] **Step 3: Extend the `ProjectView` type** (server.ts ~lines 186-229)

```ts
  /** OPTIONAL CI observability: the per-project event bus + a history reader for
   *  `GET /projects/:id/ci/:taskId/stream`. Unset → 404. */
  ci?: { bus: CiEventBus; readEvents: (taskId: string) => Promise<string> };
  /** OPTIONAL agent-ci capability probe for `GET /projects/:id/ci/capability`. Unset → 404. */
  onCiCapability?: () => Promise<AgentCiCapability>;
```

Add imports:
```ts
import { CiEventBus, handleCiStream, handleCiCapability } from "./ci-events.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";
```

- [ ] **Step 4: Add the route dispatch** (in `handleRequest`, in the per-project route block ~lines 2145-2153, next to the chat routes)

```ts
      if (req.method === "GET" && (sub === "/ci/capability" || sub === "/ci/capability/"))
        return void handleCiCapability(p.onCiCapability, res);
      const ciStreamMatch = /^\/ci\/([^/]+)\/stream\/?$/.exec(sub);
      if (req.method === "GET" && ciStreamMatch)
        return void handleCiStream(p.ci, decodeURIComponent(ciStreamMatch[1]!), res);
```

Order note: place the `/ci/capability` check BEFORE the `/ci/:taskId/stream` regex so the literal `capability` segment can't be captured as a taskId (it can't match `/ci/([^/]+)/stream` anyway, but keep the literal first for clarity).

- [ ] **Step 5: Register the bus for shutdown** — mirror `chatManagersByProject`. Near line 786:
```ts
  const ciBusesByProject = new Map<string, CiEventBus>();
```
After resolving the view (near line 2110-2111, next to the chat-manager registration):
```ts
      if (p.ci) ciBusesByProject.set(rawPid, p.ci.bus);
```
In `close()` (near line 2251-2254, alongside the chat `closeAll`):
```ts
    for (const b of ciBusesByProject.values()) { try { b.closeAll(); } catch { /* ignore */ } }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run typecheck && npm test -- server.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): wire GET /ci/:taskId/stream + /ci/capability behind optional ProjectView caps"
```

---

## Task 8: conductor — surface the honest unavailable reason on escalation + wire `index.ts`

**Files:**
- Modify: `src/conductor/conductor.ts` (the gate-throw catch, ~lines 472-492)
- Modify: `src/index.ts` (add `ci` + `onCiCapability` to the `ProjectView` in `projects.get`, ~lines 175-200)
- Test: `src/conductor/conductor.test.ts` (a `runGate` that throws `AgentCiUnavailableError` → escalation reason = its detail)

- [ ] **Step 1: Write the failing test**

```ts
// src/conductor/conductor.test.ts  (add; reuse the file's fake repo + escalation capture)
import { AgentCiUnavailableError } from "../gate/agent-ci-exec.js";

it("escalates with the AgentCiUnavailableError's detail (not the generic gate-threw string)", async () => {
  const { runIteration, state } = makeConductor({
    runGate: async () => { throw new AgentCiUnavailableError("needs-wsl-on-windows", "agent-ci gate requires WSL on Windows -- install WSL or run on Linux/Mac"); },
  });
  await seedActiveTask(state, "t1");
  await runIteration();
  const esc = readEscalation(state, "t1");
  expect(esc.reason).toMatch(/requires WSL on Windows/);
  expect(esc.reason).not.toMatch(/broken operator config/);
});

it("still uses the generic reason for a non-agent-ci gate throw", async () => {
  const { runIteration, state } = makeConductor({
    runGate: async () => { throw new Error("INVARIANTS.md missing"); },
  });
  await seedActiveTask(state, "t2");
  await runIteration();
  expect(readEscalation(state, "t2").reason).toMatch(/broken operator config/);
});
```

(Use the file's existing conductor test scaffolding — the recon confirms a fake repo with `runtimeFiles`/escalation moves; adapt `makeConductor`/`seedActiveTask`/`readEscalation` to the real helper names in that file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- conductor.test`
Expected: FAIL — the argument-less catch discards the error; reason is always the generic string.

- [ ] **Step 3: Update the catch branch** (conductor.ts ~line 476)

Add the import near the other gate imports (top of file):
```ts
import { AgentCiUnavailableError } from "../gate/agent-ci-exec.js";
```

Change `} catch {` to capture and branch:
```ts
      } catch (err) {
        await repo.moveTask(task.id, "active", "escalated");
        const escType: EscalationType = task.contract_zones_touched.length > 0 ? "constitution" : "needs-guard";
        const isUnavailable = err instanceof AgentCiUnavailableError;
        const reason = isUnavailable
          ? (err as AgentCiUnavailableError).detail
          : "gate threw -- broken operator config";
        const decision = isUnavailable
          ? "Install WSL (Windows) or run the daemon on Linux/Mac, then re-queue -- or disable gate.agentCi."
          : "Fix the broken gate config (INVARIANTS.md / GUARDS.md / check command) before retrying.";
        await escalate(
          buildEscalation(task, {
            reason,
            type: escType,
            what: `Task ${task.id} gate invocation threw.`,
            decision,
            optionA: isUnavailable ? "Enable WSL / switch platform and re-queue." : "Fix the config and re-queue.",
            optionB: "Abandon the task.",
            costOfWrong: "A broken gate config cannot safely judge ANY task, not just this one.",
            evidence: `taskId=${task.id}${isUnavailable ? ` reason=${(err as AgentCiUnavailableError).reason}` : ""}`,
          }),
        );
        return { claimedTaskId: task.id, committed: false, rateLimited: false };
      }
```

- [ ] **Step 4: Wire `index.ts`** — add to the `ProjectView` object in `projects.get` (near the `chat:` field, ~line 195):
```ts
        ci: root.ci,
        onCiCapability: root.onCiCapability,
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (full suite; the whole backend feature is now wired).

- [ ] **Step 6: Commit**

```bash
git add src/conductor/conductor.ts src/index.ts
git commit -m "feat(conductor): honest 'needs WSL' escalation reason for AgentCiUnavailableError; wire ci into ProjectView"
```

---

## Task 9: UI client — types, api methods, query + SSE hooks

**Files:**
- Modify: `ui/src/lib/api.ts` (types + `getCiStatus`/`getCiCapability`/`ciEventsUrl`)
- Modify: `ui/src/lib/queries.ts` (`qk` keys + `useCiStatus`/`useCiCapability`/`useCiEvents`)

> UI has no test infra (established repo convention: UI is review-only). Verification for Tasks 9-12 is typecheck + build + the live browser-prove (Task 13). No vitest steps here.

- [ ] **Step 1: Add types + api methods to `ui/src/lib/api.ts`**

Near the other doc types (~lines 222-277):
```ts
export interface CiStatus {
  phase: "running" | "passed" | "failed";
  workflow: string | null;
  steps: { done: number; total: number };
  failedSteps: string[];
}

export type CiCapabilityMode = "native" | "wsl" | "unavailable";
export interface CiCapability {
  mode: CiCapabilityMode;
  reason?: "needs-wsl-on-windows" | "needs-node-in-wsl";
  detail: string;
}

/** One CI event frame as delivered over SSE (mirrors the backend AgentCiEvent union). */
export type CiEventFrame =
  | { kind: "run-start"; runId?: string }
  | { kind: "job-start"; job: string; runner?: string; workflow?: string }
  | { kind: "step-start"; job: string; step: string; index: number }
  | { kind: "step-finish"; job: string; step: string; index: number; status: string; durationMs?: number }
  | { kind: "job-finish"; job: string; status: string; durationMs?: number }
  | { kind: "run-finish"; status: string }
  | { kind: "other" };
```

In the `api` object (near `getConfig`/`getRunUsage`, ~lines 384-407 and `chatStreamUrl` ~558-562):
```ts
  getCiStatus: (projectId: string, taskId: string) =>
    req<CiStatus>(projectPath(projectId, `/tasks/${encodeURIComponent(taskId)}/runtime/agent-ci-status.json`)),
  getCiCapability: (projectId: string) =>
    req<CiCapability>(projectPath(projectId, "/ci/capability")),
  ciEventsUrl: (projectId: string, taskId: string): string =>
    projectPath(projectId, `/ci/${encodeURIComponent(taskId)}/stream`),
```

Note: `agent-ci-status.json` is served by the existing runtime-file route (`GET /tasks/:id/runtime/:name`) which returns the raw text; `req<CiStatus>` will `JSON.parse` it via the `accept: application/json` path. If that route sets `content-type: text/plain`, use the `getRuntimeFile` + `JSON.parse` idiom instead (see `useTaskVerdict`) — verify against `handleReadRuntimeFile` and pick the matching path.

- [ ] **Step 2: Add query keys + hooks to `ui/src/lib/queries.ts`**

In `qk` (~lines 8-21):
```ts
  ciStatus: (p: string, taskId: string) => ["ci-status", p, taskId] as const,
  ciCapability: (p: string) => ["ci-capability", p] as const,
```

Hooks (model `useCiStatus` on `useTaskVerdict`'s 404-tolerant shape; `useCiCapability` on `useConfig`'s `enabled` guard):
```ts
export const useCiStatus = (p: string, taskId: string) =>
  useQuery({
    queryKey: qk.ciStatus(p, taskId),
    enabled: p !== "" && taskId !== "",
    queryFn: async (): Promise<CiStatus | null> => {
      try {
        return await api.getCiStatus(p, taskId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null; // no CI run yet
        throw err;
      }
    },
  });

export const useCiCapability = (p: string) =>
  useQuery({ queryKey: qk.ciCapability(p), queryFn: () => api.getCiCapability(p), enabled: p !== "" });

/** Live CI events over SSE. Mirrors ChatModal's EventSource effect; owns local state
 *  (NOT the query cache). Returns the accumulated event list for the active task. */
export const useCiEvents = (projectId: string, taskId: string): CiEventFrame[] => {
  const [events, setEvents] = ReactUseState<CiEventFrame[]>([]);
  ReactUseEffect(() => {
    setEvents([]);
    if (projectId === "" || taskId === "") return;
    const es = new EventSource(api.ciEventsUrl(projectId, taskId));
    es.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data) as CiEventFrame;
        if (frame && typeof frame.kind === "string") setEvents((prev) => [...prev, frame]);
      } catch {
        /* malformed frame — ignore */
      }
    };
    return () => es.close();
  }, [projectId, taskId]);
  return events;
};
```

Add imports at the top of `queries.ts`: `useState as ReactUseState, useEffect as ReactUseEffect` from `react` (or use bare `useState`/`useEffect` if the file doesn't already shadow them), and `type CiStatus, type CiCapability, type CiEventFrame, ApiError` from `./api`.

- [ ] **Step 3: Typecheck + build the UI**

Run: `cd ui && npm run typecheck && npm run build && cd ..`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/api.ts ui/src/lib/queries.ts
git commit -m "feat(ui): CI status/capability api + query hooks + useCiEvents SSE hook"
```

---

## Task 10: SessionRail `CI` block + "Now" sub-note

**Files:**
- Modify: `ui/src/components/SessionRail.tsx`

- [ ] **Step 1: Read config + status at the top of `SessionRail`** (near the other hooks, ~lines 36-57)

```tsx
  const ciEnabled = config.data?.gate?.agentCi?.enabled === true;
  const activeTaskId = activeTask?.id ?? "";
  const ciStatus = useCiStatus(projectId, ciEnabled ? activeTaskId : "");
```

(Confirm `ProjectConfigView` exposes `gate.agentCi.enabled` on the client `config` type; if the projected `config` omits it, add `agentCi: { enabled: boolean }` to the `gate` slice of `ProjectConfigView` in `src/api/config-view.ts` + its UI type — a tiny read-only projection add. Check first; the s37 gate work may already project it.)

- [ ] **Step 2: Add the `CI` block** among the blocks (after the "Now" block, ~line 112; only when enabled)

```tsx
{ciEnabled && (
  <Block
    title="CI"
    badge={
      ciStatus.data ? (
        <Badge
          variant="secondary"
          className="ml-auto h-auto rounded-full px-1.5 py-0 font-mono text-[10px] normal-case tracking-normal text-muted-foreground"
        >
          {ciStatus.data.steps.done}/{ciStatus.data.steps.total || "?"}
        </Badge>
      ) : undefined
    }
  >
    {ciStatus.data ? (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Dot
            tone={ciStatus.data.phase === "passed" ? "clean" : ciStatus.data.phase === "failed" ? "broken" : "working"}
            pulse={ciStatus.data.phase === "running"}
          />
          <span className="font-mono text-[11px] text-foreground">
            {ciStatus.data.phase === "running" ? "running" : ciStatus.data.phase === "passed" ? "passed" : "failed"}
            {ciStatus.data.phase === "failed" && ciStatus.data.failedSteps[0] ? ` (step "${ciStatus.data.failedSteps[0]}")` : ""}
          </span>
        </div>
        <Kv k="workflow" v={ciStatus.data.workflow ?? dash} />
        <Link
          to="/p/$projectId/ci/$taskId"
          params={{ projectId, taskId: activeTaskId }}
          className="font-mono text-[11px] text-accent hover:underline"
        >
          open CI run →
        </Link>
      </div>
    ) : (
      <Step state="idle" label="no CI run yet" />
    )}
  </Block>
)}
```

Add imports: `Link` from `@tanstack/react-router`; `useCiStatus` from `@/lib/queries`. (`Dot`, `Badge`, `Kv`, `Step` already in the file.)

- [ ] **Step 3: Add the "Now" sub-note** (in the Now block, ~lines 99-112) — when a CI replay is live, annotate the gate step:

```tsx
        <Step
          state="idle"
          label={`${activeTask.id} gate${ciEnabled && ciStatus.data && ciStatus.data.phase === "running" ? ` (CI ${ciStatus.data.steps.done}/${ciStatus.data.steps.total || "?"})` : ""} → critic → commit`}
        />
```

- [ ] **Step 4: Typecheck + build**

Run: `cd ui && npm run typecheck && npm run build && cd ..`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/SessionRail.tsx
git commit -m "feat(ui): CI block in SessionRail (enabled-gated) + Now-block CI sub-note"
```

---

## Task 11: `CiRunView` screen + route

**Files:**
- Create: `ui/src/views/CiRunView.tsx`
- Modify: `ui/src/router.tsx`

- [ ] **Step 1: Add the route** in `ui/src/router.tsx`

```tsx
import { CiRunView } from "./views/CiRunView";

const ciRunRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/ci/$taskId",
  component: CiRunView,
});
```
Append `ciRunRoute` to `projectRoute.addChildren([...])` (the array at ~lines 78-84).

- [ ] **Step 2: Create the screen** — builds the live workflow→job→step tree from `useCiEvents`, falling back to the persisted history the SSE replays on connect. Compose `Card`/`Collapsible`/`Badge`/`Dot`/`Spinner`.

```tsx
// ui/src/views/CiRunView.tsx
import { getRouteApi } from "@tanstack/react-router";
import { useMemo } from "react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Dot } from "@/components/ui/Dot";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/Feedback";
import { useCiEvents, useCiStatus, useCiCapability } from "@/lib/queries";
import type { CiEventFrame } from "@/lib/api";

const route = getRouteApi("/p/$projectId/ci/$taskId");

interface StepRow { step: string; index: number; status: "running" | "passed" | "failed"; durationMs?: number }
interface JobGroup { job: string; steps: StepRow[]; status: "running" | "passed" | "failed" }

function reduceTree(events: CiEventFrame[]): { jobs: JobGroup[]; runStatus: "running" | "passed" | "failed" } {
  const jobs = new Map<string, JobGroup>();
  let runStatus: "running" | "passed" | "failed" = "running";
  const ensureJob = (job: string): JobGroup => {
    let g = jobs.get(job);
    if (!g) { g = { job, steps: [], status: "running" }; jobs.set(job, g); }
    return g;
  };
  const norm = (s: string): "passed" | "failed" =>
    /^(passed|success|succeeded)$/i.test(s) ? "passed" : "failed";
  for (const e of events) {
    if (e.kind === "job-start") ensureJob(e.job);
    else if (e.kind === "step-start") {
      const g = ensureJob(e.job);
      if (!g.steps.some((s) => s.index === e.index)) g.steps.push({ step: e.step, index: e.index, status: "running" });
    } else if (e.kind === "step-finish") {
      const g = ensureJob(e.job);
      const row = g.steps.find((s) => s.index === e.index);
      const status = norm(e.status);
      if (row) { row.status = status; row.durationMs = e.durationMs; }
      else g.steps.push({ step: e.step, index: e.index, status, durationMs: e.durationMs });
    } else if (e.kind === "job-finish") ensureJob(e.job).status = norm(e.status);
    else if (e.kind === "run-finish") runStatus = norm(e.status);
  }
  for (const g of jobs.values()) g.steps.sort((a, b) => a.index - b.index);
  return { jobs: [...jobs.values()], runStatus };
}

function StatusGlyph({ status }: { status: "running" | "passed" | "failed" }) {
  if (status === "running") return <Spinner className="size-3.5 text-[var(--color-working)]" />;
  return <Dot tone={status === "passed" ? "clean" : "broken"} />;
}

export function CiRunView() {
  const { projectId, taskId } = route.useParams();
  const events = useCiEvents(projectId, taskId);
  const status = useCiStatus(projectId, taskId);
  const capability = useCiCapability(projectId);
  const { jobs, runStatus } = useMemo(() => reduceTree(events), [events]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="font-sans text-xl font-semibold text-foreground">CI run</h1>
        <Badge variant="secondary" className="font-mono text-[11px]">{taskId}</Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusGlyph status={runStatus} />
          <span className="font-mono text-[12px] text-muted-foreground">{runStatus}</span>
        </div>
      </div>

      {capability.data && capability.data.mode === "unavailable" && (
        <div className="mb-4 rounded-md border border-[color-mix(in_srgb,var(--color-uncertain)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-uncertain)_8%,transparent)] px-3 py-2">
          <p className="font-mono text-[11px] text-uncertain">{capability.data.detail}</p>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState title="No CI events yet" description="Waiting for the agent-ci replay to start…" />
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.map((g) => (
            <Card key={g.job}>
              <Collapsible defaultOpen>
                <CollapsibleTrigger className="w-full">
                  <CardHeader className="flex items-center gap-2">
                    <StatusGlyph status={g.status} />
                    <span className="font-mono text-[13px] text-foreground">{g.job}</span>
                    <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
                      {g.steps.filter((s) => s.status !== "running").length}/{g.steps.length}
                    </Badge>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardBody className="flex flex-col gap-1">
                    {g.steps.map((s) => (
                      <div key={s.index} className="flex items-center gap-2 py-0.5">
                        <StatusGlyph status={s.status} />
                        <span className="font-mono text-[12px] text-foreground">{s.step}</span>
                        {s.durationMs !== undefined && (
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {(s.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    ))}
                  </CardBody>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          {runStatus === "passed"
            ? "agent_ci_green ✓ → gate COMMIT unaffected"
            : runStatus === "failed"
              ? `agent_ci_green ✗ → gate RETRY${status.data?.failedSteps[0] ? ` (failed: ${status.data.failedSteps.join(", ")})` : ""}`
              : "CI replay in progress…"}
        </p>
      </div>
    </div>
  );
}
```

(Verify the exact export names/props of `Card`/`CardHeader`/`CardBody`, `Collapsible*`, `EmptyState`, `Spinner`, `Dot`, `Badge` against the vendored files — the recon lists them; adjust class props to the real signatures. Tone CSS vars are `--color-working`/`--color-clean`/`--color-broken` per `ui/src/lib/status.ts`.)

- [ ] **Step 3: Typecheck + build**

Run: `cd ui && npm run typecheck && npm run build && cd ..`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/CiRunView.tsx ui/src/router.tsx
git commit -m "feat(ui): live CI run step-tree screen + /p/:id/ci/:taskId route"
```

---

## Task 12: RunView link + Project Settings capability line

**Files:**
- Modify: `ui/src/views/RunView.tsx` (a `Link` to the CI screen in the run-header actions bar)
- Modify: `ui/src/views/ProjectSettingsView.tsx` (a read-only CI capability line in/near the Gate section)

- [ ] **Step 1: RunView link** — in `RunHeading`'s actions bar (~lines 138-157), add a link to the CI screen for the run's newest/active task. Since the route is per-task, use the run's first task id (or the active task) from the run's `taskIds`:

```tsx
import { Link } from "@tanstack/react-router";
// inside the actions bar <div>, add (guard on a resolvable taskId):
{firstTaskId && (
  <Link
    to="/p/$projectId/ci/$taskId"
    params={{ projectId, taskId: firstTaskId }}
    title="Open CI run"
    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
  >
    <Activity className="size-3.5" />
  </Link>
)}
```
Derive `firstTaskId` from the run manifest's `taskIds[0]` already in scope in RunView (it renders per-task `TaskCard`s). Import `Activity` from `lucide-react`. Only render when the project's `gate.agentCi.enabled` (optional — reuse `useConfig`; if not worth a fetch here, always show the link and let the CI screen show its own "no CI run yet" empty state).

- [ ] **Step 2: Project Settings capability line** — add a read-only status near the Gate section (~lines 343-354) or as a sibling panel after `AgentExtensionsPanel` (~line 283)

```tsx
import { useCiCapability } from "@/lib/queries";
import { StatusPill } from "@/components/ui/StatusPill";

function CiCapabilityRow({ projectId }: { projectId: string }) {
  const cap = useCiCapability(projectId);
  if (!cap.data) return null;
  const tone = cap.data.mode === "unavailable" ? "broken" : cap.data.mode === "wsl" ? "uncertain" : "clean";
  const label = cap.data.mode === "native" ? "native" : cap.data.mode === "wsl" ? "via WSL" : "needs WSL on Windows";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">agent-ci</span>
        <StatusPill tone={tone} label={label} />
      </div>
      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{cap.data.detail}</p>
    </div>
  );
}
```
Render `<CiCapabilityRow projectId={projectId} />` inside the Gate `SettingsSection` (below the Check-command row). No toggle this round.

- [ ] **Step 3: Typecheck + build**

Run: `cd ui && npm run typecheck && npm run build && cd ..`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/RunView.tsx ui/src/views/ProjectSettingsView.tsx
git commit -m "feat(ui): RunView CI link + Project Settings agent-ci capability line"
```

---

## Task 13: full build, codex gate, live-prove through the daemon + browser

**Files:** none (verification + review + evidence).

- [ ] **Step 1: Full green bar**

Run: `npm run typecheck && npm test && npm run build && cd ui && npm run typecheck && npm run build && cd ..`
Expected: all green. Record the test count.

- [ ] **Step 2: Mandatory codex GPT-5.5 gate** on the backend diff (`gate.ts` + `agent-ci*.ts` + `ci-events.ts` + `conductor.ts` + `root.ts`). Submit via the codex-companion runtime; **feed the FULL current file content inline**, not a git diff (gotcha `[critic/codex]` — the sandbox can't run git on Windows; and an inline diff lost quotes → false-positive "invalid TS" Sev-1s in s37). Poll `status`/`result <jobid>` from MAIN. Fix every finding with a regression test; **re-critic every in-place fix** — never self-certify. Repeat until CLEAN.

- [ ] **Step 3: Live-prove THROUGH the daemon + browser** (the operator's core ask; NOT a standalone script). On the operator's native-Windows box:
  1. Rebuild BOTH bundles (gotcha `[build/stale-dist-backend]`): `npm run build && npm run build:ui`.
  2. Copy `dist/ui` into the target project + `.git/info/exclude` it (gotcha `[ui/serve-uidir-reporoot]`); run `serve` DETACHED (`Start-Process`, gotcha `[orchestrator/bg-spawn-killed]`).
  3. On a project with `gate.agentCi.enabled:true` + a real workflow allowlist, in WSL: `npm i -D @redwoodjs/agent-ci@0.16.2` (fast; do NOT cold-`npx`). The `ghcr.io/actions/actions-runner:latest` image is still cached in WSL from s37.
  4. In the browser: drive a real task; **watch the CI block go running → passed**, the CI screen stream the workflow→job→step tree live, and Project Settings show "agent-ci: via WSL". Prove the **WSL-proxy happy path end-to-end** (daemon on Windows → agent-ci in WSL). Screenshot each.
  5. Prove the **red path**: a workflow that fails → CI block shows `✗ failed (step "…")`, the gate folds to RETRY, the reason names the failing step.
  6. Prove the **honest-unavailable path**: with the WSL bridge unavailable (or a non-WSL simulation), Settings shows "needs WSL on Windows" AND an escalation reason carries the specific detail, never the generic "broken operator config".
  7. Environment facts to reuse (s37): Docker 29.4 on Windows + WSL Ubuntu node v22 + docker 29.4 inside; a run needs `GITHUB_REPO=owner/repo` or a git remote.

- [ ] **Step 4: Docs + gotchas** — update `docs/CURRENT-STATE.md` (top block), prepend a `docs/SESSION-LOG.md` entry, and add any new `docs/gotchas/{slug}.md` (likely: WSL-proxy path-mapping surprises, SSE history-replay race, or a `wsl.exe -l -q` UTF-16/NUL parsing gotcha) + bump the `GOTCHAS.md` count.

- [ ] **Step 5: One PR** — batch the whole feature into a single PR (per AGENTS.md batch-merges), merge after codex-CLEAN + green CI + the browser live-proof.

---

## Self-Review (run against the spec)

**Spec coverage:**
- §3a cross-platform invocation → Task 2 (`detectAgentCiCapability`, `winToWslPath`, `buildAgentCiCommand`). ✓
- §3b `unavailable` → typed error + specific escalation reason → Task 2 (`AgentCiUnavailableError`) + Task 8 (conductor reason). ✓
- §3c streaming refactor + `onEvent` + failing-step reasons → Task 3. ✓
- §3d hybrid transport (persist ndjson + status.json + SSE bus, history replay, flushHeaders) → Task 5 (bus + SSE) + Task 6 (persist closure). ✓
- §3e UI (CI block, CI screen, Settings capability line) → Tasks 10, 11, 12. ✓
- §3f "Now" sub-note → Task 10 Step 3. ✓
- §4 component list → every file mapped in File Structure + tasks. ✓
- §5 error handling (WSL absent, unmappable path, persist/SSE best-effort, disconnect, timeout/infra unchanged) → Tasks 2/5/6. ✓
- §6 testing (exec/events/agent-ci/ci-events/gate unit tests + codex + live-prove) → Tasks 1-8 + 13. ✓
- Open questions → all four settled in "Locked decisions". ✓

**Placeholder scan:** no TBD/"add error handling"/"similar to Task N" — every code step carries real code. ✓

**Type consistency:** `AgentCiEvent` union identical in `agent-ci-events.ts` (Task 1), re-exported through `agent-ci.ts` (Task 3), mirrored as `CiEventFrame` in `api.ts` (Task 9), consumed in `CiRunView` (Task 11). `AgentCiCapability`/`AgentCiUnavailableError` defined in `agent-ci-exec.ts` (Task 2), thrown in `agent-ci.ts` (Task 3), caught in `conductor.ts` (Task 8), surfaced as `CiCapability` in the UI (Task 9/12). `runAgentCi(taskId)` arity: changed in `gate.ts` (Task 4), satisfied in `root.ts` (Task 6). `CiStatusSummary`/`CiStatus` fields (`phase`/`workflow`/`steps`/`failedSteps`) identical backend (Task 6) ↔ client (Task 9). ✓

## Related

- `docs/superpowers/specs/2026-07-10-agent-ci-observability-design.md` — the spec this implements.
- `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` + `plans/2026-07-10-agent-ci-gate-hardening.md` — v1.
- Gotchas: `[gate/agent-ci-not-runnable-on-native-windows]`, `[gate/agent-ci-ndjson-keyed-by-event-not-type]`, `[chat/onToken-bound-once]` (SSE flush), `[build/stale-dist-backend]`, `[ui/serve-uidir-reporoot]`, `[orchestrator/bg-spawn-killed]`.
- Mirror sources: `src/orchestrator/claude-chat-process.ts` + `chat-session-manager.ts` (streaming + SSE), `src/detect/agent-extensions.ts` (streaming spawner), `ui/src/views/ChatModal.tsx` (EventSource hook).
