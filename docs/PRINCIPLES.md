# PRINCIPLES — Autodev Harness

> The constitution. **Why** the invariants exist, not just what they are.
>
> Read this when a guard, gate, or restriction looks like "unnecessary complexity"
> and you are tempted to remove it. Almost every one of these was written to stop a
> specific failure that already happened. If you want to change one, argue with the
> *reason* here first — do not delete the mechanism and discover the reason again.
>
> `VISION.md` = what we are building. `PRINCIPLES.md` = the rules that must hold for it
> to mean anything. When a tactical doc contradicts a principle, the principle wins.

---

## 1. Intelligence is separated from execution authority

**Principle.** The component that *decides* what to write (the LLM) is never the
component that *decides whether it may pass* (the gate). The worker proposes; the
harness disposes.

**Why.** An agent judging its own output has an unbreakable conflict of interest. Every
"agent that checks itself" collapses into the agent rationalizing its own work as done.
Separating the two roles is the only structural fix — you cannot prompt your way out of
a conflict of interest, you can only remove it.

**Enforced by.** The two-layer split (`adr/003` R1): a deterministic enforcement
substrate below, an LLM orchestrator strictly above it. The orchestrator can enqueue,
trigger, read, report — and nothing else.

## 2. The worker has no authority over acceptance

**Principle.** "DONE" from a worker is a *claim*, not a *fact*. It carries no weight
until an independent process confirms it.

**Why.** Workers are confidently wrong. Green tests, a plausible diff, and a cheerful
summary are exactly what a subtly-broken change looks like. If the worker's word were
enough, the whole system would be "trust the model" with extra steps.

**Enforced by.** The critic gate + mechanical gate run *after* the worker and *before*
commit. The worker cannot commit; the conductor commits, and only after the gate.

## 3. The gate is mechanical and cannot be talked past

**Principle.** The final barrier is deterministic code, not an LLM's judgment. It runs
**outside the agent's context**, so no amount of clever output can bypass it.

**Why.** This is the one guarantee that actually holds under an adversarial or simply
mistaken agent. A gate implemented as "ask a model if this is ok" can be argued with; a
gate implemented as code (contract zones, mutation-verified guards, CI exit codes)
cannot. The mechanical guarantee — *not* the agent's good behavior — is what makes
"never merge bullshit" true. In autodev-loop the gate ran in PowerShell, not in the
operator's Claude session, precisely so the agent physically could not reach it.

**Enforced by.** The enforcement substrate (`adr/003`): worktree isolation, machine
gate + guards + mutation-check, dirty-file fence, commit-after-gate. The orchestrator
has no `run_gate`/`skip`/`reorder` capability.

## 4. The critic is independent — never Claude-on-Claude

**Principle.** The critic that reviews a diff must be a different model family from the
worker that wrote it. Heterogeneity is a policy (default on), not a coincidence.

**Why.** A model reviewing its own family's output shares its blind spots and its
failure modes — it nods along at exactly the mistakes it would have made. Independence
is what makes the review find things the worker could not see itself.

**Enforced by.** `policy.heterogeneity` (`adr/003` R3); the critic is pinned to a
non-worker model (currently codex `gpt-5.6-luna`).

## 5. Self-critique is never the gate

**Principle.** A worker refining its own work in-loop is *useful*, but it is **not** the
acceptance step. The gate is always external.

**Why.** In-loop self-refinement and "critique theater" (the model grading itself
before returning) are the exact failure mode the harness exists to prevent. Accepting
them as the gate re-introduces the conflict of interest Principle 1 removes. This was a
deliberate rejection during donor extraction (Open Design / OpenHands both do it; we do
not adopt it as a gate).

**Enforced by.** `adr/002` axis 5 (gate = independent diff-critic + machine gate;
self-critique rejected as a gate).

## 6. Re-critic your own fixes — never self-certify

**Principle.** A fix made in response to a critic finding is not trusted because you
made it. It goes back through the critic (or is gated by a regression test that
mechanically proves the fix).

**Why.** Fixes are as fallible as the original code — often more so, because they are
narrower and made under the assumption "I now understand the bug." Real cases: two
incomplete fixes slipped through self-certification in the parent project (2026-06-07);
a fix leaked a *narrower version of the same bug* across four re-critic rounds in s46. A
fix that isn't re-verified is just a new, less-tested claim of DONE.

**Enforced by.** The review discipline in `AGENT-RULES.md`; a mechanical critic-advised
fix is gated by its regression test.

## 7. Coverage is mechanical; correctness is the critic's job

**Principle.** The critic judges **correctness** (broken contracts, fabricated proof,
logic regressions). Whether a test/guard exists is a **mechanical** question, answered
by the zones + mutation-check + CI — not a reason for the critic to block.

**Why.** Conflating the two makes the critic un-satisfiable in test-less repos (it
demands a guard, no guard framework exists, nothing ever passes — observed live in s41).
Correctness and coverage are different failures with different owners; merging them
paralyzes the gate.

**Enforced by.** `adr/005` (critic prompt: coverage is not a defect, correctness is).

## 8. Autonomy lives *above* the gate, never *through* it

**Principle.** Giving the system more autonomy (unattended overnight runs, auto-rework)
never means giving anything the power to weaken or skip the gate. More autonomy = more
deciding *what to attempt*, never *what is allowed to pass*.

**Why.** The gate is the one thing that must not bend. If autonomy is bought by relaxing
enforcement, the whole guarantee evaporates the moment no human is watching — which is
exactly when it matters most.

**Enforced by.** `adr/004` (post-review autonomy sits above the gate); `adr/003` R1
(orchestrator strictly above the substrate).

## 9. Blocking parks the task, never the queue

**Principle.** When the system cannot safely decide something unattended, it parks
**that one task** and moves on. It never stalls the whole queue waiting on a human.

**Why.** A single ambiguous task should not hold every other task hostage. Parking is
graceful degradation; queue-stalling is a denial of service on your own pipeline.

**Enforced by.** `adr/004` decision classes; the overnight supervisor journals a park
and continues (s45/s46).

## 10. When unsure, fail toward the safe state

**Principle.** Every ambiguity resolves toward the more conservative outcome: unclear
presence → treat as attended; unreadable config → the restrictive default; a load/parse
error → closed, not open.

**Why.** The cost of a false "safe" is a little wasted caution; the cost of a false
"go" is unsupervised bullshit merged. Those costs are wildly asymmetric, so the default
must lean to caution every time.

**Enforced by.** Fail-closed loads, read-through presence checks, bounded defaults
(s45/s46 gotchas).

## 11. Single source of truth — the file-blackboard

**Principle.** There is exactly one authoritative store of harness state: the
file-blackboard. Anything else (a cache, a projection, a UI model) is downstream and
must never become a second truth that can drift.

**Why.** Two sources of truth is zero sources of truth — the moment they disagree, every
component has to guess which one is right, and the guarantees built on state become
unprovable.

**Enforced by.** `adr/002` axis 1; the `BlackboardRepository` seam; no parallel daemon
DB.

## 12. Anti-drift — measure intent against the cumulative diff

**Principle.** Over a long run, check not just "is this change correct" but "does the
*accumulated* work still match the operator's original intent."

**Why.** Small locally-correct steps can walk a project somewhere it was never meant to
go. Each diff passes; the sum drifts. Only comparing against the stated intent catches
that.

**Enforced by.** The anti-drift critic (`src/anti-drift`); becomes mandatory once
unattended autonomy ships (`adr/004`).

## 13. Verify before "done" — evidence, not assertion

**Principle.** No claim of "works", "fixed", or "passing" without having *run it and
observed the result*. This binds the harness's own development too.

**Why.** "It should work" is how bullshit merges. A project whose entire thesis is
mechanical verification cannot exempt itself from mechanical verification. Words are not
evidence.

**Enforced by.** `AGENT-RULES.md` (verify-before-done); the gate applies to our own
code.

## 14. The worker does not write its own oracle

**Principle.** The worker may propose a diff; it holds **no authority to modify the
oracle** — the tests, assertions, contract zones, guards, CI config, protected-path
list, or acceptance criteria that *define* what "pass" means. Oracle definitions the
gate trusts are read from a root the worker cannot write; a legitimate oracle change
is blessed by the operator, never silently trusted because it rode in on a feature
diff.

**Why.** This is the write-authority half of Principle 2, and it is distinct: #2
says the worker cannot self-*certify* (declare its own diff correct); this says the
worker cannot re-*define* the standard it is certified against. Once self-certifying
is closed, the rational reward-hacking target becomes the checks themselves —
weaken a test, gut a zone, soften `ci.yml`, drop a file from the human-only list. A
gate that reads its oracle from the same tree the worker just wrote can be talked
past not by argument but by edit. The s48 audit found this boundary half-open: the
task contract and gate config are already worker-inaccessible, but the machine gate
read its zone/guard/CI *definitions* from the worktree.

**Enforced by.** `adr/006` (capability-based Authority Model): oracle definitions
read from a trusted root, oracle execution against the worktree, oracle
modifications require an operator capability. Enforcement is phased — see the ADR.

## 15. The gate proves only formalized properties

**Principle.** The mechanical gate can only prove what has been **formalized** into
it — a declared contract zone, a mutation-verified guard, an executable CI check.
It does not prove business-logic correctness, requirement completeness, or UX. The
corollary is the harness's growth path: **the better the spec and acceptance oracle,
the stronger the harness.** More proven properties come from formalizing more, not
from a smarter model.

**Why.** It keeps "never merge bullshit" honest about its own scope. A green gate
means "every formalized property held," not "this is good software" — conflating the
two would let the guarantee overclaim. It also names the durable investment: the
asset is the harness's set of independently-provable properties (hence Profiles /
qualification layers, which formalize a project type's oracle), not the worker.

**Enforced by.** `adr/006` (protected oracle) + the Profiles thrust
(`architecture-review-external-2026-07.md` risk 3/7); every gate verdict is scoped
to its declared zones/guards/CI, never a blanket "correct."

---

## Related

- `VISION.md` — what we are building and why (the anchor).
- `AGENT-RULES.md` — the workflow that operationalizes these principles.
- `adr/` — the decisions that established each principle (linked inline above).
- `reference/autodev-loop-runbook.md` — the proven origin of the discipline.
