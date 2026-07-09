import { useState } from "react";
import { CircleAlert } from "lucide-react";
import type { FsDirEntry, ProjectSummary } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { useRegisterProject } from "@/lib/queries";
import { Spinner } from "./ui/Feedback";
import { Input } from "./ui/input";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "./ui/field";

/** Read-only default role chips (mockup `.rolegrid`). These are NOT submitted —
 *  the scaffold applies the schema defaults; roles are edited in project settings
 *  after registering. */
const DEFAULT_ROLES: ReadonlyArray<[string, string]> = [
  ["orchestrator", "claude · opus"],
  ["worker", "claude · sonnet-5"],
  ["critic", "codex · gpt-5.5 · high"],
];

const LABEL = "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground";
const INPUT_CLASS = "font-mono text-xs";
const HINT = "mt-1 text-[11px] text-muted-foreground";
// Field-slot overrides: the shadcn Field owns the label/description spacing
// (gap-1.5), so these drop the manual margins the standalone LABEL/HINT carry
// while keeping the mono micro-label + hint look.
const FIELD_LABEL = "font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground";
const FIELD_HINT = "text-[11px] text-muted-foreground";

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
      <h2 className="mb-1 font-sans text-base font-semibold text-foreground">Register project</h2>
      <p className="mb-3.5 break-all font-mono text-[11px] text-muted-foreground">{entry.path} · git repo</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* Display name */}
        <Field className="mb-3 gap-1.5">
          <FieldLabel htmlFor="rf-name" className={FIELD_LABEL}>
            Display name
          </FieldLabel>
          <Input
            id="rf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT_CLASS}
          />
        </Field>

        {/* Roles — read-only defaults, applied by the scaffold, not submitted. */}
        <div className="mb-3">
          <span className={LABEL}>Roles</span>
          <div className="grid grid-cols-[86px_1fr] items-center gap-1.5">
            {DEFAULT_ROLES.map(([role, model]) => (
              <span key={role} className="contents">
                <span className="font-mono text-[11px] text-muted-foreground">{role}</span>
                <span className="rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                  {model}
                </span>
              </span>
            ))}
          </div>
          <p className={HINT}>defaults — edit in project settings after registering</p>
        </div>

        {/* Gate check command */}
        <Field className="mb-3 gap-1.5">
          <FieldLabel htmlFor="rf-gate" className={FIELD_LABEL}>
            Gate check command
          </FieldLabel>
          <Input
            id="rf-gate"
            value={checkCommand}
            onChange={(e) => setCheckCommand(e.target.value)}
            placeholder="e.g. npm test"
            className={INPUT_CLASS}
          />
          <FieldDescription className={FIELD_HINT}>
            the un-bypassable machine gate, runs in the task worktree
          </FieldDescription>
        </Field>

        {/* Worktree provision */}
        <Field className="mb-3 gap-1.5">
          <FieldLabel htmlFor="rf-provision" className={FIELD_LABEL}>
            Worktree provision
          </FieldLabel>
          <Input
            id="rf-provision"
            value={provision}
            onChange={(e) => setProvision(e.target.value)}
            placeholder="e.g. node_modules, vendor"
            className={INPUT_CLASS}
          />
          <FieldDescription className={FIELD_HINT}>
            gitignored dep dirs linked into each worktree, comma-separated
          </FieldDescription>
        </Field>

        {/* Branch pattern */}
        <Field className="mb-3 gap-1.5">
          <FieldLabel htmlFor="rf-branch" className={FIELD_LABEL}>
            Branch pattern
          </FieldLabel>
          <Input
            id="rf-branch"
            value={branchPattern}
            onChange={(e) => setBranchPattern(e.target.value)}
            className={INPUT_CLASS}
          />
        </Field>

        {/* Scaffold — the Checkbox is wrapped BY the label so clicking anywhere
            (box OR text) toggles it. Base UI's Checkbox root is a span + hidden
            input, which a sibling `htmlFor` label would NOT reliably activate. */}
        <label className="my-3.5 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <Checkbox checked={scaffold} onCheckedChange={setScaffold} className="mt-0.5" />
          <span>
            Scaffold <b className="font-medium text-foreground">.autodev/</b> (config.yaml, GOAL.md,
            INVARIANTS.md, queue/) and add it to{" "}
            <span className="font-mono text-muted-foreground">.git/info/exclude</span>
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

        <Button
          type="submit"
          variant="primary"
          disabled={register.isPending}
          className="w-full rounded-lg py-2 font-semibold"
        >
          {register.isPending && <Spinner className="text-primary-foreground" />}
          Register project
        </Button>
      </form>
    </div>
  );
}
