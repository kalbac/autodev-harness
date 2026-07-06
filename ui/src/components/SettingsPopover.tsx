import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link } from "@tanstack/react-router";

const THEME_SEGMENTS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/**
 * Footer gear popover: global settings, per-project settings (disabled off a
 * project), and the theme segmented control. Closes on outside-click,
 * Escape, or an item click.
 *
 * The real trigger (the gear icon) lives in `Sidebar.tsx`, outside this
 * component — it toggles `Sidebar`'s own `settingsOpen` state, which mounts
 * this component only while open. Base UI's `Popover` still needs a
 * `PopoverTrigger` to anchor the floating content to a point, so this
 * renders one invisible/zero-size at the same corner the old manually-
 * positioned panel used. It is never clicked (`open` is hardcoded `true` —
 * this component only exists while `Sidebar` wants it open); it's purely an
 * anchor. Known consequence of the split: Base UI's outside-press dismiss
 * treats a click on the REAL gear button as an outside press (it only
 * special-cases clicks on its own trigger/content), so re-clicking the gear
 * while open now closes-then-immediately-reopens via `Sidebar`'s toggle,
 * instead of cleanly toggling closed. Fixing that fully needs the gear
 * button itself wired as this popover's trigger, which is out of scope here.
 */
export function SettingsPopover({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string | null;
  projectName?: string;
  onClose: () => void;
}) {
  const [theme, setTheme] = useTheme();

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverTrigger
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none absolute right-2 top-0 h-0 w-0"
      />
      <PopoverContent side="top" align="end" className="w-56 gap-0 bg-muted p-1.5">
        <Link
          to="/settings"
          onClick={onClose}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-card"
        >
          Global settings
        </Link>

        {projectId ? (
          <Link
            to="/p/$projectId/settings"
            params={{ projectId }}
            onClick={onClose}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-card"
          >
            Project settings
            {projectName && (
              <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{projectName}</span>
            )}
          </Link>
        ) : (
          <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground">
            Project settings
          </div>
        )}

        <div className="my-1.5 mx-1 h-px bg-border" />

        <div className="flex gap-1 px-2 py-1.5">
          {THEME_SEGMENTS.map((seg) => {
            const on = theme === seg.value;
            return (
              <button
                key={seg.value}
                type="button"
                onClick={() => setTheme(seg.value)}
                className={cn(
                  "flex-1 rounded-md border px-0 py-1 text-center text-[11px] transition-colors",
                  on
                    ? "border-primary bg-card text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {seg.label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
