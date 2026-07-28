import { ArrowLeft, FileWarning, ShieldQuestion, TriangleAlert } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useGuarantees, useProjects } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { ApiError, type ProjectGuaranteesView, type ProjectGuaranteesZone } from "@/lib/api";
import { Loading, EmptyState } from "@/components/ui/Feedback";
import { StatusPill } from "@/components/ui/StatusPill";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { SettingsPage, SettingsSection, SettingsRow } from "@/components/SettingsLayout";
import { ChipList } from "./ProjectSettingsView";

/**
 * The plain-language explanation screen for issue #138: "what will this harness
 * do to my code, and what will it refuse", read top-to-bottom as the story of
 * one change moving through the harness. Purely a read projection of
 * `GET /projects/:id/guarantees` — there is nothing to edit here, on purpose
 * (the settings screen already owns every writable field; this screen exists
 * ONLY to make the read-only/enforced parts legible to a human who never read
 * the source). Reuses the `SettingsPage`/`SettingsSection`/`SettingsRow` chrome
 * so it reads as a sibling of Project settings, not a bespoke page.
 */
export function GuaranteesView() {
  const projectId = useProjectId() ?? "";
  const projects = useProjects();
  const guarantees = useGuarantees(projectId);

  const project = projects.data?.projects.find((p) => p.id === projectId);
  const name = project?.name ?? projectId;

  const back = (
    <Link
      to="/p/$projectId"
      params={{ projectId }}
      className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      back
    </Link>
  );

  return (
    <SettingsPage title="What this project guarantees" subtitle={name} back={back}>
      {guarantees.isLoading ? (
        <Loading label="Loading guarantees…" />
      ) : guarantees.isError ? (
        <GuaranteesUnavailable error={guarantees.error} />
      ) : guarantees.data ? (
        <GuaranteesSections data={guarantees.data} />
      ) : null}
    </SettingsPage>
  );
}

function GuaranteesSections({ data }: { data: ProjectGuaranteesView }) {
  const { branchPattern, contract, checks, review, onFailure, autonomy } = data;
  const profile = checks.profile;

  return (
    <>
      {/* 1. Where the work happens */}
      <SettingsSection title="Where the work happens">
        <p className="text-[13px] leading-relaxed text-foreground">
          The agent works on a branch matching{" "}
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
            {branchPattern}
          </span>
          , inside an isolated git worktree — never in your working tree.
        </p>
      </SettingsSection>

      {/* 2. What it may not touch */}
      <SettingsSection title="What it may not touch">
        <p className="pb-2 text-[11px] leading-relaxed text-muted-foreground">
          A change to any path below is <strong>refused</strong>, not reviewed — the gate never even scores the diff.
        </p>

        {!contract.invariantsReadable && (
          <Alert variant="destructive" className="mb-2.5">
            <TriangleAlert />
            <AlertTitle>Contract zones are NOT being enforced</AlertTitle>
            <AlertDescription>
              The contract file at <span className="font-mono">{contract.invariantsFile}</span> could not be read or
              parsed. This is different from declaring zero zones — the harness has no idea what it is supposed to
              protect, and every value-protection guarantee below is currently inert.
            </AlertDescription>
          </Alert>
        )}

        <SettingsRow
          label="Invariants file"
          value={<span className="font-mono">{contract.invariantsFile}</span>}
        />
        <SettingsRow
          label="Protected paths"
          value={<ChipList items={contract.protectedPaths} empty="none declared beyond the invariants file" />}
        />
        <SettingsRow
          label="Constitution files"
          value={
            <ChipList
              items={contract.constitutionGlobs}
              empty="none — no additional constitution globs declared"
            />
          }
        />
        <SettingsRow
          label="Gate profile's protected paths"
          value={
            profile ? (
              <ChipList items={profile.protectedPaths} empty="none declared" />
            ) : (
              <span className="text-muted-foreground">no gate profile attached</span>
            )
          }
        />
      </SettingsSection>

      {/* 3. Protected values (contract zones) */}
      <SettingsSection title="Protected values (contract zones)" className="flex flex-col gap-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Beyond files, the harness protects specific <strong>values</strong> wherever they appear — a config key, a
          magic number, a security check. The file may still be edited freely; only the named value inside it may
          not change.
        </p>
        {!contract.invariantsReadable ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Contract zones could not be loaded — see the warning above.
          </p>
        ) : contract.zones.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            no contract zones declared — nothing is value-protected in this project
          </p>
        ) : (
          contract.zones.map((zone) => <ZoneCard key={zone.id} zone={zone} />)
        )}
      </SettingsSection>

      {/* 4. Checks that will actually run */}
      <SettingsSection title="Checks that will actually run">
        <p className="pb-2 text-[11px] leading-relaxed text-muted-foreground">
          This is what &quot;it passed&quot; actually means here.
        </p>

        {profile ? (
          <div className="flex flex-col gap-2 pb-2">
            <div className="font-mono text-[11px] text-muted-foreground">
              gate profile <span className="text-foreground">{profile.id}</span> · v{profile.version}
            </div>
            {profile.gates.map((g) => (
              <div key={g.id} className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-medium text-foreground">{g.id}</span>
                  <StatusPill tone="idle" label={g.filesGlob ? "changed files" : "whole project"} />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{g.run}</div>
                {g.filesGlob && (
                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    scoped to <span className="text-foreground">{g.filesGlob}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <SettingsRow label="Gate profile" value={<span className="text-muted-foreground">none attached</span>} />
        )}

        <SettingsRow label="Check command" value={checks.checkCommand ?? "none declared"} />

        <div className="flex items-center gap-2 py-1.5">
          <span className="text-[13px] text-muted-foreground">agent-ci</span>
          <StatusPill tone={checks.agentCi.enabled ? "clean" : "idle"} label={checks.agentCi.enabled ? "enabled" : "disabled"} />
        </div>
        {checks.agentCi.enabled && (
          <SettingsRow label="Workflows" value={<ChipList items={checks.agentCi.workflows} empty="none declared" />} />
        )}

        <SettingsRow
          label="Task commands"
          value={
            <ChipList
              items={checks.taskCommands}
              empty="none declared — a task may only use this project's own package.json scripts"
            />
          }
        />
        <SettingsRow
          label="Package scripts"
          value={
            checks.packageScripts === null ? (
              <span className="text-muted-foreground">could not read package.json</span>
            ) : (
              <ChipList items={checks.packageScripts} empty="no scripts declared in package.json" />
            )
          }
        />
      </SettingsSection>

      {/* 5. Who reviews it */}
      <SettingsSection title="Who reviews it">
        <SettingsRow
          label="Critic"
          value={[review.adapter, review.model, review.effort].filter(Boolean).join(" · ")}
        />
        <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
          {review.mandateNarrows
            ? "For a change that touches only the documentation paths you declared above, the critic's mandate narrows: an assertion it can't verify about code the change doesn't touch is reported as a note, not a blocker. Everything else is reviewed in full."
            : "The critic's mandate never narrows — every change is reviewed at full mandate, regardless of what it touches."}
        </p>
      </SettingsSection>

      {/* 6. If a check fails */}
      <SettingsSection title="If a check fails">
        <p className="text-[13px] leading-relaxed text-foreground">
          A failing check is retried up to <strong>{onFailure.maxAttempts}</strong> time
          {onFailure.maxAttempts === 1 ? "" : "s"}, then the task parks and waits for you.
        </p>
      </SettingsSection>

      {/* 7. Unattended runs */}
      <SettingsSection title="Unattended runs">
        <div className="flex items-center gap-2 py-1">
          <StatusPill
            tone={autonomy.overnightOptIn ? "clean" : "idle"}
            label={autonomy.overnightOptIn ? "opted in" : "not opted in"}
          />
        </div>
        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          {autonomy.overnightOptIn
            ? "This project may run unattended overnight."
            : "This project always waits for you, even overnight."}{" "}
          Either way, it also needs the global Overnight switch (sidebar) to be on — both must be true before an
          unattended run can happen.
        </p>
      </SettingsSection>
    </>
  );
}

/** One card per contract zone: the human `why` leads, then what it scopes
 *  (files) and what it protects (exact values / patterns) as mono chips. */
function ZoneCard({ zone }: { zone: ProjectGuaranteesZone }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 border-b border-border pb-1.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{zone.id}</h3>
        <div className="ml-auto">
          <StatusPill
            tone={zone.autoGuardable ? "clean" : "idle"}
            label={zone.autoGuardable ? "auto-guardable" : "manual only"}
          />
        </div>
      </div>
      <p className="pb-2 text-[13px] leading-relaxed text-foreground">{zone.why}</p>
      <SettingsRow label="Files" value={<ChipList items={zone.pathGlobs} empty="applies file-wide" />} />
      <SettingsRow label="Exact values" value={<ChipList items={zone.namedValues} empty="none" />} />
      <SettingsRow label="Patterns" value={<ChipList items={zone.namedPatterns} empty="none" />} />
    </div>
  );
}

function GuaranteesUnavailable({ error }: { error: unknown }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <SettingsSection title="Guarantees">
      <EmptyState
        icon={notFound ? ShieldQuestion : FileWarning}
        title={notFound ? "Not available yet" : "Guarantees unavailable"}
        description={
          notFound
            ? "This daemon doesn't have the guarantees endpoint yet — it will populate once the project is on a build that serves it."
            : error instanceof ApiError
              ? error.message
              : "Could not load this project's guarantees."
        }
      />
    </SettingsSection>
  );
}
