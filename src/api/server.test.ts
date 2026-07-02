import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import { createApiServer, type ApiServerHandle } from "./server.js";

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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/state`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/state`);
    const body = (await res.json()) as { digestTail: string };
    expect(body.digestTail).toContain("LAST LINE");
  });

  it("never throws when digest.md is absent -- digestTail is an empty string", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/state`);
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

    handle = createApiServer({ repo, stateDir, watchFactory: fakeWatchFactory });
    const port = await handle.listen(0);

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
    handle = createApiServer({ repo, stateDir, now: () => 424242 });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/escalations/esc-1/reply`, {
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
    handle = createApiServer({ repo, stateDir, now: () => 1 });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/escalations/esc-2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "B" }),
    });
    const body = (await res.json()) as { note: string };
    expect(body.note).toBe("");
  });

  it("rejects a choice other than A/B with 400 and writes no reply file", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/escalations/esc-3/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "C" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "esc-3.reply.json"))).toBe(false);
  });

  it("rejects an id containing '..' with 400 and writes no file", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/escalations/foo..bar/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "foo..bar.reply.json"))).toBe(false);
  });

  it("rejects an id containing an (encoded) slash with 400 and writes no file outside escalations/", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    // %2F decodes to "/" -- must be rejected even though it matches the route
    // as a single raw path segment (path-traversal guard is post-decode).
    const res = await fetch(`http://127.0.0.1:${port}/escalations/a%2Fb/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "a.reply.json"))).toBe(false);
    expect(existsSync(join(stateDir, "escalations", "a", "b.reply.json"))).toBe(false);
  });

  it("rejects an id with a colon (Windows ADS syntax) via the positive allowlist", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/escalations/a%3Ab/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(stateDir, "escalations", "a:b.reply.json"))).toBe(false);
  });

  it("rejects an over-sized body with 413 and writes no reply file", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    // note is free text -- an unbounded body is a memory-DoS / close()-hang risk.
    const huge = "x".repeat(1_000_001 + 64);
    const res = await fetch(`http://127.0.0.1:${port}/escalations/esc-big/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "A", note: huge }),
    });
    expect(res.status).toBe(413);
    expect(existsSync(join(stateDir, "escalations", "esc-big.reply.json"))).toBe(false);
  });
});

describe("createApiServer / GET /state digest tail is bounded", () => {
  it("returns the true last line even when digest.md far exceeds the read window", async () => {
    mkdirSync(stateDir, { recursive: true });
    // Write a digest larger than MAX_DIGEST_READ_BYTES (64KB) so the positioned
    // tail read is exercised; the final line must still be surfaced intact.
    const filler = Array.from({ length: 5000 }, (_v, i) => `[ts] filler line ${i}`).join("\n");
    writeFileSync(join(stateDir, "digest.md"), `${filler}\n[ts] THE ACTUAL LAST LINE\n`);

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/state`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/state`);
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
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns manifests sorted newest-first by at", async () => {
    seedRun("run-1", 100);
    seedRun("run-2", 300);
    seedRun("run-3", 200);

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string }[];
    expect(body.map((r) => r.runId)).toEqual(["run-good"]);
  });

  it("returns [] (never 500s) when runs/ exists but is a plain file, not a directory", async () => {
    // runs/ occupied by a file -> readdir throws ENOTDIR; best-effort must degrade to [].
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "runs"), "not a directory");

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("createApiServer / GET /runs/:id", () => {
  it("returns the manifest for a known run id", async () => {
    seedRun("run-abc", 42, "build the thing", ["t1", "t2"]);

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs/run-abc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; intent: string; taskIds: string[]; at: number };
    expect(body).toEqual({ runId: "run-abc", intent: "build the thing", taskIds: ["t1", "t2"], at: 42 });
  });

  it("404s for a missing run id", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("400s for an id containing '..'", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs/foo..bar`);
    expect(res.status).toBe(400);
  });

  it("400s for an id with an encoded slash (path-traversal guard is post-decode)", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs/a%2Fb`);
    expect(res.status).toBe(400);
  });

  it("a traversal id can never read a file outside runs/ (sentinel one dir up is unreachable)", async () => {
    seedRun("run-x", 1);
    // Sentinel sits directly under stateDir, one directory above runs/.
    writeFileSync(join(stateDir, "sentinel.json"), JSON.stringify({ secret: "leak-me-not" }));

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/runs/..%2Fsentinel`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as string[];
    expect(body.sort()).toEqual(["gate-verdict.json", "worker-report.md"]);
  });

  it("returns [] when the task's runtime dir does not exist", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/no-such-task/runtime`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("400s for a bad task id", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/a%2Fb/runtime`);
    expect(res.status).toBe(400);
  });
});

describe("createApiServer / GET /tasks/:id/runtime/:name", () => {
  it("returns text content with text/plain content-type for a non-json file", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-report.md"), "# hello world");

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/worker-report.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("# hello world");
  });

  it("returns application/json content-type for a .json file", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gate-verdict.json"), JSON.stringify({ verdict: "pass" }));

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/gate-verdict.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { verdict: string };
    expect(body.verdict).toBe("pass");
  });

  it("404s when the runtime file does not exist", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/missing.md`);
    expect(res.status).toBe(404);
  });

  it("400s for a bad task id", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/a%2Fb/runtime/report.md`);
    expect(res.status).toBe(400);
  });

  it("400s for a name containing '..' (even embedded, e.g. worker..report)", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/worker..report`);
    expect(res.status).toBe(400);
  });

  it("400s for a name with an encoded slash (path-traversal guard is post-decode)", async () => {
    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/a%2Fb`);
    expect(res.status).toBe(400);
  });

  it("a traversal name can never read a file outside the task's runtimeDir (sentinel one dir up is unreachable)", async () => {
    const dir = repo.runtimeDir("t1");
    mkdirSync(dir, { recursive: true });
    // Sentinel sits in the shared "runtime" parent dir, one directory above t1's own runtimeDir.
    const runtimeParent = join(dir, "..");
    writeFileSync(join(runtimeParent, "sentinel-runtime.txt"), "leak-me-not-either");

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/..%2Fsentinel-runtime.txt`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/huge.json`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/subdir`);
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

    handle = createApiServer({ repo, stateDir });
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/tasks/t1/runtime/link.md`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("leak-me-not-via-symlink");
  });
});
