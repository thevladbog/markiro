# План 1e3: приложение — типовые шаблоны в мастере, список «Шаблоны» (включение, категории) и экран «Умолчания шаблонов» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мастер первого запуска создаёт типовые шаблоны этикеток домена и делает коробку 58×40 и паллету 100×150 умолчаниями организации, а шаг «Проверка» говорит, сколько шаблонов каждого назначения появится. В разделе офиса «Каталог» появляются «Шаблоны» — таблица всех шаблонов с поиском и отбором, где обе роли включают и выключают шаблон и меняют его категории, — и «Умолчания шаблонов» — один документ: умолчания организации и умолчания категорий. Редактор шаблона (создание, копия, переименование, импорт, форма размеров, предпросмотр, выгрузки, удаление) — план 1e4.

**Architecture:**

- `src/wizard/wizard-form.ts` — `stockTemplates()` из трёх строителей `@markiro/domain` с `orgDefault` у двух умолчаний, `stockTemplateCounts`, `MAX_STOCK_TEMPLATES`; `toBootstrapRequest` шлёт `templates`, шаг «Проверка» называет их число по назначениям.
- `src/office/catalog-queries.ts` и `src/office/template-options.ts` — общие для товаров и шаблонов запросы (`useProductGroups`, `useTemplates`, с задачи 6 `useTemplateDefaults`) и выбор шаблона для слота (`templateOptions`, теперь для любого назначения); оба перенесены из `products/`.
- `src/office/templates/` — тексты (`template-text.ts`: размер, разрешение, категории, отказ `template_is_default` словами), список (`template-list.ts`: сортировка, поиск, отбор, слияние ответа записи в сводку), страница `TemplatesPage` с окнами `TemplateStateDialog` и `TemplateCategoriesDialog` (на переиспользуемом `CategoryScopeField`), страница `TemplateDefaultsPage` с черновиком `defaults-form.ts` и окном `CategoryDefaultDialog`.
- Хост, `proto`, оболочка, станция и `packages/*` не меняются: схемы, сборщики тел и методы `HostApi` готовы с плана 1e2.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, TanStack Query 5.101, i18next, `@markiro/ui` (`Table`, `FilterBar`, `Select` с `native`, `RadioGroup`, `Checkbox`, `Badge`, `StatusChip`, `RowActions`, `Card`, `Alert`), `@markiro/domain` (`buildDefaultLabelTemplates`, `buildDuplicateLabelTemplates`, `buildPalletLabelTemplates`, `DEFAULT_BOX_LABEL_TEMPLATE_NAME`, `PALLET_LABEL_TEMPLATE_NAME`; правило слота — через `templateFitsSlot`), Vitest 4 с jsdom.

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1e3-design.md`: границы плана и решения D1–D10; всё, что брифом не названо, — в «Перенесено».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §4.3 (схема каталога, документ умолчаний), §4.5 (маршруты и фикстуры), §4.6 (ошибки), §4.8 (роли), §5.5 (офис), §6 (контракт), §8 (строка 1e).
- Планы 1e1 и 1e2 (`docs/superpowers/plans/2026-10-03-standalone-1e1-host-catalog-templates.md`, `docs/superpowers/plans/2026-10-04-standalone-1e2-office-catalog-station-copies.md`), их «Отклонения при исполнении» и «Перенесено» (пункты для плана 1e3).
- Облако: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (типовой набор и умолчания нового арендатора), `apps/admin/src/pages/labels/{index.tsx,scope.ts}` (`describeTemplateScope`, `describeDefaultConflict`, `PURPOSE_TO_TONE`), `apps/admin/src/pages/labels/editor/index.tsx` (`scopeMode`, `scopeSearch`, `visibleGroups`).

## Global Constraints

**Решения контроллера** (обязательные; владелец может их пересмотреть; уточнения планировщика помечены «Уточнение»)

- D1. План 1e делится так: 1e1 (хост) и 1e2 (слой протокола всего каталога, «Товары», копии станции) готовы; 1e3 — этот план: мастер шлёт типовые шаблоны, список «Шаблоны» (что есть, включить и выключить, сузить категории) и экран «Умолчания шаблонов»; 1e4 — редактор шаблона (создание, копия, переименование, импорт ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки, удаление) с вопросом зависимости `opentype.js`; 1f — вход оператора на станции. Документы этого плана (§8 строка 1e, §5.5, `AGENTS.md`) нигде не числят за 1e3 редактор, импорт, предпросмотр и выгрузки.
- D2. Мастер без нового шага: `toBootstrapRequest` в `src/wizard/wizard-form.ts` добавляет `templates` из трёх строителей домена с `orgDefault: true` ровно у шаблона `DEFAULT_BOX_LABEL_TEMPLATE_NAME` (назначение `box`) и `PALLET_LABEL_TEMPLATE_NAME` (назначение `pallet`) и ни у чего больше (умолчания дубликата нет, как в облаке; добавить его в автономном продукте — вопрос владельцу). Шаг «Проверка» одной короткой фразой говорит, что будет создано (число по назначениям). Тесты: запрос проходит строгую `bootstrapRequestSchema`; ровно одно `orgDefault` у коробов и у паллет, ни одного у дубликатов; числа 16/2/2 — только как их дают строители (оба умолчания есть, итог не больше потолка хоста 32, потолок — константа `MAX_STOCK_TEMPLATES`, зеркало `bootstrap::MAX_STOCK_TEMPLATES`).
- D3. `DefaultBodyLimit` не меняется. Настоящий набор — около 31 КБ при пределе axum по умолчанию 2 МиБ; вопрос владельца из плана 1e1 закрыт тестом, который держит тело мастера меньше 256 КиБ (восьмая часть предела, с запасом на рост набора), и одним предложением `AGENTS.md`; пересмотреть, только если набор подрастёт к пределу.
- D4. «Шаблоны» — таблица, не облачная сетка карточек с миниатюрами (растеризатора в плане нет): название, назначение (тег со словом), размер («58 × 40 мм», «—», где в сводке `null`), разрешение («—» без него), категории (все / одна по названию / «Категорий: N», полный список в `title`, как у `describeTemplateScope` облака), состояние словом, метка «Типовой», действия строки с названием шаблона в доступном имени. Отбор по назначению и состоянию (все / включённые / выключенные), поиск по названию. Ни создания, ни копии, ни переименования, ни удаления, ни действий с макетом (план 1e4). Уточнение: столбец разрешения называется «Разрешение макета» — сводка отдаёт `dpi` макета, а станция печатает в разрешении своего принтера (спецификация облака 2026-09-10).
- D5. Два действия строки: включить/выключить и «Категории» (окно). Оба идут через `updateTemplate` с `templateUpdate(template, next)` из СВОДКИ (`name`, `enabled`, `chzProductGroupCodes`, `rev`) и ревизией ОТКРЫТОЙ строки в `expectedRev`. Выключение шаблона-умолчания — `conflict` `template_is_default`: объяснить словами (умолчание организации и/или названные категории, как `describeDefaultConflict` облака) и где менять — экран умолчаний. `stale_revision` — «Загрузить заново». Сужение, на которое опирается умолчание, отвергается так же. Уточнение: оба направления переключения спрашивают подтверждение, как у операторов: выключение — с вариантом `destructive`, включение — лёгкое.
- D6. Переиспользуемое поле категорий `CategoryScopeField` (его возьмёт редактор 1e4): радио «Все категории» / «Только выбранные», поиск по названиям групп (как `scopeMode`, `scopeSearch`, `visibleGroups` редактора облака), флажки по названию группы, хотя бы одна выбранная при «Только выбранные»; на хост коды уходят ПО ВОЗРАСТАНИЮ (переставленный список — изменение, новая ревизия и макет до 256 КБ всем станциям), `null` — все категории. Группы — из `useProductGroups`. Уточнение: проверку «хотя бы одна» делает окно-потребитель, поле показывает переданную ошибку; выбранные коды не стираются при «Все категории», так что возврат к «Только выбранные» их возвращает.
- D7. Строка обновляется на месте ответом хоста, без перечитывания: в КЭШИРОВАННУЮ СВОДКУ сливаются `name`, `enabled`, `chzProductGroupCodes`, `stock` и `rev` ответа (`withTemplateChange`); размер, разрешение и язык остаются, макет в кэш не попадает. Порядок показа не зависит от порядка записей (сортировка при выводе).
- D8. «Умолчания шаблонов» (раздел «Каталог») правят ОДИН документ. Умолчания организации — три выбора («Не выбран» и включённые шаблоны своего назначения, подходящие слоту организации, `templateFitsSlot(template, { purpose, chzProductGroupCode: null })`, по названию); умолчания категорий — таблица строк (категория, назначение, шаблон, «Убрать») и окно «Добавить умолчание категории» (категория из справочника, назначение, шаблон, подходящий ЭТОЙ категории и назначению; занятое место дважды не предлагается). Видны только категории с умолчанием. Одна «Сохранить» шлёт документ целиком `templateDefaultsUpdate(defaults, expectedRev)` с `rev` ЗАГРУЖЕННОГО документа, ответ заменяет документ в кэше. Несохранённые правки видны, возврат к загруженному документу есть. Отказы: `validation_failed` на `defaultBoxTemplateId` / `defaultPalletTemplateId` / `defaultDuplicateTemplateId` — под своим выбором, на `categories.{i}.templateId` / `.chzProductGroupCode` / `categories.{i}` — под своей строкой; `stale_revision` — «Загрузить заново» (правки пропадают); шаблон, исчезнувший, пока экран открыт, — полевой отказ, не устаревшая запись. Уточнение: после полевого отказа страница перечитывает список шаблонов, чтобы отказанный шаблон показался с пометкой; кнопка возврата называется «Отменить изменения»; текст `stale_revision` называет и профиль организации.
- D9. Ни мёртвого интерфейса, ни вида «только чтение»: обе роли пишут каталог; кнопки записи закрыты `useCan("editCatalog")`, как у «Товаров», тесты проверяют, что их видят обе роли. Меню: два пункта раздела «Каталог» (`/templates`, `/template-defaults`) для обеих ролей; маршруты без `RequireRole`.
- D10. Станция, оболочка, хост, `proto`, `packages/*` не меняются, новых зависимостей нет. Пробел хоста — в отчёт, не чинить.

**Роли** (спецификация §4.8)

- Обе роли офиса читают и пишут каталог, шаблоны и умолчания (`useCan("editCatalog")` верно для обеих); вида «только чтение» нет. Права проверяет хост.

**Правила хоста, которые повторяет вебвью** (`apps/standalone/AGENTS.md` «Catalog and label templates»; `host/src/routes/{templates,template_defaults}.rs`)

- `PUT /v1/office/templates/{id}` меняет только присланное, `expectedRev` обязателен; `chzProductGroupCodes: null` — все категории; типовой шаблон можно выключить и сузить, но не переименовать, не менять его макет и не удалить.
- Шаблон-умолчание организации своего назначения или категории нельзя выключить или сузить так, чтобы он перестал подходить слоту: `conflict` с `details.constraint: template_is_default`, `organizationDefault` (boolean) и `categoryDefaults` (коды по возрастанию).
- Слот (`templates::fits`): включён, то же назначение, категории покрывают; слоту организации нужен шаблон для ВСЕХ категорий.
- `PUT /v1/office/template-defaults` заменяет документ целиком с `expectedRev`: не присланное умолчание организации — пусто, не присланное умолчание категории снимается. `validation_failed` — на `defaultBoxTemplateId` и соседях, на `categories.{i}.templateId`, на `categories.{i}.chzProductGroupCode` (неизвестная группа), на `categories.{i}` (слот дважды); `{i}` — номер в ПРИСЛАННОМ списке. Хост проверяет умолчания раньше ревизии.
- `rev` документа — самая новая ревизия записи организации, умолчаний категорий и их надгробий: правка профиля (`PUT /v1/office/org`) или любого умолчания делает старый `expectedRev` `stale_revision`.
- Неизменный шаблон или документ хост возвращает как есть, без новой ревизии.

**Тела запросов** (прежние сборщики `src/host/requests.ts`; новых сборщиков нет)

- Переключение — `templateUpdate(row, { enabled })` → `{ enabled, expectedRev }`.
- Категории — `templateUpdate(row, { chzProductGroupCodes })` → `{ chzProductGroupCodes, expectedRev }`: коды по возрастанию (`scopeCodes`), `null` — все категории.
- Умолчания — `templateDefaultsUpdate(input, document.rev)`: документ целиком, `null` за «Не выбран», все умолчания категорий страницы в её порядке.
- `expectedRev` — ревизия ОТКРЫТОЙ записи; запись никогда не повторяется с `details.currentRev`.

**Запись** (уроки планов 1d3–1e2)

- В `try` — только ожидаемая запись; колбэк после записи — после `try/catch`, каждый `catch` кончается `return`.
- Двойной щелчок — одна запись: в окнах её отсекает `FormDialog`, на странице умолчаний — свой ref-страж; в тестах оба щелчка — в одном `act`.

**Мастер** (факты типового набора)

- Строители и порядок облака: `buildDefaultLabelTemplates()` (короб), `buildDuplicateLabelTemplates()` (дубликат товара), `buildPalletLabelTemplates()` (паллета); сегодня 16, 2 и 2.
- `orgDefault: true` — только у «Коробка 58×40» (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) и «Паллета 100×150» (`PALLET_LABEL_TEMPLATE_NAME`); у остальных поля нет, хост читает это как `false`.
- `MAX_STOCK_TEMPLATES = 32` в `wizard-form.ts`; тело мастера меньше 256 КиБ (сейчас около 31 КБ).

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`; тексты даны в шагах задач целиком и переносятся буква в букву; кавычки — «ёлочки».
- Новые ключи: `wizard.review.templates` (задача 1); группа `office.templateChoice` — перенос четырёх ключей `office.products.*` выбора шаблона, слова те же (задача 2); группа `office.templates` (задачи 2–5); `office.nav.templates` (задача 3); группа `office.categoryScope` (задача 5); группа `office.templateDefaults` и `office.nav.templateDefaults` (задачи 6–7). Прежние тексты не меняются.
- Число в тексте — переменная `n` или именованные (`box`, `pallet`, `duplicate`), не `count`: с `count` i18next ищет формы множественного числа.

**Решения планировщика** (открытые места брифа)

- Раскладка умолчаний: две карточки — «Для организации» (три выбора) и «Для категорий» (таблица только существующих умолчаний и окно добавления): три слота организации постоянны, а умолчаний категорий единицы из 51×3 возможных.
- У «Шаблонов» нет страниц, поэтому `ProductsPager` не выносится: шаблонов на площадке десятки, хост отдаёт список целиком, поиск и отбор его сужают.
- Тон назначения — `PURPOSE_TO_TONE` облака (короб — violet, дубликат — teal, паллета — magenta, порядок объединения домена): одно назначение одного цвета в облаке и здесь. «Типовой» — `Badge` тона `steel` (признак, не фаза); состояние — `StatusChip`: включён — `active`, выключен — `retired`.
- Общие модули: `useProductGroups`, `useTemplates` и `templateOptions` переносятся из `products/` в `src/office/`, ключи `templateOptions` — в `office.templateChoice`: страницы шаблонов — второй и третий потребитель, а разделы офиса друг друга не импортируют.
- `useTemplateDefaults` и `officeKeys.templateDefaults` приходят в задаче 6 вместе с первым читателем, `CategoryScopeField` — в задаче 5 вместе с окном «Категории» (бриф ставил их в общие куски): у хука без читателя нечего проверять, кроме мока, а поле проверяется и само, и в окне.
- Страница умолчаний читает документ, шаблоны и группы один раз за посещение и передаёт их форме: форма пересоздаётся на каждой новой ревизии, и свой запрос перечитывал бы список при каждом сохранении.
- `StaleAlert` и `WriteFailureAlert` (`src/office/page-state.tsx`) получают необязательный текст устаревшей записи: у умолчаний он называет профиль организации.
- Добавить умолчание категории нельзя, пока не загрузились и группы, и шаблоны; выбор шаблона в строке умолчания категории — без «Не выбран» (умолчание категории снимает «Убрать»).
- Задачи 6 и 7 делят страницу умолчаний: организация и механизм сохранения, затем категории; задача 8 — сверка документов.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля в `src/`); у каждой таблицы свой `empty`, каждое окно — `FormDialog` (в нём `closeLabel`); состояние словами, не одним цветом; где результат меняется без перехода — `aria-live`.
- Новых зависимостей нет. `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto` и `apps/standalone/src-tauri` не меняются; Rust не меняется, набор Cargo остаётся 41 набор, 453 теста.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам). Правки внутри шага идут сверху вниз по файлу, одна за другой. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Create» — новый файл, ровно как в блоке; «Заменить содержимое … целиком» — файл становится ровно таким, как в блоке; «удалить фрагмент» (только в мутациях) — фрагмент убирается, а строка, где он стоял, может остаться пустой.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> "$TMPDIR/before"` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным сообщением; затем `cp "$TMPDIR/before" <файл>`, `cmp "$TMPDIR/before" <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от эффекта, — скрытый флейк. Ждать эффект явно (`waitFor`), «ровно N раз» проверять так: `waitFor`, два хода `await new Promise((resolve) => setImmediate(resolve))`, снова та же проверка. Два щелчка, которые должны быть одновременными, — в одном `act`.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`), поэтому опечатка в ключе роняет тест, а не показывает ключ.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс: он делает флейк эффекта постоянным. Стенд — два временных файла внутри пакета (из `$TMPDIR` Vite не грузит); запустить и сразу удалить, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  <!-- prettier-ignore -->
  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`, so an assertion that depends on an
  // effect right after `findBy*` fails every time instead of now and then.
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setImmediate", {
    configurable: true,
    writable: true,
    value: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      realSetTimeout(callback, 3, ...args),
  });
  ```

  `apps/standalone/vitest.delay.config.ts`:

  <!-- prettier-ignore -->
  ```ts
  import react from "@vitejs/plugin-react";
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/delayed-immediate.setup.ts", "test/setup.ts"],
    },
  });
  ```

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`, затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

**Счёт тестов**

- До плана: Vitest — 40 файлов, 958 тестов; cargo — 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107). Каждое «Expected» ниже выведено из этих чисел тестами самого плана; расхождение значит, что шаг применён не так (а тесты, которые исполнитель добавит сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку.

<!-- prettier-ignore -->
```text
apps/standalone/src/wizard/{wizard-form.ts,BootstrapWizard.tsx}                          задача 1
apps/standalone/test/{wizard-form.test.ts,wizard.test.tsx}, test/support/wizard.ts        задача 1
apps/standalone/src/office/{catalog-queries,template-options}.ts (из products/)           задачи 2, 6
apps/standalone/src/office/products/{ProductsPage,ProductDialog}.tsx (импорты)           задача 2
apps/standalone/src/office/templates/{template-text,template-list}.ts                     задачи 2, 3
apps/standalone/test/{template-text,template-list,template-options}.test.ts              задача 2
apps/standalone/src/office/templates/TemplatesPage.tsx, test/templates-page.test.tsx      задачи 3–5
apps/standalone/src/office/{nav.ts,routes.tsx}                                            задачи 3, 6
apps/standalone/src/office/templates/{TemplateFailureAlert,TemplateStateDialog}.tsx       задача 4
apps/standalone/src/office/templates/{category-scope.ts,CategoryScopeField.tsx}           задача 5
apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx                         задача 5
apps/standalone/test/category-scope-field.test.tsx                                        задача 5
apps/standalone/src/office/{office-query.ts,page-state.tsx}, test/form-dialog.test.tsx    задача 6
apps/standalone/src/office/templates/{defaults-form.ts,TemplateDefaultsPage.tsx}          задачи 6, 7
apps/standalone/test/{defaults-form.test.ts,template-defaults-page.test.tsx}              задачи 6, 7
apps/standalone/src/office/templates/CategoryDefaultDialog.tsx                            задача 7
apps/standalone/src/host/protocol.ts (комментарий)                                        задача 8
apps/standalone/src/app/shell.css                                                         задачи 3, 5
apps/standalone/src/i18n/ru.json                                                          задачи 1–7
apps/standalone/AGENTS.md                                                                 задачи 1, 3–8
спецификация: §4.5, §6 — задача 1; §5.5 — задачи 3–7; §5.5, §8 — задача 8
```

Мастер (задача 1) не зависит от экранов и идёт первым. Задача 2 переносит общие модули каталога и добавляет тексты и слияние ответа, которые берут обе страницы. Страница «Шаблоны» приходит без кнопок записи (задача 3); переключение (задача 4) и категории (задача 5) приходят каждое со своим окном, поэтому мёртвых кнопок нет ни на одном коммите. Страница умолчаний — сначала умолчания организации и механизм сохранения (задача 6), затем умолчания категорий (задача 7). Каждая задача обновляет документы о том, что сама сделала; задача 8 сверяет оставшиеся места, где 1e3 ещё числит редактор. Итоговые ворота — в «Итоговой проверке плана».

---

### Task 1: Мастер шлёт типовые шаблоны (D2, D3)

Мастер первого запуска остаётся без нового шага (D2): `toBootstrapRequest` добавляет `templates` — типовые шаблоны, которые строит `@markiro/domain`: коробы (`buildDefaultLabelTemplates`), дубликаты (`buildDuplicateLabelTemplates`) и паллеты (`buildPalletLabelTemplates`), в порядке, в котором облако засевает нового арендатора (`tenant-provisioning.service.ts`). `orgDefault: true` стоит ровно у «Коробка 58×40» (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) и «Паллета 100×150» (`PALLET_LABEL_TEMPLATE_NAME`); у дубликатов умолчания нет, как в облаке; у остальных поле опущено, и хост читает его как `false`. Шаг «Проверка» одной фразой называет, сколько шаблонов каждого назначения появится, чтобы администратора не удивили двадцать шаблонов: `stockTemplateCounts` отдаёт числа под теми же именами, что переменные текста, поэтому перепутать места нельзя.

Тесты не держат чисел домена (16/2/2): они читают их у строителей, проверяют строгую `bootstrapRequestSchema`, оба умолчания и потолок хоста 32 (`MAX_STOCK_TEMPLATES`, зеркало `bootstrap::MAX_STOCK_TEMPLATES`), а тело запроса — меньше 256 КиБ (D3: восьмая часть 2 МиБ axum, настоящее тело — около 31 КБ). `EXPECTED_REQUEST` в `test/support/wizard.ts` теперь говорит, что несёт тело (`templates: EXPECTED_TEMPLATES`, собранные в тесте из тех же строителей), поэтому тесты первого запуска в `test/app.test.tsx` и `test/wizard.test.tsx`, которые сравнивают тело целиком, ловят и пропажу шаблонов, и лишний `orgDefault`.

**Files:**

- Modify: `apps/standalone/src/wizard/wizard-form.ts`, `apps/standalone/src/wizard/BootstrapWizard.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/support/wizard.ts`, `apps/standalone/test/wizard-form.test.ts`, `apps/standalone/test/wizard.test.tsx` (Modify); `apps/standalone/test/app.test.tsx` не меняется, но его тесты первого запуска сравнивают новое `EXPECTED_REQUEST`
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Protocol»), спецификация §4.5 (абзац под таблицей), §6

**Interfaces:**

- Consumes:
  - `buildDefaultLabelTemplates`, `buildDuplicateLabelTemplates`, `buildPalletLabelTemplates`, `DEFAULT_BOX_LABEL_TEMPLATE_NAME`, `PALLET_LABEL_TEMPLATE_NAME`, `type LabelTemplateSpec` — `@markiro/domain`;
  - `bootstrapRequestSchema`, `type StockTemplate`, `type TemplatePurpose`, `type BootstrapRequest` — `src/host/protocol.ts` (план 1e2).
- Produces:
  - `src/wizard/wizard-form.ts`: `MAX_STOCK_TEMPLATES = 32`, `stockTemplates(): StockTemplate[]`, `type StockTemplateCounts = { box: number; pallet: number; duplicate: number }`, `stockTemplateCounts(templates: readonly Pick<StockTemplate, "purpose">[]): StockTemplateCounts`; `toBootstrapRequest` шлёт `templates: stockTemplates()`;
  - `test/support/wizard.ts`: `reachReview()`, `completeWizard()`, `EXPECTED_TEMPLATES`, `EXPECTED_REQUEST` с `templates`;
  - ключ `wizard.review.templates`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/support/wizard.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { fireEvent, screen } from "@testing-library/react";

import type { BootstrapRequest } from "../../src/host/protocol.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { fireEvent, screen } from "@testing-library/react";

import type { BootstrapRequest, StockTemplate, TemplatePurpose } from "../../src/host/protocol.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
```

2. В `apps/standalone/test/support/wizard.ts`, фрагмент

<!-- prettier-ignore -->
```ts
}

/**
 * Fill every step with valid answers and press «Создать». The GLN has a
 * correct check digit: 4600682000013.
 */
export async function completeWizard(): Promise<void> {
  await screen.findByText("Шаг 1 из 5 · Администратор");
  type("Логин", " admin ");
  type("Имя и фамилия", " Ирина Смирнова ");
```

заменить на

<!-- prettier-ignore -->
```ts
}

/**
 * Fill every step with valid answers, up to the review. The GLN has a
 * correct check digit: 4600682000013.
 */
export async function reachReview(): Promise<void> {
  await screen.findByText("Шаг 1 из 5 · Администратор");
  type("Логин", " admin ");
  type("Имя и фамилия", " Ирина Смирнова ");
```

3. В `apps/standalone/test/support/wizard.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  next();

  await screen.findByText("Шаг 5 из 5 · Проверка");
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
}

/** The request `completeWizard` produces. */
export const EXPECTED_REQUEST: BootstrapRequest = {
```

заменить на

<!-- prettier-ignore -->
```ts
  next();

  await screen.findByText("Шаг 5 из 5 · Проверка");
}

/** Fill every step with valid answers and press «Создать». */
export async function completeWizard(): Promise<void> {
  await reachReview();
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
}

/** One family of the domain's stock templates as the wizard sends it. */
function family(
  purpose: TemplatePurpose,
  built: readonly { name: string; spec: LabelTemplateSpec }[],
  defaultName: string | null,
): StockTemplate[] {
  return built.map(({ name, spec }) =>
    name === defaultName ? { name, purpose, spec, orgDefault: true } : { name, purpose, spec },
  );
}

/**
 * The stock templates the wizard sends, built here from the domain's
 * builders, as the cloud seeds a new tenant: the dated box 58×40 and the
 * pallet 100×150 are the organization's defaults, a duplicate has none, and
 * every other template leaves `orgDefault` out.
 */
export const EXPECTED_TEMPLATES: StockTemplate[] = [
  ...family("box", buildDefaultLabelTemplates(), DEFAULT_BOX_LABEL_TEMPLATE_NAME),
  ...family("product_duplicate", buildDuplicateLabelTemplates(), null),
  ...family("pallet", buildPalletLabelTemplates(), PALLET_LABEL_TEMPLATE_NAME),
];

/** The request `completeWizard` produces. */
export const EXPECTED_REQUEST: BootstrapRequest = {
```

4. В `apps/standalone/test/support/wizard.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  },
  sscc: { boxNextSerial: 1500, palletNextSerial: 40 },
  lines: ["Линия 1", "Линия 2"],
};
```

заменить на

<!-- prettier-ignore -->
```ts
  },
  sscc: { boxNextSerial: 1500, palletNextSerial: 40 },
  lines: ["Линия 1", "Линия 2"],
  templates: EXPECTED_TEMPLATES,
};
```

5. В `apps/standalone/test/wizard-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  defaultWizardValues,
  fieldFromHost,
  stepOf,
  toBootstrapRequest,
  validateStep,
  type WizardValues,
} from "../src/wizard/wizard-form.js";

function values(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  hasValidCheckDigit,
  PALLET_LABEL_TEMPLATE_NAME,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { bootstrapRequestSchema, type TemplatePurpose } from "../src/host/protocol.js";
import {
  defaultWizardValues,
  fieldFromHost,
  MAX_STOCK_TEMPLATES,
  stepOf,
  stockTemplateCounts,
  stockTemplates,
  toBootstrapRequest,
  validateStep,
  type WizardValues,
} from "../src/wizard/wizard-form.js";
import { EXPECTED_TEMPLATES } from "./support/wizard.js";

function values(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
```

6. В `apps/standalone/test/wizard-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      },
      sscc: { boxNextSerial: 1, palletNextSerial: 0 },
      lines: ["Линия 1"],
    });
  });

```

заменить на

<!-- prettier-ignore -->
```ts
      },
      sscc: { boxNextSerial: 1, palletNextSerial: 0 },
      lines: ["Линия 1"],
      templates: EXPECTED_TEMPLATES,
    });
  });

```

7. В `apps/standalone/test/wizard-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(stepOf("passwordConfirm")).toBe("admin");
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(stepOf("passwordConfirm")).toBe("admin");
  });
});

describe("the wizard's stock templates", () => {
  it("go with the request as the strict schema reads it: the domain's box, duplicate and pallet sets, each with its purpose and layout", () => {
    const request = toBootstrapRequest(values());
    expect(bootstrapRequestSchema.parse(request)).toStrictEqual(request);
    expect(request.templates).toStrictEqual(EXPECTED_TEMPLATES);
    expect(stockTemplates()).toStrictEqual(EXPECTED_TEMPLATES);
  });

  it("make exactly the dated box 58×40 and the pallet 100×150 the organization's defaults, leave `orgDefault` out everywhere else, and give a duplicate none", () => {
    const templates = stockTemplates();
    expect(
      templates
        .filter((template) => template.orgDefault === true)
        .map(({ name, purpose }) => ({ name, purpose })),
    ).toStrictEqual([
      { name: DEFAULT_BOX_LABEL_TEMPLATE_NAME, purpose: "box" },
      { name: PALLET_LABEL_TEMPLATE_NAME, purpose: "pallet" },
    ]);
    expect(templates.filter((template) => "orgDefault" in template)).toHaveLength(2);
    expect(templates.some((template) => template.purpose === "product_duplicate")).toBe(true);
  });

  it("count each purpose as the domain builds it and stay within the host's cap of 32", () => {
    const templates = stockTemplates();
    expect(stockTemplateCounts(templates)).toStrictEqual({
      box: buildDefaultLabelTemplates().length,
      pallet: buildPalletLabelTemplates().length,
      duplicate: buildDuplicateLabelTemplates().length,
    });
    expect(MAX_STOCK_TEMPLATES).toBe(32);
    expect(templates.length).toBeLessThanOrEqual(MAX_STOCK_TEMPLATES);
  });

  it("keep the whole request under 256 KiB, an eighth of the host's 2 MiB body limit", () => {
    const body = JSON.stringify(toBootstrapRequest(values()));
    expect(new TextEncoder().encode(body).length).toBeLessThan(256 * 1024);
  });

  it("are counted by purpose", () => {
    const of = (purpose: TemplatePurpose) => ({ purpose });
    expect(
      stockTemplateCounts([
        of("box"),
        of("product_duplicate"),
        of("box"),
        of("pallet"),
        of("box"),
        of("product_duplicate"),
      ]),
    ).toStrictEqual({ box: 3, pallet: 1, duplicate: 2 });
    expect(stockTemplateCounts([])).toStrictEqual({ box: 0, pallet: 0, duplicate: 0 });
  });
});
```

8. В `apps/standalone/test/wizard.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import { BootstrapWizard } from "../src/wizard/BootstrapWizard.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
```

заменить на

<!-- prettier-ignore -->
```tsx
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
} from "@markiro/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import i18n from "../src/i18n/index.js";
import { BootstrapWizard } from "../src/wizard/BootstrapWizard.js";
import { completeWizard, EXPECTED_REQUEST, reachReview } from "./support/wizard.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
```

9. В `apps/standalone/test/wizard.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(EXPECTED_REQUEST));
  });

  it("stays on a step until its fields are right", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(EXPECTED_REQUEST));
  });

  it("says on the review step how many stock templates of each purpose it creates, each count in its own place", async () => {
    render(<BootstrapWizard onSubmit={vi.fn()} />);
    await reachReview();
    const box = buildDefaultLabelTemplates().length;
    const pallet = buildPalletLabelTemplates().length;
    const duplicate = buildDuplicateLabelTemplates().length;
    expect(
      screen.getByText(
        `Мастер создаст типовые шаблоны этикеток: для коробов — ${box}, для паллет — ${pallet}, для дубликатов товара — ${duplicate}.`,
      ),
    ).toBeTruthy();
    // The domain builds as many pallet templates as duplicates: distinct counts pin each place.
    expect(i18n.t("wizard.review.templates", { box: 3, pallet: 1, duplicate: 2 })).toBe(
      "Мастер создаст типовые шаблоны этикеток: для коробов — 3, для паллет — 1, для дубликатов товара — 2.",
    );
  });

  it("stays on a step until its fields are right", async () => {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx`
Expected: FAIL — 3 файла, `Tests  8 failed | 77 passed (85)`: `TypeError: stockTemplates is not a function` и `TypeError: stockTemplateCounts is not a function` (`test/wizard-form.test.ts`), `Unable to find an element with the text: Мастер создаст типовые шаблоны этикеток: …` (`test/wizard.test.tsx`), а тела без `templates` роняют «is trimmed and normalized», «creates the site from every answer» и «creates the site on a fresh host and opens the office». Тест размера тела уже проходит: шаблонов в теле ещё нет.

- [ ] **Step 3: Типовые шаблоны в запросе и на шаге «Проверка»**

1. В `apps/standalone/src/wizard/wizard-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { ssccSerialCapacity } from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest } from "../host/protocol.js";
import {
  isPlainText,
  issuerPrefix,
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  ssccSerialCapacity,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest, StockTemplate, TemplatePurpose } from "../host/protocol.js";
import {
  isPlainText,
  issuerPrefix,
```

2. В `apps/standalone/src/wizard/wizard-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  }
}

export function toBootstrapRequest(values: WizardValues): BootstrapRequest {
  return {
    admin: {
```

заменить на

<!-- prettier-ignore -->
```ts
  }
}

/** The most stock templates the host takes (`bootstrap::MAX_STOCK_TEMPLATES`). */
export const MAX_STOCK_TEMPLATES = 32;

/** One family of the domain's stock templates with its purpose. */
function family(
  purpose: TemplatePurpose,
  built: readonly { name: string; spec: LabelTemplateSpec }[],
  defaultName: string | null,
): StockTemplate[] {
  return built.map(({ name, spec }) =>
    name === defaultName ? { name, purpose, spec, orgDefault: true } : { name, purpose, spec },
  );
}

/**
 * The stock label templates the wizard sends: the domain's box,
 * product-duplicate and pallet sets, in the order the cloud seeds a new
 * tenant (`tenant-provisioning.service.ts`). The dated box 58×40
 * (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) and the pallet 100×150
 * (`PALLET_LABEL_TEMPLATE_NAME`) become the organization's defaults; a
 * duplicate gets none, as in the cloud. Every other template leaves
 * `orgDefault` out, which the host reads as `false`.
 */
export function stockTemplates(): StockTemplate[] {
  return [
    ...family("box", buildDefaultLabelTemplates(), DEFAULT_BOX_LABEL_TEMPLATE_NAME),
    ...family("product_duplicate", buildDuplicateLabelTemplates(), null),
    ...family("pallet", buildPalletLabelTemplates(), PALLET_LABEL_TEMPLATE_NAME),
  ];
}

/**
 * How many templates of each purpose a list holds, by the names the review's
 * text uses. A type, not an interface: i18next takes it as interpolation
 * values only with an implicit index signature.
 */
export type StockTemplateCounts = { box: number; pallet: number; duplicate: number };

export function stockTemplateCounts(
  templates: readonly Pick<StockTemplate, "purpose">[],
): StockTemplateCounts {
  const count = (purpose: TemplatePurpose) =>
    templates.filter((template) => template.purpose === purpose).length;
  return { box: count("box"), pallet: count("pallet"), duplicate: count("product_duplicate") };
}

export function toBootstrapRequest(values: WizardValues): BootstrapRequest {
  return {
    admin: {
```

3. В `apps/standalone/src/wizard/wizard-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    org: toOrgInput(values),
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
  };
}

```

заменить на

<!-- prettier-ignore -->
```ts
    org: toOrgInput(values),
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
    templates: stockTemplates(),
  };
}

```

4. В `apps/standalone/src/wizard/BootstrapWizard.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  fieldFromHost,
  MAX_LINES,
  stepOf,
  toBootstrapRequest,
  validateStep,
  WIZARD_STEPS,
```

заменить на

<!-- prettier-ignore -->
```tsx
  fieldFromHost,
  MAX_LINES,
  stepOf,
  stockTemplateCounts,
  toBootstrapRequest,
  validateStep,
  WIZARD_STEPS,
```

5. В `apps/standalone/src/wizard/BootstrapWizard.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          </div>
        ))}
      </dl>
    </>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
          </div>
        ))}
      </dl>
      <p className="standalone-wizard__note">
        {t("wizard.review.templates", stockTemplateCounts(request.templates ?? []))}
      </p>
    </>
  );
}
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "prefix": "Префикс SSCC",
      "box": "Первый номер короба",
      "pallet": "Первый номер паллеты",
      "lines": "Линии"
    },
    "errors": {
      "serial": "Укажите целое неотрицательное число",
```

заменить на

<!-- prettier-ignore -->
```json
      "prefix": "Префикс SSCC",
      "box": "Первый номер короба",
      "pallet": "Первый номер паллеты",
      "lines": "Линии",
      "templates": "Мастер создаст типовые шаблоны этикеток: для коробов — {{box}}, для паллет — {{pallet}}, для дубликатов товара — {{duplicate}}."
    },
    "errors": {
      "serial": "Укажите целое неотрицательное число",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx`
Expected: PASS — 3 файла, 85 тестов (`wizard-form` 12, `wizard` 7, `app` 66).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx`
Expected: PASS, 85 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 85; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/wizard/wizard-form.ts` не слать шаблоны: удалить фрагмент

<!-- prettier-ignore -->
```ts
    templates: stockTemplates(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx`
Expected: FAIL — `Tests  5 failed | 80 passed (85)`: тела без шаблонов (`expected { …(4) } to deeply equal { …(5) }`, `expected undefined to strictly equal [ …(20) ]`), а шаг «Проверка» считает пустой список (`Unable to find an element with the text: Мастер создаст типовые шаблоны этикеток: для коробов — 16, для паллет — 2, для дубликатов товара — 2.`).

Мутация 2. В `apps/standalone/src/wizard/wizard-form.ts` не делать паллету 100×150 умолчанием: фрагмент

<!-- prettier-ignore -->
```ts
buildPalletLabelTemplates(), PALLET_LABEL_TEMPLATE_NAME)
```

заменить на

<!-- prettier-ignore -->
```ts
buildPalletLabelTemplates(), null)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts -t "organization's defaults"`
Expected: FAIL — `expected [ { name: 'Коробка 58×40', …(1) } ] to strictly equal [ …(2) ]`: умолчание осталось одно.

Мутация 3. В `apps/standalone/src/wizard/wizard-form.ts` слать `orgDefault: false` у остальных шаблонов: фрагмент

<!-- prettier-ignore -->
```ts
{ name, purpose, spec, orgDefault: true } : { name, purpose, spec }
```

заменить на

<!-- prettier-ignore -->
```ts
{ name, purpose, spec, orgDefault: true } : { name, purpose, spec, orgDefault: false }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts -t "organization's defaults"`
Expected: FAIL — `expected [ …(20) ] to have a length of 2 but got 20`: поле есть у каждого шаблона.

Мутация 4. В `apps/standalone/src/wizard/wizard-form.ts` слать паллеты с назначением дубликата: фрагмент

<!-- prettier-ignore -->
```ts
...family("pallet", buildPalletLabelTemplates()
```

заменить на

<!-- prettier-ignore -->
```ts
...family("product_duplicate", buildPalletLabelTemplates()
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts -t "strict schema reads it"`
Expected: FAIL — `expected [ …(20) ] to strictly equal [ …(20) ]`: набор разошёлся со строителями.

Мутация 5. В `apps/standalone/src/wizard/wizard-form.ts` перепутать паллеты и дубликаты в числах: фрагмент

<!-- prettier-ignore -->
```ts
pallet: count("pallet"), duplicate: count("product_duplicate")
```

заменить на

<!-- prettier-ignore -->
```ts
pallet: count("product_duplicate"), duplicate: count("pallet")
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts -t "are counted by purpose"`
Expected: FAIL — `expected { box: 3, pallet: 2, duplicate: 1 } to strictly equal { box: 3, pallet: 1, duplicate: 2 }`.

Мутация 6. В `apps/standalone/src/wizard/wizard-form.ts` поднять потолок до 33: фрагмент

<!-- prettier-ignore -->
```ts
export const MAX_STOCK_TEMPLATES = 32;
```

заменить на

<!-- prettier-ignore -->
```ts
export const MAX_STOCK_TEMPLATES = 33;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts -t "host's cap"`
Expected: FAIL — `expected 33 to be 32`.

Мутация 7. В `apps/standalone/src/wizard/BootstrapWizard.tsx` не считать шаблоны запроса на шаге «Проверка»: фрагмент

<!-- prettier-ignore -->
```tsx
stockTemplateCounts(request.templates ?? [])
```

заменить на

<!-- prettier-ignore -->
```tsx
stockTemplateCounts([])
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx -t "review step"`
Expected: FAIL — `Unable to find an element with the text: Мастер создаст типовые шаблоны этикеток: для коробов — 16, для паллет — 2, для дубликатов товара — 2.`

Мутация 8. В `apps/standalone/src/i18n/ru.json` поменять местами переменные текста: фрагмент

<!-- prettier-ignore -->
```json
для паллет — {{pallet}}, для дубликатов товара — {{duplicate}}
```

заменить на

<!-- prettier-ignore -->
```json
для паллет — {{duplicate}}, для дубликатов товара — {{pallet}}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx -t "review step"`
Expected: FAIL — `expected 'Мастер создаст типовые шаблоны этикет…' to be 'Мастер создаст типовые шаблоны этикет…'`: паллет и дубликатов в наборе домена поровну, поэтому места переменных ловит сравнение текста с числами 3, 1 и 2.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

The wizard (`POST /v1/bootstrap`) takes the stock templates the app builds
with `@markiro/domain` (plan 1e3) as an optional `templates` list, so a
wizard from before then still works: at most 32 (`MAX_STOCK_TEMPLATES`; the
domain builds 20), each a name, a purpose and a layout checked as any
template's, stored enabled, for every category and `stock`, in the
wizard's one transaction, so a refusal creates nothing. The whole request
must stay under axum's default 2 MiB body limit (about eight maximum-size
layouts, where the domain's real 20-template set is about 31 KB): a larger
body is `validation_failed` without `details.field`. No route-level
`DefaultBodyLimit` is set, and raising it is an owner or plan 1e3 decision.
`orgDefault: true` on one template of a purpose makes it the organization's
default of that purpose, so the request names no id it does not have yet; a
second of the same purpose is `validation_failed` on
`templates.{i}.orgDefault`. The `host.bootstrap` row counts them
(`templateCount`).

Plan 1e1 built the host's side and plan 1e2 the webview's: Zod schemas for
every catalog shape and a builder for every office request body of the catalog
```

заменить на

<!-- prettier-ignore -->
```text
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

The wizard (`POST /v1/bootstrap`) takes the stock templates as an optional
`templates` list, so a wizard from before plan 1e3 still works: at most 32
(`MAX_STOCK_TEMPLATES`), each a name, a purpose and a layout checked as any
template's, stored enabled, for every category and `stock`, in the wizard's
one transaction, so a refusal creates nothing. The app's wizard sends them
since plan 1e3: `stockTemplates` (`src/wizard/wizard-form.ts`) builds the
domain's box, product-duplicate and pallet sets (20 templates today;
`test/wizard-form.test.ts` reads the counts from the builders and keeps the
total within `MAX_STOCK_TEMPLATES`, which `wizard-form.ts` mirrors), and the
review step says how many of each purpose it creates. `orgDefault: true` on
one template of a purpose makes it the organization's default of that purpose,
so the request names no id it does not have yet; a second of the same purpose
is `validation_failed` on `templates.{i}.orgDefault`. The wizard sets it on
the dated box 58×40 (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) and the pallet 100×150
(`PALLET_LABEL_TEMPLATE_NAME`), as the cloud seeds a new tenant, and leaves it
out everywhere else: the cloud has no duplicate default, and whether the
standalone sets one is an owner question. The whole request must stay under
axum's default 2 MiB body limit (about eight maximum-size layouts): a larger
body is `validation_failed` without `details.field`. No route-level
`DefaultBodyLimit` is set, and plan 1e3 keeps it so: the wizard's body is
about 31 KB, and `test/wizard-form.test.ts` holds it under 256 KiB, an eighth
of the limit, so only a stock set that grows toward the limit reopens the
question. The `host.bootstrap` row counts them (`templateCount`).

Plan 1e1 built the host's side and plan 1e2 the webview's: Zod schemas for
every catalog shape and a builder for every office request body of the catalog
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`test/template-eligibility.test.ts` the slot rule's), the station's copies of
products, templates and category defaults («Reference sync», «Local
database») and the office's «Товары» page («Office pages»). The template
screens, the defaults screen and the wizard's `templates` come with plan 1e3;
the `HostApi` methods and the builders they call are in place.

## Reference sync

```

заменить на

<!-- prettier-ignore -->
```text
`test/template-eligibility.test.ts` the slot rule's), the station's copies of
products, templates and category defaults («Reference sync», «Local
database») and the office's «Товары» page («Office pages»). The template
screens and the defaults screen come with plan 1e3, whose wizard already
sends the stock templates (above); the `HostApi` methods and the builders
they call are in place.

## Reference sync

```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
the whole document.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard; its
optional `templates`, which plan 1e3 sends, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. Response types, which
```

заменить на

<!-- prettier-ignore -->
```text
the whole document.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard; its
`templates`, built by `stockTemplates` since plan 1e3, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. Response types, which
```

4. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
Тело запроса мастера ограничено 2 МиБ — пределом тела запроса axum по умолчанию: это
около восьми макетов предельного размера (настоящий набор домена из 20 шаблонов —
около 31 КБ); тело больше отвечает `validation_failed` без `details.field`.
`DefaultBodyLimit` на маршруте не задан, и его повышение — решение владельца или
плана 1e3.

Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).
```

заменить на

<!-- prettier-ignore -->
```text
Тело запроса мастера ограничено 2 МиБ — пределом тела запроса axum по умолчанию: это
около восьми макетов предельного размера (настоящий набор домена из 20 шаблонов —
около 31 КБ); тело больше отвечает `validation_failed` без `details.field`.
`DefaultBodyLimit` на маршруте не задан, и план 1e3 его не задаёт: мастер приложения
шлёт типовые шаблоны домена (`stockTemplates`), тело его запроса — около 31 КБ, и
тест держит его меньше 256 КиБ, восьмой части предела; вопрос вернётся, только если
типовой набор вырастет к пределу. Умолчаниями организации мастер делает коробку
58×40 с датами и паллету 100×150, как облако при создании арендатора; умолчания
дубликата он не назначает (в облаке его нет; вопрос владельцу).

Офисные маршруты требуют и ключ устройства, и токен сессии этого же устройства
(заголовок `X-Office-Session`).
```

5. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  потерь, Vitest разбирает их схемами Zod. Изменение формы без обновления фикстур
  роняет обе проверки. (Фикстуры плана 1e1 — товарные группы, товары, шаблоны,
  умолчания, лента каталога, мастер с шаблонами, правило слота — Vitest разбирает
  с плана 1e2; мастер с шаблонами — строгой схемой запроса, а шлёт `templates`
  только мастер плана 1e3.)
- Фикстура `phc-password.json`: PHC-строка, созданная хостом, проверяется
  `verifyPhc` из `@markiro/domain`, а PHC-строка PIN, созданная TypeScript,
  разбирается хостом.
```

заменить на

<!-- prettier-ignore -->
```text
  потерь, Vitest разбирает их схемами Zod. Изменение формы без обновления фикстур
  роняет обе проверки. (Фикстуры плана 1e1 — товарные группы, товары, шаблоны,
  умолчания, лента каталога, мастер с шаблонами, правило слота — Vitest разбирает
  с плана 1e2; мастер с шаблонами — строгой схемой запроса, которой с плана 1e3
  проверяется и запрос самого мастера: он шлёт `templates`.)
- Фикстура `phc-password.json`: PHC-строка, созданная хостом, проверяется
  `verifyPhc` из `@markiro/domain`, а PHC-строка PIN, созданная TypeScript,
  разбирается хостом.
```

Перечитать в `AGENTS.md` разделы «Catalog and label templates» и «Protocol», в спецификации — абзац под таблицей §4.5 и §6 целиком: мастер шлёт `templates` с плана 1e3, вопрос `DefaultBodyLimit` закрыт тестом, умолчание дубликата — вопрос владельцу; экраны шаблонов пока описаны как работа этого плана, которую делают задачи 3–8.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/wizard/wizard-form.ts apps/standalone/test/support/wizard.ts apps/standalone/test/wizard-form.test.ts apps/standalone/test/wizard.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 40 файлов, 964 теста (958 + 6).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/wizard/wizard-form.ts apps/standalone/test/support/wizard.ts apps/standalone/test/wizard-form.test.ts apps/standalone/test/wizard.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): мастер создаёт типовые шаблоны этикеток и умолчания организации" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Общие модули каталога, тексты шаблонов и слияние ответа в сводку

Страницам шаблонов нужны запросы и выбор шаблона, которые сейчас лежат в `products/`: `useProductGroups` и `useTemplates` (`product-queries.ts`) и `templateOptions` (`template-options.ts`). Разделы офиса друг друга не импортируют, поэтому оба файла переезжают в `src/office/` (`catalog-queries.ts`, `template-options.ts`), а `templateOptions` принимает любое назначение — дубликат тоже (страница умолчаний выбирает и умолчание дубликата). Его тексты переезжают из `office.products.*` в общую группу `office.templateChoice`; слова те же, поэтому тесты товаров не меняются.

Новые модули `src/office/templates/`: `template-text.ts` — размер («58 × 40 мм», дробь с запятой, «—» без ширины или высоты), разрешение («203 dpi» или «—»), название группы (код, если справочника нет), категории словами (как `describeTemplateScope` облака), отказ `template_is_default` словами (как `describeDefaultConflict` облака, но по `HostError.details` и с подсказкой про «Умолчания шаблонов»), порядок назначений и их тона (`PURPOSE_TO_TONE` облака); `template-list.ts` — сортировка по названию и слияние ответа записи в кэшированную сводку (D7: `name`, `enabled`, `chzProductGroupCodes`, `stock`, `rev` из ответа, размер, разрешение и язык остаются, макета в сводке нет). Экранов в задаче нет: тексты и слияние берут задачи 3–7, поэтому у новых модулей свои тесты.

**Files:**

- Move: `apps/standalone/src/office/products/product-queries.ts` → `apps/standalone/src/office/catalog-queries.ts`, `apps/standalone/src/office/products/template-options.ts` → `apps/standalone/src/office/template-options.ts` (`git mv`, затем новое содержимое)
- Create: `apps/standalone/src/office/templates/template-text.ts`, `apps/standalone/src/office/templates/template-list.ts`
- Modify: `apps/standalone/src/office/products/ProductsPage.tsx`, `apps/standalone/src/office/products/ProductDialog.tsx` (импорты), `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/template-text.test.ts`, `apps/standalone/test/template-list.test.ts`, `apps/standalone/test/template-options.test.ts` (Create)

**Interfaces:**

- Consumes:
  - `templateFitsSlot` — `src/lib/template-eligibility.ts`; `alertFailure`, `type AlertFailure` — `src/office/form-errors.ts`; `HostError` — `src/host/client.ts`; `type BadgeTone` — `@markiro/ui`;
  - `type LabelTemplate`, `type LabelTemplateSummary`, `type ProductGroup`, `type TemplatePurpose` — `src/host/protocol.ts`.
- Produces:
  - `src/office/catalog-queries.ts`: `useProductGroups()` (`staleTime: Infinity`), `useTemplates()`;
  - `src/office/template-options.ts`: `type TemplateOption`, `templateOptions(templates, purpose: TemplatePurpose, group: number | null, kept: readonly string[], t)`;
  - `src/office/templates/template-text.ts`: `PURPOSES`, `PURPOSE_TONE`, `sizeText(template, t)`, `dpiText(dpi, t)`, `groupName(groups, code, t)`, `describeScope(codes, groups, t): { label; title }`, `interface DefaultConflict { organization: boolean; categories: number[] }`, `defaultConflict(error): DefaultConflict | null`, `describeDefaultConflict(conflict, groups, t)`, `type TemplateFailure = AlertFailure | { kind: "default"; conflict: DefaultConflict }`, `templateFailure(error)`;
  - `src/office/templates/template-list.ts`: `templatesByName(templates)`, `withTemplateChange(list, template): LabelTemplateSummary[]`;
  - ключи `office.templateChoice.{none,unfit,id,missing}` и группа `office.templates` (`size`, `dpi`, `groupCode`, `scope.*`, `conflict.*`).

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/template-text.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { ProductGroup } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  defaultConflict,
  describeDefaultConflict,
  describeScope,
  dpiText,
  groupName,
  PURPOSE_TONE,
  PURPOSES,
  sizeText,
  templateFailure,
} from "../src/office/templates/template-text.js";

const t = i18n.t;

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
];

function conflict(details: Record<string, unknown>): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "conflict",
    details,
  });
}

describe("template texts", () => {
  it("write a size in millimetres, a fraction with a comma, and none when the layout lacks the width or the height", () => {
    expect(sizeText({ widthMm: 58, heightMm: 40 }, t)).toBe("58 × 40 мм");
    expect(sizeText({ widthMm: 58.5, heightMm: 100 }, t)).toBe("58,5 × 100 мм");
    expect(sizeText({ widthMm: null, heightMm: 40 }, t)).toBe("—");
    expect(sizeText({ widthMm: 58, heightMm: null }, t)).toBe("—");
  });

  it("write a resolution in dpi, and none without one", () => {
    expect(dpiText(203, t)).toBe("203 dpi");
    expect(dpiText(0, t)).toBe("0 dpi");
    expect(dpiText(null, t)).toBe("—");
  });

  it("name a product group from the lookup, and by its code when the lookup lacks it or did not load", () => {
    expect(groupName(GROUPS, 13, t)).toBe("Упакованная вода");
    expect(groupName(GROUPS, 99, t)).toBe("Код 99");
    expect(groupName(undefined, 8, t)).toBe("Код 8");
  });

  it("describe the categories: every one, one by name, or how many with the names as a title", () => {
    expect(describeScope(null, GROUPS, t)).toStrictEqual({ label: "Все категории", title: null });
    expect(describeScope([13], GROUPS, t)).toStrictEqual({
      label: "Упакованная вода",
      title: "Упакованная вода",
    });
    expect(describeScope([8, 13, 99], GROUPS, t)).toStrictEqual({
      label: "Категорий: 3",
      title: "Молочная продукция, Упакованная вода, Код 99",
    });
    expect(describeScope([8, 13], undefined, t)).toStrictEqual({
      label: "Категорий: 2",
      title: "Код 8, Код 13",
    });
  });

  it("offer the purposes box, pallet, duplicate and tone them as the cloud does: violet, magenta, teal", () => {
    expect(PURPOSES).toStrictEqual(["box", "pallet", "product_duplicate"]);
    expect(PURPOSE_TONE).toStrictEqual({
      box: "violet",
      product_duplicate: "teal",
      pallet: "magenta",
    });
  });
});

describe("a refused template write", () => {
  it("names the defaults in its way only for a `template_is_default` conflict", () => {
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8, 15],
        }),
      ),
    ).toStrictEqual({ organization: true, categories: [8, 15] });
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [],
        }),
      ),
    ).toStrictEqual({ organization: false, categories: [] });
    // Only a real `true` is the organization's default, and unreadable codes name no category.
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: "true",
          categoryDefaults: ["8"],
        }),
      ),
    ).toStrictEqual({ organization: false, categories: [] });
    expect(defaultConflict(conflict({ constraint: "stock_template" }))).toBeNull();
    const stale = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { constraint: "template_is_default" },
    });
    expect(defaultConflict(stale)).toBeNull();
    expect(defaultConflict(new Error("template_is_default"))).toBeNull();
  });

  it("explains whose default the template is, the categories by name or code, and where to choose another", () => {
    const hint = "Сначала выберите другой шаблон на странице «Умолчания шаблонов».";
    expect(describeDefaultConflict({ organization: true, categories: [] }, GROUPS, t)).toBe(
      `Шаблон выбран по умолчанию для организации. ${hint}`,
    );
    expect(describeDefaultConflict({ organization: false, categories: [8, 99] }, GROUPS, t)).toBe(
      `Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. ${hint}`,
    );
    expect(describeDefaultConflict({ organization: true, categories: [13] }, undefined, t)).toBe(
      `Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Код 13. ${hint}`,
    );
  });

  it("is a default conflict, a stale write that offers to reload, or an alert by its code", () => {
    expect(
      templateFailure(
        conflict({
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: true, categories: [8] } });
    expect(
      templateFailure(
        new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
      ),
    ).toStrictEqual({ kind: "stale" });
    expect(templateFailure(conflict({ constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });
});
```

2. Create `apps/standalone/test/template-list.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { LabelTemplate, LabelTemplateSummary } from "../src/host/protocol.js";
import { templatesByName, withTemplateChange } from "../src/office/templates/template-list.js";

function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 3,
    ...data,
  } satisfies LabelTemplateSummary;
}

const A = summary("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "Коробка 100×100");
const B = summary("1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", "Коробка 58×40", {
  widthMm: 58.5,
  dpi: null,
  language: null,
});
const C = summary("2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f", "Паллета 100×150", {
  purpose: "pallet",
});

describe("the templates list", () => {
  it("sorts by name with numbers by value, then by id, without changing the list it is given", () => {
    const twin = summary("00000000-0000-4000-8000-000000000001", "Коробка 58×40");
    const list = Object.freeze([C, A, B, twin]);
    expect(templatesByName(list).map((each) => each.id)).toStrictEqual([twin.id, B.id, A.id, C.id]);
    expect(list).toStrictEqual([C, A, B, twin]);
  });

  it("merges a template a write returned into its summary in place: name, flag, categories, stock and revision, keeping the size, resolution and language", () => {
    const saved: LabelTemplate = {
      id: B.id,
      name: "Коробка 58×40 (своя)",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: [8, 13],
      stock: false,
      spec: { widthMm: 75, heightMm: 120, dpi: 300, language: "tspl", elements: [] },
      rev: 9,
    };
    const list = Object.freeze([A, Object.freeze(B), C]);
    const merged = withTemplateChange(list, saved);
    expect(merged).toStrictEqual([
      A,
      {
        id: B.id,
        name: "Коробка 58×40 (своя)",
        purpose: "box",
        enabled: false,
        chzProductGroupCodes: [8, 13],
        stock: false,
        widthMm: 58.5,
        heightMm: 40,
        dpi: null,
        language: null,
        rev: 9,
      },
      C,
    ]);
    expect(merged[0]).toBe(A);
    expect(merged[2]).toBe(C);
    expect(list[1]).toBe(B);
    expect(B.enabled).toBe(true);
  });

  it("changes nothing for a template the list lacks", () => {
    const stranger: LabelTemplate = {
      id: "3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a",
      name: "Чужой",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: null,
      stock: false,
      spec: {},
      rev: 10,
    };
    const list = [A, B];
    const merged = withTemplateChange(list, stranger);
    expect(merged).toStrictEqual([A, B]);
    expect(merged).not.toBe(list);
  });
});
```

3. Create `apps/standalone/test/template-options.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { LabelTemplateSummary } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { templateOptions } from "../src/office/template-options.js";

const t = i18n.t;

function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 1,
    ...data,
  } satisfies LabelTemplateSummary;
}

const FULL = "1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a";
const SHORT = "2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b";
const MILK = "3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c";
const OFF = "4d8f1c9b-6e0a-4f2b-9c3d-8e9f0a1b2c3d";
const BOX = "5e9a2d0c-7f1b-4a3c-8d4e-9f0a1b2c3d4e";
const TEMPLATES: LabelTemplateSummary[] = [
  summary(SHORT, "Дубликат 58×40 [Краткое]", { purpose: "product_duplicate" }),
  summary(FULL, "Дубликат 10×10", { purpose: "product_duplicate" }),
  summary(MILK, "Дубликат молока", { purpose: "product_duplicate", chzProductGroupCodes: [8] }),
  summary(OFF, "Дубликат старый", { purpose: "product_duplicate", enabled: false }),
  summary(BOX, "Коробка 58×40"),
];

function labels(options: { label: string }[]): string[] {
  return options.map((option) => option.label);
}

describe("template choices", () => {
  it("offer «Не выбран» with the empty value, then the templates that fit a duplicate slot, by name with numbers by value", () => {
    const organization = templateOptions(TEMPLATES, "product_duplicate", null, [], t);
    expect(organization).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: FULL, label: "Дубликат 10×10" },
      { value: SHORT, label: "Дубликат 58×40 [Краткое]" },
    ]);
    // A category's slot takes a duplicate template scoped to that category too.
    expect(labels(templateOptions(TEMPLATES, "product_duplicate", 8, [], t))).toStrictEqual([
      "Не выбран",
      "Дубликат 10×10",
      "Дубликат 58×40 [Краткое]",
      "Дубликат молока",
    ]);
    expect(labels(templateOptions(TEMPLATES, "box", 8, [], t))).toStrictEqual([
      "Не выбран",
      "Коробка 58×40",
    ]);
  });

  it("keep a kept id that does not fit as a marked choice, once: by name, as missing from the list, or by its first eight characters while the list loads", () => {
    const gone = "6f0b3e1d-8a2c-4b4d-9e5f-0a1b2c3d4e5f";
    expect(
      templateOptions(TEMPLATES, "product_duplicate", 13, [MILK, gone, "", MILK, FULL], t),
    ).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: FULL, label: "Дубликат 10×10" },
      { value: SHORT, label: "Дубликат 58×40 [Краткое]" },
      { value: MILK, label: "Дубликат молока — не подходит" },
      { value: gone, label: "Шаблон 6f0b3e1d… — нет в списке" },
    ]);
    expect(templateOptions(undefined, "pallet", null, [gone], t)).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: gone, label: "Шаблон 6f0b3e1d…" },
    ]);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts test/template-list.test.ts test/template-options.test.ts`
Expected: FAIL — 3 файла не загружаются, тестов нет: `Failed to resolve import "../src/office/templates/template-text.js"`, `… "../src/office/templates/template-list.js"` и `… "../src/office/template-options.js"`.

- [ ] **Step 3: Перенос, тексты и слияние**

1. Перенести оба модуля из `products/` (их содержимое заменяют следующие пункты):

<!-- prettier-ignore -->
```bash
git mv apps/standalone/src/office/products/product-queries.ts apps/standalone/src/office/catalog-queries.ts
git mv apps/standalone/src/office/products/template-options.ts apps/standalone/src/office/template-options.ts
```

2. Заменить содержимое `apps/standalone/src/office/catalog-queries.ts` целиком:

<!-- prettier-ignore -->
```ts
import { officeKeys, useOfficeQuery } from "./office-query.js";

/**
 * The ЧЗ product groups (`GET /v1/office/product-groups`): a static lookup,
 * so it is not read again while it is cached (`staleTime: Infinity`). The
 * catalog's pages and dialogs share it.
 */
export function useProductGroups() {
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token), {
    staleTime: Infinity,
  });
}

/**
 * The label templates without their layouts (`GET /v1/office/templates`):
 * read again whenever a page or a product dialog opens, since a template may
 * have been disabled, narrowed or deleted since.
 */
export function useTemplates() {
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
}
```

3. Заменить содержимое `apps/standalone/src/office/template-options.ts` целиком:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { LabelTemplateSummary, TemplatePurpose } from "../host/protocol.js";
import { templateFitsSlot } from "../lib/template-eligibility.js";

/** Template names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface TemplateOption {
  value: string;
  label: string;
}

/**
 * The choices of a template for one slot: none (`""`), then every template
 * that fits the slot for the category (`templateFitsSlot`: enabled, of the
 * slot's purpose, covering the category; `null` is a product without a group
 * and the organization's slot), by name. Each id in `kept` that does not fit
 * stays a choice of its own, marked: the loaded choice, which a template
 * disabled or narrowed since, or a category changed in the form, does not
 * take away, and the form's current choice. `templates` is `undefined` while
 * the list is not loaded.
 */
export function templateOptions(
  templates: readonly LabelTemplateSummary[] | undefined,
  purpose: TemplatePurpose,
  group: number | null,
  kept: readonly string[],
  t: TFunction,
): TemplateOption[] {
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const options: TemplateOption[] = [
    { value: "", label: t("office.templateChoice.none") },
    ...fitting.map((template) => ({ value: template.id, label: template.name })),
  ];
  for (const id of kept) {
    if (id === "" || options.some((option) => option.value === id)) continue;
    const template = templates?.find((each) => each.id === id);
    const short = id.slice(0, 8);
    options.push({
      value: id,
      label:
        template !== undefined
          ? t("office.templateChoice.unfit", { name: template.name })
          : templates === undefined
            ? t("office.templateChoice.id", { id: short })
            : t("office.templateChoice.missing", { id: short }),
    });
  }
  return options;
}
```

4. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

import type { OfficeProduct } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, useStoreRecord } from "../records.js";
```

заменить на

<!-- prettier-ignore -->
```tsx

import type { OfficeProduct } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, useStoreRecord } from "../records.js";
```

5. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  type ProductFilter,
  type ProductState,
} from "./product-list.js";
import { useProductGroups } from "./product-queries.js";

/** A state in words and in its phase: archived is out of use, not an alarm. */
const STATE_PHASE = {
```

заменить на

<!-- prettier-ignore -->
```tsx
  type ProductFilter,
  type ProductState,
} from "./product-list.js";

/** A state in words and in its phase: archived is out of use, not an alarm. */
const STATE_PHASE = {
```

6. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGroupCode, toGtin14 } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  gtinOwner,
  PRODUCT_CONFLICTS,
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGroupCode, toGtin14 } from "../../lib/rules.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { templateOptions } from "../template-options.js";
import {
  gtinOwner,
  PRODUCT_CONFLICTS,
```

7. В `apps/standalone/src/office/products/ProductDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";
import { useProductGroups, useTemplates } from "./product-queries.js";
import { templateOptions } from "./template-options.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });
```

заменить на

<!-- prettier-ignore -->
```tsx
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });
```

8. Create `apps/standalone/src/office/templates/template-text.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";
import { z } from "zod";

import type { BadgeTone } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { LabelTemplateSummary, ProductGroup, TemplatePurpose } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";

/** The purposes in the order the office offers them (filters, choices). */
export const PURPOSES: readonly TemplatePurpose[] = ["box", "pallet", "product_duplicate"];

/**
 * A purpose's category tone, as the cloud's `PURPOSE_TO_TONE` gives it: the
 * domain's union order (box, product duplicate, pallet) takes violet, teal
 * and magenta. A purpose is a kind, not a phase, so it is a `Badge`.
 */
export const PURPOSE_TONE = {
  box: "violet",
  product_duplicate: "teal",
  pallet: "magenta",
} as const satisfies Record<TemplatePurpose, BadgeTone>;

/** Millimetres as the office writes them: «58», «58,5». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

/** «58 × 40 мм»; none when the layout gives no width or no height. */
export function sizeText(
  template: Pick<LabelTemplateSummary, "widthMm" | "heightMm">,
  t: TFunction,
): string {
  if (template.widthMm === null || template.heightMm === null) return t("office.common.none");
  return t("office.templates.size", {
    width: MM.format(template.widthMm),
    height: MM.format(template.heightMm),
  });
}

/** «203 dpi»; none when the layout gives no resolution. */
export function dpiText(dpi: number | null, t: TFunction): string {
  return dpi === null ? t("office.common.none") : t("office.templates.dpi", { dpi });
}

/** A product group's name from the lookup; its code when the lookup lacks it or did not load. */
export function groupName(
  groups: readonly ProductGroup[] | undefined,
  code: number,
  t: TFunction,
): string {
  return (
    groups?.find((group) => group.code === code)?.name ?? t("office.templates.groupCode", { code })
  );
}

/**
 * A template's categories in words, after the cloud's `describeTemplateScope`:
 * every category; one group's name; or how many, since ЧЗ group names run
 * long. `title` carries the names whenever there is a list.
 */
export function describeScope(
  codes: readonly number[] | null,
  groups: readonly ProductGroup[] | undefined,
  t: TFunction,
): { label: string; title: string | null } {
  if (codes === null) return { label: t("office.templates.scope.all"), title: null };
  const names = codes.map((code) => groupName(groups, code, t)).join(", ");
  if (codes.length === 1) return { label: names, title: names };
  return { label: t("office.templates.scope.count", { n: codes.length }), title: names };
}

/**
 * The defaults a refused template write names (`conflict` with
 * `constraint: template_is_default`): the organization's default of the
 * template's purpose, and the categories whose default it is.
 */
export interface DefaultConflict {
  organization: boolean;
  categories: number[];
}

const CATEGORY_CODES = z.array(z.number().int().nonnegative());

/** The defaults a refusal names, or `null` when it is any other failure. */
export function defaultConflict(error: unknown): DefaultConflict | null {
  if (
    !(error instanceof HostError) ||
    error.code !== "conflict" ||
    error.details.constraint !== "template_is_default"
  ) {
    return null;
  }
  const categories = CATEGORY_CODES.safeParse(error.details.categoryDefaults);
  return {
    organization: error.details.organizationDefault === true,
    categories: categories.success ? categories.data : [],
  };
}

/**
 * The refusal in words, after the cloud's `describeDefaultConflict`: whose
 * default the template is, the categories by name, and where to choose
 * another template first.
 */
export function describeDefaultConflict(
  conflict: DefaultConflict,
  groups: readonly ProductGroup[] | undefined,
  t: TFunction,
): string {
  const parts: string[] = [];
  if (conflict.organization) parts.push(t("office.templates.conflict.organization"));
  if (conflict.categories.length > 0) {
    parts.push(
      t("office.templates.conflict.categories", {
        categories: conflict.categories.map((code) => groupName(groups, code, t)).join(", "),
      }),
    );
  }
  parts.push(t("office.templates.conflict.hint"));
  return parts.join(" ");
}

/** A refused template write: the defaults in its way, or what `alertFailure` makes of it. */
export type TemplateFailure = AlertFailure | { kind: "default"; conflict: DefaultConflict };

export function templateFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  return conflict === null ? alertFailure(error) : { kind: "default", conflict };
}
```

9. Create `apps/standalone/src/office/templates/template-list.ts`:

<!-- prettier-ignore -->
```ts
import type { LabelTemplate, LabelTemplateSummary } from "../../host/protocol.js";

/** Template names in Russian order, with numbers by value: «Коробка 58×40» before «Коробка 100×100». */
const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * Templates by name (`NAMES`), then by id so equal names keep one order. The
 * host sorts bytewise, and a write changes the cached list in place, so a page
 * sorts what it shows itself.
 */
export function templatesByName<T extends Pick<LabelTemplateSummary, "id" | "name">>(
  templates: readonly T[],
): T[] {
  return [...templates].sort(
    (a, b) => NAMES.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * `list` with a template a write returned merged into its summary: the name,
 * the flag, the categories, `stock` and the revision come from the template;
 * the size, the resolution and the language stay, since switching a template
 * or changing its categories never touches the layout, and the layout itself
 * is no part of a summary. The summary keeps its position; a template the list
 * lacks changes nothing. A new array; neither argument is changed.
 */
export function withTemplateChange(
  list: readonly LabelTemplateSummary[],
  template: LabelTemplate,
): LabelTemplateSummary[] {
  return list.map((summary) =>
    summary.id === template.id
      ? {
          ...summary,
          name: template.name,
          enabled: template.enabled,
          chzProductGroupCodes: template.chzProductGroupCodes,
          stock: template.stock,
          rev: template.rev,
        }
      : summary,
  );
}
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "draftHint": "Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете.",
      "groupMissing": "Код {{code}} — нет в справочнике",
      "groupsUnavailable": "Справочник групп не загрузился: группу сейчас не изменить.",
      "noTemplate": "Не выбран",
      "templateUnfit": "{{name}} — не подходит",
      "templateId": "Шаблон {{id}}…",
      "templateMissing": "Шаблон {{id}}… — нет в списке",
      "templatesLoading": "Загружаем шаблоны…",
      "templatesUnavailable": "Список шаблонов не загрузился: шаблоны останутся как есть.",
      "created": "Товар «{{name}}» добавлен.",
```

заменить на

<!-- prettier-ignore -->
```json
      "draftHint": "Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете.",
      "groupMissing": "Код {{code}} — нет в справочнике",
      "groupsUnavailable": "Справочник групп не загрузился: группу сейчас не изменить.",
      "templatesLoading": "Загружаем шаблоны…",
      "templatesUnavailable": "Список шаблонов не загрузился: шаблоны останутся как есть.",
      "created": "Товар «{{name}}» добавлен.",
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "next": "Вперёд",
        "page": "Страница {{page}} из {{pages}}"
      }
    },
    "noAccess": {
      "title": "Нет доступа",
```

заменить на

<!-- prettier-ignore -->
```json
        "next": "Вперёд",
        "page": "Страница {{page}} из {{pages}}"
      }
    },
    "templates": {
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
      "scope": {
        "all": "Все категории",
        "count": "Категорий: {{n}}"
      },
      "conflict": {
        "organization": "Шаблон выбран по умолчанию для организации.",
        "categories": "Шаблон выбран по умолчанию для категорий: {{categories}}.",
        "hint": "Сначала выберите другой шаблон на странице «Умолчания шаблонов»."
      }
    },
    "templateChoice": {
      "none": "Не выбран",
      "unfit": "{{name}} — не подходит",
      "id": "Шаблон {{id}}…",
      "missing": "Шаблон {{id}}… — нет в списке"
    },
    "noAccess": {
      "title": "Нет доступа",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts test/template-list.test.ts test/template-options.test.ts test/products-page.test.tsx test/product-dialog.test.tsx`
Expected: PASS — 5 файлов, 55 тестов: новые 13 (`template-text` 8, `template-list` 3, `template-options` 2) и тесты товаров без изменений (`products-page` 20, `product-dialog` 22): перенесённые тексты выводят те же слова.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-text.test.ts test/template-list.test.ts test/template-options.test.ts`
Expected: PASS, 13 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 13; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/template-text.ts` писать размер, когда у макета есть только одна сторона: фрагмент

<!-- prettier-ignore -->
```ts
if (template.widthMm === null || template.heightMm === null)
```

заменить на

<!-- prettier-ignore -->
```ts
if (template.widthMm === null && template.heightMm === null)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "a size in millimetres"`
Expected: FAIL — `expected '0 × 40 мм' to be '—'`.

Мутация 2. В `apps/standalone/src/office/templates/template-text.ts` считать нулевое разрешение отсутствующим: фрагмент

<!-- prettier-ignore -->
```ts
return dpi === null ? t(
```

заменить на

<!-- prettier-ignore -->
```ts
return !dpi ? t(
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "resolution in dpi"`
Expected: FAIL — `expected '—' to be '0 dpi'`.

Мутация 3. В `apps/standalone/src/office/templates/template-text.ts` одну категорию называть числом: фрагмент

<!-- prettier-ignore -->
```ts
if (codes.length === 1) return { label: names, title: names };
```

заменить на

<!-- prettier-ignore -->
```ts
if (codes.length === 0) return { label: names, title: names };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "describe the categories"`
Expected: FAIL — `expected { label: 'Категорий: 1', …(1) } to strictly equal { label: 'Упакованная вода', …(1) }`.

Мутация 4. В `apps/standalone/src/office/templates/template-text.ts` читать умолчание организации по правдивости, а не как `true`: фрагмент

<!-- prettier-ignore -->
```ts
organization: error.details.organizationDefault === true,
```

заменить на

<!-- prettier-ignore -->
```ts
organization: Boolean(error.details.organizationDefault),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "names the defaults"`
Expected: FAIL — `expected { organization: true, categories: [] } to strictly equal { organization: false, categories: [] }`.

Мутация 5. В `apps/standalone/src/office/templates/template-text.ts` принимать за отказ умолчания конфликт с любым кодом: удалить фрагмент

<!-- prettier-ignore -->
```ts
    error.code !== "conflict" ||
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "names the defaults"`
Expected: FAIL — `expected { organization: false, categories: [] } to be null`.

Мутация 6. В `apps/standalone/src/office/templates/template-list.ts` не сливать ревизию ответа: удалить фрагмент

<!-- prettier-ignore -->
```ts
          rev: template.rev,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-list.test.ts -t "merges"`
Expected: FAIL — `expected [ { …(11) }, { …(11) }, { …(11) } ] to strictly equal [ { …(11) }, { …(11) }, { …(11) } ]`: в строке осталась прежняя ревизия.

Мутация 7. В `apps/standalone/src/office/templates/template-list.ts` сливать в сводку и макет: фрагмент

<!-- prettier-ignore -->
```ts
          ...summary,
```

заменить на

<!-- prettier-ignore -->
```ts
          ...summary,
          ...template,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-list.test.ts -t "merges"`
Expected: FAIL — `expected [ { …(11) }, { …(12) }, { …(11) } ] to strictly equal [ { …(11) }, { …(11) }, { …(11) } ]`: у сводки появился двенадцатый ключ — макет.

Мутация 8. В `apps/standalone/src/office/templates/template-list.ts` сортировать без идентификатора: фрагмент

<!-- prettier-ignore -->
```ts
(a, b) => NAMES.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
```

заменить на

<!-- prettier-ignore -->
```ts
(a, b) => NAMES.compare(a.name, b.name),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-list.test.ts -t "sorts by name"`
Expected: FAIL — `expected [ …(4) ] to strictly equal [ …(4) ]`: два шаблона с одним названием стоят не по идентификатору.

Мутация 9. В `apps/standalone/src/office/template-options.ts` предлагать для дубликата шаблоны короба: фрагмент

<!-- prettier-ignore -->
```ts
templateFitsSlot(template, { purpose, chzProductGroupCode: group })
```

заменить на

<!-- prettier-ignore -->
```ts
templateFitsSlot(template, { purpose: purpose === "product_duplicate" ? "box" : purpose, chzProductGroupCode: group })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-options.test.ts`
Expected: FAIL — оба теста: `expected [ …(2) ] to strictly equal [ …(3) ]`, `expected [ …(5) ] to strictly equal [ …(5) ]`.

Мутация 10. В `apps/standalone/src/office/templates/template-text.ts` поменять тона паллеты и дубликата: фрагмент

<!-- prettier-ignore -->
```ts
  product_duplicate: "teal",
  pallet: "magenta",
```

заменить на

<!-- prettier-ignore -->
```ts
  product_duplicate: "magenta",
  pallet: "teal",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts -t "tone them"`
Expected: FAIL — `expected { box: 'violet', …(2) } to strictly equal { box: 'violet', …(2) }`.

- [ ] **Step 6: Документы**

Документов задача не меняет: `AGENTS.md` и спецификация не называют перенесённых модулей, а новые модули ещё никто не показывает (о них — в задачах 3–7).

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/i18n/ru.json apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/template-options.ts apps/standalone/src/office/templates/template-list.ts apps/standalone/src/office/templates/template-text.ts apps/standalone/test/template-list.test.ts apps/standalone/test/template-options.test.ts apps/standalone/test/template-text.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 43 файла, 977 тестов (964 + 13).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/i18n/ru.json apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/products/ProductDialog.tsx apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/template-options.ts apps/standalone/src/office/templates/template-list.ts apps/standalone/src/office/templates/template-text.ts apps/standalone/test/template-list.test.ts apps/standalone/test/template-options.test.ts apps/standalone/test/template-text.test.ts
git commit -m "refactor(standalone): общие модули каталога, тексты шаблонов и слияние ответа в сводку" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Страница «Шаблоны» — меню, список, поиск и отбор

В разделе «Каталог» после «Товаров» появляется пункт «Шаблоны» (обе роли, маршрут `/templates` без `RequireRole`) и страница — таблица, не облачные карточки (D4): название с меткой «Типовой», назначение словом на категорийном теге, размер и разрешение макета из сводки («—», где их нет), категории словами (`describeScope`, полный список в `title`), состояние словом с фазой. Хост отдаёт список целиком, поэтому сортировка по названию (`templatesByName`), поиск по названию без учёта регистра, отбор по назначению и по состоянию — в вебвью; страниц нет (шаблонов на площадке десятки). Название группы — из справочника хоста; если он не загрузился, список остаётся с кодами и предупреждением с «Повторить», а когда не загрузились и шаблоны, видна одна ошибка шаблонов, чья «Повторить» перечитывает оба.

Кнопок записи в задаче нет: переключение (задача 4) и категории (задача 5) приходят каждое со своим окном. Шаблоны читаются при каждом открытии страницы, справочник групп — один раз, пока он в кэше.

**Files:**

- Create: `apps/standalone/src/office/templates/TemplatesPage.tsx`
- Modify: `apps/standalone/src/office/templates/template-list.ts`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/templates-page.test.tsx` (Create)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `useProductGroups`, `useTemplates` — `src/office/catalog-queries.ts`; `templatesByName` — `src/office/templates/template-list.ts`; `describeScope`, `dpiText`, `sizeText`, `PURPOSES`, `PURPOSE_TONE` — `src/office/templates/template-text.ts` (задача 2);
  - `LoadError`, `PageLoading` — `src/office/page-state.tsx`; `fakeOfficeSession`, `renderOffice`, `TECHNOLOGIST`, `type FakeOfficeSession` — `test/support/office.tsx`.
- Produces:
  - `src/office/templates/template-list.ts`: `type TemplatePurposeFilter = "all" | TemplatePurpose`, `type TemplateStateFilter = "all" | "enabled" | "disabled"`, `matchesTemplateSearch(template, search)`, `findTemplates(templates, search, purpose, state)`;
  - `TemplatesPage` — `src/office/templates/TemplatesPage.tsx`; пункт меню `/templates` и маршрут `templates`; класс `.template-name` — `src/app/shell.css`;
  - ключи `office.nav.templates` и группы `office.templates` (`title`, `empty`, `nothingFound`, `filters`, `search`, `searchHint`, `purposeFilter`, `stateFilter`, `found`, `purposes.*`, `stateFilters.*`, `states.*`, `table.*`, `stock`, `groupsFailed`).

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/templates-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { matchesTemplateSearch } from "../src/office/templates/template-list.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
];

/** A template summary: an enabled box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX_58 = summary("7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c", "Коробка 58×40", { stock: true });
const BOX_100 = summary("8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d", "Коробка 100×100", {
  stock: true,
  widthMm: 100,
  heightMm: 100,
});
const MILK = summary("a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d", "Молоко 58×40", {
  chzProductGroupCodes: [8],
  language: "tspl",
});
/** Disabled, for three categories, one of them unknown to the lookup; a fractional width and no resolution. */
const DRINKS = summary("9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e", "Вода и молоко", {
  enabled: false,
  chzProductGroupCodes: [8, 13, 99],
  widthMm: 58.5,
  dpi: null,
});
const PALLET = summary("0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f", "Паллета 100×150", {
  purpose: "pallet",
  stock: true,
  widthMm: 100,
  heightMm: 150,
});
const DUPLICATE = summary(
  "1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a",
  "Дубликат Data Matrix 58×40 [Полное наименование]",
  { purpose: "product_duplicate", stock: true },
);
/** A layout without a size, a resolution or a language. */
const BARE = summary("2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b", "Импорт без размера", {
  widthMm: null,
  heightMm: null,
  dpi: null,
  language: null,
});

/** The host's own order (names bytewise): the page sorts again. */
const TEMPLATES = [BOX_100, BOX_58, DRINKS, DUPLICATE, BARE, MILK, PALLET];

function session(templates: LabelTemplateSummary[] = TEMPLATES, user = TECHNOLOGIST) {
  const fake = fakeOfficeSession({ user });
  fake.api.listTemplates.mockResolvedValue(templates);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openTemplates(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The names column, top to bottom, without the «Типовой» tag. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) => within(row).getAllByRole("cell")[0]?.firstElementChild?.firstElementChild?.textContent,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The text of the row's cells, left to right. */
function cells(name: string): (string | null)[] {
  return within(rowOf(name))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });
const UNREACHABLE = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";

describe("office label templates", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» right after «Товары», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      const menu = await screen.findByRole("navigation", { name: "Разделы офиса" });
      const items = within(menu)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
      const catalog = items.indexOf("Каталог");
      expect(items.slice(catalog, catalog + 3)).toEqual(["Каталог", "Товары", "Шаблоны"]);
      view.unmount();
    }
  });

  it("lists the templates by name with numbers by value, whatever order the host sends", async () => {
    await openTemplates(session());
    expect(names()).toEqual([
      "Вода и молоко",
      "Дубликат Data Matrix 58×40 [Полное наименование]",
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
      "Паллета 100×150",
    ]);
  });

  it("shows the purpose in words, the size, the layout's resolution, the categories and the state in words with its glyph, and tags a stock template", async () => {
    await openTemplates(session());
    // The six columns of the list; the write buttons have a column of their own.
    expect(cells("Коробка 58×40").slice(0, 6)).toEqual([
      "Коробка 58×40Типовой",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Все категории",
      "▸Включён",
    ]);
    expect(cells("Молоко 58×40").slice(0, 6)).toEqual([
      "Молоко 58×40",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Молочная продукция",
      "▸Включён",
    ]);
    expect(cells("Вода и молоко").slice(0, 6)).toEqual([
      "Вода и молоко",
      "Короб",
      "58,5 × 40 мм",
      "—",
      "Категорий: 3",
      "✕Выключен",
    ]);
    expect(cells("Импорт без размера").slice(0, 6)).toEqual([
      "Импорт без размера",
      "Короб",
      "—",
      "—",
      "Все категории",
      "▸Включён",
    ]);
    expect(cells("Паллета 100×150").slice(0, 3)).toEqual([
      "Паллета 100×150Типовой",
      "Паллета",
      "100 × 150 мм",
    ]);
    expect(cells("Дубликат Data Matrix 58×40 [Полное наименование]")[1]).toBe("Дубликат товара");
    expect(screen.getAllByText("Типовой")).toHaveLength(4);
  });

  it("names every category in a title when it counts them, and names one category or a code the lookup lacks", async () => {
    await openTemplates(session());
    const scope = within(rowOf("Вода и молоко")).getByText("Категорий: 3");
    expect(scope.getAttribute("title")).toBe("Молочная продукция, Упакованная вода, Код 99");
    expect(
      within(rowOf("Молоко 58×40")).getByText("Молочная продукция").getAttribute("title"),
    ).toBe("Молочная продукция");
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории").hasAttribute("title")).toBe(
      false,
    );
  });

  it("finds templates by name, without case and spaces around the search", async () => {
    await openTemplates(session());
    const search = screen.getByLabelText("Поиск");
    fireEvent.change(search, { target: { value: " КОРОБКА " } });
    expect(names()).toEqual(["Коробка 58×40", "Коробка 100×100"]);
    expect(screen.getByText("Найдено: 2 из 7")).toBeTruthy();
    fireEvent.change(search, { target: { value: "58×40" } });
    expect(names()).toEqual([
      "Дубликат Data Matrix 58×40 [Полное наименование]",
      "Коробка 58×40",
      "Молоко 58×40",
    ]);
    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toHaveLength(7);
    expect(matchesTemplateSearch({ name: "Молоко 58×40" }, "  ")).toBe(true);
    expect(matchesTemplateSearch({ name: "Молоко 58×40" }, "кефир")).toBe(false);
  });

  it("keeps one purpose or one state with the filters, and both together", async () => {
    await openTemplates(session());
    const purpose = screen.getByLabelText("Назначение");
    const state = screen.getByLabelText("Состояние");
    fireEvent.change(purpose, { target: { value: "pallet" } });
    expect(names()).toEqual(["Паллета 100×150"]);
    fireEvent.change(purpose, { target: { value: "product_duplicate" } });
    expect(names()).toEqual(["Дубликат Data Matrix 58×40 [Полное наименование]"]);
    fireEvent.change(purpose, { target: { value: "box" } });
    expect(names()).toEqual([
      "Вода и молоко",
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    fireEvent.change(state, { target: { value: "disabled" } });
    expect(names()).toEqual(["Вода и молоко"]);
    fireEvent.change(state, { target: { value: "enabled" } });
    expect(names()).toEqual([
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    fireEvent.change(purpose, { target: { value: "all" } });
    fireEvent.change(state, { target: { value: "all" } });
    expect(names()).toHaveLength(7);
  });

  it("says nothing was found apart from an empty list", async () => {
    await openTemplates(session());
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "кефир" } });
    expect(screen.getByText("Ничего не найдено. Измените поиск или отбор.")).toBeTruthy();
    expect(screen.getByText("Найдено: 0 из 7")).toBeTruthy();
    expect(screen.queryByText("Шаблонов пока нет.")).toBeNull();
  });

  it("says when there are no templates", async () => {
    await openTemplates(session([]));
    expect(screen.getByText("Шаблонов пока нет.")).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено. Измените поиск или отбор.")).toBeNull();
  });

  it("explains a failed load and loads again; with the groups failed too it is one alert and one «Повторить» that reads both again", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(down());
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
    cleanup();
    const both = session();
    both.api.listTemplates.mockRejectedValueOnce(down());
    both.api.listProductGroups.mockRejectedValueOnce(down());
    renderOffice(both);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(1));
    // Two passes of the scheduler: the groups' failure has been taken in too.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(both.api.listTemplates).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(rowOf("Молоко 58×40")).getByText("Молочная продукция")).toBeTruthy();
  });

  it("keeps the list when the product groups do not load, shows their codes and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(down());
    await openTemplates(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Молоко 58×40")).getByText("Код 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await within(rowOf("Молоко 58×40")).findByText("Молочная продукция")).toBeTruthy();
  });

  it("reads the templates on every visit and the product groups once while they are cached", async () => {
    const fake = session();
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
    await screen.findByText("Молоко 58×40");
    // Two passes of the scheduler: an effect that would read again has run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.api.listProductGroups).toHaveBeenCalledTimes(1);
  });

  it("tags each purpose with its own category tone and the state with its phase: a disabled template is retired, not an alarm", async () => {
    await openTemplates(session());
    const tag = (name: string, label: string) => within(rowOf(name)).getByText(label);
    expect(tag("Коробка 58×40", "Короб").classList.contains("mk-badge--violet")).toBe(true);
    expect(tag("Паллета 100×150", "Паллета").classList.contains("mk-badge--magenta")).toBe(true);
    expect(
      tag("Дубликат Data Matrix 58×40 [Полное наименование]", "Дубликат товара").classList.contains(
        "mk-badge--teal",
      ),
    ).toBe(true);
    expect(tag("Коробка 58×40", "Типовой").classList.contains("mk-badge--steel")).toBe(true);
    const chip = (name: string, label: string) => tag(name, label).closest(".mk-chip");
    expect(chip("Коробка 58×40", "Включён")?.classList.contains("mk-chip--active")).toBe(true);
    expect(chip("Вода и молоко", "Выключен")?.classList.contains("mk-chip--retired")).toBe(true);
  });

  it("names the table, the search controls and both filters, with their choices in order", async () => {
    await openTemplates(session());
    expect(screen.getByRole("region", { name: "Шаблоны этикеток" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Поиск и отбор шаблонов" })).toBeTruthy();
    expect(screen.getByText("Название шаблона")).toBeTruthy();
    const options = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]);
    expect(options("Назначение")).toEqual([
      ["all", "Все"],
      ["box", "Короб"],
      ["pallet", "Паллета"],
      ["product_duplicate", "Дубликат товара"],
    ]);
    expect(options("Состояние")).toEqual([
      ["all", "Все"],
      ["enabled", "Включённые"],
      ["disabled", "Выключенные"],
    ]);
  });

  it("opens for the administrator too", async () => {
    await openTemplates(session(TEMPLATES, { ...TECHNOLOGIST, role: "admin" }));
    expect(names()).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx`
Expected: FAIL — `Tests  14 failed (14)`: пункта меню нет (`expected [ 'Каталог', 'Товары', 'Доступ' ] to deeply equal [ 'Каталог', 'Товары', 'Шаблоны' ]`, `Unable to find role="link" and name "Шаблоны"`).

- [ ] **Step 3: Пункт меню, маршрут и страница**

1. В `apps/standalone/src/office/templates/template-list.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { LabelTemplate, LabelTemplateSummary } from "../../host/protocol.js";

/** Template names in Russian order, with numbers by value: «Коробка 58×40» before «Коробка 100×100». */
const NAMES = new Intl.Collator("ru", { numeric: true });
```

заменить на

<!-- prettier-ignore -->
```ts
import type { LabelTemplate, LabelTemplateSummary, TemplatePurpose } from "../../host/protocol.js";

/** What the purpose filter keeps. */
export type TemplatePurposeFilter = "all" | TemplatePurpose;

/** What the state filter keeps: every template, the enabled ones or the disabled ones. */
export type TemplateStateFilter = "all" | "enabled" | "disabled";

/** Whether a template's name holds the search, without case; a blank search matches every template. */
export function matchesTemplateSearch(
  template: Pick<LabelTemplateSummary, "name">,
  search: string,
): boolean {
  const text = search.trim().toLocaleLowerCase("ru");
  return text === "" || template.name.toLocaleLowerCase("ru").includes(text);
}

/** The templates the search and both filters keep, in the order given. */
export function findTemplates<T extends LabelTemplateSummary>(
  templates: readonly T[],
  search: string,
  purpose: TemplatePurposeFilter,
  state: TemplateStateFilter,
): T[] {
  return templates.filter(
    (template) =>
      (purpose === "all" || template.purpose === purpose) &&
      (state === "all" || template.enabled === (state === "enabled")) &&
      matchesTemplateSearch(template, search),
  );
}

/** Template names in Russian order, with numbers by value: «Коробка 58×40» before «Коробка 100×100». */
const NAMES = new Intl.Collator("ru", { numeric: true });
```

2. Create `apps/standalone/src/office/templates/TemplatesPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { LoadError, PageLoading } from "../page-state.js";
import {
  findTemplates,
  templatesByName,
  type TemplatePurposeFilter,
  type TemplateStateFilter,
} from "./template-list.js";
import { describeScope, dpiText, PURPOSE_TONE, PURPOSES, sizeText } from "./template-text.js";

const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
  const templates = useTemplates();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");

  const columns: TableColumn<LabelTemplateSummary>[] = [
    {
      key: "name",
      title: t("office.templates.table.name"),
      wrap: true,
      render: (template) => (
        <span className="template-name">
          <span>{template.name}</span>
          {template.stock && <Badge tone="steel">{t("office.templates.stock")}</Badge>}
        </span>
      ),
    },
    {
      key: "purpose",
      title: t("office.templates.table.purpose"),
      render: (template) => (
        <Badge tone={PURPOSE_TONE[template.purpose]}>
          {t(`office.templates.purposes.${template.purpose}`)}
        </Badge>
      ),
    },
    {
      key: "size",
      title: t("office.templates.table.size"),
      mono: true,
      render: (template) => sizeText(template, t),
    },
    {
      key: "dpi",
      title: t("office.templates.table.dpi"),
      mono: true,
      render: (template) => dpiText(template.dpi, t),
    },
    {
      key: "scope",
      title: t("office.templates.table.scope"),
      wrap: true,
      render: (template) => {
        const scope = describeScope(template.chzProductGroupCodes, groups.data, t);
        return <span title={scope.title ?? undefined}>{scope.label}</span>;
      },
    },
    {
      key: "state",
      title: t("office.templates.table.state"),
      render: (template) => (
        <StatusChip
          phase={template.enabled ? "active" : "retired"}
          label={t(
            template.enabled
              ? "office.templates.states.enabled"
              : "office.templates.states.disabled",
          )}
        />
      ),
    },
  ];

  const content = () => {
    if (templates.isPending) return <PageLoading />;
    if (templates.isError) {
      return (
        <LoadError
          error={templates.error}
          onRetry={() => {
            void templates.refetch();
            // One click recovers both reads when the group names failed too.
            if (groups.isError) void groups.refetch();
          }}
        />
      );
    }
    const found = findTemplates(templatesByName(templates.data), search, purpose, state);
    return (
      <>
        <FilterBar
          label={t("office.templates.filters")}
          resultSummary={t("office.templates.found", {
            shown: found.length,
            total: templates.data.length,
          })}
        >
          <Input
            label={t("office.templates.search")}
            hint={t("office.templates.searchHint")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            native
            label={t("office.templates.purposeFilter")}
            options={PURPOSE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.purposes.${value}`),
            }))}
            value={purpose}
            onValueChange={setPurpose}
          />
          <Select
            native
            label={t("office.templates.stateFilter")}
            options={STATE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.stateFilters.${value}`),
            }))}
            value={state}
            onValueChange={setState}
          />
        </FilterBar>
        <Card>
          <Table
            columns={columns}
            rows={found}
            getRowKey={(template) => template.id}
            empty={t(
              templates.data.length === 0
                ? "office.templates.empty"
                : "office.templates.nothingFound",
            )}
            scrollLabel={t("office.templates.title")}
          />
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader title={t("office.templates.title")} />
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
      {groups.isError && templates.isSuccess && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templates.groupsFailed")}
        </Alert>
      )}
      {content()}
    </>
  );
}
```

3. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/templates",
    labelKey: "office.nav.templates",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

4. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";

/** Office routes; paths match `OFFICE_NAV`. */
```

заменить на

<!-- prettier-ignore -->
```tsx
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";

/** Office routes; paths match `OFFICE_NAV`. */
```

5. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        ),
      },
      { path: "products", element: <ProductsPage /> },
      {
        path: "users",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
        ),
      },
      { path: "products", element: <ProductsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      {
        path: "users",
        element: (
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "operators": "Операторы",
      "devices": "Устройства",
      "products": "Товары",
      "users": "Пользователи"
    },
    "common": {
```

заменить на

<!-- prettier-ignore -->
```json
      "operators": "Операторы",
      "devices": "Устройства",
      "products": "Товары",
      "templates": "Шаблоны",
      "users": "Пользователи"
    },
    "common": {
```

7. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      }
    },
    "templates": {
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

заменить на

<!-- prettier-ignore -->
```json
      }
    },
    "templates": {
      "title": "Шаблоны этикеток",
      "empty": "Шаблонов пока нет.",
      "nothingFound": "Ничего не найдено. Измените поиск или отбор.",
      "filters": "Поиск и отбор шаблонов",
      "search": "Поиск",
      "searchHint": "Название шаблона",
      "purposeFilter": "Назначение",
      "stateFilter": "Состояние",
      "found": "Найдено: {{shown}} из {{total}}",
      "purposes": {
        "all": "Все",
        "box": "Короб",
        "pallet": "Паллета",
        "product_duplicate": "Дубликат товара"
      },
      "stateFilters": {
        "all": "Все",
        "enabled": "Включённые",
        "disabled": "Выключенные"
      },
      "states": {
        "enabled": "Включён",
        "disabled": "Выключен"
      },
      "table": {
        "name": "Название",
        "purpose": "Назначение",
        "size": "Размер",
        "dpi": "Разрешение макета",
        "scope": "Категории",
        "state": "Состояние"
      },
      "stock": "Типовой",
      "groupsFailed": "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

8. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  padding: 12px 0 0;
}

/* The GTIN field, and under it what the dialog says about a valid GTIN. */
.product-gtin,
.product-gtin__notes {
```

заменить на

<!-- prettier-ignore -->
```css
  padding: 12px 0 0;
}

/* A template's name, and the «Типовой» tag of a stock template beside it. */
.template-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* The GTIN field, and under it what the dialog says about a valid GTIN. */
.product-gtin,
.product-gtin__notes {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx`
Expected: PASS — 14 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx`
Expected: PASS, 14 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 14; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplatesPage.tsx` показывать шаблоны в порядке хоста: фрагмент

<!-- prettier-ignore -->
```tsx
findTemplates(templatesByName(templates.data), search, purpose, state)
```

заменить на

<!-- prettier-ignore -->
```tsx
findTemplates(templates.data, search, purpose, state)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "lists the templates by name"`
Expected: FAIL — `expected [ 'Коробка 100×100', …(6) ] to deeply equal [ 'Вода и молоко', …(6) ]`.

Мутация 2. В `apps/standalone/src/office/templates/template-list.ts` искать с учётом регистра: фрагмент

<!-- prettier-ignore -->
```ts
template.name.toLocaleLowerCase("ru").includes(text)
```

заменить на

<!-- prettier-ignore -->
```ts
template.name.includes(text)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "finds templates"`
Expected: FAIL — `expected [ undefined ] to deeply equal [ 'Коробка 58×40', 'Коробка 100×100' ]`.

Мутация 3. В `apps/standalone/src/office/templates/template-list.ts` не обрезать пробелы поиска: фрагмент

<!-- prettier-ignore -->
```ts
const text = search.trim().toLocaleLowerCase("ru");
```

заменить на

<!-- prettier-ignore -->
```ts
const text = search.toLocaleLowerCase("ru");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "finds templates"`
Expected: FAIL — `expected [ undefined ] to deeply equal [ 'Коробка 58×40', 'Коробка 100×100' ]`.

Мутация 4. В `apps/standalone/src/office/templates/template-list.ts` не отбирать по назначению: фрагмент

<!-- prettier-ignore -->
```ts
(purpose === "all" || template.purpose === purpose) &&
```

заменить на

<!-- prettier-ignore -->
```ts
(purpose === "all" || template.purpose !== "") &&
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "keeps one purpose"`
Expected: FAIL — `expected [ 'Вода и молоко', …(6) ] to deeply equal [ 'Паллета 100×150' ]`.

Мутация 5. В `apps/standalone/src/office/templates/template-list.ts` перевернуть отбор по состоянию: фрагмент

<!-- prettier-ignore -->
```ts
template.enabled === (state === "enabled")
```

заменить на

<!-- prettier-ignore -->
```ts
template.enabled === (state === "disabled")
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "keeps one purpose"`
Expected: FAIL — `expected [ 'Импорт без размера', …(3) ] to deeply equal [ 'Вода и молоко' ]`.

Мутация 6. В `apps/standalone/src/office/templates/TemplatesPage.tsx` считать пустым список, в котором ничего не нашлось: фрагмент

<!-- prettier-ignore -->
```tsx
templates.data.length === 0
```

заменить на

<!-- prettier-ignore -->
```tsx
found.length === 0
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "nothing was found"`
Expected: FAIL — `Unable to find an element with the text: Ничего не найдено. Измените поиск или отбор.`

Мутация 7. В `apps/standalone/src/office/templates/TemplatesPage.tsx` предупреждать о группах и при упавшем списке: фрагмент

<!-- prettier-ignore -->
```tsx
{groups.isError && templates.isSuccess && (
```

заменить на

<!-- prettier-ignore -->
```tsx
{groups.isError && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "explains a failed load"`
Expected: FAIL — `expected [ …(2) ] to have a length of 1 but got 2`: два предупреждения вместо одного.

Мутация 8. В `apps/standalone/src/office/templates/TemplatesPage.tsx` «Повторить» перечитывает только шаблоны: удалить фрагмент

<!-- prettier-ignore -->
```tsx
            if (groups.isError) void groups.refetch();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "explains a failed load"`
Expected: FAIL — `expected "vi.fn()" to be called 2 times, but got 1 times`: справочник групп не перечитан.

Мутация 9. В `apps/standalone/src/office/templates/TemplatesPage.tsx` не давать полного списка категорий в `title`: фрагмент

<!-- prettier-ignore -->
```tsx
<span title={scope.title ?? undefined}>{scope.label}</span>
```

заменить на

<!-- prettier-ignore -->
```tsx
<span>{scope.label}</span>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "names every category"`
Expected: FAIL — `expected null to be 'Молочная продукция, Упакованная вода,…'`.

Мутация 10. В `apps/standalone/src/office/nav.ts` поставить пункт в раздел «Доступ»: фрагмент

<!-- prettier-ignore -->
```ts
    to: "/templates",
    labelKey: "office.nav.templates",
    sectionKey: "office.nav.sections.catalog",
```

заменить на

<!-- prettier-ignore -->
```ts
    to: "/templates",
    labelKey: "office.nav.templates",
    sectionKey: "office.nav.sections.access",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "is in the menu"`
Expected: FAIL — `expected [ 'Каталог', 'Товары', 'Доступ' ] to deeply equal [ 'Каталог', 'Товары', 'Шаблоны' ]`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`PRODUCT_STALE_FIELDS`): the form was opened before its template was
  deleted. «Загрузить заново» closes the dialog and reads the products again;
  the templates are read again whenever a dialog opens.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  (`PRODUCT_STALE_FIELDS`): the form was opened before its template was
  deleted. «Загрузить заново» closes the dialog and reads the products again;
  the templates are read again whenever a dialog opens.
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards with
  thumbnails (nothing here renders a layout), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
  («58 × 40 мм») and the layout's resolution («203 dpi») as the summary has
  them, «—» where it has none, the categories (every category, one group's name,
  or «Категорий: N» with the names in a `title`; a code where the lookup lacks
  the group or did not load, and a failed lookup leaves the list in place and
  offers to read it again), the state in words («Включён», or «Выключен» as
  `retired`) and a «Типовой» tag on a stock template. The host sends the whole
  list, so the search (by name, without case), the purpose filter and the state
  filter work in the page; there are no pages, since a site keeps tens of
  templates. The templates are read whenever the page opens.

## Marking rules

```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  изменений. Отказ `validation_failed` по шаблону товара (шаблон удалили, пока
  форма была открыта) окно принимает за `stale_revision` и предлагает загрузить
  данные заново.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
```

заменить на

<!-- prettier-ignore -->
```text
  изменений. Отказ `validation_failed` по шаблону товара (шаблон удалили, пока
  форма была открыта) окно принимает за `stale_revision` и предлагает загрузить
  данные заново.
- Шаблоны (план 1e3): список видят все роли — все шаблоны, выключенные тоже,
  таблицей по названию с числами по значению (карточек с миниатюрами, как в облаке,
  нет: макет здесь не рисуется); в строке — назначение словом, размер и разрешение
  макета из сводки («—», где их нет), категории (все, одна по названию или
  «Категорий: N» с полным списком в подсказке; код, если справочник групп не
  загрузился или кода в нём нет), состояние словом и метка «Типовой». Поиск по
  названию и отбор по назначению и состоянию — в самом экране: хост отдаёт список
  целиком. Редактор шаблона — создание, копия, переименование, импорт ZPL/TSPL/JSON,
  форма размеров, предпросмотр, выгрузки и удаление — план 1e4: он переносит
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
```

Перечитать раздел «Office pages» в `AGENTS.md` и §5.5 спецификации целиком: то, что сказано о «Шаблонах», совпадает с тем, что делает страница (без кнопок записи до задачи 4), а редактор числится за планом 1e4.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/template-list.ts apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 44 файла, 991 тест (977 + 14).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/template-list.ts apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Шаблоны» — меню, список, поиск и отбор" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: «Шаблоны» — включение и выключение с объяснением умолчаний (D5, D7)

В строке появляется столбец «Действия» с «Выключить» или «Включить» (доступное имя — с названием шаблона), закрытый `useCan("editCatalog")` (D9: обе роли его видят, вида «только чтение» нет). Кнопка открывает `TemplateStateDialog` — подтверждение, как у операторов: выключение — с вариантом `destructive` и словами о том, что шаблон перестанет предлагаться для товаров и умолчаний, а станции получат изменение; включение — лёгкое. На хост уходит только признак с ревизией ОТКРЫТОЙ строки (`templateUpdate(row, { enabled })` из сводки), ответ хоста сливается в кэшированную сводку на месте (`useChangeList` с `withTemplateChange`), и список не перечитывается.

Шаблон-умолчание хост выключить не даёт (`conflict` `template_is_default`): `TemplateFailureAlert` говорит словами, чей он умолчание — организации, категорий по названию (код, если справочника нет), — и что сначала нужно выбрать другой шаблон на странице «Умолчания шаблонов». `stale_revision` — «Загрузить заново»: окно закрывается, список читается заново. Тест кэша рендерит страницу со своим `QueryClient` и закрепляет, что макет из ответа в кэш не попадает.

**Files:**

- Create: `apps/standalone/src/office/templates/TemplateFailureAlert.tsx`, `apps/standalone/src/office/templates/TemplateStateDialog.tsx`
- Modify: `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/templates-page.test.tsx` (Modify)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `templateUpdate` — `src/host/requests.ts`; `HostApi.updateTemplate` (план 1e2); `useOfficeMutation`, `officeKeys` — `src/office/office-query.ts`; `useChangeList` — `src/office/records.tsx`; `FormDialog`; `WriteFailureAlert` — `src/office/page-state.tsx`; `useCan` — `src/office/access.ts`;
  - `templateFailure`, `describeDefaultConflict`, `type TemplateFailure` — `template-text.ts`; `withTemplateChange` — `template-list.ts` (задача 2); `useProductGroups` — `catalog-queries.ts`.
- Produces:
  - `TemplateFailureAlert({ failure, groups, onReload })` — `src/office/templates/TemplateFailureAlert.tsx` (его же берёт задача 5);
  - `TemplateStateDialog({ template, onClose, onSaved, onReload })` — `src/office/templates/TemplateStateDialog.tsx`;
  - в `TemplatesPage`: `type TemplatesDialog`, столбец `actions`, уведомление и слияние ответа;
  - ключи `office.templates.{enable,disable,enableNamed,disableNamed,enableTitle,enableBody,enableSubmit,disableTitle,disableBody,disableSubmit,enabledNotice,disabledNotice}`, `office.templates.table.actions`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { matchesTemplateSearch } from "../src/office/templates/template-list.js";
import {
  fakeOfficeSession,
  renderOffice,
```

заменить на

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { matchesTemplateSearch } from "../src/office/templates/template-list.js";
import { TemplatesPage } from "../src/office/templates/TemplatesPage.js";
import {
  fakeOfficeSession,
  renderOffice,
```

2. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(names()).toHaveLength(7);
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(names()).toHaveLength(7);
  });
});

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

/**
 * The host's answer to a template write: the template with its layout. The
 * layout's size differs from the summary's on purpose: a row keeps the size it
 * has, since a switch or a change of categories never touches the layout.
 */
function answer(template: LabelTemplateSummary, data: Partial<LabelTemplate>): LabelTemplate {
  return {
    id: template.id,
    name: template.name,
    purpose: template.purpose,
    enabled: template.enabled,
    chzProductGroupCodes: template.chzProductGroupCodes,
    stock: template.stock,
    spec: { widthMm: 999, heightMm: 999, dpi: 600, language: "tspl", elements: [] },
    rev: template.rev + 1,
    ...data,
  };
}

/** Two passes of the scheduler: an effect that would read again has run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("office label templates: switching on and off", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lets both office roles switch templates, each button named after its template", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(TEMPLATES, user));
      fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
      expect(
        await screen.findByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Включить шаблон «Вода и молоко»" })).toBeTruthy();
      view.unmount();
    }
  });

  it("switches a template off after asking, sending only the flag with the opened row's revision, and shows the answer in the row without reading the list again", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { enabled: false }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    expect(screen.getByRole("dialog", { name: "Выключить шаблон?" })).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Шаблон «Молоко 58×40» перестанет предлагаться для товаров и умолчаний, а станции получат изменение. Включить его снова можно здесь же.",
      ),
    ).toBeTruthy();
    const submit = within(dialog()).getByRole("button", { name: "Выключить" });
    // Switching off takes the template out of use: the destructive variant.
    expect(submit.classList.contains("mk-btn--destructive")).toBe(true);
    fireEvent.click(submit);
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { enabled: false, expectedRev: 60 }],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cells("Молоко 58×40").slice(0, 6)).toEqual([
      "Молоко 58×40",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Молочная продукция",
      "✕Выключен",
    ]);
    expect(screen.getByRole("button", { name: "Включить шаблон «Молоко 58×40»" })).toBeTruthy();
    await settle();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached list a list of summaries: the answer goes into its row, and its layout stays out", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { enabled: false }));
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <TemplatesPage />
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    await screen.findByText("Шаблон «Молоко 58×40» выключен.");
    expect(queryClient.getQueryData(officeKeys.templates)).toStrictEqual(
      TEMPLATES.map((each) => (each.id === MILK.id ? { ...MILK, enabled: false, rev: 61 } : each)),
    );
  });

  it("switches a disabled template on after a light confirmation, and the notice goes when the next dialog opens", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(DRINKS, { enabled: true }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Включить шаблон «Вода и молоко»" }));
    expect(screen.getByRole("dialog", { name: "Включить шаблон?" })).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Шаблон «Вода и молоко» снова будет предлагаться для товаров и умолчаний, а станции получат изменение.",
      ),
    ).toBeTruthy();
    const submit = within(dialog()).getByRole("button", { name: "Включить" });
    expect(submit.classList.contains("mk-btn--primary")).toBe(true);
    fireEvent.click(submit);
    expect(await screen.findByText("Шаблон «Вода и молоко» включён.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", DRINKS.id, { enabled: true, expectedRev: 60 }],
    ]);
    expect(within(rowOf("Вода и молоко")).getByText("Включён")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }));
    expect(screen.queryByText("Шаблон «Вода и молоко» включён.")).toBeNull();
  });

  it("explains why a default stays on: the organization's default and the categories by name or code, and where to choose another; the row stays as it was", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", 409, {
        constraint: "template_is_default",
        organizationDefault: true,
        categoryDefaults: [8, 99],
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        "Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Выключить шаблон?" })).toBeTruthy();
    expect(within(rowOf("Коробка 58×40")).getByText("Включён")).toBeTruthy();
  });

  it("offers to load the templates again after a stale switch, closing the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("explains any other failure by its code and takes it away when the next try starts", async () => {
    const fake = session();
    let release: (template: LabelTemplate) => void = () => undefined;
    fake.api.updateTemplate.mockRejectedValueOnce(hostError("internal", 500)).mockReturnValueOnce(
      new Promise<LabelTemplate>((resolve) => {
        release = resolve;
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText("На хосте произошла ошибка. Повторите попытку."),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    await waitFor(() =>
      expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull(),
    );
    await act(async () => {
      release(answer(MILK, { enabled: false }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
  });

  it("sends one request for a double click, and «Отмена» closes the dialog without one", async () => {
    const fake = session();
    let release: (template: LabelTemplate) => void = () => undefined;
    fake.api.updateTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        release = resolve;
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 100×100»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    const submit = within(dialog()).getByRole("button", { name: "Выключить" });
    // Both clicks in one `act`: only the dialog's own guard drops the second.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await waitFor(() => expect(submit).toHaveProperty("disabled", true));
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(answer(MILK, { enabled: false }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx`
Expected: FAIL — `Tests  8 failed | 14 passed (22)`: кнопок нет (`Unable to find an accessible element with the role "button" and name "Выключить шаблон «Молоко 58×40»"`).

- [ ] **Step 3: Окно переключения и действия строки**

1. Create `apps/standalone/src/office/templates/TemplateFailureAlert.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { ProductGroup } from "../../host/protocol.js";
import { WriteFailureAlert } from "../page-state.js";
import { describeDefaultConflict, type TemplateFailure } from "./template-text.js";

export interface TemplateFailureAlertProps {
  /** `null` shows nothing. */
  failure: TemplateFailure | null;
  /** The ЧЗ product groups, to name a category; `undefined` names it by its code. */
  groups: readonly ProductGroup[] | undefined;
  /** Loads the templates again after a stale write. */
  onReload: () => void;
}

/**
 * A refused template write above its form: a template that is a default says
 * whose default it is and where to choose another; a stale write offers to
 * reload; anything else is explained by its code (`WriteFailureAlert`).
 */
export function TemplateFailureAlert({ failure, groups, onReload }: TemplateFailureAlertProps) {
  const { t } = useTranslation();
  if (failure?.kind === "default") {
    return <Alert tone="error">{describeDefaultConflict(failure.conflict, groups, t)}</Alert>;
  }
  return <WriteFailureAlert failure={failure} onReload={onReload} />;
}
```

2. Create `apps/standalone/src/office/templates/TemplateStateDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { templateFailure, type TemplateFailure } from "./template-text.js";

export interface TemplateStateDialogProps {
  /** The row as it was when the dialog opened: its revision goes with the write. */
  template: LabelTemplateSummary;
  onClose: () => void;
  onSaved: (template: LabelTemplate) => void;
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
}

/**
 * Switches an enabled template off, or a disabled one on, after saying what
 * it means. Switching off takes the template out of use (the `destructive`
 * variant); switching on is a light confirmation. Only the flag goes, with the
 * opened row's revision (`templateUpdate`). A template that is a default
 * cannot be switched off: the host refuses with `template_is_default`, and the
 * dialog says whose default it is and where to choose another.
 */
export function TemplateStateDialog({
  template,
  onClose,
  onSaved,
  onReload,
}: TemplateStateDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const change = useOfficeMutation((api, token, body: TemplateUpdate) =>
    api.updateTemplate(token, template.id, body),
  );
  const turningOff = template.enabled;

  const submit = async () => {
    setFailure(null);
    let saved: LabelTemplate;
    try {
      saved = await change.mutateAsync(templateUpdate(template, { enabled: !turningOff }));
    } catch (error) {
      setFailure(templateFailure(error));
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t(turningOff ? "office.templates.disableTitle" : "office.templates.enableTitle")}
      submitLabel={t(
        turningOff ? "office.templates.disableSubmit" : "office.templates.enableSubmit",
      )}
      submitVariant={turningOff ? "destructive" : "primary"}
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} onReload={onReload} />}
    >
      <p>
        {t(turningOff ? "office.templates.disableBody" : "office.templates.enableBody", {
          name: template.name,
        })}
      </p>
    </FormDialog>
  );
}
```

3. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  type TableColumn,
} from "@markiro/ui";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { LoadError, PageLoading } from "../page-state.js";
import {
  findTemplates,
  templatesByName,
  type TemplatePurposeFilter,
  type TemplateStateFilter,
} from "./template-list.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
  type TableColumn,
} from "@markiro/ui";

import type { LabelTemplate, LabelTemplateSummary } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { officeKeys } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useChangeList } from "../records.js";
import { TemplateStateDialog } from "./TemplateStateDialog.js";
import {
  findTemplates,
  templatesByName,
  withTemplateChange,
  type TemplatePurposeFilter,
  type TemplateStateFilter,
} from "./template-list.js";
```

4. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
  const templates = useTemplates();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");

  const columns: TableColumn<LabelTemplateSummary>[] = [
    {
```

заменить на

<!-- prettier-ignore -->
```tsx
const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

type TemplatesDialog = { kind: "state"; template: LabelTemplateSummary };

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes. Both office roles switch
 * templates on and off (`editCatalog`); a write's answer goes into the cached
 * row in place (`withTemplateChange`), and the list is not read again.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const templates = useTemplates();
  const groups = useProductGroups();
  const changeList = useChangeList<LabelTemplateSummary>(officeKeys.templates);
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");
  const [dialog, setDialog] = useState<TemplatesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: TemplatesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (template: LabelTemplate, message: string) => {
    changeList((list) => withTemplateChange(list, template));
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void templates.refetch();
  };

  const columns: TableColumn<LabelTemplateSummary>[] = [
    {
```

5. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      ),
    },
  ];

  const content = () => {
    if (templates.isPending) return <PageLoading />;
```

заменить на

<!-- prettier-ignore -->
```tsx
      ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.templates.table.actions"),
      render: (template) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t(
            template.enabled ? "office.templates.disableNamed" : "office.templates.enableNamed",
            { name: template.name },
          )}
          onClick={() => open({ kind: "state", template })}
        >
          {t(template.enabled ? "office.templates.disable" : "office.templates.enable")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (templates.isPending) return <PageLoading />;
```

6. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader title={t("office.templates.title")} />
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
      {groups.isError && templates.isSuccess && (
        <Alert
```

заменить на

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader title={t("office.templates.title")} />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
      {groups.isError && templates.isSuccess && (
        <Alert
```

7. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        </Alert>
      )}
      {content()}
    </>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
        </Alert>
      )}
      {content()}
      {canEdit && dialog?.kind === "state" && (
        <TemplateStateDialog
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSaved={(template) =>
            saved(
              template,
              t(
                template.enabled
                  ? "office.templates.enabledNotice"
                  : "office.templates.disabledNotice",
                { name: template.name },
              ),
            )
          }
          onReload={reload}
        />
      )}
    </>
  );
}
```

8. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "size": "Размер",
        "dpi": "Разрешение макета",
        "scope": "Категории",
        "state": "Состояние"
      },
      "stock": "Типовой",
      "groupsFailed": "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

заменить на

<!-- prettier-ignore -->
```json
        "size": "Размер",
        "dpi": "Разрешение макета",
        "scope": "Категории",
        "state": "Состояние",
        "actions": "Действия"
      },
      "stock": "Типовой",
      "groupsFailed": "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
      "enable": "Включить",
      "disable": "Выключить",
      "enableNamed": "Включить шаблон «{{name}}»",
      "disableNamed": "Выключить шаблон «{{name}}»",
      "enableTitle": "Включить шаблон?",
      "enableBody": "Шаблон «{{name}}» снова будет предлагаться для товаров и умолчаний, а станции получат изменение.",
      "enableSubmit": "Включить",
      "disableTitle": "Выключить шаблон?",
      "disableBody": "Шаблон «{{name}}» перестанет предлагаться для товаров и умолчаний, а станции получат изменение. Включить его снова можно здесь же.",
      "disableSubmit": "Выключить",
      "enabledNotice": "Шаблон «{{name}}» включён.",
      "disabledNotice": "Шаблон «{{name}}» выключен.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx`
Expected: PASS — 22 теста.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx`
Expected: PASS, 22 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 22; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplatesPage.tsx` закрыть кнопки по `editReference`: фрагмент

<!-- prettier-ignore -->
```tsx
const canEdit = useCan("editCatalog");
```

заменить на

<!-- prettier-ignore -->
```tsx
const canEdit = useCan("editReference");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "lets both office roles"`
Expected: FAIL — `Unable to find role="button" and name "Выключить шаблон «Коробка 58×40»"`.

Мутация 2. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` слать тот же признак: фрагмент

<!-- prettier-ignore -->
```tsx
templateUpdate(template, { enabled: !turningOff })
```

заменить на

<!-- prettier-ignore -->
```tsx
templateUpdate(template, { enabled: turningOff })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "switches a"`
Expected: FAIL — оба теста переключения: `expected [ [ 'office-session-token', …(2) ] ] to strictly equal [ [ 'office-session-token', …(2) ] ]`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` слать вместе с признаком категории: фрагмент

<!-- prettier-ignore -->
```tsx
templateUpdate(template, { enabled: !turningOff })
```

заменить на

<!-- prettier-ignore -->
```tsx
templateUpdate(template, { enabled: !turningOff, chzProductGroupCodes: [] })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "switches a"`
Expected: FAIL — оба теста переключения: `expected [ [ 'office-session-token', …(2) ] ] to strictly equal [ [ 'office-session-token', …(2) ] ]`.

Мутация 4. В `apps/standalone/src/office/templates/TemplatesPage.tsx` перечитывать список вместо слияния: фрагмент

<!-- prettier-ignore -->
```tsx
    changeList((list) => withTemplateChange(list, template));
```

заменить на

<!-- prettier-ignore -->
```tsx
    void templates.refetch();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "switches a template off"`
Expected: FAIL — `expected [ 'Молоко 58×40', 'Короб', …(4) ] to deeply equal [ 'Молоко 58×40', 'Короб', …(4) ]`: строка осталась прежней — список перечитан, ответ в неё не попал.

Мутация 5. В `apps/standalone/src/office/templates/TemplatesPage.tsx` заменять сводку ответом целиком: фрагмент

<!-- prettier-ignore -->
```tsx
changeList((list) => withTemplateChange(list, template));
```

заменить на

<!-- prettier-ignore -->
```tsx
changeList((list) => list.map((each) => (each.id === template.id ? { ...each, ...template } : each)));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "cached list"`
Expected: FAIL — `expected [ { …(11) }, { …(11) }, …(5) ] to strictly equal [ { …(11) }, { …(11) }, …(5) ]`: в кэш попал макет ответа.

Мутация 6. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` выключать без варианта `destructive`: фрагмент

<!-- prettier-ignore -->
```tsx
submitVariant={turningOff ? "destructive" : "primary"}
```

заменить на

<!-- prettier-ignore -->
```tsx
submitVariant="primary"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "switches a template off"`
Expected: FAIL — `expected false to be true`: у кнопки «Выключить» нет варианта разрушительного действия.

Мутация 7. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` не убирать прежний отказ: фрагмент

<!-- prettier-ignore -->
```tsx
  const submit = async () => {
    setFailure(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const submit = async () => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "any other failure"`
Expected: FAIL — `expected <div …(1)></div> to be null`: прежний отказ виден во время новой попытки.

Мутация 8. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` объяснять умолчание без справочника групп: фрагмент

<!-- prettier-ignore -->
```tsx
groups={groups.data}
```

заменить на

<!-- prettier-ignore -->
```tsx
groups={undefined}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "default stays on"`
Expected: FAIL — `Unable to find an element with the text: Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. Сначала выберите другой шаблон на странице «Умолчания шаблонов».`: категории названы кодами.

Мутация 9. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` разбирать отказ общим `alertFailure`: фрагмент

<!-- prettier-ignore -->
```tsx
import { templateFailure, type TemplateFailure } from "./template-text.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { alertFailure as templateFailure } from "../form-errors.js";
import type { TemplateFailure } from "./template-text.js";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "default stays on"`
Expected: FAIL — `Unable to find an element with the text: Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. Сначала выберите другой шаблон на странице «Умолчания шаблонов».`: вместо объяснения — общий текст ошибки.

Мутация 10. В `apps/standalone/src/office/templates/TemplatesPage.tsx` «Загрузить заново» не закрывает окно: фрагмент

<!-- prettier-ignore -->
```tsx
  const reload = () => {
    setDialog(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const reload = () => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "stale switch"`
Expected: FAIL — `expected <div role="dialog" …(5)>…(3)</div> to be null`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  `retired`) and a «Типовой» tag on a stock template. The host sends the whole
  list, so the search (by name, without case), the purpose filter and the state
  filter work in the page; there are no pages, since a site keeps tens of
  templates. The templates are read whenever the page opens.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  `retired`) and a «Типовой» tag on a stock template. The host sends the whole
  list, so the search (by name, without case), the purpose filter and the state
  filter work in the page; there are no pages, since a site keeps tens of
  templates. The templates are read whenever the page opens. Both roles switch a
  template on and off (`useCan("editCatalog")`; no role lacks it, so there is no
  read-only view). «Выключить» asks first, with the `destructive` submit, and
  says the template is no longer offered for products and defaults and the
  stations get the change; «Включить» asks lightly. Only the flag goes, with the
  opened row's revision (`templateUpdate`), and the answer goes into the cached
  row in place (`withTemplateChange`: the name, the flag, the categories,
  `stock` and the revision; the size, the resolution and the language stay, and
  the layout stays out of the cache), without reading the list again. Switching
  off a default is refused (`template_is_default`), and the dialog says whose
  default the template is (the organization's, the categories by name, a code
  where the lookup lacks the group) and that another template must be chosen on
  «Умолчания шаблонов» first; `stale_revision` offers «Загрузить заново», which
  closes the dialog and reads the list again.

## Marking rules

```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  «Категорий: N» с полным списком в подсказке; код, если справочник групп не
  загрузился или кода в нём нет), состояние словом и метка «Типовой». Поиск по
  названию и отбор по назначению и состоянию — в самом экране: хост отдаёт список
  целиком. Редактор шаблона — создание, копия, переименование, импорт ZPL/TSPL/JSON,
  форма размеров, предпросмотр, выгрузки и удаление — план 1e4: он переносит
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

заменить на

<!-- prettier-ignore -->
```text
  «Категорий: N» с полным списком в подсказке; код, если справочник групп не
  загрузился или кода в нём нет), состояние словом и метка «Типовой». Поиск по
  названию и отбор по назначению и состоянию — в самом экране: хост отдаёт список
  целиком. Включают и выключают шаблон обе роли, с подтверждением: на хост уходит
  только признак с ревизией открытой строки, ответ хоста встаёт в строку на месте,
  без перечитывания списка. Шаблон по умолчанию хост выключить не даёт
  (`template_is_default`), и окно говорит, у кого он стоит по умолчанию — у
  организации или у каких категорий, — и что сначала нужно выбрать другой шаблон на
  странице «Умолчания шаблонов». Редактор шаблона — создание, копия, переименование,
  импорт ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки и удаление — план
  1e4: он переносит `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с
  растеризатором и проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

Перечитать пункт «Шаблоны» в «Office pages» `AGENTS.md` и в §5.5 спецификации целиком: переключение описано так, как его делает окно, а категорий (задача 5) там ещё нет.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/TemplateFailureAlert.tsx apps/standalone/src/office/templates/TemplateStateDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 44 файла, 999 тестов (991 + 8).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/TemplateFailureAlert.tsx apps/standalone/src/office/templates/TemplateStateDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Шаблоны» — включение и выключение с объяснением умолчаний" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: «Шаблоны» — категории шаблона на `CategoryScopeField` (D6)

Второе действие строки — «Категории»: окно `TemplateCategoriesDialog` на переиспользуемом поле `CategoryScopeField` (его возьмёт редактор плана 1e4). Поле: радио «Все категории» / «Только выбранные»; при «Только выбранные» — поиск по названиям групп без учёта регистра, счётчик выбранных в живой области и флажки групп по названию; выбранные коды остаются, пока выбраны «Все категории», так что возврат их возвращает; пока справочник грузится или не загрузился, поле говорит, почему список пуст, и коды не теряет. Чистые помощники — `category-scope.ts`: `scopeOf`, `scopeCodes` (`null` для всех категорий, иначе коды ПО ВОЗРАСТАНИЮ: `templateUpdate` считает переставленный список изменением), `sameCategories` (те же категории в любом порядке), `visibleGroups`.

Окно шлёт `templateUpdate(row, { chzProductGroupCodes })` с ревизией открытой строки; «Сохранить» выключена, пока категории те же, хотя бы в другом порядке; «Только выбранные» без единой категории — ошибка под выбором без запроса. Сужение шаблона-умолчания хост отвергает (`template_is_default`), и окно объясняет это теми же словами, что переключение (`TemplateFailureAlert`); `stale_revision` — «Загрузить заново». Ответ сливается в строку на месте.

**Files:**

- Create: `apps/standalone/src/office/templates/category-scope.ts`, `apps/standalone/src/office/templates/CategoryScopeField.tsx`, `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`
- Modify: `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/category-scope-field.test.tsx` (Create), `apps/standalone/test/templates-page.test.tsx` (Modify)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `useProductGroups` — `catalog-queries.ts`; `errorProp` — `src/lib/form-error.ts`; `RadioGroup`, `Checkbox`, `Input`, `Alert`, `Button` — `@markiro/ui`;
  - `templateUpdate`; `TemplateFailureAlert`, `templateFailure` (задачи 2 и 4); `FormDialog`, `useOfficeMutation`.
- Produces:
  - `src/office/templates/category-scope.ts`: `interface CategoryScope { mode: "all" | "selected"; codes: readonly number[] }`, `scopeOf(codes)`, `scopeCodes(scope): number[] | null`, `sameCategories(a, b)`, `visibleGroups(groups, search)`;
  - `CategoryScopeField({ value, onChange, error? })` — `src/office/templates/CategoryScopeField.tsx` (для редактора 1e4 тоже);
  - `TemplateCategoriesDialog({ template, onClose, onSaved, onReload })`; в `TemplatesPage` — `RowActions` с двумя кнопками и `kind: "state" | "categories"`;
  - классы `.category-scope`, `.category-scope__list`; группа `office.categoryScope` и ключи `office.templates.{categories,categoriesNamed,categoriesTitle,categoriesIntro,categoriesNotice}`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/category-scope-field.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import {
  sameCategories,
  scopeCodes,
  scopeOf,
  visibleGroups,
  type CategoryScope,
} from "../src/office/templates/category-scope.js";
import { CategoryScopeField } from "../src/office/templates/CategoryScopeField.js";
import { fakeOfficeSession, type FakeOfficeSession } from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 3, alias: "tobacco", name: "Альтернативная табачная продукция" },
];

function session(): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

/** The field as a form holds it; `changes` records every value it reports. */
function renderField(fake: FakeOfficeSession, initial: CategoryScope, error?: string) {
  const changes: CategoryScope[] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <CategoryScopeField
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
        {...(error === undefined ? {} : { error })}
      />
    );
  }
  render(
    <QueryClientProvider client={createOfficeQueryClient()}>
      <OfficeSessionProvider value={fake}>
        <Harness />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
  return changes;
}

/** The groups the list offers, top to bottom, and whether each is checked. */
function offered(): [string | null, string | null][] {
  return within(screen.getByRole("group", { name: "Категории на выбор" }))
    .getAllByRole("checkbox")
    .map((box) => [
      document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
      box.getAttribute("aria-checked"),
    ]);
}

describe("the category scope of a template", () => {
  it("sends null for every category and the chosen codes ascending, and compares categories in any order", () => {
    expect(scopeOf(null)).toStrictEqual({ mode: "all", codes: [] });
    expect(scopeOf([13, 8])).toStrictEqual({ mode: "selected", codes: [13, 8] });
    expect(scopeCodes({ mode: "all", codes: [8] })).toBeNull();
    const codes = [13, 100, 8];
    expect(scopeCodes({ mode: "selected", codes })).toStrictEqual([8, 13, 100]);
    expect(codes).toStrictEqual([13, 100, 8]);
    expect(sameCategories(null, null)).toBe(true);
    expect(sameCategories([8, 13], [13, 8])).toBe(true);
    expect(sameCategories([8], [8, 13])).toBe(false);
    expect(sameCategories([8, 13], [8, 15])).toBe(false);
    expect(sameCategories([], null)).toBe(false);
    expect(sameCategories(null, [8])).toBe(false);
  });

  it("finds groups by name without case and spaces around the search, by name in Russian order", () => {
    expect(visibleGroups(GROUPS, "").map((group) => group.code)).toStrictEqual([3, 8, 13]);
    expect(visibleGroups(GROUPS, "  ПРОДУКЦ ").map((group) => group.code)).toStrictEqual([3, 8]);
    expect(visibleGroups(GROUPS, "кефир")).toStrictEqual([]);
  });

  it("offers every category or only the chosen ones, and lists the groups by name only for the chosen ones", async () => {
    const changes = renderField(session(), scopeOf(null));
    expect(screen.getByRole("radiogroup", { name: "Категории" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("group", { name: "Категории на выбор" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    expect(changes).toStrictEqual([{ mode: "selected", codes: [] }]);
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered()).toStrictEqual([
      ["Альтернативная табачная продукция", "false"],
      ["Молочная продукция", "false"],
      ["Упакованная вода", "false"],
    ]);
    expect(screen.getByText("Выбрано: 0").getAttribute("aria-live")).toBe("polite");
  });

  it("checks the template's categories, adds and takes away codes, and counts them", async () => {
    const changes = renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered()).toStrictEqual([
      ["Альтернативная табачная продукция", "false"],
      ["Молочная продукция", "false"],
      ["Упакованная вода", "true"],
    ]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [13, 8] });
    expect(screen.getByText("Выбрано: 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [8] });
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
  });

  it("searches the list, says when nothing matches, and a checked group the search hides stays chosen", async () => {
    const changes = renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    const search = screen.getByLabelText("Поиск категории");
    fireEvent.change(search, { target: { value: " МОЛОЧ " } });
    expect(offered()).toStrictEqual([["Молочная продукция", "false"]]);
    fireEvent.change(search, { target: { value: "кефир" } });
    expect(screen.getByText("Категорий с таким названием нет.")).toBeTruthy();
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
    expect(changes).toStrictEqual([]);
  });

  it("keeps the chosen codes while every category is chosen, so switching back brings them back", async () => {
    const changes = renderField(session(), scopeOf([8]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "all", codes: [8] });
    expect(screen.queryByRole("group", { name: "Категории на выбор" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [8] });
    expect(
      screen.getByRole("checkbox", { name: "Молочная продукция" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("says why it lists nothing while the groups load or when they fail, keeps the codes, and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const changes = renderField(fake, scopeOf([8]));
    expect(screen.getByText("Загружаем справочник категорий…")).toBeTruthy();
    expect(
      await screen.findByText(
        "Справочник категорий не загрузился: выбрать категории сейчас нельзя.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(
      screen.getByRole("checkbox", { name: "Молочная продукция" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(changes).toStrictEqual([]);
  });

  it("shows an error under the choice and ties it to the radio group", async () => {
    renderField(session(), scopeOf([]), "Выберите хотя бы одну категорию");
    const message = screen.getByText("Выберите хотя бы одну категорию");
    const choice = screen.getByRole("radiogroup", { name: "Категории" });
    expect(choice.getAttribute("aria-describedby")).toBe(message.id);
    expect(choice.getAttribute("aria-invalid")).toBe("true");
    await screen.findByRole("group", { name: "Категории на выбор" });
  });
});
```

2. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("office label templates: categories", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /** Opens a template's «Категории» and waits for the groups. */
  async function openCategories(fake: FakeOfficeSession, name: string): Promise<void> {
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: `Категории шаблона «${name}»` }));
    expect(screen.getByRole("dialog", { name: `Категории шаблона «${name}»` })).toBeTruthy();
  }

  function save(): HTMLElement {
    return within(dialog()).getByRole("button", { name: "Сохранить" });
  }

  it("narrows a template to the chosen categories: the codes go ascending with the opened row's revision, and the row counts them", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(BOX_100, { chzProductGroupCodes: [8, 13] }));
    await openCategories(fake, "Коробка 100×100");
    expect(
      within(dialog()).getByText(
        "Шаблон будет предлагаться только товарам выбранных категорий. Умолчанием организации может быть только шаблон для всех категорий.",
      ),
    ).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    fireEvent.click(save());
    expect(await screen.findByText("Категории шаблона «Коробка 100×100» сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", BOX_100.id, { chzProductGroupCodes: [8, 13], expectedRev: 60 }],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    const scope = within(rowOf("Коробка 100×100")).getByText("Категорий: 2");
    expect(scope.getAttribute("title")).toBe("Молочная продукция, Упакованная вода");
    expect(cells("Коробка 100×100")[2]).toBe("100 × 100 мм");
    await settle();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("widens a template to every category with null", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { chzProductGroupCodes: null }));
    await openCategories(fake, "Молоко 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(save());
    expect(await screen.findByText("Категории шаблона «Молоко 58×40» сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { chzProductGroupCodes: null, expectedRev: 60 }],
    ]);
    expect(within(rowOf("Молоко 58×40")).getByText("Все категории")).toBeTruthy();
  });

  it("asks for at least one category before sending, and keeps «Сохранить» off while the categories are the row's in any order", async () => {
    const reversed = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", "Обратный порядок", {
      chzProductGroupCodes: [13, 8],
    });
    const fake = session([...TEMPLATES, reversed]);
    fake.api.updateTemplate.mockResolvedValue(answer(reversed, { chzProductGroupCodes: [13] }));
    await openCategories(fake, "Обратный порядок");
    await screen.findByRole("checkbox", { name: "Молочная продукция" });
    // The same categories in another order are no change: nothing would be sent.
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(save()).toHaveProperty("disabled", false);
    fireEvent.click(save());
    const message = await screen.findByText(
      "Выберите хотя бы одну категорию или переключитесь на «Все категории».",
    );
    expect(
      screen.getByRole("radiogroup", { name: "Категории" }).getAttribute("aria-describedby"),
    ).toBe(message.id);
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
    // A change of the categories takes the message away; the back-sorted list goes ascending.
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(
      screen.queryByText("Выберите хотя бы одну категорию или переключитесь на «Все категории»."),
    ).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1));
    expect(fake.api.updateTemplate.mock.calls[0]?.[2]).toStrictEqual({
      chzProductGroupCodes: [13],
      expectedRev: 60,
    });
  });

  it("explains a refused narrowing of a default: the categories by name, and where to choose another", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", 409, {
        constraint: "template_is_default",
        organizationDefault: false,
        categoryDefaults: [8],
      }),
    );
    await openCategories(fake, "Коробка 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(save());
    expect(
      await within(dialog()).findByText(
        "Шаблон выбран по умолчанию для категорий: Молочная продукция. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории")).toBeTruthy();
  });

  it("offers to load the templates again after a stale change of the categories, closing the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    await openCategories(fake, "Молоко 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(save());
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: FAIL — `test/category-scope-field.test.tsx` не загружается (`Failed to resolve import "../src/office/templates/category-scope.js"`), в `test/templates-page.test.tsx` — `Tests  5 failed | 22 passed (27)`: кнопки «Категории» нет (`Unable to find an accessible element with the role "button" and name "Категории шаблона «Коробка 100×100»"`).

- [ ] **Step 3: Поле категорий, окно и вторая кнопка строки**

1. Create `apps/standalone/src/office/templates/category-scope.ts`:

<!-- prettier-ignore -->
```ts
import type { ProductGroup } from "../../host/protocol.js";

/** Group names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * A template's categories as `CategoryScopeField` edits them: every category,
 * or the chosen ЧЗ product-group codes. The codes stay while «Все категории»
 * is chosen, so switching back brings them back.
 */
export interface CategoryScope {
  mode: "all" | "selected";
  codes: readonly number[];
}

/** The field's value for a template's categories (`null` for every category). */
export function scopeOf(codes: readonly number[] | null): CategoryScope {
  return codes === null ? { mode: "all", codes: [] } : { mode: "selected", codes };
}

/**
 * The categories a write sends: `null` for every category, else the chosen
 * codes ascending. `templateUpdate` takes a reordered list as a change, which
 * would cost a new revision and send the layout to every station again.
 */
export function scopeCodes(scope: CategoryScope): number[] | null {
  return scope.mode === "all" ? null : [...scope.codes].sort((a, b) => a - b);
}

/** Whether two category lists name the same categories in any order (`null` is every category). */
export function sameCategories(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((code) => b.includes(code));
}

/** The groups whose name holds the search without case, by name; a blank search keeps them all. */
export function visibleGroups(groups: readonly ProductGroup[], search: string): ProductGroup[] {
  const text = search.trim().toLocaleLowerCase("ru");
  return groups
    .filter((group) => text === "" || group.name.toLocaleLowerCase("ru").includes(text))
    .sort((a, b) => NAMES.compare(a.name, b.name));
}
```

2. Create `apps/standalone/src/office/templates/CategoryScopeField.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, RadioGroup } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { visibleGroups, type CategoryScope } from "./category-scope.js";

export interface CategoryScopeFieldProps {
  value: CategoryScope;
  onChange: (next: CategoryScope) => void;
  /** Under the choice: why the categories cannot go as they are. */
  error?: string;
}

/**
 * A template's categories: every category, or the chosen ЧЗ product groups,
 * found by name (after the cloud editor's `scopeMode`, `scopeSearch` and
 * `visibleGroups`). The groups come from `useProductGroups`; while they load
 * or when they fail, «Только выбранные» keeps its codes and says why it lists
 * nothing. The template editor of plan 1e4 is to take this field as well.
 */
export function CategoryScopeField({ value, onChange, error }: CategoryScopeFieldProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const shown = groups.data === undefined ? [] : visibleGroups(groups.data, search);

  const toggle = (code: number, checked: boolean) =>
    onChange({
      mode: "selected",
      codes: checked ? [...value.codes, code] : value.codes.filter((each) => each !== code),
    });

  const list = () => {
    if (groups.isPending) return <p className="office-note">{t("office.categoryScope.loading")}</p>;
    if (groups.isError) {
      return (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.categoryScope.failed")}
        </Alert>
      );
    }
    return (
      <>
        <Input
          label={t("office.categoryScope.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div
          className="category-scope__list"
          role="group"
          aria-label={t("office.categoryScope.list")}
        >
          {shown.length === 0 ? (
            <p className="office-note">{t("office.categoryScope.nothingFound")}</p>
          ) : (
            shown.map((group) => (
              <Checkbox
                key={group.code}
                label={group.name}
                checked={value.codes.includes(group.code)}
                onCheckedChange={(checked) => toggle(group.code, checked)}
              />
            ))
          )}
        </div>
      </>
    );
  };

  return (
    <div className="category-scope">
      <RadioGroup
        label={t("office.categoryScope.label")}
        options={[
          { value: "all", label: t("office.categoryScope.all") },
          { value: "selected", label: t("office.categoryScope.selected") },
        ]}
        value={value.mode}
        onValueChange={(mode) =>
          onChange({ ...value, mode: mode === "selected" ? "selected" : "all" })
        }
        {...errorProp(error)}
      />
      {value.mode === "selected" && (
        <>
          <p className="office-note" aria-live="polite">
            {t("office.categoryScope.chosen", { n: value.codes.length })}
          </p>
          {list()}
        </>
      )}
    </div>
  );
}
```

3. Create `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { sameCategories, scopeCodes, scopeOf, type CategoryScope } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { templateFailure, type TemplateFailure } from "./template-text.js";

export interface TemplateCategoriesDialogProps {
  /** The row as it was when the dialog opened: its revision goes with the write. */
  template: LabelTemplateSummary;
  onClose: () => void;
  onSaved: (template: LabelTemplate) => void;
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
}

/**
 * A template's categories: every category (`null`) or the chosen ones,
 * ascending, with the opened row's revision (`templateUpdate`). «Сохранить»
 * stays off until the categories differ from the row's in more than their
 * order, and «Только выбранные» needs at least one category. Narrowing a
 * template out of a category whose default it is, or narrowing the
 * organization's default at all, is refused with `template_is_default`, and
 * the dialog says whose default the template is.
 */
export function TemplateCategoriesDialog({
  template,
  onClose,
  onSaved,
  onReload,
}: TemplateCategoriesDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [scope, setScope] = useState<CategoryScope>(() => scopeOf(template.chzProductGroupCodes));
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const save = useOfficeMutation((api, token, body: TemplateUpdate) =>
    api.updateTemplate(token, template.id, body),
  );
  const codes = scopeCodes(scope);

  const submit = async () => {
    setFailure(null);
    if (codes !== null && codes.length === 0) {
      setScopeError("office.categoryScope.empty");
      return;
    }
    let saved: LabelTemplate;
    try {
      saved = await save.mutateAsync(templateUpdate(template, { chzProductGroupCodes: codes }));
    } catch (error) {
      setFailure(templateFailure(error));
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t("office.templates.categoriesTitle", { name: template.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={sameCategories(codes, template.chzProductGroupCodes)}
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} onReload={onReload} />}
    >
      <p>{t("office.templates.categoriesIntro")}</p>
      <CategoryScopeField
        value={scope}
        onChange={(next) => {
          setScope(next);
          setScopeError(null);
        }}
        {...(scopeError === null ? {} : { error: t(scopeError) })}
      />
    </FormDialog>
  );
}
```

4. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
```

заменить на

<!-- prettier-ignore -->
```tsx
  FilterBar,
  Input,
  PageHeader,
  RowActions,
  Select,
  StatusChip,
  Table,
```

5. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { officeKeys } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useChangeList } from "../records.js";
import { TemplateStateDialog } from "./TemplateStateDialog.js";
import {
  findTemplates,
```

заменить на

<!-- prettier-ignore -->
```tsx
import { officeKeys } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useChangeList } from "../records.js";
import { TemplateCategoriesDialog } from "./TemplateCategoriesDialog.js";
import { TemplateStateDialog } from "./TemplateStateDialog.js";
import {
  findTemplates,
```

6. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

type TemplatesDialog = { kind: "state"; template: LabelTemplateSummary };

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
```

заменить на

<!-- prettier-ignore -->
```tsx
const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

type TemplatesDialog = { kind: "state" | "categories"; template: LabelTemplateSummary };

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
```

7. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes. Both office roles switch
 * templates on and off (`editCatalog`); a write's answer goes into the cached
 * row in place (`withTemplateChange`), and the list is not read again.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
```

заменить на

<!-- prettier-ignore -->
```tsx
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes. Both office roles switch
 * templates on and off and change their categories (`editCatalog`); a write's
 * answer goes into the cached row in place (`withTemplateChange`), and the
 * list is not read again.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
```

8. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      key: "actions",
      title: t("office.templates.table.actions"),
      render: (template) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t(
            template.enabled ? "office.templates.disableNamed" : "office.templates.enableNamed",
            { name: template.name },
          )}
          onClick={() => open({ kind: "state", template })}
        >
          {t(template.enabled ? "office.templates.disable" : "office.templates.enable")}
        </Button>
      ),
    });
  }
```

заменить на

<!-- prettier-ignore -->
```tsx
      key: "actions",
      title: t("office.templates.table.actions"),
      render: (template) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t(
              template.enabled ? "office.templates.disableNamed" : "office.templates.enableNamed",
              { name: template.name },
            )}
            onClick={() => open({ kind: "state", template })}
          >
            {t(template.enabled ? "office.templates.disable" : "office.templates.enable")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.templates.categoriesNamed", { name: template.name })}
            onClick={() => open({ kind: "categories", template })}
          >
            {t("office.templates.categories")}
          </Button>
        </RowActions>
      ),
    });
  }
```

9. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          onReload={reload}
        />
      )}
    </>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
          onReload={reload}
        />
      )}
      {canEdit && dialog?.kind === "categories" && (
        <TemplateCategoriesDialog
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSaved={(template) =>
            saved(template, t("office.templates.categoriesNotice", { name: template.name }))
          }
          onReload={reload}
        />
      )}
    </>
  );
}
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "disableSubmit": "Выключить",
      "enabledNotice": "Шаблон «{{name}}» включён.",
      "disabledNotice": "Шаблон «{{name}}» выключен.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

заменить на

<!-- prettier-ignore -->
```json
      "disableSubmit": "Выключить",
      "enabledNotice": "Шаблон «{{name}}» включён.",
      "disabledNotice": "Шаблон «{{name}}» выключен.",
      "categories": "Категории",
      "categoriesNamed": "Категории шаблона «{{name}}»",
      "categoriesTitle": "Категории шаблона «{{name}}»",
      "categoriesIntro": "Шаблон будет предлагаться только товарам выбранных категорий. Умолчанием организации может быть только шаблон для всех категорий.",
      "categoriesNotice": "Категории шаблона «{{name}}» сохранены.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
      "groupCode": "Код {{code}}",
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "categories": "Шаблон выбран по умолчанию для категорий: {{categories}}.",
        "hint": "Сначала выберите другой шаблон на странице «Умолчания шаблонов»."
      }
    },
    "templateChoice": {
      "none": "Не выбран",
```

заменить на

<!-- prettier-ignore -->
```json
        "categories": "Шаблон выбран по умолчанию для категорий: {{categories}}.",
        "hint": "Сначала выберите другой шаблон на странице «Умолчания шаблонов»."
      }
    },
    "categoryScope": {
      "label": "Категории",
      "all": "Все категории",
      "selected": "Только выбранные",
      "search": "Поиск категории",
      "list": "Категории на выбор",
      "chosen": "Выбрано: {{n}}",
      "nothingFound": "Категорий с таким названием нет.",
      "loading": "Загружаем справочник категорий…",
      "failed": "Справочник категорий не загрузился: выбрать категории сейчас нельзя.",
      "empty": "Выберите хотя бы одну категорию или переключитесь на «Все категории»."
    },
    "templateChoice": {
      "none": "Не выбран",
```

12. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  gap: 8px;
}

/* The GTIN field, and under it what the dialog says about a valid GTIN. */
.product-gtin,
.product-gtin__notes {
```

заменить на

<!-- prettier-ignore -->
```css
  gap: 8px;
}

/* A template's categories: the choice, the search and a list of groups that scrolls. */
.category-scope {
  display: grid;
  gap: 12px;
}

.category-scope__list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
}

/* The GTIN field, and under it what the dialog says about a valid GTIN. */
.product-gtin,
.product-gtin__notes {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: PASS — 2 файла, 35 тестов (`category-scope-field` 8, `templates-page` 27).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: PASS, 35 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 35; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/category-scope.ts` слать коды в порядке выбора: фрагмент

<!-- prettier-ignore -->
```ts
[...scope.codes].sort((a, b) => a - b)
```

заменить на

<!-- prettier-ignore -->
```ts
[...scope.codes]
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 33 passed (35)`: `expected [ 13, 100, 8 ] to strictly equal [ 8, 13, 100 ]`, `expected [ [ 'office-session-token', …(2) ] ] to strictly equal [ [ 'office-session-token', …(2) ] ]`.

Мутация 2. В `apps/standalone/src/office/templates/category-scope.ts` сравнивать категории с учётом порядка: фрагмент

<!-- prettier-ignore -->
```ts
a.every((code) => b.includes(code))
```

заменить на

<!-- prettier-ignore -->
```ts
a.every((code, index) => code === b[index])
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 33 passed (35)`: `expected false to be true`, `expected <button type="submit" …(3)></button> to have property "disabled" with value true`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx` слать пустой выбор: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    if (codes !== null && codes.length === 0) {
      setScopeError("office.categoryScope.empty");
      return;
    }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "at least one category"`
Expected: FAIL — `Unable to find an element with the text: Выберите хотя бы одну категорию или переключитесь на «Все категории».`: окно отправило пустой выбор.

Мутация 4. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx` не убирать ошибку при смене выбора: фрагмент

<!-- prettier-ignore -->
```tsx
          setScope(next);
          setScopeError(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
          setScope(next);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "at least one category"`
Expected: FAIL — `expected <span …(2)></span> to be null`: ошибка осталась после выбора категории.

Мутация 5. В `apps/standalone/src/office/templates/CategoryScopeField.tsx` перевернуть радио: фрагмент

<!-- prettier-ignore -->
```tsx
mode: mode === "selected" ? "selected" : "all"
```

заменить на

<!-- prettier-ignore -->
```tsx
mode: mode === "selected" ? "all" : "selected"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx`
Expected: FAIL — `Tests  2 failed | 6 passed (8)`: `expected [ { mode: 'all', codes: [] } ] to strictly equal [ { mode: 'selected', codes: [] } ]`, `expected { mode: 'selected', codes: [ 8 ] } to strictly equal { mode: 'all', codes: [ 8 ] }`.

Мутация 6. В `apps/standalone/src/office/templates/CategoryScopeField.tsx` флажок заменяет выбор: фрагмент

<!-- prettier-ignore -->
```tsx
codes: checked ? [...value.codes, code] : value.codes.filter((each) => each !== code),
```

заменить на

<!-- prettier-ignore -->
```tsx
codes: checked ? [code] : value.codes.filter((each) => each !== code),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx -t "adds and takes away"`
Expected: FAIL — `expected { mode: 'selected', codes: [ 8 ] } to strictly equal { mode: 'selected', codes: [ 13, 8 ] }`.

Мутация 7. В `apps/standalone/src/office/templates/CategoryScopeField.tsx` стирать коды при «Все категории»: фрагмент

<!-- prettier-ignore -->
```tsx
onChange({ ...value, mode: mode === "selected" ? "selected" : "all" })
```

заменить на

<!-- prettier-ignore -->
```tsx
onChange({ codes: [], mode: mode === "selected" ? "selected" : "all" })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx -t "switching back"`
Expected: FAIL — `expected { codes: [], mode: 'all' } to strictly equal { mode: 'all', codes: [ 8 ] }`.

Мутация 8. В `apps/standalone/src/office/templates/CategoryScopeField.tsx` не показывать ошибку поля: удалить фрагмент

<!-- prettier-ignore -->
```tsx
        {...errorProp(error)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 33 passed (35)`: `Unable to find an element with the text: Выберите хотя бы одну категорию`, `Unable to find an element with the text: Выберите хотя бы одну категорию или переключитесь на «Все категории».`

Мутация 9. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx` держать «Сохранить» включённой: фрагмент

<!-- prettier-ignore -->
```tsx
submitDisabled={sameCategories(codes, template.chzProductGroupCodes)}
```

заменить на

<!-- prettier-ignore -->
```tsx
submitDisabled={false}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "at least one category"`
Expected: FAIL — `expected <button type="submit" …(3)></button> to have property "disabled" with value true`.

Мутация 10. В `apps/standalone/src/office/templates/CategoryScopeField.tsx` вывести счётчик из живой области: фрагмент

<!-- prettier-ignore -->
```tsx
<p className="office-note" aria-live="polite">
```

заменить на

<!-- prettier-ignore -->
```tsx
<p className="office-note">
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/category-scope-field.test.tsx`
Expected: FAIL — `Tests  1 failed | 7 passed (8)`: `expected null to be 'polite'`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  default the template is (the organization's, the categories by name, a code
  where the lookup lacks the group) and that another template must be chosen on
  «Умолчания шаблонов» first; `stale_revision` offers «Загрузить заново», which
  closes the dialog and reads the list again.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  default the template is (the organization's, the categories by name, a code
  where the lookup lacks the group) and that another template must be chosen on
  «Умолчания шаблонов» first; `stale_revision` offers «Загрузить заново», which
  closes the dialog and reads the list again. «Категории» opens a dialog on
  `CategoryScopeField` (`src/office/templates/CategoryScopeField.tsx`, which the
  editor of plan 1e4 is to reuse): «Все категории» or «Только выбранные», the
  product groups by name with a search and a live count of the chosen ones; the
  chosen codes stay while «Все категории» is picked, so switching back brings
  them back, and while the lookup loads or fails the field keeps them and says
  why it lists nothing. The dialog sends `null` for every category or the chosen
  codes ascending (`scopeCodes`: `templateUpdate` takes a reordered list as a
  change, a new revision and the layout to every station again), with the opened
  row's revision; «Сохранить» stays off while the categories are the row's in
  any order, and «Только выбранные» needs at least one category. Narrowing a
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place.

## Marking rules

```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  без перечитывания списка. Шаблон по умолчанию хост выключить не даёт
  (`template_is_default`), и окно говорит, у кого он стоит по умолчанию — у
  организации или у каких категорий, — и что сначала нужно выбрать другой шаблон на
  странице «Умолчания шаблонов». Редактор шаблона — создание, копия, переименование,
  импорт ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки и удаление — план
  1e4: он переносит `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с
  растеризатором и проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
```

заменить на

<!-- prettier-ignore -->
```text
  без перечитывания списка. Шаблон по умолчанию хост выключить не даёт
  (`template_is_default`), и окно говорит, у кого он стоит по умолчанию — у
  организации или у каких категорий, — и что сначала нужно выбрать другой шаблон на
  странице «Умолчания шаблонов». Категории шаблона меняет окно на
  `CategoryScopeField` (его возьмёт и редактор плана 1e4): все категории или только
  выбранные, поиск групп по названию; на хост уходят `null` или выбранные коды по
  возрастанию (переставленный список хост счёл бы изменением и разослал бы макет
  всем станциям заново), «Сохранить» выключена, пока категории те же хотя бы в
  другом порядке, а «Только выбранные» требует хотя бы одной категории. Сужение
  шаблона, на котором стоит умолчание, хост отвергает так же, и окно объясняет это
  теми же словами. Редактор шаблона — создание, копия, переименование, импорт
  ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки и удаление — план 1e4: он
  переносит `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с
  растеризатором и проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
```

Перечитать пункт «Шаблоны» в «Office pages» `AGENTS.md` и в §5.5 спецификации целиком: категории описаны так, как их меняет окно, `CategoryScopeField` назван полем, которое редактор 1e4 ещё только возьмёт.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/CategoryScopeField.tsx apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/category-scope.ts apps/standalone/test/category-scope-field.test.tsx apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 45 файлов, 1012 тестов (999 + 13).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/CategoryScopeField.tsx apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/category-scope.ts apps/standalone/test/category-scope-field.test.tsx apps/standalone/test/templates-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Шаблоны» — категории шаблона на CategoryScopeField" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Страница «Умолчания шаблонов» — умолчания организации и сохранение документа (D8)

В «Каталоге» после «Шаблонов» появляется пункт «Умолчания шаблонов» (обе роли, маршрут `/template-defaults` без `RequireRole`). Страница читает один документ (`useTemplateDefaults`, новый ключ `officeKeys.templateDefaults`, `staleTime` 0) и список шаблонов — один раз за посещение, в компоненте страницы, и передаёт их форме: форма пересоздаётся на каждой новой ревизии (`key={document.rev}`), и свой запрос перечитывал бы список при каждом сохранении. Карточка «Для организации» — три выбора (`templateOptions` с категорией `null`: «Не выбран» и включённые шаблоны своего назначения для всех категорий, по названию; умолчание, которого список не предлагает, остаётся выбором с пометкой).

Правки живут в странице (`defaults-form.ts`: черновик, где «Не выбран» — `""`, и сравнение в любом порядке): живая строка о несохранённых изменениях, «Отменить изменения» возвращает загруженный документ, «Сохранить» (выключена без изменений) шлёт документ целиком `templateDefaultsUpdate(defaultsInput(draft), document.rev)` — `null` за «Не выбран» и умолчания категорий как есть — и отсекает второй щелчок своим ref-стражем; ответ ложится в кэш, форма начинается заново, уведомление «Изменения сохранены.» уходит, когда начинается следующее сохранение. `validation_failed` на умолчании организации встаёт под его выбор («Шаблон больше не подходит…») и перечитывает список шаблонов; смена этого выбора убирает сообщение. `stale_revision` — «Загрузить заново» со своим текстом (правку двигает и профиль организации): `StaleAlert` и `WriteFailureAlert` получают необязательный текст. Умолчания категорий (карточка, строки, добавление) — задача 7.

**Files:**

- Create: `apps/standalone/src/office/templates/defaults-form.ts`, `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx`
- Modify: `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/catalog-queries.ts`, `apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/defaults-form.test.ts`, `apps/standalone/test/template-defaults-page.test.tsx` (Create); `apps/standalone/test/form-dialog.test.tsx` (Modify)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `HostApi.getTemplateDefaults`, `HostApi.updateTemplateDefaults`, `templateDefaultsUpdate`, `type TemplateDefaultsInput` (план 1e2); `useTemplates` — `catalog-queries.ts`; `templateOptions` — `template-options.ts` (задача 2);
  - `useOfficeQuery`, `useOfficeMutation`, `officeKeys`; `LoadError`, `PageLoading`, `WriteFailureAlert`; `alertFailure`, `type AlertFailure`; `useCan`; `errorProp`.
- Produces:
  - `officeKeys.templateDefaults` (`["office", "template-defaults"]`); `useTemplateDefaults()` — `catalog-queries.ts`;
  - `src/office/templates/defaults-form.ts`: `ORG_DEFAULTS`, `type OrgDefaultField`, `interface DefaultsDraft`, `draftOf(document)`, `withOrgDefault(draft, field, id)`, `defaultsInput(draft)`, `slotKey(entry)`, `sameDraft(a, b)`, `type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure`, `defaultsFailure(error)`;
  - `TemplateDefaultsPage` — `src/office/templates/TemplateDefaultsPage.tsx`; пункт меню `/template-defaults` и маршрут `template-defaults`;
  - `StaleAlert({ onReload, message? })`, `WriteFailureAlert({ failure, onReload?, staleMessage? })`;
  - ключи `office.nav.templateDefaults` и группы `office.templateDefaults` (`title`, `organization`, `orgHint`, `fields.*`, `dirty`, `cancel`, `stale`, `templatesFailed`, `errors.unfit`).

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/defaults-form.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { TemplateDefaults } from "../src/host/protocol.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  sameDraft,
  slotKey,
  withOrgDefault,
} from "../src/office/templates/defaults-form.js";

const BOX = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const MILK = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const WATER = "8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d";

const DOCUMENT: TemplateDefaults = {
  defaultBoxTemplateId: BOX,
  defaultPalletTemplateId: null,
  defaultDuplicateTemplateId: null,
  categories: [
    { chzProductGroupCode: 8, purpose: "box", templateId: MILK },
    { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
  ],
  rev: 64,
};

function rejected(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "rejected",
    details: { field },
  });
}

describe("the defaults form", () => {
  it("holds an organization default as its select does, and sends one left at «Не выбран» as null", () => {
    const draft = draftOf(DOCUMENT);
    expect(draft).toStrictEqual({
      defaultBoxTemplateId: BOX,
      defaultPalletTemplateId: "",
      defaultDuplicateTemplateId: "",
      categories: DOCUMENT.categories,
    });
    expect(defaultsInput(draft)).toStrictEqual({
      defaultBoxTemplateId: BOX,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: DOCUMENT.categories,
    });
    const changed = withOrgDefault(
      withOrgDefault(
        withOrgDefault(draft, "defaultBoxTemplateId", ""),
        "defaultPalletTemplateId",
        BOX,
      ),
      "defaultDuplicateTemplateId",
      MILK,
    );
    expect(defaultsInput(changed)).toStrictEqual({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: BOX,
      defaultDuplicateTemplateId: MILK,
      categories: DOCUMENT.categories,
    });
    expect(draft.defaultBoxTemplateId).toBe(BOX);
  });

  it("keys a category default by its category and purpose, as the feed does", () => {
    expect(slotKey({ chzProductGroupCode: 8, purpose: "product_duplicate" })).toBe(
      "8:product_duplicate",
    );
  });

  it("finds a draft unchanged with the same defaults in any order, and changed by any default", () => {
    const draft = draftOf(DOCUMENT);
    const reversed = { ...draft, categories: [...draft.categories].reverse() };
    expect(sameDraft(reversed, draft)).toBe(true);
    for (const field of [
      "defaultBoxTemplateId",
      "defaultPalletTemplateId",
      "defaultDuplicateTemplateId",
    ] as const) {
      expect(sameDraft(withOrgDefault(draft, field, WATER), draft), field).toBe(false);
    }
    const [milk, water] = DOCUMENT.categories;
    if (milk === undefined || water === undefined) throw new Error("two category defaults");
    expect(sameDraft({ ...draft, categories: [milk] }, draft)).toBe(false);
    expect(sameDraft({ ...draft, categories: [milk, { ...water, templateId: MILK }] }, draft)).toBe(
      false,
    );
    expect(
      sameDraft({ ...draft, categories: [milk, { ...water, purpose: "pallet" }] }, draft),
    ).toBe(false);
  });

  it("puts a refusal of an organization default under its field, and explains anything else above the form", () => {
    for (const field of [
      "defaultBoxTemplateId",
      "defaultPalletTemplateId",
      "defaultDuplicateTemplateId",
    ] as const) {
      expect(defaultsFailure(rejected(field))).toStrictEqual({
        kind: "field",
        key: field,
        message: "office.templateDefaults.errors.unfit",
      });
    }
    expect(defaultsFailure(rejected("expectedRev"))).toStrictEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(
      defaultsFailure(
        new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
      ),
    ).toStrictEqual({ kind: "stale" });
    expect(defaultsFailure(new Error("boom"))).toStrictEqual({
      kind: "alert",
      message: "errors.unknown",
    });
  });
});
```

2. В `apps/standalone/test/form-dialog.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("explains a stale write without a reload button when the form cannot reload", () => {
    render(<WriteFailureAlert failure={{ kind: "stale" }} />);
    expect(
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("says a stale write in the form's own words when the form names them", () => {
    const onReload = vi.fn();
    render(
      <WriteFailureAlert
        failure={{ kind: "stale" }}
        onReload={onReload}
        staleMessage="office.templateDefaults.stale"
      />,
    );
    expect(
      screen.getByText(
        "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Данные изменились, пока вы их редактировали. Обновите их и повторите."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("explains a stale write without a reload button when the form cannot reload", () => {
    render(<WriteFailureAlert failure={{ kind: "stale" }} />);
    expect(
```

3. Create `apps/standalone/test/template-defaults-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplateSummary, ProductGroup, TemplateDefaults } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 3, alias: "tobacco", name: "Альтернативная табачная продукция" },
];

/** A template summary: an enabled box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 2,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX = summary("7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c", "Коробка 58×40");
const BOX_100 = summary("8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d", "Коробка 100×100");
const MILK = summary("a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d", "Молоко 58×40", {
  stock: false,
  chzProductGroupCodes: [8],
});
const OLD = summary("9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e", "Старая коробка", {
  stock: false,
  enabled: false,
});
const PALLET = summary("0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f", "Паллета 100×150", {
  purpose: "pallet",
});
const PALLET_58 = summary("1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a", "Паллета 58×40", {
  purpose: "pallet",
});
const DUPLICATE = summary("2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b", "Дубликат [Полное]", {
  purpose: "product_duplicate",
});
const TEMPLATES = [BOX_100, BOX, DUPLICATE, MILK, OLD, PALLET, PALLET_58];

const DEFAULTS: TemplateDefaults = {
  defaultBoxTemplateId: BOX.id,
  defaultPalletTemplateId: PALLET.id,
  defaultDuplicateTemplateId: null,
  categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: MILK.id }],
  rev: 64,
};

function session(document: TemplateDefaults = DEFAULTS, user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.getTemplateDefaults.mockResolvedValue(document);
  fake.api.listTemplates.mockResolvedValue(TEMPLATES);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openDefaults(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
  await screen.findByRole("heading", { name: "Для организации" });
  await waitFor(() =>
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
  );
}

/** The labels a select offers, top to bottom. */
function choices(label: string): (string | null)[] {
  return within(screen.getByLabelText(label))
    .getAllByRole("option")
    .map((option) => option.textContent);
}

function choose(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

/** Two passes of the scheduler: an effect that would read again has run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const DIRTY = "Есть несохранённые изменения.";
const UNFIT = "Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.";

describe("office template defaults: the organization's", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» right after «Шаблоны», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      const menu = await screen.findByRole("navigation", { name: "Разделы офиса" });
      const items = within(menu)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
      const catalog = items.indexOf("Каталог");
      expect(items.slice(catalog, catalog + 4)).toEqual([
        "Каталог",
        "Товары",
        "Шаблоны",
        "Умолчания шаблонов",
      ]);
      view.unmount();
    }
  });

  it("offers for each purpose «Не выбран» and the enabled templates of that purpose for every category, by name, and holds the document's choice", async () => {
    await openDefaults(session());
    expect(screen.getByRole("heading", { name: "Умолчания шаблонов" })).toBeTruthy();
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Коробка 100×100"]);
    expect(choices("Шаблон паллеты")).toEqual(["Не выбран", "Паллета 58×40", "Паллета 100×150"]);
    expect(choices("Шаблон дубликата товара")).toEqual(["Не выбран", "Дубликат [Полное]"]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX.id);
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", PALLET.id);
    expect(screen.getByLabelText("Шаблон дубликата товара")).toHaveProperty("value", "");
    expect(screen.getAllByText("Только включённые шаблоны для всех категорий")).toHaveLength(3);
  });

  it("keeps a default the list does not offer as a marked choice: one that no longer fits, or one the list lacks", async () => {
    const gone = "6f0b3e1d-8a2c-4b4d-9e5f-0a1b2c3d4e5f";
    await openDefaults(
      session({ ...DEFAULTS, defaultBoxTemplateId: OLD.id, defaultDuplicateTemplateId: gone }),
    );
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Коробка 58×40",
      "Коробка 100×100",
      "Старая коробка — не подходит",
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", OLD.id);
    expect(choices("Шаблон дубликата товара")).toEqual([
      "Не выбран",
      "Дубликат [Полное]",
      "Шаблон 6f0b3e1d… — нет в списке",
    ]);
  });

  it("saves the whole document with the loaded revision: a changed default, a cleared one as null and the category defaults as they were; the answer then shows", async () => {
    const fake = session();
    const answer: TemplateDefaults = {
      ...DEFAULTS,
      defaultBoxTemplateId: BOX_100.id,
      defaultPalletTemplateId: null,
      rev: 70,
    };
    fake.api.updateTemplateDefaults.mockResolvedValue(answer);
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    const pallets = screen.getByLabelText("Шаблон паллеты");
    const none = within(pallets).getByRole("option", { name: "Не выбран" });
    expect(none).toHaveProperty("value", "");
    fireEvent.change(pallets, { target: { value: none.getAttribute("value") } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          defaultBoxTemplateId: BOX_100.id,
          defaultPalletTemplateId: null,
          defaultDuplicateTemplateId: null,
          categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: MILK.id }],
          expectedRev: 64,
        },
      ],
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX_100.id);
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(DIRTY)).toBeNull();
    await settle();
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(1);
  });

  it("says when there are unsaved changes, keeps «Сохранить» and «Отменить изменения» off without them, and «Отменить изменения» brings back the loaded document", async () => {
    await openDefaults(session());
    const save = screen.getByRole("button", { name: "Сохранить" });
    const cancel = screen.getByRole("button", { name: "Отменить изменения" });
    expect(save).toHaveProperty("disabled", true);
    expect(cancel).toHaveProperty("disabled", true);
    choose("Шаблон паллеты", PALLET_58.id);
    const note = screen.getByText(DIRTY);
    expect(note.getAttribute("aria-live")).toBe("polite");
    expect(save).toHaveProperty("disabled", false);
    expect(cancel).toHaveProperty("disabled", false);
    // Choosing the loaded template again is no change.
    choose("Шаблон паллеты", PALLET.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
    expect(save).toHaveProperty("disabled", true);
    choose("Шаблон дубликата товара", DUPLICATE.id);
    fireEvent.click(cancel);
    expect(screen.getByLabelText("Шаблон дубликата товара")).toHaveProperty("value", "");
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("puts a refused default under its select as a template that no longer fits, reads the templates again, and takes the message away once that choice changes", async () => {
    const fake = session();
    await openDefaults(fake);
    for (const [field, label] of [
      ["defaultBoxTemplateId", "Шаблон короба"],
      ["defaultPalletTemplateId", "Шаблон паллеты"],
      ["defaultDuplicateTemplateId", "Шаблон дубликата товара"],
    ] as const) {
      fake.api.updateTemplateDefaults.mockRejectedValueOnce(
        hostError("validation_failed", 400, { field }),
      );
      choose("Шаблон дубликата товара", DUPLICATE.id);
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      const message = await screen.findByText(UNFIT);
      expect(screen.getByLabelText(label).getAttribute("aria-describedby")).toBe(message.id);
      expect(screen.getAllByText(UNFIT)).toHaveLength(1);
    }
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(4));
    // Another select leaves the message; its own select takes it away.
    choose("Шаблон короба", BOX_100.id);
    expect(screen.getByText(UNFIT)).toBeTruthy();
    choose("Шаблон дубликата товара", "");
    expect(screen.queryByText(UNFIT)).toBeNull();
  });

  it("offers to load the defaults again after a stale save, saying the profile may have moved them; the reload drops the edits", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults.mockRejectedValue(
      hostError("stale_revision", 409, { currentRev: 66 }),
    );
    await openDefaults(fake);
    fake.api.getTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultPalletTemplateId: PALLET_58.id,
      rev: 66,
    });
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", PALLET_58.id),
    );
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Загрузить заново" })).toBeNull();
  });

  it("explains any other failure by its code, and a new save takes away both the failure and the notice of the last save", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults
      .mockResolvedValueOnce({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 })
      .mockRejectedValueOnce(hostError("internal", 500))
      .mockReturnValueOnce(
        new Promise<TemplateDefaults>((resolve) => {
          release = resolve;
        }),
      );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    choose("Шаблон паллеты", PALLET_58.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("На хосте произошла ошибка. Повторите попытку.")).toBeTruthy();
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull(),
    );
    await act(async () => {
      release({
        ...DEFAULTS,
        defaultBoxTemplateId: BOX_100.id,
        defaultPalletTemplateId: PALLET_58.id,
        rev: 66,
      });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults.mock.calls.map((call) => call[1].expectedRev)).toEqual([
      64, 65, 65,
    ]);
  });

  it("sends one request for a double click on «Сохранить»", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        release = resolve;
      }),
    );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    const save = screen.getByRole("button", { name: "Сохранить" });
    // Both clicks in one `act`: only the form's own guard drops the second.
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(save).toHaveProperty("disabled", true));
    expect(fake.api.updateTemplateDefaults).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults).toHaveBeenCalledTimes(1);
  });

  it("lets both office roles change the defaults", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(DEFAULTS, user));
      fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
      expect(await screen.findByRole("button", { name: "Сохранить" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Отменить изменения" })).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
      );
      view.unmount();
    }
  });

  it("reads the document and the templates again on every visit", async () => {
    const fake = session();
    await openDefaults(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await waitFor(() => expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Для организации" });
    // Once per visit: the form, which a new revision remounts, reads nothing itself.
    await settle();
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2);
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
  });

  it("explains a failed load of the document and loads it again", async () => {
    const fake = session();
    fake.api.getTemplateDefaults.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Для организации" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("heading", { name: "Для организации" })).toBeTruthy();
  });

  it("keeps the choices off while the templates do not load, says so, and reads them again", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    expect(
      await screen.findByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", true);
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Шаблон 7c1e4b2a…"]);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    expect(
      screen.queryByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/form-dialog.test.tsx test/template-defaults-page.test.tsx`
Expected: FAIL — `test/defaults-form.test.ts` не загружается (`Failed to resolve import "../src/office/templates/defaults-form.js"`); `Tests  14 failed | 12 passed (26)`: в `test/form-dialog.test.tsx` — `Unable to find an element with the text: Умолчания или профиль организации изменились…`, в `test/template-defaults-page.test.tsx` все 13 — `Unable to find role="link" and name "Умолчания шаблонов"`.

- [ ] **Step 3: Ключ, запрос, черновик, страница и меню**

1. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
  templates: ["office", "templates"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
} as const;

/**
```

2. В `apps/standalone/src/office/catalog-queries.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export function useTemplates() {
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
}
```

заменить на

<!-- prettier-ignore -->
```ts
export function useTemplates() {
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
}

/**
 * The templates' defaults (`GET /v1/office/template-defaults`): one document,
 * read again whenever the page opens (`staleTime` 0), since a change of the
 * organization's profile moves its revision too.
 */
export function useTemplateDefaults() {
  return useOfficeQuery(officeKeys.templateDefaults, (api, token) =>
    api.getTemplateDefaults(token),
  );
}
```

3. В `apps/standalone/src/office/page-state.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

export interface StaleAlertProps {
  onReload: () => void;
}

/** A write the host refused as stale: reloading shows the new data and drops this form's edits. */
export function StaleAlert({ onReload }: StaleAlertProps) {
  const { t } = useTranslation();
  return (
    <Alert
```

заменить на

<!-- prettier-ignore -->
```tsx

export interface StaleAlertProps {
  onReload: () => void;
  /** The i18n key of the text, when the form knows what else moves its revision. */
  message?: string;
}

/** A write the host refused as stale: reloading shows the new data and drops this form's edits. */
export function StaleAlert({ onReload, message = "errors.api.stale_revision" }: StaleAlertProps) {
  const { t } = useTranslation();
  return (
    <Alert
```

4. В `apps/standalone/src/office/page-state.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        </Button>
      }
    >
      {t("errors.api.stale_revision")}
    </Alert>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
        </Button>
      }
    >
      {t(message)}
    </Alert>
  );
}
```

5. В `apps/standalone/src/office/page-state.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  failure: AlertFailure | null;
  /** Loads the data again after a stale write; without it a stale write is only explained. */
  onReload?: () => void;
}

/** A failed write above a form: a stale one offers to reload when the form can, the rest are explained. */
export function WriteFailureAlert({ failure, onReload }: WriteFailureAlertProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  if (failure.kind === "stale" && onReload !== undefined) return <StaleAlert onReload={onReload} />;
  return <Alert tone="error">{t(failureMessage(failure))}</Alert>;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
  failure: AlertFailure | null;
  /** Loads the data again after a stale write; without it a stale write is only explained. */
  onReload?: () => void;
  /** The i18n key of the reload's text (`StaleAlert`'s `message`); the general one without it. */
  staleMessage?: string;
}

/** A failed write above a form: a stale one offers to reload when the form can, the rest are explained. */
export function WriteFailureAlert({ failure, onReload, staleMessage }: WriteFailureAlertProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  if (failure.kind === "stale" && onReload !== undefined) {
    return (
      <StaleAlert
        onReload={onReload}
        {...(staleMessage === undefined ? {} : { message: staleMessage })}
      />
    );
  }
  return <Alert tone="error">{t(failureMessage(failure))}</Alert>;
}
```

6. Create `apps/standalone/src/office/templates/defaults-form.ts`:

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import type {
  CategoryTemplateDefault,
  TemplateDefaults,
  TemplatePurpose,
} from "../../host/protocol.js";
import type { TemplateDefaultsInput } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";

/** The organization's three defaults: each one's field in the document and its slot's purpose. */
export const ORG_DEFAULTS = [
  { field: "defaultBoxTemplateId", purpose: "box" },
  { field: "defaultPalletTemplateId", purpose: "pallet" },
  { field: "defaultDuplicateTemplateId", purpose: "product_duplicate" },
] as const satisfies readonly { field: keyof TemplateDefaultsInput; purpose: TemplatePurpose }[];

export type OrgDefaultField = (typeof ORG_DEFAULTS)[number]["field"];

/**
 * The defaults as the page edits them: each organization default as its
 * select holds it (`""` for none) and every category default.
 */
export interface DefaultsDraft {
  defaultBoxTemplateId: string;
  defaultPalletTemplateId: string;
  defaultDuplicateTemplateId: string;
  categories: readonly CategoryTemplateDefault[];
}

/** The draft of a loaded document. */
export function draftOf(document: TemplateDefaults): DefaultsDraft {
  return {
    defaultBoxTemplateId: document.defaultBoxTemplateId ?? "",
    defaultPalletTemplateId: document.defaultPalletTemplateId ?? "",
    defaultDuplicateTemplateId: document.defaultDuplicateTemplateId ?? "",
    categories: document.categories,
  };
}

/** `draft` with one organization default chosen (`""` for none). */
export function withOrgDefault(
  draft: DefaultsDraft,
  field: OrgDefaultField,
  id: string,
): DefaultsDraft {
  switch (field) {
    case "defaultBoxTemplateId":
      return { ...draft, defaultBoxTemplateId: id };
    case "defaultPalletTemplateId":
      return { ...draft, defaultPalletTemplateId: id };
    case "defaultDuplicateTemplateId":
      return { ...draft, defaultDuplicateTemplateId: id };
  }
}

/** What `templateDefaultsUpdate` sends: `null` for an organization default left at «Не выбран». */
export function defaultsInput(draft: DefaultsDraft): TemplateDefaultsInput {
  const id = (value: string) => (value === "" ? null : value);
  return {
    defaultBoxTemplateId: id(draft.defaultBoxTemplateId),
    defaultPalletTemplateId: id(draft.defaultPalletTemplateId),
    defaultDuplicateTemplateId: id(draft.defaultDuplicateTemplateId),
    categories: draft.categories,
  };
}

/** A category default's slot, its category and purpose, as the feed keys it (`8:box`). */
export function slotKey(
  entry: Pick<CategoryTemplateDefault, "chzProductGroupCode" | "purpose">,
): string {
  return `${entry.chzProductGroupCode}:${entry.purpose}`;
}

/**
 * Whether two drafts hold the same defaults: the organization's three, and
 * the same template in the same category slots, in any order.
 */
export function sameDraft(a: DefaultsDraft, b: DefaultsDraft): boolean {
  return (
    a.defaultBoxTemplateId === b.defaultBoxTemplateId &&
    a.defaultPalletTemplateId === b.defaultPalletTemplateId &&
    a.defaultDuplicateTemplateId === b.defaultDuplicateTemplateId &&
    a.categories.length === b.categories.length &&
    a.categories.every((entry) =>
      b.categories.some(
        (other) => slotKey(other) === slotKey(entry) && other.templateId === entry.templateId,
      ),
    )
  );
}

/**
 * A refused save: under the organization default the host names (a template
 * that no longer fits its slot, or no longer exists; `key` is that default's
 * field), else a stale write or an alert (`alertFailure`). The host checks the
 * defaults before the revision, so a template disabled, narrowed or deleted
 * while the page was open is refused on its field, not as `stale_revision`.
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(error: unknown): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
  }
  return alertFailure(error);
}
```

7. Create `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, Select } from "@markiro/ui";

import type {
  LabelTemplateSummary,
  TemplateDefaults,
  TemplateDefaultsUpdate,
} from "../../host/protocol.js";
import { templateDefaultsUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useCan } from "../access.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import type { AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { templateOptions } from "../template-options.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  ORG_DEFAULTS,
  sameDraft,
  withOrgDefault,
  type OrgDefaultField,
} from "./defaults-form.js";

/**
 * The templates' defaults (spec §4.3, §5.5): one document, the organization's
 * default of each purpose and every category's, read whenever the page opens
 * and saved whole with the loaded revision. Both office roles change it.
 */
export function TemplateDefaultsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.templateDefaults.title")} />
      <TemplateDefaultsContent />
    </>
  );
}

function TemplateDefaultsContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaults = useTemplateDefaults();
  const templates = useTemplates();
  // The revision the last save produced; its notice stays until the document changes.
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (defaults.isPending) return <PageLoading />;
  if (defaults.isError) {
    return <LoadError error={defaults.error} onRetry={() => void defaults.refetch()} />;
  }

  return (
    <>
      {savedRev === defaults.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {templates.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void templates.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.templatesFailed")}
        </Alert>
      )}
      {/* A new revision — after a save or a reload — starts the form afresh. */}
      <TemplateDefaultsForm
        key={defaults.data.rev}
        document={defaults.data}
        templates={templates}
        onSaved={(saved) => {
          queryClient.setQueryData(officeKeys.templateDefaults, saved);
          setSavedRev(saved.rev);
        }}
        onSubmitStart={() => setSavedRev(null)}
        onReload={() => void defaults.refetch()}
      />
    </>
  );
}

interface TemplateDefaultsFormProps {
  /** The loaded document: its revision goes with the save. */
  document: TemplateDefaults;
  /**
   * The template list, read once per visit by the page: the form remounts on
   * every new revision, and a query of its own would read the list again each
   * time.
   */
  templates: UseQueryResult<LabelTemplateSummary[], Error>;
  onSaved: (document: TemplateDefaults) => void;
  onSubmitStart: () => void;
  /** The document changed on the host: load it again, which drops the edits. */
  onReload: () => void;
}

/**
 * The document as a form. An organization default offers «Не выбран» and the
 * enabled templates of its purpose for every category (`templateOptions` for
 * category `null`), and keeps a default the list does not offer as a marked
 * choice. Edits stay in the page until «Сохранить», which sends the whole
 * document (`templateDefaultsUpdate`) and drops a second click while the save
 * is on its way; «Отменить изменения» goes back to the loaded document.
 */
function TemplateDefaultsForm({
  document,
  templates,
  onSaved,
  onSubmitStart,
  onReload,
}: TemplateDefaultsFormProps) {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const loaded = draftOf(document);
  const [draft, setDraft] = useState(loaded);
  const [fieldError, setFieldError] = useState<{ key: string; message: string } | null>(null);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = useOfficeMutation((api, token, body: TemplateDefaultsUpdate) =>
    api.updateTemplateDefaults(token, body),
  );
  const dirty = !sameDraft(draft, loaded);

  const chooseOrg = (field: OrgDefaultField, id: string) => {
    setDraft((current) => withOrgDefault(current, field, id));
    if (fieldError?.key === field) setFieldError(null);
  };

  const cancel = () => {
    setDraft(loaded);
    setFieldError(null);
    setFailure(null);
  };

  const submit = async () => {
    onSubmitStart();
    setFailure(null);
    setFieldError(null);
    let saved: TemplateDefaults;
    try {
      saved = await save.mutateAsync(templateDefaultsUpdate(defaultsInput(draft), document.rev));
    } catch (error) {
      const outcome = defaultsFailure(error);
      if (outcome.kind === "field") {
        setFieldError({ key: outcome.key, message: outcome.message });
        // The refused template is marked in the choices once the list is read again.
        void templates.refetch();
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    void submit().finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
  };

  return (
    <form className="standalone-form" onSubmit={send} noValidate>
      <WriteFailureAlert
        failure={failure}
        onReload={onReload}
        staleMessage="office.templateDefaults.stale"
      />
      <Card title={t("office.templateDefaults.organization")} titleAs="h2">
        <div className="standalone-form">
          {ORG_DEFAULTS.map(({ field, purpose }) => (
            <Select
              key={field}
              native
              label={t(`office.templateDefaults.fields.${field}`)}
              hint={t("office.templateDefaults.orgHint")}
              options={templateOptions(
                templates.data,
                purpose,
                null,
                [loaded[field], draft[field]],
                t,
              )}
              value={draft[field]}
              onValueChange={(id) => chooseOrg(field, id)}
              disabled={!canEdit || !templates.isSuccess}
              {...errorProp(fieldError?.key === field ? t(fieldError.message) : undefined)}
            />
          ))}
        </div>
      </Card>
      {canEdit && (
        <div className="standalone-form__actions">
          <p className="office-note" aria-live="polite">
            {dirty ? t("office.templateDefaults.dirty") : ""}
          </p>
          <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
            {t("office.templateDefaults.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!dirty}>
            {t("office.common.save")}
          </Button>
        </div>
      )}
    </form>
  );
}
```

8. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/template-defaults",
    labelKey: "office.nav.templateDefaults",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
```

9. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";

```

заменить на

<!-- prettier-ignore -->
```tsx
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";

```

10. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      },
      { path: "products", element: <ProductsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      {
        path: "users",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
      },
      { path: "products", element: <ProductsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
        path: "users",
        element: (
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "devices": "Устройства",
      "products": "Товары",
      "templates": "Шаблоны",
      "users": "Пользователи"
    },
    "common": {
```

заменить на

<!-- prettier-ignore -->
```json
      "devices": "Устройства",
      "products": "Товары",
      "templates": "Шаблоны",
      "templateDefaults": "Умолчания шаблонов",
      "users": "Пользователи"
    },
    "common": {
```

12. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "hint": "Сначала выберите другой шаблон на странице «Умолчания шаблонов»."
      }
    },
    "categoryScope": {
      "label": "Категории",
      "all": "Все категории",
```

заменить на

<!-- prettier-ignore -->
```json
        "hint": "Сначала выберите другой шаблон на странице «Умолчания шаблонов»."
      }
    },
    "templateDefaults": {
      "title": "Умолчания шаблонов",
      "organization": "Для организации",
      "orgHint": "Только включённые шаблоны для всех категорий",
      "fields": {
        "defaultBoxTemplateId": "Шаблон короба",
        "defaultPalletTemplateId": "Шаблон паллеты",
        "defaultDuplicateTemplateId": "Шаблон дубликата товара"
      },
      "dirty": "Есть несохранённые изменения.",
      "cancel": "Отменить изменения",
      "stale": "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      "templatesFailed": "Список шаблонов не загрузился: умолчания сейчас не изменить.",
      "errors": {
        "unfit": "Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой."
      }
    },
    "categoryScope": {
      "label": "Категории",
      "all": "Все категории",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/form-dialog.test.tsx test/template-defaults-page.test.tsx`
Expected: PASS — 3 файла, 30 тестов (`defaults-form` 4, `form-dialog` 13, `template-defaults-page` 13).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/defaults-form.test.ts test/form-dialog.test.tsx test/template-defaults-page.test.tsx`
Expected: PASS, 30 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 30; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/defaults-form.ts` не слать умолчания категорий: фрагмент

<!-- prettier-ignore -->
```ts
    defaultDuplicateTemplateId: id(draft.defaultDuplicateTemplateId),
    categories: draft.categories,
```

заменить на

<!-- prettier-ignore -->
```ts
    defaultDuplicateTemplateId: id(draft.defaultDuplicateTemplateId),
    categories: [],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 15 passed (17)`: `expected { …(4) } to strictly equal { …(4) }`, `expected [ Array(1) ] to strictly equal [ Array(1) ]`.

Мутация 2. В `apps/standalone/src/office/templates/defaults-form.ts` слать `""` вместо `null`: фрагмент

<!-- prettier-ignore -->
```ts
const id = (value: string) => (value === "" ? null : value);
```

заменить на

<!-- prettier-ignore -->
```ts
const id = (value: string) => value;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 15 passed (17)`: `expected { …(4) } to strictly equal { …(4) }`, `expected [ Array(1) ] to strictly equal [ Array(1) ]`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` слать чужую ревизию: фрагмент

<!-- prettier-ignore -->
```tsx
templateDefaultsUpdate(defaultsInput(draft), document.rev)
```

заменить на

<!-- prettier-ignore -->
```tsx
templateDefaultsUpdate(defaultsInput(draft), document.rev + 1)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "loaded revision"`
Expected: FAIL — `expected [ Array(1) ] to strictly equal [ Array(1) ]`: запись ушла с другой ревизией.

Мутация 4. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` «Отменить изменения» не возвращает документ: фрагмент

<!-- prettier-ignore -->
```tsx
  const cancel = () => {
    setDraft(loaded);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const cancel = () => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "unsaved changes"`
Expected: FAIL — `expected <select …(4)>…(2)</select> to have property "value" with value ''`.

Мутация 5. В `apps/standalone/src/office/templates/defaults-form.ts` показывать полевой отказ предупреждением над формой: фрагмент

<!-- prettier-ignore -->
```ts
  if (org !== undefined) {
```

заменить на

<!-- prettier-ignore -->
```ts
  if (org !== undefined && path === "never") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 15 passed (17)`: `expected { kind: 'alert', …(1) } to strictly equal { kind: 'field', …(2) }`, `Unable to find an element with the text: Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.`

Мутация 6. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` не перечитывать шаблоны после полевого отказа: удалить фрагмент

<!-- prettier-ignore -->
```tsx
        void templates.refetch();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "refused default"`
Expected: FAIL — `expected "vi.fn()" to be called 4 times, but got 1 times`: после трёх отказов список шаблонов не перечитан.

Мутация 7. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` убирать сообщение при любом выборе: фрагмент

<!-- prettier-ignore -->
```tsx
    if (fieldError?.key === field) setFieldError(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
    setFieldError(null);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "refused default"`
Expected: FAIL — `Unable to find an element with the text: Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.`: выбор в другом поле убрал сообщение.

Мутация 8. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` говорить общим текстом устаревшей записи: удалить фрагмент

<!-- prettier-ignore -->
```tsx
        staleMessage="office.templateDefaults.stale"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "stale save"`
Expected: FAIL — `Unable to find an element with the text: Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.`

Мутация 9. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` снять страж второго щелчка: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    if (inFlight.current) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "double click"`
Expected: FAIL — `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 10. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` читать список шаблонов и в форме: фрагмент

<!-- prettier-ignore -->
```tsx
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
```

заменить на

<!-- prettier-ignore -->
```tsx
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  useTemplates();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "every visit"`
Expected: FAIL — `expected "vi.fn()" to be called 2 times, but got 3 times`: список шаблонов прочитан лишний раз.

Мутация 11. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` оставлять уведомление прошлого сохранения: фрагмент

<!-- prettier-ignore -->
```tsx
  const submit = async () => {
    onSubmitStart();
```

заменить на

<!-- prettier-ignore -->
```tsx
  const submit = async () => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "any other failure"`
Expected: FAIL — `expected <div …(1)></div> to be null`: уведомление прошлого сохранения видно во время нового.

Мутация 12. В `apps/standalone/src/office/page-state.tsx` `StaleAlert` не берёт переданный текст: фрагмент

<!-- prettier-ignore -->
```tsx
      {t(message)}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {t("errors.api.stale_revision")}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-dialog.test.tsx test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 24 passed (26)`, в обоих — `Unable to find an element with the text: Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.`

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
  (`useTemplateDefaults`, `staleTime` 0), with the template list, which the page
  reads once per visit and passes to the form, since the form remounts on every
  new revision. Both roles change it (`useCan("editCatalog")`), so there is no
  read-only view. The organization's three defaults are selects of «Не выбран»
  and the enabled templates of their purpose for every category
  (`templateOptions` with category `null`), by name; a default the list does not
  offer stays a marked choice («— не подходит», «— нет в списке»). Edits stay in
  the page: a live note says there are unsaved changes, «Отменить изменения»
  brings back the loaded document, and «Сохранить», off until something changed,
  sends the whole document with the loaded revision (`templateDefaultsUpdate`:
  `null` for «Не выбран», the category defaults as they are), drops a second
  click while the save is on its way and puts the answer in the cache, which
  starts the form afresh. A `validation_failed` on `defaultBoxTemplateId` or a
  sibling goes under that select as a template that no longer fits (disabled,
  narrowed or deleted while the page was open: the host checks the defaults
  before the revision), and the template list is read again so the choice shows
  as marked; a change of that select takes the message away. `stale_revision`
  offers «Загрузить заново» in words of its own, since a change of the
  organization's profile moves the document's revision too, and the reload drops
  the edits.

## Marking rules

```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
### 5.5. Офис

- Раскладка по образцу `apps/admin/src/layout/AppShell.tsx`: `Sidebar` из
  `@markiro/ui` с разделами «Организация» (профиль, SSCC, контрагенты), «Производство»
  (линии, операторы, устройства), «Каталог» (товары, шаблоны), «Доступ» (офисные
  пользователи); шапка с именем пользователя, переключателем темы, кнопками
  «Сменить пароль» и «Выйти в цех» (сессия закрывается сразу — решение владельца
  2026-09-26). Пункты скрываются по роли.
- Экраны переносятся из админки заменой слоя данных: каждый экран обращается к
  хосту только через `session.call` с методами `session.api` (`HostApi`,
  `src/host/api.ts`) — хуки `useOfficeQuery` и `useOfficeMutation`
```

заменить на

<!-- prettier-ignore -->
```text
### 5.5. Офис

- Раскладка по образцу `apps/admin/src/layout/AppShell.tsx`: `Sidebar` из
  `@markiro/ui` с разделами «Организация» (профиль, SSCC, контрагенты),
  «Производство» (линии, операторы, устройства), «Каталог» (товары, шаблоны,
  умолчания шаблонов), «Доступ» (офисные пользователи); шапка с именем пользователя,
  переключателем темы, кнопками «Сменить пароль» и «Выйти в цех» (сессия закрывается
  сразу — решение владельца 2026-09-26). Пункты скрываются по роли.
- Экраны переносятся из админки заменой слоя данных: каждый экран обращается к
  хосту только через `session.call` с методами `session.api` (`HostApi`,
  `src/host/api.ts`) — хуки `useOfficeQuery` и `useOfficeMutation`
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки и удаление — план 1e4: он
  переносит `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с
  растеризатором и проверкой покрытия шрифтов.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

заменить на

<!-- prettier-ignore -->
```text
  ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки и удаление — план 1e4: он
  переносит `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с
  растеризатором и проверкой покрытия шрифтов.
- Умолчания шаблонов (план 1e3): один документ
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
  организации каждого назначения — выбор из «Не выбран» и включённых шаблонов этого
  назначения для всех категорий, по названию; умолчание, которого список не
  предлагает, остаётся выбором с пометкой. Правки живут в экране: строка о
  несохранённых изменениях, «Отменить изменения» возвращает загруженный документ,
  «Сохранить» отправляет документ целиком с ревизией загруженного и второй раз его
  не шлёт. Отказ по умолчанию организации (шаблон выключили, сузили или удалили,
  пока экран был открыт) встаёт под его выбор, и список шаблонов перечитывается;
  `stale_revision` предлагает загрузить умолчания заново и говорит, что их ревизию
  двигает и правка профиля организации.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

Перечитать «Office pages» в `AGENTS.md` и §5.5 спецификации целиком (первый пункт — о разделах меню — тоже): «Умолчания шаблонов» описаны так, как их правит страница, без умолчаний категорий (задача 7).

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplateDefaultsPage.tsx apps/standalone/src/office/templates/defaults-form.ts apps/standalone/test/defaults-form.test.ts apps/standalone/test/form-dialog.test.tsx apps/standalone/test/template-defaults-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 47 файлов, 1030 тестов (1012 + 18).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplateDefaultsPage.tsx apps/standalone/src/office/templates/defaults-form.ts apps/standalone/test/defaults-form.test.ts apps/standalone/test/form-dialog.test.tsx apps/standalone/test/template-defaults-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Умолчания шаблонов» — умолчания организации" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: «Умолчания шаблонов» — умолчания категорий (D8)

Карточка «Для категорий»: строки только тех категорий, у которых умолчание есть (сетка 51×3 была бы непригодна), по названию категории, затем по назначению — сортировка при выводе, а страница хранит и шлёт свой порядок. В строке — название группы (код, если справочник не загрузился), назначение на категорийном теге, выбор шаблонов, подходящих этой категории и назначению, без «Не выбран» (умолчание категории снимает «Убрать»), и «Убрать». «Добавить умолчание категории» (выключена, пока не загрузились группы и шаблоны) открывает `CategoryDefaultDialog`: категория, у которой осталось назначение без умолчания, такое назначение, затем шаблон, подходящий обоим (`templateOptions`); новая категория начинает назначение и шаблон заново; пустые поля — ошибки под ними; если подходящего шаблона нет, окно так и говорит. Добавленная строка входит в документ страницы, а «Сохранить» шлёт его целиком.

Отказы по строкам (`validation_failed` на `categories.{i}.templateId`, `.chzProductGroupCode`, `categories.{i}`) хост называет номером в ПРИСЛАННОМ списке: `defaultsFailure(error, sent)` находит по нему слот (`slotKey`) и ставит текст под выбор шаблона этой строки — «Шаблон больше не подходит…», «Хост не принял эту категорию.», «Это умолчание задано дважды.»; после отказа список шаблонов перечитывается; смена шаблона этой строки или её удаление убирает сообщение, а изменения других строк — нет. `TemplateDefaultsPage.tsx` меняется во многих местах, поэтому шаг даёт его новое содержимое целиком.

**Files:**

- Create: `apps/standalone/src/office/templates/CategoryDefaultDialog.tsx`
- Modify: `apps/standalone/src/office/templates/defaults-form.ts`, `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` (целиком), `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/defaults-form.test.ts`, `apps/standalone/test/template-defaults-page.test.tsx` (Modify)
- Modify: `apps/standalone/AGENTS.md` («Office pages»), спецификация §5.5

**Interfaces:**

- Consumes:
  - `useProductGroups` — `catalog-queries.ts`; `groupName`, `PURPOSE_TONE`, `PURPOSES` — `template-text.ts`; `templateOptions` — `template-options.ts`; `templatePurposeSchema` — `src/host/protocol.ts`;
  - из задачи 6: `defaults-form.ts`, `TemplateDefaultsPage.tsx`, `FormDialog`.
- Produces:
  - `defaults-form.ts`: `withCategoryDefault(draft, entry)`, `withoutCategoryDefault(draft, slot)`, `freePurposes(categories, code)`, `defaultsFailure(error, sent = [])` с разбором `categories.{i}…`;
  - `CategoryDefaultDialog({ groups, templates, taken, onClose, onAdd })` — `src/office/templates/CategoryDefaultDialog.tsx`;
  - в `TemplateDefaultsPage`: карточка «Для категорий», `groups` в форме, `sent` при сохранении;
  - ключи `office.templateDefaults.{fields.category,fields.purpose,fields.template,categories,categoriesHint,empty,table.*,templateNamed,remove,removeNamed,add,addTitle,addSubmit,noCategory,noPurpose,noTemplateFits,groupsFailed}` и `errors.{category,twice,chooseCategory,choosePurpose,chooseTemplate}`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/defaults-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  defaultsFailure,
  defaultsInput,
  draftOf,
  sameDraft,
  slotKey,
  withOrgDefault,
} from "../src/office/templates/defaults-form.js";

const BOX = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
```

заменить на

<!-- prettier-ignore -->
```ts
  defaultsFailure,
  defaultsInput,
  draftOf,
  freePurposes,
  sameDraft,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withoutCategoryDefault,
} from "../src/office/templates/defaults-form.js";

const BOX = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
```

2. В `apps/standalone/test/defaults-form.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    });
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    });
  });
});

describe("the defaults form: category defaults", () => {
  const draft = draftOf(DOCUMENT);

  it("puts a category default in its slot in place, or adds it at the end, and removes one by its slot", () => {
    const changed = withCategoryDefault(draft, {
      chzProductGroupCode: 8,
      purpose: "box",
      templateId: WATER,
    });
    expect(changed.categories).toStrictEqual([
      { chzProductGroupCode: 8, purpose: "box", templateId: WATER },
      { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
    ]);
    const added = withCategoryDefault(draft, {
      chzProductGroupCode: 8,
      purpose: "pallet",
      templateId: BOX,
    });
    expect(added.categories).toStrictEqual([
      ...DOCUMENT.categories,
      { chzProductGroupCode: 8, purpose: "pallet", templateId: BOX },
    ]);
    expect(withoutCategoryDefault(draft, "13:box").categories).toStrictEqual([
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK },
    ]);
    expect(withoutCategoryDefault(draft, "13:pallet").categories).toStrictEqual(
      DOCUMENT.categories,
    );
    expect(draft.categories).toBe(DOCUMENT.categories);
  });

  it("offers the purposes a category has no default of yet, box, pallet, duplicate", () => {
    expect(freePurposes(DOCUMENT.categories, 8)).toStrictEqual(["pallet", "product_duplicate"]);
    expect(freePurposes(DOCUMENT.categories, 3)).toStrictEqual([
      "box",
      "pallet",
      "product_duplicate",
    ]);
    const full = [
      ...DOCUMENT.categories,
      { chzProductGroupCode: 8, purpose: "pallet", templateId: BOX },
      { chzProductGroupCode: 8, purpose: "product_duplicate", templateId: BOX },
    ] as const;
    expect(freePurposes(full, 8)).toStrictEqual([]);
  });

  it("puts a refusal of a category default under the default it names by its index in what was sent", () => {
    const sent = [
      { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
      { chzProductGroupCode: 3, purpose: "pallet", templateId: BOX },
    ] as const;
    expect(defaultsFailure(rejected("categories.1.templateId"), sent)).toStrictEqual({
      kind: "field",
      key: "3:pallet",
      message: "office.templateDefaults.errors.unfit",
    });
    expect(defaultsFailure(rejected("categories.0.chzProductGroupCode"), sent)).toStrictEqual({
      kind: "field",
      key: "13:box",
      message: "office.templateDefaults.errors.category",
    });
    expect(defaultsFailure(rejected("categories.1"), sent)).toStrictEqual({
      kind: "field",
      key: "3:pallet",
      message: "office.templateDefaults.errors.twice",
    });
    for (const field of [
      "categories.2.templateId",
      "categories.1.purpose",
      "categories.x",
      "xcategories.1",
      "categories.1.templateIdx",
    ]) {
      expect(defaultsFailure(rejected(field), sent), field).toStrictEqual({
        kind: "alert",
        message: "errors.api.validation_failed",
      });
    }
  });
});
```

3. В `apps/standalone/test/template-defaults-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    ).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    ).toBeNull();
  });
});

describe("office template defaults: the categories'", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /**
   * Four defaults of two categories, in an order unlike the one the page
   * shows; code 13 has all three purposes, so nothing is left to add for it.
   */
  const FULL_WATER: TemplateDefaults = {
    ...DEFAULTS,
    categories: [
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK.id },
      { chzProductGroupCode: 13, purpose: "pallet", templateId: PALLET.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ],
  };

  function rows(): (string | null)[][] {
    const table = within(screen.getByRole("region", { name: "Для категорий" }));
    return table
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 2)
          .map((cell) => cell.textContent),
      );
  }

  /** Opens «Добавить умолчание категории» and waits for its dialog. */
  function openAdd(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: "Добавить умолчание категории" }));
    return screen.getByRole("dialog", { name: "Умолчание категории" });
  }

  it("lists the category defaults by category name and purpose, each a choice of the templates that fit its category and purpose, with «Убрать»", async () => {
    await openDefaults(session(FULL_WATER));
    expect(screen.getByRole("heading", { name: "Для категорий" })).toBeTruthy();
    expect(
      screen.getByText("Станция возьмёт умолчание категории товара раньше умолчания организации."),
    ).toBeTruthy();
    expect(rows()).toEqual([
      ["Молочная продукция", "Короб"],
      ["Упакованная вода", "Короб"],
      ["Упакованная вода", "Паллета"],
      ["Упакованная вода", "Дубликат товара"],
    ]);
    // A category default always has a template: no «Не выбран» in its choice.
    expect(choices("Шаблон: Молочная продукция, Короб")).toEqual([
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    expect(screen.getByLabelText("Шаблон: Молочная продукция, Короб")).toHaveProperty(
      "value",
      MILK.id,
    );
    expect(choices("Шаблон: Упакованная вода, Короб")).toEqual([
      "Коробка 58×40",
      "Коробка 100×100",
    ]);
    expect(choices("Шаблон: Упакованная вода, Паллета")).toEqual([
      "Паллета 58×40",
      "Паллета 100×150",
    ]);
    expect(
      screen.getByRole("button", { name: "Убрать умолчание: Упакованная вода, Паллета" }),
    ).toBeTruthy();
    const purpose = within(screen.getByRole("region", { name: "Для категорий" })).getByText(
      "Дубликат товара",
    );
    expect(purpose.classList.contains("mk-badge--teal")).toBe(true);
  });

  it("says when there are no category defaults", async () => {
    await openDefaults(session({ ...DEFAULTS, categories: [] }));
    expect(screen.getByText("Умолчаний категорий нет.")).toBeTruthy();
  });

  it("changes a category default's template in its place and removes one; the save sends the categories as the page holds them", async () => {
    const fake = session(FULL_WATER);
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...FULL_WATER, rev: 70 });
    await openDefaults(fake);
    choose("Шаблон: Молочная продукция, Короб", BOX_100.id);
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Упакованная вода, Паллета" }),
    );
    expect(rows()).toHaveLength(3);
    expect(screen.getByText(DIRTY)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls[0]?.[1].categories).toStrictEqual([
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: BOX_100.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ]);
  });

  it("adds a category default: a category with a purpose left, a purpose it has no default of, then a template that fits both", async () => {
    const fake = session(FULL_WATER);
    const milkPallet = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", "Паллета молока", {
      purpose: "pallet",
      stock: false,
      chzProductGroupCodes: [8],
    });
    fake.api.listTemplates.mockResolvedValue([...TEMPLATES, milkPallet]);
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...FULL_WATER, rev: 70 });
    await openDefaults(fake);
    const add = openAdd();
    // «Упакованная вода» has a default of every purpose: it is not offered.
    expect(choices("Категория")).toEqual([
      "Не выбрана",
      "Альтернативная табачная продукция",
      "Молочная продукция",
    ]);
    expect(screen.getByLabelText("Назначение")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", true);
    choose("Категория", "8");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Паллета", "Дубликат товара"]);
    choose("Назначение", "pallet");
    // A template scoped to the category fits it too.
    expect(choices("Шаблон")).toEqual([
      "Не выбран",
      "Паллета 58×40",
      "Паллета 100×150",
      "Паллета молока",
    ]);
    choose("Шаблон", PALLET_58.id);
    // A new category starts the purpose and the template afresh.
    choose("Категория", "3");
    expect(screen.getByLabelText("Назначение")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("value", "");
    choose("Назначение", "box");
    choose("Шаблон", BOX_100.id);
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()[0]).toEqual(["Альтернативная табачная продукция", "Короб"]);
    expect(
      screen.getByLabelText("Шаблон: Альтернативная табачная продукция, Короб"),
    ).toHaveProperty("value", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls[0]?.[1].categories).toStrictEqual([
      ...FULL_WATER.categories,
      { chzProductGroupCode: 3, purpose: "box", templateId: BOX_100.id },
    ]);
  });

  it("asks for the category, the purpose and the template before adding, says when no template fits, and «Отмена» adds nothing", async () => {
    await openDefaults(session());
    const add = openAdd();
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    expect(await within(add).findByText("Выберите категорию")).toBeTruthy();
    expect(within(add).getByText("Выберите назначение")).toBeTruthy();
    expect(within(add).getByText("Выберите шаблон")).toBeTruthy();
    expect(screen.getByLabelText("Категория").getAttribute("aria-describedby")).toBe(
      within(add).getByText("Выберите категорию").id,
    );
    choose("Категория", "3");
    expect(within(add).queryByText("Выберите категорию")).toBeNull();
    choose("Назначение", "product_duplicate");
    expect(choices("Шаблон")).toEqual(["Не выбран", "Дубликат [Полное]"]);
    // A category and a purpose without a template is not enough either.
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    expect(await within(add).findByText("Выберите шаблон")).toBeTruthy();
    expect(within(add).queryByText("Выберите назначение")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Умолчание категории" })).toBeTruthy();
    expect(
      within(add).queryByText("Нет включённых шаблонов этого назначения для этой категории."),
    ).toBeNull();
    fireEvent.click(within(add).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()).toEqual([["Молочная продукция", "Короб"]]);
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("says when no template fits the category and purpose chosen", async () => {
    const fake = session();
    fake.api.listTemplates.mockResolvedValue(
      TEMPLATES.map((each) => (each.id === DUPLICATE.id ? { ...each, enabled: false } : each)),
    );
    await openDefaults(fake);
    const add = openAdd();
    choose("Категория", "3");
    choose("Назначение", "product_duplicate");
    expect(choices("Шаблон")).toEqual(["Не выбран"]);
    expect(
      within(add).getByText("Нет включённых шаблонов этого назначения для этой категории."),
    ).toBeTruthy();
  });

  it("puts a refused category default under its row, found by the order the page sent and not the order it shows, and takes the message away when that row changes", async () => {
    const fake = session();
    await openDefaults(fake);
    const add = openAdd();
    choose("Категория", "3");
    choose("Назначение", "box");
    choose("Шаблон", BOX_100.id);
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Sent: «Молочная продукция» first, then the added one; shown: the added one first.
    expect(rows()).toEqual([
      ["Альтернативная табачная продукция", "Короб"],
      ["Молочная продукция", "Короб"],
    ]);
    const added = "Шаблон: Альтернативная табачная продукция, Короб";
    for (const [field, message] of [
      ["categories.1.templateId", UNFIT],
      ["categories.1.chzProductGroupCode", "Хост не принял эту категорию."],
      ["categories.1", "Это умолчание задано дважды."],
    ] as const) {
      fake.api.updateTemplateDefaults.mockRejectedValueOnce(
        hostError("validation_failed", 400, { field }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      const shown = await screen.findByText(message);
      expect(screen.getByLabelText(added).getAttribute("aria-describedby")).toBe(shown.id);
      expect(
        screen.getByLabelText("Шаблон: Молочная продукция, Короб").hasAttribute("aria-describedby"),
      ).toBe(false);
    }
    choose(added, BOX.id);
    expect(screen.queryByText("Это умолчание задано дважды.")).toBeNull();
    fake.api.updateTemplateDefaults.mockRejectedValueOnce(
      hostError("validation_failed", 400, { field: "categories.0.templateId" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const shown = await screen.findByText(UNFIT);
    expect(
      screen.getByLabelText("Шаблон: Молочная продукция, Короб").getAttribute("aria-describedby"),
    ).toBe(shown.id);
    // Another row's change or removal leaves the message; its own row's removal takes it away.
    choose(added, BOX_100.id);
    expect(screen.getByText(UNFIT)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Убрать умолчание: Альтернативная табачная продукция, Короб",
      }),
    );
    expect(screen.getByText(UNFIT)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    );
    expect(screen.queryByText(UNFIT)).toBeNull();
  });

  it("names the categories by their codes while the groups do not load, keeps adding off, and reads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    await openDefaults(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: вместо названий категорий видны коды, а умолчание категории сейчас не добавить.",
      ),
    ).toBeTruthy();
    expect(rows()).toEqual([["Код 8", "Короб"]]);
    expect(screen.getByRole("button", { name: "Добавить умолчание категории" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(rows()).toEqual([["Молочная продукция", "Короб"]]));
    expect(screen.getByRole("button", { name: "Добавить умолчание категории" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("keeps «Добавить умолчание категории» off while the templates do not load", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await screen.findByText("Список шаблонов не загрузился: умолчания сейчас не изменить.");
    const add = screen.getByRole("button", { name: "Добавить умолчание категории" });
    expect(add).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — 2 файла, `Tests  12 failed | 17 passed (29)`: `TypeError: withCategoryDefault is not a function`, `TypeError: freePurposes is not a function`; отказ по строке пока разбирается как предупреждение над формой (`expected { kind: 'alert', …(1) } to strictly equal { Object (kind, key, ...) }`); страница — без карточки (`Unable to find an accessible element with the role "heading" and name "Для категорий"`, `Unable to find an element with the text: Умолчаний категорий нет.`).

- [ ] **Step 3: Помощники, окно добавления и карточка категорий**

1. Create `apps/standalone/src/office/templates/CategoryDefaultDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import {
  templatePurposeSchema,
  type CategoryTemplateDefault,
  type LabelTemplateSummary,
  type ProductGroup,
  type TemplatePurpose,
} from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { FormDialog } from "../FormDialog.js";
import { templateOptions } from "../template-options.js";
import { freePurposes } from "./defaults-form.js";

/** Group names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface CategoryDefaultDialogProps {
  groups: readonly ProductGroup[];
  templates: readonly LabelTemplateSummary[];
  /** The category defaults the page holds: a slot in use is not offered again. */
  taken: readonly CategoryTemplateDefault[];
  onClose: () => void;
  onAdd: (entry: CategoryTemplateDefault) => void;
}

/**
 * Adds a category default to the page's document, which «Сохранить» sends
 * later: a category that still has a purpose without a default, a purpose
 * that category has no default of yet, and a template that fits that
 * category and purpose (`templateOptions`). A new category starts the purpose
 * and the template afresh; a new purpose, the template.
 */
export function CategoryDefaultDialog({
  groups,
  templates,
  taken,
  onClose,
  onAdd,
}: CategoryDefaultDialogProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurpose | "">("");
  const [templateId, setTemplateId] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [purposeError, setPurposeError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const category = code === "" ? null : Number(code);
  const categories = groups
    .filter((group) => freePurposes(taken, group.code).length > 0)
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const purposes = category === null ? [] : freePurposes(taken, category);
  const choices =
    category === null || purpose === ""
      ? [{ value: "", label: t("office.templateChoice.none") }]
      : templateOptions(templates, purpose, category, [], t);

  // Nothing goes to the host here: the row joins the page's document.
  const submit = (): Promise<void> => {
    setCodeError(category === null ? "office.templateDefaults.errors.chooseCategory" : null);
    setPurposeError(purpose === "" ? "office.templateDefaults.errors.choosePurpose" : null);
    setTemplateError(templateId === "" ? "office.templateDefaults.errors.chooseTemplate" : null);
    if (category !== null && purpose !== "" && templateId !== "") {
      onAdd({ chzProductGroupCode: category, purpose, templateId });
    }
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateDefaults.addTitle")}
      submitLabel={t("office.templateDefaults.addSubmit")}
      onSubmit={submit}
      onClose={onClose}
    >
      <Select
        native
        label={t("office.templateDefaults.fields.category")}
        options={[
          { value: "", label: t("office.templateDefaults.noCategory") },
          ...categories.map((group) => ({ value: String(group.code), label: group.name })),
        ]}
        value={code}
        onValueChange={(next) => {
          setCode(next);
          setPurpose("");
          setTemplateId("");
          setCodeError(null);
          setPurposeError(null);
          setTemplateError(null);
        }}
        {...errorProp(codeError === null ? undefined : t(codeError))}
      />
      <Select
        native
        label={t("office.templateDefaults.fields.purpose")}
        options={[
          { value: "", label: t("office.templateDefaults.noPurpose") },
          ...purposes.map((each) => ({
            value: each,
            label: t(`office.templates.purposes.${each}`),
          })),
        ]}
        value={purpose}
        onValueChange={(next) => {
          const parsed = templatePurposeSchema.safeParse(next);
          setPurpose(parsed.success ? parsed.data : "");
          setTemplateId("");
          setPurposeError(null);
          setTemplateError(null);
        }}
        disabled={category === null}
        {...errorProp(purposeError === null ? undefined : t(purposeError))}
      />
      <Select
        native
        label={t("office.templateDefaults.fields.template")}
        options={choices}
        value={templateId}
        onValueChange={(next) => {
          setTemplateId(next);
          setTemplateError(null);
        }}
        disabled={purpose === ""}
        {...(purpose !== "" && choices.length === 1
          ? { hint: t("office.templateDefaults.noTemplateFits") }
          : {})}
        {...errorProp(templateError === null ? undefined : t(templateError))}
      />
    </FormDialog>
  );
}
```

2. В `apps/standalone/src/office/templates/defaults-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
} from "../../host/protocol.js";
import type { TemplateDefaultsInput } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";

/** The organization's three defaults: each one's field in the document and its slot's purpose. */
export const ORG_DEFAULTS = [
```

заменить на

<!-- prettier-ignore -->
```ts
} from "../../host/protocol.js";
import type { TemplateDefaultsInput } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { PURPOSES } from "./template-text.js";

/** The organization's three defaults: each one's field in the document and its slot's purpose. */
export const ORG_DEFAULTS = [
```

3. В `apps/standalone/src/office/templates/defaults-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return `${entry.chzProductGroupCode}:${entry.purpose}`;
}

/**
 * Whether two drafts hold the same defaults: the organization's three, and
 * the same template in the same category slots, in any order.
```

заменить на

<!-- prettier-ignore -->
```ts
  return `${entry.chzProductGroupCode}:${entry.purpose}`;
}

/** `draft` with `entry` in its slot: in place of the slot's default, or added at the end. */
export function withCategoryDefault(
  draft: DefaultsDraft,
  entry: CategoryTemplateDefault,
): DefaultsDraft {
  const slot = slotKey(entry);
  return {
    ...draft,
    categories: draft.categories.some((each) => slotKey(each) === slot)
      ? draft.categories.map((each) => (slotKey(each) === slot ? entry : each))
      : [...draft.categories, entry],
  };
}

/** `draft` without the category default of `slot`: saving it clears that default. */
export function withoutCategoryDefault(draft: DefaultsDraft, slot: string): DefaultsDraft {
  return { ...draft, categories: draft.categories.filter((each) => slotKey(each) !== slot) };
}

/** The purposes a category has no default of yet, in the order the office offers them. */
export function freePurposes(
  categories: readonly CategoryTemplateDefault[],
  code: number,
): TemplatePurpose[] {
  return PURPOSES.filter(
    (purpose) =>
      !categories.some((each) => each.chzProductGroupCode === code && each.purpose === purpose),
  );
}

/**
 * Whether two drafts hold the same defaults: the organization's three, and
 * the same template in the same category slots, in any order.
```

4. В `apps/standalone/src/office/templates/defaults-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  );
}

/**
 * A refused save: under the organization default the host names (a template
 * that no longer fits its slot, or no longer exists; `key` is that default's
 * field), else a stale write or an alert (`alertFailure`). The host checks the
 * defaults before the revision, so a template disabled, narrowed or deleted
 * while the page was open is refused on its field, not as `stale_revision`.
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(error: unknown): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
  }
  return alertFailure(error);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  );
}

/** `categories.{i}`, `categories.{i}.templateId` or `categories.{i}.chzProductGroupCode`. */
const CATEGORY_FIELD = /^categories\.(\d+)(?:\.(templateId|chzProductGroupCode))?$/;

/**
 * A refused save: under the organization default the host names, or under
 * the category default it names by its index in the categories the page sent
 * (`sent`, which keeps the page's own order, not the order it shows), else a
 * stale write or an alert (`alertFailure`). `key` is the organization
 * default's field or the category default's slot (`slotKey`). The host checks
 * the defaults before the revision, so a template disabled, narrowed or
 * deleted while the page was open is refused on its field, not as
 * `stale_revision`.
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(
  error: unknown,
  sent: readonly CategoryTemplateDefault[] = [],
): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
  }
  const category = path === null ? null : CATEGORY_FIELD.exec(path);
  const entry = category === null ? undefined : sent[Number(category[1])];
  if (category !== null && entry !== undefined) {
    const message =
      category[2] === "templateId"
        ? "office.templateDefaults.errors.unfit"
        : category[2] === "chzProductGroupCode"
          ? "office.templateDefaults.errors.category"
          : "office.templateDefaults.errors.twice";
    return { kind: "field", key: slotKey(entry), message };
  }
  return alertFailure(error);
}
```

5. Заменить содержимое `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` целиком:

<!-- prettier-ignore -->
```tsx
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type {
  CategoryTemplateDefault,
  LabelTemplateSummary,
  ProductGroup,
  TemplateDefaults,
  TemplateDefaultsUpdate,
} from "../../host/protocol.js";
import { templateDefaultsUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useCan } from "../access.js";
import { useProductGroups, useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import type { AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { templateOptions } from "../template-options.js";
import { CategoryDefaultDialog } from "./CategoryDefaultDialog.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  ORG_DEFAULTS,
  sameDraft,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withoutCategoryDefault,
  type OrgDefaultField,
} from "./defaults-form.js";
import { groupName, PURPOSE_TONE, PURPOSES } from "./template-text.js";

/** Category names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * The templates' defaults (spec §4.3, §5.5): one document, the organization's
 * default of each purpose and every category's, read whenever the page opens
 * and saved whole with the loaded revision. Both office roles change it.
 */
export function TemplateDefaultsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.templateDefaults.title")} />
      <TemplateDefaultsContent />
    </>
  );
}

function TemplateDefaultsContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaults = useTemplateDefaults();
  const templates = useTemplates();
  const groups = useProductGroups();
  // The revision the last save produced; its notice stays until the document changes.
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (defaults.isPending) return <PageLoading />;
  if (defaults.isError) {
    return <LoadError error={defaults.error} onRetry={() => void defaults.refetch()} />;
  }

  return (
    <>
      {savedRev === defaults.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {templates.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void templates.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.templatesFailed")}
        </Alert>
      )}
      {groups.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.groupsFailed")}
        </Alert>
      )}
      {/* A new revision — after a save or a reload — starts the form afresh. */}
      <TemplateDefaultsForm
        key={defaults.data.rev}
        document={defaults.data}
        templates={templates}
        groups={groups}
        onSaved={(saved) => {
          queryClient.setQueryData(officeKeys.templateDefaults, saved);
          setSavedRev(saved.rev);
        }}
        onSubmitStart={() => setSavedRev(null)}
        onReload={() => void defaults.refetch()}
      />
    </>
  );
}

interface TemplateDefaultsFormProps {
  /** The loaded document: its revision goes with the save. */
  document: TemplateDefaults;
  /**
   * The template list, read once per visit by the page: the form remounts on
   * every new revision, and a query of its own would read the list again each
   * time.
   */
  templates: UseQueryResult<LabelTemplateSummary[], Error>;
  /** The ЧЗ product groups, read by the page as the templates are. */
  groups: UseQueryResult<ProductGroup[], Error>;
  onSaved: (document: TemplateDefaults) => void;
  onSubmitStart: () => void;
  /** The document changed on the host: load it again, which drops the edits. */
  onReload: () => void;
}

/**
 * The document as a form. An organization default offers «Не выбран» and the
 * enabled templates of its purpose for every category (`templateOptions` for
 * category `null`), and keeps a default the list does not offer as a marked
 * choice. The category defaults are rows by category name, each a choice of
 * the templates that fit its category and purpose, removed with «Убрать» and
 * added in `CategoryDefaultDialog`. Edits stay in the page until «Сохранить»,
 * which sends the whole document (`templateDefaultsUpdate`) and drops a second
 * click while the save is on its way; «Отменить изменения» goes back to the
 * loaded document.
 */
function TemplateDefaultsForm({
  document,
  templates,
  groups,
  onSaved,
  onSubmitStart,
  onReload,
}: TemplateDefaultsFormProps) {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const loaded = draftOf(document);
  const [draft, setDraft] = useState(loaded);
  const [fieldError, setFieldError] = useState<{ key: string; message: string } | null>(null);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const [adding, setAdding] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = useOfficeMutation((api, token, body: TemplateDefaultsUpdate) =>
    api.updateTemplateDefaults(token, body),
  );
  const dirty = !sameDraft(draft, loaded);

  const chooseOrg = (field: OrgDefaultField, id: string) => {
    setDraft((current) => withOrgDefault(current, field, id));
    if (fieldError?.key === field) setFieldError(null);
  };

  const chooseCategory = (entry: CategoryTemplateDefault) => {
    setDraft((current) => withCategoryDefault(current, entry));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
  };

  const removeCategory = (entry: CategoryTemplateDefault) => {
    setDraft((current) => withoutCategoryDefault(current, slotKey(entry)));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
  };

  const cancel = () => {
    setDraft(loaded);
    setFieldError(null);
    setFailure(null);
  };

  const submit = async () => {
    onSubmitStart();
    setFailure(null);
    setFieldError(null);
    // The host names a category default by its index in what was sent.
    const sent = draft.categories;
    let saved: TemplateDefaults;
    try {
      saved = await save.mutateAsync(templateDefaultsUpdate(defaultsInput(draft), document.rev));
    } catch (error) {
      const outcome = defaultsFailure(error, sent);
      if (outcome.kind === "field") {
        setFieldError({ key: outcome.key, message: outcome.message });
        // The refused template is marked in the choices once the list is read again.
        void templates.refetch();
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    void submit().finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
  };

  const named = (entry: CategoryTemplateDefault) => ({
    category: groupName(groups.data, entry.chzProductGroupCode, t),
    purpose: t(`office.templates.purposes.${entry.purpose}`),
  });
  // The page's own order is the order sent; the table sorts what it shows.
  const rows = [...draft.categories].sort(
    (a, b) =>
      NAMES.compare(
        groupName(groups.data, a.chzProductGroupCode, t),
        groupName(groups.data, b.chzProductGroupCode, t),
      ) || PURPOSES.indexOf(a.purpose) - PURPOSES.indexOf(b.purpose),
  );
  const loadedTemplate = (entry: CategoryTemplateDefault) =>
    loaded.categories.find((each) => slotKey(each) === slotKey(entry))?.templateId ?? "";
  const columns: TableColumn<CategoryTemplateDefault>[] = [
    {
      key: "category",
      title: t("office.templateDefaults.table.category"),
      wrap: true,
      render: (entry) => groupName(groups.data, entry.chzProductGroupCode, t),
    },
    {
      key: "purpose",
      title: t("office.templateDefaults.table.purpose"),
      render: (entry) => (
        <Badge tone={PURPOSE_TONE[entry.purpose]}>
          {t(`office.templates.purposes.${entry.purpose}`)}
        </Badge>
      ),
    },
    {
      key: "template",
      title: t("office.templateDefaults.table.template"),
      render: (entry) => (
        <Select
          native
          aria-label={t("office.templateDefaults.templateNamed", named(entry))}
          // A category default always has a template: «Убрать» clears it, not «Не выбран».
          options={templateOptions(
            templates.data,
            entry.purpose,
            entry.chzProductGroupCode,
            [loadedTemplate(entry), entry.templateId],
            t,
          ).filter((option) => option.value !== "")}
          value={entry.templateId}
          onValueChange={(id) => chooseCategory({ ...entry, templateId: id })}
          disabled={!canEdit || !templates.isSuccess}
          {...errorProp(fieldError?.key === slotKey(entry) ? t(fieldError.message) : undefined)}
        />
      ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.templateDefaults.table.actions"),
      render: (entry) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.templateDefaults.removeNamed", named(entry))}
          onClick={() => removeCategory(entry)}
        >
          {t("office.templateDefaults.remove")}
        </Button>
      ),
    });
  }

  return (
    <>
      <form className="standalone-form" onSubmit={send} noValidate>
        <WriteFailureAlert
          failure={failure}
          onReload={onReload}
          staleMessage="office.templateDefaults.stale"
        />
        <Card title={t("office.templateDefaults.organization")} titleAs="h2">
          <div className="standalone-form">
            {ORG_DEFAULTS.map(({ field, purpose }) => (
              <Select
                key={field}
                native
                label={t(`office.templateDefaults.fields.${field}`)}
                hint={t("office.templateDefaults.orgHint")}
                options={templateOptions(
                  templates.data,
                  purpose,
                  null,
                  [loaded[field], draft[field]],
                  t,
                )}
                value={draft[field]}
                onValueChange={(id) => chooseOrg(field, id)}
                disabled={!canEdit || !templates.isSuccess}
                {...errorProp(fieldError?.key === field ? t(fieldError.message) : undefined)}
              />
            ))}
          </div>
        </Card>
        <Card
          title={t("office.templateDefaults.categories")}
          titleAs="h2"
          {...(canEdit
            ? {
                actions: (
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => setAdding(true)}
                    disabled={!groups.isSuccess || !templates.isSuccess}
                  >
                    {t("office.templateDefaults.add")}
                  </Button>
                ),
              }
            : {})}
        >
          <p className="office-note">{t("office.templateDefaults.categoriesHint")}</p>
          <Table
            columns={columns}
            rows={rows}
            getRowKey={slotKey}
            empty={t("office.templateDefaults.empty")}
            scrollLabel={t("office.templateDefaults.categories")}
          />
        </Card>
        {canEdit && (
          <div className="standalone-form__actions">
            <p className="office-note" aria-live="polite">
              {dirty ? t("office.templateDefaults.dirty") : ""}
            </p>
            <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
              {t("office.templateDefaults.cancel")}
            </Button>
            <Button type="submit" loading={saving} disabled={!dirty}>
              {t("office.common.save")}
            </Button>
          </div>
        )}
      </form>
      {/* Outside the page's form: a dialog has a form of its own. */}
      {canEdit && adding && groups.isSuccess && templates.isSuccess && (
        <CategoryDefaultDialog
          groups={groups.data}
          templates={templates.data}
          taken={draft.categories}
          onClose={() => setAdding(false)}
          onAdd={(entry) => {
            chooseCategory(entry);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "fields": {
        "defaultBoxTemplateId": "Шаблон короба",
        "defaultPalletTemplateId": "Шаблон паллеты",
        "defaultDuplicateTemplateId": "Шаблон дубликата товара"
      },
      "dirty": "Есть несохранённые изменения.",
      "cancel": "Отменить изменения",
      "stale": "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      "templatesFailed": "Список шаблонов не загрузился: умолчания сейчас не изменить.",
      "errors": {
        "unfit": "Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой."
      }
    },
    "categoryScope": {
```

заменить на

<!-- prettier-ignore -->
```json
      "fields": {
        "defaultBoxTemplateId": "Шаблон короба",
        "defaultPalletTemplateId": "Шаблон паллеты",
        "defaultDuplicateTemplateId": "Шаблон дубликата товара",
        "category": "Категория",
        "purpose": "Назначение",
        "template": "Шаблон"
      },
      "categories": "Для категорий",
      "categoriesHint": "Станция возьмёт умолчание категории товара раньше умолчания организации.",
      "empty": "Умолчаний категорий нет.",
      "table": {
        "category": "Категория",
        "purpose": "Назначение",
        "template": "Шаблон",
        "actions": "Действия"
      },
      "templateNamed": "Шаблон: {{category}}, {{purpose}}",
      "remove": "Убрать",
      "removeNamed": "Убрать умолчание: {{category}}, {{purpose}}",
      "add": "Добавить умолчание категории",
      "addTitle": "Умолчание категории",
      "addSubmit": "Добавить",
      "noCategory": "Не выбрана",
      "noPurpose": "Не выбрано",
      "noTemplateFits": "Нет включённых шаблонов этого назначения для этой категории.",
      "groupsFailed": "Справочник товарных групп не загрузился: вместо названий категорий видны коды, а умолчание категории сейчас не добавить.",
      "dirty": "Есть несохранённые изменения.",
      "cancel": "Отменить изменения",
      "stale": "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      "templatesFailed": "Список шаблонов не загрузился: умолчания сейчас не изменить.",
      "errors": {
        "unfit": "Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.",
        "category": "Хост не принял эту категорию.",
        "twice": "Это умолчание задано дважды.",
        "chooseCategory": "Выберите категорию",
        "choosePurpose": "Выберите назначение",
        "chooseTemplate": "Выберите шаблон"
      }
    },
    "categoryScope": {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: PASS — 2 файла, 29 тестов (`defaults-form` 7, `template-defaults-page` 22).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: PASS, 29 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 29; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` искать строку отказа в другом порядке: фрагмент

<!-- prettier-ignore -->
```tsx
    const sent = draft.categories;
```

заменить на

<!-- prettier-ignore -->
```tsx
    const sent = [...draft.categories].reverse();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "refused category default"`
Expected: FAIL — `expected null to be 'mk-select-…-error'`: сообщение встало не под ту строку.

Мутация 2. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` не передавать отправленный список: фрагмент

<!-- prettier-ignore -->
```tsx
const outcome = defaultsFailure(error, sent);
```

заменить на

<!-- prettier-ignore -->
```tsx
const outcome = defaultsFailure(error);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "refused category default"`
Expected: FAIL — `Unable to find an element with the text: Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.`: без отправленного списка отказ стал предупреждением над формой.

Мутация 3. В `apps/standalone/src/office/templates/defaults-form.ts` снять якорь конца с пути поля: фрагмент

<!-- prettier-ignore -->
```ts
(?:\.(templateId|chzProductGroupCode))?$/;
```

заменить на

<!-- prettier-ignore -->
```ts
(?:\.(templateId|chzProductGroupCode))?/;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts -t "index in what was sent"`
Expected: FAIL — `categories.1.purpose: expected { Object (kind, key, ...) } to strictly equal { kind: 'alert', …(1) }`.

Мутация 4. В `apps/standalone/src/office/templates/defaults-form.ts` искать свободные назначения без учёта категории: фрагмент

<!-- prettier-ignore -->
```ts
!categories.some((each) => each.chzProductGroupCode === code && each.purpose === purpose),
```

заменить на

<!-- prettier-ignore -->
```ts
!categories.some((each) => each.purpose === purpose),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  3 failed | 26 passed (29)`: `expected [ 'pallet', 'product_duplicate' ] to strictly equal [ Array(3) ]`, `expected [ 'Не выбрана' ] to deeply equal [ 'Не выбрана', …(2) ]`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` предлагать «Не выбран» в строке категории: фрагмент

<!-- prettier-ignore -->
```tsx
).filter((option) => option.value !== "")}
```

заменить на

<!-- prettier-ignore -->
```tsx
)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "lists the category defaults"`
Expected: FAIL — `expected [ 'Не выбран', 'Коробка 58×40', …(2) ] to deeply equal [ 'Коробка 58×40', …(2) ]`.

Мутация 6. В `apps/standalone/src/office/templates/defaults-form.ts` добавлять строку при смене шаблона: фрагмент

<!-- prettier-ignore -->
```ts
    categories: draft.categories.some((each) => slotKey(each) === slot)
      ? draft.categories.map((each) => (slotKey(each) === slot ? entry : each))
      : [...draft.categories, entry],
```

заменить на

<!-- prettier-ignore -->
```ts
    categories: [...draft.categories, entry],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/defaults-form.test.ts test/template-defaults-page.test.tsx`
Expected: FAIL — `Tests  3 failed | 26 passed (29)`: `expected [ …(3) ] to strictly equal [ …(2) ]`, `expected [ …(4) ] to have a length of 3 but got 4`, `Found multiple elements with the text of: Шаблон: Альтернативная табачная продукция, Короб`.

Мутация 7. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` выводить строки в порядке страницы: фрагмент

<!-- prettier-ignore -->
```tsx
            rows={rows}
```

заменить на

<!-- prettier-ignore -->
```tsx
            rows={[...draft.categories]}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "lists the category defaults"`
Expected: FAIL — `expected [ [ 'Упакованная вода', …(1) ], …(3) ] to deeply equal [ …(4) ]`.

Мутация 8. В `apps/standalone/src/office/templates/CategoryDefaultDialog.tsx` добавлять без шаблона: фрагмент

<!-- prettier-ignore -->
```tsx
if (category !== null && purpose !== "" && templateId !== "") {
```

заменить на

<!-- prettier-ignore -->
```tsx
if (category !== null && purpose !== "") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "asks for the category"`
Expected: FAIL — `Unable to find an element with the text: Выберите шаблон`: окно добавило умолчание без шаблона.

Мутация 9. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` убирать сообщение при смене любой строки: фрагмент

<!-- prettier-ignore -->
```tsx
    setDraft((current) => withCategoryDefault(current, entry));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
    setDraft((current) => withCategoryDefault(current, entry));
    setFieldError(null);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "refused category default"`
Expected: FAIL — `Unable to find an element with the text: Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.`: смена другой строки убрала сообщение.

Мутация 10. В `apps/standalone/src/office/templates/CategoryDefaultDialog.tsx` предлагать в окне шаблоны для всех категорий: фрагмент

<!-- prettier-ignore -->
```tsx
: templateOptions(templates, purpose, category, [], t);
```

заменить на

<!-- prettier-ignore -->
```tsx
: templateOptions(templates, purpose, null, [], t);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "adds a category default"`
Expected: FAIL — `expected [ 'Не выбран', 'Паллета 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Паллета 58×40', …(2) ]`: «Паллета молока», шаблон категории 8, не предложен.

Мутация 11. В `apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` включать добавление при незагруженных шаблонах: фрагмент

<!-- prettier-ignore -->
```tsx
disabled={!groups.isSuccess || !templates.isSuccess}
```

заменить на

<!-- prettier-ignore -->
```tsx
disabled={!groups.isSuccess}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-defaults-page.test.tsx -t "templates do not load"`
Expected: FAIL — `expected <button type="button" …(2)></button> to have property "disabled" with value true`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  words; a saved answer goes into the row in place.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
  (`useTemplateDefaults`, `staleTime` 0), with the template list, which the page
  reads once per visit and passes to the form, since the form remounts on every
  new revision. Both roles change it (`useCan("editCatalog")`), so there is no
  read-only view. The organization's three defaults are selects of «Не выбран»
  and the enabled templates of their purpose for every category
  (`templateOptions` with category `null`), by name; a default the list does not
  offer stays a marked choice («— не подходит», «— нет в списке»). Edits stay in
  the page: a live note says there are unsaved changes, «Отменить изменения»
  brings back the loaded document, and «Сохранить», off until something changed,
  sends the whole document with the loaded revision (`templateDefaultsUpdate`:
  `null` for «Не выбран», the category defaults as they are), drops a second
  click while the save is on its way and puts the answer in the cache, which
  starts the form afresh. A `validation_failed` on `defaultBoxTemplateId` or a
  sibling goes under that select as a template that no longer fits (disabled,
  narrowed or deleted while the page was open: the host checks the defaults
  before the revision), and the template list is read again so the choice shows
  as marked; a change of that select takes the message away. `stale_revision`
  offers «Загрузить заново» in words of its own, since a change of the
  organization's profile moves the document's revision too, and the reload drops
  the edits.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
  words; a saved answer goes into the row in place.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
  (`useTemplateDefaults`, `staleTime` 0), with the template list and the product
  groups, which the page reads once per visit and passes to the form, since the
  form remounts on every new revision. Both roles change it
  (`useCan("editCatalog")`), so there is no read-only view. The organization's
  three defaults are selects of «Не выбран» and the enabled templates of their
  purpose for every category (`templateOptions` with category `null`), by name;
  a default the list does not offer stays a marked choice («— не подходит», «—
  нет в списке»). The category defaults are rows by category name, then purpose
  (the page sorts what it shows and sends its own order): the group's name (its
  code where the lookup lacks it or did not load), the purpose on its tag and a
  select of the templates that fit that category and purpose, without «Не
  выбран», since «Убрать» clears a category default. «Добавить умолчание
  категории» (off while the groups or the templates do not load) asks for a
  category that still has a purpose without a default, a purpose that category
  has no default of yet and a template that fits both (`CategoryDefaultDialog`),
  and adds the row to the page's document. Edits stay in the page: a live note
  says there are unsaved changes, «Отменить изменения» brings back the loaded
  document, and «Сохранить», off until something changed, sends the whole
  document with the loaded revision (`templateDefaultsUpdate`: `null` for «Не
  выбран», every category default the page holds), drops a second click while
  the save is on its way and puts the answer in the cache, which starts the form
  afresh. A `validation_failed` goes under the control it names
  (`defaultsFailure`): an organization default's select, or the row of the
  category default the page sent at that index (`categories.{i}`, `.templateId`,
  `.chzProductGroupCode`), in words for each: a template that no longer fits
  (disabled, narrowed or deleted while the page was open: the host checks the
  defaults before the revision), a category the host did not take, a default
  given twice. The template list is then read again so a refused choice shows as
  marked, and a change of that control, or the removal of that row, takes the
  message away. `stale_revision` offers «Загрузить заново» in words of its own,
  since a change of the organization's profile moves the document's revision
  too, and the reload drops the edits.

## Marking rules

```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
  организации каждого назначения — выбор из «Не выбран» и включённых шаблонов этого
  назначения для всех категорий, по названию; умолчание, которого список не
  предлагает, остаётся выбором с пометкой. Правки живут в экране: строка о
  несохранённых изменениях, «Отменить изменения» возвращает загруженный документ,
  «Сохранить» отправляет документ целиком с ревизией загруженного и второй раз его
  не шлёт. Отказ по умолчанию организации (шаблон выключили, сузили или удалили,
  пока экран был открыт) встаёт под его выбор, и список шаблонов перечитывается;
  `stale_revision` предлагает загрузить умолчания заново и говорит, что их ревизию
  двигает и правка профиля организации.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

заменить на

<!-- prettier-ignore -->
```text
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
  организации каждого назначения — выбор из «Не выбран» и включённых шаблонов этого
  назначения для всех категорий, по названию; умолчание, которого список не
  предлагает, остаётся выбором с пометкой. Умолчания категорий — строки по названию
  категории (код, если справочника нет) и назначению: у каждой — выбор шаблонов,
  подходящих её категории и назначению, и «Убрать»; «Добавить умолчание категории»
  спрашивает категорию, у которой осталось назначение без умолчания, такое
  назначение и подходящий обоим шаблон, так что занятое место дважды не
  предлагается. Правки живут в экране: строка о несохранённых изменениях, «Отменить
  изменения» возвращает загруженный документ, «Сохранить» отправляет документ
  целиком с ревизией загруженного и второй раз его не шлёт. Отказ хоста по умолчанию
  (шаблон выключили, сузили или удалили, пока экран был открыт) встаёт под его выбор
  или строку — строку находит номер в отправленном списке, — и список шаблонов
  перечитывается; `stale_revision` предлагает загрузить умолчания заново и говорит,
  что их ревизию двигает и правка профиля организации.
- Устройства: список, переименование, линия, отзыв; диалог кода подключения с
  DataMatrix, кодом, отпечатком и адресами хоста для ручного ввода и таймером.
  Пока диалог открыт, список перечитывается каждые 3 с: подключение по коду не
```

Перечитать пункт «Умолчания шаблонов» в «Office pages» `AGENTS.md` и в §5.5 спецификации целиком: умолчания категорий, добавление и отказы по строкам описаны так, как их делает страница.

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/CategoryDefaultDialog.tsx apps/standalone/src/office/templates/TemplateDefaultsPage.tsx apps/standalone/src/office/templates/defaults-form.ts apps/standalone/test/defaults-form.test.ts apps/standalone/test/template-defaults-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 47 файлов, 1042 теста (1030 + 12).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/i18n/ru.json apps/standalone/src/office/templates/CategoryDefaultDialog.tsx apps/standalone/src/office/templates/TemplateDefaultsPage.tsx apps/standalone/src/office/templates/defaults-form.ts apps/standalone/test/defaults-form.test.ts apps/standalone/test/template-defaults-page.test.tsx docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Умолчания шаблонов» — умолчания категорий" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Сверка документов: 1e3 и 1e4

Задачи 1–7 описали то, что сделали сами. Остались места, которые ещё числят за планом 1e3 работу редактора или говорят об экранах шаблонов в будущем времени: итоговый абзац «Catalog and label templates» и первое предложение о сборщиках каталога в «Protocol» (`AGENTS.md`), пункт §5.5 о проверке макета `labelTemplateSpecSchema` и строка 1e таблицы §8 (спецификация), комментарий `templateSpecSchema` в `src/host/protocol.ts` (макет проверяет редактор плана 1e4). Задача правит их и прогоняет общие проверки; кода, кроме комментария, она не меняет.

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts` (комментарий), `apps/standalone/AGENTS.md` («Catalog and label templates», «Protocol»), спецификация §5.5 и §8

**Interfaces:**

- Consumes:
  - документы задач 1–7.
- Produces:
  - документы, где 1e3 — мастер, «Шаблоны» и «Умолчания шаблонов», а редактор, импорт, предпросмотр, выгрузки и удаление — план 1e4.

- [ ] **Step 1: Документы и комментарий**

1. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/**
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (plan 1e3)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
 * reason's paths (`AGENTS.md`, "Reference sync"); this check gives one
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (plan 1e4)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
 * reason's paths (`AGENTS.md`, "Reference sync"); this check gives one
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
(`test/protocol.test.ts` reads every fixture of plan 1e1,
`test/template-eligibility.test.ts` the slot rule's), the station's copies of
products, templates and category defaults («Reference sync», «Local
database») and the office's «Товары» page («Office pages»). The template
screens and the defaults screen come with plan 1e3, whose wizard already
sends the stock templates (above); the `HostApi` methods and the builders
they call are in place.

## Reference sync

```

заменить на

<!-- prettier-ignore -->
```text
(`test/protocol.test.ts` reads every fixture of plan 1e1,
`test/template-eligibility.test.ts` the slot rule's), the station's copies of
products, templates and category defaults («Reference sync», «Local
database») and the office's «Товары» page («Office pages»). Plan 1e3 added
the wizard's stock templates (above) and the office's «Шаблоны» and
«Умолчания шаблонов» pages («Office pages»), which call `listTemplates`,
`updateTemplate`, `getTemplateDefaults` and `updateTemplateDefaults`. The
template editor (creating, copying and renaming a template, importing
ZPL/TSPL/JSON, the size form, the preview, downloads and deleting) is plan
1e4's, with `getTemplate`, `createTemplate` and `deleteTemplate`, whose
methods and builders are in place.

## Reference sync

```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
body the webview has built since plan 1d3 has one builder in
`src/host/requests.ts`, which names every field it sends;
`test/protocol.test.ts` checks that each builder produces its fixture exactly.
The catalog's builders (plan 1e2) cover the template routes too, which only
plan 1e3's screens will call: `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateCreate` sends the name, the purpose,
the flag, the categories (`null` for every category) and the layout;
`templateUpdate` sends the name, the flag and the categories that differ from
```

заменить на

<!-- prettier-ignore -->
```text
body the webview has built since plan 1d3 has one builder in
`src/host/requests.ts`, which names every field it sends;
`test/protocol.test.ts` checks that each builder produces its fixture exactly.
The catalog's builders (plan 1e2) cover the template routes too, which plan
1e3's pages call (`templateUpdate` for a flag or categories,
`templateDefaultsUpdate`) and plan 1e4's editor will (`templateCreate`, a
layout through `templateUpdate`): `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateCreate` sends the name, the purpose,
the flag, the categories (`null` for every category) and the layout;
`templateUpdate` sends the name, the flag and the categories that differ from
```

4. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  `editCatalog` для каталога и шаблонов плана 1e), и страницы ниже показывают
  форму или только чтение по нему.
  Формы проверяют поля правилами `@markiro/domain` до отправки на хост
  (`normalizeToGtin14`; макет — `labelTemplateSpecSchema` в экранах шаблонов
  плана 1e3); `gtinMatchesPrefix` только подсказывает владельца GTIN и
  сохранению не мешает.
- Контрагенты (план 1d3): список видят все роли, меняет администратор. Правка
  отправляет запись целиком с `expectedRev`; архив — флажок «В архиве» в той же
```

заменить на

<!-- prettier-ignore -->
```text
  `editCatalog` для каталога и шаблонов плана 1e), и страницы ниже показывают
  форму или только чтение по нему.
  Формы проверяют поля правилами `@markiro/domain` до отправки на хост
  (`normalizeToGtin14`; макет — `labelTemplateSpecSchema` в редакторе шаблона
  плана 1e4); `gtinMatchesPrefix` только подсказывает владельца GTIN и
  сохранению не мешает.
- Контрагенты (план 1d3): список видят все роли, меняет администратор. Правка
  отправляет запись целиком с `expectedRev`; архив — флажок «В архиве» в той же
```

5. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
| 1b   | Подключение местной станции, мастер первого запуска, офисные пользователи, вход в офис и роли, организация и SSCC, журнал действий                                                                                                | На одном ПК проходит первый запуск и вход в офис                              | 1a         |
| 1c   | Коды подключения и `claim`, выбор линии, лента изменений и SSE, локальная база станции, синхронизация справочников, строка состояния связи                                                                                        | Второе устройство подключается и получает справочники                         | 1b         |
| 1d   | Экраны контрагентов, линий, операторов с PIN и бейджами, устройств                                                                                                                                                                | Справочники людей и устройств ведутся из офиса и доходят до станций           | 1c         |
| 1e   | Товарные группы, каталог, шаблоны (импорт, форма, предпросмотр, умолчания), типовые шаблоны в мастере; планы 1e1 (хост), 1e2 (каталог в офисе и копии станции), 1e3 (экраны шаблонов и мастер)                                    | Каталог и шаблоны ведутся из офиса и доходят до станций                       | 1c         |
| 1f   | Вход оператора по PIN и бейджу, блокировка, киоск-режим, заглушка цеха                                                                                                                                                            | Сценарий раздела 1 целиком                                                    | 1d         |

## 9. `apps/standalone/AGENTS.md` (создаётся в плане 1a)
```

заменить на

<!-- prettier-ignore -->
```text
| 1b   | Подключение местной станции, мастер первого запуска, офисные пользователи, вход в офис и роли, организация и SSCC, журнал действий                                                                                                | На одном ПК проходит первый запуск и вход в офис                              | 1a         |
| 1c   | Коды подключения и `claim`, выбор линии, лента изменений и SSE, локальная база станции, синхронизация справочников, строка состояния связи                                                                                        | Второе устройство подключается и получает справочники                         | 1b         |
| 1d   | Экраны контрагентов, линий, операторов с PIN и бейджами, устройств                                                                                                                                                                | Справочники людей и устройств ведутся из офиса и доходят до станций           | 1c         |
| 1e   | Товарные группы, каталог, шаблоны (импорт, форма, предпросмотр, умолчания), типовые шаблоны в мастере; планы 1e1 (хост), 1e2 (каталог в офисе и копии станции), 1e3 (мастер, список шаблонов, умолчания), 1e4 (редактор шаблона)  | Каталог и шаблоны ведутся из офиса и доходят до станций                       | 1c         |
| 1f   | Вход оператора по PIN и бейджу, блокировка, киоск-режим, заглушка цеха                                                                                                                                                            | Сценарий раздела 1 целиком                                                    | 1d         |

## 9. `apps/standalone/AGENTS.md` (создаётся в плане 1a)
```

Перечитать целиком в `AGENTS.md` разделы «Catalog and label templates», «Protocol» и «Office pages», в спецификации — §4.5 (абзац под таблицей), §5.5, §6 и §8: каждое изменённое предложение говорит, что делает код; работа плана 1e4 названа будущим временем или «план 1e4»; `grep -n '1e3' apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` находит 11 строк, и каждая говорит о мастере (его `templates` и `DefaultBodyLimit`), о «Шаблонах» и «Умолчаниях шаблонов» или о строке 1e таблицы §8; ни одна не числит за планом 1e3 редактор, импорт, предпросмотр или выгрузки.

- [ ] **Step 2: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/src/host/protocol.ts docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 47 файлов, 1042 теста (без изменений).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md apps/standalone/src/host/protocol.ts docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "docs(standalone): план 1e3 — сверка документов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 47 файлов, 1042 теста (до плана 40 и 958).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx test/template-text.test.ts test/template-list.test.ts test/template-options.test.ts test/products-page.test.tsx test/product-dialog.test.tsx test/templates-page.test.tsx test/category-scope-field.test.tsx test/defaults-form.test.ts test/form-dialog.test.tsx test/template-defaults-page.test.tsx`
Expected: PASS — 13 файлов, 217 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 217; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB (главный чанк вырос примерно на 34 kB: две страницы и их окна).

- [ ] **Step 2: Cargo**

Rust план не меняет (шаг 3 это проверяет), поэтому наборы Cargo не перезапускаются: 41 набор, 453 теста, как до плана. Оболочка встраивает сборку вебвью из шага 1 (`apps/standalone/dist`), поэтому проверка сборки идёт после неё.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: чисто, без предупреждений.

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check fe084bf23`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat fe084bf23 -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri`
Expected: пусто (D10).

---

## Перенесено

- План 1e4 (редактор шаблона):
  - создание, копия, переименование, импорт ZPL/TSPL/JSON, форма размеров, предпросмотр, выгрузки, удаление и подтверждение при несохранённых правках; методы `getTemplate`, `createTemplate`, `deleteTemplate` и сборщик `templateCreate` готовы с плана 1e2, макет через `templateUpdate` — тоже;
  - растеризатор и покрытие шрифтов; зависимость `opentype.js` 2.0.0 ставится через pnpm вне песочницы: дифф importer в `pnpm-lock.yaml`, `tools/dependency-baseline.json` и `pnpm check:deps`, выдержка release-age 7 дней;
  - шрифты предпросмотра и миниатюры в списке «Шаблоны» (сейчас таблица без миниатюр, D4);
  - редактор берёт `CategoryScopeField` (задача 5) и подсказку облака о категориях вне области шаблона (ЕГАИС);
  - отказ `not_found` (шаблон удалили на другом рабочем месте, пока страница открыта) окна «Шаблонов» и страница умолчаний показывают общим текстом без «Загрузить заново»; удаление приходит с планом 1e4, и с ним — перечитывание списка по этому отказу;
  - на странице умолчаний, когда не загрузились и шаблоны, и группы, видны два предупреждения, у каждого своя «Повторить» (на «Шаблонах» — одно, которое перечитывает оба); свести их — вместе с экранами 1e4;
  - случаи дубликата с категориями в `proto/fixtures/template-eligibility.json` — по-прежнему первому плану, который меняет `proto` (план 1e2, «Перенесено»).
- План 1f (вход оператора на станции офлайн): `hostGuard`, привязанный к подключению, до чтения копий — без изменений с плана 1e2.
- План 2a (смена на станции): выбор шаблона станцией (пожелание товара, затем умолчание категории, затем организации, затем выбор оператора) по копиям, которые план 1e3 даёт менять из офиса; снимок макета в смене; копия товарных групп на станции; защиты устаревших прогонов — как записано в плане 1e2. Окно выключения говорит, что станции получат изменение: копии они получают с плана 1e2, а выбирать по ним начнут с плана 2a.
- План 5: политика «строго или нестрого» и `MIN_PROTOCOL_VERSION`; отказ хоста по `templates.{i}.*` мастер показывает общим текстом над шагом «Проверка» (`wizardFieldFor` таких путей не знает): набор строит домен, поэтому такой отказ значит расхождение версий хоста и вебвью — дело политики протокола.
- Решения владельца ждут:
  - площадки, созданные до плана 1e3, остались без типовых шаблонов (их мастер `templates` не слал): засеять набор отдельной кнопкой или маршрутом хоста или оставить создание шаблонов редактору 1e4;
  - умолчание дубликата: мастер его не назначает (в облаке его нет), а страница умолчаний даёт выбрать;
  - шаблоны товара по умолчанию (в облаке их нет с 2026-09-02), потолки вместимостей, потеря введённого товара при отказе по удалённому шаблону в режиме добавления (план 1e2, D9);
  - маршрутизация CI `packages/db/migrations/**` в `standalone_rust`; уникальность контрагента (ИНН, GLN); знаки формата; политика версий протокола.
