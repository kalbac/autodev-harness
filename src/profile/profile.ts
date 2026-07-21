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
import { globMatch, normalizePath } from "../util/glob.js";
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
 * What a profile gate should do for one task's changed-file set.
 *
 * `skipped` is a first-class outcome rather than "run it with no files": handing
 * phpcs an empty path list makes it scan the WHOLE TREE, which is precisely the
 * failure diff-scoping exists to prevent, so the distinction cannot be collapsed.
 */
export type GateInvocation = { skipped: true; reason: string } | { skipped: false; command: string };

/**
 * Decide how to invoke one gate against this task's changed files — the whole of
 * the diff-scoping decision, deliberately kept OUT of the composition root. That
 * file is untested glue by design (docs/gotchas/conductor-wiring-deferred-limitations.md),
 * and this is not glue: it decides whether a gate runs at all and over what, which
 * is exactly the kind of judgement that must be pinned by tests.
 */
export function prepareGateInvocation(gate: ResolvedGate, changedFiles: string[]): GateInvocation {
  if (gate.filesGlob === null) return { skipped: false, command: gate.run };

  const glob = gate.filesGlob;
  const matched = changedFiles.filter((f) => globMatch(normalizePath(glob), normalizePath(f)));
  if (matched.length === 0) {
    return { skipped: true, reason: `no changed file matches '${glob}'` };
  }

  // A path containing whitespace cannot survive the whitespace-tokenizing command
  // runner: it would reach the tool as two broken arguments, exit non-zero, and be
  // read as a RED gate -- looping the worker over a defect that is not in the code.
  // Refuse instead, so the conductor escalates it as the environment problem it is
  // (same fail-closed direction as loadProfile's profile-dir whitespace check).
  const spaced = matched.find((f) => /\s/.test(f));
  if (spaced !== undefined) {
    throw new Error(
      `profile gate '${gate.id}': changed file '${spaced}' contains whitespace, which cannot be passed ` +
        `through the whitespace-split command runner -- refusing rather than running a mangled command`,
    );
  }

  return { skipped: false, command: gate.run.split("{files}").join(matched.join(" ")) };
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

  // `{profile}` is expanded now (the profile directory is known); `{files}` is NOT
  // (the changed-file set does not exist until a task has run) -- see ResolvedGate.
  const gates: ResolvedGate[] = pf.gates.map((g) => ({
    id: g.id,
    run: g.run.split("{profile}").join(dir),
    filesGlob: g.files ?? null,
  }));

  // The two halves of diff-scoping must agree, and a mismatch in EITHER direction
  // is silently wrong rather than loudly broken, which is why both are refused
  // here. A `run` with `{files}` but no `files:` glob would ship the literal text
  // "{files}" to the tool as an argument (phpcs would report "the file {files}
  // does not exist" -> non-zero -> read as a RED gate, looping the worker on a
  // profile bug). A `files:` glob with no `{files}` in `run` is the more dangerous
  // one: the gate would silently run WHOLE-TREE while its author believed it was
  // diff-scoped -- exactly the 7069-vs-8 failure that made diff-scoping necessary,
  // reintroduced by a typo.
  for (const g of gates) {
    const mentionsFiles = g.run.includes("{files}");
    if (mentionsFiles && g.filesGlob === null) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' uses '{files}' but declares no 'files:' glob -- ` +
          `the placeholder would be passed to the tool verbatim`,
      );
    }
    if (!mentionsFiles && g.filesGlob !== null) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' declares a 'files:' glob but its 'run' never uses ` +
          `'{files}' -- the gate would silently run whole-tree while reading as diff-scoped`,
      );
    }
  }

  // Probe, don't trust: a gate referencing a ruleset the profile forgot to ship
  // must fail LOUD here, at load time, as broken operator config -- not surface
  // later as a non-zero gate exit that step 1d reads as a worker-fixable RED and
  // RETRYs forever on code that was never the problem. Only {profile}-derived
  // tokens are checked (matched by literal substring against the expanded `dir`,
  // which is what the {profile} substitution above actually produced): a
  // worktree-relative token like "vendor/bin/phpcs" or "." legitimately does not
  // exist yet (the worktree is created later, `vendor` is provisioned per task),
  // so checking those would fail-close on a perfectly good profile. Splitting on
  // whitespace to find those tokens is safe, not merely convenient -- the
  // whitespace check above already refused any profile `dir` containing a space,
  // so a {profile}-derived token can never itself contain one.
  for (const g of gates) {
    for (const token of g.run.split(/\s+/)) {
      const at = token.indexOf(dir);
      if (at === -1) continue; // not {profile}-derived
      const rulesetPath = token.slice(at); // drop a leading "--standard=" / "-c" flag prefix
      let st;
      try {
        st = await stat(rulesetPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new Error(
            `profile ${JSON.stringify(ref)}: gate '${g.id}' references '${rulesetPath}', which the profile ` +
              `did not ship -- a missing ruleset is broken operator config, not a worker-fixable failure`,
          );
        }
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' references '${rulesetPath}', which could not be ` +
            `probed (${code ?? "unknown fs error"})`,
        );
      }
      if (!st.isFile()) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' references '${rulesetPath}', which is not a regular file`,
        );
      }
    }
  }

  return { id, version, dir, gates, protectedPaths: pf.protectedPaths, provision: pf.requires.provision };
}
