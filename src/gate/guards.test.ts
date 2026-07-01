import { describe, it, expect } from "vitest";
import {
  parseGuardsTable,
  isMutationVerified,
  isBlessed,
  selectGuardForValue,
  selectGuardForZone,
  type GuardRow,
  type GuardRecipePair,
} from "./guards.js";

describe("parseGuardsTable", () => {
  const markdown = `
# GUARDS

| contract_id | contract_value | guard_test | recipe | mutation_verified | blessed_by | date |
|---|---|---|---|---|---|---|
| settings_option_key_edostavka | \`edostavka\` | \`T_edostavka\` | \`recipes/edostavka.json\` | yes (red on flip) | maksim | 2026-01-01 |
| shipping_method_id_edostavka | \`shipping\` | \`T_ship\` | \`recipes/ship.json\` | no | pending-operator | 2026-01-02 |

Some trailing prose that is not a table row.
`;

  it("parses data rows, stripping backticks only from value/test/recipe", () => {
    const rows = parseGuardsTable(markdown);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toEqual<GuardRow>({
      contract_id: "settings_option_key_edostavka",
      contract_value: "edostavka",
      guard_test: "T_edostavka",
      recipe: "recipes/edostavka.json",
      mutation_verified: "yes (red on flip)",
      blessed_by: "maksim",
      date: "2026-01-01",
    });

    expect(rows[1]).toEqual<GuardRow>({
      contract_id: "shipping_method_id_edostavka",
      contract_value: "shipping",
      guard_test: "T_ship",
      recipe: "recipes/ship.json",
      mutation_verified: "no",
      blessed_by: "pending-operator",
      date: "2026-01-02",
    });
  });

  it("skips the header row and the |---| separator row", () => {
    const rows = parseGuardsTable(markdown);
    expect(rows.some((r) => r.contract_id === "contract_id")).toBe(false);
    expect(rows.some((r) => /^-+$/.test(r.contract_id))).toBe(false);
  });

  it("skips lines with fewer than 8 cells and non-table lines", () => {
    const short = "| a | b |\nnot a table line at all\n";
    expect(parseGuardsTable(short)).toEqual([]);
  });

  it("returns an empty array for markdown with no table", () => {
    expect(parseGuardsTable("# just a heading\n\nsome text\n")).toEqual([]);
  });
});

describe("isMutationVerified", () => {
  const base: GuardRow = {
    contract_id: "x",
    contract_value: "x",
    guard_test: "x",
    recipe: "x",
    mutation_verified: "",
    blessed_by: "x",
    date: "x",
  };

  it("true when mutation_verified starts with 'yes'", () => {
    expect(isMutationVerified({ ...base, mutation_verified: "yes (red on flip)" })).toBe(true);
  });

  it("false for empty, 'no', or 'pending'", () => {
    expect(isMutationVerified({ ...base, mutation_verified: "" })).toBe(false);
    expect(isMutationVerified({ ...base, mutation_verified: "no" })).toBe(false);
    expect(isMutationVerified({ ...base, mutation_verified: "pending" })).toBe(false);
  });
});

describe("isBlessed", () => {
  const base: GuardRow = {
    contract_id: "x",
    contract_value: "x",
    guard_test: "x",
    recipe: "x",
    mutation_verified: "x",
    blessed_by: "",
    date: "x",
  };

  it("true for a real operator", () => {
    expect(isBlessed({ ...base, blessed_by: "maksim" })).toBe(true);
  });

  it("false for 'pending-operator' and empty string", () => {
    expect(isBlessed({ ...base, blessed_by: "pending-operator" })).toBe(false);
    expect(isBlessed({ ...base, blessed_by: "" })).toBe(false);
  });
});

describe("selectGuardForValue / selectGuardForZone — PS self-test case 2 (per-value fix)", () => {
  const settingsGuard: GuardRow = {
    contract_id: "settings_option_key_edostavka",
    contract_value: "woocommerce_edostavka_settings",
    guard_test: "T_edostavka",
    recipe: "recipes/settings.json",
    mutation_verified: "yes (red on flip)",
    blessed_by: "maksim",
    date: "2026-01-01",
  };

  const shippingGuard: GuardRow = {
    contract_id: "shipping_method_id_edostavka",
    contract_value: "edostavka",
    guard_test: "T_ship",
    recipe: "recipes/ship.json",
    mutation_verified: "yes (red on flip)",
    blessed_by: "pending-operator",
    date: "2026-01-02",
  };

  const pairs: GuardRecipePair[] = [
    {
      guard: settingsGuard,
      recipe: { zone_id: "option_keys", canonical_value: "woocommerce_edostavka_settings" },
    },
    {
      guard: shippingGuard,
      recipe: { zone_id: "shipping_method_id", canonical_value: "edostavka" },
    },
  ];

  it("selectGuardForValue matches the guard whose recipe.canonical_value equals the value", () => {
    expect(selectGuardForValue(pairs, "woocommerce_edostavka_settings")).toEqual(settingsGuard);
  });

  it("selectGuardForValue returns null for a sibling value in the SAME zone (the fix)", () => {
    expect(selectGuardForValue(pairs, "wc_edostavka_webhook_ids")).toBeNull();
  });

  it("selectGuardForValue returns null for an unrelated value", () => {
    expect(selectGuardForValue(pairs, "nope")).toBeNull();
  });

  it("selectGuardForZone falls back to zone_id match", () => {
    expect(selectGuardForZone(pairs, "option_keys")).toEqual(settingsGuard);
  });

  it("selectGuardForZone returns null for an unknown zone", () => {
    expect(selectGuardForZone(pairs, "no_such_zone")).toBeNull();
  });
});
