# Component-currency audit (s35)

> Operator ask from s34 (prompted by the `MessageScroller` miss — shipped a generic
> `ScrollArea` where a purpose-built component already existed). Review EVERY UI
> component we use — our custom ones AND the already-vendored shadcn ones — against
> the CURRENT shadcn catalog (queried live via the shadcn MCP, now connected s35),
> and where a more-relevant/more-current component exists, replace ours.
> Audited 2026-07-09.

## The governing fact — the whole catalog is Base-UI-native under `base-nova`

`ui/components.json` → `"style": "base-nova"`. Our vendored primitives sit on **Base UI**
(`@base-ui/react/*`).

**Correction (verified by fetching the raw `base-nova` registry JSON, not the MCP's
default-style metadata):** the default `@shadcn` registry reports `radix-ui` deps for the
newest items — but **the `base-nova` style ships Base-UI ports of everything.** Confirmed via
`ui.shadcn.com/r/styles/base-nova/<item>.json`: `sidebar`, `collapsible`, `accordion`,
`tabs`, `toggle-group`, `checkbox`, `alert-dialog`, `item`, `bubble`, `marker`, `attachment`,
`button-group`, `separator` all import `@base-ui/react/*` — **none pull radix.** `empty`,
`spinner`, `message`, `kbd`, `field`, `input-group`, `native-select`, `label` are dep-free.

**So there is NO radix-foundation trap on this project.** Effectively the entire catalog is a
clean adopt. The audit's real filter is therefore not "radix vs base-ui" but **value vs
churn and behaviour-preservation**:

1. **Pure win** — a purpose-built primitive exists where we hand-roll, and adopting adds
   real value (consistency, features) at low risk.
2. **Churn-for-nothing** — our custom code is already a clean Base-UI/shadcn-token
   composition; swapping buys nothing (e.g. custom `Card`, `Button`).
3. **Behaviour-risk** — the custom carries a domain feature or discipline a naive swap would
   drop (`Tabs` per-tab `accent`; `ProjectRow`'s mount-gated collapse that bounds data
   fetches; `StatusPill`/`Dot`/`VerdictSeal` tone vocabulary; `DiffView` — no shadcn diff).

> The three background audit agents were briefed with the *default-style* radix metadata and
> so tagged `item`/`bubble`/`sidebar`/`collapsible`/`toggle-group`/`checkbox` as
> "FOUNDATION-COST." Under `base-nova` that is wrong — re-read their findings with the radix
> objection removed; what remains is the value/churn/behaviour judgement above.

## Catalog snapshot

61 `registry:ui` items in `@shadcn`. New-since-our-migration items relevant to us:
`empty`, `spinner`, `item`, `field`, `form`, `button-group`, `input-group`, `kbd`,
`native-select`, `sidebar`, and the chat family `message` / `bubble` / `attachment` /
`marker` (beyond the `message-scroller` we already vendored).

## Findings — three tiers by value/churn/behaviour (radix objection removed)

### Tier 1 — pure wins (purpose-built primitive, we hand-roll; low risk, real gain)

Most of these funnel through **one file, `Feedback.tsx`** — rebuild its `Spinner` on shadcn
`spinner` and `EmptyState` on shadcn `empty`, and every caller inherits the primitive; then a
second sweep converts the bare-`<p>` empty/loading states to route through `Feedback`.

| # | Ours (hand-rolled) | Adopt | Sites |
|---|--------------------|-------|-------|
| T1.1 | `Feedback.Spinner` (bare `Loader2 animate-spin`) | `spinner` | ChatModal, RegisterForm, Inspector.Loading, EscalationCard, RuntimeFileView; SessionRail inline `Loader2` glyph |
| T1.2 | `Feedback.EmptyState` + bare-`<p>` empties | `empty` | Inspector ×4, DigestStrip, DiffView "Empty diff", RuntimeFileView, FolderBrowser "No sub-directories", Sidebar "daemon unreachable", SessionRail "no plan"/"no active run", ProjectSwitcher "No projects", EscalationCard "No record" |
| T1.3 | ChatModal `ChatBubble` (align+tinted div) | `message` (dep-free) | ChatModal transcript |
| T1.4 | NewRunComposer `⌘⏎ to launch` span | `kbd` | NewRunComposer footer |
| T1.5 | RegisterForm 4× `label`+`Input`+hint triples + error `<p>` | `field` (+`label`) | RegisterForm |
| T1.6 | SettingsPopover `h-px bg-border` divider | `separator` (vendored) | SettingsPopover |
| T1.7 | Raw inline-styled `<button>`s + chips bypassing our primitives | vendored `Button` / `Badge` / `Textarea` | EscalationCard A/B + commit buttons; TaskCard guarded/type chips; FolderBrowser git/registered pills + row actions; NewRunComposer raw `<textarea>` |

### Tier 2 — now-unblocked structural (Base-UI-native under base-nova; real refactor + a judgement)

| # | Ours | Candidate | The judgement |
|---|------|-----------|---------------|
| T2.1 | `Sidebar`+`AppShell` (custom aside/flex) | `sidebar` block | Now Base-UI; adds collapse-to-icons/mobile/keyboard + `SidebarProvider/Inset/Menu`. Real feature gain but a big, opinionated refactor. Worth it only if we want collapse/mobile; else the 7-line shell is fine. |
| T2.2 | SettingsPopover theme segments; Inspector file-tab chips | `toggle-group` | Base-UI single-select; drops manual on/off styling. Verify "keep-open on select" for the theme control. |
| T2.3 | ProjectRow / DigestStrip collapsibles | `collapsible` / `accordion` | Base-UI now. **Behaviour risk:** ProjectRow's collapse is mount-gated to bound per-project fetches — a pure-UI collapsible must not break that. DigestStrip is pure-UI → safe. |
| T2.4 | RegisterForm custom checkbox | `checkbox` | Base-UI now; drops the sr-only+hand-drawn box. Clean. |
| T2.5 | EscalationCard Commit-anyway confirm | `alert-dialog` | Base-UI now; the idiomatic home for a destructive confirm (currently plain `Dialog`). |
| T2.6 | NewRunComposer / ChatModal composer shells | `input-group` | Base-UI; bordered input+trailing-action shell. Optional polish. |

### Tier 3 — keep custom (no equivalent, or a deliberate signature/domain)

- **`DiffView`** — there is NO shadcn diff component. Keep, required.
- **`StatusPill` / `Dot` / `VerdictSeal`** — domain status/critic vocabulary (tone color-mix,
  verdict seal, confidence bar). No shadcn equivalent. Keep.
- **`Button`** — deliberate custom cva API (`primary/default/ghost/outline · sm/md/icon`) on
  shadcn tokens; adopting shadcn's variant vocabulary verbatim breaks every call site. Keep.
- **`Card`** — minimal `Card/CardHeader/CardBody`, already a clean token composition. Keep
  (optional later: adopt shadcn's richer `card` slots).
- **`Tabs`** — already the Base-UI tabs primitive + a `TabBar` adapter carrying a per-tab
  `accent` feature shadcn tabs lacks. Keep.

### D. Vendored-primitive drift (secondary track)

The 15 vendored lowercase primitives were vendored s29–s34 on `base-nova`. Use `shadcn diff`
(or fetch each `base-nova/<item>.json`) to spot-check drift. Low risk; do on execution, don't
block Tier 1 on it. Note `sonner.tsx` already had a real scaffold bug fixed s32
(`[ui/shadcn-scaffold-assumes-unmounted-next-themes]`).

## Recommendation

**Tier 1 is the clear first batch** — low-risk, high-consistency, closes the operator's
flagged miss-class, and the `Feedback.tsx` funnel makes it high-leverage. **Tier 2** is now
genuinely open (no radix cost) and worth doing for "task-maximum," but each item is a real
refactor with a behaviour or scope call — sequence it after Tier 1, item by item, each
codex-gated. **Tier 3 stays custom.** Suggested execution: subagent-driven, TDD where there's
test infra, mandatory codex GPT-5.5 gate per module, browser live-proof at the end.

## Related

- `docs/gotchas/shadcn-cli-vendoring-on-windows.md` — manual-vendor fallback + the Windows
  `Button.tsx` case-collision to watch when any adopt pulls `button` as a dep.
- `docs/gotchas/shadcn-scaffold-assumes-unmounted-next-themes.md` — audit a scaffolded
  primitive's boilerplate hooks against what's actually mounted.
- `AGENTS.md` §UI: shadcn-first — the rule this audit operationalizes.
