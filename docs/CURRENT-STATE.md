# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s53)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** is shipped; the
**unattended-autonomy half** of `adr/004` is nearly complete (the last slice is spec'd,
implementation next session). `main` is synced -- **s53 merged two tail items**:
the **CRLF-vs-WPCS papercut** (PR #114, `2a0b326`, CI 4/4) and the **Morning Report**
(PR #115, `d8badd4`, CI 4/4).

**s53 closed the operator's "tails" (items 2 and 3 of his plan), then spec'd the last
`adr/004` slice.** Two full brainstorm→spec→plan→subagent→codex-critic→live-proof→merge
cycles, plus a handed-off spec:

- **CRLF-vs-WPCS papercut (merged).** `src/normalize/eol.ts` rewrites `\r\n`→`\n` in a
  worker's changed files (after the fences, before the gate) per the target repo's
  `.gitattributes` (default LF), so a new PHP file written CRLF on Windows no longer trips
  the line-ending sniff. Live-proven: a worker's CRLF new file → normalization → phpcs
  green → DONE+commit `fb21553` with an LF committed file.
- **Morning Report (merged).** The third report type: narrate the overnight
  `decision-journal.ndjson` (auto-rework/park), reconciled against the live blackboard
  (Principle 11). `report morning [--since]` + `GET /projects/:id/morning-report`. Pure
  builder + tolerant parser + fail-closed narration (reuses the s40 narrator).
- **Mandatory Anti-Drift + North-Star (spec'd, impl next session).** Arm the existing
  (toothless) anti-drift critic: `intentSource` defaults to `.autodev/GOAL.md`; a DRIFT in
  **unattended** halts the overnight drain; an empty/stub north-star fails closed in
  unattended. Attended unchanged. Spec:
  `docs/superpowers/specs/2026-07-23-mandatory-anti-drift-north-star-design.md`.

**The recurring lesson, twice this session:** the `[ts/fail-closed]` gotcha (a best-effort
module must guard its OWN catch-block logger, or a throwing logger re-throws the fail-safe
path) fired in BOTH new modules and codex caught it both times — it and "validated one
string, used another" are this repo's two most-repeated defect shapes.

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
| Two reports (Execution + Qualification) | ✅ shipped s52 (PR #113, `4fc1e87`, CI 4/4) -- per-task evidence ledger + both reports; 4 critic rounds -> SAFE |
| CRLF-vs-WPCS-on-Windows papercut | ✅ shipped s53 (PR #114, `2a0b326`, CI 4/4) -- `src/normalize/eol.ts`, `.gitattributes`-governed CRLF→LF; live-proven `fb21553` |
| Morning Report (3rd report type) | ✅ shipped s53 (PR #115, `d8badd4`, CI 4/4) -- narrate the decision journal, Principle-11 reconciled |
| Mandatory anti-drift + north-star | 📝 spec'd s53 (impl next session, `feat/mandatory-anti-drift`) |

**Unattended-autonomy half (`adr/004`) — built vs remaining:**
- ✅ Slice 1 — overnight escalation supervisor (deterministic reason-routing, s45)
- ✅ Slice 2 — overnight presence toggle (global presence × per-project opt-in, s46)
- ✅ Morning report — narrate `.autodev/decision-journal.ndjson`, reconciled vs the live queue (s53, PR #115)
- 📝 Mandatory anti-drift + per-project **north-star** (`.autodev/GOAL.md`) — **spec'd s53, impl next session** (these two folded into one slice: the north-star IS the anti-drift intent anchor)

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
  `protectedPaths`; WP/WC first). Next in the chain — the **two reports** — is **built
  and live-proven in s52** (`feat/two-reports`), awaiting merge. (The `adr/004`
  **north-star** doc still folds into this.) After the reports land, the chain's last
  link is the **Evaluation Corpus**.

## NEXT ACTIONS

s53 closed the two "tail" items (CRLF papercut, morning report) and spec'd the last
`adr/004` slice. In priority order:

- **(NEXT SESSION, spec ready) Mandatory Anti-Drift + North-Star** — implement
  `docs/superpowers/specs/2026-07-23-mandatory-anti-drift-north-star-design.md` on
  `feat/mandatory-anti-drift`. Arm the toothless anti-drift critic (`intentSource`
  default → `.autodev/GOAL.md`, 4-part north-star stub + "unfilled" sentinel), add the
  conductor anti-drift POLICY (attended = escalate-task, unattended = halt-drain +
  require-north-star), wired by the overnight supervisor. All above the gate. This is the
  LAST unattended-autonomy slice of `adr/004`.
- **(then, priority) Evaluation Corpus** — the last link of the
  `architecture-review-external-2026-07.md` chain. Real tasks
  (feature/bugfix/migration/integration/security-WC-compat) with metrics. The reports now
  produce the raw material: first-pass gate rate, retries-to-convergence,
  escalations-by-type, proven-on-change vs debt.
- **PHPStan as a profile gate** — blocked on a portable way for a profile-shipped neon to
  reference an extension living in the project's `vendor`.
- **Carried:** agent-ci synthetic `GITHUB_REPO` · overloaded `blocked` EscalationType ·
  chat-runtime → TanStack AI + AG-UI · timing-sensitive tests flake under CPU load
  (`FUTURE-BACKLOG`).

## Open questions

- *(closed s51)* **Per-FILE vs per-LINE gate scoping** → line-scoping shipped. File-level
  made the gate *meaningful* (7069 → 8); line-level made it *usable* (a legacy file with
  10 pre-existing violations now commits a compliant change).
- **A profile gate's toolchain still comes from the project.** `vendor/bin/phpcs` is
  installed by the project's own `composer.json`, so a worker could in principle weaken
  the analyzer itself. Named residual, not closed: no mechanical rule separates "a project
  script" from "a project binary".
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

- **s53** — CRLF papercut merged (PR #114) + Morning Report merged (PR #115) + mandatory-anti-drift spec'd.
- **s52** — the two reports (Execution + Qualification) + evidence ledger (PR #113, `4fc1e87`).
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
