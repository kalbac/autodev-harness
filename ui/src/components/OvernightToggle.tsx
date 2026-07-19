import { Moon } from "lucide-react";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import { Switch } from "@/components/ui/switch";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

/**
 * Global operator-presence switch (ADR-004 tenet 5, spec 2026-07-19). Presence is
 * a property of the OPERATOR, not a project, so this is daemon-global — but
 * overnight autonomy runs on the AND of this and each project's own opt-in.
 *
 * The sub-line is the honesty mechanism, not decoration: flipping this on while
 * no project has opted in means nothing happens all night, and that state must be
 * visible HERE, on the screen where the operator clicked
 * ([ui/fire-and-forget-action-needs-feedback-at-point-of-action]).
 */
export function OvernightToggle() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { state } = useSidebar();

  const enabled = settings.data?.overnight.enabled ?? false;
  const optedIn = settings.data?.optedInProjects ?? 0;
  const total = settings.data?.totalProjects ?? 0;
  const armed = enabled && optedIn > 0;

  const detail = !settings.data
    ? "…"
    : !enabled
      ? "off · attended"
      : optedIn === 0
        ? "on · no project opted in"
        : `on · ${optedIn} of ${total} projects`;

  const toggle = () => update.mutate({ overnight: { enabled: !enabled } });

  // Collapsed icon rail: the switch has no room, so the whole row becomes one
  // icon button carrying the same state and the sub-line as its tooltip.
  if (state === "collapsed") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={`Overnight: ${detail}`}
            onClick={toggle}
            disabled={update.isPending}
            aria-label={`Overnight autonomy: ${detail}`}
          >
            <Moon
              className={
                armed
                  ? "size-4 text-primary"
                  : enabled
                    ? "size-4 text-uncertain"
                    : "size-4 text-muted-foreground"
              }
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Moon className={armed ? "size-4 shrink-0 text-primary" : "size-4 shrink-0 text-muted-foreground"} />
      <div className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-sm font-medium text-sidebar-foreground">Overnight</span>
        <span
          className={
            enabled && optedIn === 0
              ? "truncate font-mono text-[10px] text-uncertain"
              : "truncate font-mono text-[10px] text-muted-foreground"
          }
        >
          {detail}
        </span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
        disabled={update.isPending || settings.isError}
        aria-label="Overnight autonomy"
      />
    </div>
  );
}
