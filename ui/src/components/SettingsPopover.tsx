import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/lib/theme";

const THEME_SEGMENTS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/**
 * Footer gear popover: global settings, per-project settings (disabled off a
 * project), and the theme segmented control. Closes on outside-click or item
 * click.
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-11 right-2 z-20 w-56 rounded-[10px] border border-line-strong bg-surface-2 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
    >
      <Link
        to="/settings"
        onClick={onClose}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text transition-colors hover:bg-surface"
      >
        Global settings
      </Link>

      {projectId ? (
        <Link
          to="/p/$projectId/settings"
          params={{ projectId }}
          onClick={onClose}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text transition-colors hover:bg-surface"
        >
          Project settings
          {projectName && (
            <span className="ml-auto truncate font-mono text-[10px] text-subtle">{projectName}</span>
          )}
        </Link>
      ) : (
        <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-subtle">
          Project settings
        </div>
      )}

      <div className="my-1.5 mx-1 h-px bg-line" />

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
                  ? "border-primary bg-surface text-text"
                  : "border-line text-muted-foreground hover:text-text",
              )}
            >
              {seg.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
