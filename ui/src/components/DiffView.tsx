import { cn } from "@/lib/utils";

/** Minimal unified-diff renderer — colors +/- lines and dims hunk headers.
 *  Not a full parser; the daemon's diff.patch is standard `git diff` output. */
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split(/\r?\n/);
  if (patch.trim().length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-subtle">Empty diff.</p>;
  }

  return (
    <pre className="overflow-auto rounded-lg border border-line bg-panel/60 font-mono text-[11px] leading-relaxed">
      <code className="block min-w-max">
        {lines.map((l, i) => {
          const kind =
            l.startsWith("+++") || l.startsWith("---")
              ? "meta"
              : l.startsWith("@@")
                ? "hunk"
                : l.startsWith("+")
                  ? "add"
                  : l.startsWith("-")
                    ? "del"
                    : l.startsWith("diff ") || l.startsWith("index ")
                      ? "meta"
                      : "ctx";
          return (
            <div
              key={i}
              className={cn(
                "px-3 whitespace-pre",
                kind === "add" && "text-clean bg-[color-mix(in_srgb,var(--color-clean)_8%,transparent)]",
                kind === "del" && "text-broken bg-[color-mix(in_srgb,var(--color-broken)_8%,transparent)]",
                kind === "hunk" && "text-accent",
                kind === "meta" && "text-subtle",
                kind === "ctx" && "text-muted",
              )}
            >
              {l || " "}
            </div>
          );
        })}
      </code>
    </pre>
  );
}
