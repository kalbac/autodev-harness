# shadcn (Base UI) UI Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the entire dashboard UI on shadcn's Base UI foundation with the default zinc look, screen by screen, without breaking the app at any point.

**Architecture:** PR0 lays the foundation — `shadcn init` (Base UI, zinc), a reconciled `styles.css` that keeps IBM Plex fonts + the functional status vocabulary + a **legacy-token alias layer** so the ~29 files using `bg-surface`/`text-muted`/etc. instantly render zinc. Primitives under `components/ui/*` are swapped to shadcn while preserving export signatures so all call sites keep compiling. PR1–PR5 then convert one screen group at a time from legacy token classes to canonical shadcn tokens and restructure with shadcn primitives, each a gated PR.

**Tech Stack:** React 19, Vite 6, Tailwind CSS v4, shadcn CLI v4.11.0 (Base UI), `class-variance-authority`, `lucide-react`, `@fontsource` (IBM Plex).

---

## Governing principle (applies to EVERY task)

**shadcn-first.** Before writing or keeping any custom component, verify shadcn has no equivalent; state which component/block you checked and why it doesn't fit. A composition of shadcn primitives is NOT custom. Only genuinely novel widgets (e.g. `DiffView`) stay custom, and only after verification. See spec §3.

## Verification approach (why not unit TDD)

This is a visual, like-for-like migration — there is no new business logic to unit-test. The automated gate for every task is:
- `npm run typecheck` (`tsc --noEmit`) — must pass with zero errors.
- `npm run build` (`tsc --noEmit && vite build`) — must produce `../dist/ui`.

Every screen PR additionally requires a **browser-verify**: run `npm run dev` (proxies to the daemon on `127.0.0.1:4319`), open the screen, confirm it renders in both light and dark and behaves as before. Each PR closes with a **codex GPT-5.5 critic review** (per `AGENTS.md`) before the gated merge.

Run all `npm` commands from `ui/`.

## Token mapping reference (shared artifact — used by every conversion task)

Legacy Tailwind class → canonical shadcn class. During PR0 the legacy classes keep working via alias; PR1–PR5 rewrite them to the canonical column.

| Legacy class | Canonical shadcn | Meaning |
|---|---|---|
| `bg-ink` | `bg-background` | app background |
| `bg-panel` | `bg-sidebar` (fallback `bg-card`) | sidebar / rails |
| `bg-surface` | `bg-card` | cards |
| `bg-surface-2` | `bg-muted` | raised / hover |
| `border-line` | `border-border` (or bare `border`) | hairline |
| `border-line-strong` | `border-border` | stronger hairline |
| `text-text` | `text-foreground` | primary text |
| `text-muted` | `text-muted-foreground` | secondary text |
| `text-subtle` | `text-muted-foreground` | tertiary text |
| `text-accent` / `bg-accent` / `border-accent` | `text-primary` / `bg-primary` / `border-primary` | interactive |
| `font-display` | `font-sans` | (display font dropped in PR0) |

**Status vocabulary is NOT remapped** — `text-working/uncertain/broken/clean` and the `--color-*` status vars stay literal (they carry meaning, not chrome) and remain available as Tailwind utilities + `Badge` variants.

---

## PR0 — Foundation  ✅ DONE — merged to main (s29). Critic found+fixed token-alias collision + TabBar accent; re-critic clean. Live browser-verify deferred to operator.

**Outcome:** whole app compiles, builds, and renders in the zinc default look. No screen restructured yet.

### Task 0.1: Initialize shadcn (Base UI, zinc)

**Files:** Create `ui/components.json`; shadcn will touch `ui/src/styles.css` (reconciled in 0.2).

- [ ] **Step 1: Run init non-interactively**

Run (from `ui/`):
```bash
npx shadcn@latest init --template vite --base base --base-color zinc --css-variables --yes
```
Expected: creates `components.json`, writes shadcn zinc theme variables (`:root` + `.dark`) and an `@theme inline` block into `src/styles.css`, confirms `@/` alias + `cn` are detected.

- [ ] **Step 2: Verify config**

Confirm `components.json` contains `"baseColor": "zinc"`, Base UI as the primitive base, `"cssVariables": true`, and aliases pointing at `@/components` + `@/lib/utils`.

- [ ] **Step 3: Commit**

```bash
git add ui/components.json ui/src/styles.css ui/package.json ui/package-lock.json
git commit -m "chore(ui): shadcn init — Base UI, zinc, css variables"
```

### Task 0.2: Reconcile `styles.css` (fonts + status vocab + legacy aliases)

**Files:** Modify `ui/src/styles.css`.

The init overwrote our custom `@theme`. Keep shadcn's generated `:root`/`.dark`/`@theme inline`, then re-apply our three concerns on top.

- [ ] **Step 1: Re-declare IBM Plex fonts and status vocabulary**

In the shadcn `@theme inline` block (or a dedicated `@theme` block after it), add:
```css
@theme inline {
  /* ...shadcn-generated mappings stay above... */

  /* Fonts — IBM Plex (bundled offline via @fontsource; Space Grotesk dropped). */
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", monospace;

  /* Functional status vocabulary — meaning, not chrome. Kept literal in both themes. */
  --color-working: #e8833a;
  --color-uncertain: #e0a324;
  --color-broken: #e5484d;
  --color-clean: #3fb68b;

  /* Legacy-token alias layer → shadcn zinc tokens (lets the ~29 unconverted
     files render zinc until PR1–PR5 rewrite them to canonical classes). */
  --color-ink: var(--background);
  --color-panel: var(--card);
  --color-surface: var(--card);
  --color-surface-2: var(--muted);
  --color-line: var(--border);
  --color-line-strong: var(--border);
  --color-text: var(--foreground);
  --color-muted: var(--muted-foreground);
  --color-subtle: var(--muted-foreground);
  --color-accent: var(--primary);
}
```

- [ ] **Step 2: Restore the working-pulse keyframe + reduced-motion guard**

Re-add below the theme block (these were in the pre-init file):
```css
@keyframes status-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-working) 55%, transparent); }
  50% { opacity: 0.7; box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-working) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS, `../dist/ui` produced.

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(ui): reconcile theme — IBM Plex, status vocab, legacy-token aliases"
```

### Task 0.3: Drop Space Grotesk, switch `font-display` → `font-sans`

**Files:** Modify `ui/src/main.tsx`, `ui/package.json`, and the 12 files using `font-display` (EscalationCard, ProjectTopBar, RegisterForm, SessionRail, SettingsLayout, Sidebar, BoardView, HomeView, NewProjectView, RunView ×2, TaskDetailView).

- [ ] **Step 1: Remove Space Grotesk imports from `main.tsx`**

Delete these three lines:
```ts
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
```

- [ ] **Step 2: Remove the dependency**

In `ui/package.json` delete the `"@fontsource/space-grotesk": "^5.1.0"` line, then run `npm install`.

- [ ] **Step 3: Replace every `font-display` occurrence with `font-sans`**

Run (from `ui/`):
```bash
grep -rl "font-display" src | xargs sed -i 's/font-display/font-sans/g'
```
Then confirm none remain: `grep -rn "font-display" src` → no output.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.tsx ui/package.json ui/package-lock.json ui/src
git commit -m "refactor(ui): drop Space Grotesk display font, fold into font-sans"
```

### Task 0.4: Switch theme plumbing to shadcn `.dark` convention

**Files:** Modify `ui/src/lib/theme.ts`.

- [ ] **Step 1: Simplify `applyTheme` to toggle only the `.dark` class**

Replace the body of `applyTheme` with:
```ts
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}
```
Update the file's doc comment to note shadcn's `:root` (light) + `.dark` (dark) convention; the `[data-theme]` attribute is no longer used.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/theme.ts
git commit -m "refactor(ui): theme toggles shadcn .dark class (drop data-theme attr)"
```

### Task 0.5: Add shadcn primitives

**Files:** Creates `ui/src/components/ui/{button,card,tabs,badge,dialog,dropdown-menu,popover,tooltip,input,select,separator,scroll-area,sonner,skeleton,alert,progress}.tsx`.

- [ ] **Step 1: Install the core set**

Run (from `ui/`):
```bash
npx shadcn@latest add button card tabs badge dialog dropdown-menu popover tooltip input select separator scroll-area sonner skeleton alert progress --yes
```
Expected: files land under `src/components/ui/`. If any is missing from the Base UI registry, note it in the commit body and pull it with `--base radix` or hand-roll — do not block.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (new files are unused so far).

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/ui ui/package.json ui/package-lock.json
git commit -m "feat(ui): add shadcn Base UI primitives (button, card, tabs, badge, …)"
```

### Task 0.6: Replace `Button` (signature-preserving)

**Files:** Modify `ui/src/components/ui/Button.tsx` (2 call sites: keep the `primary|default|ghost|outline` + `sm|md|icon` API).

- [ ] **Step 1: Re-implement on shadcn button variants, mapping our names**

Replace `Button.tsx` so our variant names delegate to shadcn's underlying classes:
```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// Our public API (primary/default/ghost/outline · sm/md/icon) mapped onto shadcn's
// default zinc button look. primary→shadcn default, default→secondary.
const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        default: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
      },
      size: { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5", icon: "h-8 w-8" },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/ui/Button.tsx
git commit -m "refactor(ui): Button on shadcn zinc variants (API preserved)"
```

### Task 0.7: Rebuild `Card`, `TabBar`, `StatusPill`, `Dot`, `Feedback` on shadcn (signature-preserving)

**Files:** Modify `ui/src/components/ui/{Card,Tabs,StatusPill,Dot,Feedback}.tsx`. Call sites (Card 0, TabBar 2, StatusPill 7, Dot 5, Feedback 12) must keep compiling — do not change any exported name or prop.

- [ ] **Step 1: `Card` → wrap shadcn card**

Keep exports `Card`, `CardHeader`, `CardBody`. Re-implement `Card` with `bg-card border-border`, `CardHeader` with `border-b border-border`, `CardBody` unchanged (padding only). (shadcn's own `card.tsx` has `CardContent`; we keep our `CardBody` name to avoid touching call sites.)

- [ ] **Step 2: `Dot` and `StatusPill` — keep tone-driven tint, on `Badge` where possible**

`Dot` stays as-is (it already uses `toneVar` + the pulse keyframe; both survive). Re-express `StatusPill` as a shadcn `Badge` (`variant="outline"`) that keeps the inline tone tint via `toneVar[tone]` (a Badge composition, not a custom component — see shadcn-first). Keep props `{ tone, label, pulse, className }`.

- [ ] **Step 3: `Feedback` — `ErrorState` on shadcn `Alert`**

Keep exports `Spinner`, `Loading`, `EmptyState`, `ErrorState`. Re-implement `ErrorState` using shadcn `Alert` (`variant="destructive"`); `EmptyState` uses `bg-card border-border text-muted-foreground`; `Spinner`/`Loading` keep `lucide` `Loader2`.

- [ ] **Step 4: `TabBar` — on shadcn `Tabs`**

Re-implement `TabBar({ tabs, value, onChange, className })` as a thin adapter over shadcn `Tabs`/`TabsList`/`TabsTrigger` (controlled via `value`/`onValueChange`). Preserve the `TabDef.accent` option by applying it to the active trigger. (Adapter over a shadcn primitive — not custom.)

- [ ] **Step 5: Verify build + typecheck**

Run: `npm run build`
Expected: PASS, no type errors across the 26 call sites.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/ui
git commit -m "refactor(ui): Card/Tabs/StatusPill/Feedback on shadcn primitives (APIs preserved)"
```

### Task 0.8: Mirror shadcn-first into `AGENTS.md`

**Files:** Modify `AGENTS.md`.

- [ ] **Step 1: Add a "UI: shadcn-first" rule**

Add a short section: default to shadcn/Base UI primitives + blocks; a composition of primitives is not custom; genuinely novel widgets (e.g. `DiffView`) stay custom only after verifying the registry has no equivalent, and must state what was checked.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md — UI shadcn-first rule"
```

### Task 0.9: PR0 gate

- [ ] **Step 1: Browser-verify** — `npm run dev`, click through every screen; confirm each renders in zinc, light + dark toggle works, nothing is visually broken.
- [ ] **Step 2: Critic review** — run the codex GPT-5.5 critic on the PR0 diff; address findings; re-critic in-place fixes.
- [ ] **Step 3: Open PR, merge after green CI + gate.**

---

## PR1–PR5 — Per-screen conversion

Each screen task follows the **same recipe**. It is repeated here once; every task below points to it.

> **Conversion recipe (per file):**
> 1. Read the file. List each legacy token class it uses.
> 2. Rewrite each to its canonical shadcn class per the **Token mapping reference** table above. Leave status classes (`text-working` etc.) literal.
> 3. Replace ad-hoc structural markup with shadcn primitives where one fits (buttons→`Button`, panels→`Card`, menus→`DropdownMenu`, overlays→`Dialog`/`Popover`, hovers→`Tooltip`, inputs→`Input`/`Select`). Apply shadcn-first: if tempted to keep bespoke markup, name the shadcn primitive you checked.
> 4. `npm run typecheck` → PASS.
> 5. Commit the file.
> After all files in the group: `npm run build` → PASS, browser-verify the screen (light+dark), critic review, gated merge.

### Worked exemplar — `TaskCard.tsx` (do this first in PR2, follow its shape everywhere)

- [ ] **Step 1: Convert tokens.** e.g. `bg-surface`→`bg-card`, `border-line`→`border-border`, `text-muted`→`text-muted-foreground`, `text-text`→`text-foreground`. Keep `text-broken`/`text-uncertain` (guard/status) literal.
- [ ] **Step 2: Structure.** Wrap the card body in shadcn `Card`/`CardContent`; render the status as `<StatusPill>` (already shadcn `Badge` after PR0); any action button → `<Button variant="ghost" size="icon">`.
- [ ] **Step 3:** `npm run typecheck` → PASS.
- [ ] **Step 4:** `git add ui/src/components/TaskCard.tsx && git commit -m "refactor(ui): TaskCard on shadcn tokens + primitives"`.

### PR1 — App shell + navigation  ✅ DONE — merged to main (s29). Critic: all PASS, 0 findings.

Apply the recipe to, one commit each: `AppShell.tsx`, `Sidebar.tsx`, `ProjectTopBar.tsx`, `ProjectSwitcherMenu.tsx`, `SessionRail.tsx`.
- `ProjectSwitcherMenu` → shadcn `DropdownMenu`. `SettingsPopover` (if touched here) → shadcn `Popover`.
- [ ] Convert `AppShell.tsx` (recipe) · [ ] `Sidebar.tsx` · [ ] `ProjectTopBar.tsx` · [ ] `ProjectSwitcherMenu.tsx` (DropdownMenu) · [ ] `SessionRail.tsx`
- [ ] `npm run build` → PASS · [ ] browser-verify shell (light+dark) · [ ] critic review · [ ] gated merge.

### PR2 — Board  ✅ DONE — merged to main (s29). Critic: 2 High + 3 Medium fixed (light-mode layers/hover, legacy inline vars), re-critic PASS.

Apply the recipe to: `TaskCard.tsx` (exemplar above), `ProjectRow.tsx`, `BoardView.tsx`.
- [ ] `TaskCard.tsx` · [ ] `ProjectRow.tsx` · [ ] `BoardView.tsx`
- [ ] `npm run build` → PASS · [ ] browser-verify Board (light+dark) · [ ] critic review · [ ] gated merge.

### PR3 — Run (includes VerdictSeal rebuild + DiffView)

Apply the recipe to: `RunView.tsx`, `Inspector.tsx`, `EscalationCard.tsx`, `DigestStrip.tsx`, `DiffView.tsx`, plus the `VerdictSeal.tsx` rebuild.

- [ ] **VerdictSeal → shadcn composition.** Rebuild `VerdictSeal.tsx` keeping its props (`verdict`, `confidence`, `notes`, `brokenContracts`, `compact`, `className`): verdict as a `Badge` tinted by `verdictTone` (clean→`--color-clean`, broken→`--color-broken`/`variant="destructive"`, uncertain→`--color-uncertain`); `confidence` as shadcn `Progress`; `notes` as text; `brokenContracts` as an `Alert` list. The old inset mono-stamp is intentionally dropped (spec §4.2).
- [ ] **DiffView.** Genuinely novel (no shadcn diff viewer — verified). Keep custom; only convert its token classes to canonical shadcn and wrap chrome in `Card`/`ScrollArea`.
- [ ] `RunView.tsx` · [ ] `Inspector.tsx` · [ ] `EscalationCard.tsx` · [ ] `DigestStrip.tsx` · [ ] `DiffView.tsx` · [ ] `VerdictSeal.tsx`
- [ ] `npm run build` → PASS · [ ] browser-verify a run with a verdict + a diff (light+dark) · [ ] critic review · [ ] gated merge.

### PR4 — Task detail

Apply the recipe to: `TaskDetailView.tsx`, `NewRunComposer.tsx`.
- `NewRunComposer` inputs → shadcn `Input`/`Select`/`Textarea` (add `textarea` via `npx shadcn add textarea` if a multiline field exists).
- [ ] `TaskDetailView.tsx` · [ ] `NewRunComposer.tsx`
- [ ] `npm run build` → PASS · [ ] browser-verify (light+dark) · [ ] critic review · [ ] gated merge.

### PR5 — Settings + onboarding

Apply the recipe to: `GlobalSettingsView.tsx`, `ProjectSettingsView.tsx`, `SettingsLayout.tsx`, `SettingsPopover.tsx`, `NewProjectView.tsx`, `RegisterForm.tsx`, `FolderBrowser.tsx`, `RuntimeFileView.tsx`, `HomeView.tsx`.
- `SettingsPopover` → `Popover`; form fields → `Input`/`Select`; `FolderBrowser`/`RuntimeFileView` chrome → `ScrollArea`/`Card`.
- [ ] `GlobalSettingsView.tsx` · [ ] `ProjectSettingsView.tsx` · [ ] `SettingsLayout.tsx` · [ ] `SettingsPopover.tsx` · [ ] `NewProjectView.tsx` · [ ] `RegisterForm.tsx` · [ ] `FolderBrowser.tsx` · [ ] `RuntimeFileView.tsx` · [ ] `HomeView.tsx`
- [ ] `npm run build` → PASS · [ ] browser-verify each (light+dark) · [ ] critic review · [ ] gated merge.

---

## Final cleanup (end of PR5)

- [ ] **Remove the legacy-token alias layer** from `styles.css` (the `--color-ink/panel/surface/...` → shadcn-var block from Task 0.2). Run `grep -rnE "bg-ink|bg-panel|bg-surface|bg-surface-2|border-line|text-text|text-muted\b|text-subtle" ui/src` → must be empty; fix any stragglers, then delete the alias block.
- [ ] Keep the status vocabulary vars (`--color-working/uncertain/broken/clean`) and the pulse keyframe.
- [ ] `npm run build` → PASS · commit `refactor(ui): drop legacy-token alias layer — fully on shadcn tokens`.

## Success criteria (from spec §8)

- No custom re-implementation of anything shadcn provides (shadcn-first honored; only `DiffView` remains custom, justified).
- Every screen on shadcn/Base UI zinc primitives, light + dark.
- `@fontsource/space-grotesk` gone; no CDN font/asset dependency.
- App compiles, builds, and every screen is browser-verified after each PR.
