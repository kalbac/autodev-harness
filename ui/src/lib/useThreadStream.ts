// A reusable SSE hook for one live orchestrator thread (s40), modeled directly on
// `useCiEvents` in queries.ts (itself modeled on the inline `EventSource` effect in
// `ChatModal.tsx` / `chatStreamUrl`). Unlike a query hook, this owns LOCAL component
// state (an accumulating entries array + a live-typing text buffer), not the query
// cache -- there is no server-side "get all events so far" endpoint to poll, only the
// stream itself, which replays persisted history on connect. Torn down and reset on
// every `projectId`/`threadId` change (including to empty, which just clears state).
//
// Frame shapes on the wire (see `ThreadEntry` in api.ts): a real, persisted entry
// (`operator_msg` | `orchestrator_msg` | `activity` | `plan` | `run_link`), OR a
// transient `{type:"token",text}` frame that is NOT a persisted entry -- it is the
// orchestrator's live-typing signal, accumulated separately and cleared once the
// finalized `orchestrator_msg` entry for that turn arrives.
import { useEffect, useState } from "react";
import { api, type ThreadEntry } from "./api";

export interface ThreadStreamState {
  entries: ThreadEntry[];
  streamingText: string;
}

export function useThreadStream(projectId: string | undefined, threadId: string | undefined): ThreadStreamState {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");

  useEffect(() => {
    setEntries([]);
    setStreamingText("");
    if (!projectId || !threadId) return;
    const es = new EventSource(api.threadStreamUrl(projectId, threadId));
    es.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame && frame.type === "token" && typeof frame.text === "string") {
          setStreamingText((s) => s + frame.text);
          return;
        }
        // A real, persisted entry: append; if it's the finalized orchestrator prose
        // for this turn, clear the live-typing buffer it supersedes.
        setEntries((list) => [...list, frame as ThreadEntry]);
        if (frame && frame.type === "orchestrator_msg") setStreamingText("");
      } catch {
        /* malformed frame -- ignore */
      }
    };
    return () => es.close();
  }, [projectId, threadId]);

  return { entries, streamingText };
}
