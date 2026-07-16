import type { EscalationType } from "../escalate/escalate.js";

/** Reason-routing table (spec 2026-07-17). Litmus: "can a re-run with the critic's
 *  feedback plausibly fix this?" -- yes => auto-rework, no => park. Retryable are the
 *  correctness-verdict + circuit-breaker types; everything contract/operator/transient
 *  (constitution, needs-guard, blocked, dirty-file, drift) parks for a morning decision. */
const RETRYABLE: ReadonlySet<EscalationType> = new Set<EscalationType>(["disagreement", "uncertain", "poison"]);

export function isRetryable(type: EscalationType): boolean {
  return RETRYABLE.has(type);
}
