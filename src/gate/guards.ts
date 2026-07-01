/**
 * Pure guard-table parser + per-value/per-zone selectors — parity with the
 * `gate.ps1` guard bookkeeping. This module never touches the filesystem:
 * loading `GUARDS.md` and the recipe JSON files it points to is owned by
 * `gate.ts` (a later task), which builds `GuardRecipePair[]` in memory and
 * passes them into the selectors below. Keeping this fs-free is what makes
 * the per-value coverage logic unit-testable without disk.
 */

/** One row of the `GUARDS.md` pipe table. */
export interface GuardRow {
  contract_id: string;
  contract_value: string;
  guard_test: string;
  recipe: string;
  mutation_verified: string;
  blessed_by: string;
  date: string;
}

/** The recipe JSON a guard points to (loaded by gate.ts, not here). All fields optional — selectors tolerate absence. */
export interface GuardRecipe {
  zone_id?: string;
  contract_id?: string;
  file?: string;
  locator?: string;
  canonical_value?: string;
  mutated_value?: string;
  guard_test?: string;
}

/** A guard row paired with its (already-loaded) recipe JSON. */
export interface GuardRecipePair {
  guard: GuardRow;
  recipe: GuardRecipe;
}

/** Parse the 7-column GUARDS.md pipe table into rows. Parity: gate.ps1 Get-AutodevGuards. */
export function parseGuardsTable(markdown: string): GuardRow[] {
  const rows: GuardRow[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) {
      continue;
    }

    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 8) {
      continue;
    }

    const id = cells[1]!;
    if (id === "contract_id" || /^-+$/.test(id)) {
      continue;
    }

    rows.push({
      contract_id: id,
      contract_value: cells[2]!.replaceAll("`", ""),
      guard_test: cells[3]!.replaceAll("`", ""),
      recipe: cells[4]!.replaceAll("`", ""),
      mutation_verified: cells[5]!,
      blessed_by: cells[6]!,
      date: cells[7]!,
    });
  }

  return rows;
}

/** mutation_verified cell starts with "yes" (real value: "yes (red on flip)"). Parity: gate.ps1 `-notmatch '^yes'`. */
export function isMutationVerified(guard: GuardRow): boolean {
  return /^yes/i.test(guard.mutation_verified);
}

/** blessed_by is a real operator, not empty and not 'pending-operator'. Parity: gate.ps1 Test-AutodevGuardBlessed. */
export function isBlessed(guard: GuardRow): boolean {
  return guard.blessed_by !== "pending-operator" && guard.blessed_by !== "";
}

/** PER-VALUE match: the guard whose recipe.canonical_value EXACTLY equals value, or null. Parity: Select-AutodevGuardForValue. */
export function selectGuardForValue(pairs: GuardRecipePair[], value: string): GuardRow | null {
  for (const pair of pairs) {
    if (pair.recipe.canonical_value === value) {
      return pair.guard;
    }
  }
  return null;
}

/** Fallback zone-level match: recipe.zone_id === zoneId, or null. Parity: Select-AutodevGuardForZone. */
export function selectGuardForZone(pairs: GuardRecipePair[], zoneId: string): GuardRow | null {
  for (const pair of pairs) {
    if (pair.recipe.zone_id === zoneId) {
      return pair.guard;
    }
  }
  return null;
}
