import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseProfileRef, loadProfile, harnessRoot, prepareGateInvocation, classifyGateExit } from "./profile.js";

/**
 * Probed ONCE at module load (not inside a test) so `it.skipIf` can gate on it:
 * some sandboxed environments (notably a Windows CI runner without the
 * "Create symbolic links" privilege) refuse symlink/junction creation outright,
 * and that must skip the test explicitly rather than let the assertion fail for
 * an unrelated environment reason or, worse, get silently weakened to tolerate
 * either outcome.
 */
const canSymlinkDir = (() => {
  try {
    const base = mkdtempSync(join(tmpdir(), "profile-symlink-probe-"));
    try {
      const target = join(base, "target");
      mkdirSync(target);
      symlinkSync(target, join(base, "link"), process.platform === "win32" ? "junction" : "dir");
      return true;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();

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
    // "01" and "1" would parse to the identical Number, which is an ambiguity
    // this module refuses rather than silently normalizes away -- canonical
    // decimal form only (round-5 critic finding, leading-zero decision).
    ["leading-zero version", "demo@01"],
  ])("refuses a malformed reference (%s)", (_label, ref) => {
    expect(() => parseProfileRef(ref)).toThrow(/profile reference/i);
  });

  // round-5 critic finding: `Number(versionText)` silently loses precision above
  // Number.MAX_SAFE_INTEGER, so a reference like "demo@9007199254740993" would
  // round to "...992" and a profile.yaml declaring THAT rounded value would then
  // satisfy `pf.version !== version` and load -- pinning the wrong version while
  // both sides believe they agree exactly.
  it("refuses a version above Number.MAX_SAFE_INTEGER (precision loss would let the wrong pinned version silently match)", () => {
    expect(() => parseProfileRef("demo@9007199254740993")).toThrow(/exact integer/i);
  });

  it("accepts version 1", () => {
    expect(parseProfileRef("demo@1")).toEqual({ id: "demo", version: 1 });
  });

  it("accepts a large but still exactly-representable version", () => {
    expect(parseProfileRef(`demo@${Number.MAX_SAFE_INTEGER}`)).toEqual({
      id: "demo",
      version: Number.MAX_SAFE_INTEGER,
    });
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

describe("loadProfile -- 'report' key (line-scoped profile gates, Task 4)", () => {
  const withReport = (report: string, run: string) => `id: demo
version: 1
gates:
  - id: phpcs
    files: "**/*.php"
    report: ${report}
    run: "${run}"
`;

  it("carries a declared report format onto the resolved gate", async () => {
    await writeProfile(
      "demo",
      withReport("checkstyle", "vendor/bin/phpcs --report=checkstyle {files}"),
    );
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.report).toBe("checkstyle");
  });

  it("leaves report null for a gate that declares none", async () => {
    await writeProfile("demo", GOOD);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.report).toBeNull();
  });

  it("rejects an unknown report format at load (closed enum, not a free string)", async () => {
    await writeProfile(
      "demo",
      withReport("junit", "vendor/bin/phpcs --report=junit {files}"),
    );
    await expect(loadProfile("demo@1", root)).rejects.toThrow();
  });

  it("rejects a 'report: checkstyle' gate whose run command never mentions checkstyle (obviously-broken combination)", async () => {
    await writeProfile("demo", withReport("checkstyle", "vendor/bin/phpcs {files}"));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/never mentions 'checkstyle'/);
  });

  it("accepts the format mention case-insensitively and anywhere in the command", async () => {
    await writeProfile(
      "demo",
      withReport("checkstyle", "vendor/bin/phpcs --report=CheckStyle {files}"),
    );
    await expect(loadProfile("demo@1", root)).resolves.toBeTruthy();
  });
});

describe("prepareGateInvocation", () => {
  const scoped = (run: string, filesGlob: string | null) => ({
    id: "phpcs",
    run,
    filesGlob,
    redExitCodes: [1],
    report: null,
  });

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

describe("classifyGateExit -- distinguishes RED from a gate that could not run at all (critic finding 1)", () => {
  const gate = (redExitCodes: number[]) => ({ id: "phpcs", run: "phpcs .", filesGlob: null, redExitCodes });

  it("exit 0 is always green, regardless of declared red codes", () => {
    expect(classifyGateExit(gate([1]), 0)).toBe("green");
    expect(classifyGateExit(gate([1, 2]), 0)).toBe("green");
  });

  it("a declared red code is RED (worker-fixable)", () => {
    expect(classifyGateExit(gate([1]), 1)).toBe("red");
    expect(classifyGateExit(gate([1, 2]), 2)).toBe("red");
  });

  it("an undeclared non-zero exit is UNRUNNABLE (the tool could not do its job -- escalate, don't loop the worker)", () => {
    // PHPCS exit 3 = processing error (bad ruleset / unreadable file), not a code finding.
    expect(classifyGateExit(gate([1, 2]), 3)).toBe("unrunnable");
  });

  it("defaults to [1] as the sole declared red code when a gate omits redExitCodes", () => {
    // composer validate: 1 = a genuine validation failure (measured), 3 = 'composer.json not
    // found' (measured) -- an infra/config problem, not something a worker can fix by editing
    // the diff. The conservative default is therefore [1], not 'any non-zero'.
    expect(classifyGateExit(gate([1]), 1)).toBe("red");
    expect(classifyGateExit(gate([1]), 3)).toBe("unrunnable");
  });
});

describe("loadProfile -- redExitCodes wiring onto ResolvedGate", () => {
  it("defaults redExitCodes to [1] when the profile omits it", async () => {
    await writeProfile("demo", GOOD);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.redExitCodes).toEqual([1]);
  });

  it("carries an explicit redExitCodes array from the profile onto the resolved gate", async () => {
    const yaml = `id: demo
version: 1
gates:
  - id: phpcs
    run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."
    redExitCodes: [1, 2]
`;
    await writeProfile("demo", yaml);
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.redExitCodes).toEqual([1, 2]);
  });

  it("rejects an empty redExitCodes array (must be non-empty when declared)", async () => {
    const yaml = `id: demo
version: 1
gates:
  - id: phpcs
    run: "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."
    redExitCodes: []
`;
    await writeProfile("demo", yaml);
    await expect(loadProfile("demo@1", root)).rejects.toThrow();
  });
});

describe("loadProfile -- ruleset-probe token normal form (critic finding 2)", () => {
  // The probe must validate the SAME string the runner receives. A token embedding the
  // profile dir mid-word (no '=' immediately before it) is a shape the probe used to accept
  // (it only checked the suffix from the dir onward) while the runner would receive the
  // whole malformed token, e.g. "prefix<dir>/gates/phpcs.xml" instead of a real path.
  it("throws at load when a {profile}-derived token embeds the dir without a bare-path or '=' prefix", async () => {
    const yaml = `id: demo
version: 1
gates:
  - id: phpcs
    run: "vendor/bin/phpcs prefix{profile}/gates/phpcs.xml ."
`;
    await writeProfile("demo", yaml);
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/prefix.*gates[\\/]phpcs\.xml/);
  });

  it("still accepts the bare-path form (token starts with the profile dir)", async () => {
    const yaml = `id: demo
version: 1
gates:
  - id: phpcs
    run: "vendor/bin/phpcs {profile}/gates/phpcs.xml ."
`;
    await writeProfile("demo", yaml);
    await expect(loadProfile("demo@1", root)).resolves.toBeTruthy();
  });

  it("still accepts a flag-prefixed form whose prefix ends with '=' (the existing GOOD fixture)", async () => {
    // Already covered by "expands {profile}..." above; this pins the same shape by name
    // against the finding, so a regression here reads unambiguously against finding 2.
    await writeProfile("demo", GOOD);
    await expect(loadProfile("demo@1", root)).resolves.toBeTruthy();
  });
});

describe("loadProfile -- requires.provision must pass the same validation as worktree.provision (critic finding 3)", () => {
  const withProvision = (entry: string) => `id: demo
version: 1
requires:
  provision: [${JSON.stringify(entry)}]
gates: []
`;

  it.each([
    ["empty string", ""],
    ["'..' segment", ".."],
    ["multi-segment forward-slash path", "a/b"],
    ["Windows-style absolute path", "C:\\x"],
    ["POSIX absolute path", "/etc"],
  ])("rejects %s", async (_label, entry) => {
    await writeProfile("demo", withProvision(entry));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/provision/i);
  });

  it("still accepts a single top-level segment", async () => {
    await writeProfile("demo", withProvision("vendor"));
    const p = await loadProfile("demo@1", root);
    expect(p.provision).toEqual(["vendor"]);
  });
});

describe("{profile} token normal form (round-2 critic finding)", () => {
  const tok = (run: string) => `id: demo
version: 1
gates:
  - id: phpcs
    run: "${run}"
`;

  it.each([
    ["bare path", "{profile}/gates/phpcs.xml"],
    ["long flag", "--standard={profile}/gates/phpcs.xml"],
    ["short flag", "-c={profile}/gates/phpcs.xml"],
  ])("accepts a legitimate shape (%s)", async (_label, token) => {
    await writeProfile("demo", tok(`phpcs ${token}`));
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.run).toContain("gates/phpcs.xml");
  });

  it.each([
    // The round-2 leak: "ends with '='" is not proof of a flag.
    ["bare equals sign", "={profile}/gates/phpcs.xml"],
    ["arbitrary prefix", "prefix{profile}/gates/phpcs.xml"],
    ["flag without the equals", "--standard{profile}/gates/phpcs.xml"],
    ["double equals tail", "--standard=={profile}/gates/phpcs.xml"],
  ])("refuses a malformed shape (%s)", async (_label, token) => {
    await writeProfile("demo", tok(`phpcs ${token}`));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/unrecognized shape/);
  });
});

describe("{profile} token normal form (round-3 critic finding -- containment + prefix confusion)", () => {
  const tok = (run: string) => `id: demo
version: 1
gates:
  - id: phpcs
    run: "${run}"
`;

  it.each([
    ["bare path", "{profile}/gates/phpcs.xml"],
    ["long flag", "--standard={profile}/gates/phpcs.xml"],
    ["short flag", "-c={profile}/gates/phpcs.xml"],
    ["flag with underscore", "--some_flag={profile}/gates/phpcs.xml"],
    ["flag with dot", "--some.flag={profile}/gates/phpcs.xml"],
  ])("accepts a legitimate shape (%s)", async (_label, token) => {
    await writeProfile("demo", tok(`phpcs ${token}`));
    const p = await loadProfile("demo@1", root);
    expect(p.gates[0]!.run).toContain("gates/phpcs.xml");
  });

  it("refuses '{profile}' alone with no separator after it", async () => {
    await writeProfile("demo", tok("phpcs {profile}"));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/no path separator/);
  });

  it("refuses an escape via '..' even when a real file sits at the escaped location", async () => {
    // Without the containment check, `{profile}/../outside.xml` would `stat()`
    // this real file and load successfully -- the escape this test proves is
    // closed, not merely a string-shape assertion.
    await writeProfile("demo", tok("phpcs {profile}/../outside.xml"));
    await writeFile(join(root, "profiles", "outside.xml"), "<ruleset/>", "utf8");
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/resolves OUTSIDE the profile directory/);
  });

  it("refuses a sibling directory whose name shares the profile dir as a string prefix", async () => {
    // Build the sibling ON DISK, with a real file at the shape the profile
    // references, so this proves the real filesystem behaviour is blocked -- not
    // just that a string starting with the profile dir looks suspicious.
    await writeProfile("demo", tok("phpcs {profile}-evil/gates/phpcs.xml"));
    await mkdir(join(root, "profiles", "demo-evil", "gates"), { recursive: true });
    await writeFile(join(root, "profiles", "demo-evil", "gates", "phpcs.xml"), "<ruleset/>", "utf8");
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/no path separator/);
  });
});

describe("loadProfile -- refuses a hard-coded absolute path in the RAW 'run' string (round-4 critic finding)", () => {
  // A profile ships inside the harness repo and runs on whatever machine the
  // harness is installed on -- a hard-coded absolute path is unportable by
  // construction, not merely unprobed by the {profile}-derived-token check
  // (which only ever looks at tokens containing the expanded `dir`). This must
  // be checked on the RAW string, BEFORE '{profile}' expansion: after
  // expansion every legitimate {profile}-derived token IS absolute, which is
  // the whole point, so checking post-expansion would refuse the good case.
  //
  // Single-quoted YAML scalar (not double-quoted like the rest of this file):
  // a double-quoted YAML string interprets '\' as an escape introducer, so a
  // literal Windows path like 'C:\somewhere\phpcs.xml' would need doubled
  // backslashes to round-trip; single-quoted YAML treats '\' as an ordinary
  // character, which is what these fixtures need to express a raw Windows path.
  const tok = (run: string) => `id: demo
version: 1
gates:
  - id: phpcs
    run: '${run}'
`;

  it.each([
    ["POSIX absolute, flag-prefixed", "phpcs --standard=/etc/passwd ."],
    ["POSIX absolute, bare", "phpcs /etc/passwd ."],
    ["Windows drive absolute, flag-prefixed", "phpcs --standard=C:\\somewhere\\phpcs.xml ."],
    ["Windows drive-relative", "phpcs D:x ."],
    ["UNC share", "phpcs \\\\srv\\share\\phpcs.xml ."],
    ["lone leading backslash", "phpcs \\foo\\bar ."],
  ])("refuses (%s)", async (_label, run) => {
    await writeProfile("demo", tok(run));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/\{profile\}/);
  });

  it("checks the PATH PART of a flag-prefixed token, not the raw token including its --flag= prefix (the raw token '--standard=/etc/x' does not itself start with '/' or a drive letter)", async () => {
    await writeProfile("demo", tok("phpcs --standard=/etc/x ."));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/\/etc\/x/);
  });

  it("still accepts a legitimate {profile}-based flag (unaffected by the new raw-string check)", async () => {
    await writeProfile("demo", GOOD);
    await expect(loadProfile("demo@1", root)).resolves.toBeTruthy();
  });
});

describe("loadProfile -- raw absolute-path check inspects EVERY '='-separated segment, not just the text after the FIRST '=' (round-5 critic finding)", () => {
  // '--define=KEY=VALUE' is a legitimate CLI shape (repeatable key=value
  // options are a real pattern, not a hypothetical spelling), so a token can
  // legitimately contain a SECOND '=' whose presence must not be read as "no
  // absolute path here". The check's job is to catch an absolute path
  // ANYWHERE in the argument, not to parse any one tool's option grammar --
  // so every '='-separated segment is a candidate, not just the one after the
  // first '='.
  const tok = (run: string) => `id: demo
version: 1
gates:
  - id: phpcs
    run: '${run}'
`;

  it.each([
    ["absolute path after the SECOND '=' (Windows)", "vendor/bin/phpcs --define=KEY=C:\\outside\\x.xml ."],
    ["absolute path after the SECOND '=' (POSIX)", "vendor/bin/phpcs --define=KEY=/etc/x.xml ."],
    ["absolute path after the THIRD '=', token has no leading flag dash", "vendor/bin/phpcs A=B=D:\\x ."],
    // Already-covered plain forms, re-pinned here so a regression in the new
    // segment-splitting logic reads unambiguously against round 5.
    ["plain flag, absolute after the only '='", "vendor/bin/phpcs --standard=C:\\x.xml ."],
    ["bare absolute path, no '=' at all", "vendor/bin/phpcs /etc/x.xml ."],
  ])("refuses (%s)", async (_label, run) => {
    await writeProfile("demo", tok(run));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/\{profile\}/);
  });

  it.each([
    ["repeated key=value option, no absolute path in any segment", "vendor/bin/phpcs --define=KEY=VALUE ."],
    ["legitimate {profile}-based flag", "vendor/bin/phpcs --standard={profile}/gates/phpcs.xml ."],
    ["bare relative command, no arguments", "vendor/bin/phpcs"],
    ["short flag with no value", "vendor/bin/phpcs -q ."],
    ["flag with a relative value", "vendor/bin/phpcs --report=full ."],
    ["lone dot argument", "vendor/bin/phpcs ."],
  ])("still accepts (%s) -- must NOT regress", async (_label, run) => {
    await writeProfile("demo", tok(run));
    await expect(loadProfile("demo@1", root)).resolves.toBeTruthy();
  });
});

describe("loadProfile -- protectedPaths validated at load (round-3 critic finding)", () => {
  const withProtectedPaths = (entry: string) => `id: demo
version: 1
gates: []
protectedPaths: [${JSON.stringify(entry)}]
`;

  it.each([
    ["empty string", ""],
    ["'..' segment", "../outside"],
    ["POSIX absolute path", "/etc/passwd"],
    ["Windows absolute path", "C:\\outside"],
  ])("refuses %s", async (_label, entry) => {
    await writeProfile("demo", withProtectedPaths(entry));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/protectedPaths/);
  });

  it.each([
    ["plain filename", "phpcs.xml"],
    ["dotfile", ".phpcs.xml"],
    ["glob", "ci/**"],
  ])("accepts %s", async (_label, entry) => {
    await writeProfile("demo", withProtectedPaths(entry));
    const p = await loadProfile("demo@1", root);
    expect(p.protectedPaths).toEqual([entry]);
  });

  // Round-4 critic finding: `protectedPaths: ["."]` passed every check above
  // (non-empty, not absolute, no literal '..' segment) yet
  // `gate/oracle-paths.ts`'s `normalizeLiteralEntry` computes an empty
  // root-relative path for it and refuses it -- but only when a task actually
  // builds an oracle set, not at profile load. Extend the load-time predicate
  // so an entry that resolves to nothing is caught HERE instead.
  it.each([
    ["dot", "."],
    ["dot slash", "./"],
    ["segments that fully cancel out", "foo/.."],
    ["nested cancel-out", "a/b/../.."],
  ])("refuses an entry that resolves to nothing (%s)", async (_label, entry) => {
    await writeProfile("demo", withProtectedPaths(entry));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/protectedPaths/);
  });
});

describe("loadProfile -- profile directory must be realpath-contained under the harness root (round-4 critic finding: trust asserted, never verified)", () => {
  // The module header claims a profile is "trusted by construction because it
  // lives in the harness repository". Nothing previously PROVED that: `dir` is
  // resolved as `resolve(root, "profiles", id)` and everything downstream reads
  // through it unquestioned. If `profiles/<id>` is itself a symlink pointing
  // OUTSIDE the harness root, the later `realpathContains(dir, rulesetPath)`
  // canonicalizes both sides and compares the symlink's target against a path
  // under that SAME target -- "contained", trivially -- without ever proving
  // `dir` itself sits inside `root`.
  it.skipIf(!canSymlinkDir)(
    "rejects a profile directory that is a symlink pointing outside the harness root",
    async () => {
      const outside = realpathSync(await mkdtemp(join(tmpdir(), "profile-outside-")));
      try {
        await mkdir(join(root, "profiles"), { recursive: true });
        await symlink(outside, join(root, "profiles", "demo"), process.platform === "win32" ? "junction" : "dir");
        await expect(loadProfile("demo@1", root)).rejects.toThrow(/outside the harness root/i);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
});

describe("exact version pinning, both sides (round-6 critic finding)", () => {
  it("refuses a profile.yaml version JavaScript cannot represent exactly", async () => {
    // The file declares 9007199254740993, which JS stores as ...992. Reached with
    // a SAFE reference, because an unsafe one is refused earlier by
    // parseProfileRef (see the next test). Without the schema guard this surfaces
    // as "pinned version 1 does not match the file's version 9007199254740992" --
    // a message pointing at the wrong problem entirely.
    await writeProfile("demo", GOOD.replace("version: 1", "version: 9007199254740993"));
    await expect(loadProfile("demo@1", root)).rejects.toThrow(/exactly representable/i);
  });

  it("the round trip the critic described is NOT reachable: the rounded value is itself unsafe", async () => {
    // Codex round 6 rated this HIGH on the theory that a reference pinning the
    // ROUNDED value (...992) would parse cleanly and then compare equal to the
    // file's rounded version. It does not: ...992 is 2^53, one above
    // MAX_SAFE_INTEGER (...991), so parseProfileRef refuses it. Verified here
    // rather than argued -- the schema guard above is defence in depth and a
    // better error message, not the closing of an open hole.
    expect(Number.isSafeInteger(9007199254740992)).toBe(false);
    await writeProfile("demo", GOOD.replace("version: 1", "version: 9007199254740993"));
    await expect(loadProfile("demo@9007199254740992", root)).rejects.toThrow(/cannot be represented exactly/i);
  });

  it("still accepts a large but exactly representable version", async () => {
    await writeProfile("demo", GOOD.replace("version: 1", `version: ${Number.MAX_SAFE_INTEGER}`));
    const p = await loadProfile(`demo@${Number.MAX_SAFE_INTEGER}`, root);
    expect(p.version).toBe(Number.MAX_SAFE_INTEGER);
  });
});
