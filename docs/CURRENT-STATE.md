# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s51)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** (chat as the project's main
screen) is shipped; the **unattended-autonomy half** of `adr/004` is partly built (2 of
~5 slices). `main` is clean and synced -- s51 merged PR #82 (`ee0be38`), #83 (`4745a9a`) and #84 (`c1ff87e`), all CI 4/4.

**s51 shipped Profiles v1 — the qualification layer.** The harness proves the
*process*; a profile proves the *product*. A profile (`profiles/wordpress-woocommerce@1`)
is a named, versioned per-project-type proof pack living in the **harness** repo, so it
is worker-immutable by construction -- which is how `adr/006` **Phase 3** lands without
being a separate phase. It is an **oracle source, not a second judge**: its gates become
gate step 1d and its `protectedPaths` become the fifth source in `resolveOracleSet`, so
the entire Phase 1+2 protection is inherited unchanged. Six codex `gpt-5.6-luna` rounds;
all three live directions proven on `woodev-shipping-plugin-test`.

**s51 then closed the first of the two limitations that proof exposed: gate feedback
on RETRY.** A red gate used to tell the worker nothing -- the RETRY branch wrote no
artifact and every step discarded its tool output -- so the worker reproduced the same
diff until its budget ran out. Now each failing step's output is captured, bounded and
persisted as `gate-feedback.md`, and the next round's worker reads it. Live-proven: a
task that would have burned its whole budget converged in **one** retry (`c0fb8de`). Merged as PR #83 (`4745a9a`).

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | 🚧 partly built — see below |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 (s49) + Phase 2 (s50) + Phase 3 (s51, via Profiles) shipped |
| Profiles / Qualification Layer | ✅ v1 shipped (s51) -- 2 facets (`gates` + `protectedPaths`), WP/WC first |
| Gate feedback on RETRY | ✅ shipped (s51) -- the worker now sees WHY the gate rejected it |
| Line-scoped profile gates | ✅ shipped (s51, `c1ff87e`) -- `wordpress-woocommerce@2`; the worker owns the lines it wrote |

**Unattended-autonomy half (`adr/004`) — built vs remaining:**
- ✅ Slice 1 — overnight escalation supervisor (deterministic reason-routing, s45)
- ✅ Slice 2 — overnight presence toggle (global presence × per-project opt-in, s46)
- ⬜ Morning report (batch-narrate `.autodev/decision-journal.ndjson`, reuses the s40 narrator)
- ⬜ Per-project **north-star** concept doc (onboarding-created anti-drift anchor)
- ⬜ Mandatory anti-drift critic (intent vs cumulative diff)

## What s51 delivered (Profiles / WP-WC Qualification Layer v1)

- **A profile is an ORACLE SOURCE, not a second judge.** That was the load-bearing
  design call: because the profile *is* the oracle, the whole `adr/006` Phase 1+2
  protection is inherited for free. A parallel judge would have needed its own
  protection story, and a profile over an unprotected oracle is theater.
- **`src/profile/`** — a fail-closed loader. Unknown id, version mismatch, unknown key,
  id/directory disagreement, path traversal in the id, a whitespace install path, a
  ruleset the profile forgot to ship, an absolute path in a gate command, a profile
  directory that resolves outside the harness root: all throw at load. A profile that
  cannot be resolved exactly as pinned must stop the run, never degrade to "no profile"
  -- the degraded mode means gates the operator believes are running are not running,
  while a green verdict claims a qualification that never happened.
- **Gate step 1d**, mirroring `agentCi`'s step 1c. `GateVerdict` gains `profile_green`
  (deliberately its own field, never folded into `composer_green`, so a later Product
  Qualification Report assembles from already-separated data). Gates declare
  `redExitCodes`: exit 0 = pass, a declared code = worker-fixable RED -> RETRY, **any
  other non-zero = the tool could not do its job** -> throw -> the conductor escalates.
  Codes were MEASURED, not assumed (`composer validate` exits 3 with no manifest, 1 on a
  schema violation; PHPCS 1/2 are findings, 3 is a processing error).
- **The fifth oracle source.** A profile's `protectedPaths` go through the same
  `addLiteral`/`addGlob` helpers as `constitutionPaths`, inheriting Phase 2's
  fail-closed normalization verbatim.
- **`adr/006` Phase 3 landed here**, as predicted: the profile lives in the harness
  repo, which the worker's worktree never intersects, so it is worker-immutable by
  construction. s51 also made that claim *checked* rather than asserted -- a symlinked
  profile directory used to make the containment test vacuous (round-4 finding).
- **Gates are DIFF-SCOPED**, and this was found by measurement before shipping: the WPCS
  ruleset reports **7069** errors tree-wide and **8** on the file a task actually
  changed, so a whole-tree gate would be red on every run -- blocking everything while
  proving nothing about the diff. GOTCHAS 73 -> 75.
- **Six codex `gpt-5.6-luna` rounds**, the same convergence shape as Phase 1's four and
  Phase 2's six: R1 conflated RED with UNRUNNABLE; R2 found the fix still admitted
  `={profile}/...` ("ends with `=`" is not proof of a flag); R3 found `<dir>/../outside`
  still escaped and `<dir>-evil/x` passed as a bare path; R4 found the trust boundary
  asserted but never verified; R5 found an absolute path hiding after a *second* `=`.
  R6 found the R5 fix guarded only ONE side of the version comparison. Three findings
  were declined or downgraded with rationale verified against real code -- R6's own
  severity was cut after a test proved its exploit path unreachable.
- **All three live directions proven** on `woodev-shipping-plugin-test`:
  1. a new PHP file drew two genuine WPCS errors -> `profile_green:false`, `RETRY`;
  2. a docs task -> phpcs correctly **skipped** (logged), `profile_green:true`,
     **committed** (`35db1a4`);
  3. a task whose `file_set` held `phpcs.xml` -> `constitution` escalation naming the
     profile (`profile protectedPaths: phpcs.xml [fs-fingerprint]`), raised **before the
     critic** -- no `critic-verdict.json` written, no critic tokens spent.

## The thrust — Authority Model → Profiles (from the external review)

`wiki/architecture-review-external-2026-07.md` details it. The chain, order load-bearing:

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
```

- **Authority Model** — audited s48; formalized in `adr/006`; **Phase 1 shipped s49,
  Phase 2 shipped s50**. The prerequisite the profiles thrust depends on (a profile over
  an unprotected oracle is theater) is now materially satisfied; Phase 3 is not a
  separate step — it folds into Profiles (the profile and its protected-path declaration
  must themselves live at the trusted root).
- **Profiles / Qualification Layer** — **v1 shipped s51** (two facets: `gates` +
  `protectedPaths`; WP/WC first). Next in the chain: the **two reports** (Harness
  Execution vs Product Qualification), for which `profile_green` is already a separate
  verdict field. (The `adr/004` **north-star** doc still folds into this.)

## NEXT ACTIONS

- *(done s51)* **Line-scoped profile gates** -- shipped as `wordpress-woocommerce@2`.
  Findings are filtered to the lines the diff ADDED, so a compliant change to a legacy
  file commits green. A baseline file was rejected on principle (a baseline IS an oracle).
- *(done s51)* **Gate feedback on RETRY** -- shipped and live-proven; the gotcha is
  marked RESOLVED. Covers all three output-producing steps, not just profile gates.
- **CRLF vs WPCS on Windows.** WPCS demands `
`; a worker on Windows writes `

`, so
  every new PHP file draws an automatic line-ending error. A WP/WC profile needs either a
  normalization step or an explicit exclusion before it is usable on a Windows box.
- **Two reports** (Harness Execution vs Product Qualification) — the next link in the
  chain; `profile_green` is already separate, so this is assembly, not untangling.
- **Remaining `adr/004` slices** (each own brainstorm→spec→plan): morning report ·
  mandatory anti-drift · (north-star → folded into profiles).
- **Metrics / Evaluation Corpus** (decide if/when): autonomy-%, rework-cycles, first-pass
  gate-success, critic FP/FN. "Oracle-tamper attempts caught" is a real, measurable gate
  property, and "profile-gate first-pass rate" is now another.
- *(done s50)* Docs audit — next divisible-by-10 checkpoint: s60.
- **Carried:** agent-ci synthetic `GITHUB_REPO` · overloaded `blocked` EscalationType ·
  chat-runtime → TanStack AI + AG-UI (`FUTURE-BACKLOG`).

## Open questions

- *(closed s51)* **Per-FILE vs per-LINE gate scoping** → line-scoping shipped. File-level
  made the gate *meaningful* (7069 → 8); line-level made it *usable* (a legacy file with
  10 pre-existing violations now commits a compliant change).
- **PHPStan in a profile.** Deliberately not a v1 gate: useful WordPress analysis needs
  `szepeviktor/phpstan-wordpress`, whose `extension.neon` a profile-shipped config cannot
  portably reference (a neon `includes:` resolves relative to the neon file, which lives
  in the harness repo where no project `vendor/` exists). Measured: without it, a correct
  file draws 14 phantom "unknown class/function" findings. Needs a way for a profile to
  inject a project-resolved autoload/extension path.
- **The analyzer toolchain is project-controlled.** A profile's gates run
  `vendor/bin/phpcs`, and `vendor` comes from the project's own `composer.json`. Named
  residual, not closed: no mechanical rule separates "a project script" from "a project
  binary", so pretending a check closes it would be worse than naming it.
- **Oracle protection for `success_command`/`checkCommand` implementations** — they are
  commands, not declared paths, so Phase 2 protects them only when the operator lists
  them in `constitutionPaths`. Deriving a path set from a command string is not reliably
  decidable; is an explicit per-command path declaration worth the config surface?
- *(closed s51)* `adr/006` Phase 3 → landed inside Profiles, as predicted.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

- **s51** — Profiles / WP-WC Qualification Layer v1 + `adr/006` Phase 3 (`ee0be38`).
- **s50** — `adr/006` Phase 2: protected-oracle-path fence (`44aebd8`) + docs audit (`0a89a45`).
- **s49** — `adr/006` Phase 1: trusted-root oracle definitions (`cc0db6f`).
- **s48** — Authority Model audit + `adr/006` + `PRINCIPLES.md` #14/#15 (`c6c2343`).
- **s47** — docs consolidation + external review → the Profiles thrust (`7759346`).
- **s46** — overnight presence toggle, `adr/004` slice 2 (`680b9fa`).
- **s45** — overnight escalation supervisor, `adr/004` slice 1 (PR #76).
- **s44** — `gpt-5.6-luna` promoted as critic + reply-B poison fix.
- **s43** — reply-B cycle live-proven + `blocked` state (PR #74).
- **s42** — `adr/005` critic-is-a-correctness-gate (PR #73).
- **s41** — first real CI run on a real task, end-to-end DONE (`3609a2c`).

## Environment (verified s46)

- **Daemon:** `node dist/index.js serve` (:4319, daemon-global, serves `dist/ui`) or `node dist/index.js run` (headless, from the project dir). **Rebuild BOTH bundles** after backend changes (`npm run build` AND `npm run build:ui`).
- **Presence store:** `~/.autodev/settings.json` (`{overnight:{enabled}}`); `GET`/`PATCH /settings`. Per-project opt-in: `autonomy.overnight.enabled` in the project `.autodev/config.yaml`. Overnight runs on the AND, presence read fresh per trigger.
- **Test repo:** `woodev-shipping-plugin-test` (registry `~/.autodev/projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`). `.autodev` is git-excluded, so seeding never dirties the tree.
- **Critic:** codex via the `codex:codex-rescue` subagent — **pin `--model gpt-5.6-luna`**.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `adr/004` — live-orchestrator presence + post-review autonomy (the doctrine driving the remaining slices).
- `FUTURE-BACKLOG.md` — deferred features / tech debt.
