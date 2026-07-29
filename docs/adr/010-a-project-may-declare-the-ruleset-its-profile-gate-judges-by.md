# 010 — A project may DECLARE the ruleset its profile gate judges by

**Status:** accepted (s63, 2026-07-29). The agent's decision, taken under the standing
delegation recorded in `adr/009` ("Who decided what") — the operator filed the measurement
in #152 and recommended this option; the mechanism is not a question he can answer in
product terms.
**Date:** 2026-07-29
**Refines:** `006-capability-based-authority-model.md` (an operator declaration read from
the trusted root is not the defendant owning its own oracle) and the Profiles thrust
(`profiles/README.md`, "Union only, no selective disable").
**Resolves:** #152.

## Context

The harness was pointed at a REAL operator repository for the first time —
`woodev-base-theme`, his active WordPress theme — and could not write a single passing
line of PHP there.

The theme is **clean under its own standard**: `phpcs` over its `phpcs.xml.dist`, 119
files, exit 0. Under the profile's ruleset (bare `WordPress-Core` + `WordPress-Docs`),
three of its files report **53** violations:

| sniff | count |
|---|---|
| `Universal.Arrays.DisallowShortArraySyntax` | 47 |
| `WordPress.Files.FileName` (class file name) | 3 |
| `WordPress.Files.FileName` (not hyphenated lowercase) | 3 |

All 53 are two deviations the theme declares **deliberately, in the positive direction,
with a written justification per deviation** in the ruleset itself: short array syntax is
*mandatory* (it excludes `DisallowShortArraySyntax` and then re-enables
`Generic.Arrays.DisallowLongArraySyntax`), and class files are PSR-4-named because the
theme ships its own autoloader.

The gate is line-scoped (`adr/008`, profile v2), so the theme's existing code is safe.
**New** lines are not. On arrays the two standards are **mutually exclusive**: the profile
demands `array()`, the project demands `[]`. No line containing an array literal can
satisfy both. The harness cannot produce PHP here that passes both its own gate and the
project's CI, and the worker would loop until its attempt budget ran out — the
`[orchestrator/invented-success-command]` shape, one layer over.

### Why the existing reasoning does not cover this case

`profile.yaml` states the rule it was built on:

> a gate that invoked a project script (`composer check:static`) would let the repo under
> judgement define its own standard of quality — the oracle owned by the defendant, which
> is exactly what `adr/006` exists to prevent.

That is correct for the case it was written for: the project **weakening** the standard.
This is a different case, and the difference is who wrote the oracle and when.

- `adr/006` protects against **the worker** re-defining the standard mid-run, on a tree it
  just wrote.
- Here the standard was written by **the operator**, before and outside any run, in a
  file that is already in the profile's `protectedPaths`, and it is **stricter than the
  profile in one place** (long arrays are forbidden, which the profile permits).

The Profiles design had no way to tell those two apart. Everything a project said about
its own quality bar was treated as the defendant speaking. That is the defect.

## Decision

**A profile gate may nominate its ruleset as overridable; a project may then DECLARE its
own, and the declaration is read from the TRUSTED ROOT** — the same mechanism, and the
same trust argument, as `contract.docPaths` (`adr/007`) and `contract.constitutionPaths`.

Four parts, and each one closes a way this could be believed while being inert or unsafe.

### (a) The profile author decides which gates are overridable

A gate declares a profile-relative default and references it by placeholder:

```yaml
- id: phpcs
  files: "**/*.php"
  ruleset: gates/phpcs.xml
  run: "vendor/bin/phpcs -q --report=checkstyle --standard={ruleset} {files}"
  redExitCodes: [1, 2]
  report: checkstyle
```

`{ruleset}` and `ruleset:` are cross-checked in BOTH directions at profile load, exactly
like `{files}`/`files:` and `report:`, and for the same reason: each mismatch is silently
wrong rather than loudly broken. A `run` with `{ruleset}` and no `ruleset:` key would ship
the literal text to the tool; a `ruleset:` key no `run` mentions reads as overridable while
nothing can override it.

**Only the ruleset is overridable — never the `run` command.** A project substituting the
command substitutes the *tool*, and a tool that always exits 0 is a gate that proves
nothing. The blast radius of a ruleset is bounded by what the analyzer's config language
can express; the blast radius of a command is the machine. A gate without a `ruleset:` key
(`composer-validate`) cannot be overridden at all.

### (b) The project declares, from the trusted root

```yaml
contract:
  gateRulesets:
    phpcs: phpcs.xml.dist
```

It lives on the `contract:` block because that is where oracle definitions live, and it is
read by `loadConfigWithRaw(repoRoot)` — the trusted root — never from the worktree. The
worktree's copy of `phpcs.xml.dist` is not consulted even though the gate's `cwd` is the
worktree: `{ruleset}` expands to an ABSOLUTE path at the trusted root, so a worker
rewriting the file it is judged by changes nothing about the judgement.

### (c) The declared file joins the protected oracle set

The declared path is added to the `adr/006` Phase-2 fence as its own source
(`contract.gateRulesets: <gateId>`), so a worker touching it inside the worktree escalates
`constitution`. Without this, the mechanism would move the oracle from a location the fence
covers (`phpcs.xml.dist`, already in the profile's `protectedPaths`) to an arbitrary one it
does not — a declaration that quietly *un*-protects the file it points at.

The attributed source is deliberately distinct from `profile protectedPaths:`, so an
escalation names which declaration demanded the protection.

### (d) Every failure is loud, and there is no silent fallback

Fail-closed, per Principle 10 — and specifically the `[logic/ambiguous-false]` shape, which
is this repository's most expensive recurring defect:

| situation | outcome |
|---|---|
| declared path absent / unreadable / a directory / a symlink | **throw at load** |
| declared path escapes the repo root (`..`, absolute, intermediate symlink) | **throw at load** |
| declared for a gate the profile does not have | **throw at load** |
| declared for a gate with no `ruleset:` key | **throw at load** |
| declared path contains whitespace | **throw at load** |
| not declared | the profile's own ruleset, unchanged |

A declared-but-absent ruleset **must not** fall back to the profile default. The operator
would believe their standard is in force while the profile's is — the exact class of defect
in which a guard is believed and inert (`[gate/oracle-protected-paths-relative-invariant]`,
`[orchestrator/prompt-rule-zeroed-the-field]`). A throw at load stops the project, which is
the correct blast radius for "I cannot tell you what standard I am enforcing".

A declaration naming an unknown or non-overridable gate throws for the same reason: a
declaration that does nothing is worse than no declaration, because the operator stops
looking.

## What this costs, stated plainly

**A project can now declare a ruleset that is weaker than the profile's.** That is not a
leak in the mechanism — it is the mechanism. The operator's declaration IS the oracle
(Principle 14: a legitimate oracle change is blessed by the operator). What the harness
guarantees is narrower and now honest: *every formalized property held, and here is
which standard formalized them* (Principle 15).

This is why part (d) refuses to be quiet and why the UI change ships in the same batch: a
gate whose standard came from the project must say so on the screen that claims what the
project guarantees, or the operator has no way to notice a bar that moved.

**Named residual, unchanged by this ADR:** the analyzer toolchain is still
project-controlled — `vendor/bin/phpcs` comes from the project's own `composer.json`. A
project can already substitute the binary. This ADR does not widen that hole and does not
close it; it is recorded in `CURRENT-STATE.md` under open questions.

**Rejected — union the two rulesets.** It cannot work here, and the reason is not
incidental: `DisallowShortArraySyntax` and `DisallowLongArraySyntax` are contradictory
predicates over the same line, so their union is unsatisfiable. A merge strategy that
produces an unsatisfiable standard is worse than either input.

Measured rather than argued, on the real file the first task targets. One line —
`$probe = array( 1, 2 );` — was injected into `inc/Woo/FilterRail.php` in a throwaway
worktree and both rulesets were run over it:

| ruleset | verdict on that line |
|---|---|
| the project's `phpcs.xml.dist` | **RED** — `Generic.Arrays.DisallowLongArraySyntax.Found` ×1, exit 2 |
| the profile's `gates/phpcs.xml` | accepts it; `DisallowLongArraySyntax` does not appear in its report at all, while it reports 6 × short-array on the file's pre-existing code |

The exclusion runs in both directions, which is what makes it a collision rather than a
strictness ordering: neither ruleset is a relaxation of the other, so no union, and no
"take the stricter of the two", can produce a standard a line can satisfy.

**Rejected — leave it and document that the profile suits only projects with no standard
of their own.** That is `profiles/README.md` describing a limitation instead of a product,
and it would have made the first real repository the harness was pointed at
permanently out of scope.

**Rejected — strip the array sniffs from the profile's ruleset.** It fixes this one
collision and no other, weakens the profile for every project that declares nothing, and
teaches nothing about the next deviation a real repository has already made.

## Consequences

- `profiles/README.md`'s "Union only, no selective disable" is amended: an operator may
  now declare a whole ruleset. Selective per-sniff disabling is still not offered — a
  waiver mechanism is a different feature (#90) with a different audit story.
- The profile is bumped to **version 3**. The pinned version's meaning is unchanged for
  a project that declares nothing, but the gate's `run` string changed shape, and a
  pinned version whose meaning drifts underneath a project defeats pinning.
- `GET /projects/:id/guarantees` reports, per gate, which ruleset is in force and whether
  it came from the profile or the project — see #138.
- The first honest measurement on a real repository becomes possible at all. Whether it
  passes is a separate question, and this ADR asserts none of it.

## Related

- `docs/PRINCIPLES.md` — #14 (the worker does not write its own oracle), #10 (fail toward
  the safe state), #15 (the gate proves only formalized properties).
- `adr/006` — the Authority Model, and the trusted-root/worktree split this reuses.
- `adr/007` — `contract.docPaths`, the operator-declaration precedent.
- `adr/008` — line-scoping, which is why the theme's *existing* code was never the problem.
- `profiles/README.md` — the union-only rule this amends.
- #152 (the measurement), #90 (waivers), #138 (making it visible).
