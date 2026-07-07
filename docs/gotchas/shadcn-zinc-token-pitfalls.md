# `[ui/shadcn-zinc]` — shadcn zinc token pitfalls (layering + alias collisions)

Discovered across the s29 shadcn (Base UI) migration — three distinct traps the codex critic caught repeatedly.

## 1. In zinc, some "surface" tokens are IDENTICAL — layers need a border or `bg-muted`

The default shadcn **zinc** theme deliberately collapses surfaces:
- **Light:** `--card` == `--background` == `oklch(1 0 0)` (pure white). Also `--popover` == `--background`.
- **Dark:** `--sidebar` == `--card` == `oklch(0.21 …)`.

Consequences (all were real critic findings):
- A `bg-card` region over the page **does not separate** in light mode without a `border`. `bg-card/40` columns over `bg-background` were nearly invisible → use **`bg-muted`** for a tinted container (distinct in both themes) and keep `bg-card` for the raised cards inside it.
- A `bg-sidebar` rail containing `bg-card` cards **does not separate by fill** in dark mode (sidebar==card) — it relies on the cards' borders. For an inspector/content panel prefer `bg-muted/40`; `bg-sidebar` is only right for a true nav rail.
- **Rule of thumb:** page(`background`) < panel(`muted`) < card(`card`) is the only 3-layer stack that reads in BOTH themes. Never rely on `bg-card` alone over the page.

## 2. `text-white` for hover/emphasis breaks in light mode

`group-hover:text-white` (a leftover from the old dark-only design) is white-on-white on a `bg-card` (white) surface in light mode → invisible. Use **`text-foreground`** (dark on white / light on dark).

## 3. Legacy-alias layers must NOT reuse shadcn's reserved token names, and a class-only sed misses inline vars

When bridging a bespoke design onto shadcn via a legacy-token alias layer (`--color-surface → var(--card)` etc.):
- **Never alias `--color-muted` or `--color-accent`** — shadcn owns those names (`--color-muted` = a muted **background** tint; `--color-accent` = neutral hover tint). A same-name alias in the `@theme inline` block wins by declaration order and **hijacks the primitives** (Button ghost hover, dropdown/menu focus) that use `bg-muted`/`bg-accent`. Migrate the legacy semantics off instead: old `text-muted` (meaning secondary text) → `text-muted-foreground`; legacy `*-accent` (strong interactive) → `*-primary` / `ring`.
- A global `sed` that rewrites the **class** `text-muted`→`text-muted-foreground` does **not** touch inline `style={{ color: "var(--color-muted)" }}` in JSX. After removing the `--color-muted` alias, such inline usages silently resolve to shadcn's muted **background** color used as text → wrong. When retiring an alias, grep for BOTH the Tailwind class and inline `var(--color-…)`.

## Related
- [[project-autodev-harness]] · migration spec/plan: `docs/superpowers/{specs,plans}/2026-07-06-shadcn-ui-migration*.md`
- The **shadcn-first** rule (verify shadcn has no equivalent before writing custom UI) lives in `AGENTS.md` + auto-memory `feedback-shadcn-first`.
