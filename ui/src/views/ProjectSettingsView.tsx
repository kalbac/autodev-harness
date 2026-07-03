import { Link } from "@tanstack/react-router";
import { ArrowLeft, FileWarning } from "lucide-react";
import { useConfig, useProjects } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { ApiError, type ProjectConfigView } from "@/lib/api";
import { Loading, EmptyState } from "@/components/ui/Feedback";
import { SettingsPage, SettingsSection, SettingsRow } from "@/components/SettingsLayout";

/**
 * Per-project settings (mockup `Project settings`): a READ-FIRST projection of
 * the project's `.autodev/config.yaml`, served curated (no secrets) by
 * `GET /projects/:id/config`. Editing stays file-based for now — a config-WRITE
 * endpoint is the natural next backend add if in-UI editing is wanted (noted at
 * the foot of the screen). Renders inside the project route; the rail predicate
 * excludes `/settings`, so this owns the whole main region.
 */
export function ProjectSettingsView() {
  const projectId = useProjectId() ?? "";
  const projects = useProjects();
  const config = useConfig(projectId);

  const project = projects.data?.projects.find((p) => p.id === projectId);
  const name = project?.name ?? projectId;

  const back = (
    <Link
      to="/p/$projectId"
      params={{ projectId }}
      className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-text"
    >
      <ArrowLeft className="size-3.5" />
      back
    </Link>
  );

  return (
    <SettingsPage title={name} subtitle="project settings" back={back}>
      {config.isLoading ? (
        <Loading label="Loading config…" />
      ) : config.isError ? (
        <ConfigUnavailable error={config.error} />
      ) : config.data ? (
        <ConfigSections config={config.data} projectPath={project?.path} />
      ) : null}

      <p className="px-1 text-[11px] leading-relaxed text-subtle">
        This is a read-only view. Edit{" "}
        <span className="font-mono text-muted">.autodev/config.yaml</span> in the repo to change these
        settings — a config-write endpoint is the natural next step for in-UI editing.
      </p>
    </SettingsPage>
  );
}

function ConfigSections({
  config,
  projectPath,
}: {
  config: ProjectConfigView;
  projectPath?: string;
}) {
  const { gate, allowedBranchPattern, stateDir, worktree, roles } = config;
  return (
    <>
      <SettingsSection title="Repository">
        <SettingsRow label="Path" value={projectPath} />
        <SettingsRow label="State dir" value={stateDir} />
        <SettingsRow label="Branch pattern" value={allowedBranchPattern} />
      </SettingsSection>

      <SettingsSection title="Gate">
        <SettingsRow label="Check command" value={gate.checkCommand} />
      </SettingsSection>

      <SettingsSection title="Worktree provisioning">
        {worktree.provision.length === 0 ? (
          <SettingsRow label="Provision" value={<span className="text-subtle">none</span>} />
        ) : (
          <div className="flex flex-wrap justify-end gap-1.5 py-1">
            {worktree.provision.map((entry) => (
              <span
                key={entry}
                className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text"
              >
                {entry}
              </span>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Roles">
        <SettingsRow
          label="Orchestrator"
          value={roleLine(roles.orchestrator.adapter, roles.orchestrator.model, roles.orchestrator.effort)}
        />
        <SettingsRow
          label="Worker"
          value={`${roles.worker.adapter} · ${roles.worker.ladder.join(" → ")}`}
        />
        <SettingsRow
          label="Critic"
          value={roleLine(roles.critic.adapter, roles.critic.model, roles.critic.effort)}
        />
      </SettingsSection>
    </>
  );
}

/** `adapter · model · effort` — effort omitted when unset. */
function roleLine(adapter: string, model: string, effort?: string): string {
  return [adapter, model, effort].filter(Boolean).join(" · ");
}

function ConfigUnavailable({ error }: { error: unknown }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <SettingsSection title="Config">
      <EmptyState
        icon={FileWarning}
        title={notFound ? "No config projection" : "Config unavailable"}
        description={
          notFound
            ? "This project has no curated config to display — it may predate the config endpoint."
            : error instanceof ApiError
              ? error.message
              : "Could not load the project config."
        }
      />
    </SettingsSection>
  );
}
