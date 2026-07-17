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
});
