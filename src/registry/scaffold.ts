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
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { HarnessConfigSchema } from "../config/schema.js";

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
  })
  .strict();

export type ScaffoldForm = z.infer<typeof ScaffoldFormSchema>;

/** Thrown when the form produces a config the harness schema rejects. Callers
 *  (admin) map this to a 400 `invalid_config`, distinct from real fs failures. */
export class ScaffoldConfigError extends Error {}

const CONFIG_HEADER =
  "# Autodev Harness — per-project config. Scaffolded by the New Project flow; edit freely.\n" +
  "# Contract stubs live under .autodev/ (see contract.invariantsFile / guardsFile below).\n";

const GOAL_STUB = [
  "# GOAL",
  "",
  "> Scaffolded by the autodev harness New Project flow. Replace with 3-5 lines",
  "> describing what this project is and why — the operator's immutable anchor.",
  "",
  "(describe the project goal here)",
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

/** Append `.autodev/` to `.git/info/exclude` once. A `.git` FILE (worktree/
 *  submodule) skips with a WARN — never fails registration over it. */
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
      `scaffold: ${gitDir} is not a directory (worktree/submodule?) — add .autodev/ to its exclude file manually`,
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
  if (existing.split(/\r?\n/).some((l) => l.trim() === ".autodev/")) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${prefix}# autodev harness state (added by the New Project scaffold)\n.autodev/\n`, "utf8");
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
 * SYMLINK GUARD: refuse to scaffold when `.autodev` is a symlink/junction (or
 * any non-directory), OR when a real `.autodev` contains a symlinked direct
 * child. `mkdir`/`writeFile` follow a symlink, so a repo carrying a hostile
 * `.autodev -> /outside` link (or `.autodev/queue -> /outside`) would otherwise
 * have skeleton dirs written OUTSIDE the target repo via a recursive mkdir. The
 * `.autodev` check runs BEFORE the config.yaml skip too, so a symlinked
 * `.autodev` is never silently followed for either read or write. A real
 * directory with only real children (a partial scaffold) passes. (Deeper
 * grandchildren are not scanned: the only ops below a verified-real child are
 * recursive `mkdir` on the fixed queue/state dirs — mkdir on an existing
 * symlinked leaf is a no-op, never an out-of-repo content write — and the stubs
 * are written `wx`/`O_EXCL`, which refuses to follow a final symlink.)
 */
export async function scaffoldProject(repoRoot: string, form: ScaffoldForm, log?: Log): Promise<ScaffoldResult> {
  const autodevDir = join(repoRoot, ".autodev");
  const configPath = join(autodevDir, "config.yaml");

  let autodevLst;
  try {
    autodevLst = await lstat(autodevDir); // lstat: describes the link itself, never its target
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (autodevLst !== undefined) {
    if (!autodevLst.isDirectory()) {
      throw new ScaffoldConfigError(
        `refusing to scaffold: ${autodevDir} exists but is not a real directory (symlink or file) — resolve it manually`,
      );
    }
    // Real .autodev: reject any symlinked direct child so recursive mkdir/writes
    // below it can't escape the repo (codex re-critic: `.autodev/queue -> /outside`).
    for (const child of await readdir(autodevDir, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        throw new ScaffoldConfigError(
          `refusing to scaffold: ${join(autodevDir, child.name)} is a symlink — resolve it manually`,
        );
      }
    }
  }

  if (existsSync(configPath)) return { skipped: true, written: [] };

  const yamlText = buildConfigYaml(form); // throws ScaffoldConfigError BEFORE any fs write

  const written: string[] = [];
  for (const state of QUEUE_STATES) await mkdir(join(autodevDir, "queue", state), { recursive: true });
  for (const d of STATE_DIRS) await mkdir(join(autodevDir, d), { recursive: true });

  if (await writeIfAbsent(join(autodevDir, "GOAL.md"), GOAL_STUB)) written.push(".autodev/GOAL.md");
  if (await writeIfAbsent(join(autodevDir, "INVARIANTS.md"), INVARIANTS_STUB)) written.push(".autodev/INVARIANTS.md");

  await ensureGitExclude(repoRoot, log);

  await writeFile(configPath, yamlText, { flag: "wx" }); // LAST + exclusive (spec §6)
  written.push(".autodev/config.yaml");
  return { skipped: false, written };
}
