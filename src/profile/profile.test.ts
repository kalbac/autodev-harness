import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseProfileRef, loadProfile, harnessRoot, prepareGateInvocation } from "./profile.js";

let root: string;

/** Write a profile tree under a fake harness root. Returns the harness root. */
async function writeProfile(id: string, yaml: string): Promise<string> {
  const dir = join(root, "profiles", id);
  await mkdir(join(dir, "gates"), { recursive: true });
  await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
  await writeFile(join(dir, "gates", "phpcs.xml"), "<ruleset/>", "utf8");
  return root;
}

const GOOD = `id: demo
version: 1
requires:
  provision: [vendor]
gates:
  - id: phpcs
    run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."
protectedPaths:
  - phpcs.xml
`;

beforeEach(async () => {
  // realpathSync: the Windows CI runner exposes os.tmpdir() as an 8.3 short path,
  // and the loader canonicalizes its own paths -- see
  // docs/gotchas/win-83-shortpath-realpath-divergence.md.
  root = realpathSync(await mkdtemp(join(tmpdir(), "profile-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseProfileRef", () => {
  it("splits '<id>@<version>'", () => {
    expect(parseProfileRef("wordpress-woocommerce@1")).toEqual({ id: "wordpress-woocommerce", version: 1 });
  });

  it.each([
    ["no version", "wordpress-woocommerce"],
    ["empty id", "@1"],
    ["non-numeric version", "demo@v1"],
    ["path separator in id", "../escape@1"],
    ["backslash in id", "..\\escape@1"],
    ["uppercase id", "Demo@1"],
  ])("refuses a malformed reference (%s)", (_label, ref) => {
    expect(() => parseProfileRef(ref)).toThrow(/profile reference/i);
  });
});

describe("loadProfile", () => {
  it("resolves gates, protected paths and provisioning", async () => {
    await writeProfile("demo", GOOD);
    const p = await loadProfile("demo@1", root);
    expect(p.id).toBe("demo");
    expect(p.version).toBe(1);
    expect(p.dir).toBe(join(root, "profiles", "demo"));
    expect(p.provision).toEqual(["vendor"]);
    expect(p.protectedPaths).toEqual(["phpcs.xml"]);
    expect(p.gates).toHaveLength(1);
    expect(p.gates[0]!.id).toBe("phpcs");
  });

  it("expands {profile} to the absolute profile directory", async () => {
    await writeProfile("demo", GOOD);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.run).toBe(
      `vendor/bin/phpcs --standard=${join(root, "profiles", "demo")}/gates/phpcs.xml .`,
    );
    expect(p.gates[0]!.run).not.toContain("{profile}");
  });

  it("throws when the profile directory does not exist", async () => {
    await expect(loadProfile("missing@1", root)).rejects.toThrow(/not found/i);
  });

  it("throws when the pinned version does not match the file", async () => {
    await writeProfile("demo", GOOD);
    await expect(loadProfile("demo@2", root)).rejects.toThrow(/version/i);
  });

  it("throws when the id inside the file does not match the directory", async () => {
    await writeProfile("demo", GOOD.replace("id: demo", "id: other"));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/id/i);
  });

  it("throws on an unknown key (fail loud, never silently ignored)", async () => {
    await writeProfile("demo", GOOD + "criticRubric: nope\n");
    await expect(loadProfile("demo@1", root)).rejects.toThrow();
  });

  it("throws on a gate with an empty run command", async () => {
    await writeProfile("demo", GOOD.replace('run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."', 'run: "  "'));
    await expect(loadProfile("demo@1", root)).rejects.toThrow();
  });

  it("throws naming the missing file when a gate references a ruleset {profile} did not ship", async () => {
    // "resolves gates..." and "expands {profile}..." above already prove the
    // opposite case (a shipped gates/phpcs.xml) loads fine -- this covers a
    // gate whose {profile}-derived path is never written by writeProfile.
    await writeProfile(
      "demo",
      GOOD.replace(
        'run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."',
        'run: "vendor/bin/phpcs --standard={profile}/gates/missing.xml ."',
      ),
    );
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/gates[\\/]missing\.xml/);
  });

  it("throws when the profile directory path contains whitespace", async () => {
    // splitCommand() splits gate commands on whitespace and is NOT quote-aware
    // (docs/gotchas/conductor-wiring-deferred-limitations.md), so a {profile}
    // expansion containing a space would silently produce broken argv. Fail loud
    // at load instead of running a mangled command.
    const spaced = join(root, "with space");
    await mkdir(join(spaced, "profiles", "demo", "gates"), { recursive: true });
    await writeFile(join(spaced, "profiles", "demo", "profile.yaml"), GOOD, "utf8");
    await expect(loadProfile("demo@1", spaced)).rejects.toThrow(/whitespace/i);
  });
});

describe("harnessRoot", () => {
  it("resolves this repository's root, which contains profiles/", async () => {
    const r = harnessRoot();
    expect(existsSync(join(r, "package.json"))).toBe(true);
  });

  it("resolves identically from a compiled dist/ module", async () => {
    // The daemon runs `node dist/index.js`. If resolution were module-relative
    // (as the critic schema's is), it would point at dist/profiles -- a directory
    // tsc never emits -- and every profile would 'not be found' in production
    // while every unit test stayed green.
    const r = harnessRoot();
    const distEntry = join(r, "dist", "profile", "profile.js");
    if (!existsSync(distEntry)) {
      throw new Error(`run 'npm run build' before this test -- ${distEntry} is missing`);
    }
    const compiled = (await import(pathToFileURL(distEntry).href)) as { harnessRoot: () => string };
    expect(compiled.harnessRoot()).toBe(r);
  });
});

describe("diff-scoping cross-checks in loadProfile", () => {
  const SCOPED = `id: demo
version: 1
gates:
  - id: phpcs
    files: "**/*.php"
    run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml {files}"
`;

  it("carries the files glob onto the resolved gate", async () => {
    await writeProfile("demo", SCOPED);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.filesGlob).toBe("**/*.php");
    // {files} stays a placeholder: the changed-file set is unknown at load time.
    expect(p.gates[0]!.run).toContain("{files}");
  });

  it("leaves filesGlob null for a whole-project gate", async () => {
    await writeProfile("demo", GOOD);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.filesGlob).toBeNull();
  });

  it("refuses '{files}' with no files: glob (the placeholder would reach the tool verbatim)", async () => {
    await writeProfile("demo", SCOPED.replace('    files: "**/*.php"\n', ""));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/declares no 'files:' glob/);
  });

  it("refuses a files: glob whose run never uses '{files}' (would silently run whole-tree)", async () => {
    await writeProfile("demo", SCOPED.replace(" {files}", " ."));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/never uses/);
  });
});

describe("prepareGateInvocation", () => {
  const scoped = (run: string, filesGlob: string | null) => ({ id: "phpcs", run, filesGlob });

  it("passes a whole-project gate through untouched", () => {
    const inv = prepareGateInvocation(scoped("composer validate", null), ["a.php"]);
    expect(inv).toEqual({ skipped: false, command: "composer validate" });
  });

  it("expands {files} to the matching changed files, space-joined", () => {
    const inv = prepareGateInvocation(scoped("phpcs {files}", "**/*.php"), [
      "includes/a.php",
      "readme.md",
      "includes/b.php",
    ]);
    expect(inv).toEqual({ skipped: false, command: "phpcs includes/a.php includes/b.php" });
  });

  it("SKIPS rather than running when nothing matches -- an empty path list would make the tool scan the whole tree", () => {
    const inv = prepareGateInvocation(scoped("phpcs {files}", "**/*.php"), ["readme.md"]);
    expect(inv.skipped).toBe(true);
    expect(inv).toMatchObject({ reason: expect.stringContaining("**/*.php") });
  });

  it("skips on an empty changed set too", () => {
    expect(prepareGateInvocation(scoped("phpcs {files}", "**/*.php"), []).skipped).toBe(true);
  });

  it("refuses a matched path containing whitespace instead of emitting a mangled command", () => {
    expect(() => prepareGateInvocation(scoped("phpcs {files}", "**/*.php"), ["my dir/a.php"])).toThrow(
      /whitespace/i,
    );
  });

  it("does not let a non-matching whitespace path block the run", () => {
    // The whitespace refusal must apply only to files the gate actually judges;
    // an unrelated spaced path elsewhere in the diff is none of its business.
    const inv = prepareGateInvocation(scoped("phpcs {files}", "**/*.php"), ["a.php", "my docs/notes.md"]);
    expect(inv).toEqual({ skipped: false, command: "phpcs a.php" });
  });
});
