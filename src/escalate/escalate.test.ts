import { describe, it, expect } from "vitest";
import { escalate } from "./escalate.js";
import type { EscalateDeps, EscalationInput } from "./escalate.js";

const ESCALATIONS_DIR = "/repo/.autodev/escalations";

function makeInput(overrides: Partial<EscalationInput> = {}): EscalationInput {
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

interface Fakes {
  deps: EscalateDeps;
  files: Map<string, string>;
  appends: Map<string, string[]>;
  telegramCalls: Array<{ token: string; chat: string; text: string }>;
  logs: Array<{ level: string; message: string }>;
}

function makeFakes(overrides: {
  env?: Record<string, string>;
  writeFile?: EscalateDeps["writeFile"];
  telegramPost?: EscalateDeps["telegramPost"];
  omitTelegramPost?: boolean;
} = {}): Fakes {
  const files = new Map<string, string>();
  const appends = new Map<string, string[]>();
  const telegramCalls: Array<{ token: string; chat: string; text: string }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const env = overrides.env ?? {};

  const writeFile: EscalateDeps["writeFile"] =
    overrides.writeFile ??
    (async (path: string, content: string) => {
      files.set(path, content);
    });

  const appendFile: EscalateDeps["appendFile"] = async (path: string, content: string) => {
    const existing = appends.get(path) ?? [];
    existing.push(content);
    appends.set(path, existing);
  };

  const telegramPost: EscalateDeps["telegramPost"] =
    overrides.telegramPost ??
    (overrides.omitTelegramPost
      ? undefined
      : async (token: string, chat: string, text: string) => {
          telegramCalls.push({ token, chat, text });
        });

  const deps: EscalateDeps = {
    escalationsDir: ESCALATIONS_DIR,
    writeFile,
    appendFile,
    env: (name: string) => env[name],
    ...(telegramPost !== undefined ? { telegramPost } : {}),
    log: (level: string, message: string) => {
      logs.push({ level, message });
    },
  };

  return { deps, files, appends, telegramCalls, logs };
}

describe("escalate", () => {
  it("1. builds an artifact containing every field, the fenced evidence, and the verbatim Reply paragraph", async () => {
    const { deps, files } = makeFakes();
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.path).toBe(`${ESCALATIONS_DIR}/esc-1.md`);
    expect(result.artifactWritten).toBe(true);

    const content = files.get(`${ESCALATIONS_DIR}/esc-1.md`);
    expect(content).toBeDefined();
    const body = content!;

    expect(body).toContain("# ESCALATION esc-1 -- worker disagreed with critic twice");
    expect(body).toContain("**Task:** T-42 -- Rename public API");
    expect(body).toContain("**Type:** disagreement");
    expect(body).toContain("**What happened:** Worker renamed a public export; critic rejected twice.");
    expect(body).toContain("**Decision you need to make:** Keep old name or accept the rename?");
    expect(body).toContain("**Option A:** Keep old name");
    expect(body).toContain("**Option B:** Accept rename");
    expect(body).toContain("**Cost of being wrong:** Downstream consumers break silently");
    expect(body).toContain("**Evidence:**\n```\ndiff --git a/x b/x\n+export function newName() {}\n```");
    expect(body).toContain(
      "**Reply:** `A` / `B` -- structured choice only. Free-form text is recorded for\n" +
        "context but is NEVER executed as a worker instruction (Telegram is an injection\n" +
        "surface). Until you reply, this task is parked; other tasks continue.",
    );
  });

  it("2. env unset -> no telegram call, delivery outbox, exact outbox line appended", async () => {
    const { deps, appends, telegramCalls } = makeFakes({ env: {} });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.delivery).toBe("outbox");
    expect(telegramCalls).toHaveLength(0);
    const outboxLines = appends.get(`${ESCALATIONS_DIR}/_outbox.md`);
    expect(outboxLines).toEqual([
      "- [ ] [autodev escalation esc-1] disagreement :: Rename public API -- Keep old name or accept the rename? " +
        "(A: Keep old name | B: Accept rename). Cost if wrong: Downstream consumers break silently  " +
        "(file: escalations/esc-1.md)\n",
    ]);
  });

  it("3. env set + telegramPost succeeds -> delivery telegram, no outbox append", async () => {
    const { deps, appends, telegramCalls } = makeFakes({
      env: { AUTODEV_TELEGRAM_TOKEN: "tok-123", AUTODEV_TELEGRAM_CHAT: "chat-456" },
    });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.delivery).toBe("telegram");
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]?.token).toBe("tok-123");
    expect(telegramCalls[0]?.chat).toBe("chat-456");
    expect(telegramCalls[0]?.text).toBe(
      "[autodev escalation esc-1] disagreement :: Rename public API -- Keep old name or accept the rename? " +
        "(A: Keep old name | B: Accept rename). Cost if wrong: Downstream consumers break silently",
    );
    expect(appends.has(`${ESCALATIONS_DIR}/_outbox.md`)).toBe(false);
  });

  it("4. env set + telegramPost throws -> falls back to outbox, does not throw", async () => {
    const { deps, appends } = makeFakes({
      env: { AUTODEV_TELEGRAM_TOKEN: "tok-123", AUTODEV_TELEGRAM_CHAT: "chat-456" },
      telegramPost: async () => {
        throw new Error("network down");
      },
    });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.delivery).toBe("outbox");
    const outboxLines = appends.get(`${ESCALATIONS_DIR}/_outbox.md`);
    expect(outboxLines).toHaveLength(1);
  });

  it("5. writeFile throws -> does not throw, artifactWritten false, delivery still attempted", async () => {
    const { deps, appends } = makeFakes({
      env: {},
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.artifactWritten).toBe(false);
    expect(result.path).toBe(`${ESCALATIONS_DIR}/esc-1.md`);
    expect(result.delivery).toBe("outbox");
    const outboxLines = appends.get(`${ESCALATIONS_DIR}/_outbox.md`);
    expect(outboxLines).toHaveLength(1);
  });

  it("does not call telegramPost when only the token is set (chat missing)", async () => {
    const { deps, telegramCalls } = makeFakes({ env: { AUTODEV_TELEGRAM_TOKEN: "tok-123" } });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.delivery).toBe("outbox");
    expect(telegramCalls).toHaveLength(0);
  });

  it("falls back to outbox when telegramPost is not provided even if env vars are set", async () => {
    const { deps, appends } = makeFakes({
      env: { AUTODEV_TELEGRAM_TOKEN: "tok-123", AUTODEV_TELEGRAM_CHAT: "chat-456" },
      omitTelegramPost: true,
    });
    const input = makeInput();

    const result = await escalate(input, deps);

    expect(result.delivery).toBe("outbox");
    expect(appends.get(`${ESCALATIONS_DIR}/_outbox.md`)).toHaveLength(1);
  });
});
