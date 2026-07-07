import { useRuntimeFile } from "@/lib/queries";
import { DiffView } from "./DiffView";
import { Loading } from "./ui/Feedback";

/** Fetches one runtime file and renders it: diff coloring for `.patch`, plain
 *  mono for everything else. A truncated body (server `x-truncated`) is flagged. */
export function RuntimeFileView({
  projectId,
  taskId,
  name,
}: {
  projectId: string;
  taskId: string;
  name: string | null;
}) {
  const file = useRuntimeFile(projectId, taskId, name);

  if (name === null) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Select a file.</p>;
  }
  if (file.isLoading) return <Loading />;
  if (file.isError) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Could not read {name}.</p>;
  }

  const { text, truncated } = file.data!;

  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <p className="font-mono text-[10px] uppercase tracking-wide text-uncertain">
          truncated — file exceeds the read cap
        </p>
      )}
      {name.endsWith(".patch") ? (
        <DiffView patch={text} />
      ) : (
        <pre className="overflow-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
          {text || "(empty)"}
        </pre>
      )}
    </div>
  );
}
