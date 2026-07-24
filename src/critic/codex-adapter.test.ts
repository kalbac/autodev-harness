import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCriticAdapter, DEFAULT_SCHEMA_PATH } from "./codex-adapter.js";
import { buildCriticPrompt } from "./prompt.js";
import { HarnessConfigSchema } from "../config/schema.js";
import { resolveCriticExe } from "../config/roles.js";
import type { NativeOptions, NativeResult } from "../util/native.js";

const dirsToClean: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adh-critic-"));
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface RecordedCall {
  command: string;
  args: string[];
  options?: NativeOptions;
}

/** Scripted fake runner: records every call, runs an optional side-effect, replays one result per call. */
class FakeRunner {
  public readonly calls: RecordedCall[] = [];
  private readonly queue: Array<{
    result: NativeResult;
    onCall?: (args: string[]) => void;
  }>;

  constructor(queue: Array<{ result: NativeResult; onCall?: (args: string[]) => void }>) {
    this.queue = [...queue];
  }

  run = async (command: string, args: string[], options?: NativeOptions): Promise<NativeResult> => {
    this.calls.push(options !== undefined ? { command, args, options } : { command, args });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeRunner: no more scripted results");
    }
    next.onCall?.(args);
    return next.result;
  };
}

function okResult(overrides: Partial<NativeResult> = {}): NativeResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

function findOutfile(args: string[]): string {
  const idx = args.indexOf("-o");
  if (idx === -1 || args[idx + 1] === undefined) {
    throw new Error("no -o outfile arg found");
  }
  return args[idx + 1]!;
}

const cleanVerdictJson = JSON.stringify({
  verdict: "clean",
  broken_contracts: [],
  notes: "looks fine",
  confidence: 0.9,
});

describe("CodexCriticAdapter", () => {
  it("empty diff -> synthetic clean verdict, no spawn", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "", runtimeDir: "/rt", workerReportPath: null });

    expect(result.rateLimited).toBe(false);
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.verdict).toBe("clean");
    expect(result.verdict!.confidence).toBe(0.5);
    expect(result.verdict!.diff_sha256).toBeDefined();
    expect(runner.calls).toHaveLength(0);
  });

  it("empty diff (whitespace only) -> also synthetic clean, no spawn", async () => {
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "   \n  ", runtimeDir: "/rt", workerReportPath: null });

    expect(result.verdict!.verdict).toBe("clean");
    expect(runner.calls).toHaveLength(0);
  });

  it("reads verdict from the -o outfile and builds the exact pinned command", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const diff = "diff --git a/x b/x\n+1\n";
    const runner = new FakeRunner([
      {
        result: okResult({ exitCode: 0 }),
        onCall: (args) => {
          writeFileSync(findOutfile(args), cleanVerdictJson);
        },
      },
    ]);
    const adapter = new CodexCriticAdapter({
      cfg,
      repoRoot: "/repo",
      runner: runner.run,
      schemaPath: "/schema.json",
    });

    const result = await adapter.run({ diff, runtimeDir: dir, workerReportPath: null });

    expect(result.rateLimited).toBe(false);
    expect(result.verdict!.verdict).toBe("clean");
    expect(result.verdict!.diff_sha256).toBeDefined();

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.command).toBe(resolveCriticExe(cfg));
    expect(call.args).toEqual([
      "exec",
      "-m",
      cfg.roles.critic.model,
      "-c",
      `model_reasoning_effort="${cfg.roles.critic.effort}"`,
      "-c",
      `approval_policy="never"`,
      "-s",
      "read-only",
      "-C",
      "/repo",
      "--skip-git-repo-check",
      "--output-schema",
      "/schema.json",
      "-o",
      join(dir, "critic-last-message.json"),
      "-",
    ]);
    expect(call.options?.stdin).toBe(buildCriticPrompt(diff));
    expect(call.options?.cwd).toBe("/repo");
  });

  it("falls back to stdout parsing when no outfile is written", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 0, stdout: `Some prose before.\n${cleanVerdictJson}\nSome prose after.` }) },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.rateLimited).toBe(false);
    expect(result.verdict!.verdict).toBe("clean");
    expect(result.verdict!.notes).toBe("looks fine");
  });

  it("exit 4 + no parseable verdict -> rateLimited true", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([{ result: okResult({ exitCode: 4, stdout: "rate limited, no json here" }) }]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(true);
  });

  it("parsed verdict wins over exit 4 (the 2026-06-07 fix)", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      {
        result: okResult({ exitCode: 4 }),
        onCall: (args) => {
          writeFileSync(findOutfile(args), cleanVerdictJson);
        },
      },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.verdict).toBe("clean");
    expect(result.rateLimited).toBe(false);
  });

  it("parsed verdict from stdout fallback also wins over exit 4 (ordering holds on the fallback path)", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    // No outfile written — the verdict is only reachable via stdout, AND the
    // exit code is 4. A broken impl that short-circuits to rateLimited on
    // exit 4 before trying the stdout fallback would fail this.
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 4, stdout: `rate-limit-ish prose\n${cleanVerdictJson}\ntrailing prose` }) },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.verdict).toBe("clean");
    expect(result.rateLimited).toBe(false);
  });

  it("does not read a stale outfile left over from a prior round when this run writes nothing", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    // Simulate a PRIOR round having written a valid clean verdict to the
    // fixed outfile path. This run's codex exec writes nothing and rate
    // limits -- the stale file must not be mistaken for this run's verdict.
    writeFileSync(join(dir, "critic-last-message.json"), cleanVerdictJson);
    const runner = new FakeRunner([{ result: okResult({ exitCode: 4, stdout: "rate limited", stderr: "" }) }]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(true);
  });

  it("unparseable output + non-4 exit -> null verdict, not rate-limited", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([{ result: okResult({ exitCode: 1, stdout: "garbage", stderr: "also garbage" }) }]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(false);
  });

  it("non-4 exit + no verdict -> failure carries the exit code and an output detail", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 1, stdout: "", stderr: "auth error: could not reach provider" }) },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure!.exitCode).toBe(1);
    expect(result.failure!.detail).toContain("auth error");
  });

  it("runner reject (spawn failure, e.g. missing codex binary) -> null verdict, not rate-limited, failure detail", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const rejectingRunner = async (): Promise<NativeResult> => {
      throw new Error("spawn codex ENOENT");
    };
    const adapter = new CodexCriticAdapter({
      cfg,
      repoRoot: "/repo",
      runner: rejectingRunner,
      schemaPath: "/schema.json",
    });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure!.exitCode).toBe(-1);
    expect(result.failure!.detail).toContain("ENOENT");
  });

  it("a parsed clean verdict carries no failure field", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 0 }), onCall: (args) => writeFileSync(findOutfile(args), cleanVerdictJson) },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).not.toBeNull();
    expect("failure" in result).toBe(false);
  });

  it("fences the worker report for the duration of the codex call and restores it after", async () => {
    const dir = makeTempDir();
    const reportPath = join(dir, "worker-report.md");
    writeFileSync(reportPath, "original worker rationale");

    const cfg = HarnessConfigSchema.parse({});
    let sawAbsentDuringCall = false;
    const runner = new FakeRunner([
      {
        result: okResult({ exitCode: 0 }),
        onCall: (args) => {
          sawAbsentDuringCall = !existsSync(reportPath);
          writeFileSync(findOutfile(args), cleanVerdictJson);
        },
      },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: reportPath });

    expect(sawAbsentDuringCall).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe("original worker rationale");
  });

  it("attaches parsed critic usage (with the critic model) when stdout has a bare `tokens used` line", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      {
        result: okResult({ exitCode: 0, stdout: "review prose\ntokens used\n8421\n" }),
        onCall: (args) => writeFileSync(findOutfile(args), cleanVerdictJson),
      },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict!.verdict).toBe("clean");
    expect(result.usage).toEqual({ model: cfg.roles.critic.model, tokens: 8421 });
  });

  it("carries usage on the verdict-null path too (tokens are orthogonal to the verdict)", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 4, stdout: "rate limited\ntokens used: 300" }) },
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(true);
    expect(result.usage).toEqual({ model: cfg.roles.critic.model, tokens: 300 });
  });

  it("omits usage when the token line is absent, and on the no-spawn empty-diff path", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([
      { result: okResult({ exitCode: 0, stdout: cleanVerdictJson }) }, // valid verdict, no token line
    ]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const withCall = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });
    expect("usage" in withCall).toBe(false);

    const emptyRunner = new FakeRunner([]);
    const emptyAdapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: emptyRunner.run, schemaPath: "/schema.json" });
    const empty = await emptyAdapter.run({ diff: "   ", runtimeDir: dir, workerReportPath: null });
    expect("usage" in empty).toBe(false);
  });

  it("DEFAULT_SCHEMA_PATH points at an existing critic-verdict.schema.json", () => {
    expect(existsSync(DEFAULT_SCHEMA_PATH)).toBe(true);
    expect(DEFAULT_SCHEMA_PATH.endsWith("critic-verdict.schema.json")).toBe(true);
  });

  // Live integration path is behind ADH_LIVE=1 and is not part of default CI.
  const liveIt = process.env.ADH_LIVE === "1" ? it : it.skip;
  liveIt("live: runs a real codex exec call (ADH_LIVE=1 only)", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: process.cwd() });

    const result = await adapter.run({
      diff: "diff --git a/README.md b/README.md\n+hello\n",
      runtimeDir: dir,
      workerReportPath: null,
    });

    expect(typeof result.rateLimited).toBe("boolean");
    expect(result.verdict === null || typeof result.verdict.verdict === "string").toBe(true);
  });
});

