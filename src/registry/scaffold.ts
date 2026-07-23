/**
 * `.autodev/` scaffolding for the New Project flow (spec §5). Transactional-ish
 * discipline (spec §6): the config YAML is built AND validated (round-trip
 * through the real strict `HarnessConfigSchema`) BEFORE any fs write; stub
 * files are written `wx` with EEXIST-skip so an existing blackboard file is
 * NEVER clobbered; `config.yaml` is written LAST with `wx` (mirrors
 * `enqueue.ts`/`recordRun` exclusivity).
 *
 * Layout mirrors the live-proven aurora `.autodev/` + the PS-oracle convention
 * of contract files living INSIDE `.autodev/` (real woodev `.autodev/` holds
 * GOAL.md/INVARIANTS.md/GUARDS.md). The scaffolded config points
 * `contract.invariantsFile`/`guardsFile` at those stubs so they are live.
 */
import { mkdir, writeFile, readFile, appendFile, stat, lstat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import { loadConfigWithRaw, isContractFileConfigured } from "../config/config.js";
import { NORTH_STAR_UNFILLED_SENTINEL } from "../anti-drift/north-star.js";
import { realpathContains } from "../util/path-contain.js";
import { runNative } from "../util/native.js";

type Log = (level: string, message: string) => void;

/** The registration-form surface (spec §5): roles, gate command, provision list,
 *  branch pattern. `.strict()` so an unknown key from the UI is a loud 400, not
 *  silently dropped (same philosophy as the root config schema). */
export const ScaffoldFormSchema = z
  .object({
    gate: z.object({ checkCommand: z.string().min(1).optional() }).strict().optional(),
    worktree: z.object({ provision: z.array(z.string()).optional() }).strict().optional(),
    allowedBranchPattern: z.string().min(1).optional(),
    roles: z
      .object({
        orchestrator: z
          .object({ adapter: z.string().optional(), model: z.string().optional(), effort: z.string().optional() })
          .strict()
          .optional(),
        worker: z
          .object({ adapter: z.string().optional(), ladder: z.array(z.string()).optional() })
          .strict()
          .optional(),
        critic: z
          .object({ adapter: z.string().optional(), model: z.string().optional(), effort: z.string().optional() })
          .strict()
          .optional(),
        // planner: OPTIONAL role (reserved; no live adapter). Same strict shape as
        // orchestrator — {adapter, model, effort}. `exe`/unknown keys are rejected
        // (mirrors orchestrator). Projection-read is R1; this is the R3 write path.
        planner: z
          .object({ adapter: z.string().optional(), model: z.string().optional(), effort: z.string().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // Worker ambient-extension isolation (all optional; strict). Mirrors the
    // roles write path — the form carries only the sub-fields the UI toggles,
    // hand-set fields survive via mergeConfigYaml.
    isolation: z
      .object({
        worker: z
          .object({
            cleanRoom: z.boolean().optional(),
            mcp: z.boolean().optional(),
            skills: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // Overnight autonomy opt-in (spec 2026-07-19). ONLY `enabled` is writable from
    // the UI; `maxAutoReworks` stays a YAML-only field (YAGNI -- the operator edits
    // it directly on the rare occasion it needs tuning).
    autonomy: z
      .object({
        overnight: z.object({ enabled: z.boolean().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ScaffoldForm = z.infer<typeof ScaffoldFormSchema>;

/** Thrown when the form produces a config the harness schema rejects. Callers
 *  (admin) map this to a 400 `invalid_config`, distinct from real fs failures. */
export class ScaffoldConfigError extends Error {}

const CONFIG_HEADER =
  "# Autodev Harness — per-project config. Scaffolded by the New Project flow; edit freely.\n" +
  "# Contract stubs live under .autodev/ (see contract.invariantsFile / guardsFile below).\n";

/**
 * The scaffolded north-star (`adr/004` tenet 4): the project's immutable intent
 * anchor, fed WHOLE to the anti-drift critic (`cfg.antiDrift.intentSource` defaults
 * here). Four fill-in sections -- what it is / why / must do / must never do -- each
 * carrying `NORTH_STAR_UNFILLED_SENTINEL` until the operator replaces it. While ANY
 * sentinel remains the stub reads as SILENT (`isNorthStarSilent`), which fail-closes
 * unattended autonomy: the overnight run refuses to build a project whose intent is
 * still the boilerplate. Exported so `north-star.test.ts` can pin the sentinel
 * contract (the two files must agree on the exact string or the fail-open reopens).
 */
export const GOAL_STUB = [
  "# GOAL -- North-Star",
  "",
  "> The operator's immutable intent anchor, scaffolded by the New Project flow and",
  "> fed whole to the anti-drift critic. Replace each section's placeholder with real",
  "> content. Until every placeholder is gone, unattended (overnight) autonomy REFUSES",
  "> to run this project -- an autonomous night must not build against an unwritten intent.",
  "",
  "## What it is",
  `${NORTH_STAR_UNFILLED_SENTINEL} (describe what this project is)`,
  "",
  "## Why",
  `${NORTH_STAR_UNFILLED_SENTINEL} (describe why it exists / who it is for)`,
  "",
  "## What it must do",
  `${NORTH_STAR_UNFILLED_SENTINEL} (the core things it must always do)`,
  "",
  "## What it must never do",
  `${NORTH_STAR_UNFILLED_SENTINEL} (the boundaries it must never cross)`,
  "",
].join("\n");

const INVARIANTS_STUB = [
  "# INVARIANTS",
  "",
  "> Contract zones for the machine gate. The harness reads the MACHINE-INVARIANTS",
  "> block below; empty zones = nothing enforced yet. Keep the markers intact.",
  "",
  "<!-- BEGIN MACHINE-INVARIANTS -->",
  "```json",
  JSON.stringify({ version: 1, updated: "", contract_zones: [], constitution: { path_globs: [] } }, null, 2),
  "```",
  "<!-- END MACHINE-INVARIANTS -->",
  "",
].join("\n");

/**
 * The scaffolded config points `contract.guardsFile` at `.autodev/GUARDS.md` (line ~138)
 * but this stub was, until `adr/006` Phase 1, never actually written -- the gate's
 * fail-closed loader rule (`root.ts` `loadGuardPairsFrom`) now REJECTS a configured-but-
 * absent guards file, so every scaffolded project would escalate its first task without
 * this. Header + separator only (zero data rows): parses to `[]` via `parseGuardsTable`,
 * same "declared but empty is legitimate" contract as `INVARIANTS_STUB`.
 */
const GUARDS_STUB = [
  "# GUARDS",
  "",
  "> Mutation-verified guard table for the machine gate. Empty = no guards blessed yet",
  "> (a touched auto_guardable zone escalates for a human guard, same as today).",
  "",
  "| contract_id | contract_value | guard_test | recipe | mutation_verified | blessed_by | date |",
  "|---|---|---|---|---|---|---|",
  "",
].join("\n");

const QUEUE_STATES = ["pending", "active", "done", "escalated", "quarantine"] as const;
const STATE_DIRS = ["runtime", "escalations", "runs", "worktrees"] as const;

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Build the config.yaml text from the form and PROVE it loads: the emitted text
 * is parsed back and validated against the real strict `HarnessConfigSchema`,
 * so a scaffolded project can never fail its first `loadConfig`
 * (`[config/zod-strict]`: the strict root would otherwise fail loud at first use).
 */
export function buildConfigYaml(form: ScaffoldForm): string {
  const roles: Record<string, unknown> = {};
  if (form.roles?.orchestrator !== undefined) roles["orchestrator"] = pruneUndefined(form.roles.orchestrator);
  if (form.roles?.worker !== undefined) roles["worker"] = pruneUndefined(form.roles.worker);
  if (form.roles?.critic !== undefined) roles["critic"] = pruneUndefined(form.roles.critic);
  if (form.roles?.planner !== undefined) roles["planner"] = pruneUndefined(form.roles.planner);

  const cfg: Record<string, unknown> = {
    contract: { invariantsFile: ".autodev/INVARIANTS.md", guardsFile: ".autodev/GUARDS.md" },
  };
  if (form.allowedBranchPattern !== undefined) cfg["allowedBranchPattern"] = form.allowedBranchPattern;
  if (form.gate?.checkCommand !== undefined) cfg["gate"] = { checkCommand: form.gate.checkCommand };
  if (form.worktree?.provision !== undefined && form.worktree.provision.length > 0) {
    cfg["worktree"] = { provision: form.worktree.provision };
  }
  if (Object.keys(roles).length > 0) cfg["roles"] = roles;

  if (form.isolation?.worker !== undefined) {
    cfg["isolation"] = { worker: pruneUndefined(form.isolation.worker) };
  }

  const text = CONFIG_HEADER + stringifyYaml(cfg);

  const parsed = HarnessConfigSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new ScaffoldConfigError(`scaffolded config.yaml would not load: ${issues}`);
  }
  return text;
}

/**
 * Merge `form` into an EXISTING raw config object (parsed straight from YAML —
 * NOT the schema-defaulted HarnessConfig) so hand-set fields the form doesn't
 * cover survive a save from the UI. Mirrors `buildConfigYaml`'s
 * validate-before-write discipline: the merged text is parsed back and
 * validated against the real strict `HarnessConfigSchema` before being
 * returned, so a bad merge is caught here, never partially written.
 *
 * NOTE: re-serializing through the `yaml` library drops any hand-written
 * comments in the original file (this is a round-trip re-emit, not an
 * in-place comment-preserving edit) — an accepted UI-save tradeoff, not a bug.
 */
export function mergeConfigYaml(existingRawText: string, form: ScaffoldForm): string {
  const base = existingRawText.trim() === "" ? {} : parseYaml(existingRawText);
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    throw new ScaffoldConfigError("existing config.yaml is not a YAML mapping at the root");
  }
  const raw = base as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...raw };

  if (form.allowedBranchPattern !== undefined) merged["allowedBranchPattern"] = form.allowedBranchPattern;
  if (form.gate?.checkCommand !== undefined) {
    merged["gate"] = { ...(raw["gate"] as Record<string, unknown> | undefined), checkCommand: form.gate.checkCommand };
  }
  if (form.worktree?.provision !== undefined) {
    merged["worktree"] = {
      ...(raw["worktree"] as Record<string, unknown> | undefined),
      provision: form.worktree.provision,
    };
  }
  if (form.roles !== undefined) {
    const rawRoles = (raw["roles"] as Record<string, unknown> | undefined) ?? {};
    const mergedRoles: Record<string, unknown> = { ...rawRoles };
    for (const role of ["orchestrator", "worker", "critic", "planner"] as const) {
      const formRole = form.roles[role];
      if (formRole !== undefined) {
        mergedRoles[role] = { ...(rawRoles[role] as Record<string, unknown> | undefined), ...pruneUndefined(formRole) };
      }
    }
    merged["roles"] = mergedRoles;
  }
  if (form.isolation?.worker !== undefined) {
    const rawIso = (raw["isolation"] as Record<string, unknown> | undefined) ?? {};
    const rawWorker = (rawIso["worker"] as Record<string, unknown> | undefined) ?? {};
    merged["isolation"] = {
      ...rawIso,
      worker: { ...rawWorker, ...pruneUndefined(form.isolation.worker) },
    };
  }
  if (form.autonomy?.overnight !== undefined) {
    const rawAutonomy = (raw["autonomy"] as Record<string, unknown> | undefined) ?? {};
    const rawOvernight = (rawAutonomy["overnight"] as Record<string, unknown> | undefined) ?? {};
    merged["autonomy"] = {
      ...rawAutonomy,
      // `maxAutoReworks` is YAML-only (not in the form) -- spreading rawOvernight
      // FIRST then the form's pruned fields means a hand-set value survives the
      // merge untouched; only `enabled` is ever overwritten from here.
      overnight: { ...rawOvernight, ...pruneUndefined(form.autonomy.overnight) },
    };
  }

  const text = CONFIG_HEADER + stringifyYaml(merged);

  const parsed = HarnessConfigSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new ScaffoldConfigError(`merged config.yaml would not load: ${issues}`);
  }
  return text;
}

/** `writeFile` with `wx`; EEXIST -> false (existing file NEVER clobbered — spec §6). */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Refuse to write into `dir` when it is a symlink/junction/non-directory, OR when it
 * IS a real directory that contains a symlinked DIRECT child. `mkdir`/`writeFile`
 * both follow symlinks, so an unguarded write into either shape could land content
 * OUTSIDE the repo (`[scaffold/symlink-escape]`). Shared by `scaffoldProject` (new
 * project) and `ensureContractStubs` (already-registered project migration) so this
 * guard is written ONCE, not duplicated per caller.
 *
 * A `dir` that does not exist yet (ENOENT) passes silently -- the caller's own
 * `mkdir`/write decides what happens next; this only rejects a HOSTILE existing
 * shape, never a legitimate "not created yet". `label` customizes the thrown
 * message's verb (`scaffold` vs `heal`) so the error names the right operation.
 * Deeper grandchildren are deliberately NOT scanned -- same rationale as the
 * original scaffoldProject check: the only ops below a verified-real child are
 * recursive `mkdir` (a no-op on an existing symlinked leaf) and `wx`-exclusive
 * stub writes (which already refuse to follow a final symlink).
 */
async function assertRealDirNoSymlinkChildren(dir: string, label: string): Promise<void> {
  let lst;
  try {
    lst = await lstat(dir); // lstat: describes the link itself, never its target
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  if (!lst.isDirectory()) {
    throw new ScaffoldConfigError(
      `refusing to ${label}: ${dir} exists but is not a real directory (symlink or file) — resolve it manually`,
    );
  }
  for (const child of await readdir(dir, { withFileTypes: true })) {
    if (child.isSymbolicLink()) {
      throw new ScaffoldConfigError(
        `refusing to ${label}: ${join(dir, child.name)} is a symlink — resolve it manually`,
      );
    }
  }
}

/** Tooling-churn dirs the harness (and Serena) write to during a run. Left visible
 *  to git, their background churn dirties the main tree → `mergeAfterGate` refuses →
 *  every gated commit escalates `blocked` and nothing reaches DONE (gotchas
 *  `[conductor/real-repo-run]`, `[env/serena-churn-blocks-merge]`). Excluding them
 *  keeps the tree clean for merges. NB: `.git/info/exclude` only affects UNTRACKED
 *  paths — an already-tracked `.serena/project.yml` (the s31 case) still dirties the
 *  tree; the conductor's dirty-tree preflight warns and points at
 *  `git update-index --skip-worktree` for that. */
const CHURN_EXCLUDE_ENTRIES = [".autodev/", ".serena/"] as const;

/** Append the tooling-churn exclude entries to `.git/info/exclude`, once each
 *  (per-entry idempotent, so a repo already carrying `.autodev/` from a pre-s32
 *  scaffold just gains `.serena/`). A `.git` FILE (worktree/submodule) skips with a
 *  WARN — never fails registration over it. */
async function ensureGitExclude(repoRoot: string, log?: Log): Promise<void> {
  const gitDir = join(repoRoot, ".git");
  let st;
  try {
    st = await stat(gitDir);
  } catch {
    return; // validated upstream (admin requires .git); stay lenient here
  }
  if (!st.isDirectory()) {
    log?.(
      "WARN",
      `scaffold: ${gitDir} is not a directory (worktree/submodule?) — add ${CHURN_EXCLUDE_ENTRIES.join(", ")} to its exclude file manually`,
    );
    return;
  }
  const infoDir = join(gitDir, "info");
  await mkdir(infoDir, { recursive: true });
  const excludePath = join(infoDir, "exclude");
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = CHURN_EXCLUDE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(
    excludePath,
    `${prefix}# autodev harness tooling-churn state (added by the New Project scaffold)\n${missing.join("\n")}\n`,
    "utf8",
  );
}

export interface ScaffoldResult {
  /** True when `.autodev/config.yaml` already existed — nothing was touched. */
  skipped: boolean;
  /** Repo-relative paths of files this call actually wrote (dirs not tracked). */
  written: string[];
}

/**
 * Scaffold `.autodev/` into `repoRoot`. Skips entirely when
 * `.autodev/config.yaml` exists (spec §5: registering a repo that already has
 * one shows its values instead). Order: validate config text (no writes on a
 * bad form) → mkdir skeleton → stubs (`wx`, EEXIST-skip) → git exclude →
 * config.yaml LAST (`wx`).
 *
 * SYMLINK GUARD (`assertRealDirNoSymlinkChildren`, shared with `ensureContractStubs`
 * below): refuse to scaffold when `.autodev` is a symlink/junction (or any
 * non-directory), OR when a real `.autodev` contains a symlinked direct child.
 * `mkdir`/`writeFile` follow a symlink, so a repo carrying a hostile
 * `.autodev -> /outside` link (or `.autodev/queue -> /outside`) would otherwise
 * have skeleton dirs written OUTSIDE the target repo via a recursive mkdir. The
 * `.autodev` check runs BEFORE the config.yaml skip too, so a symlinked
 * `.autodev` is never silently followed for either read or write. A real
 * directory with only real children (a partial scaffold) passes.
 */
export async function scaffoldProject(repoRoot: string, form: ScaffoldForm, log?: Log): Promise<ScaffoldResult> {
  const autodevDir = join(repoRoot, ".autodev");
  const configPath = join(autodevDir, "config.yaml");

  await assertRealDirNoSymlinkChildren(autodevDir, "scaffold");

  if (existsSync(configPath)) return { skipped: true, written: [] };

  const yamlText = buildConfigYaml(form); // throws ScaffoldConfigError BEFORE any fs write

  const written: string[] = [];
  for (const state of QUEUE_STATES) await mkdir(join(autodevDir, "queue", state), { recursive: true });
  for (const d of STATE_DIRS) await mkdir(join(autodevDir, d), { recursive: true });

  if (await writeIfAbsent(join(autodevDir, "GOAL.md"), GOAL_STUB)) written.push(".autodev/GOAL.md");
  if (await writeIfAbsent(join(autodevDir, "INVARIANTS.md"), INVARIANTS_STUB)) written.push(".autodev/INVARIANTS.md");
  if (await writeIfAbsent(join(autodevDir, "GUARDS.md"), GUARDS_STUB)) written.push(".autodev/GUARDS.md");

  await ensureGitExclude(repoRoot, log);

  await writeFile(configPath, yamlText, { flag: "wx" }); // LAST + exclusive (spec §6)
  written.push(".autodev/config.yaml");
  return { skipped: false, written };
}

/**
 * The ONLY stub `ensureContractStubs` knows how to heal: `guardsFile`. `invariantsFile`
 * is deliberately EXCLUDED -- this is the round-2 fix, not an oversight, see the
 * asymmetry note on `ensureContractStubs` below. `scaffoldProject` (a FRESH project)
 * still writes BOTH `INVARIANTS_STUB` and `GUARDS_STUB` directly (above); that path is
 * unrelated and unaffected -- it never needed healing because it always wrote
 * `INVARIANTS.md` (only `GUARDS.md` was ever missing from a fresh scaffold, pre-Phase-1).
 */
const CONTRACT_STUBS = {
  guardsFile: GUARDS_STUB,
} as const;

/**
 * Self-healing migration for a project scaffolded BEFORE `adr/006` Phase 1 shipped
 * (`root.ts`'s `loadInvariantsFrom`/`loadGuardPairsFrom`). Every project scaffolded
 * pre-Phase-1 has `contract.guardsFile: .autodev/GUARDS.md` written into its
 * config.yaml (`buildConfigYaml`, above) but the file itself was NEVER created --
 * `GUARDS_STUB` only lands via a FRESH `scaffoldProject` call. Under the new
 * fail-closed loader rule, that combination makes EVERY task on an already-
 * registered, already-scaffolded project escalate as "broken -- operator config"
 * the moment the daemon upgrades -- our own live `woodev-shipping-plugin-test`
 * project is exactly in this state.
 *
 * ASYMMETRY (round-2 fix -- do NOT extend `CONTRACT_STUBS` back to `invariantsFile`):
 * healing `guardsFile` and healing `invariantsFile` are NOT the same risk, because a
 * missing file degrades each loader in an OPPOSITE direction (Principle 10/14):
 *   - missing `GUARDS.md` -> `loadGuardPairsFrom` degrades to "no guards" -> a touched
 *     `auto_guardable` zone reads as UNCOVERED -> the gate ESCALATES. Safe direction:
 *     self-healing it can only make a broken config auto-recover into a stricter gate,
 *     never a laxer one. Safe to self-heal, which is what this function does.
 *   - missing `INVARIANTS.md` -> `loadInvariantsFrom` degrades to "no zones" -> NOTHING
 *     is enforced -> the gate silently judges against a VACUOUS oracle and COMMITs.
 *     Unsafe direction: self-healing it would convert the loader's fail-closed throw
 *     (an operator-visible "broken -- operator config" escalation) into a silent
 *     fail-OPEN vacuous pass -- precisely the failure this whole Phase exists to
 *     remove. This must stay an OPERATOR decision (re-run the scaffold, or author
 *     `INVARIANTS.md` by hand), never something the daemon does for them unasked.
 * Also: the migration this function exists for only ever needed `GUARDS.md` -- the
 * pre-Phase-1 scaffold DID write `INVARIANTS.md` (`scaffoldProject` above), it only
 * omitted `GUARDS.md`. So healing invariants was never actually needed to fix the
 * `woodev-shipping-plugin-test` case this migration targets.
 *
 * Heals `guardsFile` ONLY when ALL of:
 *   - it is EXPLICITLY configured in the raw config (`isContractFileConfigured` --
 *     the parsed `cfg` always carries the schema default and can't tell "configured"
 *     from "defaulted", same reason `root.ts`'s loaders need it);
 *   - it is ABSENT (an existing file, hand-authored or already healed, is NEVER
 *     touched -- `writeIfAbsent`'s `wx` exclusivity is what enforces that here);
 *   - its configured path resolves INSIDE `<repoRoot>/<cfg.stateDir>` -- checked via
 *     REALPATH (`realpathContains`), not a lexical prefix -- see `healOneContractStub`
 *     below (round-2 fix 2);
 *   - AND (round-3 fix 1) its path is VERIFIED -- via a real `git check-ignore`, not
 *     assumed -- to actually be git-ignored in the target repo. The stateDir-
 *     containment check above says nothing about the target repo's real
 *     `.gitignore`/exclude rules: `cfg.stateDir` is operator-configurable, and the
 *     DEFAULT (`.autodev`) is only git-excluded because `scaffoldProject`'s own
 *     `ensureGitExclude` put it there. A `stateDir` repointed at a TRACKED directory
 *     would otherwise have this function write a brand-new untracked file into the
 *     working tree on every daemon startup -- dirtying `git status --porcelain` ->
 *     `mergeAfterGate` refuses -> EVERY task escalates `blocked` forever, never
 *     reaching DONE (`docs/gotchas/harness-on-real-repo-prerequisites.md` #3,
 *     `docs/gotchas/serena-churn-blocks-merge.md`). If the check itself cannot be
 *     performed (git missing, not a repo, any other non-zero exit) this ALSO skips
 *     the heal -- see `isVerifiedGitIgnored` below. A configured path that fails
 *     stateDir-containment OR the git-ignore verification gets NO write here -- that
 *     is treated as a real, git-tracked, OPERATOR-OWNED contract file; the Finding-1
 *     fail-closed throw stands for it (self-diagnosing via the path it names),
 *     healing it is an operator decision, not this migration's call.
 *
 * Reuses `writeIfAbsent` (never clobbers) and `assertRealDirNoSymlinkChildren`
 * (same symlink-escape guard `scaffoldProject` uses) rather than duplicating either.
 *
 * Best-effort: this function NEVER throws -- one broken/unreadable project config
 * must not abort the whole daemon startup pass it's wired into (`src/index.ts`'s
 * `serve` branch-ensure loop, same contract as that loop's existing per-project
 * try/catch). The stub-loop below keeps its per-key isolation structure (each key's
 * heal attempt is its OWN try/catch) even though only one key remains, so adding a
 * second healable file back would not need to touch this isolation contract.
 *
 * SCOPE NOTE: only wired into the `serve` startup pass -- the bare `run` CLI verb
 * does NOT call this. An operator hitting a stale pre-Phase-1 project via `run`
 * still gets the actionable fail-closed throw naming the missing path (self-
 * diagnosing); healing `run` too would widen this fix beyond the finding.
 *
 * DELIBERATELY NOT A REGRESSION (codex M3 finding, verified-not-a-defect, do not
 * re-flag): healing `guardsFile` lets a task touching NO auto_guardable zone commit
 * where the pre-heal broken config would have escalated EVERY task instead. That
 * blanket escalation was the actual breakage (a broken operator config, not a
 * security guarantee); healing restores the project's originally-intended
 * zero-guards oracle -- the same oracle any correctly-configured project starts with,
 * where no guard rows ever existed pre-Phase-1 either. No oracle is weakened.
 */
export async function ensureContractStubs(repoRoot: string, cfg: HarnessConfig, log?: Log): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    ({ raw } = await loadConfigWithRaw(repoRoot));
  } catch (err) {
    log?.("WARN", `scaffold: ensureContractStubs could not read config for ${repoRoot}: ${String(err)}`);
    return;
  }

  const stateDirAbs = join(repoRoot, cfg.stateDir);
  // `cfg.stateDir` itself must resolve INSIDE `repoRoot` -- a `stateDir: ../outside`
  // (or a symlinked stateDir) escapes the repo entirely, in which case there is no
  // safe place to heal into for ANY key (round-2 fix 2b). A not-yet-scaffolded
  // project has no `stateDirAbs` on disk yet either, which `realpathContains` also
  // reports as not-contained (it can't `realpath` a path that doesn't exist) -- that
  // is the ordinary "nothing to migrate" case, not a fault, so no WARN is logged here.
  if (!(await realpathContains(repoRoot, stateDirAbs))) return;

  for (const key of Object.keys(CONTRACT_STUBS) as (keyof typeof CONTRACT_STUBS)[]) {
    try {
      await healOneContractStub(repoRoot, stateDirAbs, raw, key, cfg.contract[key], CONTRACT_STUBS[key], log);
    } catch (err) {
      log?.("WARN", `scaffold: ensureContractStubs failed healing ${key} for ${repoRoot}: ${String(err)}`);
    }
  }
}

/**
 * VERIFY (never assume) that `absPath` is actually git-ignored inside `repoRoot`, via
 * `git check-ignore` (round-3 fix 1). Mirrors `worktree.ts`'s provision-time gitignore
 * check -- same `runNative` spawn convention (`docs/gotchas/runnative-windows-cmd-shim-spawn.md`:
 * a bare `child_process.spawn("git", ...)` is fine for `git` itself, which ships a
 * real `.exe`, not a `.cmd` shim, but `runNative`/cross-spawn is still the house
 * convention for every native-process call in this codebase).
 *
 * Returns `true` ONLY on a clean "ignored" verdict (`git check-ignore` exit 0).
 * Everything else returns `false`: "not ignored" (exit 1), any other git failure
 * (not a repo, corrupt repo, or any other non-zero exit), AND git itself failing to
 * spawn (missing from PATH -- `runNative` rejects on a spawn error). This is
 * deliberately fail-CLOSED: `ensureContractStubs`/`healOneContractStub` below used to
 * ASSUME a target living under `stateDir` could "never dirty the git tree", which is
 * only true because the DEFAULT `stateDir` (`.autodev`) happens to be excluded by
 * `scaffoldProject`'s own `ensureGitExclude` -- but `cfg.stateDir` is
 * operator-configurable. Pointed at a tracked directory (e.g. `stateDir: config`),
 * the pre-fix code would write a brand-new untracked file into the working tree on
 * every daemon startup, dirtying `git status --porcelain` -> `mergeAfterGate`
 * refuses -> EVERY task escalates `blocked` forever, never reaching DONE -- the exact
 * failure class in `docs/gotchas/harness-on-real-repo-prerequisites.md` #3 and
 * `docs/gotchas/serena-churn-blocks-merge.md`. Skipping the heal when this can't be
 * verified is correct, not a regression: the loader's fail-closed throw simply stands,
 * and it names the missing path (self-diagnosing).
 */
async function isVerifiedGitIgnored(repoRoot: string, absPath: string): Promise<boolean> {
  try {
    const r = await runNative("git", ["check-ignore", "-q", "--", absPath], { cwd: repoRoot });
    return r.exitCode === 0;
  } catch {
    return false; // git missing from PATH, or any other spawn failure -- fail closed, never write
  }
}

/** One `ensureContractStubs` file, isolated in its own try/catch by the caller above
 *  so a failure healing one configured key never blocks another (structure kept even
 *  though `CONTRACT_STUBS` currently has only `guardsFile` -- see that map's comment).
 *  Throws on a violation the caller above catches -- kept as a throw (not a swallowed
 *  bool) so the shared `assertRealDirNoSymlinkChildren` guard's message reaches the
 *  log verbatim. */
async function healOneContractStub(
  repoRoot: string,
  stateDirAbs: string,
  raw: Record<string, unknown>,
  key: "guardsFile",
  relPath: string,
  stub: string,
  log?: Log,
): Promise<void> {
  if (!isContractFileConfigured(raw, key)) return; // not explicitly configured -- nothing to heal
  const abs = join(repoRoot, relPath);
  if (existsSync(abs)) return; // already present (hand-authored or already healed) -- never touched

  // Round-2 fix 2: a LEXICAL `abs.startsWith(stateDirAbs + sep)` check is exactly the
  // hole the read path (`root.ts`'s `resolveContainedOracleFile`) already closed --
  // `.autodev/link/deep/GUARDS.md` with `.autodev/link` a symlink to somewhere outside
  // the repo passes that lexical check AND `lstat`s as a real directory THROUGH the
  // link, so the old code's `assertRealDirNoSymlinkChildren` (which only inspects the
  // resolved parent's OWN direct children, never its ANCESTORS) would not catch it
  // either. `realpathContains` resolves the FULL chain before comparing, closing both
  // the scope check (is this path meant to be under stateDir at all) and the escape
  // check (does its REAL location agree) in one call -- see `path-contain.ts`.
  const parentDir = dirname(abs);
  if (!(await realpathContains(stateDirAbs, parentDir))) return; // parent absent, or escapes stateDir via a symlinked ancestor

  // Round-3 fix 1: VERIFY -- via a real `git check-ignore` -- that `abs` is actually
  // git-ignored, rather than assuming it because it resolves inside `stateDirAbs`.
  // `cfg.stateDir` is operator-configurable and the containment check above says
  // nothing about the target repo's ACTUAL `.gitignore`/exclude rules. See
  // `isVerifiedGitIgnored`'s doc comment for the failure this closes.
  if (!(await isVerifiedGitIgnored(repoRoot, abs))) return;

  // `mkdir(parentDir, { recursive: true })` was REMOVED here (round-2 fix 2c): a
  // recursive mkdir can itself traverse an existing symlinked ancestor and create
  // real directories beyond it. The migration only ever heals into an ALREADY-
  // EXISTING state dir (the scaffold created it) -- the `realpathContains` check
  // above already requires `parentDir` to exist and resolve inside `stateDirAbs`, so
  // if there is nothing to migrate into, this function has already returned above.
  await assertRealDirNoSymlinkChildren(parentDir, "heal"); // complementary: rejects a symlinked SIBLING inside parentDir
  if (await writeIfAbsent(abs, stub)) {
    log?.("INFO", `scaffold: self-healed missing ${relPath} for ${repoRoot} (adr/006 Phase 1 migration)`);
  }
}
