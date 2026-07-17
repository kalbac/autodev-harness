import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBlackboardRepository } from "../blackboard/file-repository.js";
import { parseEscalation } from "../escalate/escalate.js";
import { superviseOvernight, parseReworkCount, type OvernightSupervisorDeps } from "./overnight-supervisor.js";
import { serializeDecision } from "./decision-journal.js";
import { appendFile, readFile } from "node:fs/promises";

let root: string;
let stateDir: string;
let repo: FileBlackboardRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-overnight-"));
  stateDir = join(root, ".autodev");
  mkdirSync(join(stateDir, "escalations"), { recursive: true });
  // Real constructor shape is (repoRoot, stateDir) with stateDir RELATIVE to repoRoot
  // (see src/blackboard/file-repository.ts) -- ".autodev" here, not the absolute path.
  repo = new FileBlackboardRepository(root, ".autodev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Seed a task in queue/<state>/<id>.md (minimal valid front-matter). */
function seedTask(state: "pending" | "escalated", id: string): void {
  const dir = join(stateDir, "queue", state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`);
}

/** Seed an escalation artifact escalations/<id>.md with the given Type. Deviation
 *  from the plan's literal snippet: that version used field prefixes ("**Type:**",
 *  "**What:**", "**Decision:**", "**Cost of wrong:**") and an unfenced "**Evidence:**
 *  e" line that do NOT match the real `parseEscalation` contract (it requires
 *  "**What happened:**", "**Decision you need to make:**", "**Cost of being
 *  wrong:**", and a line that is EXACTLY "**Evidence:**" followed by a fenced
 *  ``` block -- see src/escalate/escalate.ts `buildBody`/`parseEscalation`), so it
 *  always parsed to null. Fixed here to the real artifact shape (test-side bug
 *  fix, per the plan's own Task-5 step-2 note -- never weaken parseEscalation
 *  or the supervisor to accommodate a broken fixture). */
function seedEscalation(id: string, type: string): void {
  writeFileSync(
    join(stateDir, "escalations", `${id}.md`),
    [
      `# ESCALATION ${id} -- seeded`,
      "",
      `**Task:** ${id} -- t`,
      `**Type:** ${type}`,
      `**What happened:** seeded`,
      `**Decision you need to make:** seeded`,
      `**Option A:** a`,
      `**Option B:** b`,
      `**Cost of being wrong:** c`,
      "",
      "**Evidence:**",
      "```",
      "seeded evidence",
      "```",
      "",
    ].join("\n"),
  );
}

function realDeps(over: Partial<OvernightSupervisorDeps> = {}): OvernightSupervisorDeps {
  const journalPath = join(stateDir, "decision-journal.ndjson");
  const escalationsDir = join(stateDir, "escalations");
  return {
    enabled: true,
    maxAutoReworks: 2,
    drain: async () => {}, // no conductor in this test -- we drive the sweep directly
    listEscalated: async () => (await repo.listTasks("escalated")).map((t) => ({ id: t.id })),
    readEscalationType: async (id) => {
      const md = await readFile(join(escalationsDir, `${id}.md`), "utf8").catch(() => null);
      return md ? (parseEscalation(md)?.type ?? null) : null;
    },
    getReworkCount: async (id) => parseReworkCount(await repo.readRuntimeFile(id, "auto-rework-count"), 2),
    setReworkCount: async (id, n) => repo.writeRuntimeFile(id, "auto-rework-count", String(n)),
    requeueForRework: async (id) => {
      await repo.setAttempts(id, 0);
      await repo.moveTask(id, "escalated", "pending");
    },
    writeDecision: async (e) => appendFile(journalPath, serializeDecision(e), "utf8"),
    now: () => "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("superviseOvernight (real repo + parseEscalation)", () => {
  it("auto-reworks a real disagreement escalation once: attempts reset, task moved to pending, journal + count persisted", async () => {
    seedTask("escalated", "esc-dis");
    seedEscalation("esc-dis", "disagreement");
    await repo.setAttempts("esc-dis", 3);
    // Drain empties the (now-pending) queue on the 2nd sweep so the loop terminates after one rework.
    let sweeps = 0;
    await superviseOvernight(realDeps({ drain: async () => { sweeps += 1; } }));
    expect(existsSync(join(stateDir, "queue", "pending", "esc-dis.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-dis.md"))).toBe(false);
    expect(await repo.getAttempts("esc-dis")).toBe(0);
    expect(await repo.readRuntimeFile("esc-dis", "auto-rework-count")).toBe("1");
    const journal = readFileSync(join(stateDir, "decision-journal.ndjson"), "utf8").trim().split("\n");
    expect(JSON.parse(journal[0]!).decision).toBe("auto-rework");
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  it("parks a real blocked escalation: stays escalated, one park journal line, no requeue", async () => {
    seedTask("escalated", "esc-blk");
    seedEscalation("esc-blk", "blocked");
    await superviseOvernight(realDeps());
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-blk.md"))).toBe(true);
    expect(existsSync(join(stateDir, "queue", "pending", "esc-blk.md"))).toBe(false);
    const journal = readFileSync(join(stateDir, "decision-journal.ndjson"), "utf8").trim().split("\n");
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!).decision).toBe("park");
  });

  it("FAIL-CLOSED: a corrupt auto-rework-count runtime file parks a retryable escalation (no fresh quota)", async () => {
    seedTask("escalated", "esc-corrupt");
    seedEscalation("esc-corrupt", "disagreement");
    // A damaged/tampered counter must NOT grant a fresh auto-rework quota -> park.
    await repo.writeRuntimeFile("esc-corrupt", "auto-rework-count", "garbage");
    await superviseOvernight(realDeps());
    expect(existsSync(join(stateDir, "queue", "escalated", "esc-corrupt.md"))).toBe(true); // parked, never requeued
    expect(existsSync(join(stateDir, "queue", "pending", "esc-corrupt.md"))).toBe(false);
    const journal = readFileSync(join(stateDir, "decision-journal.ndjson"), "utf8").trim().split("\n");
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!).decision).toBe("park");
  });
});
