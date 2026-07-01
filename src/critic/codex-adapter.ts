import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CriticAdapter, CriticResult, CriticRunInput } from "./adapter.js";
import { buildCriticPrompt } from "./prompt.js";
import { attachDiffSha256, parseVerdict } from "./verdict.js";
import { withWorkerReportFenced } from "./fencing.js";
import type { HarnessConfig } from "../config/schema.js";
import { resolveCriticExe } from "../config/roles.js";
import { runNative } from "../util/native.js";
import type { NativeOptions, NativeResult } from "../util/native.js";

export type NativeRunner = (
  command: string,
  args: string[],
  options?: NativeOptions,
) => Promise<NativeResult>;

export interface CodexCriticAdapterDeps {
  cfg: HarnessConfig;
  repoRoot: string;
  runner?: NativeRunner;
  schemaPath?: string;
}

export const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL("./critic-verdict.schema.json", import.meta.url));

/**
 * Live codex-backed critic adapter — parity spec §5 `invoke-critic.ps1`.
 *
 * Tiering (§5): an empty diff is the `none` tier — pass-through `clean` at
 * confidence 0.5, WITHOUT spawning codex. Every non-empty diff is the
 * `expensive` tier — exactly one `codex exec` call (no internal retry; that
 * is a conductor-level concern via `cfg.roles.critic.retryMax`).
 *
 * Verdict resolution ordering (§5, load-bearing): the `-o` outfile is read
 * first; if that yields no parseable verdict, stdout+stderr is tried as a
 * fallback. A verdict parsed from EITHER source is authoritative and wins
 * over any rate-limit signal (the 2026-06-07 fix) — the exit code is only
 * inspected when NO verdict could be parsed at all.
 */
export class CodexCriticAdapter implements CriticAdapter {
  private readonly cfg: HarnessConfig;
  private readonly repoRoot: string;
  private readonly runner: NativeRunner;
  private readonly schemaPath: string;

  constructor(deps: CodexCriticAdapterDeps) {
    this.cfg = deps.cfg;
    this.repoRoot = deps.repoRoot;
    this.runner = deps.runner ?? runNative;
    this.schemaPath = deps.schemaPath ?? DEFAULT_SCHEMA_PATH;
  }

  async run(input: CriticRunInput): Promise<CriticResult> {
    if (input.diff.trim().length === 0) {
      return {
        verdict: attachDiffSha256(
          { verdict: "clean", broken_contracts: [], notes: "empty diff — nothing to review", confidence: 0.5 },
          input.diff,
        ),
        rateLimited: false,
      };
    }

    return withWorkerReportFenced(input.workerReportPath, async () => {
      const prompt = buildCriticPrompt(input.diff);
      const outfile = join(input.runtimeDir, "critic-last-message.json");

      // The outfile path is fixed per runtimeDir and reused across retry
      // rounds. Delete any stale verdict left over from a prior round BEFORE
      // spawning codex, so that "outfile exists after the run" only ever
      // means "this run wrote it" — never a leftover from an earlier round.
      await rm(outfile, { force: true });

      const result = await this.runner(
        resolveCriticExe(this.cfg),
        [
          "exec",
          "-m",
          this.cfg.roles.critic.model,
          "-c",
          `model_reasoning_effort="${this.cfg.roles.critic.effort}"`,
          "-c",
          `approval_policy="never"`,
          "-s",
          "read-only",
          "-C",
          this.repoRoot,
          "--skip-git-repo-check",
          "--output-schema",
          this.schemaPath,
          "-o",
          outfile,
          "-",
        ],
        { cwd: this.repoRoot, stdin: prompt },
      );

      let verdict = existsSync(outfile) ? parseVerdict(await readFile(outfile, "utf8")) : null;
      if (verdict === null) {
        verdict = parseVerdict(`${result.stdout}\n${result.stderr}`);
      }

      if (verdict !== null) {
        return { verdict: attachDiffSha256(verdict, input.diff), rateLimited: false };
      }

      return { verdict: null, rateLimited: result.exitCode === 4 };
    });
  }
}
