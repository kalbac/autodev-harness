import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Proves a guard is REAL by mutating the contract it protects and watching
 * the guard test flip GREEN -> RED -> GREEN. Parity: `mutation-check.ps1`
 * `Invoke-MutationCheck`. A guard that stays GREEN under mutation is not
 * protecting anything and must fail this check.
 */
export interface MutationRecipe {
  /** Repo-relative path to the target file. */
  file: string;
  /** Exact substring in the file that carries the canonical value. */
  locator: string;
  canonical_value: string;
  mutated_value: string;
  /** Test identifier passed to the injected runner. */
  guard_test: string;
  zone_id?: string;
  contract_id?: string;
}

/** Runs one guard test. green=true means the test passed. Injected so unit tests need no real subprocess. */
export type GuardTestRunner = (testFile: string) => Promise<{ green: boolean }>;

export interface MutationCheckDeps {
  repoRoot: string;
  runGuardTest: GuardTestRunner;
}

export interface MutationCheckResult {
  pass: boolean;
  /** Populated on failure. */
  reason?: string;
}

/**
 * Parity: `mutation-check.ps1` `Invoke-MutationCheck`. Runs the guard test on
 * the real contract (must be GREEN), literally mutates the recipe's locator
 * in the target file, re-runs the guard (must go RED), restores the
 * original bytes (ALWAYS, even on error), then re-runs the guard once more
 * (must be GREEN again). Returns pass/fail — NEVER leaves the file mutated.
 */
export async function mutationCheck(
  recipe: MutationRecipe,
  deps: MutationCheckDeps,
): Promise<MutationCheckResult> {
  if (
    !recipe.file ||
    !recipe.locator ||
    !recipe.canonical_value ||
    !recipe.mutated_value ||
    !recipe.guard_test
  ) {
    throw new Error(
      "mutationCheck: recipe is missing a required field (file, locator, canonical_value, mutated_value, guard_test)",
    );
  }

  const targetFile = join(deps.repoRoot, recipe.file);
  if (!existsSync(targetFile)) {
    throw new Error(`mutationCheck: target file does not exist: ${targetFile}`);
  }

  const mutatedLine = recipe.locator.replaceAll(recipe.canonical_value, recipe.mutated_value);
  if (mutatedLine === recipe.locator) {
    throw new Error("mutationCheck: canonical_value not found inside locator");
  }

  const originalBytes = await readFile(targetFile);
  let restored = false;

  try {
    const baseline = await deps.runGuardTest(recipe.guard_test);
    if (!baseline.green) {
      return { pass: false, reason: "baseline RED: guard fails on the real contract" };
    }

    const text = originalBytes.toString("utf8");
    if (!text.includes(recipe.locator)) {
      return { pass: false, reason: "locator not found in file (stale recipe)" };
    }

    const mutatedText = text.replaceAll(recipe.locator, mutatedLine);
    await writeFile(targetFile, mutatedText, "utf8");

    const mutResult = await deps.runGuardTest(recipe.guard_test);
    const wentRed = !mutResult.green;

    await writeFile(targetFile, originalBytes);
    restored = true;

    if (!wentRed) {
      return { pass: false, reason: "guard stayed GREEN under mutation — not protecting the contract" };
    }

    const after = await deps.runGuardTest(recipe.guard_test);
    if (!after.green) {
      return { pass: false, reason: "guard RED after revert — revert imperfect" };
    }

    return { pass: true };
  } finally {
    if (!restored) {
      await writeFile(targetFile, originalBytes);
    }
  }
}
