# Next-session prompt — Autodev Harness (paste this to start)

> Handoff from session **s02** (2026-07-01). The brainstorm + donor-extraction phase is
> **done and committed** (`3457c49`); architecture is **frozen and codex-verified**. This
> session's job: stand up the repo and **build P1 (the core loop)**.

---

## Paste-ready prompt

```
Продолжаем Autodev Harness. Прошлая сессия (s02) закончилась заморозкой архитектуры и
написанием спеки P1 — всё закоммичено (3457c49). Контекст был полон, поэтому план и
реализацию отложили на эту сессию.

Сделай по порядку:

1. Прочитай для контекста (в этом порядке):
   - docs/CURRENT-STATE.md  → раздел NEXT ACTIONS (главное)
   - docs/adr/002-build-own-harness-not-fork-ao.md  → решение о развороте (6 осей)
   - docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md  → спека P1
   - docs/superpowers/donor-extraction/autodev-loop-parity-spec.md  → поведение, которое портируем
   (VISION.md читается с баннером-поправкой; adr/001 УСТАРЕЛ — заменён adr/002.)

2. Создай remote-репозиторий github.com/kalbac/autodev-harness и подключи origin
   (сейчас его нет). Определись с лицензией (доноры Apache-2.0/MIT).

3. Запусти superpowers:writing-plans на спеке P1
   (docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md) → план реализации.

4. Реализуй P1 по порядку сборки (§10 спеки), TDD:
   config+blackboard → worktree → worker-runner(claude)+router → critic-runner(codex)
   → gate+guards+mutation → watchdog+escalate+anti-drift → conductor → thin api
   → parity-harness + кросс-платформенный CI.

Definition of done для P1 — поведенческий ПАРИТЕТ с боевым PowerShell-лупом
(D:/Projects/woodev_framework/tools/autodev/*.ps1) на фикстуре + одном живом woodev-ворклоаде.
```

---

## Что уже готово (не переделывать)

- **Разворот зафиксирован** (`adr/002`): не форк AO — свой Node+TS харнес; blackboard = единый
  источник истины; AO — один из 4 доноров.
- **6 осей скелета заморожены** (см. CURRENT-STATE / adr/002): blackboard-only+шов ·
  pluggable worker/critic adapter (MVP claude+codex) · commit-after-gate · per-worktree ·
  независимый критик + self-critique отвергнут · декларативный per-task роутинг.
- **Матрица VERIFIED** codex GPT-5.5 (17/18, 1 partial, 0 refuted): `donor-extraction/`.
- **Клоны доноров** в `references/` (gitignored, SHA в MANIFEST.md). ⚠️ Реальный код
  OpenHands — в `references/software-agent-sdk/`, не в `OpenHands/` (см. gotcha).

## Констрейнты

- **Непрерывность:** боевой PowerShell-луп в woodev_framework НЕ трогать — он крутит
  реальные задачи и служит parity-oracle, пока P1 не достигнет паритета.
- **Дисциплина проекта:** существенные изменения → независимый codex GPT-5.5 ревью до мёржа;
  re-critic собственных правок; self-critique гейтом не считается.
- **Стек:** Node LTS + TypeScript, кросс-платформа (Win/mac/ubuntu), sonnet-5 доступен как
  рабочая модель наравне с opus.

## Открытые вопросы (решить в начале)

- Хостинг/лицензия для `kalbac/autodev-harness`.
- Какой живой woodev-ворклоад берём как parity-таргет P1.
- Формат per-project конфига (`.autodev/config.yaml` vs `harness.config.*`).
