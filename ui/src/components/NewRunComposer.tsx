import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { useConfig, useCreateThread, useProjects, useThreadMessage } from "@/lib/queries";
import { useAppStore } from "@/lib/store";
import { ProjectSwitcherMenu } from "./ProjectSwitcherMenu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/Button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./ui/input-group";
import { Kbd, KbdGroup } from "./ui/kbd";

/**
 * The one write surface of the thread main screen. Two modes:
 *  - `start` — the fresh-thread hero composer: `submit()` creates a NEW thread
 *    (`POST /threads`) and navigates to `/t/:threadId`; the orchestrator then
 *    narrates asynchronously into that thread's transcript over SSE.
 *  - `send` — the in-thread footer composer: `submit()` posts one operator
 *    message into the current thread (`POST /threads/:id/message`); the reply
 *    streams back over the same SSE the transcript already listens to.
 *
 * A plan's actual launch is NOT triggered here — it happens through the plan
 * chip's Launch button (server-side `/confirm`, the same validated orchestrator
 * path the CLI uses). The old `ChatModal`-open behavior + digest-watch toast are
 * gone: in-thread narration now surfaces every outcome inline.
 */
export function NewRunComposer({
  mode,
  projectId = "",
  threadId,
  autoFocus = false,
}: {
  mode: "start" | "send";
  projectId?: string;
  threadId?: string;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const [intent, setIntent] = useState("");

  // "Re-run" seed from RunView: pre-fill the box once (start mode only — a
  // re-run always lands on a fresh start-composer), then clear the store so a
  // later manual edit / navigation doesn't get clobbered.
  const composerSeed = useAppStore((s) => s.composerSeed);
  const clearComposerSeed = useAppStore((s) => s.clearComposerSeed);
  useEffect(() => {
    if (mode === "start" && composerSeed !== null) {
      setIntent(composerSeed);
      clearComposerSeed();
    }
  }, [mode, composerSeed, clearComposerSeed]);

  const projects = useProjects();
  const config = useConfig(projectId);
  const createThread = useCreateThread(projectId);
  const sendMessage = useThreadMessage(projectId, threadId ?? "");

  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  const cfg = config.data;
  const workerModel = cfg?.roles.worker.ladder[0] ?? "—";
  const criticModel = cfg ? `${cfg.roles.critic.model} · ${cfg.roles.critic.effort}` : "—";

  const trimmed = intent.trim();
  const busy = createThread.isPending || sendMessage.isPending;
  const canSubmit = trimmed.length > 0 && !busy && projectId !== "" && (mode === "start" || Boolean(threadId));

  const submit = () => {
    if (!canSubmit) return;
    if (mode === "start") {
      createThread.mutate(trimmed, {
        onSuccess: ({ threadId: newId }) => {
          void navigate({ to: "/p/$projectId/t/$threadId", params: { projectId, threadId: newId } });
        },
      });
    } else {
      sendMessage.mutate(trimmed);
    }
    setIntent("");
  };

  const isStart = mode === "start";

  return (
    <div className="flex flex-col gap-2">
      <InputGroup className="rounded-xl border-border bg-card focus-within:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupTextarea
          autoFocus={autoFocus}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder={
            isStart
              ? "Describe a change to make — the orchestrator decomposes it into gated tasks…"
              : "Reply to the orchestrator…"
          }
          rows={isStart ? 3 : 2}
          className="px-4 pt-3.5 text-sm outline-none"
        />
        <InputGroupAddon align="block-end" className="flex-wrap px-3 pb-3 pt-0">
          {/* The project + role chips are hero chrome — only shown on the fresh
              start composer, not in the compact in-thread footer. */}
          {isStart && (
            <>
              <ProjectSwitcherMenu projectId={projectId} projectName={projectName} />
              <Badge
                variant="outline"
                render={<Link to="/p/$projectId/settings" params={{ projectId }} />}
                className="h-auto gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[11px] font-normal text-muted-foreground"
              >
                worker <b className="font-medium text-foreground">{workerModel}</b>
              </Badge>
              <Badge
                variant="outline"
                render={<Link to="/p/$projectId/settings" params={{ projectId }} />}
                className="h-auto gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[11px] font-normal text-muted-foreground"
              >
                critic <b className="font-medium text-foreground">{criticModel}</b>
              </Badge>
            </>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>⏎</Kbd>
            </KbdGroup>
            {isStart ? "to launch" : "to send"}
          </span>
          <Button onClick={submit} disabled={!canSubmit} variant="primary">
            <ArrowUp className="size-4" />
            {isStart ? "Start" : "Send"}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
