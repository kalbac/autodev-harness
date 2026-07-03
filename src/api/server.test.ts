import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import type { BlackboardRepository } from "../blackboard/repository.js";
import { escalate } from "../escalate/escalate.js";
import type { EscalationInput } from "../escalate/escalate.js";
import { createApiServer, type ApiServerHandle, type ApiServerDeps } from "./server.js";

/** Wrap a single {repo, stateDir[, onOrchestrate]} as a one-project deps object
 *  (project id "p1") -- keeps the existing single-project test bodies unchanged
 *  except for the URL prefix. */
function projectDeps(
  one: { repo: BlackboardRepository; stateDir: string; onOrchestrate?: (intent: string) => Promise<unknown> },
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
                ...(one.onOrchestrate !== undefined ? { onOrchestrate: one.onOrchestrate } : {}),
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
function seedTask(state: "pending" | "active" | "done", id: string): void {
  const dir = join(stateDir, "queue", state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`,
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

  it("rejects a choice other than A/B with 400 and writes no reply file", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}${p1("/escalations")}/esc-3/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
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
      JSON.stringify({ id: "esc-1", choice: "C", note: "", at: 1 }),
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

  it("a missing asset WITH an extension 404s (no SPA fallback)", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/missing.js`);
    expect(res.status).toBe(404);
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

    const res = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret2.txt`);
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("leak-me-not-via-encoded-dots");
  });

  it("an encoded-dot missing asset (/missing%2ejs -> missing.js) 404s, never SPA-fallbacks to index", async () => {
    const uiDir = seedUiDir();
    handle = createApiServer(projectDeps({ repo, stateDir }, { uiDir }));
    const port = await handle.listen(0);

    // Decodes to `missing.js` -- an ASSET path with no file. The SPA-vs-asset
    // heuristic must use the DECODED extension, so this 404s (not a route 200).
    const res = await fetch(`http://127.0.0.1:${port}/missing%2ejs`);
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
          id === "ok" ? { view: { repo, stateDir } } : id === "bad" ? { error: "bad config.yaml" } : null,
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
              ? { view: { repo, stateDir } }
              : id === "b"
                ? { view: { repo: repoB, stateDir: stateDirB } }
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
