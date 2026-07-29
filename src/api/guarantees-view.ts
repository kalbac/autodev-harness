import type { HarnessConfig } from "../config/schema.js";
import type { Invariants } from "../gate/invariants.js";
import type { ProjectGuaranteesView } from "./server.js";

/**
 * Pure projection: a validated `HarnessConfig` + the already-resolved trusted-root
 * reads (invariants, attached profile, package.json scripts) -> the read-only
 * `ProjectGuaranteesView` for `GET /projects/:id/guarantees` (#138). Mirrors
 * `buildProjectConfigView`'s split -- the ASYNC trusted-root I/O
 * (`readInvariantsForGuarantees`/`readPackageScripts`, both in
 * `src/composition/root.ts`, adr/006 Phase 1) stays in the composition root; this
 * function is the deterministic mapping step, directly unit-testable without
 * spinning up a full `ProjectRoot` (which spawns real worker/critic adapters).
 *
 * `invResult` is a TRI-STATE, not a boolean flag folded into `zones`
 * (`docs/gotchas/boolean-whose-no-means-two-things.md`): `{ readable: false }`
 * means the invariants file could not be read or parsed at all (absent, escaped
 * the trusted root, or malformed) and must project `zones: []` for the SAME reason
 * as an absent file, never as "declared, zero zones" -- that is a real, different
 * answer this function only emits when `invResult.readable` is actually `true`.
 *
 * `profile` accepts a structural subset of `ResolvedProfile` (id/version/gates/
 * protectedPaths) so this module never needs to import `profile/schema.ts` --
 * `src/composition/root.ts` passes its already-loaded `ResolvedProfile` straight
 * through, which is structurally compatible (extra fields on the source value are
 * fine; TS only rejects excess properties on fresh object LITERALS).
 */
export function buildProjectGuaranteesView(
  cfg: HarnessConfig,
  invResult: { readable: true; invariants: Invariants } | { readable: false },
  profile: {
    id: string;
    version: number;
    gates: Array<{
      id: string;
      run: string;
      filesGlob: string | null;
      ruleset: string | null;
      rulesetSource: "profile" | "project";
    }>;
    protectedPaths: string[];
  } | null,
  packageScripts: string[] | null,
): ProjectGuaranteesView {
  return {
    branchPattern: cfg.allowedBranchPattern,
    contract: {
      invariantsFile: cfg.contract.invariantsFile,
      invariantsReadable: invResult.readable,
      zones: invResult.readable
        ? invResult.invariants.contract_zones.map((z) => ({
            id: z.id,
            why: z.why,
            pathGlobs: [...z.path_globs],
            namedValues: [...z.exact_strings],
            namedPatterns: [...z.grep_patterns],
            autoGuardable: z.auto_guardable,
          }))
        : [],
      constitutionGlobs: invResult.readable ? [...invResult.invariants.constitution.path_globs] : [],
      // Copied, not aliased -- same rule `buildProjectConfigView` follows for its
      // own `contract` arrays: a JSON-serializing consumer must never be able to
      // mutate the live config through the view.
      protectedPaths: [...cfg.contract.constitutionPaths],
      docPaths: [...cfg.contract.docPaths],
    },
    checks: {
      profile:
        profile === null
          ? null
          : {
              id: profile.id,
              version: profile.version,
              // `rulesetSource` is folded to null exactly when `ruleset` is null,
              // rather than passed through as the inert `"profile"` placeholder
              // `ResolvedGate` carries for a gate that declares no ruleset at all
              // (see its field docs). Projecting that placeholder would state
              // "this gate's standard came from the profile" about a gate that
              // has no standard to speak of -- the same class of dishonest
              // projection as folding "contract file unreadable" into "zero
              // zones", which `invResult`'s tri-state above exists to prevent
              // (`docs/gotchas/boolean-whose-no-means-two-things.md`).
              gates: profile.gates.map((g) => ({
                id: g.id,
                run: g.run,
                filesGlob: g.filesGlob,
                ruleset: g.ruleset,
                rulesetSource: g.ruleset === null ? null : g.rulesetSource,
              })),
              protectedPaths: [...profile.protectedPaths],
            },
      checkCommand: cfg.gate.checkCommand,
      agentCi: { enabled: cfg.gate.agentCi.enabled, workflows: [...cfg.gate.agentCi.workflows] },
      taskCommands: [...cfg.gate.successCommands],
      packageScripts: packageScripts === null ? null : [...packageScripts],
    },
    review: {
      adapter: cfg.roles.critic.adapter,
      model: cfg.roles.critic.model,
      effort: cfg.roles.critic.effort,
      mandateNarrows: cfg.contract.docPaths.length > 0,
    },
    onFailure: { maxAttempts: cfg.loop.maxAttempts },
    autonomy: { overnightOptIn: cfg.autonomy.overnight.enabled },
  };
}
