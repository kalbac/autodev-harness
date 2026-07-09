import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const THEME_SEGMENTS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/**
 * Footer gear popover: global settings, per-project settings (disabled off a
 * project), and the theme segmented control.
 *
 * The gear button IS the `PopoverTrigger`, so Base UI owns open/close/toggle
 * and dismiss (outside-press, Escape) entirely — clicking the gear cleanly
 * toggles the popover, with no manual open-state or outside-click wiring in
 * the sidebar. The Global/Project links close the popover on navigate; the
 * theme segment buttons deliberately leave it open so you can preview themes
 * without it dismissing.
 */
export function SettingsPopover({
  projectId,
  projectName,
}: {
  projectId: string | null;
  projectName?: string;
}) {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Settings"
        className="ml-auto rounded-md border border-border px-1.5 py-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <Settings className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 gap-0 bg-muted p-1.5">
        <Link
          to="/settings"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-card"
        >
          Global settings
        </Link>

        {projectId ? (
          <Link
            to="/p/$projectId/settings"
            params={{ projectId }}
            onClick={() => setOpen(false)}
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

        <Separator className="my-1.5" />

        <ToggleGroup
          value={[theme]}
          onValueChange={(values) => {
            // Base UI's ToggleGroup value is always string[] (even for single-select);
            // it can emit [] on re-click of the active item — ignore that, never blank
            // the theme. This handler intentionally never touches `open` — see the
            // component doc comment above for why the popover must stay open here.
            const next = values[0];
            if (next) setTheme(next as Theme);
          }}
          spacing={1}
          className="w-full px-2 py-1.5"
        >
          {THEME_SEGMENTS.map((seg) => (
            // Pressed styling is driven by the `aria-pressed:` variant (which Base UI's
            // Toggle sets natively) rather than a JS-computed ternary — this shares the
            // same modifier signature as the base `toggleVariants` pressed classes, so
            // twMerge dedupes them deterministically instead of racing on stylesheet order.
            <ToggleGroupItem
              key={seg.value}
              value={seg.value}
              className="h-auto flex-1 rounded-md border border-border px-0 py-1 text-center text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:bg-card aria-pressed:text-foreground"
            >
              {seg.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  );
}
