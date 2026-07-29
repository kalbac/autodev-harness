import { describe, it, expect } from "vitest";
import { HarnessConfigSchema } from "../config/schema.js";
import { buildProjectGuaranteesView } from "./guarantees-view.js";
import type { Invariants } from "../gate/invariants.js";

/** A full-shape MACHINE-INVARIANTS zone (see `gate/invariants.ts`'s ContractZoneSchema). */
function zone(id: string, overrides: Partial<Invariants["contract_zones"][number]> = {}): Invariants["contract_zones"][number] {
  return {
    id,
    why: "test why",
    auto_guardable: true,
    path_globs: ["src/**"],
    grep_patterns: ["foo.*bar"],
    exact_strings: ["value-x"],
    ...overrides,
  };
}

const READABLE_WITH_ZONE = {
  readable: true as const,
  invariants: {
    version: 1,
    updated: "2026-01-01",
    contract_zones: [zone("zone-x")],
    constitution: { path_globs: ["ci.yml"] },
  },
};

const READABLE_ZERO_ZONES = {
  readable: true as const,
  invariants: {
    version: 1,
    updated: "2026-01-01",
    contract_zones: [],
    constitution: { path_globs: [] },
  },
};

const UNREADABLE = { readable: false as const };

describe("buildProjectGuaranteesView", () => {
  it("projects branchPattern from config", () => {
    const cfg = HarnessConfigSchema.parse({ allowedBranchPattern: "^feature/" });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.branchPattern).toBe("^feature/");
  });

  it("projects a zone's full shape (why/pathGlobs/namedValues/namedPatterns/autoGuardable)", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectGuaranteesView(cfg, READABLE_WITH_ZONE, null, []);
    expect(view.contract.invariantsReadable).toBe(true);
    expect(view.contract.zones).toEqual([
      {
        id: "zone-x",
        why: "test why",
        pathGlobs: ["src/**"],
        namedValues: ["value-x"],
        namedPatterns: ["foo.*bar"],
        autoGuardable: true,
      },
    ]);
    expect(view.contract.constitutionGlobs).toEqual(["ci.yml"]);
  });

  it("projects a zone's why as '' verbatim when the file declares it empty", () => {
    const cfg = HarnessConfigSchema.parse({});
    const withEmptyWhy = {
      readable: true as const,
      invariants: { ...READABLE_WITH_ZONE.invariants, contract_zones: [zone("zone-x", { why: "" })] },
    };
    const view = buildProjectGuaranteesView(cfg, withEmptyWhy, null, []);
    expect(view.contract.zones[0]?.why).toBe("");
  });

  it("invariantsReadable: false AND zones: [] when the file could not be read/parsed at all", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.contract.invariantsReadable).toBe(false);
    expect(view.contract.zones).toEqual([]);
    expect(view.contract.constitutionGlobs).toEqual([]);
  });

  it("invariantsReadable: true with zones: [] for a VALID file that declares zero zones -- distinct from the unreadable case", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectGuaranteesView(cfg, READABLE_ZERO_ZONES, null, []);
    expect(view.contract.invariantsReadable).toBe(true);
    expect(view.contract.zones).toEqual([]);
  });

  it("projects the declared invariants file path verbatim from config", () => {
    const cfg = HarnessConfigSchema.parse({ contract: { invariantsFile: "custom/INVARIANTS.md" } });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.contract.invariantsFile).toBe("custom/INVARIANTS.md");
  });

  it("projects contract.protectedPaths and docPaths from config.contract", () => {
    const cfg = HarnessConfigSchema.parse({
      contract: { constitutionPaths: ["ci.yml", "GUARDS.md"], docPaths: ["docs/**"] },
    });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.contract.protectedPaths).toEqual(["ci.yml", "GUARDS.md"]);
    expect(view.contract.docPaths).toEqual(["docs/**"]);
  });

  it("copies contract arrays instead of aliasing the loaded config", () => {
    const cfg = HarnessConfigSchema.parse({ contract: { docPaths: ["docs/**"] } });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    view.contract.docPaths.push("evil/**");
    expect(cfg.contract.docPaths).toEqual(["docs/**"]);
  });

  it("projects profile: null when no profile is attached", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.checks.profile).toBeNull();
  });

  it("projects the attached profile's gates and protectedPaths", () => {
    const cfg = HarnessConfigSchema.parse({});
    const profile = {
      id: "wordpress-woocommerce",
      version: 1,
      gates: [
        {
          id: "phpcs",
          run: "vendor/bin/phpcs --standard=/p/gates/phpcs.xml {files}",
          filesGlob: "**/*.php",
          ruleset: "gates/phpcs.xml",
          rulesetSource: "profile" as const,
        },
        {
          id: "composer-validate",
          run: "composer validate",
          filesGlob: null,
          ruleset: null,
          rulesetSource: "profile" as const,
        },
      ],
      protectedPaths: ["phpcs.xml"],
    };
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, profile, []);
    expect(view.checks.profile).toEqual({
      id: "wordpress-woocommerce",
      version: 1,
      gates: [
        {
          id: "phpcs",
          run: "vendor/bin/phpcs --standard=/p/gates/phpcs.xml {files}",
          filesGlob: "**/*.php",
          ruleset: "gates/phpcs.xml",
          rulesetSource: "profile",
        },
        // `rulesetSource` FOLDS TO NULL here, even though the source object
        // carries the inert `"profile"` placeholder `ResolvedGate` always sets
        // for a gate with no `ruleset:` key. Projecting the placeholder would
        // assert "this gate's standard came from the profile" about a gate that
        // has no standard at all — the dishonest-projection shape this file's
        // `invariantsReadable` tri-state already exists to prevent.
        { id: "composer-validate", run: "composer validate", filesGlob: null, ruleset: null, rulesetSource: null },
      ],
      protectedPaths: ["phpcs.xml"],
    });
  });

  it("reports a PROJECT-declared ruleset as such, so the screen never presents the project's own bar as the harness's (adr/010)", () => {
    const cfg = HarnessConfigSchema.parse({});
    const view = buildProjectGuaranteesView(
      cfg,
      UNREADABLE,
      {
        id: "wordpress-woocommerce",
        version: 3,
        gates: [
          {
            id: "phpcs",
            run: "vendor/bin/phpcs --standard=/repo/phpcs.xml.dist {files}",
            filesGlob: "**/*.php",
            ruleset: "phpcs.xml.dist",
            rulesetSource: "project" as const,
          },
        ],
        protectedPaths: [],
      },
      [],
    );
    expect(view.checks.profile?.gates[0]).toEqual({
      id: "phpcs",
      run: "vendor/bin/phpcs --standard=/repo/phpcs.xml.dist {files}",
      filesGlob: "**/*.php",
      ruleset: "phpcs.xml.dist",
      rulesetSource: "project",
    });
  });

  it("projects gate.checkCommand, successCommands (as taskCommands) and agentCi", () => {
    const cfg = HarnessConfigSchema.parse({
      gate: {
        checkCommand: "npm test",
        successCommands: ["composer check"],
        agentCi: { enabled: true, workflows: ["ci.yml"] },
      },
    });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.checks.checkCommand).toBe("npm test");
    expect(view.checks.taskCommands).toEqual(["composer check"]);
    expect(view.checks.agentCi).toEqual({ enabled: true, workflows: ["ci.yml"] });
  });

  it("packageScripts: null means unreadable/malformed, distinct from []", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(buildProjectGuaranteesView(cfg, UNREADABLE, null, null).checks.packageScripts).toBeNull();
    expect(buildProjectGuaranteesView(cfg, UNREADABLE, null, []).checks.packageScripts).toEqual([]);
    expect(buildProjectGuaranteesView(cfg, UNREADABLE, null, ["lint", "build"]).checks.packageScripts).toEqual([
      "lint",
      "build",
    ]);
  });

  it("projects review.adapter/model/effort from roles.critic", () => {
    const cfg = HarnessConfigSchema.parse({ roles: { critic: { adapter: "codex", model: "gpt-5.6-luna", effort: "high" } } });
    const view = buildProjectGuaranteesView(cfg, UNREADABLE, null, []);
    expect(view.review).toEqual({ adapter: "codex", model: "gpt-5.6-luna", effort: "high", mandateNarrows: false });
  });

  it("mandateNarrows is true exactly when docPaths is non-empty (adr/007)", () => {
    const withDocs = HarnessConfigSchema.parse({ contract: { docPaths: ["docs/**"] } });
    const withoutDocs = HarnessConfigSchema.parse({});
    expect(buildProjectGuaranteesView(withDocs, UNREADABLE, null, []).review.mandateNarrows).toBe(true);
    expect(buildProjectGuaranteesView(withoutDocs, UNREADABLE, null, []).review.mandateNarrows).toBe(false);
  });

  it("projects onFailure.maxAttempts from loop.maxAttempts", () => {
    const cfg = HarnessConfigSchema.parse({ loop: { maxAttempts: 5 } });
    expect(buildProjectGuaranteesView(cfg, UNREADABLE, null, []).onFailure).toEqual({ maxAttempts: 5 });
  });

  it("projects autonomy.overnightOptIn from autonomy.overnight.enabled", () => {
    const enabled = HarnessConfigSchema.parse({ autonomy: { overnight: { enabled: true } } });
    const disabled = HarnessConfigSchema.parse({});
    expect(buildProjectGuaranteesView(enabled, UNREADABLE, null, []).autonomy).toEqual({ overnightOptIn: true });
    expect(buildProjectGuaranteesView(disabled, UNREADABLE, null, []).autonomy).toEqual({ overnightOptIn: false });
  });
});
