import { z } from "zod";
import { globMatch } from "../util/glob.js";

/**
 * Machine-readable invariants types + gate helpers — parity spec §3
 * (MACHINE-INVARIANTS block shape) and §4 (contract-zone touch detection,
 * ported from `_common.ps1`).
 */

const ContractZoneSchema = z
  .object({
    id: z.string(),
    why: z.string(),
    auto_guardable: z.boolean(),
    path_globs: z.array(z.string()),
    grep_patterns: z.array(z.string()),
    exact_strings: z.array(z.string()),
  })
  .strict();

const ConstitutionSchema = z
  .object({
    why: z.string().optional(),
    path_globs: z.array(z.string()),
  })
  .strict();

const InvariantsSchema = z
  .object({
    version: z.number(),
    updated: z.string(),
    contract_zones: z.array(ContractZoneSchema),
    constitution: ConstitutionSchema,
  })
  .strict();

/**
 * Types are derived from the zod schemas (single source of truth). Under
 * `exactOptionalPropertyTypes`, an inferred optional field like
 * `constitution.why` is `string | undefined` — deriving avoids drift between
 * a hand-written interface and the validator that actually produces the value.
 */
export type ContractZone = z.infer<typeof ContractZoneSchema>;
export type Constitution = z.infer<typeof ConstitutionSchema>;
export type Invariants = z.infer<typeof InvariantsSchema>;

const BEGIN_MARKER = "<!-- BEGIN MACHINE-INVARIANTS -->";
const END_MARKER = "<!-- END MACHINE-INVARIANTS -->";

/**
 * Parse the fenced JSON between the MACHINE-INVARIANTS markers. Parity: the
 * `docs/reference` MACHINE-INVARIANTS block consumed by the gate scripts.
 * Throws (unlike `parseVerdict`, which returns null) because a malformed
 * invariants file is a hard configuration error, not a tolerable LLM slip.
 */
export function parseInvariants(markdown: string): Invariants {
  const beginIdx = markdown.indexOf(BEGIN_MARKER);
  const endIdx = markdown.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error("parseInvariants: missing BEGIN/END MACHINE-INVARIANTS markers");
  }

  const inner = markdown.slice(beginIdx + BEGIN_MARKER.length, endIdx).trim();

  const fenceMatch = /^```json\s*([\s\S]*?)\s*```$/.exec(inner);
  const jsonText = fenceMatch ? fenceMatch[1]! : inner;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`parseInvariants: invalid JSON between markers: ${(err as Error).message}`);
  }

  const result = InvariantsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`parseInvariants: schema mismatch: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Only +/- content lines from a unified diff (excludes the +++/--- file
 * headers). Parity: `_common.ps1 Get-GitDiffAddedRemovedLines`.
 */
export function diffAddedRemovedLines(diffText: string): string[] {
  const lines: string[] = [];
  for (const l of diffText.split(/\r?\n/)) {
    if (/^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)) {
      lines.push(l);
    }
  }
  return lines;
}

/**
 * Does the change touch this zone? Parity: `_common.ps1 Test-ZoneTouched`.
 *
 * Deliberate PS-parity quirk: PowerShell's `-match` (regex) and `-like`
 * (wildcard/contains) operators are CASE-INSENSITIVE by default, so both
 * the grep_patterns and exact_strings checks below are case-insensitive —
 * this is a faithful replication of the original gate behavior, not a bug.
 */
export function zoneTouched(zone: ContractZone, changedFiles: string[], diffLines: string[]): boolean {
  if (zone.path_globs.length > 0) {
    for (const f of changedFiles) {
      for (const glob of zone.path_globs) {
        if (globMatch(glob, f)) {
          return true;
        }
      }
    }
  }

  for (const l of diffLines) {
    for (const pat of zone.grep_patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pat, "i");
      } catch {
        // A malformed pattern must not crash the gate — treat as no match.
        continue;
      }
      if (re.test(l)) {
        return true;
      }
    }
    const lowerLine = l.toLowerCase();
    for (const s of zone.exact_strings) {
      if (lowerLine.includes(s.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Which of the zone's exact_strings actually appear in the +/- diff lines.
 * Parity: `_common.ps1 Get-AutodevZoneTouchedStrings`.
 *
 * CONTRAST with `zoneTouched`: this uses PS `.Contains`, which is
 * CASE-SENSITIVE — unlike `zoneTouched`'s case-insensitive `-like` check.
 * This asymmetry is real in the PS source and load-bearing: per-value
 * coverage reporting keys on exact casing while the boolean "was this zone
 * touched at all" gate is intentionally more lenient.
 */
export function zoneTouchedStrings(zone: ContractZone, diffLines: string[]): string[] {
  const found: string[] = [];
  for (const s of zone.exact_strings) {
    if (s === "") {
      continue;
    }
    for (const l of diffLines) {
      if (l.includes(s)) {
        found.push(s);
        break;
      }
    }
  }
  return found;
}
