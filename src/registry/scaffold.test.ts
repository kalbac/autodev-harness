import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  scaffoldProject,
  buildConfigYaml,
  mergeConfigYaml,
  ensureContractStubs,
  ScaffoldConfigError,
  ScaffoldFormSchema,
} from "./scaffold.js";
import { loadConfig } from "../config/config.js";
import { parseInvariants } from "../gate/invariants.js";
import { parseGuardsTable } from "../gate/guards.js";
import { parse as parseYaml } from "yaml";
import { runNative } from "../util/native.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adh-scaf-"));
  mkdirSync(join(repo, ".git")); // a plain .git DIR by default -- NOT a real repo (no HEAD/objects/refs)
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/**
 * Turn `repo`'s placeholder `.git` DIR (created by `beforeEach` above, which most
 * tests in this file only need to exist as a directory, e.g. for `ensureGitExclude`'s
 * `stat().isDirectory()` check) into a REAL git repository. Needed by the round-3
 * fix 1 tests below: `ensureContractStubs` now runs a real `git check-ignore`, which
 * requires an actual repo (`.git/HEAD` etc.) -- the placeholder dir is not one, and
 * `git check-ignore` fails against it exactly like a "not a git repo at all" case.
 */
async function makeRealGitRepo(dir: string): Promise<void> {
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  const r = await runNative("git", ["init"], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

describe("buildConfigYaml", () => {
  it("emits YAML that loads through the real strict schema (round-trip)", async () => {
    const text = buildConfigYaml(
      ScaffoldFormSchema.parse({
        gate: { checkCommand: "php -l src/x.php" },
        worktree: { provision: ["vendor"] },
        allowedBranchPattern: "^autodev/",
        roles: {
          worker: { adapter: "claude", ladder: ["sonnet"] },
          critic: { adapter: "codex", model: "gpt-5.5", effort: "high" },
        },
      }),
    );
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo); // throws if the emitted YAML is invalid
    expect(cfg.gate.checkCommand).toBe("php -l src/x.php");
    expect(cfg.worktree.provision).toEqual(["vendor"]);
    expect(cfg.roles.worker.ladder).toEqual(["sonnet"]);
    expect(cfg.roles.critic.model).toBe("gpt-5.5");
    expect(cfg.contract.invariantsFile).toBe(".autodev/INVARIANTS.md");
    expect(cfg.contract.guardsFile).toBe(".autodev/GUARDS.md");
  });

  it("an empty form still emits a loadable config (defaults + contract paths)", async () => {
    const text = buildConfigYaml(ScaffoldFormSchema.parse({}));
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo);
    expect(cfg.stateDir).toBe(".autodev");
  });

  it("rejects form values the harness schema rejects (empty ladder) with ScaffoldConfigError", () => {
    expect(() => buildConfigYaml(ScaffoldFormSchema.parse({ roles: { worker: { ladder: [] } } }))).toThrow(
      ScaffoldConfigError,
    );
  });

  it("rejects a provision entry with a separator (schema superRefine) with ScaffoldConfigError", () => {
    expect(() =>
      buildConfigYaml(ScaffoldFormSchema.parse({ worktree: { provision: ["a/b"] } })),
    ).toThrow(ScaffoldConfigError);
  });
});

describe("mergeConfigYaml", () => {
  it("merges gate.checkCommand into an existing config while preserving an unrelated hand-set field", () => {
    const existing = "antiDrift:\n  model: custom-model\n";
    const text = mergeConfigYaml(existing, ScaffoldFormSchema.parse({ gate: { checkCommand: "npm test" } }));
    const parsed = parseYaml(text) as { antiDrift: { model: string }; gate: { checkCommand: string } };
    expect(parsed.gate.checkCommand).toBe("npm test");
    expect(parsed.antiDrift.model).toBe("custom-model"); // survives untouched
  });

  it("preserves a hand-set gate.agentCi across a checkCommand UI edit (config-file-only block, no UI)", () => {
    const existing = [
      "gate:",
      "  agentCi:",
      "    enabled: true",
      "    workflows:",
      "      - .github/workflows/ci.yml",
      "",
    ].join("\n");
    const merged = mergeConfigYaml(existing, ScaffoldFormSchema.parse({ gate: { checkCommand: "npm test" } }));
    const parsed = parseYaml(merged) as {
      gate: { checkCommand: string; agentCi: { enabled: boolean; workflows: string[] } };
    };
    expect(parsed.gate.checkCommand).toBe("npm test");
    expect(parsed.gate.agentCi.enabled).toBe(true);
    expect(parsed.gate.agentCi.workflows).toEqual([".github/workflows/ci.yml"]);
  });

  it("preserves roles.worker's extra hand-set fields while updating only the form's ladder", () => {
    const existing = "roles:\n  worker:\n    adapter: claude\n    maxTurns: 55\n";
    const text = mergeConfigYaml(
      existing,
      ScaffoldFormSchema.parse({ roles: { worker: { ladder: ["sonnet"] } } }),
    );
    const parsed = parseYaml(text) as { roles: { worker: { adapter: string; maxTurns: number; ladder: string[] } } };
    expect(parsed.roles.worker.maxTurns).toBe(55); // survives untouched
    expect(parsed.roles.worker.adapter).toBe("claude"); // survives untouched
    expect(parsed.roles.worker.ladder).toEqual(["sonnet"]); // updated by the form
  });

  it("starts from {} when existingRawText is empty", () => {
    const text = mergeConfigYaml("", ScaffoldFormSchema.parse({ allowedBranchPattern: "^feature/" }));
    const parsed = parseYaml(text) as { allowedBranchPattern: string };
    expect(parsed.allowedBranchPattern).toBe("^feature/");
  });

  it("throws ScaffoldConfigError when the existing text is a YAML array at the root", () => {
    expect(() => mergeConfigYaml("- a\n- b\n", ScaffoldFormSchema.parse({}))).toThrow(ScaffoldConfigError);
  });

  it("throws ScaffoldConfigError when the existing text is a YAML scalar at the root", () => {
    expect(() => mergeConfigYaml("hello\n", ScaffoldFormSchema.parse({}))).toThrow(ScaffoldConfigError);
  });

  it("throws ScaffoldConfigError when the merged result fails the real schema (worktree.provision separator)", () => {
    expect(() =>
      mergeConfigYaml("", ScaffoldFormSchema.parse({ worktree: { provision: ["a/b"] } })),
    ).toThrow(ScaffoldConfigError);
  });

  it("merges roles.planner end-to-end and the result round-trips through loadConfig (R3)", async () => {
    const text = mergeConfigYaml(
      "",
      ScaffoldFormSchema.parse({ roles: { planner: { adapter: "codex", model: "o3", effort: "high" } } }),
    );
    const parsed = parseYaml(text) as { roles: { planner: { adapter: string; model: string; effort: string } } };
    expect(parsed.roles.planner).toEqual({ adapter: "codex", model: "o3", effort: "high" });
    // Prove it loads through the real strict schema (mirrors the buildConfigYaml round-trip test).
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo);
    expect(cfg.roles.planner).toMatchObject({ adapter: "codex", model: "o3", effort: "high" });
  });

  it("preserves a hand-set planner field while updating only the form's planner keys", () => {
    const existing = "roles:\n  planner:\n    adapter: codex\n    exe: my-codex\n";
    const merged = mergeConfigYaml(existing, ScaffoldFormSchema.parse({ roles: { planner: { model: "o3" } } }));
    const parsed = parseYaml(merged) as { roles: { planner: { adapter: string; exe: string; model: string } } };
    expect(parsed.roles.planner.exe).toBe("my-codex"); // survives untouched
    expect(parsed.roles.planner.adapter).toBe("codex"); // survives untouched
    expect(parsed.roles.planner.model).toBe("o3"); // updated by the form
  });
});

describe("ScaffoldFormSchema — planner (R3)", () => {
  it("accepts roles.planner.{adapter,model,effort}", () => {
    const r = ScaffoldFormSchema.safeParse({ roles: { planner: { adapter: "codex", model: "o3", effort: "high" } } });
    expect(r.success).toBe(true);
  });

  it("still REJECTS roles.worker.model (worker stays ladder-only)", () => {
    const r = ScaffoldFormSchema.safeParse({ roles: { worker: { model: "opus" } } });
    expect(r.success).toBe(false);
  });

  it("REJECTS an unknown planner key via .strict() (planner.bogus)", () => {
    const r = ScaffoldFormSchema.safeParse({ roles: { planner: { bogus: "x" } } });
    expect(r.success).toBe(false);
  });

  it("REJECTS planner.exe (mirrors orchestrator's strict shape — exe is not a form field)", () => {
    const r = ScaffoldFormSchema.safeParse({ roles: { planner: { exe: "my-codex" } } });
    expect(r.success).toBe(false);
  });
});

describe("isolation write path (M1a)", () => {
  it("buildConfigYaml round-trips isolation.worker.cleanRoom:true through the strict schema", async () => {
    const text = buildConfigYaml(ScaffoldFormSchema.parse({ isolation: { worker: { cleanRoom: true } } }));
    const parsed = parseYaml(text) as { isolation: { worker: { cleanRoom: boolean } } };
    expect(parsed.isolation.worker.cleanRoom).toBe(true);
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo);
    expect(cfg.isolation.worker.cleanRoom).toBe(true);
    expect(cfg.isolation.worker.mcp).toBe(false); // unset sub-fields default false
  });

  it("mergeConfigYaml merges isolation into an existing config without dropping other fields", () => {
    const existing = "antiDrift:\n  model: custom-model\nisolation:\n  worker:\n    mcp: true\n";
    const text = mergeConfigYaml(existing, ScaffoldFormSchema.parse({ isolation: { worker: { cleanRoom: true } } }));
    const parsed = parseYaml(text) as {
      antiDrift: { model: string };
      isolation: { worker: { cleanRoom: boolean; mcp: boolean } };
    };
    expect(parsed.antiDrift.model).toBe("custom-model"); // survives untouched
    expect(parsed.isolation.worker.mcp).toBe(true); // hand-set sub-field preserved
    expect(parsed.isolation.worker.cleanRoom).toBe(true); // updated by the form
  });

  it("ScaffoldFormSchema REJECTS an unknown isolation.worker key via .strict()", () => {
    expect(ScaffoldFormSchema.safeParse({ isolation: { worker: { bogus: true } } }).success).toBe(false);
  });
});

describe("autonomy write path (spec 2026-07-19)", () => {
  it("accepts an autonomy opt-in in the write form", () => {
    const parsed = ScaffoldFormSchema.safeParse({ autonomy: { overnight: { enabled: true } } });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown autonomy sub-key", () => {
    expect(ScaffoldFormSchema.safeParse({ autonomy: { overnight: { enable: true } } }).success).toBe(false);
  });

  it("does not accept maxAutoReworks from the form (YAML-only field)", () => {
    expect(ScaffoldFormSchema.safeParse({ autonomy: { overnight: { maxAutoReworks: 5 } } }).success).toBe(false);
  });

  it("mergeConfigYaml merges the opt-in into an existing config, preserving a hand-set maxAutoReworks", () => {
    // Closest analogue to the isolation merge test above: proves the PATCH write
    // path actually persists autonomy.overnight.enabled rather than silently
    // dropping it (mergeConfigYaml only applies keys it explicitly handles).
    const existing = "antiDrift:\n  model: custom-model\nautonomy:\n  overnight:\n    maxAutoReworks: 5\n";
    const text = mergeConfigYaml(existing, ScaffoldFormSchema.parse({ autonomy: { overnight: { enabled: true } } }));
    const parsed = parseYaml(text) as {
      antiDrift: { model: string };
      autonomy: { overnight: { enabled: boolean; maxAutoReworks: number } };
    };
    expect(parsed.antiDrift.model).toBe("custom-model"); // survives untouched
    expect(parsed.autonomy.overnight.maxAutoReworks).toBe(5); // hand-set YAML-only field preserved
    expect(parsed.autonomy.overnight.enabled).toBe(true); // updated by the form
  });
});

describe("scaffoldProject", () => {
  it("creates the full skeleton on a fresh repo: queue dirs, runtime, escalations, runs, worktrees, stubs, config", async () => {
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res.skipped).toBe(false);

    for (const q of ["pending", "active", "done", "escalated", "quarantine"]) {
      expect(existsSync(join(repo, ".autodev", "queue", q))).toBe(true);
    }
    for (const d of ["runtime", "escalations", "runs", "worktrees"]) {
      expect(existsSync(join(repo, ".autodev", d))).toBe(true);
    }
    expect(existsSync(join(repo, ".autodev", "GOAL.md"))).toBe(true);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);
  });

  it("the scaffolded INVARIANTS.md stub parses via parseInvariants with zero zones", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const inv = parseInvariants(readFileSync(join(repo, ".autodev", "INVARIANTS.md"), "utf8"));
    expect(inv.contract_zones).toEqual([]);
    expect(inv.constitution.path_globs).toEqual([]);
  });

  it("writes .autodev/GUARDS.md, and it parses to zero rows (adr/006 Phase 1 -- the scaffold configures guardsFile but never wrote it)", async () => {
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(true);
    expect(res.written).toContain(".autodev/GUARDS.md");
    const rows = parseGuardsTable(readFileSync(join(repo, ".autodev", "GUARDS.md"), "utf8"));
    expect(rows).toEqual([]);
  });

  it("the scaffolded config loads with the GUARDS.md stub in place (guardsFile fail-closed no longer trips on a fresh scaffold)", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const cfg = await loadConfig(repo);
    expect(cfg.contract.guardsFile).toBe(".autodev/GUARDS.md");
    expect(existsSync(join(repo, cfg.contract.guardsFile))).toBe(true);
  });

  it("the scaffolded config round-trips through loadConfig (strict schema passes)", async () => {
    await scaffoldProject(
      repo,
      ScaffoldFormSchema.parse({ gate: { checkCommand: "npm test" } }),
    );
    const cfg = await loadConfig(repo);
    expect(cfg.gate.checkCommand).toBe("npm test");
  });

  it("appends .autodev/ to .git/info/exclude exactly once (idempotent)", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".autodev/");

    // Second scaffold on the same repo: skipped, and no duplicate line
    const res2 = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res2.skipped).toBe(true);
    const again = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(again.split(/\r?\n/).filter((l) => l.trim() === ".autodev/").length).toBe(1);
  });

  it("preserves existing content in .git/info/exclude, appending with a clean newline", async () => {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/"); // note: no trailing newline
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("node_modules/");
    expect(exclude.split(/\r?\n/).map((l) => l.trim())).toContain(".autodev/");
  });

  it("also excludes .serena/ (tooling-churn dir) alongside .autodev/ (s32)", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const lines = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain(".autodev/");
    expect(lines).toContain(".serena/");
  });

  it("adds only the MISSING churn entry when .autodev/ is already excluded (per-entry idempotent, no dup)", async () => {
    // Pre-existing exclude already carries .autodev/ but NOT .serena/, and no config.yaml
    // yet so the scaffold proceeds and ensureGitExclude runs.
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), ".autodev/\n");
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const lines = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === ".autodev/").length).toBe(1); // not duplicated
    expect(lines.filter((l) => l === ".serena/").length).toBe(1); // added once
  });

  it("skips entirely (config.yaml untouched) when .autodev/config.yaml already exists", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "# operator's own config\n");
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({ gate: { checkCommand: "x" } }));
    expect(res.skipped).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toBe("# operator's own config\n");
  });

  it("never clobbers an existing GOAL.md / INVARIANTS.md (partial .autodev without config.yaml)", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "GOAL.md"), "MY GOAL — do not touch\n");
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res.skipped).toBe(false); // no config.yaml -> scaffold proceeds
    expect(readFileSync(join(repo, ".autodev", "GOAL.md"), "utf8")).toBe("MY GOAL — do not touch\n");
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true); // still written
  });

  it("writes NOTHING when the form is invalid (config validated before any fs write)", async () => {
    // Bypass ScaffoldFormSchema deliberately to hit buildConfigYaml's round-trip guard:
    await expect(
      scaffoldProject(repo, { roles: { worker: { ladder: [] } } } as never),
    ).rejects.toThrow(ScaffoldConfigError);
    expect(existsSync(join(repo, ".autodev"))).toBe(false);
  });

  it("skips the exclude append with a WARN when .git is a FILE (worktree/submodule)", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeFileSync(join(repo, ".git"), "gitdir: ../elsewhere\n");
    const logs: string[] = [];
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}), (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(res.skipped).toBe(false);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);
    expect(logs.some((l) => l.startsWith("WARN:"))).toBe(true);
  });

  it("refuses to scaffold through a symlinked .autodev — nothing is written outside the repo (codex M3 finding 1)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-scaf-out-"));
    // 'junction' works without admin rights on Windows; plain dir symlink on POSIX.
    symlinkSync(outside, join(repo, ".autodev"), "junction");

    await expect(scaffoldProject(repo, ScaffoldFormSchema.parse({}))).rejects.toThrow(ScaffoldConfigError);

    // The symlink target must be entirely untouched — no skeleton escaped into it.
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to scaffold when a real .autodev has a symlinked child — no escape via recursive mkdir (codex re-critic)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-scaf-out2-"));
    mkdirSync(join(repo, ".autodev")); // a REAL .autodev directory...
    symlinkSync(outside, join(repo, ".autodev", "queue"), "junction"); // ...with a symlinked child

    await expect(scaffoldProject(repo, ScaffoldFormSchema.parse({}))).rejects.toThrow(ScaffoldConfigError);

    // recursive mkdir(.autodev/queue/pending) must NOT have created anything in the target.
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("ensureContractStubs (adr/006 Phase 1 Finding 2 — self-healing migration)", () => {
  it("writes the missing GUARDS.md for an already-scaffolded pre-Phase-1 project (the woodev-shipping-plugin-test case)", async () => {
    // Simulates a project scaffolded BEFORE GUARDS_STUB existed: config.yaml already
    // configures guardsFile, but the file itself was never written. Round-3 fix 1:
    // healing now requires a VERIFIED git-ignored target, so this needs a real repo
    // with .autodev actually excluded (not just the placeholder .git dir).
    await makeRealGitRepo(repo);
    writeFileSync(join(repo, ".gitignore"), ".autodev/\n");
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(
      join(repo, ".autodev", "config.yaml"),
      "contract:\n  invariantsFile: .autodev/INVARIANTS.md\n  guardsFile: .autodev/GUARDS.md\n",
    );
    const cfg = await loadConfig(repo);
    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(false); // precondition

    await ensureContractStubs(repo, cfg);

    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(true);
    expect(parseGuardsTable(readFileSync(join(repo, ".autodev", "GUARDS.md"), "utf8"))).toEqual([]);
  });

  it("round-2 fix 1: does NOT heal invariantsFile even when explicitly configured and absent -- while guardsFile in the SAME run IS healed", async () => {
    // A missing INVARIANTS.md degrades to "zero zones" -- a VACUOUS pass, the unsafe
    // fail-OPEN direction (Principle 10/14). Auto-writing INVARIANTS_STUB would convert
    // the loader's fail-closed throw into exactly that silent vacuous pass, which is the
    // failure `adr/006` Phase 1 exists to remove. A missing GUARDS.md degrades to "no
    // guards" -- a touched auto_guardable zone reads as UNCOVERED and escalates, the safe
    // fail-CLOSED direction -- so healing guardsFile is safe and stays.
    await makeRealGitRepo(repo);
    writeFileSync(join(repo, ".gitignore"), ".autodev/\n");
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(
      join(repo, ".autodev", "config.yaml"),
      "contract:\n  invariantsFile: .autodev/INVARIANTS.md\n  guardsFile: .autodev/GUARDS.md\n",
    );
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    expect(existsSync(join(repo, ".autodev", "INVARIANTS.md"))).toBe(false);
    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(true);
  });

  it("does NOT write when guardsFile is not explicitly configured (schema default, nothing to heal)", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), ""); // empty file -> all schema defaults, nothing configured
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    // Default cfg.contract.guardsFile is "GUARDS.md" (repoRoot-relative, not under
    // stateDir) -- nothing was explicitly configured, so nothing is written anywhere.
    expect(existsSync(join(repo, "GUARDS.md"))).toBe(false);
    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(false);
  });

  it("does NOT write when the configured path resolves OUTSIDE stateDir -- the fail-closed throw stands for a real, operator-owned contract file", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: contract/GUARDS.md\n");
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    expect(existsSync(join(repo, "contract", "GUARDS.md"))).toBe(false);
  });

  it("never clobbers an existing GUARDS.md (already healed, or hand-authored by the operator)", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(
      join(repo, ".autodev", "config.yaml"),
      "contract:\n  guardsFile: .autodev/GUARDS.md\n",
    );
    writeFileSync(join(repo, ".autodev", "GUARDS.md"), "MY HAND-WRITTEN GUARDS -- do not touch\n");
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    expect(readFileSync(join(repo, ".autodev", "GUARDS.md"), "utf8")).toBe("MY HAND-WRITTEN GUARDS -- do not touch\n");
  });

  it("is a best-effort no-op (never throws) when the project's config.yaml is unreadable/invalid", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: .autodev/GUARDS.md\n");
    const cfg = await loadConfig(repo);
    // Corrupt config.yaml AFTER computing `cfg` (mirrors the real startup-pass timing:
    // ensureContractStubs re-reads raw config itself and must not blow up the caller).
    writeFileSync(join(repo, ".autodev", "config.yaml"), "not: [valid, yaml, contract:\n");

    const logs: string[] = [];
    await expect(ensureContractStubs(repo, cfg, (lvl, msg) => logs.push(`${lvl}:${msg}`))).resolves.toBeUndefined();
    expect(logs.some((l) => l.startsWith("WARN:"))).toBe(true);
  });

  it("round-2 fix 2(i): a symlinked INTERMEDIATE directory inside stateDir -> no write anywhere, even though the parent lstats as a real directory through the link", async () => {
    // `.autodev/link` is a symlink pointing OUTSIDE the repo; `outside/deep` is a REAL
    // directory over there. Lexically `.autodev/link/deep/GUARDS.md` still starts with
    // the `stateDirAbs` prefix (the old `abs.startsWith(stateDirAbs + sep)` check would
    // pass it), and `lstat` on the parent follows the symlink and sees a real directory
    // -- but the REAL location is `outside/deep`, entirely outside the repo.
    const outside = mkdtempSync(join(tmpdir(), "adh-heal-escape-"));
    try {
      mkdirSync(join(outside, "deep"), { recursive: true });
      mkdirSync(join(repo, ".autodev"), { recursive: true });
      symlinkSync(outside, join(repo, ".autodev", "link"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: .autodev/link/deep/GUARDS.md\n");
      const cfg = await loadConfig(repo);

      await ensureContractStubs(repo, cfg);

      expect(existsSync(join(outside, "deep", "GUARDS.md"))).toBe(false);
      expect(existsSync(join(repo, ".autodev", "link", "deep", "GUARDS.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("round-2 fix 2(ii): cfg.stateDir escaping repoRoot via '..' -> no write", async () => {
    // `stateDir: ../<outside>` resolves (lexically AND actually, since `outside` is a
    // real sibling tmp dir) to a location outside `repo`. Nothing configured under it
    // may ever be healed, no matter what the configured guardsFile path itself looks like.
    const outside = mkdtempSync(join(tmpdir(), "adh-statedir-escape-"));
    try {
      const relOutside = join("..", basename(outside));
      mkdirSync(join(repo, ".autodev"), { recursive: true });
      writeFileSync(
        join(repo, ".autodev", "config.yaml"),
        `stateDir: ${relOutside}\ncontract:\n  guardsFile: ${join(relOutside, "GUARDS.md")}\n`,
      );
      const cfg = await loadConfig(repo);

      await ensureContractStubs(repo, cfg);

      expect(existsSync(join(outside, "GUARDS.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("ensureContractStubs (round-3 fix 1 — VERIFY git-ignored via `git check-ignore`, don't assume it)", () => {
  it("target path IS verified git-ignored (real repo + .gitignore rule) -> the stub IS written", async () => {
    await makeRealGitRepo(repo);
    writeFileSync(join(repo, ".gitignore"), ".autodev/\n");
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: .autodev/GUARDS.md\n");
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(true);
  });

  it("target path is NOT git-ignored (real repo, no ignore rule -- a tracked/visible dir) -> NO file is created", async () => {
    // Simulates the exact hazard the finding describes: `cfg.stateDir` pointed at a
    // directory that is NOT git-excluded (e.g. an operator repointing stateDir at a
    // tracked `config/`). Writing here would dirty `git status --porcelain` on every
    // daemon startup -> `mergeAfterGate` refuses -> every task escalates `blocked`.
    await makeRealGitRepo(repo);
    // Deliberately NO .gitignore / .git/info/exclude entry for .autodev/.
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: .autodev/GUARDS.md\n");
    const cfg = await loadConfig(repo);

    await ensureContractStubs(repo, cfg);

    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(false);
  });

  it("the git-ignore check itself cannot be performed (not a git repo at all) -> no write, and ensureContractStubs never throws", async () => {
    // `repo`'s `.git` is `beforeEach`'s placeholder DIR, not a real repository --
    // `git check-ignore` run against it fails (non-zero exit / no valid repo), which
    // must be treated the SAME as "not ignored": skip the heal, never write. The
    // fail-closed loader throw this migration exists to prevent then simply stands,
    // and it names the missing path (self-diagnosing) -- correct behavior, not a bug.
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "contract:\n  guardsFile: .autodev/GUARDS.md\n");
    const cfg = await loadConfig(repo);

    await expect(ensureContractStubs(repo, cfg)).resolves.toBeUndefined(); // never throws
    expect(existsSync(join(repo, ".autodev", "GUARDS.md"))).toBe(false);
  });
});
