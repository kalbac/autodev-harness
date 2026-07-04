import type { Verdict } from "./verdict.js";
import type { CriticUsage } from "../usage/usage.js";

/**
 * Critic transport seam — parity spec §5 (`invoke-critic.ps1`). Mirrors the
 * worker/adapter.ts split: this interface only knows whether a parseable
 * verdict came back and whether the underlying codex call was rate-limited.
 * A parsed verdict is always authoritative over the rate-limit signal (the
 * 2026-06-07 fix) — see `CodexCriticAdapter.run` for the exact ordering.
 */
export interface CriticResult {
  verdict: Verdict | null;
  rateLimited: boolean;
  /** Token total of the codex call, parsed best-effort from its bare
   *  `tokens used\n<N>` stdout line. Omitted (never explicit `undefined`) when the
   *  line is absent, or when the call was skipped entirely (empty-diff pass-through). */
  usage?: CriticUsage;
}

export interface CriticRunInput {
  diff: string;
  runtimeDir: string;
  workerReportPath: string | null;
}

export interface CriticAdapter {
  run(input: CriticRunInput): Promise<CriticResult>;
}
