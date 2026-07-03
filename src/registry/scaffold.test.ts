import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, buildConfigYaml, ScaffoldConfigError, ScaffoldFormSchema } from "./scaffold.js";
import { loadConfig } from "../config/config.js";
import { parseInvariants } from "../gate/invariants.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adh-scaf-"));
  mkdirSync(join(repo, ".git")); // a plain .git DIR by default
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

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
