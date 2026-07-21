# Profiles / WP-WC Qualification Layer — design (v1)

> **Status:** approved by the operator 2026-07-22 (s51), section by section.
> **Thrust:** `Authority Model → Profiles → two reports → Evaluation Corpus`
> (`wiki/architecture-review-external-2026-07.md` risk 7). The Authority-Model
> prerequisite is satisfied: `adr/006` Phase 1 (s49) + Phase 2 (s50) shipped.
> **Principle anchor:** #15 — the gate proves only *formalized* properties, so the
> harness grows by formalizing more, not by a smarter model. A profile is a
> reusable bundle of formalizations for one project type.

## The one-line thesis

**The harness proves the *process*; a profile proves the *product*.** A profile is
a named, versioned, per-project-type proof pack. `gate.agentCi` and the machine
gate are the substrate; a profile productizes them for a project type (WordPress /
WooCommerce first).

## Decisions taken (and what each closes)

| # | Fork | Decision | Why |
|---|---|---|---|
| 1 | First consumer | The test polygon `woodev-shipping-plugin-test` — profile as a *provable mechanism*, WP/WC as its first instance, gate set minimal but honest | Real commercial plugins would drag the whole WP/WC quality contour into a v1 that has not yet proven the mechanism |
| 2 | What a profile *is* mechanically | **An oracle source**, not a second judge — it expands into the gate machinery that already exists. Catalog shape and report separation are laid out so a later Product-Qualification stage can be added without rework | Phase 1/2 oracle protection is inherited **for free** only if the profile *is* the oracle. A parallel judge would need its own protection story |
| 3 | Where it lives | `profiles/<id>/` **inside the harness repo**, resolved from the install root | Trust by construction (the worker's worktree is the *target* repo, never the harness's). Reuse is the definition of a profile. Version/review/history come free from the harness's own git + gate |
| 4 | Which facets ship | **`gates/` + `protectedPaths` only** | Those are the only two facets that are *mechanically* provable. `critic-rubrics/` and `north-star/` are LLM judgement — shipping them first would build theater on an honest foundation |
| 5 | Profile vs project config | **Union only, no selective disable** | A profile is a named proof pack; one with two gates plucked out is not that profile, and "qualified by `wordpress-woocommerce@1`" would become a lie. Escape hatch stays blunt and honest: don't attach the profile |
| 6 | v1 gate content | **Static pack with provisioning**: `composer validate` + PHPCS/WPCS + PHPStan | The maximum that is actually executable on the Windows polygon, and the exact combination `gotchas/vendor-junction-composer-autoload-basedir.md` already proves works over a junctioned `vendor`. PHPUnit/wp-env/Plugin Check need Docker → they would escalate infra on every run, i.e. theater |

## 1. Binding and resolution

One new config field:

```yaml
profile: "wordpress-woocommerce@1"   # default: null
```

`null` = the feature is **fully inert**; behaviour is byte-identical to today. This
mirrors `gate.checkCommand` (`null` = no-op) and `gate.agentCi.enabled` (off by
default): no existing project changes behaviour merely because the profile code
exists.

Resolution is from the harness install root: `<harnessRoot>/profiles/<id>/profile.yaml`,
and the `version` inside the file MUST equal the pinned version. An unknown id, an
unreadable file, or a version mismatch **throws at run start** — never a silent
skip (Principle 10; identical to Phase 1's fail-closed contract for
`contract.*File`).

**Known trap, designed against explicitly.** `gotchas/critic-schema-json-not-copied-to-dist.md`:
`critic-verdict.schema.json` is not copied to `dist/` by `tsc`, so its path breaks
from a compiled build while working from source. `profiles/**` is data, not TS, and
falls in exactly the same hole. Therefore the work includes (a) a build step that
copies `profiles/` into `dist/`, and (b) **a test that resolves a profile through
the dist path**, not only from source. Without (b) the feature is green in tests
and dead in the running daemon.

## 2. Profile format

`profiles/wordpress-woocommerce/profile.yaml`:

```yaml
id: wordpress-woocommerce
version: 1
requires:
  provision: [vendor]          # unioned with the project's worktree.provision
gates:
  - id: composer-validate
    run: "composer validate --no-check-publish --no-check-all"
  - id: phpcs
    run: "vendor/bin/phpcs -q --report=summary --standard={profile}/gates/phpcs.xml ."
  - id: phpstan
    run: "vendor/bin/phpstan analyse -c {profile}/gates/phpstan.neon --no-progress"
protectedPaths:
  - phpcs.xml
  - phpcs.xml.dist
  - phpstan.neon
  - phpstan.neon.dist
```

Shipped alongside it: `profiles/wordpress-woocommerce/gates/phpcs.xml` (the WPCS
ruleset) and `gates/phpstan.neon` (level + WP stubs).

**The load-bearing detail: the ruleset comes from the profile, not from the project.**
`{profile}` expands to the absolute path of the profile directory, and
`--standard`/`-c` point *there*. Had the gate invoked a project script such as
`composer check:static`, the standard of quality would be defined by the repo under
judgement — the oracle owned by the defendant. That is precisely what the whole of
`adr/006` exists to prevent.

**Second known trap.** `gotchas/conductor-wiring-deferred-limitations.md`: gate
command strings are whitespace-split, not quote-aware. So a harness install path
containing a space (`C:\Program Files\...`) would silently break `{profile}`
expansion. This is NOT fixed with a quote-aware runner (separate scope); it is
handled by a **fail-loud check at profile resolution**: a profile directory whose
absolute path contains whitespace throws an actionable error.

`php -l` is deliberately **not** in the set — PHPCS already fails on an unparseable
file, so a separate lint step would be a duplicate.

## 3. Gate integration

A new **step 1d**, mirroring `agentCi` (step 1c) — same shape, same failure
contract:

- `GateDeps.runProfileGates: (() => Promise<ProfileGateResult[]>) | null`; `null` =
  no profile attached.
- `GateVerdict` gains `profile_green: boolean`, with per-gate lines in `reasons`.
- **A red profile gate → RETRY** (worker-fixable, exactly like a failed
  `checkCommand`).
- **A gate that could not run — missing tool, absent `vendor`, spawn failure →
  THROWS out of `runGate`** → the conductor escalates it as broken operator config.
  This is the agent-ci path verbatim: an unfixable environment must never loop the
  worker.
- The project's own `checkCommand` still runs. Profile gates run **in addition**;
  there is no per-gate disable (decision 5).

The order and the other gate steps are not touched at all — this is the contour
where Phase 1 cost four critic rounds and Phase 2 cost six.

## 4. Protected paths

`resolveOracleSet` gains a **fifth source**: the profile's `protectedPaths`, fed
through the same `addLiteral`/`addGlob` with the same fail-closed normalization
(worktree-relative, `/`-separated, a real regular file — see
`gotchas/oracle-protected-paths-must-be-worktree-relative.md`). No new enforcement
mechanism: the fence, the fingerprints, and the pre-critic `constitution`
escalation are all s50 machinery, inherited for free. That inheritance was the
whole price of decision 2.

A useful consequence worth stating: `phpcs.xml` is **absent** in the test plugin.
The literal arm fingerprints an absent file as `<absent>`, so a worker *creating*
it registers as drift. An attempt to plant a project-local ruleset that shadows the
profile's is caught as exactly what it is — an oracle-substitution attempt — with
no bespoke check written for it.

The profile itself needs no protection: it lives in the harness repository, and the
worker's worktree is the *target project*. They do not intersect.

### Residuals, named rather than papered over

1. **`composer.json` / `composer.lock` are NOT protected in v1.** They are
   oracle-adjacent: they determine `vendor`, which supplies the phpcs/phpstan
   binaries that judge the worker. Protecting the lockfile, however, would make it
   impossible for any task to add a dependency — half of ordinary plugin work. The
   cost is judged disproportionate to the risk at v1. Revisit when a profile runs
   against a repo whose dependency set is stable.
2. **Dogfooding self-authorization.** When the harness is eventually run *on
   itself*, the worker's worktree becomes the harness repo and `profiles/` turns
   from unreachable into an ordinary project directory. At that point it MUST be
   listed in `constitutionPaths`, or the model self-authorizes (the exact gap codex
   flagged for `adr/006` Phase 3).
3. **Whitespace-split command runner** (see §2) — mitigated by a fail-loud check,
   not fixed.

## 5. How this is proven

Unit tests (TDD, implementer subagent):

- Profile loader, fail-closed matrix: unknown id · version mismatch · missing file ·
  whitespace in the install path · **resolution through the dist path** (the test
  that exists specifically to defeat the `critic-schema-json-not-copied-to-dist`
  failure mode).
- Gate step 1d: green · red → RETRY · could-not-run → throw.
- The fifth source in `resolveOracleSet`.

Live proof on `woodev-shipping-plugin-test`, **three directions** — Principle 13,
and because in this project unit tests have twice been vacuously green where only a
live run caught the defect (`agent-ci-ndjson-keyed-by-event-not-type`,
`launch-marker-needs-prompt-contract`):

1. A task producing a WPCS violation → gate red → RETRY.
2. A clean task → all three profile gates green → **commits**. This is the
   direction that proves the feature, not merely that nothing broke.
3. A task whose `file_set` contains `phpcs.xml` → `constitution` escalation
   **before the critic**.

Polygon preparation: `composer require --dev` for WPCS + PHPStan, and
`worktree.provision: [vendor]`. `gotchas/vendor-junction-composer-autoload-basedir.md`
states plainly that static tools work over a junctioned `vendor` — which is *why*
the gate set is static. `gate.agentCi.enabled` is switched off for the live proof
(`gotchas/agent-ci-not-runnable-on-native-windows.md`: on native Windows it
escalates infra on every run) and restored afterwards.

## 6. Explicitly out of scope for v1

Not built — and **no empty directories are created for it**, because an empty
`release/` in the tree reads as a promise:

- PHPUnit · wp-env · Plugin Check · HPOS · the WC compatibility matrix → these need
  a Linux/WSL polygon. Recorded as "needs a machine", not as "missing feature".
- `critic-rubrics/`, `north-star/`, `release/`, `compatibility/`, `policies/` — the
  facets dropped in decision 4.
- Per-project overrides and partial qualification — dropped in decision 5.
- A separate Product Qualification Report. Only its **shape** is preserved: the
  profile verdict lives in its own `profile_green` field and is never folded into
  `composer_green`. A second report can later be assembled from data that is
  already separated, instead of untangling data that was merged.

## Related

- `docs/adr/006-capability-based-authority-model.md` — Phase 3 folds into this work.
- `docs/wiki/architecture-review-external-2026-07.md` — risk 7 (the seed), risk 3.
- `docs/PRINCIPLES.md` — #14 (the worker does not write its own oracle), #15 (the
  gate proves only formalized properties).
- `docs/gotchas/critic-schema-json-not-copied-to-dist.md` ·
  `docs/gotchas/vendor-junction-composer-autoload-basedir.md` ·
  `docs/gotchas/agent-ci-not-runnable-on-native-windows.md` ·
  `docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md` ·
  `docs/gotchas/conductor-wiring-deferred-limitations.md`.
