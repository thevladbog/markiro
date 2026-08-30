# MKR-INS-06 «Инвентаризация: подготовка и запуск» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Шестая печатная инструкция — MKR-INS-06 «Инвентаризация: подготовка и запуск» (кабинет, менеджер): RU-страница + PDF/A-артефакт с аттестацией.

**Architecture:** Первый документ серии, снимаемый НЕ со станции. Скриншоты кабинета делает новый браузерный харнесс `apps/admin/test/browser/inventory-harness.tsx` по образцу существующего `tenant-billing-harness.tsx`: реальные страницы админки под моками сессии и `/api/`-перехватом Playwright, без Postgres и API. Дальше — знакомый конвейер: контент + реестр → лендинг → артефакт + аттестация.

**Tech Stack:** TypeScript, React, Vite, Playwright (`tools/production-browser`), Astro, Vitest, node:test, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker).

**Спека:** `docs/superpowers/specs/2026-08-30-mkr-ins-06-inventory-prep-design.md`. Ветка: `claude/mkr-ins-06-inventory-prep` (от origin/main `fc1bd7f1c`).

## Global Constraints

- Код `MKR-INS-06`, ревизия `2026.08/01`, effectiveDate `2026-08-30`, статус `active`, RU-only.
- Маршрут: `/instruktsii/inventarizatsiya-podgotovka/`. Артефакт: `markiro_mkr-ins-06_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: release id `MKR-LEGAL-2026.08-06-2026-08-30`; прежние 17 файлов в `apps/landing/public/legal` байт-в-байт.
- Аудитория — менеджер/кладовщик в кабинете; терминальная часть — только отсылкой к MKR-INS-05.
- Цитаты интерфейса — строго из `apps/admin/src/i18n/ru.json`, ветка `pages.inventory` (+ `nav`). Цитировать только строки, реально видимые на снятых кадрах: на станции нашлось пять мёртвых ключей, у кабинета такой аудит не проводился.
- Скриншоты 1280×800; синтетические данные в демо-стиле (организация «Марка Ко» — как в биллинговом харнессе; продукт «Вода 0,5 л»; линия «Тестовая линия А»).
- Генераторы: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2; TTF IBM Plex установлены.
- Prettier `--write` только на затронутые файлы; этот план уже в `.prettierignore`.
- Vitest-фильтр: `pnpm --filter <pkg> exec vitest run <path>`. Коммиты с трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Браузерный харнесс кабинета для инвентаризации

**Files:**
- Create: `apps/admin/test/browser/inventory-harness.tsx`
- Create: `apps/admin/test/browser/inventory.html`
- Create: `tools/production-browser/inventory.playwright.config.ts`
- Create: `tools/production-browser/tests/inventory.visual.spec.ts`
- Modify: `tools/production-browser/package.json` (скрипт запуска)

**Interfaces:**
- Consumes: существующий прецедент — `apps/admin/test/browser/tenant-billing-harness.tsx`, `apps/admin/test/browser/tenant-billing.html`, `apps/admin/test/browser/vite.config.ts`, `tools/production-browser/tenant-billing.playwright.config.ts`, `tools/production-browser/tests/tenant-billing.visual.spec.ts` (мокинг `/api/` через `page.route`). Маршруты админки: `/inventory`, `/inventory/new`, `/inventory/:inventoryId` (`apps/admin/src/app.tsx:185-215`), страницы защищены `RequireCapability` (`C.OPERATIONS_READ` / `C.OPERATIONS_WRITE`).
- Produces: URL вида `/test/browser/inventory.html?route=<путь>` и скрипт `pnpm --dir tools/production-browser --ignore-workspace test:inventory`, который открывает нужные экраны подготовки на синтетических данных. Task 2 использует их для съёмки.

- [ ] **Step 1: Прочитать прецедент целиком**

Прочитать пять файлов из блока Consumes. Зафиксировать в отчёте: как биллинговый харнесс подменяет сессию (`AuthClientProvider` + `AuthClientLike`), как spec перехватывает API (`page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, …)` + `route.fulfill`), как конфиг поднимает vite (`webServer.command` с `apps/admin/test/browser/vite.config.ts`).

- [ ] **Step 2: Выяснить, откуда страницы берут capabilities**

Найти, как `RequireCapability` получает права (`git grep -n "RequireCapability\|useCapabilities\|capabilit" apps/admin/src --include="*.tsx" --include="*.ts" | head -20`), и какой запрос их отдаёт. Записать в отчёт точный путь запроса — он понадобится в моках. Если права приходят не по HTTP, а из провайдера — харнесс должен подставить провайдер напрямую.

- [ ] **Step 3: Написать харнесс**

Создать `apps/admin/test/browser/inventory-harness.tsx` по образцу `tenant-billing-harness.tsx`: те же импорты стилей/i18n, `QueryClient` с `retry: false`, `AuthClientProvider` с синтетической сессией (организация «Марка Ко», пользователь-менеджер), `createMemoryRouter(appRoutes, { initialEntries: [route] })`, где `route` берётся из `?route=` (по умолчанию `/inventory`). Права доступа выдать так, как выяснено в Step 2, чтобы `RequireCapability` пропускал `OPERATIONS_READ` и `OPERATIONS_WRITE`.

Создать `apps/admin/test/browser/inventory.html` — копию `tenant-billing.html` с заголовком «Inventory browser evidence» и `src="/test/browser/inventory-harness.tsx"`.

- [ ] **Step 4: Написать playwright-конфиг и спеку**

Создать `tools/production-browser/inventory.playwright.config.ts` по образцу `tenant-billing.playwright.config.ts`: свой порт (например `61_593`), `testMatch: "inventory.visual.spec.ts"`, `outputDir` внутри `.superpowers/sdd/`, тот же `webServer.command`, `url: http://127.0.0.1:<port>/test/browser/inventory.html`.

Создать `tools/production-browser/tests/inventory.visual.spec.ts`: набор моков `/api/` для страниц подготовки и по одному тесту на экран, каждый из которых открывает `?route=…`, ждёт ключевой текст экрана и утверждает его наличие (`expect(page.getByRole("heading", { name: … }))`). Данные брать из реальных типов ответов: посмотреть `apps/admin/src/pages/inventory/api.ts` и `schemas.ts`, чтобы моки соответствовали контракту, а не выдуманной форме.

Экраны, которые обязан открывать спек (по одному тесту на каждый):
`/inventory` (список), `/inventory/new` (параметры), и `/inventory/<id>` на этапах «Выписки ЧЗ», «Проверка снимка», «Терминалы», «Запуск» — этап выбирается состоянием мока (какие загрузки готовы, зафиксирован ли снимок), поэтому в спеке будет несколько мок-наборов.

В `tools/production-browser/package.json` добавить скрипт:

```json
    "test:inventory": "playwright test --config inventory.playwright.config.ts",
```

- [ ] **Step 5: Прогнать**

Run: `pnpm --dir tools/production-browser --ignore-workspace test:inventory`
Expected: все тесты PASS — значит каждый экран действительно рендерится на моках. Если экран падает на данных, чинить МОКИ (приводить к контракту), а не продакшен-код; если для рендера чего-то не хватает в самом приложении — остановиться и доложить BLOCKED с цитатой кода.

- [ ] **Step 6: Гейты и коммит**

Run: `pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --dir tools/production-browser --ignore-workspace typecheck`
Expected: всё PASS. Prettier на затронутые файлы.

```bash
git add apps/admin/test/browser tools/production-browser
git commit -m "test(admin): browser harness for inventory preparation screens"
```

---

### Task 2: Восемь скриншотов кабинета

**Files:**
- Modify: `tools/production-browser/tests/inventory.visual.spec.ts` (добавить съёмку)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-06/{list,parameters,exports,exports-blocked,snapshot,terminals,task-form,launch}.png`

**Interfaces:**
- Consumes: харнесс и скрипт `test:inventory` из Task 1.
- Produces: восемь PNG 1280×800; id = имя файла без `.png` (ссылки контента Task 3).

Соответствие файлов экранам:

| Файл | Экран | Что должно быть видно |
| --- | --- | --- |
| list.png | `/inventory` | Список инвентаризаций: номер/статус, продукт/даты, линия/способ |
| parameters.png | `/inventory/new` | «Параметры задания»: продукт, «Способ инвентаризации», линия, шаблон, даты |
| exports.png | `/inventory/<id>` этап 2 | «Выписки по статусам кодов»: шесть статусов, часть «Готово», часть «Нет файла», кнопка «Заказать из Честного Знака» |
| exports-blocked.png | `/inventory/<id>` этап 2 (мок с блокером) | Заказ заблокирован: одно из сообщений `chzExports.blocked` (например «Подключите агент КЭП в разделе «Интеграции»») |
| snapshot.png | `/inventory/<id>` этап 3 | «Проверка снимка», список шести выписок, «Зафиксировать снимок» |
| terminals.png | `/inventory/<id>` этап 4 | «Доступ терминалов», «Назначено терминалов», «N из M терминалов в сети», «Открыть форму-задание» |
| task-form.png | форма-задание | Печатная A4-форма со штрихкодом задания |
| launch.png | `/inventory/<id>` этап 5 | «Запуск инвентаризации», «Снимок зафиксирован», чекбокс остановки движений, «Запустить инвентаризацию» |

- [ ] **Step 1: Добавить съёмку в спеку**

В `inventory.visual.spec.ts` в каждый тест добавить `await page.setViewportSize({ width: 1280, height: 800 })` и `await page.screenshot({ path: …, scale: "css" })`, складывая файлы в `packages/legal-documents/assets/instructions/mkr-ins-06/` под именами из таблицы. Путь собирать от `import.meta.dirname`, а не от cwd. `scale: "css"` даёт ровно 1280×800 без retina-удвоения.

Для `task-form.png` выяснить, как открывается форма («Открыть форму-задание» — найти обработчик в `apps/admin/src/pages/inventory/InventoryDetailPage.tsx`): если это отдельный маршрут или окно печати, снять его напрямую тем же способом; если печать через `window.print()`, снять экранное представление формы. Записать выбранный способ в отчёт.

- [ ] **Step 2: Снять**

Run: `pnpm --dir tools/production-browser --ignore-workspace test:inventory`
Expected: тесты PASS, в каталоге появились восемь PNG.

- [ ] **Step 3: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-06/*.png`
Expected: восемь `PNG image data, 1280 x 800`, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой «Что должно быть видно»; пустые состояния, спиннеры и экраны с ошибками загрузки данных — переснять, поправив моки.

- [ ] **Step 4: Commit**

```bash
git add tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-06
git commit -m "feat(legal-documents): MKR-INS-06 cabinet screenshots from the inventory harness"
```

---

### Task 3: Пакет — код MKR-INS-06, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts`, `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/src/documents/cabinet-inventory-prep.ts`
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: PNG-ассеты Task 2 (восемь id из таблицы Task 2); helpers `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent`, блоки `step`/`callout`.
- Produces: `CABINET_INVENTORY_PREP_CONTENT`; активный релиз `MKR-INS-06/2026.08/01` с маршрутом `/instruktsii/inventarizatsiya-podgotovka/`; `artifactFileName(...)` → `markiro_mkr-ins-06_2026.08-01_ru.pdf`.

- [ ] **Step 1: Базовая линия**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (MKR-INS-06 ещё не зарегистрирован); после Step 2–3 тест обязан пройти уже с шестью инструкциями.

- [ ] **Step 2: Типы, реестр, CLI**

1. `types.ts`: в union `LegalDocumentCode` добавить `"MKR-INS-06"`.
2. `registry.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-06"`; `LEGAL_DOCUMENT_KIND_BY_CODE` + `"MKR-INS-06": "instruction",`; импорт `CABINET_INVENTORY_PREP_CONTENT` из `./documents/cabinet-inventory-prep.js`; в `LEGAL_RELEASES` последним:

```ts
  {
    code: "MKR-INS-06",
    revision: "2026.08/01",
    effectiveDate: "2026-08-30",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/inventarizatsiya-podgotovka/" },
  },
```

и в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-06/2026.08/01", content: CABINET_INVENTORY_PREP_CONTENT },
```

3. `verify-artifacts.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-06"`; `SAFE_FILE_NAME` → `ins-0[123456]`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[123456])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/cabinet-inventory-prep.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const CABINET_INVENTORY_PREP_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: подготовка и запуск инвентаризации",
    summary:
      "Инструкция менеджера: создание задания инвентаризации, выписки Честного Знака, фиксация снимка, доступ терминалов и запуск.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инвентаризация — сплошной пересчёт продукции. Менеджер готовит задание в кабинете: выбирает продукт и линию, загружает выписки Честного Знака, фиксирует снимок ожидаемых кодов и запускает задание. После запуска операторы выполняют пересчёт на терминалах — их работа описана в инструкции MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "Подготовка проходит пять этапов: «Параметры», «Выписки ЧЗ», «Проверка снимка», «Терминалы», «Запуск». Кабинет ведёт по ним последовательно и не даёт запустить задание, пока предыдущие этапы не завершены.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия организации, продуктов и линий в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "create",
        heading: "2. Создание задания",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Инвентаризации»",
            text: "В боковом меню кабинета выберите «Инвентаризации». В списке видны все задания с номером и статусом, продуктом и датами, линией и способом инвентаризации.",
            image: { id: "list", caption: "Список инвентаризаций" },
          },
          {
            kind: "step",
            title: "Задайте параметры",
            text: "Нажмите «Создать инвентаризацию» и заполните параметры задания: продукт (ровно один), «Способ инвентаризации» — «Без переупаковки» или «С переупаковкой», линию, «Шаблон этикетки короба» и период дат производства «с» и «по». Период применяется включительно.",
            image: { id: "parameters", caption: "Параметры задания инвентаризации" },
            expected: "Кабинет сохранил параметры и перевёл к этапу «Выписки ЧЗ».",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Способ определяет работу операторов: «Без переупаковки» — только сканирование, «С переупаковкой» — продукцию перекладывают в новые короба и печатают этикетки. Шаблон этикетки нужен именно для второго способа.",
          },
        ],
      },
      {
        id: "exports",
        heading: "3. Выписки Честного Знака",
        blocks: [
          {
            kind: "paragraph",
            text: "Снимок ожидаемых кодов собирается из выписок Честного Знака: нужен отдельный результат по каждому из шести статусов — «Эмитирован», «В обороте», «Нанесён», «Выбыл», «Списан», «Расформирован». Пустая выгрузка с нулём строк считается успешной: значит, кодов в этом статусе нет.",
          },
          {
            kind: "step",
            title: "Закажите выписки из Честного Знака",
            text: "Нажмите «Заказать из Честного Знака» — кабинет закажет отчёты по всем шести статусам и сам загрузит готовые файлы. Состояние каждого заказа видно рядом со статусом: «В очереди», «Заказано», «Файл получен», «Импортировано».",
            image: { id: "exports", caption: "Выписки по статусам кодов" },
          },
          {
            kind: "step",
            title: "Устраните блокировку заказа",
            text: "Если заказ недоступен, кабинет называет причину: «Укажите ИНН организации в реквизитах», «Укажите группу продукции Честного Знака в карточке товара», «Подключите агент КЭП в разделе «Интеграции»» или «Обновите токен True API в разделе «Интеграции»». Исправьте указанное и повторите заказ.",
            image: { id: "exports-blocked", caption: "Заказ выписок заблокирован" },
          },
          {
            kind: "step",
            title: "Загрузите файл вручную, если Честный Знак отказал",
            text: "Для статуса, который не удалось заказать, перетащите файл выписки в его карточку или нажмите на неё и выберите файл. Максимальный размер — 64 МБ. Сообщение «Файл не прошёл проверку. Проверьте формат, статус и содержимое выписки.» означает, что файл относится к другому статусу или повреждён.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Все шесть статусов обязательны. Пока хотя бы по одному нет ни заказанного, ни загруженного результата, перейти к проверке снимка нельзя.",
          },
        ],
      },
      {
        id: "snapshot",
        heading: "4. Проверка снимка",
        blocks: [
          {
            kind: "step",
            title: "Сверьте шесть выписок и зафиксируйте снимок",
            text: "Нажмите «Проверить снимок» и убедитесь, что к каждому статусу привязана нужная загрузка. Затем нажмите «Зафиксировать снимок» — сервер посчитает итоговые количества и создаст неизменяемый снимок ожидаемых кодов.",
            image: { id: "snapshot", caption: "Проверка снимка перед фиксацией" },
            expected: "Снимок зафиксирован, кабинет показывает число ожидаемых кодов.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Зафиксированный снимок изменить нельзя — он определяет, какие коды считаются ожидаемыми во всей инвентаризации. Проверьте состав выписок до фиксации.",
          },
        ],
      },
      {
        id: "terminals",
        heading: "5. Терминалы и форма-задание",
        blocks: [
          {
            kind: "step",
            title: "Проверьте готовность терминалов",
            text: "На этапе «Доступ терминалов» видно, сколько терминалов назначено линии и сколько из них сейчас в сети. Задание появится на терминалах назначенной линии после запуска.",
            image: { id: "terminals", caption: "Доступ терминалов" },
          },
          {
            kind: "step",
            title: "Распечатайте форму-задание",
            text: "Нажмите «Открыть форму-задание» и распечатайте лист A4 со штрихкодом. Операторы сканируют этот штрихкод на терминале, и задание открывается автоматически — без поиска в списке.",
            image: { id: "task-form", caption: "Печатная форма-задание со штрихкодом" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Передайте распечатанную форму на линию до запуска. Работа операторов по ней описана в инструкции MKR-INS-05.",
          },
        ],
      },
      {
        id: "launch",
        heading: "6. Запуск",
        blocks: [
          {
            kind: "step",
            title: "Остановите складские движения и запустите",
            text: "На этапе «Запуск» кабинет показывает, сколько кодов ожидается по снимку, и требует подтвердить, что движения по складу остановлены. Отметьте подтверждение и нажмите «Запустить инвентаризацию».",
            image: { id: "launch", caption: "Запуск инвентаризации" },
            expected: "Задание перешло в статус «В работе» и появилось на терминалах линии.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Приёмка и отгрузка во время пересчёта дают расхождения, которые придётся разбирать вручную. Останавливайте движения до запуска, а не после.",
          },
          {
            kind: "paragraph",
            text: "Дальнейший контроль хода, исправления, закрытие инвентаризации и итоговые документы описаны в отдельной инструкции по контролю и закрытию.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "7. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Нужного продукта нет в списке",
                detail: "В задание можно взять только активный продукт. Архивные помечены «не используется» — снимите архивный признак в каталоге или выберите другой продукт.",
              },
              {
                term: "Честный Знак отклонил заказ статуса",
                detail: "Загрузите файл для этого статуса вручную — кабинет прямо предлагает такой путь в сообщении об ошибке.",
              },
              {
                term: "Файл выписки не проходит проверку",
                detail: "Проверьте, что выгрузка сделана по нужному статусу и продукту и не была отредактирована. Максимальный размер файла — 64 МБ.",
              },
              {
                term: "Терминалы не в сети перед запуском",
                detail: "Запустить задание можно, но операторы увидят его только после подключения терминалов. Проверьте связь на линии до начала работ.",
              },
              {
                term: "Ошиблись в параметрах после фиксации снимка",
                detail: "Снимок неизменяем. Создайте новое задание с верными параметрами; ошибочное останется в списке как черновик.",
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

Примечание для исполнителя: ОБЯЗАТЕЛЬНО сверить каждую цитату в кавычках-ёлочках с `apps/admin/src/i18n/ru.json` (`pages.inventory.*`) И с фактическими скриншотами Task 2 (открыть через Read). Если строка есть в словаре, но на кадре её нет (мёртвый ключ — на станции таких нашлось пять) или подпись другая — поправить формулировку по факту и зафиксировать в отчёте. Особое внимание: названия кнопок этапов и статусов заказа. Контент-контракт: термины definition-list не должны заканчиваться пунктуацией.

- [ ] **Step 4: Pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов + `"MKR-INS-06"`; счётчик уникальных маршрутов 13 → 14 (строка 58).
2. `test/artifact-manifest.test.ts`: фикстурная запись MKR-INS-06 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-06_2026.08-01_ru.pdf`, effectiveDate `2026-08-30` в per-code ветвлении `artifactEntry()`); счётчики 17 → 18 записей, PDF 13 → 14 (включая счётчики генерации, списка запросов и файлов на диске в том же файле).
Править по фактическим падениям, не ослабляя.

- [ ] **Step 5: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (instruction-assets — шесть инструкций). Prettier на затронутые файлы.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-06 inventory preparation instruction content"
```

---

### Task 4: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/pages/instruktsii/inventarizatsiya-podgotovka/index.astro`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`

**Interfaces:**
- Consumes: релиз/контент Task 3; `InstructionDocument.astro` (`{ page, images: Record<string, string> }`).
- Produces: страница `/instruktsii/inventarizatsiya-podgotovka/`; загрузчик принимает `ins-06`.

- [ ] **Step 1: Базовая линия падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — `DESCRIPTION_BY_CODE` без MKR-INS-06 (satisfies), pinned-счётчики, completeness против реального `public/legal` (красный до Task 5 вместе с build-зависимыми сьютами). Если vitest не резолвит `@markiro/legal-documents` или база подозрительно зелёная — сначала `pnpm --filter @markiro/legal-documents build`.

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

```ts
  "MKR-INS-06": {
    ru: "Печатная инструкция менеджера: создание задания инвентаризации, выписки Честного Знака, фиксация снимка, терминалы и запуск.",
    en: "Printable manager instruction: creating a stock-count task, Chestny Znak exports, fixing the snapshot, terminals, and launch.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/inventarizatsiya-podgotovka/index.astro` (зеркало соседних страниц в `apps/landing/src/pages/instruktsii/`):

```astro
---
import list from "@markiro/legal-documents/assets/instructions/mkr-ins-06/list.png?url";
import parameters from "@markiro/legal-documents/assets/instructions/mkr-ins-06/parameters.png?url";
import exports from "@markiro/legal-documents/assets/instructions/mkr-ins-06/exports.png?url";
import exportsBlocked from "@markiro/legal-documents/assets/instructions/mkr-ins-06/exports-blocked.png?url";
import snapshot from "@markiro/legal-documents/assets/instructions/mkr-ins-06/snapshot.png?url";
import terminals from "@markiro/legal-documents/assets/instructions/mkr-ins-06/terminals.png?url";
import taskForm from "@markiro/legal-documents/assets/instructions/mkr-ins-06/task-form.png?url";
import launch from "@markiro/legal-documents/assets/instructions/mkr-ins-06/launch.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  list,
  parameters,
  exports,
  "exports-blocked": exportsBlocked,
  snapshot,
  terminals,
  "task-form": taskForm,
  launch,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-06", "ru")} images={images} />
```

- [ ] **Step 4: Загрузчик артефактов**

`apps/landing/src/lib/legal-artifacts.ts`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[123456])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Pinned-тесты лендинга**

Ожидаемая арифметика (править по фактическим падениям; расхождение — investigate):
- `legal-artifacts.test.ts`: запись MKR-INS-06; 17 → 18 всего, `pdfa-2b` 13 → 14, `template-docx` 4.
- `legal-rendered-page.test.ts`: `/legal/` PDF 9 → 10, SHA 11 → 12 (строки ~170–171); `/en/legal/` без изменений (4 и 6). ОТДЕЛЬНО: в этом же файле есть список ожидаемых кодов реестра в completeness-проверке — добавить туда `"MKR-INS-06"` (в MKR-INS-05 про него забыли, и падение всплыло только на финальной задаче).
- `seo.test.ts`: sitemap `<url>` 58 → 60 в ДВУХ местах (строки ~84 и ~144).

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: PASS, кроме известных красных (completeness + build-зависимые — до Task 5). Build не запускать. Prettier на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src apps/landing/test
git commit -m "feat(landing): MKR-INS-06 inventory preparation instruction page"
```

---

### Task 5: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-06_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–4; тулчейн SOFFICE_BIN=/opt/homebrew/bin/soffice (LibreOffice 26.2.5.2), VERAPDF_CONTAINER_RUNTIME=docker (sandbox off для docker-команд; таймауты до 600000 мс). Прецедент аттестации: `git log --oneline --all --grep="attest the new release set"` и `git show <sha> -- deploy/production`.
- Produces: набор из 18 артефактов; аттестация `MKR-LEGAL-2026.08-06-2026-08-30`.

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

Expected: `Verified 18 immutable legal artifacts`. Read PDF (страницы 1–5): титул «Кабинет: подготовка и запуск инвентаризации», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-06», восемь скриншотов с подписями, «Шаг N.», < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-06_2026.08-01_ru.pdf`
2. `legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-06-2026-08-30"`, `manifestSha256` → новый, запись ins-06 после ins-05 (лексикографический порядок), фактический sha256.
3. `verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; `EXPECTED_PDFS` + `"markiro_mkr-ins-06_2026.08-01_ru.pdf"` после ins-05.
4. `legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-06), счётчики 13 → 14.
5. `edge-contract.test.mjs` (строка ~941): `artifacts.length` 17 → 18.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin test
pnpm format:check
```

Expected: всё PASS. В dist: новая страница 8 `<img>` / 8 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01…06.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-06 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: харнесс (T1 = ключевое отличие спеки), скриншоты (T2 = раздел 2), документ/контент/CLI (T3 = раздел 1 и часть 3), лендинг (T4), артефакт+аттестация (T5). Оба пути выписок ЧЗ — в контенте T3 (раздел 3 документа), ход/закрытие только отсылкой (раздел 6).
- Числа: маршруты 14; артефакты 18 (14 PDF + 4 DOCX); лендинг-фикстуры 18/14/4; `/legal/` PDF 10 / SHA 12; sitemap 60 (два места); аттестация 14 PDF; edge-contract 18.
- Image ids: все восемь используются ровно один раз; списки в T2, T3 и T4 идентичны.
- Контент несёт явное стоп-условие сверки цитат с i18n И со скриншотами (риск мёртвых ключей кабинета не проверялся ранее).
- Урок MKR-INS-05 учтён в T4 Step 5: список кодов в completeness-проверке `legal-rendered-page.test.ts` обновляется вместе со счётчиками, а не забывается до финальной задачи.
- Процессное требование спеки: финальному whole-branch ревью — линза «текст ↔ скриншоты ↔ i18n» (задаётся контролёром при диспатче).
