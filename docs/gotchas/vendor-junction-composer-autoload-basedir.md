# Gotcha — provisioning `vendor` as a junction breaks Composer's autoloader `$baseDir` (runtime phpunit fatals in the worktree)

**Tag:** `[worktree/vendor-junction-autoload-basedir]` · **Found:** s21 (2026-07-04), the woodev deps-provisioning ops-proof (Task 9). Reproduced deterministically (harness run + standalone repro).

## The trap

Deps-provisioning links a gitignored `vendor/` into each per-task worktree as an NTFS **junction**
(`[worktree/win-junction-follow]`). Composer's generated autoloader
(`vendor/composer/autoload_static.php` / `autoload_classmap.php`) computes its `$baseDir` from the
autoloader file's own location: `$vendorDir = dirname(__DIR__); $baseDir = dirname($vendorDir);`.

On Windows, **PHP resolves `__DIR__`/`__FILE__` through a junction to the junction's REAL target.**
So when the worktree runs code that autoloads a project class, `__DIR__` inside
`worktree/vendor/composer/autoload_*.php` resolves to `D:\...\<main-clone>\vendor\composer`, and
`$baseDir` becomes the **main clone**, not the worktree. The classmap therefore loads the project's
own classes (`woodev/…`) from the **main clone**, while worktree-relative `require_once`/`__DIR__`
paths inside the framework load the **worktree** copy of the same file. The same class is declared
from two absolute paths →

```
Fatal error: Cannot redeclare class Woodev_Packer
  (previously declared in ...\.autodev\worktrees\<task>\woodev\box-packer\abstract-class-packer.php:3)
  in D:\...\<main-clone>\woodev\box-packer\abstract-class-packer.php on line 3
```

→ PHP exits **255**, so a `composer check` gate whose `@test:unit` step **executes** the framework
(phpunit loading a real plugin fixture through the resolver) FAILS in the worktree **even though the
identical `composer check` is green on the main tree**.

## What is and isn't affected

- **Static analysis is fine.** `php -l`, **phpcs**, and **phpstan** read files by PATH (phpstan
  `paths:` are cwd-relative to the worktree; phpcs sniffs `./woodev`); they don't execute the project's
  Composer classmap, so no double-declare. Both ran **green** in the junction-provisioned worktree.
- **Runtime execution breaks.** phpunit (or anything that instantiates the plugin and lets the
  autoloader + framework `require_once` both fire) hits the redeclare fatal.

## The precondition, found by a project where it does NOT bite (s63)

The rule below was stated as "a runtime gate fatals over a junction". That is too broad, and
believing it would have cost a real capability. The fatal needs a **specific precondition**:
the project's OWN classes must be loaded by **Composer's** generated classmap, because that is
what makes `$baseDir` resolve through the junction to the main clone while a worktree-relative
`require_once` loads the second copy. No Composer-autoloaded project classes, no double
declaration, no fatal.

Measured on `woodev-base-theme` (s63, the first real operator repository): `composer test:unit`
in a junction-provisioned worktree ran **396 tests / 1254 assertions, exit 0, ~2s** — green,
where s21's plugin fatally exited 255. The theme differs in exactly the way that matters:

- it autoloads its own classes with its **own** `inc/autoload.php`, not Composer's classmap;
- `autoload-dev` maps only the **tests** namespace (`Woodev\Theme\Base\Tests\` -> `tests/php/`),
  and those files live in the worktree, not behind the junction;
- its unit suite **mocks** WordPress with Brain\Monkey instead of booting it, so the framework
  `require_once` half of the double-load never runs either.

So the question to ask before choosing a static gate is not "does this gate execute code?" but
**"does this gate execute code whose classes Composer autoloads?"** — and it is answered by
running it once in a real junctioned worktree, which takes seconds. Do not infer the answer
from the project's language or from the presence of a `vendor/` directory; a theme, a
mu-plugin, or anything shipping its own autoloader can legitimately take the runtime gate, and
a runtime gate judges the change by the project's OWN test suite, which is a far stronger bar
than a linter.

## The rule

For a gate over a **junction-provisioned `vendor`** whose project classes are **Composer-autoloaded**,
use a **read-by-path static gate**
(`composer lint` / `phpstan`, or a combined `check:static: [@phpcs, @phpstan]` script) — NOT the full
`composer check` that runs phpunit. A runtime phpunit gate needs **per-worktree `vendor` materialization**
(a real copy, or `composer dump-autoload` regenerated with the worktree as `$baseDir`) so the classmap
resolves inside the worktree — that is real scope (defeats the zero-copy point of junction provisioning),
backlogged. The s21 ops-proof reached a green COMMIT with `gate.checkCommand: composer check:static`.

## Repro (minimal)

1. `git worktree add wt <branch>`; junction `wt/vendor -> <main>/vendor` (PowerShell `New-Item -ItemType Junction`).
2. In `wt`, run a phpunit test that loads a plugin through the framework resolver → `Cannot redeclare` / exit 255.
3. Same test on the main tree → green. Only the junction'd worktree fatals.

**Run the same three steps on any new project before assuming the fatal applies** — step 2 going
green is the whole answer, and it is the difference between a linter gate and a gate that runs
the project's own suite. Tear the probe worktree down link-safely (unlink the junction
non-recursively FIRST, verify it is gone, only then `git worktree remove`), or the teardown
deletes the real `vendor/` — see `[worktree/win-junction-follow]` below.

## Related

- `docs/gotchas/win-git-worktree-remove-follows-junction.md` — `[worktree/win-junction-follow]`, the sibling junction hazard (recursive delete follows the link; also reconfirmed live in s21 when a NON-link-safe manual `rmdir` + `git worktree remove --force` wiped the disposable clone's real `vendor/` — use link-safe removal: PowerShell `(Get-Item link).Delete()` or the harness `removeLinkOnly`, never bash `rmdir` on a live junction).
- `docs/gotchas/harness-on-real-repo-prerequisites.md` — `[conductor/real-repo-run]` (the reason provisioning exists).
- `docs/superpowers/plans/2026-07-02-p3-deps-provisioning.md` — Task 9 (the ops-proof this surfaced during).
