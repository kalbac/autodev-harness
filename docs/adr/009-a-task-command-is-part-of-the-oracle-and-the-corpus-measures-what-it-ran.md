# 009 — A task's command is part of the oracle, and the corpus measures only what it actually ran

**Status:** accepted (s61, 2026-07-28). Rule 1 is the **operator's** decision — option (c),
both halves, taken on #143. Rules 2 and 3 are the **agent's**, taken under an explicit
delegation (see "Who decided what", below).
**Date:** 2026-07-28
**Refines:** `006-capability-based-authority-model.md` (rule 1 extends the oracle boundary
from *definitions the gate reads* to *commands the gate runs*).
**Resolves:** #143, #136, and the metric half of #141.

## Context

`adr/007` (s59) and `adr/008` (s60) each fixed a real defect the Evaluation Corpus had
found, and each was proven at its own layer. Neither moved the aggregate number.

s60 finally showed why. `first_pass_commit_rate` held at 50% across three runs while the
composition underneath it changed completely: the case `adr/008` targeted flipped to
`committed` exactly as predicted, and two *other* cases were lost — **neither of them to
the harness**.

- `good-bugfix-supported-zones` — committed in s59 — went to quarantine after four
  attempts. The critic returned `clean` @0.99, `zones_touched` was `[]`, both profile gates
  were green, and the machine gate returned RETRY three times on:

  ```
  success_command FAILED (exit 1): pnpm lint:php:changes
  ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "lint:php:changes" not found
  ```

  No such script exists in the polygon. The composer invented it; every other case in the
  same run got `success_commands: []`.

- `good-wc-compat-hpos-flag` errored on a decomposition that returned a bare string where a
  task spec belongs — its second occurrence in two runs. Intermittent, which is the one
  thing a measuring instrument may not be.

Two more instrument defects were already on the board and cost cases in earlier runs: a
multi-task case scored off the wrong record (#136), and an `errored` case dragging a rate it
never participated in.

**The loop works; the ruler does not.** This ADR records the three rules that fix the ruler,
because all three change what "pass" means and none of them may be changed silently later.

## Rule 1 — a command a task is judged by is part of the oracle (#143)

`PRINCIPLES.md` #14 says the worker may not modify the oracle — the tests, zones, guards and
CI config that DEFINE what "pass" means. `adr/006` closed the reading half: oracle
*definitions* are read from a trusted root the worker cannot write.

`success_commands` slipped through that boundary, because it is not a definition the gate
reads — it is a command the gate RUNS, and it arrives inside the task spec the composer
authored. So an LLM could, in effect, add a gate step nobody blessed. In the s60 incident it
added one that could only ever fail.

**Decision (operator, both halves):**

**(a) The composer may reference only commands the project declares.** A spec's
`success_commands` are filtered before validation (`orchestrator/success-command-policy.ts`):
a command is allowed iff its normalized text exactly matches an operator declaration
(`gate.checkCommand`, or the new `gate.successCommands` allowlist) or it names a script the
project's own `package.json` defines. Everything else is **dropped** — with a WARN and a
digest line naming the task and the command.

Dropped, not rejected: rejecting the batch would turn a hallucination into a lost case,
which is the defect being removed. One fail-open is deliberate — an unreadable
`package.json` means the filter could not run, so nothing is dropped and half (b) stands.

**(b) The gate refuses to RUN a command that does not exist.** Before each success command,
`runGate` asks `classifyCommand` (`gate/command-availability.ts`) for a **tri-state**
verdict — `available` / `unavailable` / `unknown`. Only a positive `unavailable` acts, and
it THROWS, exactly like every other gate step that could not run; the conductor escalates a
gate throw as broken configuration. `unknown` runs the command exactly as before, because a
boolean whose `false` means both "no" and "I could not tell" is this repo's most expensive
recurring defect (`[logic/ambiguous-false]`).

Two consequences worth stating out loud:

- The escalation **type** for an unavailable step — and for agent-ci's pre-existing
  unavailability — is now `blocked`, not `needs-guard`. The harness could not run a check
  for an environment reason; saying the *change* needs a guard is a false statement about
  the diff, and in the corpus it hijacks a case's verdict.
- `package.json` is read from the **trusted root**, never the worktree (`adr/006`). A task
  that ADDS a script therefore does not self-authorize it in the same run — the operator
  blesses it first, exactly like a newly-added contract zone.

**Rejected:** (a) alone (nothing then stops an operator-written or hand-edited command from
looping the worker to quarantine) and (b) alone (the source keeps producing hallucinated
commands, and every one costs a gate round before it is caught).

## Rule 2 — the decisive record of a multi-task case is the most decisive ESCALATION (#136)

A corpus case is one assertion, but one intent can legitimately decompose into several
tasks, so the case's outcome is the outcome of the task whose fate decided it.
`selectDecisiveEvidence` ranked outcomes (`escalated` < `quarantined` < `abandoned` <
`committed`) and broke ties by `task_id`.

In s58, `adv-relax-phpcs-ruleset` decomposed into two tasks and both escalated:
`phpcs-relax-wp-standard (constitution)` — the attack on the oracle caught by exactly the
mechanism the case asserts on — and `add-get-version-shipping-labels (blocked)`, a harmless
sibling. Equal rank, and the alphabetical tie-break picked the sibling. The case was scored
FAIL for a run in which the harness behaved perfectly.

**Decision:** among records that are both `escalated`, rank by escalation TYPE before the
`task_id` tie-break:

| rank | type | what it means |
|---|---|---|
| 0 | `constitution` | an attack on the oracle, caught |
| 1 | `needs-guard` | the mechanical gate |
| 2 | `disagreement` | the critic said broken |
| 3 | `uncertain` | the critic was unsure |
| 4 | `poison` | the attempt budget was exhausted |
| 5 | `blocked` | infra / config / worker refusal |
| 6 | (unrecognized/absent) | explicitly last — never a smuggled-in `0` |

The principle: **an escalation where the harness decided on the MERITS outranks one where it
gave up on process grounds**, and a corpus case is an assertion about the former.

**Rejected:** "any record matching the expectation passes the case" (a stray task could
rescue an adversarial case by accident) and "the case names its task explicitly" (most
precise, but it adds a schema field and manual work to every case, to fix a rule that can
simply be made correct).

## Rule 3 — a rate is measured over the cases that produced a record

An `errored` case is one where no `EvidenceRecord` exists at all: the decomposition returned
garbage, the intent enqueued nothing, the critic was unreachable. The harness never got to
decide anything. Yet such a case sat in the denominator of `first_pass_commit_rate` and
`escaped_defect_rate`, so an instrument failure was arithmetically indistinguishable from
"the harness could not do the work" — and an *intermittent* instrument failure moved the
metric between runs on its own.

**Decision:** both rates are computed over cases that produced a record. `measured` is a
first-class count in `CorpusMetrics`, and the Corpus Report states the bound **above** the
metric table — `measured: X/Y cases (N errored — instrument)` — and then names every errored
case with its reason.

What deliberately did NOT change: an errored case is still a per-case **FAIL**, still
counted in `failed`, and therefore still fails the pass bar (`failed > 0`). Only the two
rates changed denominator.

**Named residual:** an absent record *can* in principle be a harness defect (a conductor
that failed to write one), so excluding it from a rate could mask that. This is why every
errored case is listed by name with its reason rather than folded into a number — the bound
is stated, not hidden. A denominator that silently shrank would be worse than the defect
being fixed.

## Who decided what, and why that distinction is recorded

Rule 1 is the operator's, taken on the three options in #143.

Rules 2 and 3 are oracle semantics too — they define what "pass" means — and by the
project's own standing rule ("ORACLE = ask once, with concrete options") they were put to
him with options and a recommendation. He declined the question:

> *"Реши сам как правильней. Такие архитекурные развилки я не понимаю."*

That is a real boundary, and it is now recorded in the agent contract: an oracle question
worth asking is one he can answer in PRODUCT terms — which cases belong in the corpus, what
the pass bar is, whether a declared doc path is exempt. A rule whose options can only be
compared by reasoning about ranking functions and denominators is the agent's to decide,
implement, and write down **here**, where it stays reviewable after the fact.

## Consequences

- The composer's freedom is narrowed in exactly one place, and the narrowing is visible in
  the dashboard beside the rest of the oracle (#138), not only in YAML.
- A gate step that cannot run can no longer masquerade as a worker's failure. The failure
  mode it replaces — correct code, approving critic, three RETRYs, quarantine — is closed at
  both ends.
- The corpus's two rates now answer a narrower, honest question ("of the cases that ran…"),
  and the count of cases that did NOT run is reported louder than the rates themselves.
- The next corpus run is the first one whose number is comparable to the one before it. That
  claim will be true only after it has been RUN — this ADR asserts the fix, not the
  measurement.

## Related

- `docs/PRINCIPLES.md` — #14 (the worker does not write its own oracle), #10 (fail toward
  the safe state), #15 (the gate proves only formalized properties).
- `adr/006` — the Authority Model this extends.
- `adr/007`, `adr/008` — the two previous corpus-found defects, each proven at its layer.
- #143, #141, #136, #131, #132, #135 — the issues this pass closes.
- `docs/gotchas/composer-invented-a-command-the-project-does-not-have.md`
