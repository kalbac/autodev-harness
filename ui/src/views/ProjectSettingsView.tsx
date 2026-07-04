import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FileWarning, Pencil, Plus, X } from "lucide-react";
import { useConfig, useProjects, useUpdateProjectConfig } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { ApiError, type ProjectConfigForm, type ProjectConfigView } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Loading, EmptyState, Spinner } from "@/components/ui/Feedback";
import { SettingsPage, SettingsSection, SettingsRow } from "@/components/SettingsLayout";

/** Local edit-draft shape — exactly the fields `PATCH /projects/:id/config`
 *  accepts. Seeded from `useConfig`'s data when edit mode is entered, diffed
 *  against that same data on Save so only actually-changed sections are sent. */
interface EditDraft {
  allowedBranchPattern: string;
  checkCommand: string;
  provision: string[];
  ladder: string[];
  orchestratorAdapter: string;
  orchestratorModel: string;
  orchestratorEffort: string;
  workerAdapter: string;
  criticAdapter: string;
  criticModel: string;
  criticEffort: string;
}

function draftFrom(config: ProjectConfigView): EditDraft {
  return {
    allowedBranchPattern: config.allowedBranchPattern,
    checkCommand: config.gate.checkCommand ?? "",
    provision: [...config.worktree.provision],
    ladder: [...config.roles.worker.ladder],
    orchestratorAdapter: config.roles.orchestrator.adapter,
    orchestratorModel: config.roles.orchestrator.model,
    orchestratorEffort: config.roles.orchestrator.effort ?? "",
    workerAdapter: config.roles.worker.adapter,
    criticAdapter: config.roles.critic.adapter,
    criticModel: config.roles.critic.model,
    criticEffort: config.roles.critic.effort,
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Sets `target[key]` only when the trimmed draft value is non-empty AND
 *  differs from the loaded config value — mirrors `gate.checkCommand`'s
 *  established convention (clearing a field client-side is a silent no-op,
 *  not an "unset" request), applied uniformly to every role adapter/model/
 *  effort text field. */
function addIfChanged(target: Record<string, string>, key: string, draftValue: string, currentValue: string): void {
  const trimmed = draftValue.trim();
  if (trimmed.length > 0 && trimmed !== currentValue) target[key] = trimmed;
}

/** Builds the PATCH body from only the fields the user actually changed vs.
 *  the loaded config — unchanged sections are omitted entirely so the backend
 *  never touches them. `gate.checkCommand` is included only when non-empty
 *  (the backend requires `min(1)`); clearing it client-side is a silent no-op,
 *  not an "unset" request. */
function buildDiff(config: ProjectConfigView, draft: EditDraft): ProjectConfigForm {
  const diff: ProjectConfigForm = {};
  if (draft.allowedBranchPattern !== config.allowedBranchPattern) {
    diff.allowedBranchPattern = draft.allowedBranchPattern;
  }
  const trimmedCheck = draft.checkCommand.trim();
  if (trimmedCheck.length > 0 && trimmedCheck !== (config.gate.checkCommand ?? "")) {
    diff.gate = { checkCommand: trimmedCheck };
  }
  if (!arraysEqual(draft.provision, config.worktree.provision)) {
    diff.worktree = { provision: draft.provision };
  }

  const roles: NonNullable<ProjectConfigForm["roles"]> = {};

  const orchestrator: Record<string, string> = {};
  addIfChanged(orchestrator, "adapter", draft.orchestratorAdapter, config.roles.orchestrator.adapter);
  addIfChanged(orchestrator, "model", draft.orchestratorModel, config.roles.orchestrator.model);
  addIfChanged(orchestrator, "effort", draft.orchestratorEffort, config.roles.orchestrator.effort ?? "");
  if (Object.keys(orchestrator).length > 0) roles.orchestrator = orchestrator;

  const worker: { adapter?: string; ladder?: string[] } = {};
  const trimmedWorkerAdapter = draft.workerAdapter.trim();
  if (trimmedWorkerAdapter.length > 0 && trimmedWorkerAdapter !== config.roles.worker.adapter) {
    worker.adapter = trimmedWorkerAdapter;
  }
  if (!arraysEqual(draft.ladder, config.roles.worker.ladder)) worker.ladder = draft.ladder;
  if (Object.keys(worker).length > 0) roles.worker = worker;

  const critic: Record<string, string> = {};
  addIfChanged(critic, "adapter", draft.criticAdapter, config.roles.critic.adapter);
  addIfChanged(critic, "model", draft.criticModel, config.roles.critic.model);
  addIfChanged(critic, "effort", draft.criticEffort, config.roles.critic.effort);
  if (Object.keys(critic).length > 0) roles.critic = critic;

  if (Object.keys(roles).length > 0) diff.roles = roles;

  return diff;
}

/** Mirrors the backend's `superRefine` on `worktree.provision` entries: one
 *  path segment, no separators, no `.`/`..`/empty. Cheap client-side guard —
 *  the backend still re-validates. */
function validateProvisionEntry(value: string): string | null {
  if (value === "" || value === "." || value === "..") return "invalid path segment";
  if (value.includes("/") || value.includes("\\")) return "single path segment only (no / or \\)";
  return null;
}

/**
 * Per-project settings (mockup `Project settings`): a projection of the
 * project's `.autodev/config.yaml`, served curated (no secrets) by
 * `GET /projects/:id/config`. The editable subset — branch pattern, gate check
 * command, worktree provisioning, worker ladder, and every role's
 * adapter/model/effort — can be changed in place via `PATCH /projects/:id/config`;
 * only path and state dir stay read-only (fixed at registration). Renders inside
 * the project route; the rail predicate excludes `/settings`, so this owns the
 * whole main region.
 */
export function ProjectSettingsView() {
  const projectId = useProjectId() ?? "";
  const projects = useProjects();
  const config = useConfig(projectId);
  const updateConfig = useUpdateProjectConfig(projectId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);

  const project = projects.data?.projects.find((p) => p.id === projectId);
  const name = project?.name ?? projectId;

  const startEditing = () => {
    if (!config.data) return;
    setDraft(draftFrom(config.data));
    setEditing(true);
  };
  const cancelEditing = () => {
    setEditing(false);
    setDraft(null);
    updateConfig.reset(); // drop a prior failed-save error so it can't re-surface on re-open
  };
  const patchDraft = (patch: Partial<EditDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const diff = config.data && draft ? buildDiff(config.data, draft) : {};
  const hasChanges = Object.keys(diff).length > 0;
  const ladderValid = draft ? draft.ladder.length > 0 : false;
  const canSave = hasChanges && ladderValid;

  const save = () => {
    if (!canSave) return;
    updateConfig.mutate(diff, {
      onSuccess: () => {
        setEditing(false);
        setDraft(null);
      },
    });
  };

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
        <>
          <div className="flex items-center justify-between gap-3 px-1">
            {editing && updateConfig.error && (
              <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-broken">
                {updateConfig.error instanceof ApiError ? updateConfig.error.message : "save failed"}
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {editing ? (
                updateConfig.isPending ? (
                  <Spinner />
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={cancelEditing}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" onClick={save} disabled={!canSave}>
                      Save
                    </Button>
                  </>
                )
              ) : (
                <Button size="sm" variant="ghost" onClick={startEditing}>
                  <Pencil className="size-3" />
                  Edit
                </Button>
              )}
            </div>
          </div>

          <ConfigSections
            config={config.data}
            projectPath={project?.path}
            editing={editing}
            draft={draft}
            onDraftChange={patchDraft}
          />
        </>
      ) : null}

      {!editing && (
        <p className="px-1 text-[11px] leading-relaxed text-subtle">
          Repository path and state directory are fixed at registration; only the fields above are
          editable here.
        </p>
      )}
    </SettingsPage>
  );
}

function ConfigSections({
  config,
  projectPath,
  editing,
  draft,
  onDraftChange,
}: {
  config: ProjectConfigView;
  projectPath?: string;
  editing: boolean;
  draft: EditDraft | null;
  onDraftChange: (patch: Partial<EditDraft>) => void;
}) {
  const { gate, allowedBranchPattern, stateDir, worktree, roles } = config;
  const editable = editing && draft;

  return (
    <>
      <SettingsSection title="Repository">
        <SettingsRow label="Path" value={projectPath} />
        <SettingsRow label="State dir" value={stateDir} />
        {editable ? (
          <TextFieldRow
            label="Branch pattern"
            value={draft.allowedBranchPattern}
            onChange={(v) => onDraftChange({ allowedBranchPattern: v })}
          />
        ) : (
          <SettingsRow label="Branch pattern" value={allowedBranchPattern} />
        )}
      </SettingsSection>

      <SettingsSection title="Gate">
        {editable ? (
          <TextFieldRow
            label="Check command"
            value={draft.checkCommand}
            onChange={(v) => onDraftChange({ checkCommand: v })}
            placeholder="e.g. npm test"
          />
        ) : (
          <SettingsRow label="Check command" value={gate.checkCommand} />
        )}
      </SettingsSection>

      <SettingsSection title="Worktree provisioning">
        {editable ? (
          <EditableList
            items={draft.provision}
            onChange={(items) => onDraftChange({ provision: items })}
            placeholder="path segment"
            validate={validateProvisionEntry}
          />
        ) : worktree.provision.length === 0 ? (
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
        {editable ? (
          <>
            <TextFieldRow
              label="Orchestrator adapter"
              value={draft.orchestratorAdapter}
              onChange={(v) => onDraftChange({ orchestratorAdapter: v })}
            />
            <TextFieldRow
              label="Orchestrator model"
              value={draft.orchestratorModel}
              onChange={(v) => onDraftChange({ orchestratorModel: v })}
            />
            <TextFieldRow
              label="Orchestrator effort"
              value={draft.orchestratorEffort}
              onChange={(v) => onDraftChange({ orchestratorEffort: v })}
              placeholder="optional"
            />
          </>
        ) : (
          <SettingsRow
            label="Orchestrator"
            value={roleLine(roles.orchestrator.adapter, roles.orchestrator.model, roles.orchestrator.effort)}
          />
        )}
        {editable ? (
          <TextFieldRow
            label="Worker adapter"
            value={draft.workerAdapter}
            onChange={(v) => onDraftChange({ workerAdapter: v })}
          />
        ) : (
          <SettingsRow label="Worker adapter" value={roles.worker.adapter} />
        )}
        {editable ? (
          <EditableList
            items={draft.ladder}
            onChange={(items) => onDraftChange({ ladder: items })}
            placeholder="model name"
            emptyError="ladder needs at least one model"
          />
        ) : (
          <SettingsRow label="Worker ladder" value={roles.worker.ladder.join(" → ")} />
        )}
        {editable ? (
          <>
            <TextFieldRow
              label="Critic adapter"
              value={draft.criticAdapter}
              onChange={(v) => onDraftChange({ criticAdapter: v })}
            />
            <TextFieldRow
              label="Critic model"
              value={draft.criticModel}
              onChange={(v) => onDraftChange({ criticModel: v })}
            />
            <TextFieldRow
              label="Critic effort"
              value={draft.criticEffort}
              onChange={(v) => onDraftChange({ criticEffort: v })}
            />
          </>
        ) : (
          <SettingsRow
            label="Critic"
            value={roleLine(roles.critic.adapter, roles.critic.model, roles.critic.effort)}
          />
        )}
      </SettingsSection>
    </>
  );
}

/** A single editable key/value line: muted label left, right-aligned mono
 *  input replacing the static value. Mirrors `SettingsRow`'s layout. */
function TextFieldRow({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-1.5">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-right font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"
      />
    </div>
  );
}

/** Editable list of single-value strings (`worktree.provision` /
 *  `roles.worker.ladder`): a chip per entry with a remove button, plus an
 *  add input+button. `validate` runs on the pending add-input only — already
 *  committed entries are trusted (they passed validation, or came from the
 *  server, on the way in). */
function EditableList({
  items,
  onChange,
  placeholder,
  validate,
  emptyError,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  validate?: (value: string) => string | null;
  emptyError?: string;
}) {
  const [pending, setPending] = useState("");
  const trimmed = pending.trim();
  const validationError = trimmed.length > 0 ? (validate?.(trimmed) ?? null) : null;
  const canAdd = trimmed.length > 0 && !validationError && !items.includes(trimmed);

  const add = () => {
    if (!canAdd) return;
    onChange([...items, trimmed]);
    setPending("");
  };
  const remove = (item: string) => onChange(items.filter((i) => i !== item));

  return (
    <div className="py-1">
      {items.length === 0 ? (
        <div className="flex justify-end py-0.5 font-mono text-[11px] text-subtle">none</div>
      ) : (
        <div className="flex flex-wrap justify-end gap-1.5">
          {items.map((item) => (
            <span
              key={item}
              className="flex items-center gap-1 rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text"
            >
              {item}
              <button
                type="button"
                onClick={() => remove(item)}
                aria-label={`Remove ${item}`}
                className="text-subtle transition-colors hover:text-broken"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <input
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="w-40 rounded-md border border-line-strong bg-surface px-2 py-1 text-right font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"
        />
        <Button size="sm" variant="ghost" onClick={add} disabled={!canAdd}>
          <Plus className="size-3" />
        </Button>
      </div>
      {validationError && (
        <div className="mt-1 text-right font-mono text-[11px] text-broken">{validationError}</div>
      )}
      {!validationError && items.length === 0 && emptyError && (
        <div className="mt-1 text-right font-mono text-[11px] text-broken">{emptyError}</div>
      )}
    </div>
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
