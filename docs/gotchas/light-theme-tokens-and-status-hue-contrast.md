# `[ui/light-theme-tokens]` — light theme via `[data-theme]` override; shared status hues are legible as DOTS but marginal as TEXT on light

**Tag:** `[ui/light-theme-tokens]`
**Seen:** s18 (2026-07-04), M5 light theme.

## How the light theme re-cascades (Tailwind 4)

The design tokens are declared in a plain `@theme { --color-*: … }` block
(`ui/src/styles.css`) — **not** `@theme inline`. With plain `@theme`, Tailwind 4
compiles utilities like `bg-surface`/`text-text` to `var(--color-surface)`
*references* (not the resolved hex). So the light theme is just an override block
that redefines the same custom properties:

```css
[data-theme="light"] { --color-ink: #eef1f5; --color-surface: #fff; … }
```

`lib/theme.ts` sets `data-theme="light"` on `<html>` (and drops the `.dark`
class), the vars re-cascade, and every utility repaints — no per-component work.
Specificity ties `:root` (0,1,0) but the override wins on source order (it's
unlayered and appears later). **If you ever switch to `@theme inline`, this
breaks** — inline bakes the hex at build time and the override no longer cascades.

Only the **chrome** is remapped (ink/panel/surface/line/text). Elevation is
inverted on purpose: main area = light slate, cards = white (brightest = raised),
sidebar just above the base, hover tints DARKEN (surface→surface-2) — the mirror
of dark mode.

## The caveat — status/verdict hues are shared, and that's fine ONLY for dots

The status vocabulary (`working`/`uncertain`/`broken`/`clean`/`accent`) is
deliberately **not** overridden — same hue in both themes so the "color is rare
and meaningful" language reads identically. That is correct **for dots, pills,
and tinted (color-mix 8–9%) seal backgrounds**, which is all the current screens
use them for.

But those hues were tuned for a dark bg. As **text on the light bg** they are
marginal-to-failing: `broken` `#e5484d` on white ≈ 4.2:1 (AA-large only; the 11px
error lines that use `text-broken` are borderline), and `uncertain` (amber) /
`clean` (jade) as text on white are genuinely low-contrast. Today nothing renders
amber/jade *as text*, so it's fine. **Rule for future light-mode surfaces:** if
you render a verdict tone as text (not a dot/tint) — e.g. a verdict line on a
white card — add light-tuned darker variants of those hues under
`[data-theme="light"]`; don't reuse the dark hex as text.

## Related

- `ui/src/lib/theme.ts` (switcher plumbing), `ui/src/lib/status.ts` (`toneVar`).
- `ui/src/styles.css` `@theme` + the `[data-theme="light"]` block.
