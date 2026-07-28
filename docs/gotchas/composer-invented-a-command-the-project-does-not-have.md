# The composer invented a command, and the gate looped the worker over it to quarantine

**Tag:** `[orchestrator/invented-success-command]` · Found s60 (28.07.2026), diagnosed from
archived corpus artifacts · Fixed s61 (`adr/009`)

## What happens

The LLM that turns an operator intent into task specs ("the composer") emits a
`success_commands` entry the project does not have:

```yaml
success_commands:
  - pnpm lint:php:changes      # no such script in this project's package.json
```

Every other task in the same run got `success_commands: []`. The corpus case that carried
this one had a `success_command` nowhere in its definition. It was a hallucination, and
nothing between the model and the gate looked at it.

The machine gate then does exactly what it is designed to do with a failing command:

```json
{ "decision": "RETRY", "reasons": ["success_command FAILED (exit 1): pnpm lint:php:changes"] }
```

```text
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "lint:php:changes" not found
```

RETRY sends the worker back to fix its code. The code was never the problem, so round two
produces the same diff, and round three, and then the attempt budget runs out and the task
is **quarantined**.

The measured outcome of that task: worker code **correct**, critic `clean` @0.99,
`zones_touched` `[]`, both qualification gates **green**, task **lost**.

## Why it hides

Every individual component behaved correctly.

- The composer is an LLM; producing a plausible-looking command is exactly the failure mode
  LLMs have, and nobody had told it not to.
- `validateTaskSpec` is a *shape* validator. `success_commands` is a `string[]`, and
  `"pnpm lint:php:changes"` is a string.
- The gate cannot tell "your code fails this check" from "this check does not exist" —
  both are a non-zero exit code, and a non-zero exit from a check is, by design,
  worker-fixable.
- The escalation that finally arrives says `poison` / attempt budget exhausted, which reads
  like a worker that could not converge. The real reason is four layers upstream, in a
  field nobody was looking at.

It also stayed invisible because it needs a specific coincidence: a project whose declared
commands are thin (`checkCommand: null`), and a model that fills the silence.

## The deeper reason it matters

`PRINCIPLES.md` #14 says the worker may not modify the ORACLE — the tests, zones, guards and
CI config that define what "pass" means. `adr/006` closed the *reading* half: definitions
come from a trusted root.

A `success_command` is neither read nor defined — it is **run**, and it arrives inside the
spec an LLM authored. So the composer could, in effect, add a gate step nobody blessed.
Here it added one that could only ever fail; the same hole would equally accept one that
could only ever pass.

## What to do

- **A command a task is judged by is part of the oracle.** Filter a spec's
  `success_commands` against what the PROJECT declares (`package.json` scripts, plus the
  operator's `gate.checkCommand` / `gate.successCommands`), and drop the rest — with a WARN
  and an operator-visible digest line, because a silent drop is how a rule becomes
  invisible. Drop, do not reject the batch: rejecting turns a hallucination into a lost
  case, which is the defect being fixed.
- **Ask whether a command EXISTS before running it**, and make the answer a TRI-STATE.
  Only a positive "it is not there" may act; "I could not tell" must run the command exactly
  as before (`[logic/ambiguous-false]`).
- **A step that could not RUN is broken config, not a worker failure.** Throw out of the
  gate the way every other unrunnable step does, and let the conductor escalate — and give
  it the honest escalation type (`blocked`), because `needs-guard` asserts something about
  the diff that is not true, and in the corpus that hijacks the case's verdict.
- **Read the declaration from the trusted root, not the worktree.** A task that ADDS a
  script does not self-authorize it in the same run — the operator blesses it first,
  exactly like a newly-added contract zone (`adr/006`).
- **Teach the model too.** The prompt half and the code half ship together, or the drops
  repeat silently forever (`[chat/launch-marker-needs-prompt-contract]`).

## How it was found

Not by a test, and not by watching a run. By the corpus diagnostics archive (#126): the
case's `gate-verdict.json`, `critic-verdict.json` and quarantined spec were still on disk
from a run that had already finished, so the whole chain — approving critic, green gates,
three RETRYs on an invented command — could be reconstructed without re-running anything.
The archive is what turned "a case regressed" into a named defect.

## Related

- `docs/adr/009-a-task-command-is-part-of-the-oracle-and-the-corpus-measures-what-it-ran.md`
- `docs/gotchas/boolean-whose-no-means-two-things.md` — the tri-state rule the fix follows.
- `docs/gotchas/gate-reads-oracle-definitions-from-worktree.md` — the same boundary, one
  layer in.
- `docs/PRINCIPLES.md` #14 — the worker does not write its own oracle.
