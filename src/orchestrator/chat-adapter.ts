import type { ReadSnapshot } from "./adapter.js";
import type { TaskSpec } from "./task-spec.js";

/** Opaque handle to one live chat session — callers never reach into it. */
export interface ChatSessionHandle {
  sessionId: string;
}

export interface ChatTurnResult {
  /** The orchestrator's full conversational reply for this turn. */
  reply: string;
  /**
   * Advisory-only preview of a task breakdown, when the model included one —
   * NEVER enqueued directly. On "Confirm & Launch" the real breakdown is
   * computed fresh via the existing `OrchestratorAdapter.decompose()`/
   * `handleIntent` path; this field exists purely so the UI can render a live
   * "proposed plan" panel during the conversation.
   */
  proposedSpecs?: TaskSpec[];
}

/**
 * A pre-enqueue conversational layer (adr/003-safe: has NO `enqueue`/
 * `trigger` access at all — those capabilities belong exclusively to the
 * existing `OrchestratorCapabilities`/`handleIntent` path). One
 * `OrchestratorChatAdapter` session backs exactly one chat modal instance,
 * for the operator's pre-launch conversation only (see
 * `docs/superpowers/specs/2026-07-08-orchestrator-chat-design.md`).
 */
export interface OrchestratorChatAdapter {
  startSession(input: {
    intent: string;
    state: ReadSnapshot;
    onToken: (text: string) => void;
  }): Promise<{ handle: ChatSessionHandle; turn: ChatTurnResult }>;
  send(handle: ChatSessionHandle, message: string): Promise<ChatTurnResult>;
  close(handle: ChatSessionHandle): Promise<void>;
}
