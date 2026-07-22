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
import { canonicalPathContains, realpathContains } from "../util/path-contain.js";
import { ProfileFileSchema, isAbsoluteOnAnyPlatform, type ResolvedProfile, type ResolvedGate } from "./schema.js";

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
 * The version text after '@': canonical decimal digits only, no leading zero
 * (round-5 critic finding, leading-zero decision). "01" and "1" would parse to
 * the identical `Number`, so accepting both would mean two different-looking
 * references silently pin the same profile version -- an ambiguity this
 * module refuses rather than silently normalizes away, the same way `PROFILE_ID`
 * above refuses more than one spelling of the same id. "0" alone is
 * syntactically accepted by this regex; `profile.yaml`'s
 * `z.number().int().positive()` is what actually refuses a non-positive
 * version, so there is no need to duplicate that rule here.
 */
const VERSION_TEXT = /^(0|[1-9][0-9]*)$/;

/**
 * The only prefix a `{profile}`-derived command token may carry: a flag-SHAPED
 * string ending in `=`, e.g. `--standard=`, `-c=`, `--some_flag=`, `--some.flag=`.
 *
 * This is deliberately a FLAG shape, not "the prefix ends with `=`". That weaker
 * rule was the round-2 critic finding: `={profile}/gates/phpcs.xml` ends with `=`,
 * so it validated, while the runner received the malformed argument
 * `=<dir>/gates/phpcs.xml` -- a narrower instance of exactly the
 * validate-one-string-run-another bug the check was added to close. "Ends with a
 * character a flag happens to end with" is not proof of a flag; requiring the
 * whole prefix to BE one is.
 *
 * Honesty about what this regex actually checks (round-3 finding): it is a
 * deliberately LOOSE flag-shaped check, not a validator of any one tool's option
 * grammar. Its only job is to reject prefixes that are NOT flag-like at all (a
 * bare `=`, an arbitrary word, a flag missing its `=`) -- it still accepts
 * oddities a strict CLI grammar would refuse, such as `--some-=` or `-123=`. That
 * is fine: this check exists to catch the validate-one-string-run-another class of
 * bug above, not to police flag-naming conventions no tool here actually enforces.
 * `_` and `.` are included in the allowed body characters because real CLI tools
 * legitimately define flags like `--some_flag=` and `--some.flag=`; the name must
 * still start with an alphanumeric and the whole prefix must end with `=`.
 */
const FLAG_PREFIX = /^--?[A-Za-z0-9][A-Za-z0-9._-]*=$/;

/**
 * Parse `"<id>@<version>"`. The id charset is restrictive on purpose: it is
 * concatenated into a filesystem path, so a separator or a `..` segment would let
 * a config reference resolve a "profile" from outside the harness tree.
 */
export function parseProfileRef(ref: string): { id: string; version: number } {
  const at = ref.lastIndexOf("@");
  const id = at === -1 ? "" : ref.slice(0, at);
  const versionText = at === -1 ? "" : ref.slice(at + 1);
  if (!PROFILE_ID.test(id) || !VERSION_TEXT.test(versionText)) {
    throw new Error(
      `invalid profile reference ${JSON.stringify(ref)} -- expected "<id>@<version>" with a lowercase ` +
        `id ([a-z0-9-], no path separators) and an integer version, e.g. "wordpress-woocommerce@1"`,
    );
  }
  const version = Number(versionText);
  // round-5 critic finding: `Number(versionText)` silently rounds any digit
  // string above Number.MAX_SAFE_INTEGER, so "demo@9007199254740993" would
  // become the SAME number as "demo@9007199254740992" and a profile.yaml
  // declaring that rounded value would satisfy `pf.version !== version` and
  // load below -- pinning a DIFFERENT version than the one the caller wrote,
  // while both sides believe they resolved exactly. Refuse rather than
  // resolve a reference this module cannot represent exactly.
  if (!Number.isSafeInteger(version)) {
    throw new Error(
      `invalid profile reference ${JSON.stringify(ref)} -- version '${versionText}' cannot be represented ` +
        `exactly as a number (must be a safe integer, i.e. <= ${Number.MAX_SAFE_INTEGER}); a profile version ` +
        `must be an exact integer, since a larger one can silently round to a different value`,
    );
  }
  return { id, version };
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
 * What a gate's exit code means, given what IT declared as its red codes.
 *
 * Pure and exported (not inlined into the composition root) because this is a
 * decision that must be pinned by tests, not untested glue --
 * `src/composition/root.ts` is deliberately untested (it spawns real processes),
 * so any judgement call that lives only there is a judgement call nobody is
 * checking.
 *
 * - `0` -> `"green"`: always, regardless of what the profile declared as red.
 * - exit code in `gate.redExitCodes` -> `"red"`: a genuine, worker-fixable finding.
 * - anything else -> `"unrunnable"`: the tool could not do its job at all (a
 *   processing error, a missing manifest, ...). This is NOT a code defect, so it
 *   must never fold into the RETRY path the way a red gate does -- the caller is
 *   expected to escalate instead (see `runProfileGates` in
 *   `src/composition/root.ts`, which throws on this outcome the same way a
 *   `runNative` ENOENT already does).
 */
export function classifyGateExit(gate: Pick<ResolvedGate, "redExitCodes">, exitCode: number): "green" | "red" | "unrunnable" {
  if (exitCode === 0) return "green";
  if (gate.redExitCodes.includes(exitCode)) return "red";
  return "unrunnable";
}

/**
 * Load, validate and expand the profile pinned by `ref`. `root` defaults to the
 * harness package root and is injectable for tests.
 */
export async function loadProfile(ref: string, root: string = harnessRoot()): Promise<ResolvedProfile> {
  const { id, version } = parseProfileRef(ref);
  const dir = resolve(root, "profiles", id);

  // Verify the trust claim in this module's header, don't just assert it
  // (round-4 critic finding). Everything below reads THROUGH `dir` -- `stat`,
  // `readFile`, and the ruleset probe's own `realpathContains(dir, rulesetPath)`
  // -- and that ruleset-probe check alone proves nothing about `dir` itself: it
  // canonicalizes BOTH sides, so if `profiles/<id>` is a symlink pointing
  // OUTSIDE `root`, a ruleset sitting under that same external target still
  // reads as "contained" relative to the symlink's target, never checking that
  // the target is inside `root` at all. Only skip the check when `dir` does not
  // exist yet (`existsSync` follows the symlink, so a dangling link also counts
  // as "not there"): that case must still fall through to the ordinary
  // 'not found' error below, not this one, and `realpathContains` cannot tell
  // "absent" apart from "escapes" on its own (it folds both into `false`).
  if (existsSync(dir) && !(await realpathContains(root, dir))) {
    throw new Error(
      `profile ${JSON.stringify(ref)}: profile directory '${dir}' resolves OUTSIDE the harness root '${root}' -- ` +
        `a profile is trusted by construction only because it lives inside the harness repository, and that is ` +
        `not true of a path that escapes it (e.g. via a symlink); refusing to load it`,
    );
  }

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

  // Refuse a hard-coded absolute path in the RAW `run` string, BEFORE
  // `{profile}` expansion (round-4 critic finding). A profile ships inside the
  // harness repo and runs on whatever machine the harness is installed on, so
  // an author who writes a literal absolute path -- `--standard=C:\somewhere\
  // phpcs.xml` -- instead of using `{profile}` has written something broken by
  // construction, not merely something the existing {profile}-derived-token
  // probe below happens not to cover (that probe only ever looks at tokens
  // that embed the EXPANDED `dir`). This MUST run before expansion: after
  // `{profile}` is substituted, every legitimate {profile}-derived token IS an
  // absolute path -- that is the whole point of the substitution -- so
  // checking post-expansion would refuse the good case along with the bad one.
  //
  // `isAbsoluteOnAnyPlatform` is imported from `./schema.js` rather than
  // duplicated a third time: `src/gate/oracle-paths.ts` has the canonical
  // (non-exported) version, `src/profile/schema.ts` already carries an
  // identical copy from the round-3 `protectedPaths`/`requires.provision`
  // fixes (now exported for this reuse) -- and `schema.ts` is a module
  // `profile.ts` already owns/imports, so there is no dependency-direction
  // reason left to keep a third copy.
  for (const g of pf.gates) {
    for (const token of g.run.split(/\s+/)) {
      if (token === "") continue;
      // Check EVERY '='-separated segment of the token, not just the text
      // after the FIRST '=' (round-5 critic finding). A flag-prefixed token
      // like `--define=KEY=C:\outside\x.xml` has TWO '=' signs, and
      // `--define=KEY=VALUE` (a repeatable key=value option) is a real CLI
      // shape, not a hypothetical spelling -- so an option's VALUE can itself
      // legitimately contain an assignment. This check's job is to catch an
      // absolute path ANYWHERE in the argument, not to parse any one tool's
      // option grammar, so every segment is a candidate, not only the last or
      // only the one right after the first '='. A token with no '=' at all
      // degenerates to a single segment (the whole token), which is exactly
      // the pre-existing bare-path behaviour.
      for (const segment of token.split("=")) {
        if (isAbsoluteOnAnyPlatform(segment)) {
          throw new Error(
            `profile ${JSON.stringify(ref)}: gate '${g.id}' run command '${g.run}' contains the hard-coded ` +
              `absolute path '${segment}' -- a profile ships inside the harness repo and runs on whatever machine ` +
              `the harness is installed on, so a baked-in absolute path is unportable by construction; use ` +
              `'{profile}' to reference a file the profile itself ships instead`,
          );
        }
      }
    }
  }

  // `{profile}` is expanded now (the profile directory is known); `{files}` is NOT
  // (the changed-file set does not exist until a task has run) -- see ResolvedGate.
  const gates: ResolvedGate[] = pf.gates.map((g) => ({
    id: g.id,
    run: g.run.split("{profile}").join(dir),
    filesGlob: g.files ?? null,
    // See ResolvedGate.redExitCodes for why the default is [1], not "any non-zero".
    redExitCodes: g.redExitCodes ?? [1],
    report: g.report ?? null,
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

    // 'report' cross-check. What CAN be verified at load time, honestly: we
    // cannot run the tool, so we cannot prove `run` truly makes it emit
    // `report` -- only a live run proves that (Task 7 of the plan). What we CAN
    // refuse is the obviously-broken combination: a gate that declares a report
    // format its own command never even ASKS the tool for. A command that never
    // mentions "checkstyle" anywhere cannot plausibly have been written to pass
    // e.g. `--report=checkstyle` -- the author almost certainly forgot the flag,
    // or copy-pasted a gate and only edited half of it. This is the same
    // "obviously broken, not exhaustively proven" spirit as the {files}/files:
    // cross-check above: a case-sensitive-lowercased substring search is
    // deliberately weak (it does not parse any tool's flag grammar, does not
    // check the flag is spelled `--report=`, and would be fooled by a command
    // that merely mentions "checkstyle" in a comment-like argument) -- widening
    // it to actually validate flag syntax would be false confidence: this
    // module has no way to know what flag shape a given tool expects. Refusing
    // the case where the format is not mentioned AT ALL is the one thing this
    // check can say for certain without running anything.
    if (g.report !== null && !g.run.toLowerCase().includes(g.report.toLowerCase())) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' declares 'report: ${g.report}' but its 'run' command ` +
          `('${g.run}') never mentions '${g.report}' -- this cannot prove the tool actually emits that format ` +
          `(only a live run can), but a gate that never asks the tool for it cannot possibly produce it either; ` +
          `add the tool's own report flag (e.g. '--report=${g.report}') to 'run', or remove 'report: ${g.report}'`,
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
  //
  // The probe must validate the SAME string the command runner will actually
  // receive as an argument, not just a suffix of the token. There are exactly two
  // shapes a {profile}-derived token can legitimately take: the bare path itself
  // (`<dir>/...`, `at === 0`) or a flag-prefixed form whose prefix ends with `=`
  // (`--standard=<dir>/...`). Anything else -- e.g. a token like
  // "prefix{profile}/gates/phpcs.xml" expanding to "prefix<dir>/gates/phpcs.xml"
  // -- is a malformed argument the runner would receive verbatim. Fail loud here
  // instead, naming both accepted shapes.
  //
  // THE NORMAL FORM (round-3 finding): a {profile}-derived token is
  // `<optional flag prefix><dir><separator><relative path>`, where the separator
  // is `/` or `\`, and the resolved path must remain INSIDE `dir`. Two gaps in an
  // earlier, narrower reading of that same sentence:
  //   (a) `token.indexOf(dir) === 0` only proves the token STARTS WITH the string
  //       `dir` -- it does not prove `dir` is a genuine path component. A sibling
  //       directory whose name shares `dir` as a prefix ('<dir>-evil/x.xml') or a
  //       token that is `dir` with an unrelated suffix ('<dir>extra') both satisfy
  //       it while naming something other than the profile directory. Requiring
  //       the character immediately after `dir` to be a path separator (checked
  //       below, before any path is built) closes this; it simultaneously refuses
  //       a token that IS `dir` with nothing after it, which names no file at all.
  //   (b) Even a token that legitimately continues with a separator can still
  //       resolve outside `dir` once `.`/`..` segments are collapsed
  //       (`<dir>/../outside.xml`) -- `at === 0` says nothing about that. Closed by
  //       verifying containment properly: a lexical check (`canonicalPathContains`,
  //       no filesystem access -- catches the `..` escape even for a path that
  //       does not exist yet) followed by a realpath check once the file is known
  //       to exist (`realpathContains` -- catches an intermediate symlinked
  //       ancestor whose real location is outside `dir`, which lexical resolution
  //       alone cannot see). This is the SAME lexical-then-realpath sequencing
  //       `src/gate/oracle-paths.ts` uses for the analogous oracle-path
  //       containment problem (`resolveTrustedFile` / `normalizeLiteralEntry`);
  //       `src/util/path-contain.ts` is the shared primitive both use.
  //
  // Splitting on whitespace to find {profile}-derived tokens is safe, not merely
  // convenient -- the whitespace check above already refused any profile `dir`
  // containing a space, so a {profile}-derived token can never itself contain one.
  for (const g of gates) {
    for (const token of g.run.split(/\s+/)) {
      const at = token.indexOf(dir);
      if (at === -1) continue; // not {profile}-derived
      const prefix = token.slice(0, at);
      if (at !== 0 && !FLAG_PREFIX.test(prefix)) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' token '${token}' embeds the profile directory in an ` +
            `unrecognized shape -- a {profile}-derived token must be either the bare path ('${dir}/...') or a ` +
            `flag-prefixed form ('--standard=${dir}/...', '-c=${dir}/...')`,
        );
      }

      // `dir` must be a genuine path component of the token, not merely a string
      // it starts with: the character right after it must be a separator. This
      // also refuses a token that IS `dir` with nothing following it.
      const afterDir = token.charAt(at + dir.length);
      if (afterDir !== "/" && afterDir !== "\\") {
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' token '${token}' embeds the profile directory '${dir}' ` +
            `with no path separator immediately after it -- a {profile}-derived token must continue with '/' or ` +
            `'\\' followed by a relative path, e.g. '${dir}/gates/phpcs.xml' (a token that is only '${dir}' with ` +
            `nothing after it names no file either)`,
        );
      }

      const rulesetPath = token.slice(at);

      // Lexical containment: collapses '.'/'..' segments without touching the
      // filesystem, so an escape like '{profile}/../outside.xml' is refused even
      // when a real file happens to sit at the escaped location.
      if (!canonicalPathContains(resolve(dir), resolve(rulesetPath))) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' references '${rulesetPath}', which resolves OUTSIDE ` +
            `the profile directory '${dir}' via a '..' path segment -- refusing to probe a path outside the profile`,
        );
      }

      // Deliberately `stat` (follows a symlink), not `lstat` like the
      // structurally similar probe in `src/gate/oracle-paths.ts` (round-4
      // critic finding: the divergence was real but undocumented, which reads
      // as an oversight rather than a decision -- comment only, no behaviour
      // change). `oracle-paths.ts` refuses ANY symlinked leaf outright because
      // it FINGERPRINTS the file's content across a worker's task: a worker
      // could repoint the link (or swap the target for a same-content file)
      // between the pre- and post- snapshot, and the hash would not move,
      // silently defeating the fence it is part of. Nothing here is
      // fingerprinted -- this probe only proves the ruleset file exists and is
      // a regular file ONCE, at profile-load time, before any task runs. A
      // ruleset that is a symlink pointing INWARD, to another file the profile
      // itself ships, is harmless to follow here. This is not a blanket claim
      // that symlinks are safe in this module in general -- FIX A above still
      // refuses the profile DIRECTORY itself being a symlink out of `root` --
      // only that this one probe has no content-integrity property for a
      // symlinked leaf to defeat.
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

      // Realpath containment, now that the file is known to exist: catches an
      // intermediate symlinked ancestor whose REAL location is outside `dir` even
      // though it lexically resolved inside it.
      if (!(await realpathContains(dir, rulesetPath))) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: gate '${g.id}' references '${rulesetPath}', which resolves OUTSIDE ` +
            `the profile directory '${dir}' via a symlink -- refusing to probe a path outside the profile`,
        );
      }
    }
  }

  return { id, version, dir, gates, protectedPaths: pf.protectedPaths, provision: pf.requires.provision };
}
