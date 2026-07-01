# Autodev Harness — старт новой сессии (читай и приступай)

Ты продолжаешь проект **Autodev Harness**. Предыдущая сессия (s02, 2026-07-01) завершила
фазу брейншторма и donor-extraction: **архитектура заморожена и независимо верифицирована
codex GPT-5.5**, спека P1 написана, всё закоммичено (`3457c49`, промт-хендофф `cbec5f5`).
План и реализацию сознательно отложили сюда (там кончался контекст). **Твоя задача этой
сессии — поднять репозиторий и построить P1 (ядро-луп).**

Это не «черновик на подумать» — скелет уже решён оператором. Не переоткрывай замороженные
решения без веской причины.

## Шаг 1 — восстанови контекст (прочитай в этом порядке)

1. `docs/CURRENT-STATE.md` → раздел **NEXT ACTIONS** (главный ориентир).
2. `docs/adr/002-build-own-harness-not-fork-ao.md` → решение о развороте + 6 замороженных осей.
3. `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` → **спека P1** (что строим).
4. `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` → поведение боевого
   PS-лупа, которое портируем (это оракул паритета).

Примечание: `VISION.md` читается с баннером-поправкой; `adr/001` **устарел** (заменён `adr/002`).
Полная матрица решений — `docs/superpowers/donor-extraction/decision-matrix.md` (VERIFIED),
её проверка — `codex-verification.md`.

## Шаг 2 — что уже зафиксировано (НЕ переделывать)

- **Разворот:** не форк AO — свой **Node LTS + TypeScript** харнес; **file-blackboard =
  единый источник истины**; AO — один из 4 доноров (с OpenHands, Open Design, Aider); база —
  наш проверенный PowerShell autodev-loop.
- **6 осей скелета заморожены:** state = blackboard-only + repository-шов · pluggable
  `WorkerAdapter`/`CriticAdapter` (MVP: `claude` + `codex`) · commit-after-gate + шов под PR ·
  per-worktree изоляция (паттерн AO) · независимый diff-критик + machine-gate, **self-critique
  отвергнут** · декларативный per-task `model:` роутинг + тонкая абстракция-шов.
- **Клоны доноров** в `references/` (gitignored, SHA в `MANIFEST.md`). ⚠️ Реальный код
  OpenHands — в `references/software-agent-sdk/`, не в `OpenHands/` (см. гочу).

## Шаг 3 — сделай по порядку

1. **Создай remote** `github.com/kalbac/autodev-harness` и подключи `origin` (его ещё нет).
   Реши вопрос лицензии (доноры Apache-2.0/MIT — код переиспользуем).
2. **Запусти `superpowers:writing-plans`** на спеке P1
   (`docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md`) → план реализации.
3. **Реализуй P1** по порядку сборки (§10 спеки), через **TDD**:
   `config`+`blackboard` → `worktree` → `worker-runner`(claude)+`router` →
   `critic-runner`(codex) → `gate`+`guards`+`mutation-check` → `watchdog`+`escalate`+`anti-drift`
   → `conductor` → тонкий `api` → parity-harness + кросс-платформенный CI.

**Definition of done для P1:** поведенческий **паритет** с боевым PowerShell-лупом
(`D:/Projects/woodev_framework/tools/autodev/*.ps1`) на фикстуре + одном живом woodev-ворклоаде.

## Констрейнты

- **Непрерывность:** боевой PS-луп в `woodev_framework` **НЕ трогать** — он крутит реальные
  задачи и служит parity-oracle, пока P1 не достигнет паритета.
- **Дисциплина проекта (дожфудинг):** существенные изменения → независимый codex GPT-5.5
  ревью до мёржа; re-critic собственных правок; self-critique гейтом не считается.
- **Стек:** Node LTS + TypeScript, кросс-платформа (Win/mac/ubuntu); `sonnet-5` доступен как
  рабочая модель наравне с `opus` (в s02 отработал отлично на изучении доноров).

## Открытые вопросы — реши в начале

- Хостинг/лицензия для `kalbac/autodev-harness`.
- Какой живой woodev-ворклоад берём как parity-таргет P1.
- Формат per-project конфига (`.autodev/config.yaml` vs `harness.config.*`).

---
_Если по ходу возникнет скелетообразующее решение, не покрытое `adr/002` — вынеси его
оператору как 🔴 (архитектурное), прежде чем кодить. Мелкие обратимые — решай сам._
