# `[ui/base-nova-ports-catalog-to-base-ui]` — the shadcn MCP's default-style metadata lies about deps; base-nova ships Base-UI ports of everything

**Tag:** `[ui/base-nova-ports-catalog-to-base-ui]`
**Found:** s35 (component-currency audit)

## The trap

Our `ui/components.json` style is **`base-nova`** (shadcn on **Base UI**, `@base-ui/react/*`).
When you ask the shadcn MCP (`view_items_in_registries` / item metadata) about a component,
it reports the **default-style** dependencies — and the default style is **Radix**. So `bubble`,
`item`, `marker`, `sidebar`, `collapsible`, `accordion`, `tabs`, `toggle-group`, `checkbox`,
`alert-dialog` all show a `radix-ui` dep in the MCP output. Taken at face value this reads as
"these components would pull Radix into our Base-UI project — foundation mismatch, don't adopt."

**That conclusion is wrong for this project.** The `base-nova` style ships **Base-UI ports** of
the whole catalog. Verified by fetching the raw per-style registry JSON:

```
curl -s https://ui.shadcn.com/r/styles/base-nova/<item>.json
```

Every one of the above imports `@base-ui/react/*` (or is dep-free) under `base-nova` — **none pull
Radix.** So there is **no radix-foundation trap**; effectively the entire catalog is a clean adopt
on our stack, and the real adoption filter is value / churn / behaviour-preservation, not
"radix vs base-ui."

## Rule

- Do NOT trust the shadcn MCP's default-style dep metadata to decide adoptability on a Base-UI
  (`base-nova`) project. It describes the Radix default, not our style.
- To know what a component ACTUALLY pulls on our stack, fetch the **style-specific** registry JSON
  (`.../r/styles/base-nova/<item>.json`) and read its `dependencies` / `registryDependencies` and
  the actual `import` lines in `files[0].content`.
- The MCP is still the right tool for discovery (catalog listing, audit checklist, add-command
  resolution) — just not for the radix-vs-base-ui foundation call.
- When briefing subagents to audit components, give them THIS fact, or they will (correctly, from
  the MCP metadata) tag half the catalog "FOUNDATION-COST" and wrongly recommend keeping hand-rolled.

## Related

- `docs/wiki/component-currency-audit-s35.md` — the audit this reframed.
- `docs/gotchas/shadcn-cli-vendoring-on-windows.md` — the manual-vendor fallback (curl the registry
  JSON, write `files[0].content`, rewrite aliases) — which is exactly how you inspect the style JSON.
- `[ui/shadcn-zinc]`, `[ui/light-theme-tokens]` — other shadcn-on-this-project token pitfalls.
