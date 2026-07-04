# Spec — Token/usage instrumentation (s22)

> Status: APPROVED (operator scope-gate s22). The next real module after P3 closed.
> Scope decision (operator): **per-task runtime file + client-side aggregation by run.**

## Goal

Surface real token/usage numbers on the dashboard's "Tokens" rail (currently a
`phase 2` placeholder) by instrumenting the two LLM adapters and persisting a
per-task usage artifact the existing runtime-file endpoint already serves.

## The single design decision (operator-gated)

- **Granularity:** per-task `token-usage.json` runtime file (sibling of the
  deferred `critic-verdict.json`, gotcha `[ui/verdict-not-persisted]`).
- **Aggregation:** the UI sums a run's tasks **on the client** (via the newest
  run manifest's `taskIds`). NO server aggregation endpoint, NO conductor
  cumulative counter. Minimal conductor touch.
- **Read path:** the EXISTING generic runtime-file endpoint
  `GET /projects/:id/tasks/:id/runtime/token-usage.json` serves it. **No new API code.**

## What we can and cannot measure

- **Worker (claude):** `claude -p --output-format stream-json --verbose` already
  emits JSONL; the final `type:"result"` event carries a `usage` object
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`) and `total_cost_usd`. Full detail available —
  no new CLI flag. `WatchedRunResult.stdout` already captures it.
- **Critic (codex):** plain `codex exec` (no `--json`) prints only a bare
  `tokens used\n<N>` total near the end of stdout. We parse that total
  **best-effort**. We deliberately do NOT switch codex to `--json`: the critic
  verdict resolution reads stdout as its fallback source (`codex-adapter.ts`),
  and destabilising the enforcement gate for an observability nicety is a bad
  trade. Critic usage is therefore a single `tokens` total (no input/output
  split, no cost), and is `null`/omitted when the bare line can't be parsed.

## Modules

### `src/usage/usage.ts` (new, pure — fully unit-tested)

```ts
export interface WorkerUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
}
export interface CriticUsage {
  model: string;
  tokens: number; // codex bare-line total; no split available on plain exec
}
export interface TokenUsageDoc {
  worker: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    total_cost_usd: number;
    runs: WorkerUsage[];   // per ladder-step/round detail
  };
  critic: {
    tokens: number;
    runs: CriticUsage[];   // per round detail
  };
  total_cost_usd: number;  // worker cost total (critic exec gives none on plain exec)
  updated_at: number;      // conductor clock.now()
}

// Parse the LAST stream-json `result` event's usage + total_cost_usd.
// Tolerant: skips non-JSON lines; returns null if no result-with-usage found.
export function parseClaudeUsage(stdout: string): Omit<WorkerUsage, "model"> | null;

// Parse the bare `tokens used\n<N>` (or `tokens used: N`) total. Tolerant;
// strips thousands separators; returns null on no match.
export function parseCodexTokens(stdout: string): number | null;

// Pure aggregator: sum worker.runs + critic.runs into a TokenUsageDoc.
export function buildTokenUsageDoc(
  workerRuns: WorkerUsage[],
  criticRuns: CriticUsage[],
  updatedAt: number,
): TokenUsageDoc;
```

### `src/worker/adapter.ts` + `src/worker/claude-adapter.ts`

- Add `usage?: WorkerUsage` to `WorkerResult` (optional; omitted when unparseable,
  respecting `exactOptionalPropertyTypes` — never assign explicit `undefined`).
- In `toResult(status, model, result)`: `const u = parseClaudeUsage(result.stdout);`
  attach `usage: { model, ...u }` only when `u !== null`.
- The 5 existing exact-shape assertions in `claude-adapter.test.ts` use
  `okResult()` with `stdout: ""` → `parseClaudeUsage` returns null → `usage`
  key absent → those `toEqual({...no usage...})` assertions stay green **unchanged**.
  Add NEW tests for the usage-present path.

### `src/critic/adapter.ts` + `src/critic/codex-adapter.ts`

- Add `usage?: CriticUsage` to `CriticResult`.
- After the `runner(...)` call, `const t = parseCodexTokens(result.stdout);`
  attach `usage: { model: cfg.roles.critic.model, tokens: t }` on BOTH the
  verdict-found and verdict-null returns when `t !== null`.
- The empty-diff early return (no spawn) carries no usage — omitted.

### `src/conductor/conductor.ts`

- Per task (inside `runIteration`), accumulate `workerRuns: WorkerUsage[]` and
  `criticRuns: CriticUsage[]`.
- Push `wr.usage` right after `worker.run` returns (BEFORE the rate-limit/timeout
  early returns, so a throttled run still records what it burned) and `cr.usage`
  right after `critic.run`.
- A best-effort `persistTokenUsage()` writes `token-usage.json` via
  `repo.writeRuntimeFile(task.id, "token-usage.json", JSON.stringify(doc, null, 2))`.
  Call it after each push so the file always reflects consumption-so-far
  regardless of which of the many early returns fires. Overwrite is idempotent.
- **Never-throws:** wrap in try/catch + `safeLog` (same discipline as `recordRun`
  / digest / teardown — token accounting must NEVER break the enforcement loop or
  convert a decided iteration into a rejection; gotcha `[ts/fail-closed]`).

## UI (review-only, static — no codex gate)

- `SessionRail.tsx` "Tokens" block: drop the `phase 2` badge; show the newest
  run's summed tokens + cost, aggregated on the client.
- New hook `useRunUsage(projectId, runId)` (in `queries.ts`): fetch the run's
  `token-usage.json` per `taskId` (tolerate 404 → skip), sum worker+critic
  `tokens` and worker `total_cost_usd`. Single `useQuery`, async `queryFn` with
  `Promise.all`. NO server change.
- Rail shows `this run` = total tokens (e.g. `12.3k`), `cost` = `$0.0123`.
  "today" (cross-run) is out of scope for a session rail (would be N×M fetches);
  drop it rather than fake it.

## Discipline

Enforcement-adjacent (worker/critic adapters) + conductor → **full TDD →
spec-check → independent codex GPT-5.5 gate → re-critic**. UI is review-only.

## Related

- `docs/CURRENT-STATE.md` NEXT ACTIONS #1 (the findings this spec starts from).
- gotcha `[ui/verdict-not-persisted]` — the sibling deferred runtime artifact.
- gotcha `[ts/fail-closed]` — never-throws catch-block discipline.
- `src/api/server.ts` — the runtime-file endpoint that serves the artifact unchanged.
