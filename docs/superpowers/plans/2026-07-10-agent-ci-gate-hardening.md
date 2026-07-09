# Agent-CI Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. This touches `src/gate/gate.ts` —
> **the project's single most sensitive module** — so the discipline is non-negotiable:
> TDD (failing test first) + `npm run typecheck` + `npm test` + **mandatory independent
> codex GPT-5.5 critic gate on the `gate.ts` diff specifically** + a real live-prove
> before merge. No self-certification.

**Goal:** Add an OPTIONAL, project-config-gated, ADDITIONAL machine-gate step that replays
a project's real GitHub Actions CI locally (`redwoodjs/agent-ci`, npm `@redwoodjs/agent-ci@0.16.2`)
in the per-task worktree BEFORE commit — closing the gap where the harness gate can bless and
commit a change the project's own CI would then reject. Off by default, inert unless
`gate.agentCi.enabled: true` + an explicit workflow allowlist. A genuine workflow failure →
RETRY (worker-fixable, like `success_commands`). An agent-ci/Docker infrastructure failure
(no Docker, unresolvable binary, timeout) → the step THROWS → the EXISTING conductor
try/catch escalates it as "gate threw — broken operator config". Never replaces the
independent critic. Never mandatory. No UI for v1.

**Spec:** `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` (read it end
to end first). **Recon:** `docs/wiki/agent-ci-analysis.md`.

**Architecture:** A new pure-ish module `src/gate/agent-ci.ts` exposes
`runAgentCiWorkflows(input)` → `Promise<{ green: boolean; reasons: string[] }>`. It spawns
`npx @redwoodjs/agent-ci run --workflow <path> --json` per allowlisted workflow SEQUENTIALLY
(parallel Docker runs against ONE worktree risk the shared-`node_modules`-mount collision
agent-ci's own docs warn about), parses the buffered NDJSON stdout for each workflow's
terminal `run.finish` event, and returns `green:false` with a per-workflow reason on a
genuine job failure. It THROWS (never returns `{green:false}`) for an infra failure — that
distinction IS the contract §3c/callers rely on. `src/gate/gate.ts` gains one new optional
dep `runAgentCi` and one new step "1c" right after `success_commands`, folding its `green`
into the existing RETRY decision and appending its reasons; a throw propagates out of
`runGate` exactly like a throwing `loadInvariants` does today (verified: `conductor.ts:474-492`
wraps `runGate` in try/catch → escalate). `src/composition/root.ts`'s `gateDeps(wt)` builds
`runAgentCi` the same way it builds `runCheck`: `null` when disabled, else a closure.

**Ground-truth notes used throughout (verified this session, 2026-07-10):**
- Docker **29.4.0** is installed on this box → all three live-prove branches (pass / job-fail
  / infra-fail) are exercisable locally.
- `@redwoodjs/agent-ci` is **published on npm at 0.16.2** (recon's "not yet npm-packaged"
  referred to the Rust runner track; the CLI package exists). A **cold `npx` download of it
  exceeded 3 minutes** on this box — so (a) `timeoutMs` default 600000 (10 min) must comfortably
  cover a cold first run, and (b) the live-prove and any opting-in project should **pre-install
  / pre-cache** agent-ci (`npm i -D @redwoodjs/agent-ci` in the target project, or a global
  install) so a gate run isn't a multi-minute cold download that looks like a hang. Documented
  as an operator prerequisite (§ Task 6), not something the harness auto-installs.
- **Config write-path is safe as-is:** `mergeConfigYaml` (scaffold.ts:175-176) is field-selective
  and spreads `...raw.gate`, and `ScaffoldFormSchema` has no `agentCi` field, so a hand-set
  `gate.agentCi` block SURVIVES a UI `checkCommand` edit. No `ScaffoldFormSchema` /
  `buildConfigYaml` / `mergeConfigYaml` changes are needed — v1 is genuinely config-file-only.
  Task 5 adds a cheap regression test proving that preservation (insurance against the
  `[config/zod-strict]` silent-revert class), not a code change.
- **The exact NDJSON `run.finish` field names are confirmed against a fake stream in unit
  tests (spec §6's approach) and validated against reality only in the live-prove (Task 6).**
  The parser is written DEFENSIVELY (tolerant of unknown/extra fields, and of the terminal
  event being reported as either a `run.finish` with a `status`/`conclusion` string or a
  top-level `passed` boolean) so a minor real-world shape difference is absorbed, not a crash —
  and the live-prove is where the real shape is nailed. Do NOT hardcode a single guessed field
  name and skip the live-prove: that is the "invented shapes" trap the chat plan (Task 2) and
  gotcha discipline explicitly warn against.

**Tech stack:** Node + TypeScript, vitest, `runNative` (`util/native.ts`, cross-spawn-backed,
Windows `.cmd`-shim safe), zod (config schema). No UI, no new HTTP route.

---

## Task 1: Config schema — add the `gate.agentCi` block

Extend the existing `gate` object in `src/config/schema.ts` with a nested, fully-defaulted
`agentCi` object so an opted-out project (the default) is byte-identical to today, and an
old on-disk config missing the block loads with `enabled:false`. `.strict()` on the root
still holds (agentCi is now a KNOWN key under `gate`, which is itself not `.strict()`, so a
stray key under `gate` is stripped, same as today — acceptable; the ROOT strictness is what
guards against the [config/zod-strict] revert class).

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/config.test.ts` (extend — defaults + a populated block round-trip)

- [ ] **Step 1: Write the failing test (defaults present when omitted; values parsed when set)**

Add to `src/config/config.test.ts`:

```ts
it("defaults gate.agentCi to disabled with an empty allowlist when omitted", () => {
  const dir = makeTempRepo(); // existing helper idiom in this file
  writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
  const { cfg } = /* the file's existing load call */ loadConfigSync(dir);
  expect(cfg.gate.agentCi.enabled).toBe(false);
  expect(cfg.gate.agentCi.workflows).toEqual([]);
  expect(cfg.gate.agentCi.timeoutMs).toBe(600000);
});

it("parses an explicit gate.agentCi block", () => {
  const dir = makeTempRepo();
  writeFileSync(
    join(dir, ".autodev", "config.yaml"),
    [
      "gate:",
      "  agentCi:",
      "    enabled: true",
      "    workflows:",
      "      - .github/workflows/ci.yml",
      "    timeoutMs: 120000",
      "",
    ].join("\n"),
  );
  const { cfg } = loadConfigSync(dir);
  expect(cfg.gate.agentCi).toEqual({
    enabled: true,
    workflows: [".github/workflows/ci.yml"],
    timeoutMs: 120000,
  });
});
```

> Match the file's ACTUAL load helper + temp-repo idiom (it uses `loadConfigWithRaw`/a sync
> variant — read `config.test.ts` first and mirror exactly; the pseudo-names above are
> placeholders).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — `cfg.gate.agentCi` is `undefined`.

- [ ] **Step 3: Implement — extend the `gate` schema**

In `src/config/schema.ts`, replace the current `gate` object:

```ts
  gate: z
    .object({
      checkCommand: z.string().nullable().default(null), // e.g. "composer check" / "npm test"
      skipCheckByDefault: z.boolean().default(false),
      // OPTIONAL local-CI-replay hardening (spec 2026-07-08-agent-ci-gate-hardening).
      // Fully inert unless `enabled` AND a non-empty `workflows` allowlist — mirrors
      // checkCommand's null-is-a-no-op shape. NEVER auto-discovers workflows (a
      // deploy/publish workflow with secrets must never fire pre-merge); the allowlist
      // is explicit. A genuine workflow failure -> RETRY; an agent-ci/Docker infra
      // failure -> the gate step throws -> conductor escalates (see gate.ts step 1c).
      agentCi: z
        .object({
          enabled: z.boolean().default(false),
          workflows: z.array(z.string()).default([]),
          // 10 min: comfortably covers a cold `npx @redwoodjs/agent-ci` download +
          // a real Docker CI job. A run exceeding this is an INFRA failure (escalate),
          // not a job failure (retry).
          timeoutMs: z.number().int().positive().default(600000),
        })
        .default({ enabled: false, workflows: [], timeoutMs: 600000 }),
    })
    .default({
      checkCommand: null,
      skipCheckByDefault: false,
      agentCi: { enabled: false, workflows: [], timeoutMs: 600000 },
    }),
```

- [ ] **Step 4: Run typecheck + the config test**

Run: `npm run typecheck && npx vitest run src/config/config.test.ts`
Expected: no type errors; the two new tests pass; all existing config tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/config.test.ts
git commit -m "feat(config): add optional gate.agentCi block (enabled/workflows/timeoutMs)

Off by default -> byte-identical to today. Nested defaults so an old on-disk
config loads with enabled:false. First slice of agent-ci gate hardening."
```

---

## Task 2: `src/gate/agent-ci.ts` — the pure workflow-replay module

`runAgentCiWorkflows` spawns agent-ci once per allowlisted workflow (sequentially), parses
each run's terminal event, and returns `{green, reasons}` on a job outcome — or THROWS on an
infra failure. The throw-vs-return distinction is the whole contract (spec §3c/§4).

**Files:**
- Create: `src/gate/agent-ci.ts`
- Test: `src/gate/agent-ci.test.ts`

- [ ] **Step 1: Write the failing test against a fake runner (mirrors the `NativeRunner` fake
      style in `claude-orchestrator-adapter.test.ts`)**

```ts
// src/gate/agent-ci.test.ts
import { describe, it, expect } from "vitest";
import { runAgentCiWorkflows } from "./agent-ci.js";
import type { NativeResult } from "../util/native.js";

/** Build a fake NativeResult (agent-ci writes NDJSON to stdout). */
function res(stdout: string, exitCode = 0): NativeResult {
  return { stdout, stderr: "", exitCode } as NativeResult;
}

/** One passing workflow's NDJSON stream (defensive parser tolerates extra fields). */
const PASS = [
  JSON.stringify({ type: "run.start", workflow: ".github/workflows/ci.yml" }),
  JSON.stringify({ type: "step.finish", name: "test", conclusion: "success" }),
  JSON.stringify({ type: "run.finish", status: "passed" }),
].join("\n");

const FAIL = [
  JSON.stringify({ type: "run.start", workflow: ".github/workflows/ci.yml" }),
  JSON.stringify({ type: "step.finish", name: "test", conclusion: "failure" }),
  JSON.stringify({ type: "run.finish", status: "failed" }),
].join("\n");

describe("runAgentCiWorkflows", () => {
  it("returns green:true when the single workflow's run.finish is passed", async () => {
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 60000,
      runner: async () => res(PASS),
    });
    expect(out).toEqual({ green: true, reasons: [] });
  });

  it("returns green:false with a reason when a workflow fails", async () => {
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/ci.yml"],
      timeoutMs: 60000,
      runner: async () => res(FAIL, 1),
    });
    expect(out.green).toBe(false);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain(".github/workflows/ci.yml");
  });

  it("runs multiple workflows sequentially; any red fails the batch, naming each failure", async () => {
    const streams = [PASS, FAIL];
    let i = 0;
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [".github/workflows/a.yml", ".github/workflows/b.yml"],
      timeoutMs: 60000,
      runner: async (_c, args) => {
        // sequential: each call consumes the next scripted stream
        const stream = streams[i++] ?? PASS;
        // sanity: the workflow path is threaded through as an arg
        expect(args.join(" ")).toMatch(/\.github\/workflows\//);
        return res(stream, stream === FAIL ? 1 : 0);
      },
    });
    expect(out.green).toBe(false);
    expect(out.reasons.some((r) => r.includes("b.yml"))).toBe(true);
  });

  it("THROWS (infra failure) when a run has no parseable run.finish event", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 60000,
        runner: async () => res("Cannot connect to the Docker daemon\n", 125),
      }),
    ).rejects.toThrow(/agent-ci/i);
  });

  it("THROWS (infra failure) when the runner exceeds timeoutMs", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 20,
        runner: () => new Promise<NativeResult>(() => {}), // never resolves
      }),
    ).rejects.toThrow(/tim(ed )?out/i);
  });

  it("THROWS (infra failure) when the runner itself rejects (spawn error)", async () => {
    await expect(
      runAgentCiWorkflows({
        cwd: "/wt",
        workflows: [".github/workflows/ci.yml"],
        timeoutMs: 60000,
        runner: async () => {
          throw new Error("spawn npx ENOENT");
        },
      }),
    ).rejects.toThrow();
  });

  it("returns green:true (no throw) for an empty workflow list", async () => {
    // The empty-allowlist WARN+skip lives in root.ts; the module itself simply
    // has nothing to run and is trivially green.
    const out = await runAgentCiWorkflows({
      cwd: "/wt",
      workflows: [],
      timeoutMs: 60000,
      runner: async () => res(PASS),
    });
    expect(out).toEqual({ green: true, reasons: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/gate/agent-ci.test.ts`
Expected: FAIL — `Cannot find module './agent-ci.js'`.

- [ ] **Step 3: Implement**

```ts
// src/gate/agent-ci.ts
import type { NativeOptions, NativeResult } from "../util/native.js";

/** The subprocess seam — same signature as `runNative`, injected so the whole
 *  module is unit-testable with a scripted fake (no Docker in unit tests). */
export type NativeRunner = (
  command: string,
  args: string[],
  options?: NativeOptions,
) => Promise<NativeResult>;

export interface RunAgentCiInput {
  /** The per-task git worktree — agent-ci runs against its current file state. */
  cwd: string;
  /** Explicit allowlist of workflow file paths (never auto-discovered). */
  workflows: string[];
  /** Per-workflow wall-clock ceiling. Exceeding it is an INFRA failure (throw). */
  timeoutMs: number;
  runner: NativeRunner;
}

export interface AgentCiResult {
  green: boolean;
  reasons: string[];
}

/**
 * Replay a project's real GitHub Actions workflows locally via
 * `npx @redwoodjs/agent-ci run --workflow <path> --json`, one at a time, against
 * the given worktree.
 *
 * TWO outcomes, deliberately distinct (spec §3c — callers rely on the difference):
 *  - A genuine JOB failure (agent-ci ran fine, a workflow's run.finish is not
 *    "passed") -> RETURN `{green:false, reasons:[...]}`. Worker-fixable.
 *  - An INFRASTRUCTURE failure (Docker down, agent-ci unresolvable, no parseable
 *    run.finish event, or the run exceeds `timeoutMs`) -> THROW. NOT worker-fixable;
 *    the caller (gate.ts, via conductor.ts:474-492) escalates it.
 *
 * Sequential execution (never parallel) avoids the shared-node_modules-mount
 * collision agent-ci's own docs warn about for concurrent cold installs against
 * one working tree.
 */
export async function runAgentCiWorkflows(input: RunAgentCiInput): Promise<AgentCiResult> {
  const reasons: string[] = [];
  let green = true;

  for (const wf of input.workflows) {
    const result = await runOne(wf, input);
    const outcome = parseWorkflowOutcome(result.stdout);

    if (outcome === "infra") {
      // No parseable terminal event -> agent-ci itself did not complete a run
      // (Docker down, bad binary, etc.). Infra, not job -> throw (spec §3c).
      throw new Error(
        `agent-ci workflow '${wf}' produced no parseable run.finish event ` +
          `(exit ${result.exitCode}) -- treating as an infrastructure failure`,
      );
    }
    if (outcome === "failed") {
      green = false;
      reasons.push(`agent-ci workflow '${wf}' FAILED`);
    }
  }

  return { green, reasons };
}

/** Spawn one workflow with an independent timeout race. A promise that never
 *  resolves before `timeoutMs` is an infra failure -> throw. */
async function runOne(wf: string, input: RunAgentCiInput): Promise<NativeResult> {
  const args = ["@redwoodjs/agent-ci", "run", "--workflow", wf, "--json"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`agent-ci workflow '${wf}' timed out after ${input.timeoutMs}ms`)),
      input.timeoutMs,
    );
  });
  try {
    // AGENT_CI_JSON=1 belt-and-suspenders in case `--json` shifts; AI_AGENT=1
    // suppresses animated rendering. Both are additive/harmless if unrecognized.
    return await Promise.race([
      input.runner("npx", args, {
        cwd: input.cwd,
        env: { ...process.env, AGENT_CI_JSON: "1", AI_AGENT: "1" },
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type WorkflowOutcome = "passed" | "failed" | "infra";

/**
 * Parse agent-ci's buffered NDJSON stdout for a run's terminal outcome.
 * DEFENSIVE by design (see plan header): the terminal signal may appear as a
 * `run.finish` event carrying a `status`/`conclusion`/`result` string, or as a
 * top-level `passed` boolean. Any recognized "passed" wins; any recognized
 * "failed" is a job failure; NOTHING recognized is an infra failure. Unknown/
 * extra fields are ignored, never a crash. The EXACT real shape is confirmed in
 * the live-prove (Task 6) — do not remove that step in favor of trusting this.
 */
export function parseWorkflowOutcome(stdout: string): WorkflowOutcome {
  let sawTerminal = false;
  let failed = false;
  let passed = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue; // non-JSON log line -> ignore
    }

    const type = obj["type"];
    if (type === "run.finish" || type === "run.finished" || type === "run.complete") {
      sawTerminal = true;
      const verdict = terminalVerdict(obj);
      if (verdict === "passed") passed = true;
      else if (verdict === "failed") failed = true;
    } else if (typeof obj["passed"] === "boolean" && (type === undefined || type === "run.finish")) {
      // Alternate shape: a top-level {passed:bool} terminal object.
      sawTerminal = true;
      if (obj["passed"] === true) passed = true;
      else failed = true;
    }
  }

  if (!sawTerminal) return "infra";
  if (failed) return "failed";
  if (passed) return "passed";
  return "failed"; // a terminal event we couldn't read as pass -> treat as job failure, not infra
}

/** Read pass/fail from a terminal event across the field names agent-ci might use. */
function terminalVerdict(obj: Record<string, unknown>): "passed" | "failed" | "unknown" {
  if (obj["passed"] === true) return "passed";
  if (obj["passed"] === false) return "failed";
  for (const key of ["status", "conclusion", "result", "outcome"]) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    const s = v.toLowerCase();
    if (s === "passed" || s === "success" || s === "succeeded") return "passed";
    if (s === "failed" || s === "failure" || s === "error") return "failed";
  }
  return "unknown";
}
```

> **Note for the implementer:** the fake-stream unit tests above are the CONTRACT; the
> live-prove (Task 6) validates the parser against a real `agent-ci ... --json` NDJSON
> capture and adjusts `terminalVerdict`'s field list if the real terminal event differs.
> Capture the real stream first (`npx @redwoodjs/agent-ci run --workflow <wf> --json > out.ndjson`)
> and add one unit test using a verbatim real line before merge, per gotcha discipline.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/gate/agent-ci.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/gate/agent-ci.ts src/gate/agent-ci.test.ts
git commit -m "feat(gate): agent-ci local workflow-replay module (job-fail=return, infra-fail=throw)

Sequential npx @redwoodjs/agent-ci run --workflow <p> --json per allowlisted
workflow. Job failure -> {green:false,reasons}; Docker/binary/timeout infra
failure -> throw (the throw-vs-return split IS the contract). Defensive NDJSON
terminal-event parser; real shape confirmed in live-prove."
```

---

## Task 3: `src/gate/gate.ts` — wire step 1c + `agent_ci_green` + fold into the decision

The single most sensitive change. Add ONE optional dep, ONE step after `success_commands`,
ONE new named verdict boolean, and fold `green` into the EXISTING RETRY branch. A throw from
the dep must propagate out of `runGate` unchanged (no new try/catch inside gate.ts).

**Files:**
- Modify: `src/gate/gate.ts`
- Test: `src/gate/gate.test.ts` (extend)

- [ ] **Step 1: Write the failing tests (extend `gate.test.ts`)**

Add four cases — mirror the file's existing `runGate` fake-deps builder (read it first;
reuse its `makeDeps()`/defaults idiom exactly):

```ts
// present + green -> COMMIT unaffected, agent_ci_green true
it("agent-ci present and green leaves the decision unchanged and sets agent_ci_green", async () => {
  const deps = makeDeps({ runAgentCi: async () => ({ green: true, reasons: [] }) });
  const v = await runGate({ taskId: "t", fileSet: ["a.ts"] }, deps);
  expect(v.agent_ci_green).toBe(true);
  expect(v.decision).toBe("COMMIT");
});

// present + red -> RETRY, reason string surfaced
it("agent-ci present and red forces RETRY and records its reasons", async () => {
  const deps = makeDeps({
    runAgentCi: async () => ({ green: false, reasons: ["agent-ci workflow '.github/workflows/ci.yml' FAILED"] }),
  });
  const v = await runGate({ taskId: "t", fileSet: ["a.ts"] }, deps);
  expect(v.agent_ci_green).toBe(false);
  expect(v.decision).toBe("RETRY");
  expect(v.reasons.some((r) => r.includes("ci.yml"))).toBe(true);
});

// present + throwing -> propagates out of runGate (like loadInvariants throwing)
it("an agent-ci INFRA throw propagates out of runGate (conductor escalates)", async () => {
  const deps = makeDeps({
    runAgentCi: async () => {
      throw new Error("agent-ci ... infrastructure failure");
    },
  });
  await expect(runGate({ taskId: "t", fileSet: ["a.ts"] }, deps)).rejects.toThrow(/infrastructure/i);
});

// absent (null) -> today's behavior byte-for-byte; agent_ci_green defaults true
it("agent-ci absent (null) is a no-op: decision unchanged, agent_ci_green defaults true", async () => {
  const deps = makeDeps({ runAgentCi: null });
  const v = await runGate({ taskId: "t", fileSet: ["a.ts"] }, deps);
  expect(v.agent_ci_green).toBe(true);
  expect(v.decision).toBe("COMMIT");
});
```

> The critical regression guard is the LAST one (`null` = today's behavior). Ensure
> `makeDeps` defaults `runAgentCi` to `null` so EVERY pre-existing gate test still passes
> untouched — that is the proof this change is inert when off.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/gate/gate.test.ts`
Expected: FAIL — `runAgentCi` not on `GateDeps`; `agent_ci_green` not on the verdict.

- [ ] **Step 3: Implement — four edits to `gate.ts`**

1. `GateVerdict` — add the named boolean (default `true`; §3d convention: one boolean per
   check family):

```ts
export interface GateVerdict {
  task_id: string;
  composer_green: boolean;
  success_green: boolean;
  agent_ci_green: boolean; // true when the feature is off / not applicable
  constitution_touched: string[];
  zones_touched: ZoneResult[];
  decision: Decision;
  reasons: string[];
  changed_files: string[];
}
```

2. `GateDeps` — add the optional dep (null = skip, mirrors `runCheck`):

```ts
  /** Optional local-CI replay (agent-ci). null = feature off (skip). A genuine
   *  workflow failure returns {green:false}; an INFRA failure THROWS, and that
   *  throw is meant to propagate out of runGate exactly like a throwing
   *  loadInvariants/loadGuardPairs does (conductor treats a gate throw as
   *  ESCALATE -- see conductor.ts:474-492). Do NOT wrap it in a try/catch here. */
  runAgentCi: (() => Promise<{ green: boolean; reasons: string[] }>) | null;
```

3. The empty-file_set fast-path verdict (step 0) — add `agent_ci_green: true` to keep the
   object shape complete.

4. New step "1c", immediately AFTER the success_commands loop (current line ~131) and BEFORE
   the constitution check (current line ~133):

```ts
  // 1c. optional agent-ci local CI replay (spec 2026-07-08). null = feature off.
  // A red workflow is worker-fixable -> RETRY (folds in below, exactly like a
  // failed success_command). An INFRA failure THROWS out of runGate here (Docker
  // down / binary unresolvable / timeout) -- intentionally NOT caught: the
  // conductor's try/catch around runGate escalates it as a broken-operator-config
  // problem, the same path a throwing loadInvariants takes.
  let agentCiGreen = true;
  if (deps.runAgentCi !== null) {
    const ci = await deps.runAgentCi();
    agentCiGreen = ci.green;
    if (!ci.green) {
      reasons.push(...ci.reasons);
    }
  }
```

5. Fold into the decision (current line ~235) — add `|| !agentCiGreen` to the RETRY branch:

```ts
  let decision: Decision = "COMMIT";
  if (!composerGreen || !successGreen || !agentCiGreen) {
    decision = "RETRY";
  } else if (constitutionTouched.length > 0) {
    decision = "ESCALATE";
  } else {
    // ... unchanged zone loop ...
  }
```

6. Add `agent_ci_green: agentCiGreen` to the final `verdict` object.

- [ ] **Step 4: Run the gate tests + typecheck**

Run: `npm run typecheck && npx vitest run src/gate/gate.test.ts`
Expected: no type errors; the four new tests pass; ALL pre-existing gate tests still pass
(the `null` default makes them inert).

- [ ] **Step 5: Commit**

```bash
git add src/gate/gate.ts src/gate/gate.test.ts
git commit -m "feat(gate): fold optional agent-ci replay into the machine gate (step 1c)

New optional GateDeps.runAgentCi + agent_ci_green verdict field. Red workflow
-> RETRY (like success_commands); infra throw propagates out of runGate ->
conductor escalates (no new try/catch). null dep = byte-for-byte today."
```

---

## Task 4: `src/composition/root.ts` — build `runAgentCi` in `gateDeps`

Wire the real dep the same way `runCheck` is wired: `null` when disabled, else a closure over
`runAgentCiWorkflows`. Handle the "enabled but empty allowlist" case here (WARN + skip →
green), since this is where `log` lives and where the "misconfigured-but-not-broken → fail
open with a loud warning" convention already lives. Untested glue by design (gotcha
`[conductor/wiring]`), covered by typecheck + the suite + the live-prove.

**Files:**
- Modify: `src/composition/root.ts`

- [ ] **Step 1: Add the import**

```ts
import { runAgentCiWorkflows } from "../gate/agent-ci.js";
```

- [ ] **Step 2: Build `runAgentCi` inside `gateDeps(wt)` (alongside `runCheck`)**

```ts
  function gateDeps(wt: Worktree): GateDeps {
    const checkCommand = cfg.gate.checkCommand;
    const agentCi = cfg.gate.agentCi;
    return {
      // ... loadInvariants / loadGuardPairs / resolveScope / runCheck / runSuccessCommand unchanged ...
      runAgentCi: agentCi.enabled
        ? async () => {
            if (agentCi.workflows.length === 0) {
              // Enabled but nothing to run: fail OPEN with a loud warning
              // (mirrors policy.heterogeneity's misconfig convention). Never
              // blocks a run on a half-finished config.
              log("WARN", "gate.agentCi.enabled but workflows allowlist is empty -- skipping agent-ci this round");
              return { green: true, reasons: [] };
            }
            return runAgentCiWorkflows({
              cwd: wt.path,
              workflows: agentCi.workflows,
              timeoutMs: agentCi.timeoutMs,
              runner: runNative,
            });
          }
        : null,
      // ... guardStillRed / writeVerdict unchanged ...
    };
  }
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: green; no test references the new wiring directly (it's glue), but nothing regresses.

- [ ] **Step 4: Commit**

```bash
git add src/composition/root.ts
git commit -m "feat(gate): wire agent-ci replay into gateDeps (null when disabled)

Closure over runAgentCiWorkflows against the task worktree; enabled-but-empty
allowlist -> WARN + skip (fail-open), matching the heterogeneity misconfig
convention. runNative is the real subprocess seam."
```

---

## Task 5: Regression test — a UI `checkCommand` save preserves a hand-set `gate.agentCi`

No code change — insurance against the `[config/zod-strict]` / `[config/yaml-merge-drops-comments]`
class: prove `mergeConfigYaml` (field-selective + spreads `...raw.gate`) does NOT drop an
operator's hand-written `gate.agentCi` when the UI later edits `checkCommand`. If this test
ever fails, the config-file-only design is silently broken and agent-ci would flip back to
disabled on an unrelated UI save.

**Files:**
- Test: `src/registry/scaffold.test.ts` (extend)

- [ ] **Step 1: Add the regression test**

```ts
it("mergeConfigYaml preserves a hand-set gate.agentCi across a checkCommand UI edit", () => {
  const existing = [
    "gate:",
    "  agentCi:",
    "    enabled: true",
    "    workflows:",
    "      - .github/workflows/ci.yml",
    "",
  ].join("\n");
  const merged = mergeConfigYaml(existing, { gate: { checkCommand: "npm test" } });
  const parsed = parseYaml(merged) as any;
  expect(parsed.gate.checkCommand).toBe("npm test");
  expect(parsed.gate.agentCi.enabled).toBe(true);
  expect(parsed.gate.agentCi.workflows).toEqual([".github/workflows/ci.yml"]);
});
```

> Use the file's existing `parseYaml` import / idiom.

- [ ] **Step 2: Run to verify it passes (it should already, given the spread) — a red here is a real finding**

Run: `npx vitest run src/registry/scaffold.test.ts`
Expected: pass. If it FAILS, STOP — the write path drops agentCi and needs a fix (spread
`...(raw.gate)` is already there at scaffold.ts:176, so this is expected green; the test locks it).

- [ ] **Step 3: Commit**

```bash
git add src/registry/scaffold.test.ts
git commit -m "test(config): lock that a UI checkCommand save preserves hand-set gate.agentCi

Insurance against the [config/zod-strict] silent-revert class -- mergeConfigYaml
spreads ...raw.gate, so the config-file-only agentCi block survives an unrelated
UI edit. Regression guard only, no code change."
```

---

## Task 6: Full verification, codex gate, live-prove, docs

- [ ] **Step 1: Whole-suite + typecheck + build (root + ui)**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; test count up by the new files' cases.

- [ ] **Step 2: MANDATORY codex GPT-5.5 critic gate on the `gate.ts` diff specifically**

This is the whole point of the project on its most sensitive file. Submit the full diff
(schema + agent-ci.ts + gate.ts + root.ts + tests) to codex GPT-5.5 via `codex-companion.mjs`
(rescue subagent submits; poll `status`/`result <jobid>` from the MAIN session). Feed the diff
INLINE in the prompt (gotcha `[critic/codex]`: the sandbox can't spawn `git diff` on Windows).
Fix every finding with a regression test; **re-critic the fixes** — never self-certify. Only
proceed to live-prove after a CLEAN (or CLEAN-after-fix) verdict.

- [ ] **Step 3: Live-prove (Docker is present: 29.4.0) — all three branches on a disposable repo**

Set up a throwaway git repo with a minimal real `.github/workflows/ci.yml` (one job, one step
— e.g. `run: node -e "process.exit(0)"`). Register it, put it on an `autodev/*` branch, and set
`.autodev/config.yaml`:

```yaml
gate:
  agentCi:
    enabled: true
    workflows: [".github/workflows/ci.yml"]
```

**Pre-cache agent-ci first** (`npm i -D @redwoodjs/agent-ci` in the test repo OR a global
install) — a cold `npx` download took >3 min this session and would otherwise eat the gate
timeout and look like a hang.

- [ ] **(a) PASS branch:** a workflow made to succeed → drive one task through the gate →
      confirm the gate does NOT block on agent-ci (decision reaches COMMIT as it would without
      the feature), `gate-verdict.json` shows `agent_ci_green: true`.
- [ ] **(b) JOB-FAIL branch:** flip the workflow step to `run: node -e "process.exit(1)"` →
      confirm the gate returns RETRY with an `agent-ci workflow '...' FAILED` reason and
      `agent_ci_green: false` (worker-fixable path, NOT an escalation).
- [ ] **(c) INFRA-FAIL branch:** stop Docker (or point `workflows` at a missing file / make
      the binary unresolvable) → confirm `runGate` throws → the conductor escalates it as
      "gate threw -- broken operator config" (NOT an infinite worker retry loop). Capture the
      real NDJSON `--json` stream during (a)/(b) and, if the terminal event's field names
      differ from the defensive parser's list, add a verbatim-real-line unit test and adjust
      `terminalVerdict` before merge.

- [ ] **Step 4: Docs — gotchas + state**

- [ ] Scan the session for gotchas (likely candidates: the cold-`npx`-download-looks-like-a-
      hang trap; the exact real `run.finish` field name once confirmed; any Docker/worktree
      interaction). Add `docs/gotchas/{slug}.md` + a `docs/GOTCHAS.md` index line + bump the
      count for each.
- [ ] Update `docs/CURRENT-STATE.md` (top block) + prepend a `docs/SESSION-LOG.md` entry.

- [ ] **Step 5: Merge decision (superpowers:finishing-a-development-branch)**

Batch the whole feature into ONE PR (operator's batch-merge steer). Gate the merge on:
codex CLEAN on the gate.ts diff + green CI (4/4) + all three live-prove branches demonstrated.
Then self-merge per the standing git-ownership grant (AGENTS.md) — do not pause to ask.

---

## Decisions locked in this plan (spec §7 open questions, resolved)

1. **Invocation path:** `npx @redwoodjs/agent-ci run --workflow <path> --json` (npm 0.16.2),
   with `AGENT_CI_JSON=1`/`AI_AGENT=1` env belt-and-suspenders. The opting-in project must
   pre-install/pre-cache agent-ci (documented prereq) — the harness does NOT auto-install it,
   and a cold `npx` download is slow enough to matter (covered by the 10-min default timeout,
   but recommended against for real use).
2. **`timeoutMs` floor:** not enforced in v1 (schema only requires a positive int). A too-low
   value simply makes real runs escalate as infra-timeout — visible and self-correcting, not
   silently wrong. A minimum floor can be a later nicety; not worth the added surface now.

## Related

- `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` — the spec.
- `docs/wiki/agent-ci-analysis.md` — the recon.
- `src/gate/gate.ts`, `src/conductor/conductor.ts` (try/catch at 474-492), `src/composition/root.ts`.
