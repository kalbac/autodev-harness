import type { Task } from "../blackboard/types.js";
import type { HarnessConfig } from "../config/schema.js";

export interface LadderResolution {
  ladder: string[];
  warnings: string[];
}

export interface Router {
  resolveLadder(task: Task): LadderResolution;
}

/**
 * Model ladder resolution — parity spec §7.
 *
 * Priority order:
 * 1. Contract-zone pin wins unconditionally: `[ladder[0]]` (top tier), no
 *    matter what `task.model` says. A mismatched declaration only WARNs.
 * 2. Else if `task.model` is a known ladder tier: cheaper-only sub-ladder
 *    starting at that tier (rate-limit step-downs only ever go cheaper).
 * 3. Else if `task.model` is declared but unknown: WARN + full ladder.
 * 4. Else (no `task.model`): full ladder.
 */
export function createRouter(cfg: HarnessConfig): Router {
  const fullLadder = cfg.worker.ladder;
  const topTier = fullLadder[0];
  if (topTier === undefined) {
    throw new Error("createRouter: cfg.worker.ladder must be non-empty");
  }

  return {
    resolveLadder(task: Task): LadderResolution {
      const warnings: string[] = [];

      if (task.touches_contract_zone) {
        if (task.model !== null && task.model !== topTier) {
          warnings.push(
            `contract-zone task declared model '${task.model}' — pinned to '${topTier}'`,
          );
        }
        return { ladder: [topTier], warnings };
      }

      if (task.model !== null) {
        const idx = fullLadder.indexOf(task.model);
        if (idx !== -1) {
          return { ladder: fullLadder.slice(idx), warnings };
        }
        warnings.push(`declared model '${task.model}' not in ladder — using full ladder`);
        return { ladder: fullLadder.slice(), warnings };
      }

      return { ladder: fullLadder.slice(), warnings };
    },
  };
}
