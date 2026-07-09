# `[ui/twmerge-important-arbitrary-variant-no-dedupe]` — tailwind-merge doesn't dedupe an important + arbitrary-variant utility, so stylesheet order (not class order) wins

**Tag:** `[ui/twmerge-important-arbitrary-variant-no-dedupe]`
**Found:** s36 (2026-07-09), collapsed sidebar-footer gear bug.

## Symptom

The shadcn `sidebar` block's `SidebarMenuButton size="lg"` did NOT collapse to a clean
`size-8` square in the icon rail. Live DOM measurement: the collapsed button was `32×32`
but with `padding: 8px` (`p-2`), leaving a **16px content box** — so a `size-8` (32px)
icon-square child overflowed and was clipped by `overflow-hidden` to a `24px`-wide
vertical sliver, with the icon pushed off-center. Non-hover showed the clipped child bg
(vertical rectangle); hover showed the button's own bg (square), gear still shifted.

## Root cause

`sidebarMenuButtonVariants` builds (via cva, then `cn(...)`):

- base: `... p-2 ... group-data-[collapsible=icon]:p-2! ...`
- size `lg`: `h-12 ... group-data-[collapsible=icon]:p-0!`

The intent is that `lg`'s `group-data-[collapsible=icon]:p-0!` overrides the base
`group-data-[collapsible=icon]:p-2!` when collapsed. It DOESN'T. **tailwind-merge fails to
recognise `group-data-[collapsible=icon]:p-2!` and `group-data-[collapsible=icon]:p-0!` as
conflicting** — the combination of an `!important` marker AND an arbitrary `group-data-[...]`
variant slips past its conflict detection — so it keeps BOTH classes. With both emitted +
equal specificity + both `!important`, the winner is decided by **stylesheet order**, and
Tailwind emits `p-0` before `p-2`, so **`p-2` wins**. Result: the collapsed button keeps
8px padding instead of 0.

Adding your OWN `group-data-[collapsible=icon]:p-0!` in the component's `className` does NOT
help — same non-dedupe → same stylesheet-order outcome → `p-2` still wins.

## Fix (what we did)

Don't fight the padding. The block's DEFAULT-size menu buttons (New Project, the project
rows) collapse cleanly because a **`size-4` icon centers perfectly in the 16px content box**
that `p-2` leaves. So we replaced the footer's `size-8` accent-square wrapper with a bare
`<Settings className="size-4" />` — the native pattern the block's own buttons use, with
**zero collapse-conditional classes** (no `group-data-[collapsible=icon]:hidden`/`:size-4`
crutches — the operator explicitly flagged those as hacks). It centers by construction.

Trade-off accepted: the size-8 NavUser "avatar tile" look in the EXPANDED footer is gone
(a size-8 square fundamentally can't fit the 16px collapsed content while `p-0` is broken).
The canonical NavUser (dashboard-01 / sidebar-07) gets away with a size-8 avatar because
there `p-0` DOES win — evidently a tailwind-merge version / class-order difference; we did
not chase it down (see FUTURE-BACKLOG "option B" if the tile is wanted back).

## Lessons

- **A shadcn primitive collapsing wrong is not always your bug — it can be a tailwind-merge
  dedupe miss on `important` + arbitrary-variant utilities.** When an expected override
  silently doesn't apply, MEASURE the computed style (don't trust the class string); if the
  "losing" class is still applied, suspect a non-dedupe → stylesheet-order outcome.
- Prefer the primitive's **default-button** collapse mechanics (icon centered by the `p-2`
  content box) over the `size="lg"` avatar-tile mechanics (which need the fragile `p-0`).
- Never add a `group-data-[collapsible=icon]:hidden` to force a collapse — that fights the
  block's native `overflow-hidden` clip and is a crutch; restructure to the native pattern.

## Related

- `gotchas/shadcn-cli-vendoring-on-windows.md` — vendoring base-nova + the Button collision.
- `wiki/component-currency-audit-s35.md` — the Tier 2 migration this surfaced in.
