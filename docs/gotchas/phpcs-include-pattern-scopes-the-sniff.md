# `[gate/phpcs-include-pattern-scopes-the-sniff]`

> A path-scoped exemption in a PHPCS ruleset scopes the **sniff**, not the property —
> so the shape that reads as "relax this rule only here" silently switches the rule
> **off everywhere else**. Found s65 on the operator's own theme.

## The situation

`adr/010` lets a project declare the ruleset its profile gate is judged by. In s65 the
operator's decision (`woodev-base-theme#52`) was that the WooCommerce template
overrides under `woodev-base-theme/woocommerce/` may name the `woocommerce` text
domain, so WooCommerce's own translation applies instead of being re-translated.

His `phpcs.xml.dist` forbade exactly that:

```xml
<rule ref="WordPress.WP.I18n">
  <properties>
    <property name="text_domain" type="array">
      <element value="woodev-base-theme"/>
    </property>
  </properties>
</rule>
```

Every carve-out call was `WordPress.WP.I18n.TextDomainMismatch`, so the task was
**unsatisfiable until the ruleset changed** — the project's own oracle contradicted the
project owner's own product decision. (That is not a defect in the harness: the
ruleset is a declared oracle inside the `adr/006` fence, so the worker could not
rewrite the standard it is judged by, which is the intended behaviour. It made the
resolution an operator act.)

## The trap

The obvious narrow fix is a second rule reference carrying an `<include-pattern>`, so
the two-domain list applies only inside the subtree:

```xml
<rule ref="WordPress.WP.I18n">
  <properties><property name="text_domain" type="array">
    <element value="woodev-base-theme"/>
  </property></properties>
</rule>
<rule ref="WordPress.WP.I18n">
  <include-pattern>woodev-base-theme/woocommerce/*</include-pattern>
  <properties><property name="text_domain" type="array">
    <element value="woodev-base-theme"/>
    <element value="woocommerce"/>
  </property></properties>
</rule>
```

Measured against real phpcs, on two fixtures carrying the same calls, one inside the
subtree and one outside:

| under the "path-scoped" ruleset | inside `woocommerce/` | outside |
|---|---|---|
| foreign domain (`'x', 'some-plugin'`) | ERROR | **nothing** |
| no `$domain` argument at all | ERROR | **nothing** |

`include-pattern` restricts which files **the sniff** runs on, not which files the
property applies to. Because both rule references name the same sniff, PHPCS merges
them and the include-pattern wins: i18n checking stops existing for the rest of the
theme, including the `MissingArgDomain` check — the one that catches a string silently
vanishing from the POT, which is the whole reason the rule is there.

So the ruleset **reads as a tightening and behaves as a switch-off**. Nothing reports
it. `composer phpcs` stays exit 0, which is precisely the tell that means nothing.

The other narrow shape — excluding the sniff for the subtree — is worse for the same
reason and more obviously so: it also blinds the missing-domain check in exactly the
files most likely to copy core.

## What to do instead

Accept that this sniff cannot express a path-scoped property, widen it globally, and
put the scope in a layer that *can* express it. In s65 that is the project's own
`I18nSourceTest`, which checks an exact allowlist of msgids (with context for `_x`)
**and** requires the file to be under the subtree. Both layers run in the same gate,
so the effective rule is their intersection — which is exactly the operator's decision,
even though neither layer states it alone.

Name the cost out loud where the change lives: phpcs alone no longer distinguishes a
`woocommerce` domain inside the overrides from one outside. Then prove the rest was
not relaxed — after the change, a foreign domain and a missing `$domain` argument are
still errors everywhere, and tree-wide phpcs is exit 0 over 119 files.

## Rules

- **A path-scoped exemption in a PHPCS ruleset is a claim about a sniff, not about a
  property.** If you are narrowing a rule "only for these files", check what the rule's
  OTHER checks do outside those files.
- **Measure the ruleset shape before proposing it.** This one was written up as "the
  technically correct form", presented to the operator as such, and was wrong — and
  only running it said so. Two fixtures and one `phpcs` invocation took under a minute.
- **A guard that stops reporting raises no alarm.** The same shape as
  `[gate/validator-after-normalizer]` and `[test/mutation-check-noop]`: the passing
  condition is met without the thing being checked ever happening. Probe with an input
  that MUST fail (a foreign domain, a missing argument) rather than confirming the case
  you want to allow.
- When a declared ruleset (`adr/010`) has to change to make an operator decision
  implementable, that is an **oracle change**: the operator blesses it and it is applied
  outside the worker's diff, never carried inside one (`PRINCIPLES.md` #14).

## Related

- `PRINCIPLES.md` #14 — the worker does not write its own oracle; #15 — the gate proves
  only formalized properties.
- `adr/010` — a project may declare the ruleset its gate is judged by.
- `gotchas/a-declared-ruleset-anchors-report-paths-elsewhere.md` — the other s63/s64
  surprise from the same mechanism: a declared ruleset also moves the frame of
  reference of the report it produces.
- `gotchas/a-validator-placed-after-its-normalizer.md`,
  `gotchas/mutation-check-that-did-not-mutate.md` — same family: a check that quietly
  stops checking.
- `gotchas/profile-gates-must-be-diff-scoped.md` — why a linter gate is line-scoped at
  all.
