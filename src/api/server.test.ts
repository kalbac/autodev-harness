import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import type { BlackboardRepository } from "../blackboard/repository.js";
import { escalate } from "../escalate/escalate.js";
import type { EscalationInput } from "../escalate/escalate.js";
import { createApiServer, applyRunPatch, type ApiServerHandle, type ApiServerDeps, type ProjectConfigView, type ProjectView } from "./server.js";
import { ThreadEventBus } from "./thread-events.js";
import type { ThreadMeta } from "../thread/thread-types.js";
import type { RegisterResult, GitInitResult } from "../registry/admin.js";
import type { FsDirsResult } from "../fsbrowse/fsbrowse.js";
import type { DetectedAgent } from "../detect/detect-agents.js";
import type { DetectGitResult } from "../detect/detect-git.js";
import type { AgentExtensions } from "../detect/agent-extensions.js";
import { createScheduler } from "../scheduler/scheduler.js";
import { ChatSessionManager } from "../orchestrator/chat-session-manager.js";
import type { OrchestratorChatAdapter, ChatSessionHandle } from "../orchestrator/chat-adapter.js";
import type { ReadSnapshot } from "../orchestrator/adapter.js";
import { CiEventBus } from "./ci-events.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";

/**
 * The reader the composition root supplies in production (`readExecutionReportJson`),
 * modelled here over a temp stateDir. The endpoint never builds this name itself --
 * one function owns `<stateDir>/reports/<runId>.json`, and in a test that function
 * is this one.
 */
function storedReportReader(stateDir: string): (runId: string) => Promise<string | null> {
  return async (runId) => {
    const p = join(stateDir, "reports", `${runId}.json`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
}

/** Wrap a single {repo, stateDir[, onOrchestrate]} as a one-project deps object
 *  (project id "p1") -- keeps the existing single-project test bodies unchanged
 *  except for the URL prefix. */
function projectDeps(
  one: {
    repo: BlackboardRepository;
    stateDir: string;
    onOrchestrate?: (intent: string) => Promise<unknown>;
    config?: ProjectConfigView;
    onScanExtensions?: () => Promise<AgentExtensions | null>;
    onApplyOnAccept?: (taskId: string) => Promise<{ ok: true; hash: string } | { ok: false; reason: string }>;
    onReplyRework?: (taskId: string) => void;
    chat?: { manager: ChatSessionManager; buildSnapshot: () => Promise<ReadSnapshot> };
    ci?: { bus: CiEventBus; readEvents: (taskId: string) => Promise<string> };
    onCiCapability?: () => Promise<AgentCiCapability>;
    threads?: ProjectView["threads"];
    onQualificationReport?: ProjectView["onQualificationReport"];
    /** Overrides the default temp-dir-backed reader (see `storedReportReader`). */
    readExecutionReportJson?: ProjectView["readExecutionReportJson"];
  },
  extra: Partial<ApiServerDeps> = {},
): ApiServerDeps {
  return {
    projects: {
      list: async () => [{ id: "p1", name: "p1", path: one.stateDir, status: "ready" }],
      get: async (id) =>
        id === "p1"
          ? {
              view: {
                repo: one.repo,
                stateDir: one.stateDir,
                readExecutionReportJson: one.readExecutionReportJson ?? storedReportReader(one.stateDir),
                ...(one.onOrchestrate !== undefined ? { onOrchestrate: one.onOrchestrate } : {}),
                ...(one.config !== undefined ? { config: one.config } : {}),
                ...(one.onScanExtensions !== undefined ? { onScanExtensions: one.onScanExtensions } : {}),
                ...(one.onApplyOnAccept !== undefined ? { onApplyOnAccept: one.onApplyOnAccept } : {}),
                ...(one.onReplyRework !== undefined ? { onReplyRework: one.onReplyRework } : {}),
                ...(one.chat !== undefined ? { chat: one.chat } : {}),
                ...(one.ci !== undefined ? { ci: one.ci } : {}),
                ...(one.onCiCapability !== undefined ? { onCiCapability: one.onCiCapability } : {}),
                ...(one.threads !== undefined ? { threads: one.threads } : {}),
                ...(one.onQualificationReport !== undefined
                  ? { onQualificationReport: one.onQualificationReport }
                  : {}),
              },
            }
          : null,
    },
    ...extra,
  };
}

/** Prefix an API path with the default test project. */
const p1 = (path: string): string => `/projects/p1${path}`;

let root: string;
let stateDir: string;
let repo: FileBlackboardRepository;
let handle: ApiServerHandle | null;
let wsClients: WebSocket[];

/** Seed a task file directly under `<stateDir>/queue/<state>/<id>.md`, mirroring
 * the seeding style used by `src/blackboard/file-repository.test.ts`. */
function seedTask(
  state: "pending" | "active" | "done" | "escalated" | "quarantine",
  id: string,
  opts?: { fileSet?: string[]; dependsOn?: string[] },
): void {
  const dir = join(stateDir, "queue", state);
  mkdirSync(dir, { recursive: true });
  const fileSet = opts?.fileSet ?? ["src/x.ts"];
  const fileSetYaml = fileSet.map((f) => `  - ${f}`).join("\n");
  const dependsYaml =
    opts?.dependsOn && opts.dependsOn.length
      ? `depends_on:\n${opts.dependsOn.map((d) => `  - ${d}`).join("\n")}\n`
      : "";
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: t\ntype: tooling\n${dependsYaml}file_set:\n${fileSetYaml}\n---\nbody`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-api-"));
  stateDir = join(root, ".autodev");
  repo = new FileBlackboardRepository(root, ".autodev");
  handle = null;
  wsClients = [];
});

afterEach(async () => {
  for (const ws of wsClients) {
    try {
      ws.terminate();
    } catch {
      // best-effort cleanup
    }
  }
  if (handle) await handle.close();
});

describe("createApiServer / GET /state", () => {
  it("returns seeded queues with parsed task ids under the right keys", async () => {
    seedTask("pending", "p1");
    seedTask("active", "a1");
    seedTask("done", "d1");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queues: Record<string, { id: string }[]>;
      digestTail: string;
    };

    expect(body.queues.pending?.map((t) => t.id)).toEqual(["p1"]);
    expect(body.queues.active?.map((t) => t.id)).toEqual(["a1"]);
    expect(body.queues.done?.map((t) => t.id)).toEqual(["d1"]);
    expect(body.queues.escalated).toEqual([]);
    expect(body.queues.quarantine).toEqual([]);
  });

  it("includes the digest.md tail when the file exists", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "digest.md"), "[ts] first line\n[ts] second line\n[ts] LAST LINE\n");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    const body = (await res.json()) as { digestTail: string };
    expect(body.digestTail).toContain("LAST LINE");
  });

  it("never throws when digest.md is absent -- digestTail is an empty string", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digestTail: string };
    expect(body.digestTail).toBe("");
  });
});

describe("createApiServer / WS change stream", () => {
  it("pushes a {type:'change'} message to connected clients when the injected watcher fires", async () => {
    let capturedOnChange: ((path: string) => void) | null = null;
    const fakeWatchFactory = (_stateDir: string, onChange: (path: string) => void) => {
      capturedOnChange = onChange;
      return { close: () => {} };
    };

    handle = createApiServer(projectDeps({ repo, stateDir }, { watchFactory: fakeWatchFactory }));
    const port = await handle.listen(0);

    // Watchers now attach lazily, the first time a project resolves. Hit a
    // project-scoped route once so `ensureWatcher` wires the injected factory
    // (a later task moves this to eager per-registered-project attachment).
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    wsClients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    expect(capturedOnChange).not.toBeNull();

    const messagePromise = new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    capturedOnChange!(join(stateDir, "queue", "pending", "x.md"));

    const raw = await messagePromise;
    const msg = JSON.parse(raw) as { type: string; path: string };
    expect(msg.type).toBe("change");
    expect(msg.path).toContain("x.md");
  });

  it("change events carry the projectId of the project whose stateDir changed", async () => {
    const onChangeByDir = new Map<string, (path: string) => void>();
    const factory = (dir: string, onChange: (path: string) => void) => {
      onChangeByDir.set(dir, onChange);
      return { close: () => {} };
    };
    handle = createApiServer(projectDeps({ repo, stateDir }, { watchFactory: factory }));
    const port = await handle.listen(0);

    // A project's watcher is attached on first resolution -- touch the project once:
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(onChangeByDir.has(stateDir)).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    wsClients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const msg = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    onChangeByDir.get(stateDir)!("queue/pending/t1.md");
    const parsed = JSON.parse(await msg) as { type: string; projectId: string; path: string };
    expect(parsed).toEqual({ type: "change", projectId: "p1", path: "queue/pending/t1.md" });
    ws.close();
  });
});

describe("createApiServer / watcher re-attach on stateDir change", () => {
  it("closes the stale watcher and attaches a new one when a project id is re-registered to a new path", async () => {
    const dirA = join(root, "stateA");
    const dirB = join(root, "stateB");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    // A mutable stateDir simulates re-registering the SAME id "p1" to a new path.
    let currentStateDir = dirA;

    const onChangeByDir = new Map<string, (path: string) => void>();
    const closedDirs: string[] = [];
    const watchFactory = (sd: string, onChange: (path: string) => void) => {
      onChangeByDir.set(sd, onChange);
      return { close: () => void closedDirs.push(sd) };
    };

    const deps: ApiServerDeps = {
      projects: {
        list: async () => [{ id: "p1", name: "p1", path: currentStateDir, status: "ready" }],
        get: async (id) =>
          id === "p1"
            ? { view: { repo, stateDir: currentStateDir, readExecutionReportJson: storedReportReader(currentStateDir) } }
            : null,
      },
      watchFactory,
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);

    // First resolution -> watcher attached on dirA, nothing closed yet.
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(onChangeByDir.has(dirA)).toBe(true);
    expect(closedDirs).toEqual([]);

    // Re-register p1 to dirB, resolve again -> stale dirA watcher closed, new one on dirB.
    currentStateDir = dirB;
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(closedDirs).toEqual([dirA]);
    expect(onChangeByDir.has(dirB)).toBe(true);

    // A change fired via dirB's captured callback now broadcasts under projectId "p1".
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    wsClients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const msg = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    onChangeByDir.get(dirB)!("queue/pending/new.md");
    const parsed = JSON.parse(await msg) as { type: string; projectId: string; path: string };
    expect(parsed).toEqual({ type: "change", projectId: "p1", path: "queue/pending/new.md" });
    ws.close();
  });

  it("silences a retired watcher's callback -- the OLD stateDir's onChange must not broadcast after re-registration", async () => {
    const dirA = join(root, "stateA2");
    const dirB = join(root, "stateB2");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    let currentStateDir = dirA;

    const onChangeByDir = new Map<string, (path: string) => void>();
    const watchFactory = (sd: string, onChange: (path: string) => void) => {
      onChangeByDir.set(sd, onChange);
      // dirA's close handle never resolves -- simulates the fire-and-forget close
      // hanging (or forever pending), which is exactly the case the identity
      // guard must cover: the old callback must stay silent regardless. dirB's
      // close resolves normally so the test's own teardown (`handle.close()`,
      // which awaits every live watcher) does not hang.
      return { close: () => (sd === dirA ? new Promise<void>(() => {}) : Promise.resolve()) };
    };

    const deps: ApiServerDeps = {
      projects: {
        list: async () => [{ id: "p1", name: "p1", path: currentStateDir, status: "ready" }],
        get: async (id) =>
          id === "p1"
            ? { view: { repo, stateDir: currentStateDir, readExecutionReportJson: storedReportReader(currentStateDir) } }
            : null,
      },
      watchFactory,
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);

    // First resolution -> watcher attached on dirA, captures its onChange.
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    const oldOnChange = onChangeByDir.get(dirA)!;

    // Re-register p1 to dirB, resolve again -> dirA's watcher is retired (close
    // never settles), dirB's watcher attaches.
    currentStateDir = dirB;
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(onChangeByDir.has(dirB)).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    wsClients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const received: unknown[] = [];
    ws.on("message", (d) => received.push(JSON.parse(String(d))));

    // Fire the OLD dir's captured callback -- must NOT broadcast anything.
    oldOnChange("queue/pending/stale.md");

    // Fire the NEW dir's callback -- must broadcast normally, proving the
    // socket/plumbing is alive and the silence above wasn't incidental.
    const msg = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    onChangeByDir.get(dirB)!("queue/pending/new.md");
    const parsed = JSON.parse(await msg) as { type: string; projectId: string; path: string };
    expect(parsed).toEqual({ type: "change", projectId: "p1", path: "queue/pending/new.md" });

    // Exactly one message arrived in total -- the stale dirA event was dropped.
    expect(received).toEqual([{ type: "change", projectId: "p1", path: "queue/pending/new.md" }]);

    ws.close();
  });
});

describe("createApiServer / POST /escalations/:id/reply", () => {
  it("accepts choice A, records a structured reply file with the injected clock, and returns it", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { now: () => 424242 }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A", note: "operator context only" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; choice: string; note: string; at: number };
    expect(body).toEqual({ id: "esc-1", choice: "A", note: "operator context only", at: 424242 });

    const filePath = join(stateDir, "escalations", "esc-1.reply.json");
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf8")) as { choice: string };
    expect(written.choice).toBe("A");
  });

  it("defaults note to an empty string when omitted", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { now: () => 1 }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    const body = (await res.json()) as { note: string };
    expect(body.note).toBe("");
  });

  it("rejects a choice other than A/B/C with 400 and writes no reply file", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-3/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "Z" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "esc-3.reply.json"))).toBe(false);
  });

  it("rejects an id containing '..' with 400 and writes no file", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/foo..bar/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "foo..bar.reply.json"))).toBe(false);
  });

  it("rejects an id containing an (encoded) slash with 400 and writes no file outside escalations/", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    // %2F decodes to "/" -- must be rejected even though it matches the route
    // as a single raw path segment (path-traversal guard is post-decode).
    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/a%2Fb/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "a.reply.json"))).toBe(false);
    expect(existsSync(join(stateDir, "escalations", "a", "b.reply.json"))).toBe(false);
  });

  it("rejects an id with a colon (Windows ADS syntax) via the positive allowlist", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/a%3Ab/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "a:b.reply.json"))).toBe(false);
  });

  it("rejects an over-sized body with 413 and writes no reply file", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    // note is free text -- an unbounded body is a memory-DoS / close()-hang risk.
    const huge = "x".repeat(1_000_001 + 64);
    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-big/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A", note: huge }),
    });
    expect(res.status).toBe(413);
    expect(existsSync(join(stateDir, "escalations", "esc-big.reply.json"))).toBe(false);
  });

  it("choice A moves the escalated task to quarantine/ (NOT done) and leaves escalated/ (gotcha [escalate/replied-holds-filelock])", async () => {
    seedTask("escalated", "esc-a");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-a/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-a.md"))).toBe(false);
    // quarantine, not done -- A releases the lock without claiming repo-completion
    // (the escalated work was never committed; done would falsely satisfy depends_on).
    expect(existsSync(join(stateDir, "queue", "quarantine", "esc-a.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "done", "esc-a.md"))).toBe(false);
    expect(existsSync(join(stateDir, "escalations", "esc-a.reply.json"))).toBe(true);
  });

  it("choice B re-queues the escalated task to pending/", async () => {
    seedTask("escalated", "esc-b");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-b/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-b.md"))).toBe(false);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-b.md"))).toBe(true);
  });

  it("choice B triggers onReplyRework (drain) after re-queuing to pending/", async () => {
    seedTask("escalated", "esc-b2");
    const reworkArgs: string[] = [];
    handle = createApiServer(projectDeps({ repo, stateDir, onReplyRework: (taskId) => void reworkArgs.push(taskId) }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-b2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-b2.md"))).toBe(true);
    // the replied task id flows to the hook (drain + narrator re-arm keyed on it)
    expect(reworkArgs).toEqual(["esc-b2"]);
  });

  it("choice B resets the task's attempt budget so the rework re-claim is not immediately poisoned ([rework/reply-b-poisons-maxrounds-exhausted-task])", async () => {
    seedTask("escalated", "esc-b-attempts");
    // The task escalated after exhausting its attempt budget (circuit breaker
    // counter at/over cfg.loop.maxAttempts). Without a reset, the reply-B drain
    // re-claims it and the conductor's poison-pill re-escalates it to quarantine
    // in ~80ms with no worker run. An explicit reply-B (rework) is a deliberate
    // "give it another real try" signal -> the budget must be reset.
    await repo.setAttempts("esc-b-attempts", 3);
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-b-attempts/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-b-attempts.md"))).toBe(true);
    // Fresh budget: the next claim increments 0 -> 1, well under maxAttempts.
    expect(await repo.getAttempts("esc-b-attempts")).toBe(0);
  });

  it("choice A does NOT reset the attempt budget (accept is terminal, no re-run)", async () => {
    seedTask("escalated", "esc-a-attempts");
    await repo.setAttempts("esc-a-attempts", 3);
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-a-attempts/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);
    // The budget is untouched -- A quarantines, there is no re-run to budget for.
    expect(await repo.getAttempts("esc-a-attempts")).toBe(3);
  });

  it("choice A does NOT trigger onReplyRework (quarantine is terminal)", async () => {
    seedTask("escalated", "esc-a2");
    let reworkCalls = 0;
    handle = createApiServer(projectDeps({ repo, stateDir, onReplyRework: () => void reworkCalls++ }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-a2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);
    expect(reworkCalls).toBe(0);
  });

  it("choice B on a drift-style escalation (no queue task) does NOT trigger onReplyRework", async () => {
    let reworkCalls = 0;
    handle = createApiServer(projectDeps({ repo, stateDir, onReplyRework: () => void reworkCalls++ }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/drift-b/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    // The reply is recorded (200) but there was no escalated queue task to move,
    // so there is nothing to drain -- the hook must NOT fire.
    expect(res.status).toBe(200);
    expect(reworkCalls).toBe(0);
  });

  it("a synchronously-throwing onReplyRework does NOT break the 200 reply response", async () => {
    seedTask("escalated", "esc-throw");
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onReplyRework: () => {
          throw new Error("boom");
        },
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-throw/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-throw.md"))).toBe(true);
  });

  it("choice B with NO onReplyRework wired (read-only deployment) still re-queues and returns 200", async () => {
    seedTask("escalated", "esc-b3");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-b3/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-b3.md"))).toBe(true);
  });

  it("a throwing injected logger never breaks the reply-B 200 or the escalated->pending move ([ts/fail-closed])", async () => {
    // reply logs on the HAPPY path (the "recorded escalation reply" INFO fires
    // before any move), so a throwing `deps.log` that was routed raw would abort
    // handleReply before the 200 -- and the terminal error backstop would re-throw
    // logging that too, leaving the client hung with no response. The fail-closed
    // `log` wrapper must contain it so the request still completes normally.
    seedTask("escalated", "esc-badlog");
    const logged: string[] = [];
    const throwingLog = (level: string, msg: string): void => {
      logged.push(`${level}:${msg}`);
      throw new Error("logger down");
    };
    handle = createApiServer(projectDeps({ repo, stateDir }, { log: throwingLog }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-badlog/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-badlog.md"))).toBe(true);
    // Non-vacuous AND call-site-specific: the happy-path "recorded escalation reply"
    // INFO (which fires before any move) really was reached and threw, and the
    // wrapper swallowed it so the 200 still went out.
    expect(logged.some((l) => l.startsWith("INFO:") && l.includes("recorded escalation reply"))).toBe(true);
  });

  it("a throwing logger AND a hostile-error onReplyRework together still return 200 and re-queue ([ts/fail-closed] rule-of-thumb)", async () => {
    // The gotcha's rule of thumb: inject a throwing logger AND a throwing primary
    // dep together. Here onReplyRework throws an Error whose `message` getter also
    // throws, so BOTH the best-effort catch's `log(...)` and the `safeErrorText`
    // that builds its message must be fail-closed -- otherwise the throw escapes
    // the very catch meant to swallow it, before the 200 is sent.
    seedTask("escalated", "esc-badlog-hostile");
    const logged: string[] = [];
    const throwingLog = (level: string, msg: string): void => {
      logged.push(`${level}:${msg}`);
      throw new Error("logger down");
    };
    const hostileErr = new Error("placeholder");
    Object.defineProperty(hostileErr, "message", {
      get(): string {
        throw new Error("message getter boom");
      },
    });
    handle = createApiServer(
      projectDeps(
        {
          repo,
          stateDir,
          onReplyRework: () => {
            throw hostileErr;
          },
        },
        { log: throwingLog },
      ),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-badlog-hostile/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-badlog-hostile.md"))).toBe(true);
    // Both fail-closed guards were exercised at the specific onReplyRework catch:
    // safeErrorText turned the hostile error into the literal fallback while building
    // the WARN message, and the wrapper then swallowed the throwing logger.
    expect(
      logged.some((l) => l.startsWith("WARN:") && l.includes("onReplyRework threw") && l.includes("<unstringifiable error>")),
    ).toBe(true);
  });

  it("the terminal error backstop survives a throwing logger: a rejected handler still 500s the client instead of hanging ([ts/fail-closed])", async () => {
    // A handler rejection that reaches the top-level `handleRequest(...).catch`
    // backstop logs via the SAME fail-closed `log` wrapper before sending the 500.
    // A `deps.projects.get` that throws is not caught inside handleRequest, so it
    // propagates to that backstop; with a raw throwing logger the backstop's own
    // ERROR log would re-throw and the 500 would never be sent (client hangs).
    const logged: string[] = [];
    const throwingLog = (level: string, msg: string): void => {
      logged.push(`${level}:${msg}`);
      throw new Error("logger down");
    };
    handle = createApiServer(
      projectDeps(
        { repo, stateDir },
        {
          projects: {
            list: async () => [],
            get: async () => {
              throw new Error("resolve boom");
            },
          },
          log: throwingLog,
        },
      ),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    // Call-site-specific: the terminal backstop's own "unhandled error" ERROR log
    // was reached and threw, and the wrapper contained it so the 500 still went out.
    expect(logged.some((l) => l.startsWith("ERROR:") && l.includes("unhandled error"))).toBe(true);
  });

  it("a replied escalation no longer blocks a same-file_set pending task", async () => {
    seedTask("escalated", "esc-lock");
    seedTask("pending", "p-blocked");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const scheduler = createScheduler(repo);
    expect(await scheduler.claimNextTask()).toBeNull();

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-lock/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);

    const claimed = await scheduler.claimNextTask();
    expect(claimed?.id).toBe("p-blocked");
  });

  it("INTEGRATION (real repo+scheduler): critic-feedback.md persists across reply-B -> re-claim so a rework re-run can read it", async () => {
    // The escalation persisted the critic's objection into the per-task runtime
    // dir (conductor.ts, part a). Prove on the REAL FileBlackboardRepository --
    // not a fake -- that the runtime file survives the escalated -> pending ->
    // active (re-claim) queue transition, since runtimeDir is keyed by task id
    // independent of queue state. This is the gap a fake repo cannot exercise
    // ([rework/reply-b-drops-critic-feedback]).
    seedTask("escalated", "esc-rework");
    await repo.writeRuntimeFile("esc-rework", "critic-feedback.md", "Fix the load order: hook on plugins_loaded.");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-rework/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);

    // reply-B released it to pending/; the real scheduler re-claims it (-> active).
    const scheduler = createScheduler(repo);
    const claimed = await scheduler.claimNextTask();
    expect(claimed?.id).toBe("esc-rework");

    // The objection is still readable after the full transition -- the re-run's
    // round-0 read (conductor.ts, part b) would hand this to the worker prompt.
    const feedback = await repo.readRuntimeFile("esc-rework", "critic-feedback.md");
    expect(feedback).toBe("Fix the load order: hook on plugins_loaded.");
  });

  it("INTEGRATION (real repo+scheduler): reply-B on an attempt-exhausted escalation re-claims fresh, not poisoned ([rework/reply-b-poisons-maxrounds-exhausted-task])", async () => {
    // The round-exhausted escalation carries an attempt counter at the circuit-
    // breaker ceiling. Prove on the REAL repo+scheduler that reply-B releases it
    // to pending AND resets the budget, so the re-claim the conductor performs
    // increments 0 -> 1 (under cfg.loop.maxAttempts, default 3) and reaches the
    // worker -- instead of tripping the poison-pill to quarantine with no run.
    seedTask("escalated", "esc-exhausted");
    await repo.setAttempts("esc-exhausted", 3); // at/over the default maxAttempts
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-exhausted/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    expect(res.status).toBe(200);

    // Real scheduler re-claims the released task...
    const scheduler = createScheduler(repo);
    const claimed = await scheduler.claimNextTask();
    expect(claimed?.id).toBe("esc-exhausted");
    // ...with a fresh budget: the conductor's next `getAttempts + 1` = 1, which is
    // <= maxAttempts, so the circuit breaker does NOT poison it.
    expect(await repo.getAttempts("esc-exhausted")).toBe(0);
  });

  it("a reply to an escalation with no queue task (drift-style) still records the reply and returns 200", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/drift-123/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "escalations", "drift-123.reply.json"))).toBe(true);
  });

  it("choice A does NOT falsely satisfy a dependent's depends_on (quarantine is not in doneIds)", async () => {
    // The escalated task's work was never committed, so accepting it must not let a
    // dependent run as though the prerequisite were in the repo. A -> quarantine keeps
    // the dependent blocked (correct); only a real committed `done` would release it.
    seedTask("escalated", "esc-dep", { fileSet: ["src/a.ts"] });
    seedTask("pending", "p-dependent", { fileSet: ["src/b.ts"], dependsOn: ["esc-dep"] });
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const scheduler = createScheduler(repo);
    expect(await scheduler.claimNextTask()).toBeNull(); // blocked: esc-dep not done

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-dep/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "quarantine", "esc-dep.md"))).toBe(true);

    // Still blocked: esc-dep is quarantined, not done, so p-dependent must not claim.
    expect(await scheduler.claimNextTask()).toBeNull();
  });

  // --- choice C: commit-on-accept (operator gate-override) ------------------

  it("choice C on success commits, moves escalated/ -> done/ (NOT quarantine), records the reply with the hash", async () => {
    seedTask("escalated", "esc-c");
    const calls: string[] = [];
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onApplyOnAccept: async (taskId) => {
          calls.push(taskId);
          return { ok: true, hash: "abc1234" };
        },
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-c/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choice: "C", commit: "abc1234" });
    expect(calls).toEqual(["esc-c"]);
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-c.md"))).toBe(false);
    expect(existsSync(join(stateDir, "queue", "done", "esc-c.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "quarantine", "esc-c.md"))).toBe(false);
    const replyJson = JSON.parse(readFileSync(join(stateDir, "escalations", "esc-c.reply.json"), "utf8"));
    expect(replyJson.commit).toBe("abc1234");
  });

  it("choice C on refusal returns 409, LEAVES the task escalated, and writes NO reply file", async () => {
    seedTask("escalated", "esc-cfail");
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onApplyOnAccept: async () => ({ ok: false, reason: "git apply failed (branch moved)" }),
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-cfail/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/git apply failed/);
    // Task stays escalated (nothing committed, lock still held); no resolving reply.
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-cfail.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "done", "esc-cfail.md"))).toBe(false);
    expect(existsSync(join(stateDir, "escalations", "esc-cfail.reply.json"))).toBe(false);
  });

  it("choice C returns 404 when apply-on-accept is not wired for the project", async () => {
    seedTask("escalated", "esc-cno");
    handle = createApiServer(projectDeps({ repo, stateDir })); // no onApplyOnAccept
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-cno/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
    });
    expect(res.status).toBe(404);
    // Untouched: still escalated, no reply.
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-cno.md"))).toBe(true);
    expect(existsSync(join(stateDir, "escalations", "esc-cno.reply.json"))).toBe(false);
  });

  it("choice C -> done DOES satisfy a dependent's depends_on (unlike A->quarantine): the committed work is now in the repo", async () => {
    seedTask("escalated", "esc-dep2", { fileSet: ["src/a.ts"] });
    seedTask("pending", "p-dependent2", { fileSet: ["src/b.ts"], dependsOn: ["esc-dep2"] });
    handle = createApiServer(
      projectDeps({ repo, stateDir, onApplyOnAccept: async () => ({ ok: true, hash: "deadbee" }) }),
    );
    const port = await handle.listen(0);

    const scheduler = createScheduler(repo);
    expect(await scheduler.claimNextTask()).toBeNull(); // blocked before the accept

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-dep2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(stateDir, "queue", "done", "esc-dep2.md"))).toBe(true);

    // Now claimable: esc-dep2 is in done (committed), so depends_on is truthfully met.
    expect((await scheduler.claimNextTask())?.id).toBe("p-dependent2");
  });
});

/** A representative `EscalationInput`, overridable per test. */
function makeEscalationInput(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    id: "esc-1",
    reason: "worker disagreed with critic twice",
    type: "disagreement",
    taskId: "T-42",
    title: "Rename public API",
    what: "Worker renamed a public export; critic rejected twice.",
    decision: "Keep old name or accept the rename?",
    optionA: "Keep old name",
    optionB: "Accept rename",
    costOfWrong: "Downstream consumers break silently",
    evidence: "diff --git a/x b/x\n+export function newName() {}",
    ...overrides,
  };
}

/** Writes a REAL `<stateDir>/escalations/<id>.md` via the real `buildBody` (through
 *  `escalate()`, whose `writeFile` is injected to hit real disk) -- exactly the
 *  artifact the conductor would have written, not a hand-rolled fixture. */
async function seedEscalation(input: EscalationInput): Promise<void> {
  const escalationsDir = join(stateDir, "escalations");
  mkdirSync(escalationsDir, { recursive: true });
  await escalate(input, {
    escalationsDir,
    writeFile: async (path: string, content: string) => {
      await writeFileAsync(path, content, "utf8");
    },
    appendFile: async () => {},
    env: () => undefined,
  });
}

describe("createApiServer / GET /escalations/:id", () => {
  it("200s with every parsed field and reply: null when no reply file exists", async () => {
    const input = makeEscalationInput();
    await seedEscalation(input);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: input.id,
      reason: input.reason,
      type: input.type,
      taskId: input.taskId,
      title: input.title,
      what: input.what,
      decision: input.decision,
      optionA: input.optionA,
      optionB: input.optionB,
      costOfWrong: input.costOfWrong,
      evidence: input.evidence,
      reply: null,
    });
  });

  it("includes the reply object when a reply file exists", async () => {
    await seedEscalation(makeEscalationInput());
    writeFileSync(
      join(stateDir, "escalations", "esc-1.reply.json"),
      JSON.stringify({ id: "esc-1", choice: "A", note: "operator context", at: 999 }),
    );

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: unknown };
    expect(body.reply).toEqual({ choice: "A", note: "operator context", at: 999 });
  });

  it("degrades to reply: null (never fails the endpoint) when the reply file is malformed JSON", async () => {
    await seedEscalation(makeEscalationInput());
    writeFileSync(join(stateDir, "escalations", "esc-1.reply.json"), "{ not valid json ");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: unknown };
    expect(body.reply).toBeNull();
  });

  it("degrades to reply: null when the reply file has an invalid choice", async () => {
    await seedEscalation(makeEscalationInput());
    writeFileSync(
      join(stateDir, "escalations", "esc-1.reply.json"),
      JSON.stringify({ id: "esc-1", choice: "Z", note: "", at: 1 }),
    );

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: unknown };
    expect(body.reply).toBeNull();
  });

  it("404s for a missing escalation id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("404s when the escalation markdown is unparseable", async () => {
    const escalationsDir = join(stateDir, "escalations");
    mkdirSync(escalationsDir, { recursive: true });
    writeFileSync(join(escalationsDir, "esc-bad.md"), "not an escalation artifact at all");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-bad`);
    expect(res.status).toBe(404);
  });

  it("404s for an oversized escalation file (bounded before parse)", async () => {
    const escalationsDir = join(stateDir, "escalations");
    mkdirSync(escalationsDir, { recursive: true });
    // Larger than MAX_ESCALATION_READ_BYTES (256 KiB) -- even though it happens to
    // start with a valid-looking header, it must never be parsed.
    writeFileSync(join(escalationsDir, "esc-huge.md"), `# ESCALATION esc-huge -- ${"x".repeat(300 * 1024)}`);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-huge`);
    expect(res.status).toBe(404);
  });

  it("400s for an id containing '..'", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/foo..bar`);
    expect(res.status).toBe(400);
  });

  it("400s for an id with an (encoded) slash (path-traversal guard is post-decode)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/a%2Fb`);
    expect(res.status).toBe(400);
  });

  it("400s for an id with a colon (Windows ADS syntax) via the positive allowlist", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/a%3Ab`);
    expect(res.status).toBe(400);
  });

  it("a traversal id can never read a file outside escalations/ (sentinel one dir up is unreachable)", async () => {
    await seedEscalation(makeEscalationInput());
    // Sentinel sits directly under stateDir, one directory above escalations/.
    writeFileSync(join(stateDir, "sentinel.md"), "# ESCALATION sentinel -- leak-me-not\nsecret");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/..%2Fsentinel`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not");
  });

  it("404s (does not follow) a symlink at the escalation markdown path pointing outside escalations/", async () => {
    const escalationsDir = join(stateDir, "escalations");
    mkdirSync(escalationsDir, { recursive: true });
    const secret = join(root, "outside-secret.md");
    writeFileSync(secret, "# ESCALATION secret -- leak-me-not-via-symlink\n\n**Task:** T -- t\n**Type:** drift\n**What happened:** x\n**Decision you need to make:** x\n**Option A:** x\n**Option B:** x\n**Cost of being wrong:** x\n\n**Evidence:**\n```\nx\n```\n");
    try {
      symlinkSync(secret, join(escalationsDir, "esc-link.md"), "file");
    } catch {
      return; // environment can't create symlinks -- the lstat/isFile guard still holds
    }

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-link`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("leak-me-not-via-symlink");
  });

  it("POST /escalations/:id/reply still works alongside the new GET route (no shadowing regression)", async () => {
    await seedEscalation(makeEscalationInput());

    handle = createApiServer(projectDeps({ repo, stateDir }, { now: () => 555 }));
    const port = await handle.listen(0);

    const postRes = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B", note: "picking B" }),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { choice: string };
    expect(postBody.choice).toBe("B");

    const getRes = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { reply: { choice: string } | null };
    expect(getBody.reply?.choice).toBe("B");
  });

  it("404s when the parsed escalation's internal id does not match the requested :id (stale/hand-edited file)", async () => {
    const escalationsDir = join(stateDir, "escalations");
    // Seed a well-formed artifact under a DIFFERENT id, then place its content
    // (internal `# ESCALATION other-id -- ...` header) at the esc-1.md path -- the
    // filename says esc-1 but the parsed body still says other-id.
    await seedEscalation(makeEscalationInput({ id: "other-id" }));
    const content = readFileSync(join(escalationsDir, "other-id.md"), "utf8");
    writeFileSync(join(escalationsDir, "esc-1.md"), content);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(404);
  });

  it("degrades to reply: null (still 200 with the escalation) when the reply file's id does not match the requested :id", async () => {
    await seedEscalation(makeEscalationInput());
    writeFileSync(
      join(stateDir, "escalations", "esc-1.reply.json"),
      JSON.stringify({ id: "other-id", choice: "A", note: "wrong file", at: 1 }),
    );

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: unknown };
    expect(body.reply).toBeNull();
  });
});

describe("createApiServer / GET /state digest tail is bounded", () => {
  it("returns the true last line even when digest.md far exceeds the read window", async () => {
    mkdirSync(stateDir, { recursive: true });
    // Write a digest larger than MAX_DIGEST_READ_BYTES (64KB) so the positioned
    // tail read is exercised; the final line must still be surfaced intact.
    const filler = Array.from({ length: 5000 }, (_v, i) => `[ts] filler line ${i}`).join("\n");
    writeFileSync(join(stateDir, "digest.md"), `${filler}\n[ts] THE ACTUAL LAST LINE\n`);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    const body = (await res.json()) as { digestTail: string };
    expect(body.digestTail).toContain("THE ACTUAL LAST LINE");
    // The tail is capped at DIGEST_TAIL_LINES (50), not the whole 5000-line file.
    expect(body.digestTail.split("\n").length).toBeLessThanOrEqual(50);
    expect(body.digestTail).not.toContain("filler line 0");
  });

  it("does not drop the first line when the 64KB window starts exactly on a line boundary", async () => {
    mkdirSync(stateDir, { recursive: true });
    // Each line is exactly 2048 bytes (2047 visible + "\n"). 65536 % 2048 === 0,
    // so the last-64KB window begins precisely on a line boundary AND holds only
    // 32 lines (fewer than the 50-line tail cap) -- so a spuriously-dropped first
    // line is visible in the result count. The over-read fix must keep it.
    const lineCount = 40; // 40*2048 = 81920 bytes; window (last 64KB) = lines 8..39 = 32 lines
    const lines = Array.from({ length: lineCount }, (_v, i) => `[ts] digest line ${i}`.padEnd(2047));
    writeFileSync(join(stateDir, "digest.md"), `${lines.join("\n")}\n`);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    const body = (await res.json()) as { digestTail: string };
    const tail = body.digestTail.split("\n");
    // 32 whole lines in the window; the boundary line (8) must be kept -> 32, not 31.
    expect(tail.length).toBe(32);
    expect(tail[0]).toContain("digest line 8");
    expect(tail[tail.length - 1]).toContain(`digest line ${lineCount - 1}`);
  });
});

/** Seed a run manifest at `<stateDir>/runs/<runId>.json`, mirroring the shape
 * written by `createRecordRunCapability` (`src/orchestrator/capabilities.ts`). */
function seedRun(runId: string, at: number, intent = "an intent", taskIds: string[] = []): void {
  const dir = join(stateDir, "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, intent, taskIds, at }, null, 2));
}

describe("createApiServer / GET /runs", () => {
  it("returns [] when runs/ does not exist", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns manifests sorted newest-first by at", async () => {
    seedRun("run-1", 100);
    seedRun("run-2", 300);
    seedRun("run-3", 200);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; at: number }[];
    expect(body.map((r) => r.runId)).toEqual(["run-2", "run-3", "run-1"]);
  });

  it("skips a malformed manifest file (never 500s), still returns the valid ones", async () => {
    seedRun("run-good-1", 100);
    seedRun("run-good-2", 200);
    const runsDir = join(stateDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "run-bad.json"), "{ not valid json ");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string }[];
    expect(body.map((r) => r.runId).sort()).toEqual(["run-good-1", "run-good-2"]);
  });

  it("skips an oversized manifest (bounded before parse) and a poisoned-runId manifest, keeps the valid one", async () => {
    seedRun("run-good", 100);
    const runsDir = join(stateDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // Oversized (> MAX_RUN_MANIFEST_BYTES = 256 KiB) but otherwise valid JSON.
    writeFileSync(
      join(runsDir, "run-huge.json"),
      JSON.stringify({ runId: "run-huge", intent: "x".repeat(300 * 1024), taskIds: [], at: 1 }),
    );
    // Valid JSON but a path-unsafe runId -- isRunManifest must reject it so the UI
    // never gets an unopenable id.
    writeFileSync(join(runsDir, "run-poison.json"), JSON.stringify({ runId: "../evil", intent: "i", taskIds: [], at: 1 }));

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string }[];
    expect(body.map((r) => r.runId)).toEqual(["run-good"]);
  });

  it("lists a run whose id contains a dot (intent-derived slug like 'overview.md') -- regression for 'No runs yet'", async () => {
    // slugifyIntent deliberately keeps '.', so an intent that mentions a filename
    // produces a run id like `run-<ts>-...-overview.md-...`. The read-side validator
    // must accept it (matching the write side); the stricter dot-free check silently
    // dropped EVERY filename-derived run from the list, so the UI showed "No runs yet".
    seedRun("run-123-create-docs-overview.md-file", 500, "Create docs/OVERVIEW.md", ["docs-overview-md"]);
    seedRun("run-plain", 400);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string }[];
    expect(body.map((r) => r.runId)).toEqual(["run-123-create-docs-overview.md-file", "run-plain"]);
  });

  it("returns [] (never 500s) when runs/ exists but is a plain file, not a directory", async () => {
    // runs/ occupied by a file -> readdir throws ENOTDIR; best-effort must degrade to [].
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "runs"), "not a directory");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("createApiServer / GET /runs/:id", () => {
  it("returns the manifest for a known run id", async () => {
    seedRun("run-abc", 42, "build the thing", ["t1", "t2"]);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-abc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; intent: string; taskIds: string[]; at: number };
    expect(body).toEqual({ runId: "run-abc", intent: "build the thing", taskIds: ["t1", "t2"], at: 42 });
  });

  it("opens a run whose id contains a dot (intent-derived slug) -- regression", async () => {
    seedRun("run-9-docs-overview.md-x", 7, "Create docs/OVERVIEW.md", ["docs-overview-md"]);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-9-docs-overview.md-x`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runId: string }).runId).toBe("run-9-docs-overview.md-x");
  });

  it("404s for a missing run id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("400s for an id containing '..'", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/foo..bar`);
    expect(res.status).toBe(400);
  });

  it("400s for an id with an encoded slash (path-traversal guard is post-decode)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/a%2Fb`);
    expect(res.status).toBe(400);
  });

  it("a traversal id can never read a file outside runs/ (sentinel one dir up is unreachable)", async () => {
    seedRun("run-x", 1);
    // Sentinel sits directly under stateDir, one directory above runs/.
    writeFileSync(join(stateDir, "sentinel.json"), JSON.stringify({ secret: "leak-me-not" }));

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/..%2Fsentinel`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not");
  });
});

/** Write a valid `token-usage.json` under a task's runtimeDir, mirroring the shape
 * persisted by the conductor's `buildTokenUsageDoc` (s22). */
function seedUsage(
  taskId: string,
  o: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; critic_tokens?: number } = {},
): void {
  const dir = repo.runtimeDir(taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "token-usage.json"),
    JSON.stringify({
      worker: {
        input_tokens: o.input_tokens ?? 10,
        output_tokens: o.output_tokens ?? 20,
        cache_read_input_tokens: o.cache_read_input_tokens ?? 30,
        cache_creation_input_tokens: o.cache_creation_input_tokens ?? 40,
        runs: [],
      },
      critic: { tokens: o.critic_tokens ?? 5, runs: [] },
      updated_at: 1,
    }),
  );
}

describe("createApiServer / GET /runs/:id/usage", () => {
  it("sums two tasks' token-usage.json into one summary", async () => {
    seedRun("run-u1", 1, "i", ["t1", "t2"]);
    seedUsage("t1", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, critic_tokens: 5 });
    seedUsage("t2", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, critic_tokens: 5 });

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u1/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: number; any: boolean; taskCount: number; tasksWithUsage: number };
    expect(body.tokens).toBe(10 + 20 + 30 + 40 + 5 + (1 + 2 + 3 + 4 + 5));
    expect(body).not.toHaveProperty("cost");
    expect(body).toMatchObject({ any: true, taskCount: 2, tasksWithUsage: 2 });
  });

  it("reads honestly when only one of two tasks has a usage file", async () => {
    seedRun("run-u2", 1, "i", ["t1", "t2"]);
    seedUsage("t1");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u2/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { any: boolean; taskCount: number; tasksWithUsage: number; tokens: number };
    expect(body).toMatchObject({ any: true, taskCount: 2, tasksWithUsage: 1 });
    expect(body.tokens).toBe(10 + 20 + 30 + 40 + 5);
  });

  it("returns an all-zero, any:false summary when no task has a usage file", async () => {
    seedRun("run-u3", 1, "i", ["t1", "t2", "t3"]);

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u3/usage`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: 0, any: false, taskCount: 3, tasksWithUsage: 0 });
  });

  it("404s for a missing/unknown run id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/does-not-exist/usage`);
    expect(res.status).toBe(404);
  });

  it("skips a task whose token-usage.json is malformed JSON (not counted, no 500)", async () => {
    seedRun("run-u4", 1, "i", ["t1", "t2"]);
    seedUsage("t1");
    const dir2 = repo.runtimeDir("t2");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "token-usage.json"), "{ not valid json ");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u4/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { any: boolean; taskCount: number; tasksWithUsage: number };
    expect(body).toMatchObject({ any: true, taskCount: 2, tasksWithUsage: 1 });
  });

  it("dedupes duplicate task ids in the manifest — one task's usage is not double-counted", async () => {
    seedRun("run-u5", 1, "i", ["t1", "t1"]);
    seedUsage("t1", { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, critic_tokens: 0 });

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u5/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: number; taskCount: number; tasksWithUsage: number };
    expect(body.tokens).toBe(100); // counted ONCE, not 200
    expect(body).toMatchObject({ taskCount: 1, tasksWithUsage: 1 });
  });

  it("drops a path-unsafe manifest task id (no traversal, no 500) and counts the rest", async () => {
    seedRun("run-u6", 1, "i", ["../evil", "t1"]);
    seedUsage("t1", { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, critic_tokens: 0 });

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u6/usage`);
    expect(res.status).toBe(200); // the unsafe id is filtered before any path is built
    const body = (await res.json()) as { tokens: number; taskCount: number; tasksWithUsage: number };
    expect(body.tokens).toBe(7);
    expect(body).toMatchObject({ taskCount: 1, tasksWithUsage: 1 }); // only the safe unique id
  });

  it("still parses a pre-existing token-usage.json that carries a leftover total_cost_usd, and never surfaces cost", async () => {
    // Backward-compat: files written before the cost strip still have this field
    // on disk. `isTokenUsageDoc` must ignore it, not reject the doc.
    seedRun("run-u7", 1, "i", ["t1"]);
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "token-usage.json"),
      JSON.stringify({
        worker: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, total_cost_usd: 0.05, runs: [] },
        critic: { tokens: 5, runs: [] },
        total_cost_usd: 0.05,
        updated_at: 1,
      }),
    );

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-u7/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: number; taskCount: number; tasksWithUsage: number };
    expect(body.tokens).toBe(10 + 20 + 30 + 40 + 5);
    expect(body).not.toHaveProperty("cost");
    expect(body).toMatchObject({ taskCount: 1, tasksWithUsage: 1 });
  });
});

describe("createApiServer / GET /projects/:id/agent-extensions", () => {
  const fixture: AgentExtensions = {
    model: "claude-haiku-4",
    cwd: "/repo/root",
    mcp: [{ name: "serena", status: "connected" }],
    skills: ["deep-research"],
    slashCommands: ["review"],
    agents: ["Explore"],
  };

  it("returns 200 { extensions: <fixture> } when the view exposes onScanExtensions", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir, onScanExtensions: async () => fixture }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/agent-extensions")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extensions: fixture });
  });

  it("returns 200 { extensions: null } when the best-effort scan captured no init", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir, onScanExtensions: async () => null }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/agent-extensions")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extensions: null });
  });

  it("404s when the view does not expose onScanExtensions (read-only deployment)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/agent-extensions")}`);
    expect(res.status).toBe(404);
  });
});

describe("applyRunPatch (pure merge)", () => {
  const base = { runId: "run-1", intent: "do a thing", taskIds: ["t1"], at: 10 };

  it("renames via a trimmed name and clears it on empty string", () => {
    expect(applyRunPatch(base, { name: "  My Run  " }, 99)).toEqual({ ...base, name: "My Run" });
    // Clearing: an existing name removed by an empty string -> key omitted, back to intent.
    expect(applyRunPatch({ ...base, name: "old" }, { name: "   " }, 99)).toEqual(base);
    expect("name" in applyRunPatch({ ...base, name: "old" }, { name: "" }, 99)).toBe(false);
  });

  it("archives with the injected now and unarchives by clearing archived_at", () => {
    expect(applyRunPatch(base, { archived: true }, 777)).toEqual({ ...base, archived_at: 777 });
    expect(applyRunPatch({ ...base, archived_at: 5 }, { archived: false }, 777)).toEqual(base);
    expect("archived_at" in applyRunPatch({ ...base, archived_at: 5 }, { archived: false }, 777)).toBe(false);
  });

  it("applies name and archived together and never mutates the input", () => {
    const input = { ...base };
    const out = applyRunPatch(input, { name: "N", archived: true }, 42);
    expect(out).toEqual({ ...base, name: "N", archived_at: 42 });
    expect(input).toEqual(base); // untouched
  });
});

describe("createApiServer / PATCH /runs/:id", () => {
  it("renames a run (name shown; runId/intent immutable) and reflects it on GET", async () => {
    seedRun("run-r", 10, "original intent", ["t1"]);
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-r`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nice label" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; intent: string; name?: string };
    expect(body).toMatchObject({ runId: "run-r", intent: "original intent", name: "Nice label" });

    const get = await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-r`)).json();
    expect(get).toMatchObject({ name: "Nice label", intent: "original intent" });
  });

  it("archives a run: hidden from the default list, still openable, re-includable, then unarchivable", async () => {
    seedRun("run-a", 20);
    seedRun("run-b", 10);
    handle = createApiServer(projectDeps({ repo, stateDir }, { now: () => 555 }));
    const port = await handle.listen(0);

    // Archive run-a.
    const patch = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-a`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { archived_at?: number }).archived_at).toBe(555);

    // Default list hides it.
    const listed = (await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}`)).json()) as { runId: string }[];
    expect(listed.map((r) => r.runId)).toEqual(["run-b"]);

    // ?includeArchived=1 shows both (newest-first).
    const all = (await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}?includeArchived=1`)).json()) as { runId: string }[];
    expect(all.map((r) => r.runId)).toEqual(["run-a", "run-b"]);

    // Still directly openable by id.
    expect((await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-a`)).status).toBe(200);

    // Unarchive -> back in the default list.
    await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-a`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    const relisted = (await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}`)).json()) as { runId: string }[];
    expect(relisted.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("404s a missing run; 400s an empty patch / bad types / an over-long name / a '..' id", async () => {
    seedRun("run-x", 1);
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const patch = (id: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${p1("/runs")}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await patch("nope", { name: "x" })).status).toBe(404);
    expect((await patch("run-x", {})).status).toBe(400); // nothing to update
    expect((await patch("run-x", { name: 123 })).status).toBe(400);
    expect((await patch("run-x", { archived: "yes" })).status).toBe(400);
    expect((await patch("run-x", { name: "x".repeat(201) })).status).toBe(400);
    expect((await patch("foo..bar", { name: "x" })).status).toBe(400);
    // The valid run was never mutated by any of the rejected requests.
    const runX = (await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-x`)).json()) as { name?: string };
    expect(runX.name).toBeUndefined();
  });

  it("rejects a >200 whitespace-only name with 400 and does NOT clear an existing name (regression)", async () => {
    // Seed a run that ALREADY has a name, then send a 201-space name. The raw-length
    // check must 400 BEFORE trim, so the existing name is left untouched (an earlier
    // trim-then-length bug would have cleared it and returned 200).
    const runsDir = join(stateDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "run-named.json"), JSON.stringify({ runId: "run-named", intent: "i", taskIds: [], at: 1, name: "keep me" }));
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-named`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " ".repeat(201) }),
    });
    expect(res.status).toBe(400);
    const after = (await (await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-named`)).json()) as { name?: string };
    expect(after.name).toBe("keep me"); // untouched
  });

  it("404s (does not follow) a symlinked manifest file on write", async () => {
    const runsDir = join(stateDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const secret = join(root, "outside-run.json");
    writeFileSync(secret, JSON.stringify({ runId: "run-link", intent: "leak", taskIds: [], at: 1 }));
    try {
      symlinkSync(secret, join(runsDir, "run-link.json"), "file");
    } catch {
      return; // environment can't create symlinks -- the lstat/isFile guard still holds
    }
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs")}/run-link`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hijack" }),
    });
    expect(res.status).toBe(404);
    // The outside target was never written through the link.
    expect(readFileSync(secret, "utf8")).not.toContain("hijack");
  });
});

describe("createApiServer / GET /tasks/:id/runtime", () => {
  it("lists runtime file names for a task", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-report.md"), "# report");
    writeFileSync(join(dir, "gate-verdict.json"), JSON.stringify({ verdict: "pass" }));

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as string[];
    expect(body.sort()).toEqual(["gate-verdict.json", "worker-report.md"]);
  });

  it("returns [] when the task's runtime dir does not exist", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/no-such-task/runtime`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("400s for a bad task id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/a%2Fb/runtime`);
    expect(res.status).toBe(400);
  });
});

describe("createApiServer / GET /tasks/:id/runtime/:name", () => {
  it("returns text content with text/plain content-type for a non-json file", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-report.md"), "# hello world");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/worker-report.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("# hello world");
  });

  it("returns application/json content-type for a .json file", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gate-verdict.json"), JSON.stringify({ verdict: "pass" }));

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/gate-verdict.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { verdict: string };
    expect(body.verdict).toBe("pass");
  });

  it("404s when the runtime file does not exist", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/missing.md`);
    expect(res.status).toBe(404);
  });

  it("400s for a bad task id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/a%2Fb/runtime/report.md`);
    expect(res.status).toBe(400);
  });

  it("400s for a name containing '..' (even embedded, e.g. worker..report)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/worker..report`);
    expect(res.status).toBe(400);
  });

  it("400s for a name with an encoded slash (path-traversal guard is post-decode)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/a%2Fb`);
    expect(res.status).toBe(400);
  });

  it("a traversal name can never read a file outside the task's runtimeDir (sentinel one dir up is unreachable)", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    // Sentinel sits in the shared "runtime" parent dir, one directory above t1's own runtimeDir.
    const runtimeParent = join(dir, "..");
    writeFileSync(join(runtimeParent, "sentinel-runtime.txt"), "leak-me-not-either");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/..%2Fsentinel-runtime.txt`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not-either");
  });

  it("bounds an oversized file to exactly the cap + marker, and a truncated .json is served as text (never application/json)", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    const CAP = 1_000_000; // MAX_RUNTIME_FILE_READ_BYTES
    const MARKER = "\n...[truncated]"; // TRUNCATION_MARKER
    // A .json file so we also prove the truncated body is NOT labelled application/json
    // (prefix + marker is no longer valid JSON).
    writeFileSync(join(dir, "huge.json"), "a".repeat(CAP + 50_000));

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/huge.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-truncated")).toBe("true");
    const text = await res.text();
    // Exactly the bounded prefix (all 'a') plus the marker -- no trailing NUL padding.
    expect(text).toBe("a".repeat(CAP) + MARKER);
  });

  it("404s (does not follow) when the name resolves to a directory, not a regular file", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(join(dir, "subdir"), { recursive: true });

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/subdir`);
    expect(res.status).toBe(404);
  });

  it("404s (does not follow) a symlink inside runtimeDir pointing outside it (no escape)", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    const secret = join(root, "outside-secret.txt");
    writeFileSync(secret, "leak-me-not-via-symlink");
    // Symlink creation may require privilege on Windows; skip gracefully if unsupported.
    try {
      symlinkSync(secret, join(dir, "link.md"), "file");
    } catch {
      return; // environment can't create symlinks -- the lstat/isFile guard still holds
    }

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/tasks")}/t1/runtime/link.md`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("leak-me-not-via-symlink");
  });
});

/** Seeds a minimal fixture UI bundle under `<root>/ui-dist`. Returns its absolute path. */
function seedUiDir(): string {
  const uiDir = join(root, "ui-dist");
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><body>index</body></html>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('app');");
  writeFileSync(join(uiDir, "assets", "style.css"), "body{color:red}");
  return uiDir;
}

describe("createApiServer / static UI serving (uiDir set)", () => {
  it("GET / returns index.html with text/html content-type", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("index");
  });

  it("GET /index.html also returns index.html", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("index");
  });

  it("GET /assets/app.js returns its bytes with a javascript content-type", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("console.log('app');");
  });

  it("GET /assets/style.css returns text/css", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("SPA fallback: an extension-less unknown route serves index.html", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("index");
  });

  it("a missing asset under /assets/ 404s (never SPA-fallbacks -- a stale bundle must not be masked as HTML)", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("index");
  });

  it("SPA fallback: a client route whose id segment contains a DOT still serves index.html on reload ([ui/dotted-id-breaks-spa-reload])", async () => {
    // Run/task/thread ids are slugified from filenames/intents and keep dots
    // (`run-...-OVERVIEW.md-...`). A reload / direct-nav of such a route hits the
    // static server; the old "any segment has an extension -> asset -> 404"
    // heuristic wrongly 404'd it. It is NOT under /assets/, so it must fall back.
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/p/demo/runs/run-add-a-docs-FAQ.md-with-an-answer`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("index");
  });

  it("API routes still win over static/SPA when uiDir is set", async () => {
    seedTask("pending", "p1");
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const stateRes = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(stateRes.status).toBe(200);
    const stateBody = (await stateRes.json()) as { queues: Record<string, { id: string }[]> };
    expect(stateBody.queues.pending?.map((t) => t.id)).toEqual(["p1"]);

    const runsRes = await fetch(`http://127.0.0.1:${port}${p1("/runs")}`);
    expect(runsRes.status).toBe(200);
    expect(await runsRes.json()).toEqual([]);
  });

  it("a directory under uiDir requested as an asset path 404s (not served)", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/assets`);
    expect(res.status).toBe(404);
  });

  it("404s (does not follow) a symlink under uiDir pointing outside it", async () => {
    const uiDir = seedUiDir();
    const secret = join(root, "outside-ui-secret.txt");
    writeFileSync(secret, "leak-me-not-via-ui-symlink");
    try {
      symlinkSync(secret, join(uiDir, "link.js"), "file");
    } catch {
      handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
      await handle.listen(0);
      return; // environment can't create symlinks -- the lstat/isFile guard still holds
    }

    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/link.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("leak-me-not-via-ui-symlink");
  });

  it("a traversal request can never read a file outside uiDir (sentinel one dir up is unreachable)", async () => {
    const uiDir = seedUiDir();
    // Sentinel sits directly under root, one directory above uiDir.
    writeFileSync(join(root, "secret.txt"), "leak-me-not-via-traversal");

    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fsecret.txt`);
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not-via-traversal");
  });

  it("a double-encoded traversal request never reads a file outside uiDir", async () => {
    const uiDir = seedUiDir();
    writeFileSync(join(root, "secret2.txt"), "leak-me-not-via-encoded-dots");

    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    // The WHATWG URL parser normalizes the `%2e%2e` dot-segment away before the
    // request is even sent, so the server sees `/secret2.txt` -- a path CONTAINED
    // inside uiDir (resolveStaticPath resolves it to `<uiDir>/secret2.txt`, which
    // does not exist). Since it is not under /assets/, the SPA fallback now serves
    // index.html (200) rather than 404 -- the security-relevant guarantee is that
    // the real secret one dir ABOVE uiDir is never read, which containment upholds
    // regardless of the status code. (Literal-`..` and %2f-slash traversals are still
    // rejected outright by resolveStaticPath -- see the sibling traversal tests.)
    const res = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret2.txt`);
    expect([200, 400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not-via-encoded-dots");
  });

  it("an encoded-path missing asset under /assets/ (/assets/missing%2ejs) 404s, never SPA-fallbacks to index", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    // Decodes to `/assets/missing.js` -- a missing bundle under the asset dir. The
    // asset check runs on the DECODED resolved path, so the encoded dot cannot
    // sneak it out of the /assets/ 404 guarantee into an index.html route 200.
    const res = await fetch(`http://127.0.0.1:${port}/assets/missing%2ejs`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("index");
  });

  it("a path UNDER an existing file (/assets/app.js/foo -> ENOTDIR) 404s, never SPA-fallbacks", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    // `assets/app.js` is a file, so lstat of `.../app.js/foo` fails with ENOTDIR
    // (not ENOENT). `foo` has no extension, so a naive "missing -> SPA" would wrongly
    // serve index.html; ENOTDIR must be "blocked", never fallback.
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js/foo`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("index");
  });

  it("an INTERMEDIATE symlink directory under uiDir cannot escape (realpath containment)", async () => {
    const uiDir = seedUiDir();
    const outsideDir = join(root, "outside-ui-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.js"), "leak-me-not-via-symlink-dir");
    try {
      // A symlinked DIRECTORY inside uiDir -- lstat+O_NOFOLLOW only guard the FINAL
      // component, so only realpath containment catches this class.
      symlinkSync(outsideDir, join(uiDir, "extern"), "dir");
    } catch {
      handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
      await handle.listen(0);
      return; // environment can't create dir symlinks -- realpath guard still holds
    }

    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/extern/secret.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("leak-me-not-via-symlink-dir");
  });
});

describe("createApiServer / static UI serving (uiDir unset)", () => {
  it("GET / 404s (unchanged behavior) and API routes are unaffected", async () => {
    seedTask("pending", "p1");
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(rootRes.status).toBe(404);

    const stateRes = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(stateRes.status).toBe(200);
  });
});

/** Resolves after any pending microtasks/timers from a fire-and-forget background
 *  call (e.g. `POST /orchestrate`'s `.then/.catch/.finally` chain) have settled. */
function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A controllable promise -- lets a test hold `onOrchestrate` unresolved to
 *  exercise the single-flight guard, then resolve it on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createApiServer / POST /orchestrate", () => {
  it("404s when onOrchestrate is not configured (read-only deployment)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /orchestrate is not matched by the POST route (falls through to 404)", async () => {
    const onOrchestrate = async (): Promise<void> => {};
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`);
    expect(res.status).toBe(404);
  });

  it("returns 202 {accepted:true,intent} and calls onOrchestrate exactly once with the intent, in the background", async () => {
    const calls: string[] = [];
    const onOrchestrate = async (intent: string): Promise<void> => {
      calls.push(intent);
    };
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, intent: "build X" });

    await tick();
    expect(calls).toEqual(["build X"]);
  });

  it("returns 202 promptly even when onOrchestrate never resolves (response does not wait on it)", async () => {
    const onOrchestrate = (): Promise<void> => new Promise(() => {}); // never settles
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(res.status).toBe(202);
  });

  it("single-flight: second POST while first is unresolved -> 409; after first resolves, a third POST -> 202 again", async () => {
    const d = deferred<void>();
    let callCount = 0;
    const onOrchestrate = async (): Promise<void> => {
      callCount++;
      await d.promise;
    };
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const post = (intent: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent }),
      });

    const res1 = await post("first");
    expect(res1.status).toBe(202);

    const res2 = await post("second");
    expect(res2.status).toBe(409);
    expect(await res2.json()).toEqual({ error: "an orchestrate run is already in progress" });

    d.resolve();
    await tick();

    const res3 = await post("third");
    expect(res3.status).toBe(202);

    expect(callCount).toBe(2); // "first" + "third" -- "second" was rejected before invoking onOrchestrate
  });

  it("a rejected onOrchestrate still leaves the 202 sent, clears the in-flight flag, and logs the failure", async () => {
    const logs: string[] = [];
    const onOrchestrate = async (): Promise<void> => {
      throw new Error("boom");
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate }, { log: (level, message) => logs.push(`${level}:${message}`) }),
    );
    const port = await handle.listen(0);

    const res1 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "x" }),
    });
    expect(res1.status).toBe(202);

    await tick();
    expect(logs.some((l) => l.startsWith("ERROR:") && l.includes("boom"))).toBe(true);

    // Flag reset in `finally` -- a subsequent POST must be accepted again.
    const res2 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "y" }),
    });
    expect(res2.status).toBe(202);
  });

  it("an onOrchestrate that throws SYNCHRONOUSLY still returns 202, clears the flag, and logs (no unhandled rejection)", async () => {
    const logs: string[] = [];
    const onOrchestrate = (): Promise<void> => {
      throw new Error("sync boom");
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate }, { log: (level, message) => logs.push(`${level}:${message}`) }),
    );
    const port = await handle.listen(0);

    const res1 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "x" }),
    });
    expect(res1.status).toBe(202);

    await tick();
    expect(logs.some((l) => l.startsWith("ERROR:") && l.includes("sync boom"))).toBe(true);

    const res2 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "y" }),
    });
    expect(res2.status).toBe(202);
  });

  it("survives a background rejection whose error-stringify throws AND a throwing logger (no unhandled rejection; flag still clears)", async () => {
    // Error whose `message` getter throws + a logger that throws: a raw `String(err)`
    // and raw `log()` inside the chain's `.catch` would themselves throw and escape as
    // an unhandled rejection AFTER the 202. safeErrorText + safeLog + terminal .catch
    // must contain it, and `.finally` must still clear the in-flight flag.
    const hostileErr = new Error("placeholder");
    Object.defineProperty(hostileErr, "message", {
      get(): string {
        throw new Error("message getter boom");
      },
    });
    const onOrchestrate = async (): Promise<void> => {
      throw hostileErr;
    };
    const throwingLog = (): void => {
      throw new Error("logger down");
    };
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }, { log: throwingLog }));
    const port = await handle.listen(0);

    const res1 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "x" }),
    });
    expect(res1.status).toBe(202);

    await tick();
    // Flag cleared despite BOTH the error-stringify and the logger throwing.
    const res2 = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "y" }),
    });
    expect(res2.status).toBe(202);
  });

  it("flattens control chars in the logged intent (no log forging); the 202 body still echoes the intent verbatim", async () => {
    const logs: string[] = [];
    const onOrchestrate = async (): Promise<void> => {}; // resolves -> emits the completion INFO log
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate }, { log: (level, message) => logs.push(`${level}:${message}`) }),
    );
    const port = await handle.listen(0);

    const intent = "build X\nERROR: forged log line";
    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    expect(res.status).toBe(202);
    // The JSON 202 body echoes the intent verbatim (JSON-encoded -> safe).
    expect(await res.json()).toEqual({ accepted: true, intent });

    await tick();
    const completed = logs.find((l) => l.includes("orchestrate run completed"));
    expect(completed).toBeDefined();
    expect(completed).not.toContain("\n"); // newline flattened -> cannot forge a second log line
    expect(completed).toContain("build X ERROR: forged log line");
  });

  it("400s on a missing intent field, and does not call onOrchestrate", async () => {
    const onOrchestrate = async (): Promise<void> => {};
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an empty or whitespace-only intent", async () => {
    const onOrchestrate = async (): Promise<void> => {};
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const resEmpty = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "" }),
    });
    expect(resEmpty.status).toBe(400);

    const resWhitespace = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "   \n\t  " }),
    });
    expect(resWhitespace.status).toBe(400);
  });

  it("400s on a non-string intent", async () => {
    const onOrchestrate = async (): Promise<void> => {};
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on malformed JSON", async () => {
    const onOrchestrate = async (): Promise<void> => {};
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("413s on an over-sized body and does not call onOrchestrate", async () => {
    const calls: string[] = [];
    const onOrchestrate = async (intent: string): Promise<void> => {
      calls.push(intent);
    };
    handle = createApiServer(projectDeps({ repo, stateDir, onOrchestrate }));
    const port = await handle.listen(0);

    const huge = "x".repeat(1_000_001 + 64);
    const res = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: huge }),
    });
    expect(res.status).toBe(413);

    await tick();
    expect(calls).toEqual([]);
  });

  it("single-flight is PER PROJECT: project B can orchestrate while A is in flight", async () => {
    const dA = deferred<void>();
    const calls: string[] = [];
    const deps: ApiServerDeps = {
      projects: {
        list: async () => [
          { id: "a", name: "a", path: "/a", status: "ready" },
          { id: "b", name: "b", path: "/b", status: "ready" },
        ],
        get: async (id) =>
          id === "a"
            ? {
                view: {
                  repo,
                  stateDir,
                  readExecutionReportJson: storedReportReader(stateDir),
                  onOrchestrate: async (intent: string) => {
                    calls.push(`a:${intent}`);
                    await dA.promise;
                  },
                },
              }
            : id === "b"
              ? {
                  view: {
                    repo,
                    stateDir,
                    readExecutionReportJson: storedReportReader(stateDir),
                    onOrchestrate: async (intent: string) => {
                      calls.push(`b:${intent}`);
                    },
                  },
                }
              : null,
      },
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);

    const post = (pid: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/projects/${pid}/orchestrate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "do the thing" }),
      });

    expect((await post("a")).status).toBe(202); // A starts and hangs
    expect((await post("a")).status).toBe(409); // A again -> busy
    expect((await post("b")).status).toBe(202); // B is NOT blocked by A

    dA.resolve();
    await tick();
    expect(calls).toEqual(["a:do the thing", "b:do the thing"]);
  });
});

/** A fake chat adapter: `startSession` returns an incrementing session id and
 *  a canned first turn; `send` echoes the message back so tests can assert on
 *  it without a real model. Mirrors the shape `ChatSessionManager` expects
 *  from `OrchestratorChatAdapter` (see `chat-adapter.ts`). */
function makeFakeChatAdapter(): OrchestratorChatAdapter {
  let n = 0;
  return {
    startSession: async () => ({ handle: { sessionId: `s${++n}` }, turn: { reply: "hi", proposedSpecs: [] } }),
    send: async (_h: ChatSessionHandle, message: string) => ({ reply: `echo:${message}` }),
    close: async () => {},
  };
}

const emptySnapshot = async (): Promise<ReadSnapshot> => ({ existingIds: [], queues: {} as never });

describe("createApiServer / chat routes", () => {
  it("POST /chat 404s when chat is not configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /chat starts a session and returns the first turn", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessionId: string; reply: string; proposedSpecs: unknown[] };
    expect(json.sessionId).toBe("s1");
    expect(json.reply).toBe("hi");
    expect(json.proposedSpecs).toEqual([]);
  });

  it("a second POST /chat for the same project 409s while one is open", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const post = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "build X" }),
      });

    const res1 = await post();
    expect(res1.status).toBe(200);

    const res2 = await post();
    expect(res2.status).toBe(409);
  });

  it("POST /chat/:id/message forwards to the session, and DELETE /chat/:id cancels it", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const msgRes = await fetch(`http://127.0.0.1:${port}${p1(`/chat/${sessionId}/message`)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "make it faster" }),
    });
    expect(msgRes.status).toBe(200);
    expect(await msgRes.json()).toEqual({ reply: "echo:make it faster", proposedSpecs: [] });

    const cancelRes = await fetch(`http://127.0.0.1:${port}${p1(`/chat/${sessionId}`)}`, { method: "DELETE" });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ cancelled: true });
    expect(manager.hasOpenSession("p1")).toBe(false);
  });

  it("POST /chat/confirm closes the session and launches the real orchestrate path", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    const calls: string[] = [];
    const onOrchestrate = async (intent: string): Promise<void> => {
      calls.push(intent);
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate, chat: { manager, buildSnapshot: emptySnapshot } }),
    );
    const port = await handle.listen(0);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const confirmRes = await fetch(`http://127.0.0.1:${port}${p1("/chat/confirm")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, finalIntent: "build X, refined" }),
    });
    expect(confirmRes.status).toBe(202);
    expect(await confirmRes.json()).toEqual({ accepted: true, intent: "build X, refined" });

    expect(manager.hasOpenSession("p1")).toBe(false);

    await tick();
    expect(calls).toEqual(["build X, refined"]);
  });

  it("GET /chat/:id/stream on an unknown session returns a real 404 JSON response, not a 200 SSE frame", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/chat/does-not-exist/stream")}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /chat/:id/stream detaches its sink from the manager when the client disconnects", async () => {
    // Real HTTP client abort (not a fake `res`), because `handleChatStream`'s
    // `res.on("close", ...)` wiring is closure-internal to `createApiServer`
    // and cannot be reached directly from a test -- driving a genuine socket
    // teardown end-to-end is the only way to exercise it. `ChatSessionManager`
    // is real (not mocked); `vi.spyOn` wraps its `attachStream`/`detachStream`
    // so the test can observe the calls without losing the real behavior
    // underneath.
    //
    // NOTE on shape: this deliberately does NOT `await fetch(...)` for the
    // stream response -- Node's `http.ServerResponse.writeHead()` does not
    // flush headers to the socket until the first `write()`/`end()` (verified
    // empirically against this exact no-write-until-token shape), and this
    // route never writes until a token arrives, so an `await`ed fetch would
    // hang forever waiting for headers no production client-disconnect
    // scenario is actually blocked on. Instead: fire the request unawaited,
    // poll (bounded) for the server to have actually called `attachStream()`
    // (proving the request was fully dispatched and routed), THEN abort.
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const attachSpy = vi.spyOn(manager, "attachStream");
    const detachSpy = vi.spyOn(manager, "detachStream");

    const controller = new AbortController();
    const streamFetch = fetch(`http://127.0.0.1:${port}${p1(`/chat/${sessionId}/stream`)}`, {
      signal: controller.signal,
    }).catch(() => {
      /* expected: the abort below rejects this fetch -- nothing to assert on it */
    });

    const attachDeadline = Date.now() + 5000;
    while (attachSpy.mock.calls.length === 0 && Date.now() < attachDeadline) {
      await tick(10);
    }
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy.mock.results[0]?.value).toBe(true);

    // Client-side disconnect: abort the in-flight request, which tears down
    // the underlying socket and must fire `res`'s 'close' event server-side.
    controller.abort();
    await streamFetch;

    // The server's 'close' event is async relative to the client abort --
    // poll (bounded) instead of asserting synchronously.
    const detachDeadline = Date.now() + 5000;
    while (detachSpy.mock.calls.length === 0 && Date.now() < detachDeadline) {
      await tick(20);
    }

    expect(detachSpy).toHaveBeenCalledTimes(1);
    expect(detachSpy.mock.calls[0]?.[0]).toBe(sessionId);
    expect(detachSpy.mock.results[0]?.value).toBe(true);

    // The registry must be left clean, not holding the dead sink: a fresh
    // attach for the same session succeeds normally.
    const newSink = { write: () => {}, end: () => {} };
    expect(manager.attachStream(sessionId, newSink)).toBe(true);
  });

  it("POST /chat/confirm does NOT destroy the chat session when the real launch 409s (in-flight orchestrate)", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    const dOrchestrate = deferred<void>();
    const onOrchestrate = async (): Promise<void> => {
      await dOrchestrate.promise;
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate, chat: { manager, buildSnapshot: emptySnapshot } }),
    );
    const port = await handle.listen(0);

    // Kick off a real orchestrate run directly so it's in flight when confirm fires.
    const firstOrchestrate = await fetch(`http://127.0.0.1:${port}${p1("/orchestrate")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "already running" }),
    });
    expect(firstOrchestrate.status).toBe(202);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    expect(manager.hasOpenSession("p1")).toBe(true);

    const confirmRes = await fetch(`http://127.0.0.1:${port}${p1("/chat/confirm")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, finalIntent: "build X, refined" }),
    });
    expect(confirmRes.status).toBe(409);

    // The chat session must still be open -- confirm's cancel() must only run
    // AFTER a successful (202) launch, never before/regardless.
    expect(manager.hasOpenSession("p1")).toBe(true);

    dOrchestrate.resolve();
    await tick();
  });

  it("POST /chat/confirm 409s while a message send is still in flight for that session, and never invokes onOrchestrate", async () => {
    // A custom adapter whose send() is manually controlled -- the same
    // technique chat-session-manager.test.ts's turnInFlight tests use --
    // applied here through the real HTTP routes so the race is exercised
    // end-to-end (start, then a follow-up message that never resolves on
    // its own, then confirm racing against it).
    const dSend = deferred<{ reply: string }>();
    const adapter = makeFakeChatAdapter();
    adapter.send = () => dSend.promise;
    const manager = new ChatSessionManager({ adapter, log: () => {} });
    let orchestrateCalled = false;
    const onOrchestrate = async (): Promise<void> => {
      orchestrateCalled = true;
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate, chat: { manager, buildSnapshot: emptySnapshot } }),
    );
    const port = await handle.listen(0);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const msgPromise = fetch(`http://127.0.0.1:${port}${p1(`/chat/${sessionId}/message`)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "refine it" }),
    });
    // Let the message POST actually reach the manager and set turnInFlight
    // before firing confirm.
    await tick();
    expect(manager.isTurnInFlight(sessionId)).toBe(true);

    const confirmRes = await fetch(`http://127.0.0.1:${port}${p1("/chat/confirm")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, finalIntent: "build X, refined" }),
    });
    expect(confirmRes.status).toBe(409);
    const confirmBody = (await confirmRes.json()) as { error: string };
    expect(confirmBody.error).toMatch(/in flight/);

    expect(orchestrateCalled).toBe(false);
    // The chat session must still be open -- the 409 guard must fire BEFORE
    // any teardown, so the pending message send is left alone.
    expect(manager.hasOpenSession("p1")).toBe(true);

    dSend.resolve({ reply: "ok" });
    const msgRes = await msgPromise;
    expect(msgRes.status).toBe(200);
  });

  it("POST /chat/confirm 404s for a sessionId that was never started, and never invokes onOrchestrate", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    let orchestrateCalled = false;
    const onOrchestrate = async (): Promise<void> => {
      orchestrateCalled = true;
    };
    handle = createApiServer(
      projectDeps({ repo, stateDir, onOrchestrate, chat: { manager, buildSnapshot: emptySnapshot } }),
    );
    const port = await handle.listen(0);

    // No `/chat` start call was ever made -- this sessionId is entirely
    // bogus/fabricated, mirroring a stale (already idle-reaped or already
    // cancelled) session left behind by a modal.
    const confirmRes = await fetch(`http://127.0.0.1:${port}${p1("/chat/confirm")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "never-started", finalIntent: "build X, refined" }),
    });
    expect(confirmRes.status).toBe(404);
    expect(await confirmRes.json()).toEqual({ error: "chat session not found" });

    await tick();
    expect(orchestrateCalled).toBe(false);
  });

  it("handle.closeProjectChat closes the tracked manager for that project id, and is a safe no-op for an untracked one", async () => {
    const manager = new ChatSessionManager({ adapter: makeFakeChatAdapter(), log: () => {} });
    handle = createApiServer(projectDeps({ repo, stateDir, chat: { manager, buildSnapshot: emptySnapshot } }));
    const port = await handle.listen(0);

    const startRes = await fetch(`http://127.0.0.1:${port}${p1("/chat")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(startRes.status).toBe(200);
    expect(manager.hasOpenSession("p1")).toBe(true);

    // An untracked project id must be a silent no-op -- never throw.
    await expect(handle.closeProjectChat("unknown-project")).resolves.toBeUndefined();

    // The real target: closing by project id (as admin.unregister / the
    // config-evict path do) tears down the live session even though the
    // project no longer resolves through the normal /chat routes.
    await handle.closeProjectChat("p1");
    expect(manager.hasOpenSession("p1")).toBe(false);
  });
});

describe("createApiServer / thread routes", () => {
  const meta = (over: Partial<ThreadMeta> = {}): ThreadMeta => ({
    id: "th-1",
    title: "t",
    created_at: 1,
    status: "chatting",
    ...over,
  });

  /** A minimal fake `threads` capability built entirely from vi.fn spies. The
   *  `bus` is a real ThreadEventBus (harmless, only touched by the SSE route). */
  function makeFakeThreads(opts: {
    list?: ThreadMeta[];
    read?: (tid: string) => { meta: ThreadMeta; entries: unknown[] } | null;
    startThreadId?: string;
    confirmResult?: { accepted: boolean; reason?: string };
    cancelResult?: boolean;
  } = {}): {
    cap: NonNullable<ProjectView["threads"]>;
    spies: {
      startThread: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
      confirm: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      narratorMessage: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
      read: ReturnType<typeof vi.fn>;
    };
  } {
    const startThread = vi.fn(async (_pid: string, _intent: string) => ({ threadId: opts.startThreadId ?? "th-1" }));
    const sendMessage = vi.fn(async (_tid: string, _text: string) => {});
    const confirm = vi.fn(async (_tid: string) => opts.confirmResult ?? { accepted: true });
    const cancel = vi.fn(async (_tid: string) => opts.cancelResult ?? true);
    const narratorMessage = vi.fn(async (_tid: string, _text: string) => true);
    const list = vi.fn(async () => opts.list ?? []);
    const read = vi.fn(async (tid: string) => (opts.read ? opts.read(tid) : null));
    const readNdjson = vi.fn(async (_tid: string) => "");
    const cap = {
      store: { list, read, readNdjson },
      bus: new ThreadEventBus(),
      chat: { startThread, sendMessage, confirm, cancel },
      narratorMessage,
    } as unknown as NonNullable<ProjectView["threads"]>;
    return { cap, spies: { startThread, sendMessage, confirm, cancel, narratorMessage, list, read } };
  }

  it("POST /threads creates a thread (201) and GET /threads lists it (200)", async () => {
    const { cap, spies } = makeFakeThreads({ list: [meta({ id: "th-1" })], startThreadId: "th-1" });
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const createRes = await fetch(`http://127.0.0.1:${port}${p1("/threads")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "build X" }),
    });
    expect(createRes.status).toBe(201);
    expect(await createRes.json()).toEqual({ threadId: "th-1" });
    expect(spies.startThread).toHaveBeenCalledWith("p1", "build X");

    const listRes = await fetch(`http://127.0.0.1:${port}${p1("/threads")}`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { threads: ThreadMeta[] };
    expect(listJson.threads.map((t) => t.id)).toEqual(["th-1"]);
  });

  it("GET /threads/:tid returns meta+entries (200) and 404s on an unknown id", async () => {
    const record = { meta: meta({ id: "th-1" }), entries: [{ ts: 1, type: "operator_msg", text: "hi" }] };
    const { cap } = makeFakeThreads({ read: (tid) => (tid === "th-1" ? record : null) });
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const okRes = await fetch(`http://127.0.0.1:${port}${p1("/threads/th-1")}`);
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ meta: record.meta, entries: record.entries });

    const missRes = await fetch(`http://127.0.0.1:${port}${p1("/threads/nope")}`);
    expect(missRes.status).toBe(404);
  });

  it("GET /threads/:tid rejects an unsafe id (400) before touching the store", async () => {
    const { cap, spies } = makeFakeThreads();
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/threads/..evil")}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid id" });
    expect(spies.read).not.toHaveBeenCalled();
  });

  it("POST /threads/:tid/message routes a pre-launch (chatting) turn to chat.sendMessage", async () => {
    const { cap, spies } = makeFakeThreads({ read: () => ({ meta: meta({ status: "chatting" }), entries: [] }) });
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/threads/th-1/message")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "make it faster" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(spies.sendMessage).toHaveBeenCalledWith("th-1", "make it faster");
    expect(spies.narratorMessage).not.toHaveBeenCalled();
  });

  it("POST /threads/:tid/message routes a mid-run (running) turn to narratorMessage", async () => {
    const { cap, spies } = makeFakeThreads({
      read: () => ({ meta: meta({ status: "running", run_id: "r1" }), entries: [] }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/threads/th-1/message")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "status?" }),
    });
    expect(res.status).toBe(202);
    expect(spies.narratorMessage).toHaveBeenCalledWith("th-1", "status?");
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it("POST /threads/:tid/confirm maps accept->202, in_flight->409, no_session->404", async () => {
    for (const [result, expected] of [
      [{ accepted: true }, 202],
      [{ accepted: false, reason: "in_flight" }, 409],
      [{ accepted: false, reason: "no_session" }, 404],
    ] as const) {
      const { cap } = makeFakeThreads({ confirmResult: result });
      handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
      const port = await handle.listen(0);

      const res = await fetch(`http://127.0.0.1:${port}${p1("/threads/th-1/confirm")}`, { method: "POST" });
      expect(res.status).toBe(expected);
      if (expected === 202) expect(await res.json()).toEqual({ accepted: true });

      await handle.close();
      handle = null;
    }
  });

  it("DELETE /threads/:tid cancels the thread (200)", async () => {
    const { cap, spies } = makeFakeThreads({ cancelResult: true });
    handle = createApiServer(projectDeps({ repo, stateDir, threads: cap }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/threads/th-1")}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(spies.cancel).toHaveBeenCalledWith("th-1");
  });

  it("GET /threads 404s when the threads capability is not configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/threads")}`);
    expect(res.status).toBe(404);
  });
});

describe("createApiServer / listen with an explicit bind host", () => {
  it("still binds and is reachable via 127.0.0.1 when host is passed explicitly", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0, "127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(res.status).toBe(200);
  });
});

describe("createApiServer / multi-project routing", () => {
  it("GET /projects returns the project list", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("unknown project id -> 404 for every project-scoped route", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    for (const path of ["/projects/zz/state", "/projects/zz/runs", "/projects/zz/escalations/e1"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("a project in error state -> 503 with the error body, siblings unaffected", async () => {
    const deps: ApiServerDeps = {
      projects: {
        list: async () => [
          { id: "ok", name: "ok", path: "/x", status: "ready" },
          { id: "bad", name: "bad", path: "/y", status: "error", error: "bad config.yaml" },
        ],
        get: async (id) =>
          id === "ok"
            ? { view: { repo, stateDir, readExecutionReportJson: storedReportReader(stateDir) } }
            : id === "bad"
              ? { error: "bad config.yaml" }
              : null,
      },
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/projects/bad/state`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/projects/ok/state`)).status).toBe(200);
  });

  it("two projects serve their OWN state (no cross-bleed)", async () => {
    // Project A is the beforeEach root/repo; seed a pending task only into A.
    seedTask("pending", "t-a1");

    // Build a SECOND project dir + repo using the same idiom as beforeEach, and
    // seed one pending task "t-b1" into it mirroring `seedTask`.
    const rootB = mkdtempSync(join(tmpdir(), "adh-api-b-"));
    try {
      const stateDirB = join(rootB, ".autodev");
      const repoB = new FileBlackboardRepository(rootB, ".autodev");
      const pendingDirB = join(stateDirB, "queue", "pending");
      mkdirSync(pendingDirB, { recursive: true });
      writeFileSync(
        join(pendingDirB, "t-b1.md"),
        `---\nid: t-b1\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`,
      );

      const deps: ApiServerDeps = {
        projects: {
          list: async () => [
            { id: "a", name: "a", path: stateDir, status: "ready" },
            { id: "b", name: "b", path: stateDirB, status: "ready" },
          ],
          get: async (id) =>
            id === "a"
              ? { view: { repo, stateDir, readExecutionReportJson: storedReportReader(stateDir) } }
              : id === "b"
                ? { view: { repo: repoB, stateDir: stateDirB, readExecutionReportJson: storedReportReader(stateDirB) } }
                : null,
        },
      };
      handle = createApiServer(deps);
      const port = await handle.listen(0);

      const bBody = (await (await fetch(`http://127.0.0.1:${port}/projects/b/state`)).json()) as {
        queues: Record<string, { id: string }[]>;
      };
      expect(bBody.queues.pending?.map((t) => t.id)).toEqual(["t-b1"]);

      const aBody = (await (await fetch(`http://127.0.0.1:${port}/projects/a/state`)).json()) as {
        queues: Record<string, { id: string }[]>;
      };
      expect(aBody.queues.pending?.map((t) => t.id)).toEqual(["t-a1"]);
      expect(aBody.queues.pending?.map((t) => t.id)).not.toContain("t-b1");
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("old top-level routes are GONE (404)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    for (const path of ["/state", "/runs", "/orchestrate"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});

/** Fake admin port capturing calls; per-test overrides via the ctor arg. */
function fakeAdmin(overrides: Partial<NonNullable<ApiServerDeps["admin"]>> = {}) {
  const calls: {
    register: unknown[];
    unregister: string[];
    rename: { id: string; name: string }[];
    updateConfig: { id: string; form: unknown }[];
    listDirs: (string | undefined)[];
    detectAgents: number;
  } = {
    register: [],
    unregister: [],
    rename: [],
    updateConfig: [],
    listDirs: [],
    detectAgents: 0,
  };
  const admin: NonNullable<ApiServerDeps["admin"]> = {
    register: async (input) => {
      calls.register.push(input);
      return { ok: true, entry: { id: "new-proj", name: "new-proj", path: String((input as { path: string }).path) } };
    },
    unregister: async (id) => {
      calls.unregister.push(id);
      return id === "p1";
    },
    rename: async (id, name) => {
      calls.rename.push({ id, name });
      return id === "p1"
        ? { ok: true, entry: { id, name, path: "D:/Projects/p1" } }
        : { ok: false, code: "not_found", message: `project not found: ${id}` };
    },
    updateConfig: async (id, form) => {
      calls.updateConfig.push({ id, form });
      return id === "p1"
        ? { ok: true }
        : { ok: false, code: "not_found", message: `project not found: ${id}` };
    },
    listDirs: async (path) => {
      calls.listDirs.push(path);
      return { ok: true, path: path ?? null, parent: null, entries: [] } satisfies FsDirsResult;
    },
    detectAgents: async () => {
      calls.detectAgents++;
      return [] satisfies DetectedAgent[];
    },
    initGit: async () => ({ ok: true, branch: "autodev/main", untrackedCount: 0 }) satisfies GitInitResult,
    detectGit: async () => ({ installed: true }) satisfies DetectGitResult,
    ...overrides,
  };
  return { admin, calls };
}

describe("GET /fs/dirs", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs`);
    expect(res.status).toBe(404);
  });

  it("passes the decoded ?path= through and returns the listing", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=${encodeURIComponent("D:\\Projects")}`);
    expect(res.status).toBe(200);
    expect(calls.listDirs).toEqual(["D:\\Projects"]);
    const body = (await res.json()) as { path: string | null; entries: unknown[] };
    expect(body.path).toBe("D:\\Projects");
  });

  it("omits path when the param is absent (roots view)", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs`);
    expect(res.status).toBe(200);
    expect(calls.listDirs).toEqual([undefined]);
  });

  it("maps invalid_path to 400, never 500", async () => {
    const { admin } = fakeAdmin({
      listDirs: async () => ({ ok: false, code: "invalid_path", message: "nope" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=zzz`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("nope");
  });
});

describe("createApiServer / GET /agents/detect", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/agents/detect`);
    expect(res.status).toBe(404);
  });

  it("200s with the admin port's detection result wrapped in {agents}", async () => {
    const stub: DetectedAgent[] = [
      { id: "claude", name: "Claude Code", supported: true, available: true, path: "/usr/bin/claude", version: "1.0.0" },
      { id: "gemini", name: "Gemini CLI", supported: false, available: false },
    ];
    let detectCalls = 0;
    const { admin } = fakeAdmin({
      detectAgents: async () => {
        detectCalls++;
        return stub;
      },
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/agents/detect`);
    expect(res.status).toBe(200);
    expect(detectCalls).toBe(1);
    expect((await res.json()) as { agents: DetectedAgent[] }).toEqual({ agents: stub });
  });
});

describe("POST /fs/git-init", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(404);
  });

  it("200s with { branch, untrackedCount } on success", async () => {
    const { admin } = fakeAdmin({
      initGit: async () => ({ ok: true, branch: "autodev/main", untrackedCount: 3 }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branch: "autodev/main", untrackedCount: 3 });
  });

  it("409s for an already-git repo, 400 for other typed codes", async () => {
    const { admin } = fakeAdmin({
      initGit: async () => ({ ok: false, code: "already_git_repo", message: "already a git repository" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("already_git_repo");
  });

  it("400s for other typed codes (e.g. invalid_path)", async () => {
    const { admin } = fakeAdmin({
      initGit: async () => ({ ok: false, code: "invalid_path", message: "not a directory" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_path");
  });

  it("400s on a missing path", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /system/git", () => {
  it("404s without an admin port", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/system/git`)).status).toBe(404);
  });

  it("200s with the detect result", async () => {
    const { admin } = fakeAdmin({ detectGit: async () => ({ installed: true, version: "git version 2.44.0" }) });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/system/git`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installed: true, version: "git version 2.44.0" });
  });
});

describe("GET /settings", () => {
  it("404s without a settings port", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/settings`)).status).toBe(404);
  });

  it("200s with the settings plus opt-in counts", async () => {
    handle = createApiServer(
      projectDeps(
        { repo, stateDir },
        {
          settings: {
            read: async () => ({ overnight: { enabled: true }, optedInProjects: 1, totalProjects: 3 }),
            write: async () => ({ overnight: { enabled: true }, optedInProjects: 1, totalProjects: 3 }),
          },
        },
      ),
    );
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      overnight: { enabled: true },
      optedInProjects: 1,
      totalProjects: 3,
    });
  });
});

describe("PATCH /settings", () => {
  const okPort = () => ({
    read: async () => ({ overnight: { enabled: false }, optedInProjects: 0, totalProjects: 0 }),
    write: async (s: { overnight: { enabled: boolean } }) => ({
      overnight: { enabled: s.overnight.enabled },
      optedInProjects: 0,
      totalProjects: 0,
    }),
  });

  it("writes and returns the same shape as GET", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      overnight: { enabled: true },
      optedInProjects: 0,
      totalProjects: 0,
    });
  });

  it("400s on an unknown key", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true }, bogus: 1 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_settings");
  });

  it("400s on a wrongly-typed value", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: "yes" } }),
    });
    expect(res.status).toBe(400);
  });

  it("500s when the write fails", async () => {
    handle = createApiServer(
      projectDeps(
        { repo, stateDir },
        {
          settings: {
            read: okPort().read,
            write: async () => {
              throw new Error("disk on fire");
            },
          },
        },
      ),
    );
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true } }),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /projects", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:/x" }),
    });
    expect(res.status).toBe(404);
  });

  it("registers and returns 201 with the entry", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:/Projects/app", name: "App", scaffold: true, config: { gate: { checkCommand: "npm test" } } }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { id: string }).toMatchObject({ id: "new-proj" });
    expect(calls.register[0]).toMatchObject({ path: "D:/Projects/app", name: "App", scaffold: true });
  });

  it("400s a missing/empty path before calling the port", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    for (const body of [{}, { path: "" }, { path: 42 }]) {
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(calls.register).toEqual([]);
  });

  it("maps already_registered to 409 and invalid_path/not_a_git_repo/invalid_config to 400", async () => {
    const cases: Array<{ code: "already_registered" | "invalid_path" | "not_a_git_repo" | "invalid_config"; status: number }> = [
      { code: "already_registered", status: 409 },
      { code: "invalid_path", status: 400 },
      { code: "not_a_git_repo", status: 400 },
      { code: "invalid_config", status: 400 },
    ];
    for (const c of cases) {
      const { admin } = fakeAdmin({
        register: async () => ({ ok: false, code: c.code, message: "m" }) as RegisterResult,
      });
      const h = createApiServer(projectDeps({ repo, stateDir }, { admin }));
      const port = await h.listen(0);
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "D:/x" }),
      });
      expect(res.status).toBe(c.status);
      await h.close();
    }
  });

  it("rejects invalid JSON with 400", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /projects/:id", () => {
  it("unregisters a known id -> 200; unknown id -> 404", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const ok = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { removed: string }).toMatchObject({ removed: "p1" });

    const missing = await fetch(`http://127.0.0.1:${port}/projects/ghost`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(calls.unregister).toEqual(["p1", "ghost"]);
  });

  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("works even when the project root would fail to build (never resolves the root)", async () => {
    const { admin } = fakeAdmin();
    const deps: ApiServerDeps = {
      projects: {
        list: async () => [],
        get: async () => ({ error: "broken config" }), // GET-path would 503
      },
      admin,
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(res.status).toBe(200); // DELETE never called projects.get
  });

  it("closes a live watcher for the removed project id", async () => {
    let closed = 0;
    const fakeWatchFactory = (_sd: string, _onChange: (p: string) => void) => ({
      close: () => {
        closed++;
      },
    });
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin, watchFactory: fakeWatchFactory }));
    const port = await handle.listen(0);

    // Attach the watcher by touching any project-scoped GET route.
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(closed).toBe(0);

    await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(closed).toBe(1);
  });
});

describe("PATCH /projects/:id", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(404);
  });

  it("renames a known id -> 200 with the updated entry; forwards id+name to admin.rename", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string; name: string }).toMatchObject({ id: "p1", name: "New Name" });
    expect(calls.rename).toEqual([{ id: "p1", name: "New Name" }]);
  });

  it("unknown id -> 404", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/ghost`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "not_found" });
  });

  it("empty/invalid name -> 400 (admin reports invalid_name)", async () => {
    const { admin } = fakeAdmin({
      rename: async () => ({ ok: false, code: "invalid_name", message: "name must not be empty" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "invalid_name" });
  });

  it("non-string name -> 400 WITHOUT calling admin.rename", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "name must be a string" });
    expect(calls.rename).toEqual([]);
  });

  it("invalid project id segment -> 400 'invalid project id'", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent("bad id!")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid project id" });
  });

  it("malformed JSON body -> 400 WITHOUT calling admin.rename", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid JSON body" });
    expect(calls.rename).toEqual([]);
  });

  it("rejects an over-sized body with 413 and never calls admin.rename", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    // Same unbounded-body memory-DoS guard as register/reply (`[api/413-teardown]`).
    const huge = "x".repeat(1_000_001 + 64);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: huge }),
    });
    expect(res.status).toBe(413);
    expect(calls.rename).toEqual([]);
  });

  it("renames even when the project's config fails to build (handled before root resolve)", async () => {
    // The whole reason PATCH sits BEFORE `projects.get`: a project whose config is
    // broken (get -> {error}, or here a throw) must still be renameable. Assert the
    // rename lands and `projects.get` is never consulted for this route.
    const { admin, calls } = fakeAdmin();
    let getCalls = 0;
    handle = createApiServer({
      projects: {
        list: async () => [{ id: "p1", name: "p1", path: stateDir, status: "error" }],
        get: async () => {
          getCalls++;
          throw new Error("config failed to build");
        },
      },
      admin,
    });
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Despite Broken Config" }),
    });
    expect(res.status).toBe(200);
    expect(calls.rename).toEqual([{ id: "p1", name: "Renamed Despite Broken Config" }]);
    expect(getCalls).toBe(0);
  });
});

describe("GET /projects/:id/config", () => {
  const sampleConfig: ProjectConfigView = {
    stateDir: ".autodev",
    allowedBranchPattern: "^autodev/",
    gate: { checkCommand: "npm test", agentCi: { enabled: false } },
    worktree: { provision: ["vendor", "node_modules"] },
    roles: {
      orchestrator: { adapter: "claude", model: "opus", effort: "high" },
      worker: { adapter: "claude", ladder: ["opus", "sonnet", "haiku"] },
      critic: { adapter: "codex", model: "gpt-5.5", effort: "high" },
      planner: { adapter: "codex", model: "o3", effort: "high" },
    },
    isolation: { worker: { cleanRoom: false, mcp: false, skills: false } },
    autonomy: { overnight: { enabled: false } },
    policy: { heterogeneity: "warn" },
    heterogeneityWarnings: [],
  };

  it("404s when the view has no config (default projectDeps helper doesn't set it)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`);
    expect(res.status).toBe(404);
  });

  it("returns the exact curated config object when the view has config", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectConfigView;
    expect(body).toEqual(sampleConfig);
  });

  it("omits an absent optional orchestrator effort rather than sending it as undefined/null", async () => {
    const configNoEffort: ProjectConfigView = {
      ...sampleConfig,
      roles: { ...sampleConfig.roles, orchestrator: { adapter: "claude", model: "opus" } },
    };
    handle = createApiServer(projectDeps({ repo, stateDir, config: configNoEffort }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectConfigView;
    expect(body).toEqual(configNoEffort);
    expect(Object.prototype.hasOwnProperty.call((body.roles as { orchestrator: object }).orchestrator, "effort")).toBe(
      false,
    );
  });

  it("400s on an invalid project id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/projects/@bad/config`);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /projects/:id/config", () => {
  const sampleConfig: ProjectConfigView = {
    stateDir: ".autodev",
    allowedBranchPattern: "^autodev/",
    gate: { checkCommand: "npm test", agentCi: { enabled: false } },
    worktree: { provision: ["vendor", "node_modules"] },
    roles: {
      orchestrator: { adapter: "claude", model: "opus", effort: "high" },
      worker: { adapter: "claude", ladder: ["opus", "sonnet", "haiku"] },
      critic: { adapter: "codex", model: "gpt-5.5", effort: "high" },
    },
    isolation: { worker: { cleanRoom: false, mcp: false, skills: false } },
    autonomy: { overnight: { enabled: false } },
    policy: { heterogeneity: "warn" },
    heterogeneityWarnings: [],
  };

  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: { checkCommand: "npm test" } }),
    });
    expect(res.status).toBe(404);
  });

  it("success -> 200 with the entry's config; forwards {id, form} to admin.updateConfig", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: { checkCommand: "npm test" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectConfigView;
    expect(body).toEqual(sampleConfig);
    expect(calls.updateConfig).toEqual([{ id: "p1", form: { gate: { checkCommand: "npm test" } } }]);
  });

  it("unknown id -> 404 not_found", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/projects/ghost/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: { checkCommand: "npm test" } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "not_found" });
  });

  it("invalid form (admin reports invalid_config) -> 400", async () => {
    const { admin } = fakeAdmin({
      updateConfig: async () => ({ ok: false, code: "invalid_config", message: "invalid config form: bogus" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bogus: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "invalid_config" });
  });

  it("malformed JSON body -> 400 WITHOUT calling admin.updateConfig", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid JSON body" });
    expect(calls.updateConfig).toEqual([]);
  });

  it("rejects an over-sized body with 413 and never calls admin.updateConfig", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir, config: sampleConfig }, { admin }));
    const port = await handle.listen(0);
    // Same unbounded-body memory-DoS guard as register/rename/reply (`[api/413-teardown]`).
    const huge = "x".repeat(1_000_001 + 64);
    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: { checkCommand: huge } }),
    });
    expect(res.status).toBe(413);
    expect(calls.updateConfig).toEqual([]);
  });

  it("succeeds even though the project's config currently fails to build (PATCH sits before root-resolve; the post-write re-resolve then picks up the fixed state)", async () => {
    // Mirrors the rename PATCH block's "broken-config-still-renameable" test: the
    // config-write route must be reachable regardless of the CURRENT hub state.
    // Unlike rename, this route DOES need one post-write `projects.get` call (to
    // report the fresh config back), so the stateful fake here fails on its FIRST
    // call (simulating the currently-broken build a plain GET would 503 on) and
    // succeeds from the SECOND call on (simulating the post-write rebuild that
    // index.ts's real wiring triggers via hub.evict).
    const { admin } = fakeAdmin({ updateConfig: async () => ({ ok: true }) });
    let getCalls = 0;
    const fixedConfig: ProjectConfigView = { ...sampleConfig, gate: { checkCommand: "fixed", agentCi: { enabled: false } } };
    handle = createApiServer({
      projects: {
        list: async () => [{ id: "p1", name: "p1", path: stateDir, status: "error" }],
        get: async (id) => {
          getCalls++;
          if (id !== "p1") return null;
          if (getCalls === 1) return { error: "config currently fails to build" };
          return { view: { repo, stateDir, config: fixedConfig, readExecutionReportJson: storedReportReader(stateDir) } };
        },
      },
      admin,
    });
    const port = await handle.listen(0);

    // A plain GET while the config is still broken -- 503, and consumes call #1.
    const getRes = await fetch(`http://127.0.0.1:${port}${p1("/config")}`);
    expect(getRes.status).toBe(503);

    // The PATCH never consults the broken cached state (it's handled before root-
    // resolve): it calls admin.updateConfig directly, then does its OWN post-write
    // get() (call #2), which now reflects the fixed config.
    const res = await fetch(`http://127.0.0.1:${port}${p1("/config")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: { checkCommand: "fixed" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectConfigView;
    expect(body).toEqual(fixedConfig);
    expect(getCalls).toBe(2);
  });
});

describe("createApiServer / CI observability routes", () => {
  it("GET /projects/:id/ci/capability 404s when the view has no onCiCapability (default projectDeps helper doesn't set it)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/ci/capability")}`);
    expect(res.status).toBe(404);
  });

  it("GET /projects/:id/ci/capability returns the capability JSON when the view provides onCiCapability", async () => {
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onCiCapability: async () => ({ mode: "native", detail: "native here" }),
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/ci/capability")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "native", detail: "native here" });
  });

  it("GET /projects/:id/ci/:taskId/stream 404s when the view has no ci capability", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/ci/t1/stream")}`);
    expect(res.status).toBe(404);
  });

  it("GET /projects/:id/ci/:taskId/stream replays persisted history as SSE frames", async () => {
    const bus = new CiEventBus();
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        ci: {
          bus,
          readEvents: async () => '{"kind":"run-start"}\n{"kind":"run-finish","status":"passed"}\n',
        },
        onCiCapability: async () => ({ mode: "native", detail: "x" }),
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/ci/t1/stream")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: {"kind":"run-start"}');
    await reader.cancel();
  });
});

describe("createApiServer / GET /runs/:runId/report", () => {
  it("404s with 'report not ready' before the run has produced one", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/run-1/report")}`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "report not ready" });
  });

  it("returns the stored execution report JSON once written", async () => {
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(
      // The stored file is `<runId>.json` -- no added prefix: a run id already
      // starts with `run-`, so one would bake `run-run-...` into every artifact name.
      join(stateDir, "reports", "run-1.json"),
      JSON.stringify({ kind: "harness-execution", run: { runId: "run-1" } }),
    );

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/run-1/report")}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string }).toMatchObject({ kind: "harness-execution" });
  });

  it("accepts a DOTTED run id -- the same allowlist the write side uses", async () => {
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(join(stateDir, "reports", "run-OVERVIEW.md-1.json"), JSON.stringify({ kind: "harness-execution" }));
    // The request path carries the FULL run id, dots and all.

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/run-OVERVIEW.md-1/report")}`);
    expect(res.status).toBe(200);
  });

  it("reads through the project's report reader -- the route never builds the filename itself", async () => {
    // The composition root owns `<stateDir>/reports/<runId>.json` (`executionReportPath`).
    // Proof that the route goes through the injected reader and not its own `join`:
    // NOTHING is written to stateDir here, and the reader is the only source of content.
    const seen: string[] = [];
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        readExecutionReportJson: async (runId) => {
          seen.push(runId);
          return JSON.stringify({ kind: "harness-execution", run: { runId } });
        },
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/run-1/report")}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string }).toMatchObject({ kind: "harness-execution" });
    expect(seen).toEqual(["run-1"]);
  });

  it("400s a traversal-shaped run id", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/..%2Fx/report")}`);
    expect(res.status).toBe(400);
  });

  it("500s (never 404s) a report file that exists but does not parse", async () => {
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(join(stateDir, "reports", "run-1.json"), "{not json");

    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/runs/run-1/report")}`);
    expect(res.status).toBe(500);
  });
});

describe("createApiServer / POST /qualification-report", () => {
  it("404s when the project exposes no qualification-report capability", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/qualification-report")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("passes the range through and returns {json, markdown}", async () => {
    const seen: { from?: string; to?: string }[] = [];
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onQualificationReport: async (range) => {
          seen.push(range);
          return { json: { kind: "product-qualification" }, markdown: "# Product Qualification Report" };
        },
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/qualification-report")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "abc123", to: "HEAD" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { markdown: string }).toMatchObject({ markdown: "# Product Qualification Report" });
    expect(seen).toEqual([{ from: "abc123", to: "HEAD" }]);
  });

  it("400s a rev that git would read as a FLAG", async () => {
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onQualificationReport: async () => ({ json: {}, markdown: "" }),
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/qualification-report")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "--all" }),
    });
    expect(res.status).toBe(400);
  });

  it("500s when the range cannot be resolved -- never an empty report", async () => {
    handle = createApiServer(
      projectDeps({
        repo,
        stateDir,
        onQualificationReport: async () => {
          throw new Error("git rev-list bad..HEAD failed (exit 128)");
        },
      }),
    );
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/qualification-report")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "bad" }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("rev-list");
  });
});
