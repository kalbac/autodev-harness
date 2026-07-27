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
});
