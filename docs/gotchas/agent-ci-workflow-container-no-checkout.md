# `[gate/agent-ci-workflow-container-no-checkout]`

**For a workflow to actually RUN under `@redwoodjs/agent-ci`, shape it as a `container:` job with the tools pre-installed and NO `actions/checkout` — agent-ci mounts the workspace, and both `setup-*` marketplace actions and `checkout` fail in its local runner.**

Empirically tested in WSL (s41), running the same php-lint workflow three ways via `npx @redwoodjs/agent-ci@0.16.2 run --workflow <path> --json`:

| Workflow shape | Result under agent-ci |
|---|---|
| `runs-on: ubuntu-latest` + `actions/checkout@v4` + `shivammathur/setup-php@v2` | checkout PASSES, **`setup-php` FAILS** → job failed (it downloads PHP; agent-ci's runner can't) |
| `container: php:8.3-cli` + `actions/checkout@v4` + `php -l` | **`checkout` FAILS** (the php image has no git/node) → lint skipped |
| **`container: php:8.3-cli` + (no checkout) + `php -l` loop** | **PASSES** — agent-ci mounts the repo into the job workspace, so `find \| php -l` sees every file |

So the CI gate workflow (`ci.yml`, allowlisted in `gate.agentCi.workflows`) must:
- run inside an image that ALREADY has the toolchain (`container: php:8.3-cli`), not install it via a marketplace action;
- **omit `actions/checkout`** — agent-ci provides the workspace (a checkout-less `container:` job would be VACUOUS on real GitHub, so this shape is optimized for the agent-ci gate, not dual-purpose GitHub CI);
- keep steps to plain `run:` shell that the container can execute.

The s41 `ci.yml` uses exactly this shape and ran green (5/5 steps, `run-finish: passed`, ~2.6s job) as the harness gate. The plugin's other pre-existing workflows (`php-lint.yml`, `php-test.yml`) do `composer install` with no `composer.json` present and would fail on real GitHub too — they are aspirational, not the gate.

Found s41.

## Related
- [[agent-ci-needs-github-remote-slug]] — the slug prerequisite for agent-ci to start at all.
- [[critic-before-ci-blocks-testless-repos]] — why reaching this CI step is hard in the first place.
- [[agent-ci-not-runnable-on-native-windows]] — agent-ci is WSL/Linux-only on Windows.
