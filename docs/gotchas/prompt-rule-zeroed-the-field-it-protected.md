# `[orchestrator/prompt-rule-zeroed-the-field]` — a prompt rule written to stop a hallucination stopped the behaviour entirely

> Found s62 (2026-07-28), measured on a 9-case corpus run. Issues #148, #149.

## What happened

s60 lost a good task because the LLM composer invented a `success_command` the project did
not have (`pnpm lint:php:changes`), and the gate looped the worker over it to quarantine —
`docs/gotchas/composer-invented-a-command-the-project-does-not-have.md`. `adr/009` closed
that in two halves: **code** (filter a spec's commands against what the project declares;
refuse to RUN a command that does not exist) and **prompt** (teach the model the rule, so it
does not keep producing drops).

The prompt half says, among other things:

> "Omitting `success_commands` entirely is the NORMAL case. … a task-specific
> `success_commands` entry is the rare exception, not the default. When in doubt, leave it
> out."

One run later, across **all nine corpus cases, every single task carried
`success_commands: []`.** Not most — all. Including a case whose operator intent said in as
many words that the change was not done until `npm run check:docs` passed, and whose project
DECLARED that script. The model put the command in the task's `acceptance` prose and in the
body, where a human reads it, and left the executable field empty.

So the hallucination is gone and so is the behaviour. `adr/009`'s code half — the declared-
command filter, the tri-state availability pre-flight, the refuse-to-run-and-escalate path —
now guards a road nothing drives on. The only live route left is the operator's global
`gate.successCommands`, which applies to every task rather than to the one that needs it.

## Why it hid

Every downstream signal reads GREEN when the field is empty:

- the gate's verdict says `success_green: true`, which means "nothing to run" and is
  byte-identical to "the commands passed";
- the corpus case asserting the pathway **passed**, because a case can only assert an
  OUTCOME (`committed`), and the task committed for unrelated reasons (#149);
- no WARN fires, because dropping nothing is not an event.

The measurement that caught it was reading nine archived task specs by hand, after the
report already said the case passed.

## Rules

1. **A prompt rule that suppresses a bad value can suppress the good ones too.** "Do not
   invent X" and "X is rare, leave it out when in doubt" are different instructions; the
   second is a prior on the whole field, not a constraint on wrong values. If the code half
   still needs the field populated in legitimate cases, the prompt must say when to populate
   it, with an example — not only when not to.
2. **After shipping a prompt half, MEASURE the field's population rate**, not just the
   absence of the incident. Both halves ship together
   (`docs/gotchas/launch-marker-needs-prompt-contract.md`) — and so must both measurements:
   the bad value is gone AND the good value still appears.
3. **"Nothing to run" must not serialize as "everything passed."** A verdict field that
   means "vacuously true" needs to be distinguishable downstream, or every report built on
   it overstates what was checked.
4. A guard around a field nobody fills is not protection, it is unexercised code — and it
   will be believed anyway, because it has tests.

## Related

- `docs/adr/009-a-task-command-is-part-of-the-oracle-and-the-corpus-measures-what-it-ran.md`
- `docs/gotchas/composer-invented-a-command-the-project-does-not-have.md` — the incident the
  prompt half was written for
- `docs/gotchas/launch-marker-needs-prompt-contract.md` — the mirror image: a marker the code
  DETECTED that the prompt never taught the model to EMIT
- `docs/gotchas/vacuous-assertions-and-or-arm-isolation.md` — the green-proves-nothing shape
- `corpus/README.md` — "A case must be able to FAIL for its stated reason"
