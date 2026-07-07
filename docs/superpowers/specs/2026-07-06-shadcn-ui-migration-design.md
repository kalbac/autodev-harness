# Design Spec — Full UI Migration to shadcn (Base UI)

> Status: **Approved design, pending spec review** · Session: s29 · Date: 2026-07-06
> Anchor: this replaces the bespoke "control room" UI with the **default shadcn look**,
> rebuilt on shadcn's **Base UI** foundation. See `docs/VISION.md` for the product thesis.

## 1. Problem

At project start the intent was "build the frontend on shadcn." In practice we only adopted
shadcn's *foundation idiom* — Tailwind + `class-variance-authority` + `cn()` + `lucide-react` —
and hand-wrote every component under `ui/src/components/ui/*`. There are **no** `@radix-ui/*`,
**no** `@base-ui-components`, and **no** `components.json`. The result: a fully custom design
language that does not look like, and is not built on, shadcn. The operator wants the UI to be
genuinely on shadcn, with the standard shadcn look.

## 2. Decisions (locked)

| Axis | Decision | Rationale |
|---|---|---|
| Visual target | **Default shadcn look** | Operator wants the standard shadcn aesthetic, not our bespoke "control room" identity |
| Foundation | **Base UI** (`init -b base`) | shadcn's default since 2026-07; we are greenfield (no Radix components to migrate) |
| Base color | **Zinc** | The classic shadcn default look |
| Fonts | **IBM Plex Sans + Mono**; drop Space Grotesk | Already bundled offline via `@fontsource` (no CDN — required for the localhost daemon); neutral enough to read as standard |
| Rollout | **Incremental, per-screen**, each screen a gated PR | Matches our critic-gate + batch-merge discipline (`AGENTS.md`); UI stays working throughout |
| Theme switching | Adopt shadcn `.dark` class convention | Replaces our current `data-theme="light"` attribute approach |

### Verified facts (Context7, shadcn CLI v4.11.0)
- `npx shadcn init --template vite` — Vite template exists; Base UI is the default primitive set as of the `2026-07-base-ui-default` changelog.
- `components.json` fields: `baseColor` ∈ {gray, neutral, slate, stone, zinc}, `cssVariables: true`, base ∈ {radix, base}.
- Our repo already satisfies shadcn prerequisites: `@/` path alias, `@/lib/utils` (`cn`), Tailwind v4, CSS variables.

## 3. Governing principle — **shadcn-first**

> Before writing **or keeping** any custom UI component, verify shadcn genuinely has no
> equivalent. shadcn-first is the default; custom is the exception and must be justified
> (state which shadcn component/block was checked and why it does not fit).

Clarifications that make the rule workable:
- A **composition of shadcn primitives is not a custom component** — it is the correct pattern.
  Examples: verdict display = `Badge` + `Progress` + `Alert`; usage viz = shadcn `Chart`.
- Only **genuinely novel widgets** with no shadcn/registry equivalent may stay custom, and only
  after explicit verification. Example: `DiffView` (a code-diff viewer — shadcn has no such
  component). Even then, style them with shadcn primitives/tokens.

This principle applies to every implementation PR and to subagents doing the work. It is mirrored
into `AGENTS.md` during PR0.

## 4. Target architecture

### 4.1 Foundation (PR0)
1. Run `npx shadcn init --template vite` in `ui/`. Produces `components.json`
   (`base: base`, `baseColor: zinc`, `cssVariables: true`).
2. **Reconcile, do not blind-accept.** `init` rewrites `styles.css`. Keep shadcn's generated
   zinc theme variables (`:root` + `.dark`), then re-apply on top:
   - IBM Plex as `--font-sans` / `--font-mono` (remove `@fontsource/space-grotesk` + `--font-display`).
   - The functional status vocabulary as layered semantic tokens (see 4.3).
   - The `status-pulse` keyframe + reduced-motion guard (still used by the single "working" dot).
3. Install core primitives:
   `button card tabs dialog dropdown-menu popover tooltip badge input select separator scroll-area sonner skeleton alert progress`.
4. Verify each needed primitive exists in the **Base UI** registry. For any gap: pull the Radix
   variant point-wise (they coexist) or hand-roll — and record the gap in the PR.

### 4.2 Primitive replacement (PR0)
Replace `ui/src/components/ui/*` with shadcn equivalents, **preserving each export's signature**
so the ~30 call sites keep compiling and the default look lands broadly at once. Per-view PRs
then refine layout/spacing to shadcn conventions.

| Current | → shadcn | Notes |
|---|---|---|
| `Button` (primary/default/ghost/outline; sm/md/icon) | `button` | Map variants: primary→default, default→secondary, ghost→ghost, outline→outline |
| `Card` | `card` | Direct |
| `Tabs` | `tabs` | Direct |
| `StatusPill` | `Badge` (+status variants) | See 4.3 |
| `Dot` | `Badge`/span dot | Keep minimal "working" pulse |
| `Feedback` | `Alert` / `sonner` toast | Choose per usage (inline vs transient) |
| `VerdictSeal` | **Composition** — `Badge` (verdict tone) + `Progress` (confidence) + text (notes) + `Alert` list (broken contracts) | Signature mono-stamp is intentionally dropped for the standard look |

### 4.3 Theme + functional status vocabulary
The zinc theme (light + dark) is the base. Layered on top are semantic tokens that carry
**meaning, not decoration** — the harness's verdict/status language:
`working` (orange, in-progress), `uncertain` (amber, escalated), `broken` (red, quarantine),
`clean` (jade, done), `accent` (interactive). These are exposed as `Badge` variants and reused by
`StatusPill`, `Dot`, and the verdict composition. `lib/theme.ts` switches to toggling the `.dark`
class on `<html>` (shadcn convention) instead of the `data-theme` attribute; both light and dark
themes are retained.

## 5. Phases (each phase = one gated PR: critic GPT-5.5 review → browser-verify → green CI → merge)

| PR | Scope | Files |
|---|---|---|
| **PR0** | Foundation | `components.json`, `styles.css`, `lib/theme.ts`, `lib/utils.ts`, all `components/ui/*`, `AGENTS.md` (shadcn-first) |
| **PR1** | App shell + navigation | `AppShell`, `Sidebar`, `ProjectTopBar`, `ProjectSwitcherMenu`, `SessionRail` |
| **PR2** | Board | `BoardView`, `TaskCard`, `ProjectRow` |
| **PR3** | Run | `RunView`, `VerdictSeal`→composition, `DiffView`, `Inspector`, `EscalationCard`, `DigestStrip` |
| **PR4** | Task detail | `TaskDetailView`, `NewRunComposer` |
| **PR5** | Settings + onboarding | `GlobalSettingsView`, `ProjectSettingsView`, `SettingsLayout`, `SettingsPopover`, `NewProjectView`, `RegisterForm`, `FolderBrowser`, `RuntimeFileView`, `HomeView` |

Ordering rule: PR0 must land first (it makes everything compile on shadcn). PR1–PR5 are otherwise
independent and each keeps the app fully working.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Base UI is very new — a needed primitive may be missing or behave differently | Verify availability in PR0; fall back to Radix variant point-wise (coexist) or hand-roll; record gaps |
| `init` overwrites our Tailwind v4 / `styles.css` setup | Manual reconcile (merge, not overwrite) — see 4.1.2 |
| Signature `VerdictSeal` visual is lost | Explicit, operator-approved trade for the standard look; function preserved via composition |
| Bespoke widgets creep back in | Governing shadcn-first principle (§3), enforced in review and mirrored to `AGENTS.md` |

## 7. Out of scope
- Desktop wrap (deferred per `feedback-ui-pilot-polish-before-desktop`).
- Non-UI daemon changes.
- New features — this is a like-for-like migration of existing screens to shadcn; behavior is preserved.

## 8. Success criteria
- No custom re-implementations of anything shadcn provides (shadcn-first honored).
- Every screen renders on shadcn/Base UI primitives with the default zinc look, light + dark.
- App compiles and every screen is browser-verified working after each PR.
- `@fontsource/space-grotesk` removed; no CDN font/asset dependency remains.
