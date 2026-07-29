import { describe, it, expect } from "vitest";
import { HarnessConfigSchema } from "./schema.js";

describe("HarnessConfigSchema", () => {
  it("defaults autonomy.overnight to inert (disabled, budget 2)", () => {
    const cfg = HarnessConfigSchema.parse({});
    expect(cfg.autonomy.overnight.enabled).toBe(false);
    expect(cfg.autonomy.overnight.maxAutoReworks).toBe(2);
  });

  it("accepts an explicit autonomy.overnight block", () => {
    const cfg = HarnessConfigSchema.parse({ autonomy: { overnight: { enabled: true, maxAutoReworks: 3 } } });
    expect(cfg.autonomy.overnight.enabled).toBe(true);
    expect(cfg.autonomy.overnight.maxAutoReworks).toBe(3);
  });

  it("defaults contract.docPaths to empty -- adr/007 leniency is opt-in per project", () => {
    // The default has to reproduce the pre-adr/007 gate exactly. A project that never
    // declares a doc path must see no change in what the critic accepts.
    const cfg = HarnessConfigSchema.parse({});
    expect(cfg.contract.docPaths).toEqual([]);
  });

  it("keeps the other contract fields defaulted when only docPaths is given", () => {
    // `contract` is a single zod object with one `.default(...)`, so a partial block is
    // the shape most likely to silently drop a sibling field
    // (docs/gotchas/zod-strip-unknown-keys-silent-config-revert.md is the same family).
    const cfg = HarnessConfigSchema.parse({ contract: { docPaths: ["docs/**"] } });
    expect(cfg.contract.docPaths).toEqual(["docs/**"]);
    expect(cfg.contract.constitutionPaths).toEqual([]);
    expect(cfg.contract.invariantsFile).toBe("INVARIANTS.md");
    expect(cfg.contract.guardsFile).toBe("GUARDS.md");
  });

  it("defaults contract.gateRulesets to {} -- adr/010 override is opt-in per project", () => {
    // Byte-identical to pre-adr/010 behaviour for a project that declares nothing:
    // every gate resolves its own profile-declared default ruleset.
    const cfg = HarnessConfigSchema.parse({});
    expect(cfg.contract.gateRulesets).toEqual({});
  });

  it("accepts a populated gateRulesets map and keeps sibling contract fields defaulted", () => {
    const cfg = HarnessConfigSchema.parse({ contract: { gateRulesets: { phpcs: "phpcs.xml.dist" } } });
    expect(cfg.contract.gateRulesets).toEqual({ phpcs: "phpcs.xml.dist" });
    expect(cfg.contract.docPaths).toEqual([]);
    expect(cfg.contract.constitutionPaths).toEqual([]);
  });

  it("rejects a non-string value in gateRulesets", () => {
    expect(() => HarnessConfigSchema.parse({ contract: { gateRulesets: { phpcs: 42 } } })).toThrow();
  });
});

describe("gate.successCommands (s61 — the operator's command allowlist)", () => {
  it("defaults to an empty allowlist", () => {
    expect(HarnessConfigSchema.parse({}).gate.successCommands).toEqual([]);
  });

  it("defaults to an empty allowlist when `gate` is present but the key is not", () => {
    // The nested-default path: a config that sets only `checkCommand` must still
    // get a real `successCommands` array, not `undefined`.
    const cfg = HarnessConfigSchema.parse({ gate: { checkCommand: "composer check" } });
    expect(cfg.gate.successCommands).toEqual([]);
  });

  it("accepts the operator's declared commands", () => {
    const cfg = HarnessConfigSchema.parse({ gate: { successCommands: ["php -l src/x.php", "composer check"] } });
    expect(cfg.gate.successCommands).toEqual(["php -l src/x.php", "composer check"]);
  });

  it("rejects a non-string entry", () => {
    expect(() => HarnessConfigSchema.parse({ gate: { successCommands: [42] } })).toThrow();
  });

  it("keeps the root schema STRICT (an unknown top-level key still fails loudly)", () => {
    // gotcha `[config/zod-strict]` — adding a nested field must not weaken this.
    expect(() => HarnessConfigSchema.parse({ successCommands: [] })).toThrow();
  });
});
