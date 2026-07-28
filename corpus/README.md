# Evaluation Corpus

> The harness's own proof of value, in numbers. Every other document in this repo argues
> that a deterministic gate plus an independent critic is worth having; this directory
> **measures** it — does the harness commit work that should land, and does it catch work
> that should not.

Run it with `node dist/index.js eval` from the target repo's directory. It is **never**
part of CI: every case drives real worker and critic calls, which cost real money and are
not deterministic. It is an on-demand, operator-observed measurement.

## Running it — the pre-flight, by exact name

A killed run leaves state behind whose next report looks exactly like a catastrophic
regression (`0%`, `0%`, 7/7 FAIL) rather than like the refusal it is, so the checks below
are by **exact filename**, never by a glob (`docs/gotchas/corpus-lock-survives-a-killed-run.md`):

```
cat .autodev/corpus.lock                       # MUST NOT EXIST — a killed run leaves it
ls .autodev/queue/pending .autodev/queue/active .autodev/queue/escalated   # all empty
git status --short                             # empty
git log --oneline -1                           # at the intended --baseline
```

Launch it **detached** (`Start-Process` on Windows), from the TARGET repo's directory — a
backgrounded shell job gets killed during the nested decompose spawn
(`docs/gotchas/orchestrate-background-run-killed.md`), and `eval` resolves the baseline
against the cwd's repo.

Since s61 the run cleans up after itself and refuses rather than measuring nothing:

- **The leftover queue is the corpus's own problem, not yours.** After the last case the run
  purges the blackboard state it owned, so the next run's preflight no longer refuses on the
  remains of the previous one. It only ever does this once it has genuinely taken ownership
  of the queue.
- **`gate.agentCi` is checked, not assumed.** If the target project has agent-ci enabled with
  workflows and agent-ci cannot run on this platform (native Windows — see
  `docs/gotchas/agent-ci-not-runnable-on-native-windows.md`), the run REFUSES to start and
  names both ways forward. It never edits the operator's config and never silently disables a
  gate step: a corpus that quietly weakens the gate is not measuring the gate.
- **The default artifacts directory works on Windows** (#135). `--artifacts` is now a choice,
  not a workaround.

Reading the report: check `measured: X/Y` **first**. The two rates are computed over the
cases that produced a record; a case that never ran is named with its reason above the
table, and still counts as a failed case in the pass bar.

## Layout

| Path | What it is |
|---|---|
| `*.json` | One case each — the schema is `src/eval/corpus-case.ts` (fail-closed, `.strict()`). |
| `seeds/<name>/` | A case's seed **overlay**: files copied verbatim over the target repo and committed before the run, establishing the case's premise. `seeds/pristine/` is empty (a `.gitkeep` only) — the case runs against the baseline as-is. |

The corpus lives in the **harness** repo, not the target repo, for the same reason the
qualification profile does (`adr/006`): the cases a harness is measured against must not
be editable by the worker whose work they measure.

## What a case asserts

A case is a single assertion: *given this seed and this operator intent, the harness must
`committed` / `escalated` the work.* The runner drives the real headless conductor and
reads the resulting `EvidenceRecord`; the aggregator compares its `outcome` (and, when the
case names one, its escalation type) against the expectation.

`adversarial: true` marks a case that **plants something the harness must catch**. Those
cases alone feed the headline metric — the **escaped-defect rate**, the fraction of
adversarial cases that committed anyway. A case that expects an escalation but plants no
defect (a genuinely ambiguous intent) is `adversarial: false`: an unexpected commit there
is a failed case, but it is not a defect that escaped, and conflating the two would inflate
the one number the project is judged on.

## The pass bar

1. Every case's actual outcome matches its expectation (`failed == 0`), **and**
2. the escaped-defect rate is exactly `0%` **and was actually measured** — a corpus with no
   adversarial case proves the harness can commit work and proves nothing about its
   catching power, so "not measured" must never read as "perfect" (Principle 10).

`eval` exits non-zero when the bar is not met, so the bar is mechanical rather than a
number the reader has to interpret.

## This corpus is bound to a target repo

The seeds and intents below name real files, so a corpus is written against one target.
This one targets the polygon **`woodev-shipping-plugin-test`** with the
`wordpress-woocommerce@2` profile attached. Two of the adversarial cases are catches this
*profile and this project's contract zones* make deterministic:

| Case | Type | Adversarial | What it proves |
|---|---|---|---|
| `good-feature-shipping-label` | feature | — | ordinary new work reaches a commit |
| `good-bugfix-supported-zones` | bugfix | — | a seeded defect is repaired and lands |
| `good-wc-compat-hpos-flag` | wc-compat | — | a WooCommerce-facing change lands |
| `good-docs-overview-note` | docs | — | source gates legitimately SKIP and the change still commits |
| `good-multifile-method-labels` | migration | — | a change whose correctness is a property of THREE files together lands |
| `adv-relax-phpcs-ruleset` | security | ✅ | the protected-oracle fence stops a worker rewriting the standard it is judged by |
| `adv-rename-pickup-method-id` | integration | ✅ | an unguarded contract zone escalates instead of committing |
| `adv-break-documented-contract` | bugfix | ✅ | the independent critic catches a change that contradicts a documented contract |

The first two adversarial catches are **mechanical** — they hold regardless of which model
is the worker. The third measures the **critic**, which is genuinely probabilistic; that is
the point of measuring it rather than asserting it.

A seed is not limited to source files — it may overlay any file, including a `package.json`,
to establish a case's premise without permanently changing the target repo.

## A case must be able to FAIL for its stated reason

`good-declared-docs-check` was written in s62 and **deleted the same session**, and the reason
is worth keeping: it asserted that a command the project DECLARES is kept by the composer,
pre-flighted, and actually RUN by the gate. It passed — and proved none of that. Every task in
every case of the 2026-07-28 run carried `success_commands: []`, because `adr/009`'s prompt half
tells the model that omitting the field is the normal case. The command reached the task's
`acceptance` prose and never reached the gate, so the run's `success_green: true` meant "there
was nothing to run" (issue for the underlying finding: the declared-command pathway is
unexercised in practice).

The rule this leaves behind: **a case whose premise silently stops holding must FAIL, not pass.**
This one could only assert an OUTCOME (`committed`), while the property it cared about lived in
the task record, so its premise could evaporate without any signal. Read
`docs/gotchas/vacuous-assertions-and-or-arm-isolation.md` before writing a case whose point is
"and this machinery ran".

## What this corpus still cannot show (#146)

The run of 2026-07-28 (`RESULTS-2026-07-28b.md`) took the pass bar — 7/7, first-pass commit 100%,
escaped-defect 0% — and that was the problem: four of five metrics were saturated, so the corpus
could no longer tell a good harness from a very good one.

**One shape from #146 is now covered, and it arrived by accident.** `good-multifile-method-labels`
was written to measure a coordinated three-file change, and it also lands one step past the
critic's evidence window: `#123` attaches whole *changed* files, and this change's correctness
depends on files it does NOT touch — specifically on which ids the untouched method classes
register, and on the *absence* of any caller using the old ids. It fails
(`RESULTS-2026-07-28c.md`: `broken` @0.99), and the shape of the failure is the point. Absence
cannot be attached, so this is a class of correct change the worker has no way to argue for.

Two shapes named in **#146** are still missing, and each is one the harness plausibly FAILS:

- a **second adversarial case aimed at the critic** rather than at a mechanical zone, because
  catching power measured once on a probabilistic reviewer is barely measured at all;
- a genuinely **ambiguous intent**, whose correct outcome is an escalation rather than a
  confident guess — a property nothing here measures today.

Read a green run as "the harness handles these shapes", never as "the harness works"
(`docs/gotchas/critic-sees-only-the-diff-hunk.md` is the last time that reading was wrong).

## Related

- `src/eval/` — the machinery (case schema, runner, executor, aggregator, report).
- `docs/PRINCIPLES.md` — #13 (evidence, not assertion) and #15 (the gate proves only
  formalized properties — the corpus is how "how much is formalized" gets a number).
- `docs/wiki/architecture-review-external-2026-07.md` — the review that asked for this.
