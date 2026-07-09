# `[ui/base-ui-checkbox-wrapping-label]` — a sibling `<label htmlFor>` doesn't toggle a Base UI checkbox; wrap it in the label

**Tag:** `[ui/base-ui-checkbox-wrapping-label]`
**Found:** s36 (2026-07-09), RegisterForm Scaffold checkbox migration (codex-caught).

## Symptom / risk

Migrating the hand-rolled Scaffold checkbox (a `<label>` wrapping an `sr-only` native
`<input type=checkbox>` + a hand-drawn box) to the vendored base-nova `Checkbox`, the first
cut used the "modern" sibling pattern:

```tsx
<Checkbox id="rf-scaffold" checked={scaffold} onCheckedChange={setScaffold} />
<label htmlFor="rf-scaffold">Scaffold .autodev/ …</label>
```

Clicking the descriptive TEXT would NOT toggle the checkbox. Base UI's `Checkbox.Root`
renders (by default) a **`<span>` plus a hidden input** — and a `<label htmlFor="...">`
does not activate a plain `<span>`. So only clicking the small box toggles it, and the
visible text may not become the control's accessible label. (Codex flagged it Medium.)

## Fix

Wrap the `Checkbox` AND the text in ONE `<label>` (the classic pattern — and what the
original hand-rolled code already did):

```tsx
<label className="flex cursor-pointer items-start gap-2 …">
  <Checkbox checked={scaffold} onCheckedChange={setScaffold} className="mt-0.5" />
  <span>Scaffold <b>.autodev/</b> … .git/info/exclude</span>
</label>
```

Clicking anywhere in the label forwards to the labelable descendant (the checkbox's hidden
input), so box OR text toggles — a11y-correct.

Base UI's alternative (documented) sibling pattern requires making the root a real button:
`<Checkbox nativeButton render={<button />} id="…" />` + `<label htmlFor="…">`. The wrapping
label is simpler and was the right call here.

## Also (same primitive)

`onCheckedChange={setScaffold}` is SAFE: Base UI calls it `(checked: boolean, eventDetails)`,
and a React `Dispatch<SetStateAction<boolean>>` (arity 1) ignores the 2nd arg — so
`setScaffold` receives a plain boolean, never an event. (Verified + codex-confirmed.)

## Lesson

For a Base UI form control whose root renders a non-interactive element (span + hidden
input), **prefer a wrapping `<label>` over a sibling `htmlFor`** unless you explicitly make
the root a native button. Don't assume the shadcn "sibling label" examples apply to every
primitive — they assume a button-rooted control.

## Related

- `wiki/component-currency-audit-s35.md` — the Tier 2 migration (checkbox = item 2).
