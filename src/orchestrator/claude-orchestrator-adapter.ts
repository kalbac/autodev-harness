import type { HarnessConfig } from "../config/schema.js";
import { resolveOrchestratorExe } from "../config/roles.js";
import { runNative } from "../util/native.js";
import type { NativeOptions, NativeResult } from "../util/native.js";
import type { DecomposeInput, OrchestratorAdapter } from "./adapter.js";
import { buildDecomposePrompt } from "./decompose-prompt.js";
import { extractJsonArray } from "./json-array-extract.js";
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

/** Collapse newlines to spaces and clip to `maxLength` chars (error-message helper). */
function firstChars(text: string, maxLength: number): string {
  const collapsed = text.replace(/[\r\n]+/g, " ").trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}
