import { useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { FsDirEntry, ProjectSummary } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { useRegisterProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/Feedback";

/** Read-only default role chips (mockup `.rolegrid`). These are NOT submitted —
 *  the scaffold applies the schema defaults; roles are edited in project settings
 *  after registering. */
const DEFAULT_ROLES: ReadonlyArray<[string, string]> = [
  ["orchestrator", "claude · opus"],
  ["worker", "claude · sonnet-5"],
  ["critic", "codex · gpt-5.5 · high"],
];

const LABEL = "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-subtle";
const INPUT =
  "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text outline-none transition-colors focus:border-ring placeholder:text-subtle";
const HINT = "mt-1 text-[11px] text-subtle";

/**
 * Project register form (mockup Frame 2 `.form`). Seeded from the selected git
 * repo, it maps the visible fields into the scaffold `config` schema and POSTs
 * `/projects`. The file (`.autodev/config.yaml`) is the source of truth — the
 * registry only stores path + name; the backend self-skips scaffolding when the
 * repo already has a config, so we never special-case that here.
 */
export function RegisterForm({
  entry,
  onRegistered,
}: {
  entry: FsDirEntry;
  onRegistered: (project: ProjectSummary) => void;
}) {
  const [name, setName] = useState(entry.name);
  const [checkCommand, setCheckCommand] = useState("");
  const [provision, setProvision] = useState("");
  const [branchPattern, setBranchPattern] = useState("^autodev/");
  const [scaffold, setScaffold] = useState(true);

  const register = useRegisterProject();

  const submit = () => {
    if (register.isPending) return;
    const provisionArray = provision
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const config = {
      ...(checkCommand.trim() ? { gate: { checkCommand: checkCommand.trim() } } : {}),
      ...(provisionArray.length ? { worktree: { provision: provisionArray } } : {}),
      allowedBranchPattern: branchPattern.trim() || "^autodev/",
    };
    register.mutate(
      { path: entry.path, name: name.trim() || entry.name, scaffold, config },
      { onSuccess: onRegistered },
    );
  };

  return (
    <div className="w-full max-w-md shrink-0 overflow-auto p-4 sm:w-96">
      <h2 className="mb-1 font-sans text-base font-semibold text-text">Register project</h2>
      <p className="mb-3.5 break-all font-mono text-[11px] text-subtle">{entry.path} · git repo</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* Display name */}
        <div className="mb-3">
          <label htmlFor="rf-name" className={LABEL}>
            Display name
          </label>
          <input
            id="rf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
        </div>

        {/* Roles — read-only defaults, applied by the scaffold, not submitted. */}
        <div className="mb-3">
          <span className={LABEL}>Roles</span>
          <div className="grid grid-cols-[86px_1fr] items-center gap-1.5">
            {DEFAULT_ROLES.map(([role, model]) => (
              <span key={role} className="contents">
                <span className="font-mono text-[11px] text-muted-foreground">{role}</span>
                <span className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                  {model}
                </span>
              </span>
            ))}
          </div>
          <p className={HINT}>defaults — edit in project settings after registering</p>
        </div>

        {/* Gate check command */}
        <div className="mb-3">
          <label htmlFor="rf-gate" className={LABEL}>
            Gate check command
          </label>
          <input
            id="rf-gate"
            value={checkCommand}
            onChange={(e) => setCheckCommand(e.target.value)}
            placeholder="e.g. npm test"
            className={INPUT}
          />
          <p className={HINT}>the un-bypassable machine gate, runs in the task worktree</p>
        </div>

        {/* Worktree provision */}
        <div className="mb-3">
          <label htmlFor="rf-provision" className={LABEL}>
            Worktree provision
          </label>
          <input
            id="rf-provision"
            value={provision}
            onChange={(e) => setProvision(e.target.value)}
            placeholder="e.g. node_modules, vendor"
            className={INPUT}
          />
          <p className={HINT}>gitignored dep dirs linked into each worktree, comma-separated</p>
        </div>

        {/* Branch pattern */}
        <div className="mb-3">
          <label htmlFor="rf-branch" className={LABEL}>
            Branch pattern
          </label>
          <input
            id="rf-branch"
            value={branchPattern}
            onChange={(e) => setBranchPattern(e.target.value)}
            className={INPUT}
          />
        </div>

        {/* Scaffold */}
        <label className="my-3.5 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded border transition-colors",
              scaffold
                ? "border-primary bg-[color-mix(in_srgb,var(--primary)_25%,transparent)] text-primary"
                : "border-line-strong",
            )}
          >
            {scaffold && <Check className="size-3" />}
          </span>
          <input
            type="checkbox"
            checked={scaffold}
            onChange={(e) => setScaffold(e.target.checked)}
            className="sr-only"
          />
          <span>
            Scaffold <b className="font-medium text-text">.autodev/</b> (config.yaml, GOAL.md,
            INVARIANTS.md, queue/) and add it to{" "}
            <span className="font-mono text-subtle">.git/info/exclude</span>
          </span>
        </label>

        {register.isError && (
          <p className="mb-2 flex items-start gap-1.5 text-xs text-broken">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {register.error instanceof ApiError
              ? register.error.message
              : `Could not register: ${(register.error as Error).message}`}
          </p>
        )}

        <button
          type="submit"
          disabled={register.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {register.isPending && <Spinner className="text-primary-foreground" />}
          Register project
        </button>
      </form>
    </div>
  );
}
