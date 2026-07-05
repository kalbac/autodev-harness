import type { HarnessConfig } from "../config/schema.js";
import { heterogeneityWarnings } from "../config/roles.js";
import type { ProjectConfigView } from "./server.js";

/**
 * Pure projection: a validated `HarnessConfig` -> the read-only
 * `ProjectConfigView` the UI shell renders (top bar + inspector rail).
 *
 * `plannerConfigured` is the RAW-config presence signal (see
 * `isPlannerExplicitlyConfigured`): the parsed `cfg` ALWAYS carries a defaulted
 * `roles.planner`, so it cannot tell us whether the operator actually set it —
 * the caller passes that in. planner is projected ONLY when explicitly
 * configured; its VALUES come from the parsed `cfg` (defaults applied), exactly
 * like orchestrator, with `effort` conditionally spread (exactOptionalPropertyTypes).
 *
 * `policy.heterogeneity` + `heterogeneityWarnings` are exposed read-only so the
 * UI renders exactly what the daemon logs at wire-time (`src/composition/root.ts`),
 * reusing the single `heterogeneityWarnings(cfg)` source of truth (respects
 * `policy=off` -> []).
 */
export function buildProjectConfigView(cfg: HarnessConfig, plannerConfigured: boolean): ProjectConfigView {
  const orch = cfg.roles.orchestrator;
  const planner = cfg.roles.planner;
  return {
    stateDir: cfg.stateDir,
    allowedBranchPattern: cfg.allowedBranchPattern,
    gate: { checkCommand: cfg.gate.checkCommand },
    worktree: { provision: cfg.worktree.provision },
    roles: {
      orchestrator: {
        adapter: orch.adapter,
        model: orch.model,
        ...(orch.effort !== undefined ? { effort: orch.effort } : {}),
      },
      worker: { adapter: cfg.roles.worker.adapter, ladder: cfg.roles.worker.ladder },
      critic: { adapter: cfg.roles.critic.adapter, model: cfg.roles.critic.model, effort: cfg.roles.critic.effort },
      ...(plannerConfigured
        ? {
            planner: {
              adapter: planner.adapter,
              model: planner.model,
              ...(planner.effort !== undefined ? { effort: planner.effort } : {}),
            },
          }
        : {}),
    },
    isolation: {
      worker: {
        cleanRoom: cfg.isolation.worker.cleanRoom,
        mcp: cfg.isolation.worker.mcp,
        skills: cfg.isolation.worker.skills,
      },
    },
    policy: { heterogeneity: cfg.policy.heterogeneity },
    heterogeneityWarnings: heterogeneityWarnings(cfg),
  };
}
