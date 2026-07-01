import { describe, it, expect } from "vitest";
import {
  isBlessed,
  selectGuardForValue,
  selectGuardForZone,
  type GuardRow,
  type GuardRecipePair,
} from "./guards.js";
import { zoneTouchedStrings, type ContractZone } from "./invariants.js";

/**
 * Faithful port of the 5 `gate.ps1 -SelfTest` cases (Invoke-GateSelfTest).
 * These are the pure acceptance tests for the per-VALUE guard-coverage fix
 * (parity spec §4 / divergence #2). They drive the SAME selector functions
 * the gate uses, so a regression that re-broadens coverage back to zone-level
 * — the exact over-coverage bug this fix closed — is caught here.
 *
 * Case 2 ("sibling-value uncovered") is the load-bearing one: a different
 * enumerated value in the SAME zone must NOT be auto-covered by another
 * value's guard.
 */

/** Build a full GuardRow; only the fields a given case asserts on need to be meaningful. */
function guard(overrides: Partial<GuardRow>): GuardRow {
  return {
    contract_id: "",
    contract_value: "",
    guard_test: "",
    recipe: "",
    mutation_verified: "yes (red on flip)",
    blessed_by: "",
    date: "",
    ...overrides,
  };
}

// Synthetic guard+recipe pairs, mirroring Invoke-GateSelfTest: one guard on the
// edostavka settings key (blessed), one on a shipping id (pending). Both recipes
// carry a zone_id, so the zone-level fallback can also resolve.
const pairs: GuardRecipePair[] = [
  {
    guard: guard({ contract_id: "settings_option_key_edostavka", guard_test: "T_edostavka", blessed_by: "maksim" }),
    recipe: { zone_id: "option_keys", canonical_value: "woocommerce_edostavka_settings" },
  },
  {
    guard: guard({ contract_id: "shipping_method_id_edostavka", guard_test: "T_ship", blessed_by: "pending-operator" }),
    recipe: { zone_id: "shipping_method_id", canonical_value: "edostavka" },
  },
];

describe("gate.ps1 -SelfTest parity", () => {
  it("case 1: a guarded value resolves to its guard", () => {
    const g = selectGuardForValue(pairs, "woocommerce_edostavka_settings");
    expect(g).not.toBeNull();
    expect(g?.contract_id).toBe("settings_option_key_edostavka");
  });

  it("case 2 (THE FIX): a sibling value in the same zone is NOT auto-covered", () => {
    // 'wc_edostavka_webhook_ids' lives in the same 'option_keys' zone as the
    // guarded settings key, but has no guard of its own -> must be uncovered.
    expect(selectGuardForValue(pairs, "wc_edostavka_webhook_ids")).toBeNull();
  });

  it("case 3: zone-level fallback still resolves (only for path/grep touches with no value)", () => {
    const hit = selectGuardForZone(pairs, "option_keys");
    expect(hit?.contract_id).toBe("settings_option_key_edostavka");
    expect(selectGuardForZone(pairs, "no_such_zone")).toBeNull();
  });

  it("case 4: blessing predicate — operator yes, pending/empty no", () => {
    expect(isBlessed(guard({ blessed_by: "maksim" }))).toBe(true);
    expect(isBlessed(guard({ blessed_by: "pending-operator" }))).toBe(false);
    expect(isBlessed(guard({ blessed_by: "" }))).toBe(false);
  });

  it("case 5: zoneTouchedStrings returns ONLY the enumerated value actually in the diff", () => {
    const zone: ContractZone = {
      id: "option_keys",
      why: "",
      auto_guardable: true,
      path_globs: [],
      grep_patterns: [],
      exact_strings: ["woocommerce_edostavka_settings", "wc_edostavka_webhook_ids"],
    };
    const touched = zoneTouchedStrings(zone, ["+        get_option( 'wc_edostavka_webhook_ids' )"]);
    expect(touched).toEqual(["wc_edostavka_webhook_ids"]);
  });
});
