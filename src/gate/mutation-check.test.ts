import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationCheck, type MutationRecipe, type GuardTestRunner } from "./mutation-check.js";

describe("mutationCheck", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function makeTempFile(content: string): Promise<{ repoRoot: string; file: string; fullPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "mutation-check-"));
    tmpDir = dir;
    const file = "target.txt";
    const fullPath = join(dir, file);
    await writeFile(fullPath, content, "utf8");
    return { repoRoot: dir, file, fullPath };
  }

  /** Fake runner: green iff the file on disk still contains the canonical value. */
  function greenIffCanonicalPresent(fullPath: string, canonical: string): GuardTestRunner {
    return async () => {
      const text = await readFile(fullPath, "utf8");
      return { green: text.includes(canonical) };
    };
  }

  it("1. happy path: green -> red -> green, and file is byte-identical afterwards", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file, fullPath } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      locator: "const contract_id = 'canonical_value_1';",
      canonical_value: "canonical_value_1",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    const result = await mutationCheck(recipe, {
      repoRoot,
      runGuardTest: greenIffCanonicalPresent(fullPath, recipe.canonical_value),
    });

    expect(result).toEqual({ pass: true });

    const restoredBytes = await readFile(fullPath);
    expect(restoredBytes.equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("2. guard stays green under mutation (bad guard) -> fails, file restored", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file, fullPath } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      locator: "const contract_id = 'canonical_value_1';",
      canonical_value: "canonical_value_1",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    const alwaysGreen: GuardTestRunner = async () => ({ green: true });

    const result = await mutationCheck(recipe, { repoRoot, runGuardTest: alwaysGreen });

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/stayed GREEN under mutation/i);

    const restoredBytes = await readFile(fullPath);
    expect(restoredBytes.equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("3. baseline red -> fails with baseline reason, file untouched", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file, fullPath } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      locator: "const contract_id = 'canonical_value_1';",
      canonical_value: "canonical_value_1",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    const alwaysRed: GuardTestRunner = async () => ({ green: false });

    const result = await mutationCheck(recipe, { repoRoot, runGuardTest: alwaysRed });

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/baseline RED/i);

    const restoredBytes = await readFile(fullPath);
    expect(restoredBytes.equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("4. stale recipe: locator absent from file -> fails with locator-not-found reason, file restored", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file, fullPath } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      // Not present in the file at all — a stale recipe pointing at a line that moved/changed.
      locator: "const contract_id = 'stale_locator_line';",
      canonical_value: "stale_locator_line",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    // Force baseline to pass regardless of content so we reach the locator check.
    const alwaysGreen: GuardTestRunner = async () => ({ green: true });

    const result = await mutationCheck(recipe, { repoRoot, runGuardTest: alwaysGreen });

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/locator not found/i);

    const restoredBytes = await readFile(fullPath);
    expect(restoredBytes.equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("5a. throws on missing required field", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file } = await makeTempFile(original);

    const recipe = {
      file,
      locator: "const contract_id = 'canonical_value_1';",
      canonical_value: "canonical_value_1",
      mutated_value: "mutated_value_1",
      guard_test: "",
    } as MutationRecipe;

    await expect(
      mutationCheck(recipe, { repoRoot, runGuardTest: async () => ({ green: true }) }),
    ).rejects.toThrow();
  });

  it("5b. throws when target file does not exist", async () => {
    const { repoRoot } = await makeTempFile("irrelevant");

    const recipe: MutationRecipe = {
      file: "does-not-exist.txt",
      locator: "x",
      canonical_value: "x",
      mutated_value: "y",
      guard_test: "T_fake",
    };

    await expect(
      mutationCheck(recipe, { repoRoot, runGuardTest: async () => ({ green: true }) }),
    ).rejects.toThrow();
  });

  it("5c. throws when canonical_value is not found inside locator", async () => {
    const original = "const contract_id = 'canonical_value_1';\n";
    const { repoRoot, file } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      locator: "const contract_id = 'canonical_value_1';",
      canonical_value: "not_present_in_locator",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    await expect(
      mutationCheck(recipe, { repoRoot, runGuardTest: async () => ({ green: true }) }),
    ).rejects.toThrow(/canonical_value not found inside locator/i);
  });

  it("6. replace-all correctness: locator/canonical appearing twice is fully mutated then fully restored", async () => {
    // canonical_value_1 appears TWICE inside the locator/file. The fake runner is green
    // iff ANY occurrence remains (red only once ZERO occurrences remain). A `.replaceAll`
    // implementation wipes out both occurrences -> RED -> happy path (pass:true). A
    // `.replace`-only-first regression would leave one occurrence behind -> still green
    // under mutation -> "stayed GREEN" failure. This test asserts the correct (pass:true)
    // outcome, which only holds if every occurrence was replaced.
    const original = "const a = 'canonical_value_1'; const b = 'canonical_value_1';\n";
    const { repoRoot, file, fullPath } = await makeTempFile(original);

    const recipe: MutationRecipe = {
      file,
      locator: "const a = 'canonical_value_1'; const b = 'canonical_value_1';",
      canonical_value: "canonical_value_1",
      mutated_value: "mutated_value_1",
      guard_test: "T_fake",
    };

    const result = await mutationCheck(recipe, {
      repoRoot,
      runGuardTest: greenIffCanonicalPresent(fullPath, recipe.canonical_value),
    });

    expect(result).toEqual({ pass: true });

    const restoredBytes = await readFile(fullPath);
    expect(restoredBytes.equals(Buffer.from(original, "utf8"))).toBe(true);
  });
});
