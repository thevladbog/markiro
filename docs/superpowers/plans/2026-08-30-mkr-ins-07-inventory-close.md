# MKR-INS-07 «Инвентаризация: контроль, закрытие и документы» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Седьмая печатная инструкция и последний документ подсерии — MKR-INS-07 «Инвентаризация: контроль, закрытие и документы» (кабинет, менеджер): RU-страница + PDF/A-артефакт с аттестацией.

**Architecture:** Инфраструктура готова: харнесс кабинета из MKR-INS-06 монтирует реальные страницы админки под мок-сессией, Playwright строго перехватывает `/api/`. Эта итерация добавляет сценарии моков и кадры, затем идёт по знакомому конвейеру: контент + реестр → лендинг → артефакт + аттестация.

**Tech Stack:** TypeScript, React, Vite, Playwright (`tools/production-browser`), Astro, Vitest, node:test, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker).

**Спека:** `docs/superpowers/specs/2026-08-30-mkr-ins-07-inventory-close-design.md`. Ветка: `claude/mkr-ins-07-inventory-close` (от origin/main `10beeec86`).

## Global Constraints

- Код `MKR-INS-07`, ревизия `2026.08/01`, effectiveDate `2026-08-30`, статус `active`, RU-only.
- Маршрут: `/instruktsii/inventarizatsiya-zakrytie/`. Артефакт: `markiro_mkr-ins-07_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: release id `MKR-LEGAL-2026.08-07-2026-08-30`; прежние 18 файлов в `apps/landing/public/legal` байт-в-байт.
- Аудитория — менеджер кабинета; подготовка — отсылка к MKR-INS-06, пересчёт на терминалах — к MKR-INS-05.
- Цитаты интерфейса — строго из `apps/admin/src/i18n/ru.json` (`pages.inventory.live/corrections/close/late/documents`) И обязаны быть видны на кадре, который несёт шаг.
- Кадры: ширина 1280; высота 800, кроме тех, где содержимое выше (прецедент `exports.png` в MKR-INS-06 — 1280×1200).
- Данные синтетические, продолжают историю MKR-INS-06: организация «Марка Ко», инвентаризация ИНВ-000042, статусы по жизненному циклу («В работе» → «Закрыта» → «Завершена»).
- Опасные действия (аварийное закрытие, возобновление) описываются полностью, с последствиями словами UI.
- Генераторы: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2; TTF IBM Plex установлены.
- Prettier `--write` только на затронутые файлы; этот план уже в `.prettierignore`.
- Vitest-фильтр: `pnpm --filter <pkg> exec vitest run <path>`. Коммиты с трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Сценарии моков и одиннадцать скриншотов

**Files:**
- Modify: `tools/production-browser/tests/inventory.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-07/{live,corrections-list,corrections-form,close-ready,close-blocked,close-emergency,late-events,documents-catalog,documents-history,completion,reopen}.png`

**Interfaces:**
- Consumes: харнесс MKR-INS-06 — `apps/admin/test/browser/inventory-harness.tsx` (реальные страницы админки, мок-сессия, `?route=`), `tools/production-browser/inventory.playwright.config.ts` (порт 61593, скрипт `pnpm --dir tools/production-browser --ignore-workspace test:inventory`), строгий перехват `/api/` (неучтённый эндпоинт роняет тест).
- Produces: одиннадцать PNG; id = имя файла без `.png` (ссылки контента Task 2).

Соответствие файлов экранам (маршруты: `/inventory/<id>` — детальная страница, `/inventory/<id>/corrections` — исправления):

| Файл | Экран / состояние мока | Что должно быть видно |
| --- | --- | --- |
| live.png | `/inventory/<id>`, статус `running` | Счётчики «Ожидается», «Проверено», «Не найдено», «Расхождения»; «Участники»; «Короба»; «Последние события» |
| corrections-list.png | `/inventory/<id>/corrections` | «События и коды», фильтры «Тип события» и «Классификация», список позиций |
| corrections-form.png | там же, выбрана позиция | Форма исправления: «Причина исправления» и доступные действия («Отменить скан», «Изменить дату», …) |
| close-ready.png | `/inventory/<id>`, модалка закрытия без блокировок | «Проверка перед закрытием», «Блокировок нет…», «Закрыть безопасно» |
| close-blocked.png | та же модалка с блокировками | Список блокировок («Активные терминалы: N», «Открытые короба: N», …), «Безопасное закрытие недоступно…» |
| close-emergency.png | та же модалка, режим аварийного закрытия | «Причина аварийного закрытия», чекбокс «Я понимаю, что блокировки останутся в зафиксированном результате», «Закрыть аварийно» |
| late-events.png | «Поздние события» | Пакеты с числом событий, «Повторить обработку», «Исключить выбранные», «Причина решения» |
| documents-catalog.png | «Итоговые документы», статус `closed` | «Что сформировать», список форматов, «Сформировать документы» |
| documents-history.png | там же, есть история | «История формирования», статусы («Готово»/«Формируется»), «Скачать ZIP», метаданные артефакта |
| completion.png | там же, документы скачаны | «Завершение», «Итоговые документы скачаны и проверены», «Завершить инвентаризацию» |
| reopen.png | диалог возобновления | «Возобновить инвентаризацию?», объяснение последствий, «Подтвердить возобновление» |

- [ ] **Step 1: Изучить существующие сценарии**

Прочитать `tools/production-browser/tests/inventory.visual.spec.ts` целиком: как устроены фикстуры (`inventoryRow`, `inventoryDetailSchema`-совместимые объекты), как `installApi` регистрирует моки и роняет тест на неучтённом эндпоинте, как выбирается этап детальной страницы. Записать в отчёт, какие эндпоинты уже замоканы и каких не хватает для одиннадцати кадров.

- [ ] **Step 2: Выяснить контракты недостающих экранов**

Для каждого нового экрана найти запросы и формы ответов: `apps/admin/src/pages/inventory/api.ts` и `schemas.ts` (ход, исправления, поздние события, документы), плюс компоненты `InventoryLivePage.tsx`, `InventoryCorrections.tsx`, `InventoryClosePanel.tsx`, `InventoryLateEvents.tsx`, `InventoryDocuments.tsx` — какие поля они читают и при каких значениях показывают нужное состояние (например, какие данные дают непустой список блокировок). Моки строить по контрактам, а не выдумывать форму; при расхождении — чинить мок, а не приложение.

- [ ] **Step 3: Добавить сценарии и тесты**

В `inventory.visual.spec.ts` добавить по одному тесту на каждый из одиннадцати кадров: свой набор моков, навигация на нужный маршрут, при необходимости клики (открыть модалку закрытия, переключить на аварийный режим, выбрать позицию в исправлениях, открыть диалог возобновления), ожидание ключевого текста и осмысленный ассерт (заголовок или отличительная подпись). Статусы держать согласованными: `running` для хода и исправлений, `closed` для закрытия/поздних событий/документов, `completed` для финального кадра.

- [ ] **Step 4: Снять кадры**

В каждый тест добавить `page.setViewportSize({ width: 1280, height: 800 })` и `page.screenshot({ path: …, scale: "css" })` с путями от `import.meta.dirname` в `packages/legal-documents/assets/instructions/mkr-ins-07/`. Если содержимое экрана выше 800 px и обрезается так, что теряется существенное (как было с шестью статусами в MKR-INS-06), нарастить высоту вьюпорта по фактическому переполнению `main` (приём уже реализован в этом же файле для `exports.png` — переиспользовать его, а не изобретать заново).

Run: `pnpm --dir tools/production-browser --ignore-workspace test:inventory`
Expected: все тесты PASS (прежние восемь + одиннадцать новых), одиннадцать PNG на месте.

- [ ] **Step 5: Проверить кадры**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-07/*.png`
Expected: одиннадцать PNG шириной 1280, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой «Что должно быть видно»; спиннеры, пустые состояния и экраны ошибок загрузки — переснять, поправив моки.

- [ ] **Step 6: Гейты и коммит**

Run: `pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --dir tools/production-browser --ignore-workspace typecheck`
Expected: всё PASS. (В свежем воркtree перед typecheck админки нужен `pnpm --filter @markiro/platform-contracts build` — иначе всплывут ~55 чужих ошибок в apps/saas-admin, это артефакт окружения.) Prettier на затронутые файлы.

```bash
git add tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-07
git commit -m "feat(legal-documents): MKR-INS-07 closing screenshots from the inventory harness"
```

---

### Task 2: Пакет — код MKR-INS-07, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts`, `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/src/documents/cabinet-inventory-close.ts`
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: PNG-ассеты Task 1 (одиннадцать id из таблицы Task 1); helpers `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent`, блоки `step`/`callout`.
- Produces: `CABINET_INVENTORY_CLOSE_CONTENT`; активный релиз `MKR-INS-07/2026.08/01` с маршрутом `/instruktsii/inventarizatsiya-zakrytie/`; `artifactFileName(...)` → `markiro_mkr-ins-07_2026.08-01_ru.pdf`.

- [ ] **Step 1: Базовая линия**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (MKR-INS-07 ещё не зарегистрирован); после Step 2–3 тест обязан пройти уже с семью инструкциями.

- [ ] **Step 2: Типы, реестр, CLI**

1. `types.ts`: в union `LegalDocumentCode` добавить `"MKR-INS-07"`.
2. `registry.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-07"`; `LEGAL_DOCUMENT_KIND_BY_CODE` + `"MKR-INS-07": "instruction",`; импорт `CABINET_INVENTORY_CLOSE_CONTENT` из `./documents/cabinet-inventory-close.js`; в `LEGAL_RELEASES` последним:

```ts
  {
    code: "MKR-INS-07",
    revision: "2026.08/01",
    effectiveDate: "2026-08-30",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/inventarizatsiya-zakrytie/" },
  },
```

и в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-07/2026.08/01", content: CABINET_INVENTORY_CLOSE_CONTENT },
```

3. `verify-artifacts.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-07"`; `SAFE_FILE_NAME` → `ins-0[1234567]`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[1234567])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/cabinet-inventory-close.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const CABINET_INVENTORY_CLOSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: контроль, закрытие и документы инвентаризации",
    summary:
      "Инструкция менеджера после запуска инвентаризации: наблюдение за ходом, исправления, закрытие, поздние события, итоговые документы и завершение.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу менеджера после запуска инвентаризации: наблюдение за ходом пересчёта, исправления, закрытие задания, разбор поздних событий, формирование итоговых документов и завершение. Подготовка и запуск описаны в инструкции MKR-INS-06, работа операторов на терминалах — в MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "Задание проходит три состояния: «В работе» — идёт пересчёт; «Закрыта» — результат зафиксирован, но ещё можно разобрать поздние события и сформировать документы; «Завершена» — работа окончена, изменения недоступны.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера, количества и названия в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "live",
        heading: "2. Ход инвентаризации",
        blocks: [
          {
            kind: "step",
            title: "Следите за счётчиками и участниками",
            text: "Страница инвентаризации показывает текущие результаты: «Ожидается», «Проверено», «Не найдено», «Расхождения». Ниже видно участников — терминалы, работающие по заданию, — и их состояние: «В работе», «Нет связи», «Вышел». Панели «Короба» и «Последние события» показывают ход пересчёта по коробам и недавние сканы.",
            image: { id: "live", caption: "Ход инвентаризации: счётчики, участники, короба" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Строка о несинхронизированных событиях означает, что часть сканов ещё не дошла с терминалов. Это нормально при слабой связи: дождитесь синхронизации, прежде чем судить о расхождениях.",
          },
        ],
      },
      {
        id: "corrections",
        heading: "3. Исправления",
        blocks: [
          {
            kind: "paragraph",
            text: "Исправления доступны, только пока инвентаризация идёт. Каждое действие требует причину и сохраняется как неизменяемое аудиторское свидетельство — отменить его нельзя, можно лишь внести встречное исправление.",
          },
          {
            kind: "step",
            title: "Найдите нужное событие",
            text: "Откройте «Исправления» и выберите позицию в списке «События и коды». Список фильтруется по типу события и классификации — так проще найти конкретный скан или короб.",
            image: { id: "corrections-list", caption: "Исправления: события и коды" },
          },
          {
            kind: "step",
            title: "Выберите действие и укажите причину",
            text: "Для выбранной позиции доступны действия: «Отменить скан», «Восстановить скан», «Изменить дату», «Убрать из короба», «Аннулировать короб», «Поставить перепечать в очередь». Заполните «Причина исправления» и сохраните — запись уйдёт в аудит.",
            image: { id: "corrections-form", caption: "Форма исправления с причиной" },
            expected: "Кабинет сообщил, что исправление сохранено в аудите.",
          },
        ],
      },
      {
        id: "close",
        heading: "4. Закрытие инвентаризации",
        blocks: [
          {
            kind: "step",
            title: "Запустите проверку перед закрытием",
            text: "Нажмите «Закрыть инвентаризацию». Система проверит терминалы, локальные очереди, короба и обязательные расхождения. Если препятствий нет, кабинет сообщит, что блокировок нет и результат будет зафиксирован в текущей ревизии — нажмите «Закрыть безопасно».",
            image: { id: "close-ready", caption: "Проверка перед закрытием: блокировок нет" },
            expected: "Инвентаризация закрыта, результат зафиксирован.",
          },
          {
            kind: "step",
            title: "Разберите блокировки",
            text: "Кабинет перечисляет, что мешает закрытию: «Активные терминалы», «Терминалы без связи», «Несинхронизированные события», «Открытые короба», «Аннулированные короба» и другие. Устраните их на линии — попросите операторов выйти из задания, закрыть короба и дождаться синхронизации — и повторите проверку.",
            image: { id: "close-blocked", caption: "Проверка перед закрытием: список блокировок" },
          },
          {
            kind: "step",
            title: "Аварийное закрытие — только когда блокировки устранить нельзя",
            text: "Если ждать нельзя (например, терминал вышел из строя), доступно аварийное закрытие: заполните «Причина аварийного закрытия» и подтвердите «Я понимаю, что блокировки останутся в зафиксированном результате», затем нажмите «Закрыть аварийно».",
            image: { id: "close-emergency", caption: "Аварийное закрытие с обязательной причиной" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Блокировки при аварийном закрытии не исчезают — они остаются частью зафиксированного результата и попадут в итоговые документы. Пользуйтесь этим путём только когда обычное закрытие действительно невозможно.",
          },
        ],
      },
      {
        id: "late-events",
        heading: "5. Поздние события",
        blocks: [
          {
            kind: "step",
            title: "Разберите пакеты, пришедшие после закрытия",
            text: "События, догнавшие сервер после закрытия, собираются в пакеты со статусом «Требует решения». По каждому выберите решение: «Повторить обработку» — учесть события в результате, или «Исключить выбранные» — не учитывать. Решение требует указать «Причина решения». За один раз можно выбрать не более 100 пакетов.",
            image: { id: "late-events", caption: "Поздние события: пакеты и решения" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Пока есть пакеты со статусом «Требует решения», завершить инвентаризацию нельзя — кабинет попросит сначала обработать поздние события.",
          },
        ],
      },
      {
        id: "documents",
        heading: "6. Итоговые документы",
        blocks: [
          {
            kind: "step",
            title: "Выберите форматы и сформируйте документы",
            text: "После закрытия откройте «Итоговые документы», в блоке «Что сформировать» отметьте нужные форматы из утверждённого каталога и нажмите «Сформировать документы».",
            image: { id: "documents-catalog", caption: "Выбор форматов итоговых документов" },
          },
          {
            kind: "step",
            title: "Дождитесь готовности и скачайте",
            text: "В «Истории формирования» видно состояние каждого запуска: «В очереди», «Формируется», «Готово» или «Ошибка». Готовые документы скачиваются по одному или кнопкой «Скачать ZIP». Если формирование не удалось, доступна кнопка «Повторить формирование».",
            image: { id: "documents-history", caption: "История формирования и скачивание" },
            expected: "Все документы текущего результата скачаны.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Документы привязаны к ревизии результата. Если инвентаризацию возобновить, ранее сформированные документы аннулируются и их придётся сформировать заново.",
          },
        ],
      },
      {
        id: "completion",
        heading: "7. Завершение и возобновление",
        blocks: [
          {
            kind: "step",
            title: "Завершите инвентаризацию",
            text: "Когда документы скачаны и проверены, отметьте «Итоговые документы скачаны и проверены» и нажмите «Завершить инвентаризацию». После завершения задание становится недоступным для изменений.",
            image: { id: "completion", caption: "Завершение инвентаризации" },
            expected: "Инвентаризация завершена.",
          },
          {
            kind: "step",
            title: "Возобновляйте только при реальной необходимости",
            text: "Закрытую инвентаризацию можно возобновить кнопкой «Возобновить». Кабинет предупредит о последствиях: ревизия результата увеличится, закрывающие поля будут очищены, итоговые документы аннулированы, а ожидающие поздние события станут доступны для повторной обработки. Подтвердите, только если готовы пересобрать результат и документы заново.",
            image: { id: "reopen", caption: "Подтверждение возобновления инвентаризации" },
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "8. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Кнопка закрытия не срабатывает из-за терминалов",
                detail: "Операторы ещё в задании или терминал потерял связь. Попросите выйти из задания и дождитесь синхронизации, затем повторите проверку.",
              },
              {
                term: "Расхождений больше, чем ожидалось",
                detail: "Сначала дождитесь синхронизации всех событий: несинхронизированные сканы не учтены в счётчиках. Разбирать расхождения удобнее исправлениями, пока инвентаризация идёт.",
              },
              {
                term: "Завершение недоступно",
                detail: "Завершение открывается после того, как итоговые документы сформированы, скачаны и отмечены как проверенные, а поздние события обработаны.",
              },
              {
                term: "Документы отмечены как аннулированные",
                detail: "Инвентаризацию возобновляли — документы относятся к предыдущей ревизии результата. Сформируйте их заново и скачайте.",
              },
              {
                term: "Ошиблись в исправлении",
                detail: "Исправления неизменяемы и остаются в аудите. Внесите встречное исправление с понятной причиной — история сохранит оба действия.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Если проблема не описана выше, обратитесь в поддержку Маркиро: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
```

Примечание для исполнителя: ОБЯЗАТЕЛЬНО сверить каждую цитату в кавычках-ёлочках с `apps/admin/src/i18n/ru.json` (`pages.inventory.*`) И с фактическими кадрами Task 1 (открыть через Read). Если строка есть в словаре, но на экране не отображается или названа иначе — поправить формулировку по факту и зафиксировать в отчёте. Особое внимание к формулировкам последствий аварийного закрытия и возобновления: они обязаны совпадать с тем, что показывает UI. Контент-контракт: термины definition-list не должны заканчиваться пунктуацией.

- [ ] **Step 4: Pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов + `"MKR-INS-07"`; счётчик уникальных маршрутов 14 → 15 (строка 61).
2. `test/artifact-manifest.test.ts`: фикстурная запись MKR-INS-07 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-07_2026.08-01_ru.pdf`, effectiveDate `2026-08-30` в per-code ветвлении `artifactEntry()`); счётчики 18 → 19 записей, PDF 14 → 15 (включая счётчики генерации, списка запросов и файлов на диске в том же файле).
Править по фактическим падениям, не ослабляя.

- [ ] **Step 5: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (instruction-assets — семь инструкций). Prettier на затронутые файлы.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-07 inventory closing instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/pages/instruktsii/inventarizatsiya-zakrytie/index.astro`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`

**Interfaces:**
- Consumes: релиз/контент Task 2; `InstructionDocument.astro` (`{ page, images: Record<string, string> }`).
- Produces: страница `/instruktsii/inventarizatsiya-zakrytie/`; загрузчик принимает `ins-07`.

- [ ] **Step 1: Базовая линия падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — `DESCRIPTION_BY_CODE` без MKR-INS-07 (satisfies), pinned-счётчики, completeness против реального `public/legal` (красный до Task 4 вместе с build-зависимыми сьютами). Если vitest не резолвит `@markiro/legal-documents` или база подозрительно зелёная — сначала `pnpm --filter @markiro/legal-documents build`.

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

```ts
  "MKR-INS-07": {
    ru: "Печатная инструкция менеджера: ход инвентаризации, исправления, закрытие, поздние события, итоговые документы и завершение.",
    en: "Printable manager instruction: stock-count progress, corrections, closing, late events, final documents, and completion.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/inventarizatsiya-zakrytie/index.astro` (зеркало соседних страниц в `apps/landing/src/pages/instruktsii/`):

```astro
---
import live from "@markiro/legal-documents/assets/instructions/mkr-ins-07/live.png?url";
import correctionsList from "@markiro/legal-documents/assets/instructions/mkr-ins-07/corrections-list.png?url";
import correctionsForm from "@markiro/legal-documents/assets/instructions/mkr-ins-07/corrections-form.png?url";
import closeReady from "@markiro/legal-documents/assets/instructions/mkr-ins-07/close-ready.png?url";
import closeBlocked from "@markiro/legal-documents/assets/instructions/mkr-ins-07/close-blocked.png?url";
import closeEmergency from "@markiro/legal-documents/assets/instructions/mkr-ins-07/close-emergency.png?url";
import lateEvents from "@markiro/legal-documents/assets/instructions/mkr-ins-07/late-events.png?url";
import documentsCatalog from "@markiro/legal-documents/assets/instructions/mkr-ins-07/documents-catalog.png?url";
import documentsHistory from "@markiro/legal-documents/assets/instructions/mkr-ins-07/documents-history.png?url";
import completion from "@markiro/legal-documents/assets/instructions/mkr-ins-07/completion.png?url";
import reopen from "@markiro/legal-documents/assets/instructions/mkr-ins-07/reopen.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  live,
  "corrections-list": correctionsList,
  "corrections-form": correctionsForm,
  "close-ready": closeReady,
  "close-blocked": closeBlocked,
  "close-emergency": closeEmergency,
  "late-events": lateEvents,
  "documents-catalog": documentsCatalog,
  "documents-history": documentsHistory,
  completion,
  reopen,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-07", "ru")} images={images} />
```

- [ ] **Step 4: Загрузчик артефактов**

`apps/landing/src/lib/legal-artifacts.ts`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[1234567])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Pinned-тесты лендинга**

Ожидаемая арифметика (править по фактическим падениям; расхождение — investigate):
- `legal-artifacts.test.ts`: запись MKR-INS-07; 18 → 19 всего, `pdfa-2b` 14 → 15, `template-docx` 4.
- `legal-rendered-page.test.ts`: `/legal/` PDF 10 → 11, SHA 12 → 13 (строки ~171–172); `/en/legal/` без изменений (4 и 6); И список ожидаемых кодов реестра в completeness-проверке того же файла + `"MKR-INS-07"`.
- `seo.test.ts`: sitemap `<url>` 60 → 62 в ДВУХ местах (строки ~84 и ~144).

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: PASS, кроме известных красных (completeness + build-зависимые — до Task 4). Build не запускать. Prettier на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src apps/landing/test
git commit -m "feat(landing): MKR-INS-07 inventory closing instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-07_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–3; тулчейн SOFFICE_BIN=/opt/homebrew/bin/soffice (LibreOffice 26.2.5.2), VERAPDF_CONTAINER_RUNTIME=docker (sandbox off для docker-команд; таймауты до 600000 мс). Прецедент аттестации: `git log --oneline --all --grep="attest the new release set"` и `git show <sha> -- deploy/production`.
- Produces: набор из 19 артефактов; аттестация `MKR-LEGAL-2026.08-07-2026-08-30`.

- [ ] **Step 1: Генерация**

Удалить `apps/landing/public/legal` целиком, затем:

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

`git status --porcelain apps/landing/public/legal` → ТОЛЬКО artifacts.json (M) + новый PDF (A); diff манифеста — одна вставка, старые хеши нетронуты. Иначе restore (`git checkout -- apps/landing/public/legal`) + BLOCKED с `pdffonts` одного изменившегося файла.

- [ ] **Step 3: Верификация и просмотр**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 19 immutable legal artifacts`. Read PDF (страницы 1–5): титул «Кабинет: контроль, закрытие и документы инвентаризации», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-07», одиннадцать скриншотов с подписями, «Шаг N.», < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-07_2026.08-01_ru.pdf`
2. `legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-07-2026-08-30"`, `manifestSha256` → новый, запись ins-07 после ins-06 (лексикографический порядок), фактический sha256.
3. `verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; `EXPECTED_PDFS` + `"markiro_mkr-ins-07_2026.08-01_ru.pdf"` после ins-06.
4. `legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-07), счётчики 14 → 15.
5. `edge-contract.test.mjs` (строка ~941): `artifacts.length` 18 → 19.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS. В dist: новая страница 11 `<img>` / 11 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01…07.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-07 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: сценарии моков и кадры (T1 = раздел 2 спеки), документ/контент/CLI (T2 = раздел 1 и часть 3), лендинг (T3), артефакт+аттестация (T4). Опасные действия описаны полностью в контенте T2 (разделы 4 и 7 документа).
- Числа: маршруты 15; артефакты 19 (15 PDF + 4 DOCX); лендинг-фикстуры 19/15/4; `/legal/` PDF 11 / SHA 13; sitemap 62 (два места); аттестация 15 PDF; edge-contract 19.
- Image ids: все одиннадцать используются ровно один раз; списки в T1, T2 и T3 идентичны.
- Контент несёт стоп-условие сверки цитат с i18n И со скриншотами, с отдельным акцентом на формулировки последствий.
- Урок MKR-INS-05/06 учтён в T3 Step 5: список кодов реестра в completeness-проверке обновляется вместе со счётчиками.
- Процессное требование спеки: финальному whole-branch ревью — линза «текст ↔ скриншоты ↔ i18n» (задаётся контролёром при диспатче).
