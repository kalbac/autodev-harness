# Profiles / WP-WC Qualification Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1 of the profile mechanism — a named, versioned, per-project-type proof pack (`profiles/wordpress-woocommerce@1`) that adds executable product gates and protected oracle paths to the existing machine gate, without adding any new enforcement stage.

**Architecture:** A profile is an **oracle source**, not a second judge. `profiles/<id>/profile.yaml` lives in the harness repo (trusted by construction — the worker's worktree is the *target* repo). At composition time the profile is loaded once; its `gates[]` become a new gate step **1d** (mirroring `agentCi`'s step 1c), its `protectedPaths` become a **fifth source** in `resolveOracleSet` (adr/006 Phase 2 machinery, inherited unchanged), and its `requires.provision` unions into the worktree provisioning list. `profile: null` (the default) makes every one of these paths byte-identically inert.

**Tech Stack:** TypeScript, ESM, Node ≥ 20, zod (config validation), `yaml` (profile parsing), vitest (tests). Gate commands run through the existing `splitCommand` + `runNative` pair.

**Spec:** `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md`

---

## Deviation from the spec, decided during planning

The spec's §1 says the work includes "a build step that copies `profiles/` into `dist/`". That step is **not needed** and is not in this plan, because profile resolution here is **package-root-based**, not module-relative: `harnessRoot()` walks up from `import.meta.url` to the nearest directory containing `package.json`, which yields the *same* absolute path whether the caller was loaded from `src/` (tsx) or from `dist/` (compiled). The critic schema needed a copy step precisely because its path is module-relative (`dist/critic/`).

The spec's actual *requirement* — "a test that resolves a profile through the dist path", so the feature cannot be green in tests and dead in the daemon — is kept in full (Task 3, Step 3). Amend the spec accordingly in Task 9.

## File structure

| File | Responsibility |
|---|---|
| `src/profile/schema.ts` (create) | zod schema for `profile.yaml` + the `ResolvedProfile`/`ResolvedGate` types |
| `src/profile/profile.ts` (create) | `harnessRoot()`, `parseProfileRef()`, `loadProfile()` — resolution + fail-closed validation + `{profile}` expansion |
| `src/profile/profile.test.ts` (create) | loader fail-closed matrix + dist-path resolution |
| `src/config/schema.ts` (modify) | new top-level `profile: string \| null` field |
| `src/gate/gate.ts` (modify) | `GateDeps.runProfileGates`, `GateVerdict.profile_green`, gate step 1d |
| `src/gate/oracle-paths.ts` (modify) | fifth oracle source: profile protected paths |
| `src/composition/root.ts` (modify) | load the profile once; wire step 1d, the oracle source, and the provision union |
| `profiles/wordpress-woocommerce/profile.yaml` (create) | the v1 WP/WC proof pack |
| `profiles/wordpress-woocommerce/gates/phpcs.xml` (create) | WPCS ruleset, shipped BY the profile |
| `profiles/wordpress-woocommerce/gates/phpstan.neon` (create) | PHPStan config, shipped BY the profile |

---

### Task 1: The `profile` config field

**Files:**
- Modify: `src/config/schema.ts:43-49` (top-level object, next to `stateDir`/`allowedBranchPattern`)
- Test: `src/config/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config/config.test.ts` (match the file's existing import/helper style — it already has a temp-repo helper; if it writes configs via a local `writeConfig(dir, yaml)` helper, reuse it rather than inlining `writeFile`):

```ts
describe("profile config field", () => {
  it("defaults to null when absent", async () => {
    const dir = await makeRepo("");
    const cfg = await loadConfig(dir);
    expect(cfg.profile).toBeNull();
  });

  it("carries an explicit profile reference through", async () => {
    const dir = await makeRepo('profile: "wordpress-woocommerce@1"\n');
    const cfg = await loadConfig(dir);
    expect(cfg.profile).toBe("wordpress-woocommerce@1");
  });
});
```

If `makeRepo` does not exist under that name in the file, use whatever the file's existing helper is called — do NOT introduce a second temp-repo helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/config.test.ts -t "profile config field"`
Expected: FAIL — `cfg.profile` is `undefined` (the key does not exist), and the explicit case fails config load entirely because the root schema is `.strict()`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, inside `HarnessConfigSchema`, immediately after `allowedBranchPattern`:

```ts
  // Attached qualification profile, as "<id>@<version>" (e.g.
  // "wordpress-woocommerce@1"). null = no profile = the whole profile contour is
  // inert (no gate step 1d, no extra oracle paths, no extra provisioning), byte-
  // identical to pre-profile behaviour. Same null-is-a-no-op shape as
  // gate.checkCommand. The reference is RESOLVED (and fail-closed validated) in
  // src/profile/profile.ts, not here: the schema only records the operator's
  // intent, it does not touch the filesystem.
  profile: z.string().nullable().default(null),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/config.test.ts -t "profile config field"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/config.test.ts
git commit -m "feat(profile): add the nullable 'profile' config field"
```

---

### Task 2: Profile file schema and the fail-closed loader

**Files:**
- Create: `src/profile/schema.ts`
- Create: `src/profile/profile.ts`
- Create: `src/profile/profile.test.ts`

The loader is the whole trust boundary of this feature, so it fails **closed** on every malformed input (Principle 10). Note what each rejection prevents — an id with a path separator would let `profile: "../../somewhere@1"` resolve a "profile" outside the harness tree.

- [ ] **Step 1: Write the failing tests**

Create `src/profile/profile.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { parseProfileRef, loadProfile } from "./profile.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/profile/profile.test.ts`
Expected: FAIL — `Cannot find module './profile.js'`.

- [ ] **Step 3: Write the schema**

Create `src/profile/schema.ts`:

```ts
import { z } from "zod";

/** One executable product gate declared by a profile. */
export const ProfileGateSchema = z
  .object({
    id: z.string().min(1),
    run: z.string().refine((s) => s.trim() !== "", { message: "gate 'run' must not be blank" }),
  })
  .strict();

/**
 * `profile.yaml` — the on-disk shape of a qualification profile.
 *
 * `.strict()` everywhere for the same reason the harness config root is strict
 * (docs/gotchas/zod-strip-unknown-keys-silent-config-revert.md): a profile that
 * declares a facet this version does not implement (`criticRubrics:`,
 * `release:`) must fail LOUDLY, never load with that facet silently dropped —
 * "qualified by <profile>" would otherwise claim proof that never ran.
 */
export const ProfileFileSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    requires: z
      .object({ provision: z.array(z.string()).default([]) })
      .strict()
      .default({ provision: [] }),
    gates: z.array(ProfileGateSchema).default([]),
    protectedPaths: z.array(z.string()).default([]),
  })
  .strict();

export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** A gate with `{profile}` already expanded to an absolute path. */
export interface ResolvedGate {
  id: string;
  run: string;
}

/** A profile that has been located, validated and expanded. */
export interface ResolvedProfile {
  id: string;
  version: number;
  /** Absolute path of `<harnessRoot>/profiles/<id>`. */
  dir: string;
  gates: ResolvedGate[];
  /** Worktree-relative oracle paths this profile protects. */
  protectedPaths: string[];
  /** Top-level dirs the profile needs linked into each worktree. */
  provision: string[];
}
```

- [ ] **Step 4: Write the loader**

Create `src/profile/profile.ts`:

```ts
/**
 * Profile resolution — the trust boundary of the qualification layer.
 *
 * A profile lives in the HARNESS repository (`<harnessRoot>/profiles/<id>/`), not
 * in the project under judgement: the worker only ever writes a per-task worktree
 * of the TARGET repo, so the two trees do not intersect and the profile is trusted
 * by construction. Everything here therefore fails CLOSED — a profile that cannot
 * be resolved exactly as pinned must stop the run, never degrade into "no profile"
 * (Principle 10), because a silently-absent profile means gates the operator
 * believes are running are not running at all.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ProfileFileSchema, type ResolvedProfile, type ResolvedGate } from "./schema.js";

/**
 * The harness package root — the directory holding `package.json`, walking up from
 * this module. Deliberately NOT module-relative: this resolves to the SAME
 * absolute path whether the caller was loaded from `src/` (tsx) or `dist/`
 * (compiled), so `profiles/` needs no dist copy step, unlike the module-relative
 * critic schema (docs/gotchas/critic-schema-json-not-copied-to-dist.md).
 */
export function harnessRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(cur, "package.json"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) {
      throw new Error("harnessRoot: walked to the filesystem root without finding package.json");
    }
    cur = parent;
  }
}

/** An id is one lowercase path segment: no separators, no dots, no traversal. */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse `"<id>@<version>"`. The id charset is restrictive on purpose: it is
 * concatenated into a filesystem path, so a separator or a `..` segment would let
 * a config reference resolve a "profile" from outside the harness tree.
 */
export function parseProfileRef(ref: string): { id: string; version: number } {
  const at = ref.lastIndexOf("@");
  const id = at === -1 ? "" : ref.slice(0, at);
  const versionText = at === -1 ? "" : ref.slice(at + 1);
  if (!PROFILE_ID.test(id) || !/^[0-9]+$/.test(versionText)) {
    throw new Error(
      `invalid profile reference ${JSON.stringify(ref)} -- expected "<id>@<version>" with a lowercase ` +
        `id ([a-z0-9-], no path separators) and an integer version, e.g. "wordpress-woocommerce@1"`,
    );
  }
  return { id, version: Number(versionText) };
}

/**
 * Load, validate and expand the profile pinned by `ref`. `root` defaults to the
 * harness package root and is injectable for tests.
 */
export async function loadProfile(ref: string, root: string = harnessRoot()): Promise<ResolvedProfile> {
  const { id, version } = parseProfileRef(ref);
  const dir = resolve(root, "profiles", id);

  if (/\s/.test(dir)) {
    throw new Error(
      `profile ${JSON.stringify(ref)} resolves to '${dir}', whose path contains whitespace -- gate commands are ` +
        `split on whitespace and are not quote-aware, so a '{profile}' expansion from here would produce broken ` +
        `arguments; install the harness at a path without spaces`,
    );
  }

  const file = join(dir, "profile.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`profile ${JSON.stringify(ref)} not found -- no readable '${file}'`);
    }
    throw new Error(`profile ${JSON.stringify(ref)}: '${file}' could not be read (${code ?? "unknown fs error"})`);
  }

  const parsed = ProfileFileSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`profile ${JSON.stringify(ref)}: invalid '${file}': ${issues}`);
  }
  const pf = parsed.data;

  if (pf.id !== id) {
    throw new Error(
      `profile ${JSON.stringify(ref)}: declared id '${pf.id}' does not match its directory name '${id}'`,
    );
  }
  if (pf.version !== version) {
    throw new Error(
      `profile ${JSON.stringify(ref)}: pinned version ${version} does not match the file's version ${pf.version}`,
    );
  }

  const gates: ResolvedGate[] = pf.gates.map((g) => ({ id: g.id, run: g.run.split("{profile}").join(dir) }));

  // Probe, don't trust: a gate referencing a ruleset the profile forgot to ship
  // would otherwise surface as an opaque tool error mid-run.
  const st = await stat(dir);
  if (!st.isDirectory()) {
    throw new Error(`profile ${JSON.stringify(ref)}: '${dir}' is not a directory`);
  }

  return { id, version, dir, gates, protectedPaths: pf.protectedPaths, provision: pf.requires.provision };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/profile/profile.test.ts`
Expected: PASS (all cases)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output

- [ ] **Step 7: Commit**

```bash
git add src/profile
git commit -m "feat(profile): fail-closed profile loader with {profile} expansion"
```

---

### Task 3: Prove resolution works from a compiled build

This task exists solely to defeat the failure mode named in the spec: green in tests, dead in the running daemon (`docs/gotchas/critic-schema-json-not-copied-to-dist.md`).

**Files:**
- Modify: `src/profile/profile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/profile/profile.test.ts`:

```ts
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
```

Add to the file's imports: `import { pathToFileURL } from "node:url";`, extend the existing `node:fs` import to `import { realpathSync, existsSync } from "node:fs";`, and add `harnessRoot` to the existing `./profile.js` import.

- [ ] **Step 2: Build, then run the test**

Run: `npm run build && npx vitest run src/profile/profile.test.ts -t "harnessRoot"`
Expected: PASS (2 tests). If the second fails with a path under `dist/`, the implementation drifted to module-relative resolution — fix `harnessRoot`, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add src/profile/profile.test.ts
git commit -m "test(profile): pin dist-path resolution parity"
```

---

### Task 4: Gate step 1d

**Files:**
- Modify: `src/gate/gate.ts` (`GateVerdict`, `GateDeps`, the empty-file_set fast path, and a new step after 1c)
- Test: `src/gate/gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/gate/gate.test.ts`, reusing the file's existing deps-builder helper (it already constructs a `GateDeps` with stub loaders — extend that helper's argument object rather than hand-rolling a new full `GateDeps`):

```ts
describe("profile gates (step 1d)", () => {
  it("is green and inert when no profile is attached", async () => {
    const v = await runGate(input, deps({ runProfileGates: null }));
    expect(v.profile_green).toBe(true);
    expect(v.reasons.some((r) => /profile gate/i.test(r))).toBe(false);
  });

  it("passes when every profile gate exits 0", async () => {
    const v = await runGate(
      input,
      deps({ runProfileGates: async () => [{ id: "phpcs", green: true, exitCode: 0 }] }),
    );
    expect(v.profile_green).toBe(true);
    expect(v.decision).toBe("COMMIT");
  });

  it("RETRYs and names the failing gate when one is red", async () => {
    const v = await runGate(
      input,
      deps({
        runProfileGates: async () => [
          { id: "phpcs", green: false, exitCode: 2 },
          { id: "phpstan", green: true, exitCode: 0 },
        ],
      }),
    );
    expect(v.profile_green).toBe(false);
    expect(v.decision).toBe("RETRY");
    expect(v.reasons).toContain("profile gate 'phpcs' FAILED (exit 2)");
  });

  it("propagates a gate that could not run at all", async () => {
    // A missing tool / absent vendor is an INFRA failure: not worker-fixable, so
    // it must escape runGate for the conductor to escalate -- never be folded
    // into a red verdict that loops the worker. Same contract as runAgentCi.
    await expect(
      runGate(input, deps({ runProfileGates: async () => { throw new Error("spawn phpcs ENOENT"); } })),
    ).rejects.toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gate/gate.test.ts -t "profile gates"`
Expected: FAIL — `runProfileGates` is not a known `GateDeps` key and `profile_green` is not on `GateVerdict`.

- [ ] **Step 3: Implement**

In `src/gate/gate.ts`, add to `GateVerdict` immediately after `agent_ci_green`:

```ts
  profile_green: boolean; // true when no profile is attached
```

Add to `GateDeps` immediately after `runAgentCi`:

```ts
  /** Optional qualification-profile gates (`profile:` in config). null = no profile attached.
   *  A RED gate is worker-fixable -> RETRY. A gate that could not RUN (missing tool, absent
   *  vendor, spawn ENOENT) must THROW out of runGate exactly like runAgentCi's infra failure --
   *  do NOT catch it here; the conductor escalates a gate throw as broken operator config. */
  runProfileGates: (() => Promise<{ id: string; green: boolean; exitCode: number }[]>) | null;
```

In the empty-file_set fast path verdict object, next to `agent_ci_green: true`, add:

```ts
      profile_green: true,
```

After step 1c (the `runAgentCi` block), add step 1d:

```ts
  // 1d. optional qualification-profile gates. null = no profile attached. A red
  // gate folds into the verdict exactly like a failed check command (worker-
  // fixable -> RETRY); a gate that could not run THROWS through, like 1c.
  let profileGreen = true;
  if (deps.runProfileGates !== null) {
    const results = await deps.runProfileGates();
    for (const r of results) {
      if (!r.green) {
        profileGreen = false;
        reasons.push(`profile gate '${r.id}' FAILED (exit ${r.exitCode})`);
      }
    }
  }
```

Then include `profile_green: profileGreen` in the returned verdict object, and fold it into the same decision expression that already combines `composerGreen`/`successGreen`/`agentCiGreen` — find that expression and add `&& profileGreen` to it, so a red profile gate produces RETRY by exactly the path a red check command does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gate/gate.test.ts`
Expected: PASS — the whole file, not just the new block. Every pre-existing `GateDeps` literal in the test file now needs `runProfileGates: null`; if the file has a deps-builder helper, defaulting it to `null` there fixes them all at once.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/gate/gate.ts src/gate/gate.test.ts
git commit -m "feat(gate): profile gate step 1d (red -> RETRY, unrunnable -> throw)"
```

---

### Task 5: Profile protected paths as the fifth oracle source

**Files:**
- Modify: `src/gate/oracle-paths.ts` (`resolveOracleSet` signature + a fifth source block)
- Test: `src/gate/oracle-paths.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/gate/oracle-paths.test.ts`, reusing the file's existing temp-repo helper:

```ts
describe("profile protected paths (source 5)", () => {
  it("adds a profile literal with a profile-attributed reason", async () => {
    const root = await makeRepo();                    // existing helper
    const set = await resolveOracleSet(cfg, raw, root, ["phpcs.xml"]);
    expect(set.literals).toContain("phpcs.xml");
    expect(set.sources.get("phpcs.xml")).toMatch(/profile/i);
  });

  it("classifies a profile glob into the glob arm", async () => {
    const root = await makeRepo();
    const set = await resolveOracleSet(cfg, raw, root, ["ci/**"]);
    expect(set.globs).toContain("ci/**");
    expect(set.literals).not.toContain("ci/**");
  });

  it("fails closed on an escaping profile path", async () => {
    const root = await makeRepo();
    await expect(resolveOracleSet(cfg, raw, root, ["../outside.xml"])).rejects.toThrow(/escapes/i);
  });

  it("changes nothing when the list is empty (default)", async () => {
    const root = await makeRepo();
    const withArg = await resolveOracleSet(cfg, raw, root, []);
    const without = await resolveOracleSet(cfg, raw, root);
    expect(withArg.literals).toEqual(without.literals);
    expect(withArg.globs).toEqual(without.globs);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gate/oracle-paths.test.ts -t "profile protected paths"`
Expected: FAIL — `resolveOracleSet` takes 3 arguments.

- [ ] **Step 3: Implement**

In `src/gate/oracle-paths.ts`, extend the signature (a defaulted 4th parameter, so every existing call site keeps compiling unchanged):

```ts
export async function resolveOracleSet(
  cfg: HarnessConfig,
  raw: Record<string, unknown>,
  root: string,
  profileProtectedPaths: string[] = [],
): Promise<OracleSet> {
```

Extend the doc comment's numbered source list with:

```
 *   5. The attached profile's `protectedPaths` — passed in by the composition root
 *      (a `string[]`, not a ResolvedProfile: `gate/` must not depend on `profile/`,
 *      the same dependency-direction rule this module already follows for
 *      `composition/`). Classified literal-or-glob like `constitutionPaths`. The
 *      profile itself needs no protection: it lives in the harness repo, which the
 *      worker's worktree never intersects.
```

Add after the `contract.constitutionPaths` block (source 4):

```ts
  // 5. profile protectedPaths -- same classification and fail-closed normalization
  // as source 4; only the attributed reason differs, so an escalation says which
  // profile demanded the protection.
  for (const entry of profileProtectedPaths) {
    if (classifyOracleEntry(entry) === "glob") {
      addGlob(entry, `profile protectedPaths: ${entry}`);
    } else {
      await addLiteral(entry, `profile protectedPaths: ${entry}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gate/oracle-paths.test.ts`
Expected: PASS (whole file — the pre-existing cases must be untouched)

- [ ] **Step 5: Commit**

```bash
git add src/gate/oracle-paths.ts src/gate/oracle-paths.test.ts
git commit -m "feat(gate): profile protectedPaths as the fifth oracle source"
```

---

### Task 6: Wire the profile at the composition root

**Files:**
- Modify: `src/composition/root.ts` — profile load (~line 392, right after `loadConfigWithRaw`), worktree provision union (~line 409), `gateDeps` (~line 456), `resolveProjectOracleSet` (~line 675)

`src/composition/root.ts` is untested glue by design (`docs/gotchas/conductor-wiring-deferred-limitations.md`), so this task is verified by typecheck + the full suite + the live proof in Task 8, not by new unit tests.

- [ ] **Step 1: Load the profile once**

Immediately after the `const { cfg, raw } = await loadConfigWithRaw(repoRoot);` line, add:

```ts
  // Qualification profile (spec 2026-07-22). Loaded ONCE per root build and fail-
  // closed: an unresolvable profile throws here rather than degrading to "no
  // profile", because gates the operator believes are running would otherwise
  // silently not run. null = not attached = every profile contour below is inert.
  const profile = cfg.profile === null ? null : await loadProfile(cfg.profile);
  if (profile !== null) {
    log("INFO", `profile attached: ${profile.id}@${profile.version} (${profile.gates.length} gate(s))`);
  }
```

Add the import at the top: `import { loadProfile } from "../profile/profile.js";`

Note the ordering constraint: `log` is created a few lines below `loadConfigWithRaw`. Place the `loadProfile` call after the `log` creation so the INFO line can be emitted, and keep it before `createWorktreeManager` (which consumes `profile.provision` in Step 2).

- [ ] **Step 2: Union the provisioning list**

Change the `createWorktreeManager` options:

```ts
  const worktree = createWorktreeManager(repoRoot, worktreesDir, {
    // Union, never override: a profile ADDS what its gates need (e.g. `vendor`)
    // to whatever the project already provisions. De-duplicated because the two
    // lists legitimately overlap.
    provision: [...new Set([...cfg.worktree.provision, ...(profile?.provision ?? [])])],
    log,
  });
```

- [ ] **Step 3: Wire gate step 1d**

Inside `gateDeps(wt)`, add after the `runAgentCi` property:

```ts
      // Profile gates run in the WORKTREE (that is the code under judgement),
      // while their rulesets come from the profile directory in the harness repo
      // (already absolute after `{profile}` expansion). runNative REJECTS on a
      // spawn ENOENT, so a missing tool propagates out of runGate as the infra
      // throw the conductor escalates -- exactly the contract gate.ts documents.
      runProfileGates:
        profile === null || profile.gates.length === 0
          ? null
          : async () => {
              const out: { id: string; green: boolean; exitCode: number }[] = [];
              for (const g of profile.gates) {
                const { c, a } = splitCommand(g.run);
                const r = await runNative(c, a, { cwd: wt.path });
                out.push({ id: g.id, green: r.exitCode === 0, exitCode: r.exitCode });
              }
              return out;
            },
```

- [ ] **Step 4: Feed the oracle source**

Change `resolveProjectOracleSet`:

```ts
  const resolveProjectOracleSet = (): Promise<OracleSet> =>
    resolveOracleSet(cfg, raw, repoRoot, profile?.protectedPaths ?? []);
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exit 0; the full suite green (1251+ tests). A failure in an unrelated gate test almost certainly means a `GateDeps` literal is missing `runProfileGates: null` — add it, do not relax the type.

- [ ] **Step 6: Commit**

```bash
git add src/composition/root.ts
git commit -m "feat(profile): wire profile gates, oracle paths and provisioning at the composition root"
```

---

### Task 7: The `wordpress-woocommerce@1` profile

**Files:**
- Create: `profiles/wordpress-woocommerce/profile.yaml`
- Create: `profiles/wordpress-woocommerce/gates/phpcs.xml`
- Create: `profiles/wordpress-woocommerce/gates/phpstan.neon`
- Create: `profiles/README.md`

- [ ] **Step 1: Write the profile**

`profiles/wordpress-woocommerce/profile.yaml`:

```yaml
# WordPress / WooCommerce qualification profile, v1.
#
# The harness proves the PROCESS; this profile proves the PRODUCT. Every ruleset
# referenced below ships INSIDE this directory: a gate that invoked a project
# script (`composer check:static`) would let the repo under judgement define its
# own standard of quality -- the oracle owned by the defendant, which is exactly
# what adr/006 exists to prevent.
#
# v1 is deliberately STATIC only. PHPUnit / wp-env / Plugin Check / HPOS need
# Docker and cannot run on a native-Windows polygon
# (docs/gotchas/agent-ci-not-runnable-on-native-windows.md), where they would
# escalate infra on every single run. Static tools over a junctioned `vendor` are
# proven to work (docs/gotchas/vendor-junction-composer-autoload-basedir.md) --
# which is why the set is shaped this way and not out of modesty.
id: wordpress-woocommerce
version: 1

requires:
  provision: [vendor]

gates:
  - id: composer-validate
    run: "composer validate --no-check-publish --no-check-all"
  - id: phpcs
    run: "vendor/bin/phpcs -q --report=summary --standard={profile}/gates/phpcs.xml ."
  - id: phpstan
    run: "vendor/bin/phpstan analyse -c {profile}/gates/phpstan.neon --no-progress --error-format=raw"

# Project-local analyzer configs. They are protected rather than merely ignored:
# the gates above pass explicit --standard/-c paths, so a project-local ruleset
# cannot override them -- but a worker CREATING one is an attempt to substitute
# the oracle, and the Phase-2 fence registers exactly that (an absent literal
# fingerprints as "<absent>", so its appearance is drift).
protectedPaths:
  - phpcs.xml
  - phpcs.xml.dist
  - .phpcs.xml
  - .phpcs.xml.dist
  - phpstan.neon
  - phpstan.neon.dist
```

- [ ] **Step 2: Write the rulesets**

`profiles/wordpress-woocommerce/gates/phpcs.xml`:

```xml
<?xml version="1.0"?>
<ruleset name="autodev-harness WP/WC profile v1">
  <description>WordPress coding standards, shipped by the profile so the project cannot soften them.</description>

  <arg name="extensions" value="php"/>
  <arg name="colors"/>
  <arg value="p"/>

  <exclude-pattern>*/vendor/*</exclude-pattern>
  <exclude-pattern>*/node_modules/*</exclude-pattern>
  <exclude-pattern>*/tests/*</exclude-pattern>

  <rule ref="WordPress-Core"/>
  <rule ref="WordPress-Docs"/>
</ruleset>
```

`profiles/wordpress-woocommerce/gates/phpstan.neon`:

```neon
# Level 5 is the v1 bar: high enough to catch real type/undefined-symbol defects,
# low enough that a legacy WP plugin is not drowned in noise the worker cannot fix.
parameters:
    level: 5
    paths:
        - .
    excludePaths:
        analyse:
            - vendor
            - node_modules
            - tests
```

- [ ] **Step 3: Write the directory README**

`profiles/README.md`:

```markdown
# Profiles — per-project-type qualification packs

A profile is a **named, versioned proof pack for a project type**. The harness
proves the *process* (an independent critic + a mechanical gate decided this diff
may pass); a profile proves the *product* (this artifact meets its type's bar).

Attach one from a project's `.autodev/config.yaml`:

```yaml
profile: "wordpress-woocommerce@1"
```

## Why profiles live here and not in the project

The worker only ever writes a per-task worktree of the *target* repository. This
directory is in the *harness* repository, so the two trees never intersect and a
profile is worker-immutable by construction — the Phase-3 requirement of
`docs/adr/006-capability-based-authority-model.md`.

**One consequence to remember:** if the harness is ever run *on itself*, this
directory becomes an ordinary project directory that the worker CAN write, and it
must then be listed in `contract.constitutionPaths` — otherwise the authority
model becomes self-authorizing.

## Contract

- `gates[]` — executable product checks. Red → RETRY (worker-fixable); unrunnable
  → the gate throws → the conductor escalates. Rulesets ship *inside* the profile
  and are referenced through `{profile}`, which expands to this directory's
  absolute path. Never invoke a project script: that would hand the standard of
  quality to the repo under judgement.
- `protectedPaths[]` — oracle paths, fed into the `adr/006` Phase-2 fence.
- `requires.provision[]` — top-level dirs to link into each worktree, unioned with
  the project's own `worktree.provision`.
- **Union only, no selective disable.** A profile with gates plucked out is not
  that profile, and "qualified by `<id>@<version>`" would stop meaning anything.
  The escape hatch is blunt on purpose: don't attach the profile.

## Related

- `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md`
- `docs/adr/006-capability-based-authority-model.md`
- `docs/PRINCIPLES.md` #14, #15
```

- [ ] **Step 4: Verify the profile actually loads**

Run:

```bash
node --input-type=module -e "import{loadProfile}from'./dist/profile/profile.js';const p=await loadProfile('wordpress-woocommerce@1');console.log(JSON.stringify(p,null,2));"
```

Expected: JSON with three gates whose `run` strings contain the **absolute** profile path and no `{profile}` placeholder. Run `npm run build` first if `dist/` is stale.

- [ ] **Step 5: Commit**

```bash
git add profiles/
git commit -m "feat(profile): ship the wordpress-woocommerce@1 qualification profile"
```

---

### Task 8: Live proof on `woodev-shipping-plugin-test`

Principle 13 — evidence, not assertion. In this project unit tests have twice been vacuously green where only a live run caught the defect (`agent-ci-ndjson-keyed-by-event-not-type`, `launch-marker-needs-prompt-contract`), so all three directions below are mandatory.

**Polygon:** `D:\Projects\wordpress\woodev-shipping-plugin-test`, branch `autodev/main`, registry `C:\Users\maksi\.autodev\projects.json`.

- [ ] **Step 1: Prepare the polygon**

```bash
cd /d/Projects/wordpress/woodev-shipping-plugin-test
git status --porcelain      # must be empty
composer require --dev wp-coding-standards/wpcs phpstan/phpstan szepeviktor/phpstan-wordpress --no-interaction
vendor/bin/phpcs --config-set installed_paths vendor/wp-coding-standards/wpcs
```

Then edit its `.autodev/config.yaml`:

```yaml
profile: "wordpress-woocommerce@1"
worktree:
  provision: [vendor]
gate:
  agentCi:
    enabled: false        # native Windows: agent-ci escalates infra on every run
```

Record the original `agentCi.enabled` value — Step 5 restores it.

- [ ] **Step 2: Direction 2 first — a clean task must COMMIT**

Prove the feature works before proving it blocks; a red-only proof cannot distinguish "the gate works" from "the gate is broken and fails everything".

```bash
cd /d/Projects/autodev-harness && npm run build
cd /d/Projects/wordpress/woodev-shipping-plugin-test
node /d/Projects/autodev-harness/dist/index.js run --once
```

Run in the FOREGROUND — a bash-background run kills the nested worker spawn
(`docs/gotchas/orchestrate-background-run-killed.md`).

Expected: the task reaches DONE with a real commit; `.autodev/runtime/<task>/gate-verdict.json` has `"profile_green": true`; `conductor.log` shows `profile attached: wordpress-woocommerce@1 (3 gate(s))`. Record the commit SHA.

- [ ] **Step 3: Direction 1 — a WPCS violation must RETRY**

Enqueue a task whose change violates WPCS (e.g. Yoda-condition / spacing / missing docblock in a touched file).

Expected: `gate-verdict.json` has `"profile_green": false`, `reasons` contains `profile gate 'phpcs' FAILED (exit N)`, decision RETRY. Capture the reason line verbatim.

- [ ] **Step 4: Direction 3 — touching `phpcs.xml` must escalate before the critic**

Enqueue a task whose `file_set` contains `phpcs.xml`.

Expected: a `constitution` escalation naming the profile as the source
(`profile protectedPaths: phpcs.xml`), raised **before** the critic — verify **no
`critic-verdict.json` exists** in that task's runtime dir. That absence is the
evidence the fence ran pre-critic; a present file means the ordering regressed.

- [ ] **Step 5: Restore the polygon**

Restore the recorded `agentCi.enabled` value, leave `profile:` attached, and confirm `git status --porcelain` is clean (`.autodev` is git-excluded, so runtime churn does not dirty the tree).

- [ ] **Step 6: Commit the evidence**

Write the three outcomes (commit SHA, verbatim reason line, escalation body + the absent `critic-verdict.json`) into the session log entry in Task 9. No code commit here.

---

### Task 9: Docs, critic gate, PR

- [ ] **Step 1: Amend the spec's dist-copy paragraph**

In `docs/superpowers/specs/2026-07-22-profiles-wp-wc-qualification-layer-design.md` §1, replace the asset-copy sentence with the package-root resolution decision (see "Deviation from the spec" at the top of this plan). Keep the dist-path *test* requirement as-is.

- [ ] **Step 2: Independent critic review — MANDATORY, model PINNED**

Dispatch the `codex:codex-rescue` subagent with `--model gpt-5.6-luna` over the full diff. Budget for multiple rounds: `adr/006` Phase 1 took four and Phase 2 took six, each finding a narrower leak inside the previous round's own fix. Re-critic every in-place fix — never self-certify (Principle 6). A finding may be DECLINED only with a rationale verified against the real code, and note `docs/gotchas/codex-inline-diff-strips-quotes-false-blocker.md`: a doubled comma or a "syntactically invalid" blocker on code that typechecks and ran is the known false positive.

- [ ] **Step 3: Record the gotcha**

Add a `docs/gotchas/<slug>.md` for whatever the critic rounds and the live proof actually surfaced, plus its index row in `docs/GOTCHAS.md`, and bump the count in that file's header (73 → 74).

- [ ] **Step 4: Update the live docs**

- `docs/CURRENT-STATE.md` — **replace** the s50 "What s50 delivered" block with the s51 one; do not append a second block beside it.
- `docs/SESSION-LOG.md` — prepend a 10–20 line s51 entry.
- `docs/adr/006-capability-based-authority-model.md` — mark Phase 3 as landed in the Profiles work.

- [ ] **Step 5: Full verification before the PR**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: typecheck exit 0, full suite green, build clean. Do not open the PR on anything less.

- [ ] **Step 6: Push, PR, merge**

```bash
git push -u origin feat/profiles-wp-wc-qualification-layer
gh pr create --title "feat(profile): Profiles / WP-WC Qualification Layer v1 (s51)" --body "..."
```

Wait for green CI, then merge (standing overnight grant, `AGENTS.md`: gate + green CI, no waiting on the operator).
