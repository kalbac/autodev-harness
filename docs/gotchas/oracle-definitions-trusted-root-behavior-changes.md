# `[gate/oracle-definitions-trusted-root]` — what changed when the gate stopped reading the worktree

> Found/shipped s49 (2026-07-21), implementing `adr/006` Phase 1. This is the
> behaviour-change companion to `gate-reads-oracle-definitions-from-worktree.md`
> (the s48 audit finding this closes). Read both before touching the contract-zone
> contour.

## The change in one line

The machine gate now reads oracle **definitions** (`INVARIANTS.md` contract zones,
`GUARDS.md` + recipe JSON, and the constitution path list) from the **trusted root**
(`repoRoot`), while still **executing** everything (check command, success commands,
agent-ci, the mutation run) against the per-task **worktree**.

## Three consequences that will surprise you

### 1. A task that ADDS a contract zone no longer self-enforces it in the same run

The gate judges the diff against the **previous, trusted** oracle. A new zone
governs only after it reaches the main tree (an operator bless). This is
`adr/006` §4 — the removal of a reward-hacking surface, not a regression: "the new
zone I just wrote enforces me" was exactly the loop a worker could close by
weakening the zone in the same diff.

### 2. A scaffolded project's gate stops being vacuous — it starts really escalating

`.autodev/` is git-excluded, so `.autodev/INVARIANTS.md` was **absent from every
worktree** and the gate read `EMPTY_INVARIANTS` — zero zones, nothing enforced
(audit Finding 3). Any project that declared zones and appeared to pass was passing
**vacuously**. After Phase 1 those zones are live.

Verified live s49 on `woodev-shipping-plugin-test`: a zone `shipping-method-ids`
declared **only** at the trusted root, over a file the worker edited, produced
`decision: ESCALATE`, `reasons: ["zone 'shipping-method-ids' touched (path/grep, no
enumerated value) but no mutation-verified guard covers it (needs guard)"]` — with
no INVARIANTS file present in the worktree at all. The same run pre-Phase-1 would
have committed.

### 3. Fail-closed needs the RAW config, not the parsed one

`HarnessConfigSchema` **defaults** `contract.invariantsFile`/`guardsFile`, so the
parsed `cfg` cannot distinguish "the operator configured an oracle" from "the schema
filled in a default". The fail-closed rule (configured-but-unreadable → throw;
not-configured-and-absent → empty, legitimate) therefore hinges on
`isContractFileConfigured(raw, key)` reading the **pre-defaults** YAML — same shape
and same reason as `isPlannerExplicitlyConfigured`. Using `cfg` here would make
every project without an `INVARIANTS.md` fail closed, i.e. break everything.

## The migration trap this created (and how it is handled)

The scaffold has always written `contract.guardsFile: .autodev/GUARDS.md` into
`config.yaml` but **never created the file**. Under fail-closed that combination
throws on every task — i.e. shipping Phase 1 alone would have bricked every
already-registered project (our own live test project included).

`ensureContractStubs` (startup migration, `serve` only) heals it, but **only
`guardsFile`, never `invariantsFile`** — and the asymmetry is the whole point:

| Missing file | Degrades to | Direction |
|---|---|---|
| `GUARDS.md` | no guards → a touched auto_guardable zone reads UNCOVERED → **escalate** | safe → safe to auto-heal |
| `INVARIANTS.md` | no zones → nothing enforced → **COMMIT** | unsafe → must stay fail-closed, operator's call |

Auto-creating an empty `INVARIANTS.md` would have converted a fail-closed error into
a silent vacuous pass — the exact failure Phase 1 exists to remove (codex caught this
on the re-critic round, after the first fix healed both files).

Healing is deliberately **laxer than the broken-config state** (a task touching no
auto_guardable zone now commits where the broken config escalated everything). That
blanket escalation was breakage, not a guarantee; healing restores the zero-guards
oracle the project always had.

## Containment: a lexical `join` is not a trusted root

"Read it from `repoRoot`" is not a guarantee by itself. `join(root, rel)` clamps
neither a `..` segment nor an **intermediate symlinked ancestor**, and `readFile`
follows links — so a configured path, or a link planted in the tree, could still
resolve into a worker-controlled worktree. Both the oracle read path and the
stub-write path go through `src/util/path-contain.ts` (`realpath` both sides, then
compare) — same lesson as `static-file-serving-symlink-traversal.md`, and the first
fix round leaked it right back into the new write path. Windows extras baked into
that helper: case-insensitive compare on `win32` only (POSIX folding would be a real
weakening), and strip **all** trailing separators so a drive root (`C:\`) does not
build a `C:\\` prefix that rejects every legitimate child.

**Accepted residual:** the TOCTOU window between the `lstat`/`realpath` checks and
the later `readFile`-by-path. Exploiting it needs an actor that mutates the trusted
root mid-operation; the worker writes only its own worktree. Identical in kind to
the accepted `realpath`→`open` residual in `static-file-serving-symlink-traversal.md`
(closing it needs `openat2`, not portable in Node).

## Still open (Phase 2)

Phase 1 closes **definition** tampering only. The **contents of executable oracle
inputs** — guard test files, `success_command` scripts, agent-ci workflow
implementations — still run from the worktree by design and remain worker-writable
if they sit in a task's `file_set`. That is the protected-paths model, `adr/006`
Phase 2.

## Related

- `gate-reads-oracle-definitions-from-worktree.md` — the s48 audit finding this closes.
- `adr/006-capability-based-authority-model.md` — the model + the phase plan.
- `wiki/authority-model-audit-2026-07.md` — Findings 1/2/3/5 with file:line evidence.
- `PRINCIPLES.md` — #14 (the worker does not write its own oracle), #10 (fail safe).
- `static-file-serving-symlink-traversal.md` — the realpath-containment precedent.
- `harness-on-real-repo-prerequisites.md` — why a stub write must be git-ignored.
