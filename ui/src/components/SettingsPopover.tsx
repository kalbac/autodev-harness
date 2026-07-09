import { Link } from "@tanstack/react-router";
import { ChevronsUpDown, Settings } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { toneVar } from "@/lib/status";
import type { ConnState } from "@/lib/store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";

const THEME_SEGMENTS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting",
  live: "daemon live",
  offline: "offline",
};
const CONN_TONE = { connecting: "uncertain", live: "clean", offline: "broken" } as const;

/**
 * The sidebar footer control — the native shadcn `NavUser` pattern: a
 * `SidebarMenuButton` that triggers a `DropdownMenu` (not a hand-rolled popover).
 * The button carries a live daemon-status Badge; the menu holds global/project
 * settings and the theme segmented control.
 *
 * Base UI's DropdownMenu owns open/close/dismiss. The settings entries are
 * `DropdownMenuItem`s (close-on-select, then navigate); the theme ToggleGroup
 * sits in a plain region inside the content so selecting a theme previews it
 * without dismissing the menu.
 */
export function SidebarSettingsMenu({
  projectId,
  projectName,
  conn,
}: {
  projectId: string | null;
  projectName?: string;
  conn: ConnState;
}) {
  const [theme, setTheme] = useTheme();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="aria-expanded:bg-sidebar-accent" />}
          >
            <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-foreground">
              <Settings className="size-4" />
            </div>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">Settings</span>
              <Badge
                variant="outline"
                className="mt-0.5 h-4 w-fit gap-1 border-border px-1.5 py-0 font-mono text-[10px] font-normal text-muted-foreground"
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: conn === "offline" ? toneVar.broken : toneVar[CONN_TONE[conn]] }}
                />
                {CONN_LABEL[conn]}
              </Badge>
            </div>
            <ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>

          <DropdownMenuContent side="right" align="end" sideOffset={4} className="min-w-56">
            <DropdownMenuItem render={<Link to="/settings" />}>Global settings</DropdownMenuItem>
            {projectId ? (
              <DropdownMenuItem
                render={<Link to="/p/$projectId/settings" params={{ projectId }} />}
              >
                Project settings
                {projectName && (
                  <span className="ml-auto truncate pl-2 font-mono text-[10px] text-muted-foreground">
                    {projectName}
                  </span>
                )}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>Project settings</DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            <div className="px-1 py-1">
              <div className="px-1.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Theme
              </div>
              <ToggleGroup
                value={[theme]}
                onValueChange={(values) => {
                  // Base UI ToggleGroup value is always string[]; ignore an empty
                  // re-click emission so the theme never blanks. This never closes
                  // the menu (it isn't a DropdownMenuItem), so themes preview live.
                  const next = values[0];
                  if (next) setTheme(next as Theme);
                }}
                spacing={1}
                className="w-full"
              >
                {THEME_SEGMENTS.map((seg) => (
                  <ToggleGroupItem
                    key={seg.value}
                    value={seg.value}
                    className="h-7 flex-1 rounded-md border border-border px-0 text-center text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:bg-muted aria-pressed:text-foreground"
                  >
                    {seg.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
