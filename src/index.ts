// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags, constructs every real dependency,
// and starts it). This module is the production composition root — it is
// integration glue that spawns real `claude`/`codex`/`git`, so it is
// deliberately NOT unit-tested; every module it wires already has its own
// unit tests against injected fakes.
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { detectRepoRoot, loadConfig } from "./config/config.js";
import { createApiServer } from "./api/server.js";
import { buildProjectConfigView } from "./api/config-view.js";
import { buildProjectRoot, type ProjectRoot } from "./composition/root.js";
import { buildReadSnapshot, createReadCapability } from "./orchestrator/capabilities.js";
import { loadRegistry } from "./registry/registry.js";
import { createProjectAdmin } from "./registry/admin.js";
import { ensureContractStubs } from "./registry/scaffold.js";
import { listDirs } from "./fsbrowse/fsbrowse.js";
import { detectAgents } from "./detect/detect-agents.js";
import { detectGit } from "./detect/detect-git.js";
import { probeAgentExtensions } from "./detect/agent-extensions.js";
import { resolveWorkerExe, workerIsolationFlags } from "./config/roles.js";
import { createProjectHub } from "./hub/hub.js";
import { createLogger } from "./util/log.js";
import { createGit } from "./util/git.js";
import { ensureAutodevBranch } from "./util/ensure-branch.js";
import type { ConductorRunOptions } from "./conductor/conductor.js";
import { loadSettings, saveSettings, defaultSettingsFile } from "./settings/settings.js";
import { countOptedIn } from "./settings/opt-in-count.js";
import { parseEvalArgs, runEval, type EvalArgs } from "./eval/eval-cli.js";
import { loadCorpus } from "./eval/corpus-loader.js";
import { createCaseExecutor } from "./eval/case-executor.js";
import { createHarnessCaseEnvironment } from "./eval/harness-case-environment.js";
import { assertArtifactsRootSafe } from "./eval/artifacts-root.js";
import { assertAgentCiRunnable } from "./eval/eval-preflight.js";
import type { CorpusCaseResult } from "./eval/corpus-metrics.js";
import {
  buildCorpusRunManifest,
  renderCorpusRunManifest,
  CORPUS_RUN_MANIFEST_FILE,
} from "./eval/corpus-run-manifest.js";
import { detectAgentCiCapability } from "./gate/agent-ci.js";
import { runNative } from "./util/native.js";
import { safeErrorText, safeLog } from "./util/safe-log.js";

/** Parse a `--max-iterations` value; a non-positive-integer must fail LOUD, never
 * silently disable the limit (NaN would make the conductor's `iterations >= max`
 * guard perpetually false). */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** `--once` / `--max-iterations <n>` / `--max-iterations=<n>` from `process.argv.slice(2)`. */
function parseArgs(argv: string[]): ConductorRunOptions {
  let once = false;
  let maxIterations: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--once") {
      once = true;
    } else if (arg === "--max-iterations") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error("--max-iterations: missing value (expected a positive integer)");
      }
      maxIterations = parsePositiveInt(val, arg);
      i++;
    } else if (arg.startsWith("--max-iterations=")) {
      maxIterations = parsePositiveInt(arg.slice("--max-iterations=".length), "--max-iterations");
    }
  }

  return {
    ...(once ? { once } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

type CliCommand =
  | { mode: "run"; runOpts: ConductorRunOptions }
  | { mode: "orchestrate"; intent: string }
  | { mode: "serve"; port: number }
  | { mode: "report-run"; runId: string }
  | { mode: "report-qualify"; from?: string; to?: string }
  | { mode: "report-morning"; since?: string }
  | { mode: "eval"; args: EvalArgs };

/** Default bind port for `serve` when `--port` is omitted. */
const DEFAULT_SERVE_PORT = 4319;

/** `--port <n>` / `--port=<n>` from the args after `serve`. Mirrors `--max-iterations` parsing style. */
function parseServeArgs(argv: string[]): { port: number } {
  let port = DEFAULT_SERVE_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--port") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error("--port: missing value (expected a positive integer)");
      }
      port = parsePositiveInt(val, arg);
      i++;
    } else if (arg.startsWith("--port=")) {
      port = parsePositiveInt(arg.slice("--port=".length), "--port");
    }
  }

  return { port };
}

const REPORT_USAGE =
  "usage: report run <runId> | report qualify [--from <sha>] [--to <sha>] | report morning [--since <ISO>]";

/** `--from <sha>` / `--from=<sha>` (and the same for `--to`) from the args after
 *  `report qualify`. Mirrors the `--port` / `--max-iterations` parsing style: a flag
 *  with no value is a LOUD usage error, never a silently-dropped bound. */
function parseQualifyArgs(argv: string[]): { from?: string; to?: string } {
  let from: string | undefined;
  let to: string | undefined;

  const take = (flag: "--from" | "--to", i: number): string => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("-")) {
      throw new Error(`${flag}: missing value (expected a commit-ish)`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--from") {
      from = take("--from", i);
      i++;
    } else if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
    } else if (arg === "--to") {
      to = take("--to", i);
      i++;
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
    } else {
      throw new Error(`report qualify: unexpected argument ${JSON.stringify(arg)} (${REPORT_USAGE})`);
    }
  }

  // Spread-built so an omitted flag is ABSENT, never an explicit `undefined`
  // (exactOptionalPropertyTypes).
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** `report run <runId>` / `report qualify [--from <sha>] [--to <sha>]` /
 *  `report morning [--since <ISO>]`. Exported for the CLI-parse test. */
export function parseReportArgs(argv: string[]): CliCommand {
  const verb = argv[0];
  if (verb === "run") {
    const runId = (argv[1] ?? "").trim();
    if (runId === "") {
      throw new Error(`report run: missing run id (${REPORT_USAGE})`);
    }
    return { mode: "report-run", runId };
  }
  if (verb === "qualify") {
    return { mode: "report-qualify", ...parseQualifyArgs(argv.slice(1)) };
  }
  if (verb === "morning") {
    const argv2 = argv.slice(1);
    let since: string | undefined;
    for (let i = 0; i < argv2.length; i++) {
      const arg = argv2[i];
      if (arg === "--since") {
        const val = argv2[i + 1];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--since: missing value (expected an ISO timestamp)");
        }
        since = val;
        i++;
      } else if (arg !== undefined && arg.startsWith("--since=")) {
        since = arg.slice("--since=".length);
      } else {
        throw new Error(`report morning: unexpected argument ${JSON.stringify(arg ?? "")} (${REPORT_USAGE})`);
      }
    }
    // Validate at the boundary: an unparseable `--since` must be a LOUD error, never a
    // silently-ignored filter (the pure builder falls back to no-filter on a NaN sinceMs).
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new Error(`report morning: --since must be an ISO timestamp, got ${JSON.stringify(since)}`);
    }
    return { mode: "report-morning", ...(since !== undefined ? { since } : {}) };
  }
  throw new Error(`report: unknown subcommand ${JSON.stringify(verb ?? "")} (${REPORT_USAGE})`);
}

/**
 * Top-level CLI dispatch. `orchestrate <intent...>` runs the LLM orchestrator
 * over the operator's intent (decompose → enqueue → bounded trigger); `serve
 * [--port N]` boots the read-only dashboard API (+ static UI bundle when built)
 * bound to loopback only; `report run <runId>` / `report qualify` print the two
 * reports as Markdown; `eval` drives the Evaluation Corpus against the cwd's repo
 * and prints the Corpus Report; anything else is the default deterministic run
 * mode, honoring `--once` / `--max-iterations`. The remaining args after
 * `orchestrate` are joined so both `orchestrate "build X"` and `orchestrate build
 * X` work.
 */
function parseCli(argv: string[]): CliCommand {
  if (argv[0] === "orchestrate") {
    const intent = argv.slice(1).join(" ").trim();
    if (intent === "") {
      throw new Error('orchestrate: missing intent (usage: orchestrate "<what to build>")');
    }
    return { mode: "orchestrate", intent };
  }
  if (argv[0] === "serve") {
    return { mode: "serve", ...parseServeArgs(argv.slice(1)) };
  }
  if (argv[0] === "report") {
    return parseReportArgs(argv.slice(1));
  }
  if (argv[0] === "eval") {
    return { mode: "eval", args: parseEvalArgs(argv.slice(1)) };
  }
  return { mode: "run", runOpts: parseArgs(argv) };
}

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.mode === "serve") {
    // serve is DAEMON-GLOBAL: no cwd binding, no detectRepoRoot (spec §3b).
    const log = createLogger(join(homedir(), ".autodev", "daemon.log"));
    const registryFile = process.env["AUTODEV_REGISTRY"] ?? join(homedir(), ".autodev", "projects.json");
    const settingsFile = defaultSettingsFile(homedir());

    const hub = createProjectHub<ProjectRoot>({
      loadEntries: async () => (await loadRegistry(registryFile, log)).projects,
      buildRoot: (entry) => buildProjectRoot(entry.path),
      log,
    });

    // Project admin (New Project flow, M3): register/unregister + the folder
    // browser's registry-membership check. Same registry file as the hub, so a
    // registration is visible to hub.list()/get() on the next call.
    const admin = createProjectAdmin({ registryFile, log });

    // Defensive branch-ensure for ALREADY-registered projects (s30 Task 1): a
    // project left on master/main can't run (conductor guard). Best-effort /
    // never-throws — one broken project must not abort the whole daemon start.
    try {
      const { projects } = await loadRegistry(registryFile, log);
      for (const entry of projects) {
        try {
          if (!existsSync(join(entry.path, ".git"))) continue;
          const r = await ensureAutodevBranch(createGit(entry.path), { log });
          if (r.switched) log("INFO", `serve: ${entry.path} -> branch ${r.branch}`);
        } catch (err) {
          log("WARN", `serve: ensure-branch failed for ${entry.path}: ${String(err)}`);
        }
        // Self-healing contract-stub migration (adr/006 Phase 1 Finding 2): an
        // already-scaffolded project from BEFORE the fail-closed loader shipped
        // has `contract.guardsFile`/`invariantsFile` CONFIGURED but the file was
        // never written -- root.ts's loaders now THROW on that combination,
        // escalating every task as "broken -- operator config". Own try/catch,
        // same isolation as the branch-ensure step above -- `ensureContractStubs`
        // is itself best-effort/never-throws, but `loadConfig` (to get `cfg`) can.
        // NOTE: this only runs under `serve` -- the bare `run` CLI verb is NOT
        // healed (kept out of scope; an operator hitting this via `run` still
        // gets the actionable fail-closed throw naming the missing path, which
        // is self-diagnosing).
        try {
          const cfg = await loadConfig(entry.path);
          await ensureContractStubs(entry.path, cfg, log);
        } catch (err) {
          log("WARN", `serve: ensureContractStubs failed for ${entry.path}: ${String(err)}`);
        }
      }
    } catch (err) {
      log("WARN", `serve: branch-ensure startup pass skipped: ${String(err)}`);
    }

    // UI bundle lives with the INSTALL, not any project (closes [ui/serve-uidir-reporoot]):
    // compiled layout is dist/index.js + dist/ui. AUTODEV_UI_DIR overrides (dev runs vite anyway).
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const uiDirCandidate = process.env["AUTODEV_UI_DIR"] ?? join(moduleDir, "ui");
    const uiDir = existsSync(uiDirCandidate) ? uiDirCandidate : undefined;

    const handle = createApiServer({
      projects: {
        list: () => hub.list(),
        get: async (id) => {
          const r = await hub.get(id);
          if (r === null || "error" in r) return r;
          const root = r.root;
          const c = root.cfg;
          return {
            view: {
              repo: root.repo,
              stateDir: root.stateDirAbs,
              onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
              config: buildProjectConfigView(c, root.plannerConfigured),
              // Best-effort extension-visibility scan under the project's CURRENT saved
              // isolation. Thin closure over repoRoot + cfg so the HTTP layer never sees
              // the repoRoot/spawn. model is irrelevant to WHICH extensions load (we kill
              // before any turn); ladder[0] is a safe, cheap pick.
              onScanExtensions: () =>
                probeAgentExtensions({
                  exe: resolveWorkerExe(c),
                  cwd: root.repoRoot,
                  model: c.roles.worker.ladder[0] ?? "haiku",
                  isolationFlags: workerIsolationFlags(c),
                }),
              onApplyOnAccept: (taskId: string) => root.applyOnAccept(taskId),
              // Reply-B (rework) re-queued a task to pending/. Trigger a bounded
              // drain so it actually runs (carrying the critic's persisted
              // objection) instead of waiting for an unrelated pool trigger.
              // R1-thin: a pure `trigger` of the already-enqueued pool. Fire-and-
              // forget + best-effort (the conductor logs its own run errors to
              // conductor.log; a rejection here must never surface to the reply
              // response). See [rework/reply-b-drops-critic-feedback].
              onReplyRework: (taskId: string) => {
                void root.conductor.run({ drain: true }).catch(() => {});
                // Re-arm the narrator for a thread parked `blocked` on this
                // task's escalation so the re-run is narrated live again
                // ([narrator/escalated-run-not-terminal]). Fire-and-forget +
                // best-effort: the reply's 200 must not depend on it.
                void root.rearmNarratorForTask(id, taskId).catch(() => {});
              },
              // Pre-launch chat (adr/003-safe -- see chat-adapter.ts): `manager` is
              // the project's lazily-built ChatSessionManager (composition/root.ts);
              // `buildSnapshot` gives the chat's opening turn the SAME ReadSnapshot
              // shape `handleIntent` uses, over the SAME repo, so "current state"
              // never drifts between the two call sites.
              chat: {
                manager: root.chat,
                buildSnapshot: () => buildReadSnapshot(createReadCapability(root.repo)),
              },
              // Live-orchestrator threads (adr/004): pre-launch chat service +
              // post-launch narrator. `onOrchestrate` reuses the SAME R1-thin
              // launcher the /orchestrate route uses; the launch-guard set is a
              // FRESH per-project Set (thread-launch single-flight is separate
              // from the HTTP /orchestrate route's set -- acceptable because the
              // orchestrator's handleIntent has its own intent-level dedup).
              // buildThreads memoizes, so only the first Set is ever captured.
              threads: root.buildThreads({
                onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
                inFlight: new Set<string>(),
              }),
              ci: root.ci,
              onCiCapability: root.onCiCapability,
              // On-demand Product Qualification Report (spec 2026-07-22 D4). Thin
              // closure over the project's repoRoot + blackboard -- the HTTP layer
              // never sees a git handle. Rejects (never returns an empty report)
              // when the commit range cannot be resolved.
              onQualificationReport: (range) => root.qualificationReport(range),
              // The stored Execution Report, read through the composition root so
              // its filename keeps exactly ONE builder (`executionReportPath`).
              readExecutionReportJson: (runId) => root.readExecutionReportJson(runId),
              // On-demand Morning Report (spec 2026-07-23): reconciles the overnight
              // decision journal against the live blackboard and narrates it via the
              // orchestrator model. GET-only (a read, not an action) -- unwrap to the
              // report doc itself, which is what `GET .../morning-report` returns.
              onMorningReport: (opts) => root.morningReport(opts).then(({ report }) => report),
            },
          };
        },
      },
      admin: {
        register: (input) => admin.register(input),
        unregister: async (id) => {
          const ok = await admin.unregister(id);
          // The project no longer resolves through the normal routes, so an
          // open chat's cancel route becomes unreachable -- close it here
          // rather than leaving the live claude subprocess for the idle
          // reaper to eventually clean up.
          await handle.closeProjectChat(id);
          return ok;
        },
        rename: (id, name) => admin.rename(id, name),
        updateConfig: async (id, form) => {
          const result = await admin.updateConfig(id, form);
          // config.yaml changed on disk -- drop the cached ProjectRoot (and any stale
          // error) so the NEXT hub.get() rebuilds from the fresh file. An
          // already-in-flight run keeps whatever root it already captured.
          if (result.ok) {
            hub.evict(id);
            // Any open chat was started under the now-stale root/config --
            // close it rather than let it keep running against a root the
            // project no longer uses.
            await handle.closeProjectChat(id);
          }
          return result;
        },
        listDirs: (path) => listDirs(path, { isRegistered: (abs) => admin.isRegistered(abs) }),
        detectAgents: () => detectAgents({}),
        initGit: (path) => admin.initGit(path),
        detectGit: () => detectGit({}),
      },
      settings: {
        read: async () => {
          const s = await loadSettings(settingsFile, log);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: s.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
        write: async (next) => {
          await saveSettings(settingsFile, next);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: next.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
      },
      ...(uiDir !== undefined ? { uiDir } : {}),
      log,
    });
    const boundPort = await handle.listen(command.port, "127.0.0.1");
    log(
      "INFO",
      `serve: listening at http://127.0.0.1:${boundPort} — registry ${registryFile}${
        uiDir ? "" : ` (API only -- no UI bundle at ${uiDirCandidate})`
      }`,
    );
    return; // the listening server keeps the event loop alive; do not tear it down
  }

  const repoRoot = detectRepoRoot(process.cwd());
  const root = await buildProjectRoot(repoRoot);

  if (command.mode === "orchestrate") {
    const result = await root.orchestrator.handleIntent(command.intent);
    root.log("INFO", `orchestrate: ${result.enqueued.length} task(s) enqueued; triggered=${result.triggered}`);
    for (const t of result.enqueued) root.log("INFO", `  - ${t.id} -> ${t.path}`);
    return;
  }

  if (command.mode === "report-run") {
    // Refresh first so a run that finished under an older build (or whose report
    // write was interrupted) still yields one; `refreshReports` skips any run that
    // already has a report and never throws.
    await root.refreshReports();
    const markdown = await root.readExecutionReport(command.runId);
    if (markdown === null) {
      throw new Error(
        `report run: no execution report for '${command.runId}' -- the run has no manifest, or it is not finished yet`,
      );
    }
    printMarkdown(markdown);
    return;
  }

  if (command.mode === "report-qualify") {
    const { markdown } = await root.qualificationReport({
      ...(command.from !== undefined ? { from: command.from } : {}),
      ...(command.to !== undefined ? { to: command.to } : {}),
    });
    printMarkdown(markdown);
    return;
  }

  if (command.mode === "report-morning") {
    const { markdown } = await root.morningReport({
      ...(command.since !== undefined ? { since: command.since } : {}),
    });
    printMarkdown(markdown);
    return;
  }

  if (command.mode === "eval") {
    // Evaluation Corpus (Phase 2). ON DEMAND only, never in CI: every case drives real
    // worker/critic calls, which are costly and non-deterministic. The corpus ships with
    // the HARNESS install (not the target repo) so the cases the harness is measured
    // against cannot be edited by the worker whose work they measure.

    // Preflight, before anything else touches the target repo (#132 / Fix 5ii): a target
    // project with `gate.agentCi.enabled: true` (workflows configured) on a machine that
    // cannot actually run agent-ci would otherwise escalate every case for an environment
    // reason and still finish, still write a report -- a run that measures nothing while
    // looking exactly like a real measurement. The gate itself already fails safely per
    // task; this stops the WHOLE RUN before it wastes minutes proving that repeatedly.
    //
    // The capability probe itself spawns `wsl.exe` on Windows (a real subprocess, seconds
    // of wall-clock), so it is only invoked when agent-ci would actually engage -- an
    // every-run cost for the common case (agentCi disabled) would be its own small version
    // of the same "silent overhead nobody asked for" this fix exists to remove elsewhere.
    // `assertAgentCiRunnable` re-checks `enabled`/`hasWorkflows` itself regardless, so this
    // is purely an optimization, never a second copy of the decision.
    const agentCiCfg = root.cfg.gate.agentCi;
    const agentCiHasWorkflows = agentCiCfg.workflows.length > 0;
    if (agentCiCfg.enabled && agentCiHasWorkflows) {
      // Real capability probe (native/WSL/unavailable) -- the same one `root.ts` wires
      // into the actual gate, so this asks the identical question the gate itself would.
      await assertAgentCiRunnable({
        enabled: true,
        hasWorkflows: true,
        capability: await detectAgentCiCapability(),
      });
    }

    const moduleDir2 = dirname(fileURLToPath(import.meta.url));
    const corpusDir = command.args.corpus ?? join(moduleDir2, "..", "corpus");

    // Diagnostics land under the target repo's git-excluded state directory by default:
    // it is not purged between cases, it dirties neither repo, and it sits beside the
    // `conductor.log` a reader will want next to it. Everything here is a copy — deleting
    // the whole directory loses no measurement.
    const artifactsDir = resolve(command.args.artifacts ?? join(root.stateDirAbs, "corpus-artifacts"));
    const manifestPath = join(artifactsDir, CORPUS_RUN_MANIFEST_FILE);
    // Unique per process: a fixed `.tmp` name is shared by two concurrent `eval` runs, and
    // the corpus lock does not serialize them until `resetToBaseline` (codex R2).
    // RESIDUALS, named: a crash between write and rename leaves this file behind (it is
    // pid-suffixed so it reads as debris, and the same pid's leftover is removed below); and
    // two concurrent runs still share the published `manifestPath`. The lock is deliberately
    // NOT moved earlier to fix that — it exists to protect the target repo's STATE, and the
    // worst case here is a diagnostics file replaced by a run that then immediately refuses
    // on the lock, leaving an honest `partial: true` manifest (codex R3, declined with this
    // rationale).
    const manifestTmp = `${manifestPath}.${process.pid}.tmp`;

    // The artifacts root is validated BEFORE anything is written or deleted, including
    // before the baseline is resolved. Ordering is the finding, not the check: doing it
    // later meant an unsafe root (say `--artifacts <repo>/some-data`) had its
    // `corpus-run.json` deleted and only THEN was refused, and an unresolvable baseline
    // threw while a previous run's complete manifest still sat there claiming to describe
    // this one (codex R3). `resetToBaseline` asks the same question again per case.
    await assertArtifactsRootSafe({
      repoRoot,
      artifactsRoot: artifactsDir,
      git: async (args) => {
        const r = await runNative("git", args, { cwd: repoRoot });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
    });

    // Now that the directory is ours to write in, drop a previous run's manifest. FAIL
    // CLOSED on anything but "already absent": swallowing an EACCES here and carrying on
    // leaves the stale manifest in place, which is the exact stale-projection this deletion
    // exists to prevent (codex R3).
    for (const stale of [manifestPath, manifestTmp]) {
      try {
        await rm(stale, { force: true });
      } catch (err) {
        throw new Error(
          `eval: cannot clear the previous run's ${stale} (${safeErrorText(err)}). Refusing to start: a stale ` +
            `manifest that survives would describe a run that never happened.`,
        );
      }
    }

    // Resolve the baseline to an IMMUTABLE commit sha ONCE, before the first case --
    // including an explicitly-passed one. Every case commits (the seed, and the work
    // itself when it lands), so a mutable commit-ish like `HEAD` or a branch name would
    // be re-resolved per case and silently drift onto the PREVIOUS case's result, making
    // each case start from a different premise than the one before it (codex R1 Medium).
    // `--end-of-options` so a ref that happens to start with a dash is parsed as an
    // OPERAND, never as a git flag (codex R2 Medium). `^{commit}` makes `--verify` reject
    // anything that is not a commit (a tree, a blob, a tag pointing at one).
    const baselineRef = command.args.baseline ?? "HEAD";
    const resolved = await runNative(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`],
      { cwd: repoRoot },
    );
    if (resolved.exitCode !== 0) {
      throw new Error(`eval: cannot resolve baseline '${baselineRef}' to a commit: ${resolved.stderr.trim()}`);
    }
    const baseline = resolved.stdout.trim();

    // NOTE: the target project's exclusive lock and idle-queue check are taken by the case
    // ENVIRONMENT on its own destructive path -- deliberately NOT called here, so no future
    // entry point can construct the environment and skip them. All this layer owes is the
    // matching `dispose()` in a `finally`.
    const cases = await loadCorpus(corpusDir);
    root.log("INFO", `eval: ${cases.length} case(s) from ${corpusDir}; baseline ${baseline}; target ${repoRoot}`);
    process.stdout.write(`Evaluation Corpus: ${cases.length} case(s) from ${corpusDir}\n`);
    process.stdout.write(`Target repo ${repoRoot} @ baseline ${baseline}\n`);
    process.stdout.write(`Artifacts ${artifactsDir}\n\n`);

    const env = createHarnessCaseEnvironment({
      root,
      corpusRoot: corpusDir,
      baseline,
      maxIterations: command.args.maxIterations,
      artifactsRoot: artifactsDir,
    });

    // Rewritten after EVERY case, not once at the end: a 12-minute run that dies on the
    // last case would otherwise leave nothing machine-readable behind. A failure to write
    // it is swallowed with a WARN for the same reason the archive is — a diagnostics
    // artifact must never be able to fail a measurement.
    //
    // Written via a temp file + `rename`, never straight to the destination: `writeFile`
    // TRUNCATES first, so a crash or ENOSPC mid-write would destroy the last good manifest
    // and leave a half-parsed one in its place. `rename` is atomic within a directory, so
    // a reader sees either the previous manifest or the new one (codex R1).
    const writeManifest = async (results: CorpusCaseResult[]): Promise<void> => {
      try {
        const manifest = buildCorpusRunManifest(
          {
            generated_at: new Date().toISOString(),
            target_repo: repoRoot,
            baseline,
            corpus_dir: corpusDir,
            artifacts_dir: artifactsDir,
            total_cases: cases.length,
          },
          results,
          // Read from the environment, which owns the record: what actually happened to each
          // case's archive, so the manifest STATES it instead of implying success by naming a
          // path (codex R3/R4).
          env.archiveStatuses(),
        );
        await mkdir(artifactsDir, { recursive: true });
        await writeFile(manifestTmp, renderCorpusRunManifest(manifest), "utf8");
        await rename(manifestTmp, manifestPath);
      } catch (err) {
        safeLog(root.log, "WARN", `eval: writing ${manifestPath} failed (ignored): ${safeErrorText(err)}`);
      }
    };

    // Write it ONCE up front, before the first case. Without this, a run that dies before
    // any case completes (an unresolvable baseline, a dirty tree, a held lock) leaves the
    // PREVIOUS run's complete manifest sitting there, and a reader has no way to tell it
    // is describing a run that never happened (codex R1). An empty, `partial: true`
    // manifest is the honest artifact for "started, got nowhere".
    await writeManifest([]);

    try {
      const executor = createCaseExecutor(env);
      const { markdown, passBar } = await runEval(
        cases,
        executor,
        (line) => process.stdout.write(`${line}\n`),
        { onProgress: writeManifest },
      );

      process.stdout.write("\n");
      printMarkdown(markdown);
      if (command.args.out !== undefined) {
        await writeFile(command.args.out, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
        process.stdout.write(`\nreport written to ${command.args.out}\n`);
      }
      process.stdout.write(`diagnostics written to ${artifactsDir} (raw evidence: ${CORPUS_RUN_MANIFEST_FILE})\n`);

      if (!passBar.met) {
        // A non-zero exit makes the bar MECHANICAL rather than a number the reader has to
        // interpret -- the same discipline the gate itself is held to.
        for (const reason of passBar.reasons) process.stderr.write(`PASS BAR NOT MET: ${reason}\n`);
        process.exitCode = 1;
      }
    } finally {
      // Purge the corpus's OWN leftover blackboard state (#132 / Fix 5i) before releasing
      // the lock. `purgeLeftoverQueue` never throws and no-ops when the corpus never took
      // ownership of the queue (see its doc comment) -- so this is safe unconditionally,
      // including on a path where no case ever ran. Ordering: purge before dispose, so the
      // purge itself still runs under the corpus's exclusive ownership of the target.
      await env.purgeLeftoverQueue();

      // Releasing the lock must not be able to mask the real failure, nor to fail a run
      // whose measurement already completed. `safeLog`/`safeErrorText` because a throwing
      // logger or a hostile `message` getter inside a catch would resurrect exactly the
      // failure this handler exists to swallow (gotcha [ts/fail-closed]; codex R5).
      await env.dispose().catch((err: unknown) => {
        safeLog(root.log, "WARN", `eval: releasing the corpus lock failed (ignored): ${safeErrorText(err)}`);
      });
    }
    return;
  }
  // Overnight autonomy (spec 2026-07-17): runOrSupervise drives the escalation supervisor
  // (drain + auto-rework/park sweep) when overnight is enabled, else a plain bounded run.
  // Either way it receives the operator's `runOpts` so no run option is silently dropped.
  await root.runOrSupervise(command.runOpts);
  // The CLI `run` path's report refresh: ONCE, after the bounded run has resolved --
  // never inside the conductor's iteration loop, because a report describes a run
  // that has FINISHED. Never throws by contract (spec 2026-07-22 H6-style: reporting
  // is bookkeeping about the loop and must not be able to fail it).
  await root.refreshReports();
}

/** Print a report body to stdout with exactly one trailing newline. */
function printMarkdown(markdown: string): void {
  process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

// Only run the daemon when this module is the actual process entry point --
// NOT when it is `import`ed (e.g. by src/index.test.ts for `parseReportArgs`).
// Without this guard, importing this file for its pure CLI-parsing helpers
// would also fire off the real `main()` (real config load, real subprocess
// spawns) as an unintended side effect of loading the test file.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
