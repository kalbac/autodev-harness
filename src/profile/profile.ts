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
import { readFile, stat, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { globMatch, normalizePath } from "../util/glob.js";
import { canonicalPathContains, realpathContains } from "../util/path-contain.js";
import {
  ProfileFileSchema,
  isAbsoluteOnAnyPlatform,
  isInvalidRulesetEntry,
  type ResolvedProfile,
  type ResolvedGate,
} from "./schema.js";

/**
 * A project's override of one or more overridable profile gate rulesets —
 * `adr/010`. `repoRoot` is the anchor a `gateRulesets` entry resolves against
 * (the project's own trusted root, NOT the profile directory `{profile}` uses);
 * `gateRulesets` mirrors `HarnessConfig.contract.gateRulesets` (gate id -> a path
 * relative to `repoRoot`) exactly, so `src/composition/root.ts` can pass
 * `cfg.contract.gateRulesets` straight through without reshaping it.
 *
 * Optional on `loadProfile` (not required) because a profile can be loaded with
 * no project attached at all (every existing test in this file, and every
 * profile lookup that predates `adr/010`) — omitting it must be byte-identical
 * to every gate resolving its own profile-declared default, which is exactly
 * what "no project declares an override" means.
 */
export interface RulesetOverrides {
  repoRoot: string;
  gateRulesets: Record<string, string>;
}

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
 * Shared containment probe for an absolute `candidatePath` that must sit inside
 * `anchor` and be a real, readable regular file — the identical discipline the
 * `{profile}`-derived-token probe below always used, extracted so it has exactly
 * ONE implementation instead of two that could quietly diverge
 * (`docs/gotchas/validated-one-string-used-another.md`: a value checked against
 * one root and used against a different one is this repo's most recurring
 * defect shape). `adr/010` needs the identical three properties — lexical
 * containment, "is a regular file", realpath containment — proven against a
 * SECOND possible anchor (a project's own `repoRoot`, when it overrides a
 * gate's ruleset), so the anchor became a parameter rather than staying the
 * token probe's hard-coded `dir`.
 *
 * `anchorLabel` names the anchor in a thrown message ("the profile directory",
 * "the project's repo root") so an operator learns WHICH root a path escaped,
 * not merely that it escaped something. `subject` is the sentence fragment
 * naming what is being probed (e.g. `gate 'phpcs' references`); the caller
 * supplies it complete because the two callers describe the same failure in
 * different voices (a profile's own shipped file vs a project's declaration).
 * `missingClause` fills in what "does not exist" means for that caller (a
 * profile's ruleset "was not shipped" by the profile author; a project's
 * ruleset override "does not exist in the project").
 *
 * `refuseSymlinkLeaf`, when true, throws on ANY symlinked final path component
 * before even statting it — the treatment `adr/010`'s fail-closed table
 * requires for a PROJECT's ruleset declaration (a symlink is its own listed
 * failure, distinct from an escaping intermediate symlink, which the realpath
 * check below still catches either way). The `{profile}`-derived-token probe
 * deliberately keeps its long-standing tolerance for an INWARD-pointing
 * symlink here (see its own call site below for why that tolerance is still
 * correct for the profile's own shipped files) by passing `false`.
 */
async function assertContainedRegularFile(
  anchor: string,
  candidatePath: string,
  anchorLabel: string,
  subject: string,
  missingClause: string,
  refuseSymlinkLeaf: boolean,
): Promise<void> {
  // Lexical containment first: collapses '.'/'..' segments without touching the
  // filesystem, so an escape like '<anchor>/../outside.xml' is refused even when
  // a real file happens to sit at the escaped location.
  if (!canonicalPathContains(resolve(anchor), resolve(candidatePath))) {
    throw new Error(
      `${subject} '${candidatePath}', which resolves OUTSIDE ${anchorLabel} '${anchor}' via a '..' path segment -- refusing to probe a path outside it`,
    );
  }

  if (refuseSymlinkLeaf) {
    // `lstat` (does NOT follow the link) so a symlinked leaf is caught before the
    // regular `stat` below would silently follow it to whatever it points at.
    // Mirrors `gate/oracle-paths.ts`'s `normalizeLiteralEntry`, which refuses an
    // oracle literal that is a symlink for the identical reason: the fence's
    // trust in a project-declared path is narrower than its trust in a file the
    // profile itself ships, so a symlink standing in for that file -- even one
    // that happens to point somewhere harmless today -- is refused outright
    // rather than judged by where it currently resolves.
    let lst;
    try {
      lst = await lstat(candidatePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`${subject} '${candidatePath}', which ${missingClause} -- a missing declaration is broken operator config, not a worker-fixable failure`);
      }
      throw new Error(`${subject} '${candidatePath}', which could not be probed (${code ?? "unknown fs error"})`);
    }
    if (lst.isSymbolicLink()) {
      throw new Error(
        `${subject} '${candidatePath}', which is a SYMLINK -- a project-declared ruleset must be a real file, not a link standing in for one (adr/010)`,
      );
    }
  }

  let st;
  try {
    st = await stat(candidatePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`${subject} '${candidatePath}', which ${missingClause} -- a missing declaration is broken operator config, not a worker-fixable failure`);
    }
    throw new Error(`${subject} '${candidatePath}', which could not be probed (${code ?? "unknown fs error"})`);
  }
  if (!st.isFile()) {
    throw new Error(`${subject} '${candidatePath}', which is not a regular file`);
  }

  // Realpath containment, now that the file is known to exist: catches an
  // intermediate symlinked ancestor whose REAL location is outside `anchor` even
  // though it lexically resolved inside it.
  if (!(await realpathContains(anchor, candidatePath))) {
    throw new Error(
      `${subject} '${candidatePath}', which resolves OUTSIDE ${anchorLabel} '${anchor}' via a symlink -- refusing to probe a path outside it`,
    );
  }
}

/**
 * Load, validate and expand the profile pinned by `ref`. `root` defaults to the
 * harness package root and is injectable for tests. `overrides`, when supplied
 * (`adr/010`), lets a project point one or more overridable gates at its OWN
 * ruleset instead of the profile's default -- see `RulesetOverrides` and the
 * `{ruleset}` resolution step near the end of this function for the fail-closed
 * rules governing it. Omitted entirely, every gate resolves its own
 * profile-declared default exactly as before `adr/010` existed.
 */
export async function loadProfile(
  ref: string,
  root: string = harnessRoot(),
  overrides?: RulesetOverrides,
): Promise<ResolvedProfile> {
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
    ruleset: g.ruleset ?? null,
    // Placeholders, correct ONLY when `ruleset` above is `null` -- overwritten by
    // the `{ruleset}` resolution step near the end of this function for every
    // gate that actually declared one. See `ResolvedGate.rulesetSource`/
    // `rulesetPath` for why these two specific placeholder values are safe to
    // leave un-consulted rather than modelling "not yet resolved" as a third
    // state: the cross-check just below guarantees a gate with `ruleset === null`
    // can never have `{ruleset}` in `run` to substitute these into.
    rulesetSource: "profile",
    rulesetPath: "",
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

    // 'ruleset' cross-check -- adr/010, the same discipline and the same reason as
    // the {files}/files: pair above: a mismatch in EITHER direction is silently
    // wrong rather than loudly broken. A `run` with `{ruleset}` and no `ruleset:`
    // key would ship the literal text "{ruleset}" to the tool as an argument
    // (phpcs would report it cannot read a ruleset by that name -> non-zero ->
    // read as a RED gate, looping the worker on a profile bug that is not in the
    // diff). A `ruleset:` key whose `run` never mentions `{ruleset}` is the more
    // dangerous direction: the gate would read as OVERRIDABLE while nothing it
    // actually runs can be pointed anywhere else -- a project could declare an
    // override in `contract.gateRulesets` that is silently never consulted.
    const mentionsRuleset = g.run.includes("{ruleset}");
    if (mentionsRuleset && g.ruleset === null) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' uses '{ruleset}' but declares no 'ruleset:' key -- ` +
          `the placeholder would be passed to the tool verbatim`,
      );
    }
    if (!mentionsRuleset && g.ruleset !== null) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' declares a 'ruleset:' key but its 'run' never uses ` +
          `'{ruleset}' -- the gate would read as overridable (adr/010) while a project's override in ` +
          `'contract.gateRulesets' could never actually be substituted into the command that runs`,
      );
    }
  }

  // adr/010 part (d): a project override naming a gate id this profile does not
  // have, or a gate that never declared 'ruleset:' at all, must throw HERE --
  // "declares an override that does nothing is worse than no override, because
  // the operator stops looking" (adr/010). Checked before any path is resolved,
  // so a typo'd gate id in `contract.gateRulesets` never gets as far as "which
  // file does this even point at".
  if (overrides !== undefined) {
    for (const gateId of Object.keys(overrides.gateRulesets)) {
      const target = gates.find((g) => g.id === gateId);
      if (target === undefined) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: contract.gateRulesets declares an override for gate '${gateId}', but ` +
            `this profile has no gate with that id -- an override naming a gate that does not exist would do ` +
            `nothing while reading as if it were in force (adr/010)`,
        );
      }
      if (target.ruleset === null) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: contract.gateRulesets declares an override for gate '${gateId}', but ` +
            `that gate has no 'ruleset:' key and is not overridable at all -- only the ruleset is ever ` +
            `overridable, never the 'run' command itself (adr/010)`,
        );
      }
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

      // The shared containment probe (`assertContainedRegularFile` above) does
      // the lexical-containment / stat-is-a-file / realpath-containment
      // sequence this loop always did -- see that function's doc comment for
      // why it is now a shared function rather than inline code.
      //
      // `refuseSymlinkLeaf: false` -- deliberately `stat`-tolerant here, not
      // `lstat`-strict like `adr/010`'s NEW ruleset-override probe below.
      // `gate/oracle-paths.ts` refuses ANY symlinked oracle leaf outright
      // because it FINGERPRINTS the file's content across a worker's task: a
      // worker could repoint the link (or swap the target for a same-content
      // file) between the pre- and post- snapshot, and the hash would not
      // move, silently defeating the fence it is part of. Nothing here is
      // fingerprinted -- this probe only proves the referenced file exists and
      // is a regular file ONCE, at profile-load time, before any task runs. A
      // {profile}-derived path that is a symlink pointing INWARD, to another
      // file the profile itself ships, is harmless to follow here. This is not
      // a blanket claim that symlinks are safe in this module in general --
      // FIX A above still refuses the profile DIRECTORY itself being a symlink
      // out of `root`, and the NEW `{ruleset}` override probe below refuses a
      // project-declared symlink outright -- only that THIS probe, over the
      // profile's OWN shipped files, has no content-integrity property for a
      // symlinked leaf to defeat.
      await assertContainedRegularFile(
        dir,
        rulesetPath,
        "the profile directory",
        `profile ${JSON.stringify(ref)}: gate '${g.id}' references`,
        "the profile did not ship",
        false,
      );
    }
  }

  // {ruleset} resolution -- adr/010. Deliberately runs AFTER the {profile}-token
  // probe just above, not interleaved with it: at this point every gate's `run`
  // still contains the literal text "{ruleset}" (never yet substituted), so the
  // token probe above only ever sees genuine {profile}-derived tokens and this
  // step's own substitution cannot accidentally feed it a second, redundant
  // candidate to re-probe.
  //
  // Unlike {profile}, this is resolved to an ABSOLUTE path HERE, at load time --
  // not deferred to gate-invocation time the way {files} is. There is exactly
  // one thing a project's contract.gateRulesets entry can mean (adr/010 part
  // (b)): a path at the TRUSTED ROOT. Resolving and validating it once, now,
  // means a broken declaration surfaces as a profile-load error naming exactly
  // what was declared -- never as a gate run failing deep inside a task, which
  // step 1d would read as a worker-fixable RED and RETRY forever against a
  // defect that was never in the diff.
  for (const g of gates) {
    if (g.ruleset === null) continue; // no 'ruleset:' key -- {ruleset} cannot appear in run (cross-checked above)

    // `hasOwnProperty`, not a plain `overrides?.gateRulesets[g.id] !== undefined`
    // check: the latter cannot distinguish "no override declared" from "an
    // override was declared with the value `undefined`" -- unreachable through
    // this module's own JSON-shaped config loader, but the distinction is what
    // this whole feature is about (adr/010 part (d): a declaration that could
    // not be honoured must never silently read as "no declaration"), so the
    // stricter check costs nothing and states the intent precisely.
    let anchor: string;
    let anchorLabel: string;
    let relativeEntry: string;
    let source: "profile" | "project";
    if (overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides.gateRulesets, g.id)) {
      const declared = overrides.gateRulesets[g.id];
      // `hasOwnProperty` already proved this key is present on the record, but
      // `noUncheckedIndexedAccess` types the read as `string | undefined`
      // regardless -- it cannot see through a dynamic property-existence check.
      // The runtime guarantee (`gateRulesets` is a `Record<string,string>`
      // straight off a zod-validated `HarnessConfig`) makes this branch
      // unreachable in practice; it is stated as an explicit throw rather than
      // a `!` assertion so an unreachable branch still fails LOUD if it is ever
      // wrong, instead of silently asserting past the type checker's doubt.
      if (declared === undefined) {
        throw new Error(
          `profile ${JSON.stringify(ref)}: contract.gateRulesets['${g.id}'] has no value despite the key being ` +
            `present -- this should be unreachable through a zod-validated Record<string,string>`,
        );
      }
      anchor = overrides.repoRoot;
      anchorLabel = "the project's repo root";
      relativeEntry = declared;
      source = "project";
    } else {
      anchor = dir;
      anchorLabel = "the profile directory";
      relativeEntry = g.ruleset;
      source = "profile";
    }
    const overridden = source === "project";

    // The profile author's OWN 'ruleset:' text was already validated to this
    // exact normal form at schema-parse time (`ProfileGateSchema`'s `ruleset`
    // field, via the same `isInvalidRulesetEntry`), so re-checking it here would
    // be pure redundancy. A project's OVERRIDE text has no such guarantee: it
    // is a plain string on `HarnessConfig.contract.gateRulesets`
    // (`src/config/schema.ts`) with no path-shape validation of its own, so
    // THIS is the one place that ever inspects it lexically. Never fall back
    // to the profile default merely because the override looks malformed --
    // adr/010 part (d) is explicit that a declared-but-unhonourable override
    // must throw, not silently defer to the profile's own ruleset.
    if (overridden && isInvalidRulesetEntry(relativeEntry)) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' project override ruleset '${relativeEntry}' ` +
          `(contract.gateRulesets) is not a valid repo-relative path (must be non-blank, not absolute on any ` +
          `platform, no '..' segment, no backslash) -- refusing rather than silently falling back to the ` +
          `profile's own ruleset (adr/010)`,
      );
    }

    const candidatePath = resolve(anchor, relativeEntry);

    // Same three-property containment probe the {profile}-token probe above
    // uses, against WHICHEVER anchor this gate's ruleset is actually anchored
    // to -- see `assertContainedRegularFile`'s doc comment for why sharing this
    // one implementation is the point.
    //
    // `refuseSymlinkLeaf: overridden` -- adr/010's fail-closed table (part (d))
    // is scoped to a PROJECT's declaration specifically: its own last row,
    // "not declared -> the profile's own ruleset, unchanged", says the
    // non-override path is not touched by this ADR at all. So the symlink
    // refusal applies only when a project actually overrode this gate; the
    // profile's own default keeps the SAME tolerance the {profile}-token probe
    // above has always had (an inward-pointing symlink to another file the
    // profile itself ships is harmless here, for the identical reason that
    // probe's own comment gives -- nothing in this function fingerprints the
    // file's content across a worker's task). A project's OWN declaration gets
    // the stricter treatment because it is untrusted operator input in a way a
    // profile's shipped file is not.
    await assertContainedRegularFile(
      anchor,
      candidatePath,
      anchorLabel,
      `profile ${JSON.stringify(ref)}: gate '${g.id}' ${overridden ? "project-declared" : "profile-declared"} ruleset`,
      overridden ? "does not exist in the project" : "the profile did not ship",
      overridden,
    );

    // Gate commands are whitespace-split and are not quote-aware (the same
    // reason the profile-dir whitespace check near the top of this function
    // exists): a resolved ruleset path containing a space would silently
    // produce broken argv the moment '{ruleset}' is substituted into `run`.
    if (/\s/.test(candidatePath)) {
      throw new Error(
        `profile ${JSON.stringify(ref)}: gate '${g.id}' ruleset resolves to '${candidatePath}', whose path ` +
          `contains whitespace -- gate commands are split on whitespace and are not quote-aware, so a ` +
          `'{ruleset}' expansion from here would produce broken arguments`,
      );
    }

    g.rulesetSource = source;
    g.rulesetPath = candidatePath;
    g.run = g.run.split("{ruleset}").join(candidatePath);
  }

  return { id, version, dir, gates, protectedPaths: pf.protectedPaths, provision: pf.requires.provision };
}
