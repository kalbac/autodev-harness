# Vendoring a shadcn component on Windows: the CLI fights per-file overwrite prompts + case-insensitive `button.tsx`↔`Button.tsx` collision

**Tag:** `[ui/shadcn-cli-vendor-windows]`
**Discovered:** s34 (2026-07-09), adding the `MessageScroller` component without the shadcn MCP.

## What happens

`npx shadcn@latest add <component>` is **interactive** and, on this project/OS, can't be driven
cleanly non-interactively:

1. It resolves the component's `registryDependencies` (e.g. `message-scroller` depends on `button`)
   and tries to (re)write them. This project has a **custom `Button.tsx`** (capital B) at
   `ui/src/components/ui/Button.tsx`. Windows' filesystem is **case-insensitive**, so shadcn's check
   for its stock `button.tsx` MATCHES the custom `Button.tsx` and prompts:
   `The file button.tsx already exists. Would you like to overwrite? (y/N)`.
   Answering `y` would **clobber the custom Button** with shadcn's stock zinc button.
2. `--yes` skips only the INITIAL "proceed?" confirmation — NOT the per-file overwrite prompts.
   Closing stdin (`< /dev/null`) also does not get past the overwrite prompt; the process hangs.
3. So the install stalls before writing ANY component file (it did add `@shadcn/react` to
   `package.json` first, which is fine — that's the primitive the component imports).

## The clean workaround (no MCP, no overwrite risk)

Fetch the component's registry item JSON directly and write ONLY its own file, skipping the
already-present `registryDependencies`:

```bash
# 1. the registry item (style = components.json "style", e.g. base-nova):
curl -s "https://ui.shadcn.com/r/styles/<style>/<component>.json" -o ms.json
# 2. it has files[].content (the raw source) + registryDependencies (already-present deps to SKIP)
node -e "const j=require('./ms.json'); require('fs').writeFileSync('ui/src/components/ui/<component>.tsx', j.files[0].content)"
# 3. install the npm dependency it declares (j.dependencies), if any:
cd ui && npm install
```

Then **rewrite the vendored file's site-internal aliases by hand** (this is what the CLI would have
done automatically — bypassing it means doing it yourself):
- `@/registry/<style>/lib/utils` → this project's `@/lib/utils`
- `@/registry/<style>/ui/button` → this project's `@/components/ui/Button` (capital B)
- any `@/app/(create)/components/icon-placeholder` (`IconPlaceholder`) → a real `lucide-react` icon
  (this project's `iconLibrary` is lucide) — the registry's `IconPlaceholder` is a shadcn.com
  *site-internal* component, NOT part of the installed component.
- map the component's Button `variant`/`size` to THIS project's custom `Button` cva API
  (ours: variant `primary|default|ghost|outline`, size `sm|md|icon` — NOT shadcn's
  `secondary`/`icon-sm`). Verify `npm run typecheck` after.

## Why it matters / how to avoid next time

The real fix is the **shadcn MCP** (wired into the project `.mcp.json` in s34, live next session) —
it does the alias rewrite + dependency resolution correctly and avoids the interactive CLI entirely.
Until then, or on any box where the MCP is unavailable, use the registry-JSON workaround above.
Relevant to the backlogged **component-currency audit** (which will vendor more components).

## Related

- `docs/gotchas/detect-executable-probe.md` `[detect/executable-probe]` — the sibling Windows
  case-insensitivity / `.cmd`-shim class of pitfall.
- `.mcp.json` — the project-level shadcn MCP entry added s34.
- `docs/FUTURE-BACKLOG.md` — "Wire the shadcn MCP" + "Component-currency audit".
