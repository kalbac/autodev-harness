import { useParams, useSearch } from "@tanstack/react-router";
import { useProjects, useThread, useThreadConfirm, useThreads } from "@/lib/queries";
import { useThreadStream } from "@/lib/useThreadStream";
import { useProjectId } from "@/lib/useProjectId";
import { toneVar, type Tone } from "@/lib/status";
import type { ThreadStatus } from "@/lib/api";
import { NewRunComposer } from "@/components/NewRunComposer";
import { ProjectTopBar } from "@/components/ProjectTopBar";
import { ThreadTranscript } from "@/components/ThreadTranscript";
import { Spinner } from "@/components/ui/Feedback";

/** Thread status → the inspector tone used to tint its badge. */
const STATUS_TONE: Record<ThreadStatus, Tone> = {
  chatting: "accent",
  running: "working",
  done: "clean",
  error: "broken",
};

/**
 * The project MAIN screen (s40): one live orchestrator thread rendered as a
 * transcript. Mounted by BOTH the project home route (`/p/:id`, via HomeView)
 * and the explicit thread route (`/p/:id/t/:threadId`), so it reads its
 * threadId loosely from params.
 *
 * TRANSCRIPT SOURCE is the SSE stream (`useThreadStream`): its connect replays
 * ALL persisted entries, then streams live — so it is the single source of
 * truth for the transcript and `useThread` is used ONLY for meta (title/status).
 *
 * When no threadId is in the URL (the home route) it streams the NEWEST thread;
 * with none, or when the "New thread" affordance passes `?compose=new`, it shows
 * the fresh-thread hero (greeting + start composer) instead of an empty
 * transcript.
 */
export function ThreadView() {
  const projectId = useProjectId() ?? "";
  const params = useParams({ strict: false }) as { threadId?: string };
  const search = useSearch({ strict: false }) as { compose?: string };

  const threads = useThreads(projectId);
  const projects = useProjects();
  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? projectId;

  const paramThreadId = params.threadId;
  const forceFresh = search.compose === "new";
  const newestThreadId = threads.data?.threads[0]?.id;
  // paramThreadId always wins; on the home route pick the newest thread unless a
  // fresh compose was explicitly requested.
  const effectiveThreadId = paramThreadId ?? (forceFresh ? undefined : newestThreadId);
  // On the home route (no paramThreadId, no explicit `?compose=new`), `newestThreadId`
  // is undefined until `useThreads` resolves -- without this, the fresh-thread hero
  // flashes for a frame before flipping to the newest thread once it loads.
  const resolvingNewestThread = !paramThreadId && !forceFresh && threads.isLoading;

  // Hooks run unconditionally (rules-of-hooks); an undefined/"" threadId just
  // yields empty/disabled results.
  const stream = useThreadStream(projectId, effectiveThreadId);
  const thread = useThread(projectId, effectiveThreadId ?? "");
  const confirm = useThreadConfirm(projectId, effectiveThreadId ?? "");

  const meta = thread.data?.meta;
  const title = meta?.title ?? "Thread";
  const status = meta?.status;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ProjectTopBar projectId={projectId} />

      {effectiveThreadId ? (
        <>
          {/* Thread sub-header — title + a small status badge. */}
          <div className="flex items-center gap-2 border-b border-border px-[18px] py-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground" title={title}>
              {title}
            </span>
            {status && <StatusBadge status={status} />}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <ThreadTranscript
              projectId={projectId}
              entries={stream.entries}
              streamingText={stream.streamingText}
              onLaunchPlan={() => confirm.mutate()}
              launching={confirm.isPending}
            />
          </div>

          <div className="border-t border-border p-3">
            <div className="mx-auto w-full max-w-3xl">
              <NewRunComposer mode="send" projectId={projectId} threadId={effectiveThreadId} />
            </div>
          </div>
        </>
      ) : resolvingNewestThread ? (
        // Still resolving whether this project has an existing thread to land on --
        // a neutral loading state, never the fresh hero (which would otherwise flash
        // before flipping to the newest thread once `useThreads` settles).
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="text-muted-foreground" />
        </div>
      ) : (
        // Fresh-thread state — orchestrator greeting + a start composer, never an
        // empty transcript.
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl px-6 pb-8 pt-14">
            <h1 className="mb-2 text-center font-sans text-[26px] font-semibold leading-tight text-foreground">
              What are we building in {projectName}?
            </h1>
            <p className="mx-auto mb-6 max-w-xl text-center text-sm text-muted-foreground">
              Describe an intent — the orchestrator decomposes it into gated tasks, an independent
              critic reviews every diff, and only clean work is committed.
            </p>
            <NewRunComposer mode="start" projectId={projectId} autoFocus />
          </div>
        </div>
      )}
    </div>
  );
}

/** A small pill tinting the thread's lifecycle state with the inspector tone. */
function StatusBadge({ status }: { status: ThreadStatus }) {
  const c = toneVar[STATUS_TONE[status]];
  return (
    <span
      className="shrink-0 rounded-md border px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em]"
      style={{
        color: c,
        borderColor: `color-mix(in srgb, ${c} 40%, transparent)`,
        background: `color-mix(in srgb, ${c} 8%, transparent)`,
      }}
    >
      {status}
    </span>
  );
}
