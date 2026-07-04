import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FolderGit2, Pencil, Plus } from "lucide-react";
import { useProjects, useDeleteProject, useRenameProject } from "@/lib/queries";
import { useAppStore, type ConnState } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { ApiError, type ProjectSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dot } from "@/components/ui/Dot";
import { Button } from "@/components/ui/Button";
import { Spinner, EmptyState } from "@/components/ui/Feedback";
import { SettingsPage, SettingsSection, SettingsRow } from "@/components/SettingsLayout";

const THEME_SEGMENTS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting",
  live: "connected",
  offline: "offline",
};
const CONN_TONE = { connecting: "uncertain", live: "clean", offline: "broken" } as const;

/**
 * Daemon-global settings (mockup `Global settings`): appearance, the project
 * registry (register / unregister — the daemon's single source of truth), and
 * daemon connection info. Full-main screen inside AppShell; the rail predicate
 * excludes `/settings`, so this owns the whole main region.
 */
export function GlobalSettingsView() {
  const projects = useProjects();
  const [theme, setTheme] = useTheme();
  const conn = useAppStore((s) => s.conn);

  const list = projects.data?.projects ?? [];

  return (
    <SettingsPage
      title="Settings"
      subtitle="daemon-wide"
      back={
        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-text"
        >
          <ArrowLeft className="size-3.5" />
          back
        </Link>
      }
    >
      {/* Appearance */}
      <SettingsSection title="Appearance">
        <div className="flex items-center justify-between gap-6 py-1">
          <div>
            <div className="text-[13px] text-text">Theme</div>
            <div className="text-[11px] text-muted">Applies instantly and is remembered on this device.</div>
          </div>
          <div className="flex gap-1">
            {THEME_SEGMENTS.map((seg) => {
              const on = theme === seg.value;
              return (
                <button
                  key={seg.value}
                  type="button"
                  onClick={() => setTheme(seg.value)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-[12px] transition-colors",
                    on
                      ? "border-accent bg-surface-2 text-text"
                      : "border-line text-muted hover:text-text",
                  )}
                >
                  {seg.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      {/* Registry */}
      <SettingsSection
        title="Projects"
        aside={
          <Link
            to="/new"
            className="flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 px-2 py-1 font-mono text-[11px] text-text transition-colors hover:border-line-strong"
          >
            <Plus className="size-3 text-accent" />
            New
          </Link>
        }
        className="p-0"
      >
        {projects.isError ? (
          <p className="px-4 py-6 text-sm text-broken">daemon unreachable</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title="No projects registered"
            description="Register a git repository and the daemon will orchestrate it."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <RegistryRow key={p.id} project={p} />
            ))}
          </ul>
        )}
      </SettingsSection>

      {/* Daemon */}
      <SettingsSection title="Daemon">
        <SettingsRow
          label="Connection"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Dot tone={CONN_TONE[conn]} pulse={conn === "connecting"} />
              {CONN_LABEL[conn]}
            </span>
          }
        />
        <SettingsRow label="Host" value={window.location.host} />
        <SettingsRow label="Registered projects" value={String(list.length)} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** One registry row with an inline rename and a two-step (click → confirm)
 *  unregister. Both edit the registry entry only — never the folder on disk;
 *  rename touches the display `name`, and `id`/`path` stay immutable. */
function RegistryRow({ project }: { project: ProjectSummary }) {
  const del = useDeleteProject();
  const rename = useRenameProject();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const isError = project.status === "error";

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== project.name && trimmed.length <= 200;

  const startEditing = () => {
    setDraft(project.name);
    setEditing(true);
  };
  const cancelEditing = () => {
    setEditing(false);
    rename.reset(); // drop a prior failed-rename error so it can't re-surface on re-open
  };
  const save = () => {
    if (!canSave) return;
    rename.mutate({ id: project.id, name: trimmed }, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                else if (e.key === "Escape") cancelEditing();
              }}
              className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-text outline-none transition-colors focus:border-accent"
            />
          ) : (
            <span className="truncate text-[13px] font-semibold text-text">{project.name}</span>
          )}
          {isError && (
            <span className="shrink-0 rounded border border-[color-mix(in_srgb,var(--color-broken)_35%,transparent)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-broken">
              error
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-subtle">{project.path}</div>
        {del.error && confirming && (
          <div className="mt-1 font-mono text-[11px] text-broken">
            {del.error instanceof ApiError ? del.error.message : "unregister failed"}
          </div>
        )}
        {rename.error && editing && (
          <div className="mt-1 font-mono text-[11px] text-broken">
            {rename.error instanceof ApiError ? rename.error.message : "rename failed"}
          </div>
        )}
      </div>

      {editing ? (
        rename.isPending ? (
          <Spinner />
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={cancelEditing}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save} disabled={!canSave}>
              Save
            </Button>
          </div>
        )
      ) : del.isPending && del.variables === project.id ? (
        <Spinner />
      ) : confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted">unregister?</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              del.reset(); // drop a prior failed-delete error so it can't re-surface on re-open
            }}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              del.mutate(project.id, { onSuccess: () => setConfirming(false) })
            }
            disabled={del.isPending}
            className="border-[color-mix(in_srgb,var(--color-broken)_45%,transparent)] text-broken hover:border-broken"
          >
            Unregister
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={startEditing}>
            <Pencil className="size-3" />
            Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Unregister
          </Button>
        </div>
      )}
    </li>
  );
}
