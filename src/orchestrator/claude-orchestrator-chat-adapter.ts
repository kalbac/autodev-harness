import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config/schema.js";
import { resolveOrchestratorExe } from "../config/roles.js";
import type { OrchestratorChatAdapter, ChatSessionHandle, ChatTurnResult } from "./chat-adapter.js";
import type { ReadSnapshot } from "./adapter.js";
import { buildChatOpeningPrompt } from "./chat-prompt.js";
import { extractJsonArray } from "./json-array-extract.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";
import { ClaudeChatProcess, type SpawnFn } from "./claude-chat-process.js";

export interface ClaudeOrchestratorChatAdapterDeps {
  cfg: HarnessConfig;
  repoRoot: string;
  spawnFn?: SpawnFn;
}

interface ClaudeChatSessionHandle extends ChatSessionHandle {
  proc: ClaudeChatProcess;
}

/** Best-effort, advisory-only: drop any element that fails `validateTaskSpec`
 *  rather than throwing — this is a chat PREVIEW, never enqueued directly, so
 *  a malformed preview element must never break the conversation. */
function extractProposedSpecs(replyText: string): TaskSpec[] | undefined {
  const elements = extractJsonArray(replyText);
  if (elements === null) return undefined;
  const specs: TaskSpec[] = [];
  for (const el of elements) {
    try {
      specs.push(validateTaskSpec(el));
    } catch {
      /* advisory preview only — a bad element is dropped, never thrown */
    }
  }
  return specs.length > 0 ? specs : undefined;
}

/** Builds a `ChatTurnResult` from a completed `proc.send()` outcome, omitting
 *  `proposedSpecs` entirely (rather than setting it to `undefined`) when there
 *  is no preview — required under this project's `exactOptionalPropertyTypes: true`.
 *
 *  Throws when `outcome.isError` is set: a terminal `result` event with
 *  `is_error: true` (auth failure, rate limit, CLI crash) is a genuine
 *  turn failure, not a conversational reply — it must never be surfaced to
 *  the UI as if the orchestrator had actually replied. */
function turnResultFrom(outcome: { replyText: string; isError: boolean }): ChatTurnResult {
  if (outcome.isError) {
    throw new Error(`chat turn failed: ${outcome.replyText}`);
  }
  const proposedSpecs = extractProposedSpecs(outcome.replyText);
  return proposedSpecs !== undefined ? { reply: outcome.replyText, proposedSpecs } : { reply: outcome.replyText };
}

/**
 * Live claude-backed chat adapter (adr/003-safe: see `chat-adapter.ts`'s doc
 * comment — no enqueue/trigger access whatsoever). Spawns with NO tools and
 * NO MCP (`--tools ""` / `--strict-mcp-config`), and with `--safe-mode` to
 * disable inherited hooks, plugins, CLAUDE.md, skills, and custom commands
 * (auth/model-selection/built-in-tools/permissions still work normally, so
 * the adapter's own auth path is unaffected) — the process itself can only
 * converse, a defense-in-depth mirror of the interface-level restriction, and
 * avoids the ambient-extension noise/cost `gotcha [agents/inherit-ambient-extensions]`
 * describes for a call that has no legitimate use for any of it.
 */
export class ClaudeOrchestratorChatAdapter implements OrchestratorChatAdapter {
  constructor(private readonly deps: ClaudeOrchestratorChatAdapterDeps) {}

  async startSession(input: {
    intent: string;
    state: ReadSnapshot;
    onToken: (text: string) => void;
  }): Promise<{ handle: ChatSessionHandle; turn: ChatTurnResult }> {
    const sessionId = randomUUID();
    const args = [
      "-p",
      "--model",
      this.deps.cfg.roles.orchestrator.model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--safe-mode",
      "--strict-mcp-config",
      "--tools",
      "",
      "--session-id",
      sessionId,
    ];
    const proc = new ClaudeChatProcess({
      exe: resolveOrchestratorExe(this.deps.cfg),
      cwd: this.deps.repoRoot,
      args,
      onToken: input.onToken,
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
    });
    const prompt = buildChatOpeningPrompt(input.intent, input.state);
    let turn: ChatTurnResult;
    try {
      const outcome = await proc.send(prompt);
      turn = turnResultFrom(outcome);
    } catch (err) {
      // The opening turn failed before any handle was ever returned to the
      // caller — without this, the underlying claude child process (which
      // only exits on close() or being killed) leaks, waiting on stdin
      // forever. Close it here, then re-throw the original error unchanged.
      proc.close();
      throw err;
    }
    const handle: ClaudeChatSessionHandle = { sessionId, proc };
    return { handle, turn };
  }

  async send(handle: ChatSessionHandle, message: string): Promise<ChatTurnResult> {
    const outcome = await (handle as ClaudeChatSessionHandle).proc.send(message);
    return turnResultFrom(outcome);
  }

  async close(handle: ChatSessionHandle): Promise<void> {
    (handle as ClaudeChatSessionHandle).proc.close();
  }
}
