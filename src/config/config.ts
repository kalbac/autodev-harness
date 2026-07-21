import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

/**
 * Load `<repoRoot>/.autodev/config.yaml` returning BOTH the schema-validated,
 * defaulted `HarnessConfig` AND the pre-defaults raw YAML object. The raw object
 * is what a caller consults to tell whether an operator EXPLICITLY set a key that
 * the schema would otherwise silently default (e.g. `roles.planner`, which
 * `agentRoleSchema` always fills in) — the parsed config cannot answer that.
 */
export async function loadConfigWithRaw(
  repoRoot: string,
): Promise<{ cfg: HarnessConfig; raw: Record<string, unknown> }> {
  const path = join(repoRoot, ".autodev", "config.yaml");
  let raw: unknown = {};
  if (existsSync(path)) {
    const content = await readFile(path, "utf8");
    // An empty/whitespace-only file means "use defaults". Anything else is passed
    // through as-is so a non-object root (null, array, scalar) fails validation
    // instead of being silently coerced into defaults.
    raw = content.trim() === "" ? {} : parseYaml(content);
  }
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid .autodev/config.yaml: ${issues}`);
  }
  // Validation passed, so the root parsed as an object mapping (or {} for an
  // empty/missing file); a non-object root would have been rejected above.
  const rawObj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { cfg: parsed.data, raw: rawObj };
}

/** Load `<repoRoot>/.autodev/config.yaml`, validate against the schema, apply defaults. */
export async function loadConfig(repoRoot: string): Promise<HarnessConfig> {
  return (await loadConfigWithRaw(repoRoot)).cfg;
}

/**
 * Did the operator EXPLICITLY set `roles.planner` in the raw (pre-defaults) config?
 * The parsed `HarnessConfig` always carries a defaulted `roles.planner`, so only
 * the raw object can answer this — the projection uses it to expose planner only
 * when configured (R1).
 */
export function isPlannerExplicitlyConfigured(raw: Record<string, unknown>): boolean {
  const roles = raw["roles"];
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) return false;
  return (roles as Record<string, unknown>)["planner"] !== undefined;
}

/**
 * Did the operator EXPLICITLY set `contract.invariantsFile`/`contract.guardsFile` in
 * the raw (pre-defaults) config? Mirrors `isPlannerExplicitlyConfigured` — the parsed
 * `HarnessConfig` always defaults BOTH contract file keys (schema.ts), so only the raw
 * object can distinguish "operator configured an oracle file" from "the schema filled
 * in a default". `adr/006` Phase 1's fail-closed loader rule hinges on exactly that
 * distinction: absent + not-configured is legitimate (no oracle declared), absent +
 * configured is a broken operator config that must escalate, not silently read empty.
 */
export function isContractFileConfigured(
  raw: Record<string, unknown>,
  key: "invariantsFile" | "guardsFile",
): boolean {
  const contract = raw["contract"];
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) return false;
  return (contract as Record<string, unknown>)[key] !== undefined;
}

/** Walk up from `start` to the nearest ancestor directory containing one of `markers`. */
export function detectRepoRoot(start: string, markers: string[] = [".git"]): string {
  let cur = start;
  for (;;) {
    if (markers.some((m) => existsSync(join(cur, m)))) return cur;
    const parent = dirname(cur);
    if (parent === cur) throw new Error(`repo root not found from ${start} (markers: ${markers.join(", ")})`);
    cur = parent;
  }
}
