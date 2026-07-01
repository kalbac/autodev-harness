import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCriticAdapter } from "./codex-adapter.js";
import { buildCriticPrompt } from "./prompt.js";
import { HarnessConfigSchema } from "../config/schema.js";
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
    expect(call.command).toBe(cfg.critic.exe);
    expect(call.args).toEqual([
      "exec",
      "-m",
      cfg.critic.model,
      "-c",
      `model_reasoning_effort="${cfg.critic.effort}"`,
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

  it("unparseable output + non-4 exit -> null verdict, not rate-limited", async () => {
    const dir = makeTempDir();
    const cfg = HarnessConfigSchema.parse({});
    const runner = new FakeRunner([{ result: okResult({ exitCode: 1, stdout: "garbage", stderr: "also garbage" }) }]);
    const adapter = new CodexCriticAdapter({ cfg, repoRoot: "/repo", runner: runner.run, schemaPath: "/schema.json" });

    const result = await adapter.run({ diff: "diff content", runtimeDir: dir, workerReportPath: null });

    expect(result.verdict).toBeNull();
    expect(result.rateLimited).toBe(false);
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

