import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FileWarning, Pencil, Plus, X } from "lucide-react";
import { useConfig, useProjects, useUpdateProjectConfig, useDetectedAgents } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { ApiError, type ProjectConfigForm, type ProjectConfigView, type DetectedAgent } from "@/lib/api";
import { cn } from "@/lib/utils";
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
  plannerAdapter: string;
  plannerModel: string;
  plannerEffort: string;
  /** Intent flag: planner participates in diffing only when true — true from
   *  the start when planner is already configured, or once the operator clicks
   *  "+ Configure planner". While false, `buildDiff` NEVER emits planner, so an
   *  unconfigured planner stays unset. */
  addPlanner: boolean;
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
    plannerAdapter: config.roles.planner?.adapter ?? "",
    plannerModel: config.roles.planner?.model ?? "",
    plannerEffort: config.roles.planner?.effort ?? "",
    addPlanner: config.roles.planner !== undefined,
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

  // planner is optional: only diffed once `addPlanner` intent is set (already
  // configured, or the operator clicked "+ Configure planner"). Same
  // `addIfChanged` convention as orchestrator/critic; `?? ""` for the absent
  // case makes fresh defaults (claude/sonnet) send while an unchanged planner
  // sends nothing. When `addPlanner` is false, planner never enters the diff.
  if (draft.addPlanner) {
    const planner: Record<string, string> = {};
    addIfChanged(planner, "adapter", draft.plannerAdapter, config.roles.planner?.adapter ?? "");
    addIfChanged(planner, "model", draft.plannerModel, config.roles.planner?.model ?? "");
    addIfChanged(planner, "effort", draft.plannerEffort, config.roles.planner?.effort ?? "");
    if (Object.keys(planner).length > 0) roles.planner = planner;
  }

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
  const detected = useDetectedAgents();
  // `null` = detection not (yet) usable — the dropdowns are an enhancement, so
  // any state short of a successful load falls back to the original free-text
  // fields rather than blocking or half-rendering a select.
  const detectedAgents = detected.isSuccess ? detected.data : null;

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
            detectedAgents={detectedAgents}
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
  detectedAgents,
}: {
  config: ProjectConfigView;
  projectPath?: string;
  editing: boolean;
  draft: EditDraft | null;
  onDraftChange: (patch: Partial<EditDraft>) => void;
  /** `null` = detection unavailable/not loaded — role rows fall back to plain
   *  text fields. Non-null = a successfully loaded catalog to build selects from. */
  detectedAgents: DetectedAgent[] | null;
}) {
  const { gate, allowedBranchPattern, stateDir, worktree, roles } = config;
  const editable = editing && draft;

  const supportedOptions = detectedAgents ? supportedAgentOptions(detectedAgents) : [];
  const orchestratorAgent = detectedAgents && draft ? findAgent(detectedAgents, draft.orchestratorAdapter) : undefined;
  const workerAgent = detectedAgents && draft ? findAgent(detectedAgents, draft.workerAdapter) : undefined;
  const criticAgent = detectedAgents && draft ? findAgent(detectedAgents, draft.criticAdapter) : undefined;
  const plannerAgent = detectedAgents && draft ? findAgent(detectedAgents, draft.plannerAdapter) : undefined;

  const heteroWarnings = config.heterogeneityWarnings;
  const hasHeteroWarning = heteroWarnings.length > 0;

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

      <SettingsSection title="Roles" className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Orchestrator — adapter · model · effort (effort hidden for a matched
              adapter with no effort concept). */}
          <RoleCard title="Orchestrator">
            {editable ? (
              <RoleFields
                adapter={draft.orchestratorAdapter}
                model={draft.orchestratorModel}
                effort={draft.orchestratorEffort}
                onAdapterChange={(v) => onDraftChange({ orchestratorAdapter: v })}
                onModelChange={(v) => onDraftChange({ orchestratorModel: v })}
                onEffortChange={(v) => onDraftChange({ orchestratorEffort: v })}
                detectedAgents={detectedAgents}
                agent={orchestratorAgent}
                supportedOptions={supportedOptions}
                effortOptional
              />
            ) : (
              <RoleReadValue
                value={roleLine(roles.orchestrator.adapter, roles.orchestrator.model, roles.orchestrator.effort)}
              />
            )}
          </RoleCard>

          {/* Worker — adapter · ladder (no single model, no effort). */}
          <RoleCard title="Worker">
            {editable ? (
              <>
                {detectedAgents ? (
                  <SelectOrCustomRow
                    label="Adapter"
                    value={draft.workerAdapter}
                    onChange={(v) => onDraftChange({ workerAdapter: v })}
                    options={supportedOptions}
                  />
                ) : (
                  <TextFieldRow
                    label="Adapter"
                    value={draft.workerAdapter}
                    onChange={(v) => onDraftChange({ workerAdapter: v })}
                  />
                )}
                <EditableList
                  items={draft.ladder}
                  onChange={(items) => onDraftChange({ ladder: items })}
                  placeholder="model name"
                  emptyError="ladder needs at least one model"
                  suggestions={workerAgent?.models?.map((m) => m.id)}
                />
              </>
            ) : (
              <>
                <RoleReadValue value={roles.worker.adapter} />
                <RoleReadValue value={roles.worker.ladder.join(" → ")} muted={roles.worker.ladder.length === 0} />
              </>
            )}
          </RoleCard>

          {/* Critic — adapter · model · effort. Header carries the heterogeneity
              badge when worker & critic share an adapter family. */}
          <RoleCard
            title="Critic"
            badge={hasHeteroWarning ? <HeterogeneityBadge /> : undefined}
          >
            {editable ? (
              <RoleFields
                adapter={draft.criticAdapter}
                model={draft.criticModel}
                effort={draft.criticEffort}
                onAdapterChange={(v) => onDraftChange({ criticAdapter: v })}
                onModelChange={(v) => onDraftChange({ criticModel: v })}
                onEffortChange={(v) => onDraftChange({ criticEffort: v })}
                detectedAgents={detectedAgents}
                agent={criticAgent}
                supportedOptions={supportedOptions}
              />
            ) : (
              <RoleReadValue value={roleLine(roles.critic.adapter, roles.critic.model, roles.critic.effort)} />
            )}
          </RoleCard>

          {/* Planner — OPTIONAL. Unset in read mode → dimmed "not set" card; unset
              in edit mode → "+ Configure planner" affordance; set → orchestrator-
              like fields. No remove path (clear-is-no-op backend convention). */}
          {editable ? (
            draft.addPlanner ? (
              <RoleCard title="Planner">
                <RoleFields
                  adapter={draft.plannerAdapter}
                  model={draft.plannerModel}
                  effort={draft.plannerEffort}
                  onAdapterChange={(v) => onDraftChange({ plannerAdapter: v })}
                  onModelChange={(v) => onDraftChange({ plannerModel: v })}
                  onEffortChange={(v) => onDraftChange({ plannerEffort: v })}
                  detectedAgents={detectedAgents}
                  agent={plannerAgent}
                  supportedOptions={supportedOptions}
                  effortOptional
                />
              </RoleCard>
            ) : (
              <RoleCard title="Planner" dimmed>
                <div className="flex flex-col items-start gap-2 py-1">
                  <span className="font-mono text-[11px] text-subtle">
                    not set · orchestrator handles planning
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      onDraftChange({
                        addPlanner: true,
                        plannerAdapter: "claude",
                        plannerModel: "sonnet",
                        plannerEffort: "",
                      })
                    }
                  >
                    <Plus className="size-3" />
                    Configure planner
                  </Button>
                </div>
              </RoleCard>
            )
          ) : roles.planner ? (
            <RoleCard title="Planner">
              <RoleReadValue value={roleLine(roles.planner.adapter, roles.planner.model, roles.planner.effort)} />
            </RoleCard>
          ) : (
            <RoleCard title="Planner" dimmed>
              <RoleReadValue value="not set · orchestrator handles planning" muted />
            </RoleCard>
          )}
        </div>

        {/* Server-computed heterogeneity warning(s) — rendered verbatim. */}
        {hasHeteroWarning && (
          <div className="flex flex-col gap-1 rounded-md border border-[color-mix(in_srgb,var(--color-uncertain)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-uncertain)_8%,transparent)] px-3 py-2">
            {heteroWarnings.map((w) => (
              <p key={w} className="font-mono text-[11px] leading-relaxed text-uncertain">
                {w}
              </p>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

/** One bordered role card in the role matrix: a header (role name + optional
 *  badge) over the role's editable/read body. `dimmed` softens an inactive
 *  (unset planner) card. Sits inside the "Roles" `SettingsSection`, so it uses a
 *  slightly raised surface to read as a distinct tile. */
function RoleCard({
  title,
  badge,
  dimmed,
  children,
}: {
  title: string;
  badge?: ReactNode;
  dimmed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-md border border-line bg-surface-2/40 px-3 py-2.5", dimmed && "opacity-70")}>
      <div className="mb-1.5 flex items-center gap-2 border-b border-line pb-1.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{title}</h3>
        {badge && <div className="ml-auto">{badge}</div>}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

/** The adapter · model · effort trio shared by orchestrator/critic/planner cards
 *  — reuses `SelectOrCustomRow` (with the `detectedAgents === null` fallback to
 *  `TextFieldRow`) exactly as the flat layout did, and hides the effort row for a
 *  matched adapter that declares no effort concept. `effortOptional` flags the
 *  roles whose effort is optional (orchestrator/planner → placeholder), vs the
 *  critic whose effort is required. */
function RoleFields({
  adapter,
  model,
  effort,
  onAdapterChange,
  onModelChange,
  onEffortChange,
  detectedAgents,
  agent,
  supportedOptions,
  effortOptional,
}: {
  adapter: string;
  model: string;
  effort: string;
  onAdapterChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
  detectedAgents: DetectedAgent[] | null;
  agent: DetectedAgent | undefined;
  supportedOptions: SelectOption[];
  effortOptional?: boolean;
}) {
  const showEffort = !(detectedAgents && hasNoEffortConcept(agent));
  return (
    <>
      {detectedAgents ? (
        <SelectOrCustomRow label="Adapter" value={adapter} onChange={onAdapterChange} options={supportedOptions} />
      ) : (
        <TextFieldRow label="Adapter" value={adapter} onChange={onAdapterChange} />
      )}
      {detectedAgents ? (
        <SelectOrCustomRow label="Model" value={model} onChange={onModelChange} options={modelOptionsFor(agent)} />
      ) : (
        <TextFieldRow label="Model" value={model} onChange={onModelChange} />
      )}
      {showEffort &&
        (detectedAgents ? (
          <SelectOrCustomRow
            label="Effort"
            value={effort}
            onChange={onEffortChange}
            options={effortOptionsFor(agent)}
            placeholder={effortOptional ? "optional" : undefined}
          />
        ) : (
          <TextFieldRow
            label="Effort"
            value={effort}
            onChange={onEffortChange}
            placeholder={effortOptional ? "optional" : undefined}
          />
        ))}
    </>
  );
}

/** Read-mode value line inside a role card: a right-aligned mono string, or a
 *  muted em-dash-style caption when `muted`/empty. */
function RoleReadValue({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <div
      className={cn(
        "min-w-0 break-words py-1 text-right font-mono text-[11px]",
        muted || value === "" ? "text-subtle" : "text-text",
      )}
    >
      {value === "" ? "—" : value}
    </div>
  );
}

/** Inline amber pill on the critic card header when worker & critic share an
 *  adapter family (server-flagged). Reuses the `uncertain` (amber/warn) verdict
 *  token — the same color-mix border idiom the escalation/needs-you UI uses —
 *  rather than a hardcoded hex. */
function HeterogeneityBadge() {
  return (
    <span
      className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-uncertain"
      style={{ borderColor: "color-mix(in srgb, var(--color-uncertain) 30%, transparent)" }}
    >
      ⚠ same family
    </span>
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

interface SelectOption {
  value: string;
  label: string;
}

/** id-in-catalog value the native `<select>` uses for its synthetic "Custom…"
 *  entry — never a real adapter/model/effort id, so it can't collide. */
const CUSTOM_OPTION = "__custom__";

/** `supported` catalog agents as adapter select options. */
function supportedAgentOptions(agents: DetectedAgent[]): SelectOption[] {
  return agents.filter((a) => a.supported).map((a) => ({ value: a.id, label: a.name }));
}

function findAgent(agents: DetectedAgent[], id: string): DetectedAgent | undefined {
  return agents.find((a) => a.id === id);
}

/** The selected adapter's static model catalog, or `[]` for an unmatched
 *  (custom) adapter — which just leaves the model field in free-text mode. */
function modelOptionsFor(agent: DetectedAgent | undefined): SelectOption[] {
  return (agent?.models ?? []).map((m) => ({ value: m.id, label: m.label ?? m.id }));
}

function effortOptionsFor(agent: DetectedAgent | undefined): SelectOption[] {
  return (agent?.efforts ?? []).map((e) => ({ value: e, label: e }));
}

/** True only when the adapter is a MATCHED catalog entry that explicitly
 *  declares no effort concept (e.g. claude — `efforts` absent). An unmatched
 *  (custom) adapter keeps the effort row, since we simply don't know whether
 *  it has one. */
function hasNoEffortConcept(agent: DetectedAgent | undefined): boolean {
  return agent !== undefined && (agent.efforts === undefined || agent.efforts.length === 0);
}

/**
 * A `<select>` styled like `TextFieldRow`, with a synthetic "Custom…" entry
 * that swaps in a free-text input in its place — the escape hatch for a
 * hand-set adapter/model/effort that isn't (yet) in the detected-agent
 * catalog (mirrors Open Design's `supportsCustomModel` idea). `value`/
 * `onChange` back BOTH modes directly — no separate "custom draft" field, so
 * the value always round-trips through the same `EditDraft` key regardless of
 * which control produced it.
 *
 * The select-vs-custom mode is decided ONCE at mount (from whether `value` is
 * already a known option, or whether there are no options at all) and from
 * then on is the user's to toggle via the select's "Custom…" entry or the
 * text mode's "list" button — this only remounts (and re-decides) when the
 * parent remounts it, i.e. when edit mode is (re-)entered.
 */
function SelectOrCustomRow({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
}) {
  const [custom, setCustom] = useState(() => options.length === 0 || !options.some((o) => o.value === value));

  if (custom) {
    return (
      <div className="flex items-center justify-between gap-6 py-1.5">
        <span className="shrink-0 text-[13px] text-muted">{label}</span>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-right font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"
          />
          {options.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setCustom(false)}>
              list
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-6 py-1.5">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === CUSTOM_OPTION) setCustom(true);
          else onChange(e.target.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-right font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={CUSTOM_OPTION}>Custom…</option>
      </select>
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
  suggestions,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  validate?: (value: string) => string | null;
  emptyError?: string;
  /** Optional model-id hints (e.g. the worker adapter's catalog) shown as
   *  clickable chips below the add-input — clicking one appends it directly
   *  (already-added ids are filtered out, so no dedup surprises; these are
   *  trusted catalog ids so `validate` doesn't apply, same as committed items
   *  from the server). Existing add/remove behavior is untouched when omitted. */
  suggestions?: string[];
}) {
  const [pending, setPending] = useState("");
  const trimmed = pending.trim();
  const validationError = trimmed.length > 0 ? (validate?.(trimmed) ?? null) : null;
  const canAdd = trimmed.length > 0 && !validationError && !items.includes(trimmed);
  const suggestionChips = (suggestions ?? []).filter((s) => !items.includes(s));

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
      {suggestionChips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
          {suggestionChips.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange([...items, s])}
              className="rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-[10px] text-subtle transition-colors hover:border-accent hover:text-accent"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
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
