import { describe, it, expect } from "vitest";
import {
  parseInvariants,
  diffAddedRemovedLines,
  zoneTouched,
  zoneTouchedStrings,
} from "./invariants.js";
import type { ContractZone } from "./invariants.js";

const SAMPLE_MARKDOWN = `# Some Doc

Intro text here.

<!-- BEGIN MACHINE-INVARIANTS -->
\`\`\`json
{
  "version": 1,
  "updated": "2026-01-01",
  "contract_zones": [
    {
      "id": "shipping-method",
      "why": "shipping method contract must not silently change",
      "auto_guardable": true,
      "path_globs": ["woodev/shipping-method/**"],
      "grep_patterns": ["shipping_method_id"],
      "exact_strings": ["woocommerce_edostavka_settings", "wc_edostavka_webhook_ids"]
    },
    {
      "id": "billing",
      "why": "billing invariants",
      "auto_guardable": false,
      "path_globs": [],
      "grep_patterns": [],
      "exact_strings": []
    }
  ],
  "constitution": {
    "why": "core rules",
    "path_globs": ["docs/**"]
  }
}
\`\`\`
<!-- END MACHINE-INVARIANTS -->

Trailing text here.
`;

describe("parseInvariants", () => {
  it("parses a realistic markdown blob into a typed Invariants object", () => {
    const result = parseInvariants(SAMPLE_MARKDOWN);
    expect(result.version).toBe(1);
    expect(result.updated).toBe("2026-01-01");
    expect(result.contract_zones).toHaveLength(2);
    expect(result.contract_zones[0]).toEqual({
      id: "shipping-method",
      why: "shipping method contract must not silently change",
      auto_guardable: true,
      path_globs: ["woodev/shipping-method/**"],
      grep_patterns: ["shipping_method_id"],
      exact_strings: ["woocommerce_edostavka_settings", "wc_edostavka_webhook_ids"],
    });
    expect(result.constitution).toEqual({
      why: "core rules",
      path_globs: ["docs/**"],
    });
  });

  it("throws when the BEGIN/END markers are missing", () => {
    expect(() => parseInvariants("# Doc with no markers at all")).toThrow();
  });

  it("throws when the JSON between the markers is malformed", () => {
    const bad = `<!-- BEGIN MACHINE-INVARIANTS -->
\`\`\`json
{ this is not valid json
\`\`\`
<!-- END MACHINE-INVARIANTS -->`;
    expect(() => parseInvariants(bad)).toThrow();
  });

  it("throws when the JSON fails schema validation", () => {
    const badSchema = `<!-- BEGIN MACHINE-INVARIANTS -->
\`\`\`json
{ "version": 1, "updated": "2026-01-01" }
\`\`\`
<!-- END MACHINE-INVARIANTS -->`;
    expect(() => parseInvariants(badSchema)).toThrow();
  });
});

describe("diffAddedRemovedLines", () => {
  it("returns only +added and -removed content lines, excluding +++/--- headers and context", () => {
    const diff = [
      "diff --git a/x b/x",
      "index 111..222 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,3 +1,3 @@",
      " context line unchanged",
      "-removed line",
      "+added line",
      " another context line",
    ].join("\n");

    expect(diffAddedRemovedLines(diff)).toEqual(["-removed line", "+added line"]);
  });

  it("returns an empty array when there are no +/- content lines", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", " unchanged"].join("\n");
    expect(diffAddedRemovedLines(diff)).toEqual([]);
  });
});

describe("zoneTouched", () => {
  const zone: ContractZone = {
    id: "shipping-method",
    why: "shipping method contract",
    auto_guardable: true,
    path_globs: ["woodev/shipping-method/**"],
    grep_patterns: ["shipping_method_id"],
    exact_strings: ["edostavka"],
  };

  it("returns true when a changed file matches a path_glob", () => {
    expect(zoneTouched(zone, ["woodev/shipping-method/class-foo.php"], [])).toBe(true);
  });

  it("returns true when a diff line matches a grep_pattern", () => {
    expect(zoneTouched(zone, [], ["+$shipping_method_id = get_id();"])).toBe(true);
  });

  it("returns true when a diff line contains an exact_string", () => {
    expect(zoneTouched(zone, [], ["+// edostavka handling"])).toBe(true);
  });

  it("matches exact_strings case-insensitively (PS -like parity)", () => {
    expect(zoneTouched(zone, [], ["+// EDOSTAVKA handling"])).toBe(true);
  });

  it("matches grep_patterns case-insensitively (PS -match parity)", () => {
    expect(zoneTouched(zone, [], ["+$SHIPPING_METHOD_ID = get_id();"])).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(zoneTouched(zone, ["src/unrelated.ts"], ["+nothing relevant here"])).toBe(false);
  });

  it("does not throw when a grep_pattern is malformed regex", () => {
    const brokenZone: ContractZone = {
      ...zone,
      grep_patterns: ["("],
    };
    expect(() => zoneTouched(brokenZone, [], ["+some line"])).not.toThrow();
    expect(zoneTouched(brokenZone, [], ["+some line"])).toBe(false);
  });
});

describe("zoneTouchedStrings", () => {
  it("returns only the enumerated values actually present, order preserved", () => {
    const zone: ContractZone = {
      id: "z",
      why: "w",
      auto_guardable: true,
      path_globs: [],
      grep_patterns: [],
      exact_strings: ["alpha", "beta", "gamma"],
    };
    const diffLines = ["+something with beta inside", "+and gamma too"];
    expect(zoneTouchedStrings(zone, diffLines)).toEqual(["beta", "gamma"]);
  });

  it("is case-sensitive (PS .Contains parity) — differently-cased line does not match", () => {
    const zone: ContractZone = {
      id: "z",
      why: "w",
      auto_guardable: true,
      path_globs: [],
      grep_patterns: [],
      exact_strings: ["Alpha"],
    };
    expect(zoneTouchedStrings(zone, ["+alpha lowercase only"])).toEqual([]);
  });

  it("returns an empty array when none are present", () => {
    const zone: ContractZone = {
      id: "z",
      why: "w",
      auto_guardable: true,
      path_globs: [],
      grep_patterns: [],
      exact_strings: ["nope"],
    };
    expect(zoneTouchedStrings(zone, ["+irrelevant line"])).toEqual([]);
  });

  it("matches the PS self-test case 5: only the second value is present", () => {
    const zone: ContractZone = {
      id: "wc-edostavka",
      why: "settings/webhook contract",
      auto_guardable: true,
      path_globs: [],
      grep_patterns: [],
      exact_strings: ["woocommerce_edostavka_settings", "wc_edostavka_webhook_ids"],
    };
    const diffLines = ["+        get_option( 'wc_edostavka_webhook_ids' )"];
    expect(zoneTouchedStrings(zone, diffLines)).toEqual(["wc_edostavka_webhook_ids"]);
  });
});
