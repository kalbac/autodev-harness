/**
 * Token/usage instrumentation types + pure parsers (s22). See
 * `docs/superpowers/specs/2026-07-04-token-usage-instrumentation.md`.
 *
 * Deliberately dependency-free and side-effect-free: the two adapters call the
 * parsers on their captured stdout, and the conductor calls `buildTokenUsageDoc`
 * to aggregate per-round runs into the persisted `token-usage.json` artifact.
 * Everything here is best-effort by contract — a parse miss returns `null`, never
 * throws, so token accounting can never break the enforcement loop.
 */

/** One worker (claude) invocation's usage, as read from its final stream-json
 *  `result` event. `model` is attached by the adapter (the parser only reads the
 *  token numbers, which the event does not label with a model). */
export interface WorkerUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One critic (codex) invocation's usage. Plain `codex exec` prints only a bare
 *  `tokens used\n<N>` total — no input/output split and no cost — so this carries
 *  a single `tokens` number. See the spec for why we don't switch codex to `--json`. */
export interface CriticUsage {
  model: string;
  tokens: number;
}

/** The persisted per-task artifact (`runtime/<id>/token-usage.json`). Sums every
 *  worker + critic invocation across all rounds of a task, keeping per-invocation
 *  detail in the `runs` arrays. */
export interface TokenUsageDoc {
  worker: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    runs: WorkerUsage[];
  };
  critic: {
    tokens: number;
    runs: CriticUsage[];
  };
  /** Conductor `clock.now()` at the last write — lets the UI show freshness. */
  updated_at: number;
}

/** Coerce an unknown JSON value to a finite non-negative-safe number, defaulting
 *  to 0 for anything missing / non-numeric (a usage field a CLI version omits
 *  must contribute 0, never NaN). */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse the LAST `type:"result"` stream-json event that carries a `usage` object
 * out of a claude worker's captured stdout (`claude -p --output-format
 * stream-json --verbose` emits JSONL). Tolerant: non-JSON / non-`{` lines are
 * skipped, and a run that never emitted a usage-bearing result event yields
 * `null`. The `model` is NOT set here — the adapter attaches the ladder model it
 * actually ran.
 */
export function parseClaudeUsage(stdout: string): Omit<WorkerUsage, "model"> | null {
  let found: Record<string, unknown> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      obj !== null &&
      typeof obj === "object" &&
      (obj as Record<string, unknown>).type === "result" &&
      typeof (obj as Record<string, unknown>).usage === "object" &&
      (obj as Record<string, unknown>).usage !== null
    ) {
      found = obj as Record<string, unknown>;
    }
  }
  if (found === null) return null;
  const u = found.usage as Record<string, unknown>;
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
  };
}

/** Strip thousands separators and parse; `null` on a non-finite result. */
function toTokenCount(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the bare `tokens used\n<N>` (or `tokens used: N`) FOOTER codex prints near
 * the end of a plain `codex exec` run. Best-effort and format-specific by design
 * (see spec). LINE-ANCHORED to avoid false telemetry: only a line whose entire
 * (trimmed) content is the token footer counts — prose that merely mentions
 * "tokens used" mid-sentence (e.g. a critic note "No tokens used in this example;
 * finding 3 ...") must NOT be mistaken for the accounting line. Scans from the end
 * (the footer is last); accepts the count inline on that line or as a bare integer
 * on the next non-empty line. Returns `null` when no such footer is present.
 */
export function parseCodexTokens(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // Whole line IS the footer: "tokens used", optionally "... : <N>" inline.
    const m = /^tokens?\s+used\b\s*:?\s*([0-9][0-9,]*)?$/i.exec(line);
    if (m === null) continue;
    if (m[1] !== undefined) return toTokenCount(m[1]);
    // Bare footer — the count is the next non-empty line, which must be a plain
    // integer (anything else is not the accounting number).
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (next === "") continue;
      return /^[0-9][0-9,]*$/.test(next) ? toTokenCount(next) : null;
    }
    return null;
  }
  return null;
}

/**
 * Aggregate per-round worker + critic usage into the persisted doc. Pure sum —
 * the conductor passes the running arrays and its clock; overwriting the file
 * with a fresh doc each round is idempotent.
 *
 * The per-run arrays are rebuilt as token-only copies at this write boundary
 * (never persisted by reference): the operator's contract is NO cost anywhere in
 * telemetry (s25), and `JSON.stringify` would otherwise preserve any stray field
 * a caller left on an input object (e.g. a legacy `WorkerUsage` still carrying
 * `total_cost_usd`). Sanitizing here makes "no cost in the artifact" a structural
 * guarantee of the writer, not a property that depends on every upstream
 * constructor staying cost-free.
 */
export function buildTokenUsageDoc(
  workerRuns: WorkerUsage[],
  criticRuns: CriticUsage[],
  updatedAt: number,
): TokenUsageDoc {
  const workerRunCopies: WorkerUsage[] = workerRuns.map((r) => ({
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_input_tokens: r.cache_read_input_tokens,
    cache_creation_input_tokens: r.cache_creation_input_tokens,
  }));
  const criticRunCopies: CriticUsage[] = criticRuns.map((r) => ({
    model: r.model,
    tokens: r.tokens,
  }));
  const worker = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    runs: workerRunCopies,
  };
  for (const r of workerRunCopies) {
    worker.input_tokens += r.input_tokens;
    worker.output_tokens += r.output_tokens;
    worker.cache_read_input_tokens += r.cache_read_input_tokens;
    worker.cache_creation_input_tokens += r.cache_creation_input_tokens;
  }
  let criticTokens = 0;
  for (const r of criticRunCopies) criticTokens += r.tokens;
  return {
    worker,
    critic: { tokens: criticTokens, runs: criticRunCopies },
    updated_at: updatedAt,
  };
}

/** Aggregate one run's per-task token-usage docs into a single summary (s25
 *  server-side aggregation for `GET /runs/:id/usage`). `taskCount` is the run's
 *  full task count; `tasksWithUsage` is how many had a parseable usage doc, so a
 *  partially-instrumented run reads honestly. `any` mirrors the s22 client aggregate. */
export interface RunUsageSummary {
  tokens: number;
  any: boolean;
  taskCount: number;
  tasksWithUsage: number;
}

/** Narrow structural guard: a file that parses as JSON but isn't a usage doc (older
 *  schema / hand-edit) is skipped by the aggregator rather than poisoning the sum.
 *  Mirrors the `isRunManifest`/`isEscalationReply` boundary-validation pattern. */
export function isTokenUsageDoc(value: unknown): value is TokenUsageDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const w = v.worker;
  const c = v.critic;
  if (typeof w !== "object" || w === null || typeof c !== "object" || c === null) return false;
  const wr = w as Record<string, unknown>;
  const cr = c as Record<string, unknown>;
  return (
    typeof wr.input_tokens === "number" &&
    typeof wr.output_tokens === "number" &&
    typeof wr.cache_read_input_tokens === "number" &&
    typeof wr.cache_creation_input_tokens === "number" &&
    typeof cr.tokens === "number"
  );
}

/** Sum token totals across a run's parsed usage docs. `docs` are ONLY the tasks
 *  that had a parseable token-usage.json; `taskCount` is the run's total task count
 *  (so `docs.length <= taskCount`). Pure. Each field goes through `num()` so a NaN/
 *  Infinity from a malformed-but-guard-passing doc contributes 0, never poisons the
 *  total (same discipline as buildTokenUsageDoc). Mirrors the s22 client summation:
 *  worker 4 token fields + critic.tokens. */
export function buildRunUsageSummary(docs: TokenUsageDoc[], taskCount: number): RunUsageSummary {
  let tokens = 0;
  for (const d of docs) {
    tokens +=
      num(d.worker.input_tokens) +
      num(d.worker.output_tokens) +
      num(d.worker.cache_read_input_tokens) +
      num(d.worker.cache_creation_input_tokens) +
      num(d.critic.tokens);
  }
  return { tokens, any: docs.length > 0, taskCount, tasksWithUsage: docs.length };
}
