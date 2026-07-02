import type { HarnessConfig } from "../config/schema.js";
import { resolveOrchestratorExe } from "../config/roles.js";
import { runNative } from "../util/native.js";
import type { NativeOptions, NativeResult } from "../util/native.js";
import type { DecomposeInput, OrchestratorAdapter } from "./adapter.js";
import { buildDecomposePrompt } from "./decompose-prompt.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";

export type NativeRunner = (
  command: string,
  args: string[],
  options?: NativeOptions,
) => Promise<NativeResult>;

export interface ClaudeOrchestratorAdapterDeps {
  cfg: HarnessConfig;
  runner?: NativeRunner;
  /**
   * Working directory for the one-shot `claude -p` decompose call. Without
   * this, the spawned process inherits `process.cwd()` of the harness
   * daemon, which is NOT necessarily the repo the operator's intent is
   * about — the model would explore the wrong filesystem tree.
   */
  repoRoot: string;
}

/**
 * Live claude/opus-backed orchestrator adapter (fork C1) — decompose-only
 * (the R2 planner is folded into this one method for the MVP).
 *
 * Spawns a single, bounded, one-shot `claude -p --model <model>` call (no
 * watchdog needed — mirrors anti-drift's `runModel`, NOT the worker's
 * long-running ladder+watchdog machinery). The model's ONLY output contract
 * is a JSON array of task-spec-shaped objects; every element is run through
 * `validateTaskSpec` (task-spec.ts) — the sole trust boundary between
 * LLM-authored JSON and a task that can ever reach `queue/pending/`.
 */
export class ClaudeOrchestratorAdapter implements OrchestratorAdapter {
  private readonly cfg: HarnessConfig;
  private readonly runner: NativeRunner;
  private readonly repoRoot: string;

  constructor(deps: ClaudeOrchestratorAdapterDeps) {
    this.cfg = deps.cfg;
    this.runner = deps.runner ?? runNative;
    this.repoRoot = deps.repoRoot;
  }

  async decompose(input: DecomposeInput): Promise<TaskSpec[]> {
    const prompt = buildDecomposePrompt(input.intent, input.state);

    const result = await this.runner(
      resolveOrchestratorExe(this.cfg),
      ["-p", "--model", this.cfg.roles.orchestrator.model],
      { cwd: this.repoRoot, stdin: prompt },
    );

    const elements = extractJsonArray(`${result.stdout}\n${result.stderr}`);
    if (elements === null) {
      throw new Error(
        "orchestrator decomposition produced no parseable JSON array " +
          `(exit ${result.exitCode}); raw output: ${firstChars(`${result.stdout}${result.stderr}`, 500)}`,
      );
    }

    // An empty array is a VALID "no work needed" decomposition, NOT an error —
    // it flows through to `handleIntent`'s empty-batch skip (report + no
    // trigger). Only UNPARSEABLE output (null above) is a decomposition
    // failure. This keeps the adapter and the orchestrator consistent.
    return elements.map((element, index) => {
      try {
        return validateTaskSpec(element);
      } catch (err) {
        throw new Error(`orchestrator decomposition element [${index}] is invalid: ${String((err as Error).message ?? err)}`);
      }
    });
  }
}

/**
 * Tolerant JSON-ARRAY extraction (mirrors `critic/verdict.ts`'s tolerant
 * `{...}` object extraction, but for a top-level `[...]` array): the model's
 * output is often surrounded by prose despite the "ONLY JSON" instruction.
 *
 * Naive "first `[` .. last `]`" slicing breaks when prose contains a stray
 * bracket (e.g. "Here are tasks [draft]\n[{...}]" — the naive slice would
 * span from the prose bracket all the way to the real close, capturing
 * invalid JSON in between). Instead, this scans every index where a `[`
 * occurs, and for each one attempts to find ITS balanced matching `]`
 * (tracking bracket depth while ignoring bracket characters that appear
 * inside JSON string literals — respecting `"..."` with `\"` escapes so a
 * bracket inside a title like `"fix [x]"` doesn't perturb the depth count).
 * The first candidate slice that both balances AND parses to a top-level
 * array is returned. Returns `null` (never throws) if no candidate
 * qualifies — the caller decides how to react.
 */
function extractJsonArray(text: string): unknown[] | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;

    const end = findBalancedArrayEnd(text, i);
    if (end === -1) continue;

    const candidate = text.slice(i, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Starting at `start` (which must point at a `[`), scan forward tracking
 * bracket depth — `[` / `]` outside of string literals adjust depth,
 * anything inside a `"..."` string (respecting `\"` escapes) is ignored —
 * and return the index of the `]` where depth returns to 0. Returns -1 if
 * the brackets never balance before the text ends.
 */
function findBalancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped character (e.g. \" or \\)
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/** Collapse newlines to spaces and clip to `maxLength` chars (error-message helper). */
function firstChars(text: string, maxLength: number): string {
  const collapsed = text.replace(/[\r\n]+/g, " ").trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}
