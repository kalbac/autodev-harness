import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.js";
import { classifyOracleEntry, resolveOracleSet, oracleGlobTouches } from "./oracle-paths.js";

/** A 7-column GUARDS.md pipe table row -- mirrors root.test.ts's `guardsMdRow`. */
function guardsMdRow(opts: {
  contractId: string;
  recipe: string;
  guardTest: string;
  mutationVerified?: string;
}): string {
  const mv = opts.mutationVerified ?? "yes (red on flip)";
  return [
    `| ${opts.contractId} | \`value-x\` | \`${opts.guardTest}\` | \`${opts.recipe}\` | ${mv} | maksim | 2026-01-01 |`,
  ].join("\n");
}

function guardsMd(rows: string[]): string {
  return ["# GUARDS", "", "| contract_id | contract_value | guard_test | recipe | mutation_verified | blessed_by | date |", "|---|---|---|---|---|---|---|", ...rows, ""].join(
    "\n",
  );
}

describe("classifyOracleEntry", () => {
  it("a plain path is a literal", () => {
    expect(classifyOracleEntry("tests/FooTest.php")).toBe("literal");
    expect(classifyOracleEntry("GUARDS.md")).toBe("literal");
  });

  it("`*` or `?` makes an entry a glob", () => {
    expect(classifyOracleEntry("secrets/*.md")).toBe("glob");
    expect(classifyOracleEntry("file?.txt")).toBe("glob");
  });

  it("`**` is still a glob (contains `*`)", () => {
    expect(classifyOracleEntry(".github/workflows/**")).toBe("glob");
  });
});

describe("resolveOracleSet", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adh-oracle-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("2. includes invariantsFile, guardsFile, and every row's recipe+guard_test -- INCLUDING an unverified row", () => {
    writeFileSync(join(root, "INVARIANTS.md"), "irrelevant content");
    writeFileSync(join(root, "GUARDS.md"), guardsMd([
      guardsMdRow({ contractId: "c-verified", recipe: "recipes/a.json", guardTest: "T_a" }),
      guardsMdRow({ contractId: "c-unverified", recipe: "recipes/b.json", guardTest: "T_b", mutationVerified: "no" }),
    ]));
    // Note: `recipes/a.json` is never created on disk -- the recipe JSON's
    // CONTENT is never read by this module (see test 4), so its existence is
    // irrelevant to this test.
    const cfg = HarnessConfigSchema.parse({});

    return resolveOracleSet(cfg, {}, root).then((set) => {
      expect(set.literals).toContain("INVARIANTS.md");
      expect(set.literals).toContain("GUARDS.md");
      expect(set.literals).toContain("recipes/a.json");
      expect(set.literals).toContain("T_a");
      // The UNVERIFIED row's recipe/guard_test must ALSO be protected -- an
      // unverified guard's test file is still an oracle input a worker must
      // not edit, even though `loadGuardPairsFrom` would filter this row out.
      expect(set.literals).toContain("recipes/b.json");
      expect(set.literals).toContain("T_b");
    });
  });

  it("3. a guard_test cell carrying a `::selector` suffix contributes only the bare path", async () => {
    writeFileSync(
      join(root, "GUARDS.md"),
      guardsMd([guardsMdRow({ contractId: "c1", recipe: "recipes/a.json", guardTest: "tests/FooTest.php::testBar" })]),
    );
    const cfg = HarnessConfigSchema.parse({});

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("tests/FooTest.php");
    expect(set.literals).not.toContain("tests/FooTest.php::testBar");
  });

  it("4. recipe.file (the code the recipe mutates) is NEVER read, so it cannot appear in the set", async () => {
    // Even though the recipe JSON declares a `file` field pointing at real
    // application source, oracle-paths.ts never opens the recipe JSON at all --
    // only the GUARDS.md `recipe` COLUMN (the path to that JSON) is protected.
    writeFileSync(
      join(root, "GUARDS.md"),
      guardsMd([guardsMdRow({ contractId: "c1", recipe: "recipes/a.json", guardTest: "T_a" })]),
    );
    // `recipes/a.json` is deliberately NOT written to disk here either -- proving
    // the recipe's `file` field never leaks into the set does not require the
    // JSON to actually exist, since it is never opened at all.
    const cfg = HarnessConfigSchema.parse({});

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("recipes/a.json"); // the recipe FILE itself, protected
    expect(set.literals).not.toContain("src/app/pricing.ts"); // the code under test, NOT protected
  });

  it("5. agent-ci DISABLED contributes no workflow entries", async () => {
    const cfg = HarnessConfigSchema.parse({ gate: { agentCi: { enabled: false, workflows: ["ci.yml"] } } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).not.toContain("ci.yml");
    expect(set.literals).not.toContain(".github/workflows/ci.yml");
    expect(set.globs).not.toContain(".github/workflows/**");
  });

  it("5b. agent-ci ENABLED contributes the entry, its .github/workflows/<entry> form, AND the directory glob", async () => {
    const cfg = HarnessConfigSchema.parse({ gate: { agentCi: { enabled: true, workflows: ["ci.yml"] } } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("ci.yml");
    expect(set.literals).toContain(".github/workflows/ci.yml");
    expect(set.globs).toContain(".github/workflows/**");
  });

  it("6. contract.constitutionPaths entries land in the correct arm (glob vs literal)", async () => {
    const cfg = HarnessConfigSchema.parse({
      contract: { constitutionPaths: ["docs/CONSTITUTION.md", "secrets/**"] },
    });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("docs/CONSTITUTION.md");
    expect(set.globs).toContain("secrets/**");
    expect(set.literals).not.toContain("secrets/**");
    expect(set.globs).not.toContain("docs/CONSTITUTION.md");
  });

  it("7a. a configured-but-absent contract file THROWS, naming the path and the root", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { invariantsFile: "custom/INVARIANTS.md" } });
    const raw = { contract: { invariantsFile: "custom/INVARIANTS.md" } };

    await expect(resolveOracleSet(cfg, raw, root)).rejects.toThrow(/custom\/INVARIANTS\.md/);
  });

  it("7b. NOT configured + absent does NOT throw (contributes nothing for that file)", async () => {
    const cfg = HarnessConfigSchema.parse({});
    // root has neither INVARIANTS.md nor GUARDS.md, and raw configures neither.

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).not.toContain("INVARIANTS.md");
    expect(set.literals).not.toContain("GUARDS.md");
  });

  it("8a. a literal entry escaping via '..' THROWS", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["../outside.md"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/outside.md|escapes/i);
  });

  it("8b. a literal entry reached through a SYMLINKED ancestor directory THROWS (realpath containment, not just lexical join)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-oracle-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "attacker content");
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["linked/secret.md"] } });

      await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/linked\/secret\.md/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("8c. a literal entry that is simply NOT YET CREATED does not throw merely for being absent (creation-as-drift is the fingerprint arm's job, not this function's)", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["not-yet-created.md"] } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("not-yet-created.md");
  });

  // --- round-1 critic regressions: every entry must be worktree-RELATIVE ---------
  // The set is resolved against the TRUSTED root but fingerprinted against the
  // WORKTREE (`snapshot(wt.path, literals)` -> `join(wt.path, entry)`). `join` does
  // NOT discard an absolute second argument, so an absolute entry produced a nonsense
  // path that read "<absent>" both before and after the worker -- the declared file
  // was silently NOT protected (fail OPEN).

  it("R1a. an ABSOLUTE literal is REFUSED even when it points INSIDE the trusted root -- it would `join` into a nonsense path under the worktree and read absent both before and after the worker", async () => {
    const absolute = join(root, "tests", "Guard.ts");
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: [absolute] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R1b. an ABSOLUTE literal OUTSIDE the trusted root is refused too", async () => {
    const outside = join(tmpdir(), "adh-oracle-absolute-outside", "Guard.ts");
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: [outside] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R1c. an ABSOLUTE contract.guardsFile is refused too -- that source pushed its raw config string straight into the set, bypassing every check", async () => {
    const absolute = join(root, "GUARDS.md");
    writeFileSync(absolute, "");
    const cfg = HarnessConfigSchema.parse({ contract: { guardsFile: absolute } });

    await expect(resolveOracleSet(cfg, { contract: { guardsFile: absolute } }, root)).rejects.toThrow(
      /is an absolute path/,
    );
  });

  it("R1d. a RELATIVE literal written with backslashes normalizes to forward slashes (one entry shape on every platform)", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["docs\\CONSTITUTION.md"] } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("docs/CONSTITUTION.md");
  });

  // --- round-2 critic regressions ------------------------------------------------

  it("R3. a WINDOWS-absolute literal is refused on POSIX too -- `path.isAbsolute` is the HOST implementation, so on Linux 'D:\\repo\\x' would pass as an ordinary relative path and silently never match anything under the worktree", async () => {
    // Deliberately a raw string, NOT `join(root, ...)`: the point is the foreign
    // syntax, which must be rejected by whichever platform this suite runs on.
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["D:\\repo\\tests\\Guard.ts"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R3b. a drive-RELATIVE literal ('D:tests/Guard.ts' -- resolved against the drive's own cwd, not the repo root) is refused", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["D:tests/Guard.ts"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R3c. a UNC literal is refused", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["\\\\server\\share\\Guard.ts"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R3d. a WINDOWS-absolute GLOB is refused on POSIX too (same host-implementation gap, glob arm)", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["D:\\repo\\outside\\**"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/absolute pattern/);
  });

  // --- round-3 critic regressions ------------------------------------------------

  it("R5. a lone-backslash drive-rooted literal ('\\\\foo\\\\bar') is refused -- win32.isAbsolute catches it where a 'two leading separators' regex does not", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["\\foo\\bar"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is an absolute path/);
  });

  it("R6. a literal resolving to the repo ROOT itself is refused -- `relative(root, root)` is '', and `snapshot` SKIPS empty paths, so it would protect nothing", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["."] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/repo root itself/);
  });

  it("R6b. a round-tripping literal ('docs/..') is refused for the same reason", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["docs/.."] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/repo root itself/);
  });

  it("R7. a literal that is an existing DIRECTORY is refused, pointing at the glob form -- a directory reads '<unreadable>' before AND after the worker, so it could never register drift", async () => {
    mkdirSync(join(root, "secrets"), { recursive: true });
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["secrets"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is a DIRECTORY/);
  });

  // --- round-4 critic regressions ------------------------------------------------

  it("R8. a backslash-separated relative literal probes and normalizes the SAME file on every platform (folded to '/' before resolve, so POSIX does not treat '\\\\' as a filename byte)", async () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "CONSTITUTION.md"), "x");
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["docs\\CONSTITUTION.md"] } });

    // If the fold did not happen, on POSIX the probe would look for a file literally
    // named `docs\CONSTITUTION.md` (absent -> silently accepted) and still key it as
    // `docs/CONSTITUTION.md`. With the real file present, an escaping/mismatched probe
    // would either mis-resolve or (for a `..`-laundered form) throw -- so a clean
    // resolution to the expected key proves the probe saw the real path.
    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("docs/CONSTITUTION.md");
  });

  it("R8b. a backslash-laundered escape ('docs\\\\..\\\\..\\\\outside.md') is caught -- the fold makes '\\\\' a separator so '..' is seen on POSIX too", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["docs\\..\\..\\outside.md"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/escapes the trusted root/);
  });

  it("R9. a SYMLINKED-LEAF literal pointing INSIDE the root is refused -- `snapshot` hashes the target's content, so repointing the link would not register drift", async () => {
    writeFileSync(join(root, "real-guard.ts"), "real content");
    symlinkSync(join(root, "real-guard.ts"), join(root, "guard-link.ts"), process.platform === "win32" ? "file" : undefined);
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["guard-link.ts"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/is a SYMLINK/);
  });

  // --- round-5 critic regressions ------------------------------------------------

  it("R10. a backslash-separated contract.guardsFile resolves the real file on every platform (resolveTrustedFile folds separators too, matching normalizeLiteralEntry)", async () => {
    mkdirSync(join(root, "cfgdir"), { recursive: true });
    writeFileSync(join(root, "cfgdir", "GUARDS.md"), guardsMd([]));
    const raw = { contract: { guardsFile: "cfgdir\\GUARDS.md" } };
    const cfg = HarnessConfigSchema.parse(raw);

    // Would THROW "configured but not readable" on POSIX if the fold were missing
    // (the literal `cfgdir\GUARDS.md` name does not exist); a clean resolve proves the
    // real file was probed and added as a normalized literal.
    const set = await resolveOracleSet(cfg, raw, root);

    expect(set.literals).toContain("cfgdir/GUARDS.md");
  });

  it("R11. a backslash-separated glob is stored in canonical forward-slash form (both arms share one shape)", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["tests\\**\\Guard.ts"] } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.globs).toContain("tests/**/Guard.ts");
    expect(set.globs).not.toContain("tests\\**\\Guard.ts");
  });

  it("R4. an fs error raised by the realpath containment probe PROPAGATES -- it must never be swallowed as 'the file does not exist yet', which would admit the literal with its containment unproven", async () => {
    // A directory standing where a file path is declared: `lstat` SUCCEEDS (so the
    // "not created yet" arm does not apply) and the realpath probe runs for real.
    // The assertion is that resolution completes on a genuinely contained entry --
    // the swallow-path regression showed up as an entry admitted after a THROWN
    // probe, so this pins that the probe's result is actually consulted rather than
    // discarded. Paired with 8b (symlinked ancestor), which pins the refusal side.
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "CONSTITUTION.md"), "x");
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["docs/CONSTITUTION.md"] } });

    const set = await resolveOracleSet(cfg, {}, root);

    expect(set.literals).toContain("docs/CONSTITUTION.md");
  });

  it("R2a. a glob with a '..' segment THROWS instead of being silently stored (it could never match a worktree-relative path)", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: ["../shared/**"] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/never match/);
  });

  it("R2b. an ABSOLUTE glob THROWS instead of being silently stored", async () => {
    const cfg = HarnessConfigSchema.parse({ contract: { constitutionPaths: [join(root, "outside", "**")] } });

    await expect(resolveOracleSet(cfg, {}, root)).rejects.toThrow(/absolute pattern/);
  });

  // --- source 5: profile protectedPaths ------------------------------------------
  // `gate/` must not depend on `profile/` (wrong dependency direction -- see this
  // module's own doc comment), so the composition root passes a plain `string[]`
  // rather than a `ResolvedProfile`. Classification/normalization is the SAME
  // addLiteral/addGlob path as every other source -- only the attributed reason
  // differs, so these tests only need to pin the wiring, not re-prove the fail-closed
  // matrix already covered above.
  describe("profile protected paths (source 5)", () => {
    it("adds a profile literal with a profile-attributed reason", async () => {
      const cfg = HarnessConfigSchema.parse({});
      const raw = {};

      const set = await resolveOracleSet(cfg, raw, root, ["phpcs.xml"]);

      expect(set.literals).toContain("phpcs.xml");
      expect(set.sources.get("phpcs.xml")).toMatch(/profile/i);
    });

    it("classifies a profile glob into the glob arm", async () => {
      const cfg = HarnessConfigSchema.parse({});
      const raw = {};

      const set = await resolveOracleSet(cfg, raw, root, ["ci/**"]);

      expect(set.globs).toContain("ci/**");
      expect(set.literals).not.toContain("ci/**");
    });

    it("fails closed on an escaping profile path", async () => {
      const cfg = HarnessConfigSchema.parse({});
      const raw = {};

      await expect(resolveOracleSet(cfg, raw, root, ["../outside.xml"])).rejects.toThrow(/escapes/i);
    });

    it("changes nothing when the list is empty (default)", async () => {
      const cfg = HarnessConfigSchema.parse({});
      const raw = {};

      const withArg = await resolveOracleSet(cfg, raw, root, []);
      const without = await resolveOracleSet(cfg, raw, root);

      expect(withArg.literals).toEqual(without.literals);
      expect(withArg.globs).toEqual(without.globs);
    });
  });
});

describe("oracleGlobTouches", () => {
  it("9. normalizes BOTH the touched path and the glob before matching (parity with forbiddenTouches)", () => {
    // normalizePath strips ALL leading '.'/'/' characters (glob.ts's documented
    // `.TrimStart('./')` parity quirk), so a dotfile's own leading dot is stripped
    // too -- consistently on BOTH sides, which is exactly what keeps the match
    // working despite the `./`-prefixed touched path.
    const hits = oracleGlobTouches(["./.github/workflows/ci.yml"], [".github/workflows/**"]);
    expect(hits).toEqual(["github/workflows/ci.yml"]);
  });

  it("no globs -> no hits, even with touched files", () => {
    expect(oracleGlobTouches(["a.ts"], [])).toEqual([]);
  });

  it("a touched file that matches no glob is not a hit", () => {
    expect(oracleGlobTouches(["a.ts"], [".github/workflows/**"])).toEqual([]);
  });
});
