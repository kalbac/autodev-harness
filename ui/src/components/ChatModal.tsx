import { useEffect, useRef, useState } from "react";
import { ArrowUp, CircleAlert } from "lucide-react";
import { api, ApiError, type ChatTaskSpecPreview } from "@/lib/api";
import { useChatCancel, useChatConfirm, useChatMessage, useChatStart } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/Feedback";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";

interface ChatMessage {
  role: "operator" | "assistant";
  text: string;
}

export interface ChatModalProps {
  projectId: string;
  open: boolean;
  /** The textarea contents at the moment "Launch run" was clicked — becomes
   *  the first operator turn. */
  initialIntent: string;
  /** Fires on ANY close path (cancel, Escape, backdrop click, or after a
   *  successful confirm). */
  onClose: () => void;
  /** Fires ONLY after a successful Confirm & Launch — distinct from `onClose`
   *  so the parent can arm its post-launch digest watch (the s32 toast fix)
   *  precisely on the path that actually enqueued a run, not on cancel. */
  onLaunched?: () => void;
}

/**
 * Pre-launch orchestrator chat — shadcn Dialog/ScrollArea/Badge composition,
 * no custom widgets. The textarea's "Launch run" no longer POSTs /orchestrate
 * directly: it opens this modal instead, and only a successful "Confirm &
 * Launch" here calls through to the same orchestrate path (via
 * `useChatConfirm` → `POST /chat/confirm`). Nothing is enqueued by opening,
 * typing, or cancelling.
 */
export function ChatModal({ projectId, open, initialIntent, onClose, onLaunched }: ChatModalProps) {
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [proposedSpecs, setProposedSpecs] = useState<ChatTaskSpecPreview[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const startedRef = useRef(false);
  // Monotonically incrementing identity for the opening `chatStart` attempt.
  // Each open (or reopen) captures the counter's value at the moment it
  // fires the request; `cancelChat()` and every fresh opening attempt bump
  // the counter, so a request's own `onSuccess` can tell — by comparing its
  // captured value against the live counter — whether it's still the
  // current attempt or a stale one from an already-closed (and possibly
  // already-reopened) cycle. This subsumes both a plain close-before-
  // resolve AND a close-then-reopen-before-resolve, which a single boolean
  // flag couldn't distinguish (a reopen would reset the flag before the
  // ORIGINAL request landed, wrongly treating its stale response as
  // legitimate).
  const startAttemptRef = useRef(0);

  const chatStart = useChatStart(projectId);
  const chatMessage = useChatMessage(projectId);
  const chatConfirm = useChatConfirm(projectId);
  const chatCancel = useChatCancel(projectId);

  // Reset all local state on close so the NEXT open (a fresh launch) starts
  // clean, regardless of how this one ended (cancel / confirm / Escape).
  useEffect(() => {
    if (open) return;
    startedRef.current = false;
    setSessionId(null);
    setTranscript([]);
    setProposedSpecs([]);
    setStreamingText("");
    setMessageInput("");
  }, [open]);

  // Kick off the session exactly once per open. The operator's typed intent
  // renders immediately as the first bubble — don't wait for the network —
  // and the orchestrator's reply is appended once `postChatStart` resolves.
  // No EventSource is attached yet at this point (there's no sessionId until
  // the response lands), so the FIRST turn's reply arrives only via this
  // response, never via the stream — that's the backend's intentional design
  // (Task 9's live verification), not a bug.
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    // Claim this attempt's identity. Anything that invalidates it — a close
    // (cancelChat) or a newer opening attempt — bumps the counter further,
    // so comparing against the live value in `onSuccess` below reliably
    // detects staleness regardless of how many close/reopen cycles happened
    // while this request was in flight.
    const myAttempt = ++startAttemptRef.current;
    setTranscript([{ role: "operator", text: initialIntent }]);
    chatStart.mutate(initialIntent, {
      onSuccess: (data) => {
        if (startAttemptRef.current !== myAttempt) {
          // A close and/or a newer start happened since THIS attempt began —
          // its local state (if any) was already reset, so don't resurrect
          // it. Best-effort cancel the session we just created instead of
          // leaving it live and orphaned server-side.
          chatCancel.mutate(data.sessionId);
          return;
        }
        setSessionId(data.sessionId);
        setTranscript((prev) => [...prev, { role: "assistant", text: data.reply }]);
        setProposedSpecs(data.proposedSpecs);
      },
    });
    // chatStart is a fresh useMutation object every render; only `open` /
    // `initialIntent` should ever re-arm this, and `startedRef` already
    // guards against re-entry within one open lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialIntent]);

  // Live token stream for every turn AFTER the first. Always torn down on
  // sessionId change, unmount, or modal close (sessionId resets to null then).
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(api.chatStreamUrl(projectId, sessionId));
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { type?: string; text?: string };
        if (parsed.type === "token" && typeof parsed.text === "string") {
          setStreamingText((prev) => prev + parsed.text);
        }
      } catch {
        /* malformed/unrecognized frame — postChatMessage's own resolved value is the fallback */
      }
    };
    return () => es.close();
  }, [projectId, sessionId]);

  const sendMessage = () => {
    const trimmed = messageInput.trim();
    if (!trimmed || !sessionId || chatMessage.isPending) return;
    setTranscript((prev) => [...prev, { role: "operator", text: trimmed }]);
    setMessageInput("");
    setStreamingText("");
    chatMessage.mutate(
      { sessionId, message: trimmed },
      {
        onSuccess: (data) => {
          // Swap the streaming buffer for the final turn in one state update —
          // avoids a flash of (streamed text) immediately followed by (same
          // text again) once the mutation itself resolves.
          setStreamingText("");
          setTranscript((prev) => [...prev, { role: "assistant", text: data.reply }]);
          setProposedSpecs(data.proposedSpecs);
        },
      },
    );
  };

  const confirmAndLaunch = () => {
    if (!sessionId) return;
    // The operator's OWN messages only — never the orchestrator's replies —
    // joined into the same shape a plain one-shot launch's intent takes.
    const finalIntent = transcript
      .filter((m) => m.role === "operator")
      .map((m) => m.text)
      .join("; ");
    chatConfirm.mutate(
      { sessionId, finalIntent },
      {
        onSuccess: () => {
          onLaunched?.();
          onClose();
        },
      },
    );
  };

  const cancelChat = () => {
    // Invalidate whatever start attempt is in flight for THIS open cycle —
    // unconditionally, regardless of whether sessionId is set yet — so a
    // late-arriving response (however it eventually resolves) is recognized
    // as stale by the opening effect's `onSuccess` check above.
    startAttemptRef.current += 1;
    // Best-effort — the modal closes regardless of whether this resolves.
    if (sessionId) {
      chatCancel.mutate(sessionId);
    }
    onClose();
  };

  const canSend = messageInput.trim().length > 0 && sessionId !== null && !chatMessage.isPending;
  const canConfirm = sessionId !== null && !chatConfirm.isPending && !chatMessage.isPending;
  const startConflict = chatStart.error instanceof ApiError && chatStart.error.status === 409;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) cancelChat();
      }}
    >
      <DialogContent className="flex max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Discuss before launching</DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-80 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex flex-col gap-3">
            {transcript.map((m, i) => (
              <ChatBubble key={i} role={m.role} text={m.text} />
            ))}
            {chatStart.isPending && <Spinner className="self-start" />}
            {streamingText && <ChatBubble role="assistant" text={streamingText} />}
            {chatMessage.isPending && !streamingText && <Spinner className="self-start" />}
          </div>
        </ScrollArea>

        {proposedSpecs.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
            <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Proposed plan — preview only
            </span>
            <div className="flex flex-wrap gap-1.5">
              {proposedSpecs.map((s) => (
                <Badge key={s.id} variant="outline" className="font-mono text-[11px] font-normal">
                  {s.title} <span className="text-muted-foreground">· {s.type}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {chatStart.isError && (
          <p className="flex items-center gap-1.5 text-xs text-broken">
            <CircleAlert className="size-3.5 shrink-0" />
            {startConflict
              ? "A chat is already open for this project — close it first."
              : `Could not start chat: ${(chatStart.error as Error).message}`}
          </p>
        )}
        {chatMessage.isError && (
          <p className="flex items-center gap-1.5 text-xs text-broken">
            <CircleAlert className="size-3.5 shrink-0" />
            Could not send: {(chatMessage.error as Error).message}
          </p>
        )}
        {chatConfirm.isError && (
          <p className="flex items-center gap-1.5 text-xs text-broken">
            <CircleAlert className="size-3.5 shrink-0" />
            Could not launch: {(chatConfirm.error as Error).message}
          </p>
        )}

        <div className="flex items-end gap-2">
          <Textarea
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendMessage();
            }}
            placeholder="Refine the intent, ask a question…"
            rows={2}
            className="resize-none bg-transparent"
          />
          <Button onClick={sendMessage} disabled={!canSend} variant="outline" size="icon">
            {chatMessage.isPending ? <Spinner /> : <ArrowUp className="size-4" />}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancelChat} disabled={chatCancel.isPending}>
            Cancel
          </Button>
          <Button onClick={confirmAndLaunch} disabled={!canConfirm} variant="primary">
            {chatConfirm.isPending ? <Spinner className="text-primary-foreground" /> : <ArrowUp className="size-4" />}
            Confirm &amp; Launch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatBubble({ role, text }: { role: ChatMessage["role"]; text: string }) {
  const isOperator = role === "operator";
  return (
    <div className={cn("flex", isOperator ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap break-words",
          isOperator
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-card text-foreground",
        )}
      >
        {text}
      </div>
    </div>
  );
}
