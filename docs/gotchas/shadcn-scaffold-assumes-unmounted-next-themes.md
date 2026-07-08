# `[ui/shadcn-scaffold-assumes-unmounted-next-themes]` — a shadcn-scaffolded primitive can silently depend on a doc-library provider that was never mounted

**Symptom (s32).** `ui/src/components/ui/sonner.tsx` (the shadcn `sonner` toast primitive, added by the shadcn
migration but never actually rendered until s32) called `useTheme()` imported from `"next-themes"` — a separate
theming library with its OWN `<ThemeProvider>` context. This project has its own theme system
(`@/lib/theme` — `localStorage` persistence + a `.dark` class toggled on `<html>`; no `next-themes` provider is
mounted anywhere in the app). Without a provider, `next-themes`' `useTheme()` returns its unconfigured default —
so the toast's theme would silently never have tracked the operator's real light/dark choice. This sat dormant
and unnoticed for the whole shadcn migration because the `<Toaster/>` was never actually rendered until this
session wired it up for the first time.

**Cause.** shadcn scaffold code (the CLI-generated primitive files) is written assuming a canonical Next.js /
`next-themes` setup. A project that rolls its own theme mechanism (as this one does — see
`[ui/light-theme-tokens]`) silently inherits a broken/no-op theme hook in any primitive that wasn't audited
against the actual app wiring. Because the component was unused, `tsc`/build never surfaced the mismatch (the
import resolves fine — `next-themes` IS a dependency, just never `<ThemeProvider>`-mounted).

**Fix:** swap the primitive's `useTheme` import to the project's real hook (`@/lib/theme`) before first use.

**Lesson:** when finally wiring up a shadcn-scaffolded primitive that has sat unused since the migration, don't
assume its boilerplate hooks (theme, router, etc.) match this project's actual providers — grep the primitive's
imports against what's ACTUALLY mounted at the app root (`main.tsx`) before trusting it compiles-and-therefore-works.
An unused component's import resolving is not the same as it being wired correctly.

## Related
- [[shadcn-zinc-token-pitfalls]] — the other class of "shadcn boilerplate vs our own conventions" gotcha (color tokens, not providers).
