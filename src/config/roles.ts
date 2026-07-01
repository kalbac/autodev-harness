import type { HarnessConfig } from "./schema.js";

export interface AdapterMeta {
  defaultExe: string;
  family: string;
}

// Known adapters for the MVP. Unknown ids fall back to using the id itself as both
// exe and family (never crash on a novel adapter id — exe can still be overridden
// per role via `exe:`).
const KNOWN: Record<string, AdapterMeta> = {
  claude: { defaultExe: "claude", family: "claude" },
  codex: { defaultExe: "codex", family: "codex" },
};

export function adapterMeta(id: string): AdapterMeta {
  return KNOWN[id] ?? { defaultExe: id, family: id };
}

export function resolveWorkerExe(cfg: HarnessConfig): string {
  return cfg.roles.worker.exe ?? adapterMeta(cfg.roles.worker.adapter).defaultExe;
}

export function resolveCriticExe(cfg: HarnessConfig): string {
  return cfg.roles.critic.exe ?? adapterMeta(cfg.roles.critic.adapter).defaultExe;
}

// policy.heterogeneity: return a one-element warning array when policy is "warn"
// AND the worker and critic resolve to the SAME adapter family; else [].
export function heterogeneityWarnings(cfg: HarnessConfig): string[] {
  if (cfg.policy.heterogeneity !== "warn") return [];
  const wf = adapterMeta(cfg.roles.worker.adapter).family;
  const cf = adapterMeta(cfg.roles.critic.adapter).family;
  if (wf === cf) {
    return [
      `heterogeneity policy: worker and critic share the same adapter family '${wf}' — an independent critic is load-bearing (parity spec §9); consider a different critic adapter`,
    ];
  }
  return [];
}

// MVP: only these role→adapter combos have a live adapter implementation.
// A config may DECLARE any adapter id, but the daemon can only INSTANTIATE
// a registered one. Fail LOUD at wire time on an unregistered worker/critic
// adapter, listing what IS supported. orchestrator/planner are NOT checked
// (no live adapter in P1 — orchestrator lands in 3b, planner is reserved).
const WORKER_ADAPTERS = new Set(["claude"]);
const CRITIC_ADAPTERS = new Set(["codex"]);

export function assertKnownAdapters(cfg: HarnessConfig): void {
  if (!WORKER_ADAPTERS.has(cfg.roles.worker.adapter)) {
    throw new Error(
      `no worker adapter registered for '${cfg.roles.worker.adapter}' (MVP supports: ${[...WORKER_ADAPTERS].join(", ")})`,
    );
  }
  if (!CRITIC_ADAPTERS.has(cfg.roles.critic.adapter)) {
    throw new Error(
      `no critic adapter registered for '${cfg.roles.critic.adapter}' (MVP supports: ${[...CRITIC_ADAPTERS].join(", ")})`,
    );
  }
}
