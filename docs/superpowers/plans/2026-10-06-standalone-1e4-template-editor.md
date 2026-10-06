# План 1e4: приложение — редактор шаблона этикетки (1e4a полностью, 1e4b — схемой) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В офисе «Маркиро Автоном» появляется редактор шаблона этикетки: новый шаблон, копия (типовой шаблон меняется только копией), правка названия, признака, категорий и макета, импорт макета из ZPL, TSPL и JSON, форма размеров, выгрузка JSON и удаление с подтверждением. Редактор проверяет макет `labelTemplateSpecSchema` до записи, шлёт ревизию открытой записи и спрашивает, прежде чем уйти с несохранёнными правками. Это первая часть плана (1e4a, задачи 1–9). Вторая (1e4b: зависимость `opentype.js`, растеризатор, покрытие шрифтов, предпросмотр, выгрузки ZPL и TSPL, миниатюры в списке) дана в конце схемой с точным шагом зависимости: её задачи пишутся отдельным планом, когда зависимость поставлена.

**Architecture:**

- `src/office/templates/` — модель без экрана (`editor-model.ts`: имя, заготовки размеров, разбор размера, стартовые макеты, проверка макета, черновик и его изменение, имя файла выгрузки; `label-geometry.ts` и `label-samples.ts` — перенос облачных `geometry.ts` и `preview-data.ts`), импорт (`import-analysis.ts`, `ImportCodeDialog.tsx`, `ImportFieldsPanel.tsx`) и редактор (`TemplateEditor.tsx`, страницы `TemplateEditorPage.tsx`, окна `LabelSizeDialog.tsx` и `DeleteTemplateDialog.tsx`, отказы `editor-failure.ts`, выгрузка `download.ts`).
- Маршруты `/templates/new`, `/templates/:id` и `/templates/:id/copy` — страницы офиса без своего пункта меню. «Шаблоны» получают «Создать шаблон» и в строке «Изменить» (свой шаблон) или «Копировать» (типовой). Сохранение и удаление возвращают к списку с уведомлением и выбрасывают кэш списка: в сводках нет макетов.
- Хост, `proto`, оболочка, станция и `packages/*` не меняются; зависимостей в 1e4a не прибавляется.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, TanStack Query 5.101, react-router 8.3 (`createMemoryRouter`, `useBlocker`), i18next, `@markiro/ui` (`Card`, `Input`, `Select` с `native`, `Checkbox`, `Textarea`, `Alert`, `Button`, `PageHeader`), `@markiro/domain` (`labelTemplateSpecSchema`, `parseLabelCode`, `parseLabelJson`, `elementBoundsMm`, `sampleLabelData`, `assertDuplicateTemplate`, `buildDuplicateLabelTemplate`, `buildPalletLabelTemplates`, `labelTemplateUsesField`, `EGAIS_PRODUCT_GROUP_CODE`, `LABEL_FIELDS`), Vitest 4 с jsdom.

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1e4-design.md`: границы плана и решения D1–D9; очередь замечаний 1e3 — `.superpowers/sdd/1e3-minors.md`, итоговое ревью 1e3 — `.superpowers/sdd/1e3-final-review-report.md`.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §4.5 (маршруты шаблонов), §5.5 (офис), §6 (контракт), §8 (строка 1e).
- Планы 1e2 и 1e3 (`docs/superpowers/plans/2026-10-04-standalone-1e2-office-catalog-station-copies.md`, `docs/superpowers/plans/2026-10-05-standalone-1e3-templates-defaults-wizard.md`), их «Перенесено» (пункты для 1e4) и «Отклонения при исполнении».
- Облако (переносится своими модулями, не импортом): `apps/admin/src/pages/labels/editor/{index.tsx,useSpecState.ts,download.ts,import-analysis.ts,ImportCodeDialog.tsx,ImportFieldsPanel.tsx}`, `apps/admin/src/pages/labels/{geometry.ts,preview-data.ts,scope.ts,index.tsx}`; для 1e4b — `apps/admin/src/labels/{rasterizer.ts,fontCoverage.ts,opentype.d.ts}`, `apps/admin/src/pages/labels/{renderer.ts,TemplateThumb.tsx}`, `apps/admin/src/pages/labels/editor/{PreviewPane.tsx,raster-preview.ts}`.
- Хост: `apps/standalone/host/src/routes/templates.rs` (порядок проверок `POST`, `PUT`, `DELETE`), `host/src/validate.rs` (`template_name`, `template_spec`).

## Global Constraints

**Решения контроллера** (обязательные; владелец может их пересмотреть; уточнения планировщика помечены «Уточнение»)

- D1. Слой протокола готов с плана 1e2: `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`, сборщики `templateCreate` и `templateUpdate`. Хост держит макет объектом JSON (до 64 уровней, до 256 КБ) и никогда не проверяет его схемой: это делает редактор до записи. Уточнение: `checkedSpec` разбирает макет `labelTemplateSpecSchema`, и на хост уходит результат разбора (неизвестные ключи отброшены); макет, который схема не принимает, не уходит вовсе.
- D2. Кэш: `withTemplateChange` (план 1e3) годится только для записей, которые не трогают макет. Уточнение: после создания, правки и удаления в редакторе кэш списка выбрасывается (`removeQueries`, точный ключ `officeKeys.templates`), поэтому «Шаблоны» показывают загрузку, а не устаревшую строку, и читают список заново. Шаблон редактора читается под своим ключом `officeKeys.template(id)` при каждом открытии и показывается, только когда прочитан в это посещение (`isFetchedAfterMount`), поэтому ревизия записи — та, что на экране. Миниатюрам (1e4b) нужен кэш макета по паре «id, ревизия» (`staleTime: Infinity`, ревизия меняется с любой записью): схема — в части 1e4b.
- D3. Обе роли (`useCan("editCatalog")`), вида «только чтение» нет. Типовой шаблон можно выключить и сузить, но не переименовать, не менять макет и не удалить (правило хоста): его строка предлагает «Копировать», а адрес `/templates/:id` типового шаблона объясняет это и предлагает копию. Уточнение: удаление — в шапке редактора (`destructive-outline`), а не в строке: в строке остаётся не больше трёх кнопок.
- D4. Сетевых зависимостей нет. Предпросмотр и миниатюры (1e4b) рисуют текст уже вложенным в приложение шрифтом IBM Plex (`@fontsource/ibm-plex-*`), а проверка покрытия шрифта читает его файлы `.woff` из того же пакета (opentype.js 2.0.0 не читает `.woff2`), как облачный `fontCoverage.ts`.
- D5. Зависимость `opentype.js` 2.0.0 — только в части 1e4b, отдельной первой задачей, которую ставит владелец (или сессия с правом) через pnpm вне песочницы; точная команда и ожидаемый дифф — в «Части 1e4b». Уточнение: в 1e4a нет ни растеризатора, ни выгрузок ZPL и TSPL — `generateZpl` и `generateTspl` требуют `rasterizeText` для любого текста вне печатного ASCII, то есть для кириллицы; выгрузка JSON от растеризатора не зависит и приходит в 1e4a.
- D6. Подтверждение ухода с несохранёнными правками; `stale_revision` — «Загрузить заново» (правки пропадают); `conflict` и `validation_failed` — под полями; `not_found` — общим текстом (список перечитывается, когда «Шаблоны» открываются). Запись — по правилам форм репозитория (ниже, «Запись»).
- D7. Названия — только текстом React и атрибутами (`escapeValue: false`); каждый видимый текст — ключ `src/i18n/ru.json`; элементы — из `@markiro/ui`; доступность по правилам репозитория (подписи, фокус, не только цвет, `closeLabel`).
- D8. Копии станции, `proto`, хост и оболочка не меняются; случаи дубликата с категориями в `proto/fixtures/template-eligibility.json` остаются в «Перенесено». Правило, которого нет в домене, названо: `fitSpecElements` (подгонка элементов в пределы этикетки) живёт в облачном приложении, а не в `@markiro/domain` (решения планировщика ниже).
- D9. Объём: задачи 1–9 — 1e4a полностью; 1e4b — схема из пяти задач с точным шагом зависимости.

**Роли** (спецификация §4.8)

- Обе роли офиса читают и пишут шаблоны; права проверяет хост.

**Правила хоста, которые повторяет редактор** (`host/src/routes/templates.rs`, `host/src/validate.rs`)

- `POST /v1/office/templates`: название обрезается и должно быть 1–200 символов без управляющих (`validation_failed` на `name`), категории — `null` или 1–100 кодов без повторов из справочника (`chzProductGroupCodes`), макет — объект JSON до 256 КБ и 64 уровней (`spec`). Назначение даётся только здесь.
- `PUT /v1/office/templates/{id}`: те же проверки присланных полей и справочника групп, затем `not_found` (удалённый шаблон — тоже `not_found`: надгробие здесь не смотрится), затем `stale_revision` при чужом `expectedRev`, затем `stock_template` (у типового шаблона меняется название или макет), затем `template_is_default` (выключение или сужение, после которого умолчание перестаёт подходить слоту). Неизменная запись возвращается как есть.
- `DELETE /v1/office/templates/{id}` → 204; уже удалённый (надгробие стоит) — снова 204, никогда не существовавший — `not_found`; типовой — `conflict` на `stock_template`; умолчание — `template_is_default`. Удаление снимает ссылку на шаблон у товаров, которые его предпочитали.

**Тела запросов** (прежние сборщики `src/host/requests.ts`; новых нет)

- Создание — `templateCreate({ name, purpose, enabled, chzProductGroupCodes, spec })`: обрезанное название, коды по возрастанию (`scopeCodes`) или `null`, макет из `checkedSpec`.
- Правка — `templateUpdate(opened, { name, enabled, chzProductGroupCodes, spec })`: изменившиеся название, признак и категории и макет всегда, с `expectedRev` ОТКРЫТОЙ записи; запись никогда не повторяется с `details.currentRev`.
- Удаление — без тела.

**Запись** (уроки планов 1d3–1e3)

- В `try` — только ожидаемая запись; всё после успеха — после `try/catch`, каждый `catch` кончается `return`.
- Двойной щелчок — одна запись: в окнах её отсекает `FormDialog`, в редакторе — свой ref-страж `inFlight`; пока запись идёт, поля редактора выключены (`fieldset disabled`), чтобы правка в эти миллисекунды не потерялась. В тестах оба щелчка — в одном `act`.

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`; тексты даны в шагах целиком и переносятся буква в букву; кавычки — «ёлочки».
- Новые группы: `office.templateImport` и `office.labelFields` (задача 2), `office.templateEditor` с подгруппами `errors`, `sizeDialog`, `deleteDialog`, `leave` (задачи 3–7); ключи `office.templates.create`, `edit`, `editNamed`, `copy`, `copyNamed` (задачи 3, 5, 6). Прежние тексты не меняются, кроме `office.templateEditor.stockLocked`, который задача 6 дополняет копией.
- Число в тексте — переменная `n` или именованная, не `count`: с `count` i18next ищет формы множественного числа.

**Решения планировщика** (открытые места брифа)

- Подгонка элементов (`fitSpecElements`) и образцы данных назначения (`labelPreviewData`) живут в облачном приложении (`apps/admin/src/pages/labels/{geometry.ts,preview-data.ts}`), а не в домене. План переносит их своими модулями (`label-geometry.ts`, `label-samples.ts`), а не трогает `packages/domain`: бриф держит пакеты нетронутыми, а сами правила разметки (`elementBoundsMm`, схема, разборщики, правило дубликата) по-прежнему берутся из домена. Перенос `fitSpecElements` в `@markiro/domain` с переводом на него обоих приложений — вопрос владельцу (корневой `AGENTS.md` требует общие правила этикетки держать в домене).
- Форма размеров — окно (`LabelSizeDialog`: заготовка, ширина, высота, разрешение, «Применить»), а не поля в редакторе, которые облако подтверждает по уходу фокуса: окно проверяет поля как любая форма офиса и не держит черновиков на каждую ось. Размер набирается текстом (`inputMode="decimal"`) с запятой или точкой: `type="number"` в jsdom стирает «58,5», а в русской раскладке запятая — привычный разделитель. Ось, которую не трогали, сохраняет точное значение (у импорта ширина может быть 58,0571… мм, а поле показывает «58,06»).
- Редактор — страница, а не окно; окна импорта, размеров, удаления и ухода — вне формы страницы (вложенных форм нет). Сохранение и удаление возвращают к «Шаблонам» с уведомлением в состоянии перехода (облако остаётся в редакторе): список сразу показывает результат, а редактор не держит состояния «после сохранения».
- Новый шаблон начинается без названия: название вводят или его приносит импорт JSON `{ name, purpose, spec }` — только пока поле пустое. У новой пустой заготовки смена назначения меняет стартовый макет (короб — пустая 58×40, дубликат — дубликат домена, паллета — типовая 100×150), но только пока макет не тронут; копия держит свой макет при любом назначении (облако меняет макет и после импорта).
- Имя файла выгрузки сохраняет кириллицу (`[^\p{L}\p{N}_-]+` → «-»), иначе каждый шаблон русской площадки скачивался бы как «label».
- «Сохранить» при правке выключена, пока ничего не изменилось (как на странице умолчаний); у нового шаблона и копии включена всегда.
- Отказ `not_found` в окнах «Шаблонов» (шаблон удалили на другом рабочем месте) — пункт «Перенесено» 1e3: окно говорит об этом, остаётся открытым и перечитывает список под собой. Общий порядок «по названию, затем по id» (`byNameThenId`, пункт 4 очереди 1e3) — в задаче 8; общая нормализация поиска (пункт 8) поведения не меняет и остаётся в «Перенесено».
- `FormDialog` получает необязательную ширину (окно импорта — 1040 px), `TemplateFailureAlert` — необязательный `onReload` (у нового шаблона устаревшей записи не бывает).
- Документы — одной последней задачей 1e4a (задача 9): задачи 1–8 меняют только код и тесты.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля в `src/`); каждое окно — `FormDialog` (в нём `closeLabel`); состояние словами, не одним цветом; где результат меняется без перехода — `aria-live`.
- Новых зависимостей в 1e4a нет. `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto` и `apps/standalone/src-tauri` не меняются; Rust не меняется, набор Cargo остаётся 41 набор, 453 теста.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам). Правки внутри шага идут сверху вниз по файлу, одна за другой. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке; «Заменить содержимое … целиком» — файл становится ровно таким, как в блоке; «удалить фрагмент» (только в мутациях) — фрагмент убирается.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным сообщением; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Каталог `/tmp/claude` один внутри и вне песочницы (`$TMPDIR` у них разный).

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать (единственное исключение — шаг зависимости части 1e4b, который выполняет владелец вне песочницы). Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`. Редактор регистрирует блокировщик ухода (`useBlocker`) в эффекте, поэтому тесты, открыв страницу редактора, делают `settle()` — два хода `await new Promise((resolve) => setImmediate(resolve))` — и только потом её трогают. Два щелчка, которые должны быть одновременными, — в одном `act`.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`), поэтому опечатка в ключе роняет тест, а не показывает ключ.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс: он делает флейк эффекта постоянным. Стенд — два временных файла внутри пакета (из `/tmp` Vite не грузит); запустить и сразу удалить, до `lint`:

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

- Нагрузка. Самый долгий тест редактора идёт около 1,1 с, когда файл запускается один. При проверке плана полный набор под внешней нагрузкой (средняя загрузка около 40) однажды уронил по таймауту 5 с пять тестов трёх файлов, в том числе два прежних (`templates-page`, `template-defaults-page`); повтор на той же машине прошёл дважды. Если тест падает только в полном прогоне, записать это в отчёт и повторить при обычной загрузке; таймауты не поднимать и утверждения не ослаблять (корневой `AGENTS.md`).

**Счёт тестов**

- До плана: Vitest — 47 файлов, 1113 тестов; cargo — 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107). Каждое «Expected» ниже измерено на копии репозитория с тестами самого плана; расхождение значит, что шаг применён не так (а тесты, которые исполнитель добавит сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку.

<!-- prettier-ignore -->
```text
apps/standalone/src/office/templates/{label-samples,label-geometry,editor-model}.ts            задача 1
apps/standalone/test/{label-geometry,editor-model}.test.ts                                     задача 1
apps/standalone/src/office/templates/{import-analysis.ts,ImportFieldsPanel.tsx,ImportCodeDialog.tsx}  задача 2
apps/standalone/src/office/FormDialog.tsx (ширина)                                             задача 2
apps/standalone/test/{import-analysis.test.ts,import-code-dialog.test.tsx}                     задача 2
apps/standalone/src/office/templates/{download,editor-failure}.ts                              задачи 3, 6
apps/standalone/src/office/templates/{TemplateEditor,TemplateEditorPage}.tsx                   задачи 3–7
apps/standalone/src/office/templates/TemplateFailureAlert.tsx (onReload необязателен)         задача 3
apps/standalone/src/office/templates/TemplatesPage.tsx                                         задачи 3, 5, 6, 8, 9
apps/standalone/src/office/routes.tsx                                                          задачи 3, 5, 6
apps/standalone/test/{editor-failure.test.ts,template-editor.test.tsx}                         задачи 3–7
apps/standalone/test/templates-page.test.tsx                                                   задачи 3, 5, 6, 8
apps/standalone/src/office/templates/LabelSizeDialog.tsx                                       задача 4
apps/standalone/src/office/office-query.ts (officeKeys.template)                              задача 5
apps/standalone/src/office/templates/DeleteTemplateDialog.tsx                                  задача 6
apps/standalone/src/office/{records.tsx,template-options.ts}                                   задача 8
apps/standalone/src/office/templates/{template-list,template-text}.ts                          задача 8
apps/standalone/src/office/templates/{TemplateStateDialog,TemplateCategoriesDialog}.tsx        задача 8
apps/standalone/test/{template-options,template-text}.test.ts                                  задача 8
apps/standalone/src/i18n/ru.json                                                               задачи 2–7
apps/standalone/src/app/shell.css                                                              задачи 2–4
apps/standalone/src/host/protocol.ts, src/office/templates/CategoryScopeField.tsx (комментарии)  задача 9
apps/standalone/AGENTS.md, спецификация §5.5                                                   задача 9
```

Модель (задача 1) и импорт (задача 2) не зависят от экранов и идут первыми, каждая со своими тестами. Редактор приходит новым шаблоном (задача 3: страница, название, назначение, признак, категории, импорт, выгрузка JSON, создание), затем формой размеров (задача 4), правкой существующего шаблона (задача 5), копией и удалением (задача 6) и подтверждением ухода (задача 7); на каждом коммите у каждой кнопки есть дело. Задача 8 — хвосты списка «Шаблоны» из очереди 1e3, задача 9 — документы. Часть 1e4b — после «Итоговой проверки плана».

---

### Task 1: Модель редактора без экрана: подгонка элементов, образцы назначения, размеры и проверка макета (D1, D8)

Редактору нужны правила, которые не зависят от экрана и проверяются сами. Подгонка элементов в пределы этикетки и образцы данных каждого назначения живут в облаке в приложении (`apps/admin/src/pages/labels/geometry.ts`, `preview-data.ts`), а не в домене, поэтому план переносит их своими модулями: `label-geometry.ts` (`fitElementWithinLabel`, `fitSpecElements` — элемент, свисающий за край, сдвигается обратно; элемент больше этикетки отвергается вместе со всем макетом) и `label-samples.ts` (`labelSampleData`, `labelRenderOptions` — дубликат меряется со своим синтетическим кодом и рисует код растром, паллета — со своим SSCC). Измерение элемента (`elementBoundsMm`), схема и правило дубликата берутся из домена.

`editor-model.ts` собирает остальное: правило названия (`templateNameRule`, 1–200 символов, как `validate::template_name`), стартовый макет назначения (`startingSpec`), заготовки размеров и их узнавание (`SIZE_PRESETS`, `presetOf`), разбор набранного размера с запятой или точкой в пределах 10–300 мм (`parseSizeMm`), разрешения (`DPI_CHOICES`, `toDpi`), чтение сохранённого макета (`readSpec`) и макет для записи (`checkedSpec`: результат разбора `labelTemplateSpecSchema`, D1), новый размер с подгонкой (`resizedSpec`), правило дубликата (`duplicateLayoutInvalid`), подсказку облака про поле ЕГАИС (`egaisOutsideScope`), черновик и его изменение (`TemplateDraft`, `draftChanged`: порядок кодов и коды под «Все категории» изменением не считаются) и выгрузку JSON (`templateJson`, `templateFileName` с кириллицей). Экранов в задаче нет.

**Files:**

- Create: `apps/standalone/src/office/templates/label-samples.ts`, `apps/standalone/src/office/templates/label-geometry.ts`, `apps/standalone/src/office/templates/editor-model.ts`
- Test: `apps/standalone/test/label-geometry.test.ts`, `apps/standalone/test/editor-model.test.ts` (Create)

**Interfaces:**

- Consumes: `elementBoundsMm`, `sampleLabelData`, `labelTemplateSpecSchema`, `assertDuplicateTemplate`, `buildDuplicateLabelTemplate`, `buildPalletLabelTemplates`, `labelTemplateUsesField`, `EGAIS_PRODUCT_GROUP_CODE`, `DomainError`, `type LabelElement`, `type LabelField`, `type LabelTemplateSpec`, `type PrinterDpi` — `@markiro/domain`; `plainTextRule` — `src/lib/rules.ts`; `sameCategories`, `scopeCodes`, `type CategoryScope` — `src/office/templates/category-scope.ts`; `type TemplatePurpose`, `type TemplateSpec` — `src/host/protocol.ts`.
- Produces:
  - `label-samples.ts`: `interface LabelRenderOptions { kmDataMatrix?: "native" | "raster" }`, `labelSampleData(purpose): Record<LabelField, string>`, `labelRenderOptions(purpose): LabelRenderOptions`;
  - `label-geometry.ts`: `fitElementWithinLabel(element, spec, data, options): ElementFit`, `fitSpecElements(spec, data, options): { ok: false } | { ok: true; spec; adjustedIds: string[] }`;
  - `editor-model.ts`: `MAX_TEMPLATE_NAME = 200`, `templateNameRule`, `BLANK_SPEC`, `startingSpec(purpose)`, `SIZE_PRESETS`, `type SizePresetKey`, `presetOf(widthMm, heightMm): SizePresetKey | null`, `MIN_SIZE_MM = 10`, `MAX_SIZE_MM = 300`, `parseSizeMm(text): number | null`, `DPI_CHOICES`, `toDpi(value): PrinterDpi`, `readSpec(spec: TemplateSpec): LabelTemplateSpec | null`, `checkedSpec(spec: LabelTemplateSpec): TemplateSpec | null`, `resizedSpec(spec, widthMm, heightMm, purpose): LabelTemplateSpec | null`, `duplicateLayoutInvalid(spec, purpose): boolean`, `egaisOutsideScope(spec, scope): boolean`, `interface TemplateDraft { name; purpose; enabled; scope; spec }`, `draftChanged(opened, draft): boolean`, `templateJson(name, purpose, spec): string`, `templateFileName(name): string`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/label-geometry.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { sampleLabelData, type LabelElement, type LabelTemplateSpec } from "@markiro/domain";

import { fitElementWithinLabel, fitSpecElements } from "../src/office/templates/label-geometry.js";

const DATA = sampleLabelData();

/** A 20 × 10 mm box: its bounds are its own size. */
function box(id: string, xMm: number, yMm: number): LabelElement {
  return { kind: "box", id, xMm, yMm, widthMm: 20, heightMm: 10, thicknessMm: 0.5 };
}

function spec(elements: LabelElement[], widthMm = 58, heightMm = 40): LabelTemplateSpec {
  return { widthMm, heightMm, dpi: 203, language: "zpl", elements };
}

describe("fitting a layout inside its label", () => {
  it("leaves an element that fits where it is", () => {
    const element = box("a", 2, 3);
    expect(fitElementWithinLabel(element, spec([]), DATA, {})).toStrictEqual({
      ok: true,
      element,
      adjusted: false,
    });
  });

  it("slides an element back over the edges it hangs across", () => {
    expect(fitElementWithinLabel(box("a", 50, -4), spec([]), DATA, {})).toStrictEqual({
      ok: true,
      element: box("a", 38, 0),
      adjusted: true,
    });
  });

  it("moves both ends of a line by the same amount", () => {
    const line: LabelElement = {
      kind: "line",
      id: "l",
      xMm: 50,
      yMm: 5,
      x2Mm: 70,
      y2Mm: 5,
      thicknessMm: 0.5,
    };
    const fit = fitElementWithinLabel(line, spec([]), DATA, {});
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.element).toMatchObject({ xMm: 38, x2Mm: 58, yMm: 5, y2Mm: 5 });
  });

  it("refuses an element larger than the label instead of shrinking it", () => {
    expect(fitElementWithinLabel(box("a", 0, 0), spec([], 15, 40), DATA, {})).toStrictEqual({
      ok: false,
    });
  });

  it("fits a whole layout and names the elements it moved", () => {
    expect(fitSpecElements(spec([box("a", 2, 3), box("b", 45, 35)]), DATA, {})).toStrictEqual({
      ok: true,
      spec: spec([box("a", 2, 3), box("b", 38, 30)]),
      adjustedIds: ["b"],
    });
  });

  it("refuses the whole layout when one element does not fit", () => {
    expect(fitSpecElements(spec([box("a", 2, 3), box("b", 0, 0)], 58, 8), DATA, {})).toStrictEqual({
      ok: false,
    });
  });
});
```

2. Создать `apps/standalone/test/editor-model.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
  type LabelElement,
  type LabelTemplateSpec,
} from "@markiro/domain";

import {
  BLANK_SPEC,
  checkedSpec,
  draftChanged,
  duplicateLayoutInvalid,
  egaisOutsideScope,
  parseSizeMm,
  presetOf,
  readSpec,
  resizedSpec,
  startingSpec,
  templateFileName,
  templateJson,
  templateNameRule,
  toDpi,
  type TemplateDraft,
} from "../src/office/templates/editor-model.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";

const EGAIS_FIELD: LabelElement = {
  kind: "field",
  id: "egais",
  xMm: 2,
  yMm: 2,
  field: "product.egais",
  fontSizePt: 8,
  maxWidthMm: 40,
};

/** A 40 × 20 mm box at the top left. */
const WIDE_BOX: LabelElement = {
  kind: "box",
  id: "frame",
  xMm: 10,
  yMm: 10,
  widthMm: 40,
  heightMm: 20,
  thicknessMm: 0.5,
};

function draft(data: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    scope: { mode: "all", codes: [] },
    spec: BLANK_SPEC,
    ...data,
  };
}

describe("the template editor's model", () => {
  it("starts a box empty, a duplicate as the domain's duplicate and a pallet as the stock pallet", () => {
    expect(startingSpec("box")).toStrictEqual({
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [],
    });
    expect(startingSpec("product_duplicate")).toStrictEqual(buildDuplicateLabelTemplate());
    expect(startingSpec("pallet")).toStrictEqual(buildPalletLabelTemplates()[0]?.spec);
  });

  it("names a size's preset and none for any other size", () => {
    expect(presetOf(58, 40)).toBe("58x40");
    expect(presetOf(100, 150)).toBe("100x150");
    expect(presetOf(40, 58)).toBeNull();
    expect(presetOf(58.04, 40)).toBeNull();
  });

  it("reads a typed size with a comma or a point within 10–300 mm and refuses the rest", () => {
    expect(parseSizeMm(" 58 ")).toBe(58);
    expect(parseSizeMm("58,5")).toBe(58.5);
    expect(parseSizeMm("58.5")).toBe(58.5);
    expect(parseSizeMm("10")).toBe(10);
    expect(parseSizeMm("300")).toBe(300);
    for (const text of ["", "9,9", "300.1", "-20", "1e2", "58 мм", "5 8", ".5", "58,"]) {
      expect(parseSizeMm(text)).toBeNull();
    }
  });

  it("takes 300 dpi from a select and 203 for anything else", () => {
    expect(toDpi("300")).toBe(300);
    expect(toDpi("203")).toBe(203);
    expect(toDpi("600")).toBe(203);
  });

  it("reads a stored layout as the domain does, and nothing else", () => {
    const pallet = buildPalletLabelTemplates()[0]?.spec;
    expect(readSpec({ ...pallet })).toStrictEqual(pallet);
    expect(readSpec({ ...BLANK_SPEC, dpi: 600 })).toBeNull();
    expect(readSpec({ widthMm: 58 })).toBeNull();
  });

  it("sends a layout as the domain's schema makes it: unknown keys dropped, a broken layout refused", () => {
    const withExtra = { ...BLANK_SPEC, elements: [{ ...WIDE_BOX, colour: "red" }] };
    expect(checkedSpec(withExtra)).toStrictEqual({ ...BLANK_SPEC, elements: [WIDE_BOX] });
    expect(checkedSpec({ ...BLANK_SPEC, elements: [WIDE_BOX, WIDE_BOX] })).toBeNull();
    expect(checkedSpec({ ...BLANK_SPEC, widthMm: 400 })).toBeNull();
  });

  it("resizes a layout and moves its elements inside, or refuses a size an element does not fit", () => {
    const layout: LabelTemplateSpec = { ...BLANK_SPEC, elements: [WIDE_BOX] };
    expect(resizedSpec(layout, 45, 40, "box")).toStrictEqual({
      ...layout,
      widthMm: 45,
      elements: [{ ...WIDE_BOX, xMm: 5 }],
    });
    expect(resizedSpec(layout, 30, 40, "box")).toBeNull();
    expect(resizedSpec(layout, 100, 150, "pallet")).toStrictEqual({
      ...layout,
      widthMm: 100,
      heightMm: 150,
    });
  });

  it("measures a duplicate with its own sample and draws its code as the raster", () => {
    expect(labelSampleData("product_duplicate")).toMatchObject({ sscc: "", qty: "1" });
    expect(labelSampleData("pallet")).toMatchObject({ sscc: "376006820000000021", qty: "240" });
    expect(labelSampleData("box").sscc).not.toBe("");
    expect(labelRenderOptions("product_duplicate")).toStrictEqual({ kmDataMatrix: "raster" });
    expect(labelRenderOptions("box")).toStrictEqual({});
    expect(labelRenderOptions("pallet")).toStrictEqual({});
  });

  it("holds a product duplicate to the domain's duplicate rule and no other purpose", () => {
    expect(duplicateLayoutInvalid(buildDuplicateLabelTemplate(), "product_duplicate")).toBe(false);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "product_duplicate")).toBe(true);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "box")).toBe(false);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "pallet")).toBe(false);
  });

  it("warns about the EGAIS field only on categories that leave beer out", () => {
    const layout: LabelTemplateSpec = { ...BLANK_SPEC, elements: [EGAIS_FIELD] };
    expect(egaisOutsideScope(layout, { mode: "selected", codes: [8, 13] })).toBe(true);
    expect(egaisOutsideScope(layout, { mode: "selected", codes: [8, 15] })).toBe(false);
    expect(egaisOutsideScope(layout, { mode: "all", codes: [8] })).toBe(false);
    expect(egaisOutsideScope(BLANK_SPEC, { mode: "selected", codes: [8] })).toBe(false);
  });

  it("trims a name and refuses an empty, an overlong or a control-character one", () => {
    expect(templateNameRule.parse("  Коробка 58×40  ")).toBe("Коробка 58×40");
    expect(templateNameRule.safeParse("x".repeat(200)).success).toBe(true);
    for (const name of ["   ", "x".repeat(201)]) {
      expect(templateNameRule.safeParse(name).error?.issues[0]?.message).toBe(
        "office.templateEditor.errors.name",
      );
    }
    expect(templateNameRule.safeParse("Коробка\t58").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("finds a change in anything a save sends, and none in the order of categories", () => {
    const opened = draft({ scope: { mode: "selected", codes: [8, 13] } });
    expect(draftChanged(opened, draft({ scope: { mode: "selected", codes: [13, 8] } }))).toBe(
      false,
    );
    expect(draftChanged(opened, draft({ ...opened, name: "Коробка 58×40 " }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, purpose: "pallet" }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, enabled: false }))).toBe(true);
    expect(draftChanged(opened, draft({ scope: { mode: "all", codes: [8, 13] } }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, spec: { ...BLANK_SPEC, dpi: 300 } }))).toBe(
      true,
    );
    expect(draftChanged(draft(), draft({ scope: { mode: "all", codes: [8] } }))).toBe(false);
  });

  it("downloads a template as `{ name, purpose, spec }` in that order with a final newline", () => {
    expect(templateJson("Коробка", "box", BLANK_SPEC)).toBe(
      `${JSON.stringify({ name: "Коробка", purpose: "box", spec: BLANK_SPEC }, null, 2)}\n`,
    );
    expect(Object.keys(JSON.parse(templateJson("Коробка", "box", BLANK_SPEC)))).toEqual([
      "name",
      "purpose",
      "spec",
    ]);
  });

  it("makes a file name of a template name, keeping Cyrillic letters", () => {
    expect(templateFileName(" Коробка 58×40 ")).toBe("Коробка-58-40");
    expect(templateFileName("Box_1 (copy)")).toBe("Box_1-copy");
    expect(templateFileName("«»…")).toBe("label");
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-geometry.test.ts test/editor-model.test.ts`
Expected: FAIL — 2 файла, `Tests  no tests`: `Failed to resolve import "../src/office/templates/label-geometry.js" from "test/label-geometry.test.ts"` и `Failed to resolve import "../src/office/templates/label-samples.js" from "test/editor-model.test.ts"`.

- [ ] **Step 3: Модули модели**

1. Создать `apps/standalone/src/office/templates/label-samples.ts`:

<!-- prettier-ignore -->
```ts
import { sampleLabelData, type LabelField } from "@markiro/domain";

import type { TemplatePurpose } from "../../host/protocol.js";

/** How a layout draws a product's code: natively, or as the shared GS1 raster. */
export interface LabelRenderOptions {
  kmDataMatrix?: "native" | "raster";
}

const BOX = sampleLabelData();

/**
 * The sample data the editor measures a layout with, after the cloud's
 * `labelPreviewData` (`apps/admin/src/pages/labels/preview-data.ts`): a
 * product duplicate carries a synthetic code and no SSCC, a pallet its own
 * SSCC and the units of every box on it. Synthetic, never a code taken from
 * production. One record per purpose, so a purpose added later cannot fall
 * through to the box's sample.
 */
const SAMPLES: Record<TemplatePurpose, Record<LabelField, string>> = {
  box: BOX,
  product_duplicate: {
    ...BOX,
    "km.code": "010460000000001521DEMO-LABEL-42\u001d93Abcd",
    "product.gtin": "04600000000015",
    "product.printName": "Кега · демонстрационная этикетка",
    qty: "1",
    sscc: "",
  },
  pallet: { ...BOX, sscc: "376006820000000021", qty: "240" },
};

/** A product duplicate draws its code as the raster the station prints; the rest natively. */
const RENDER_OPTIONS: Record<TemplatePurpose, LabelRenderOptions> = {
  box: {},
  product_duplicate: { kmDataMatrix: "raster" },
  pallet: {},
};

/** The sample data of a purpose. */
export function labelSampleData(purpose: TemplatePurpose): Record<LabelField, string> {
  return SAMPLES[purpose];
}

/** How a purpose draws a product's code. */
export function labelRenderOptions(purpose: TemplatePurpose): LabelRenderOptions {
  return RENDER_OPTIONS[purpose];
}
```

2. Создать `apps/standalone/src/office/templates/label-geometry.ts`:

<!-- prettier-ignore -->
```ts
import {
  elementBoundsMm,
  type LabelElement,
  type LabelField,
  type LabelTemplateSpec,
} from "@markiro/domain";

import type { LabelRenderOptions } from "./label-samples.js";

/** Slack for floating-point sums of millimetres. */
const EPSILON = 1e-9;

/** An element that cannot sit inside the label: it is larger than the label. */
export interface ElementTooLarge {
  ok: false;
}

export type ElementFit = ElementTooLarge | { ok: true; element: LabelElement; adjusted: boolean };

function finiteSize(spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">): boolean {
  return (
    Number.isFinite(spec.widthMm) &&
    Number.isFinite(spec.heightMm) &&
    spec.widthMm > 0 &&
    spec.heightMm > 0
  );
}

/**
 * One element moved inside the label, after the cloud editor's
 * `fitElementWithinLabel` (`apps/admin/src/pages/labels/geometry.ts`): its
 * bounds (`elementBoundsMm`, measured with the same sample data the layout
 * is drawn with) are slid back over the edge they hang across; an element
 * larger than the label is refused, never shrunk.
 */
export function fitElementWithinLabel(
  element: LabelElement,
  spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): ElementFit {
  if (!finiteSize(spec)) return { ok: false };
  const bounds = elementBoundsMm(element, data, options);
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.w) ||
    !Number.isFinite(bounds.h) ||
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    bounds.w > spec.widthMm + EPSILON ||
    bounds.h > spec.heightMm + EPSILON
  ) {
    return { ok: false };
  }
  const deltaX = Math.min(Math.max(bounds.x, 0), spec.widthMm - bounds.w) - bounds.x;
  const deltaY = Math.min(Math.max(bounds.y, 0), spec.heightMm - bounds.h) - bounds.y;
  if (Math.abs(deltaX) <= EPSILON && Math.abs(deltaY) <= EPSILON) {
    return { ok: true, element, adjusted: false };
  }
  const moved: LabelElement =
    element.kind === "line"
      ? {
          ...element,
          xMm: element.xMm + deltaX,
          yMm: element.yMm + deltaY,
          x2Mm: element.x2Mm + deltaX,
          y2Mm: element.y2Mm + deltaY,
        }
      : { ...element, xMm: element.xMm + deltaX, yMm: element.yMm + deltaY };
  const after = elementBoundsMm(moved, data, options);
  if (
    after.x < -EPSILON ||
    after.y < -EPSILON ||
    after.x + after.w > spec.widthMm + EPSILON ||
    after.y + after.h > spec.heightMm + EPSILON
  ) {
    return { ok: false };
  }
  return { ok: true, element: moved, adjusted: true };
}

/**
 * Every element of a layout moved inside its label (`fitElementWithinLabel`),
 * all or nothing: one element larger than the label refuses the whole
 * layout, so a resize never cuts content a save would then keep. The ids of
 * the moved elements come back for the import's summary.
 */
export function fitSpecElements(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): ElementTooLarge | { ok: true; spec: LabelTemplateSpec; adjustedIds: string[] } {
  if (!finiteSize(spec)) return { ok: false };
  const adjustedIds: string[] = [];
  const elements: LabelElement[] = [];
  for (const element of spec.elements) {
    const fit = fitElementWithinLabel(element, spec, data, options);
    if (!fit.ok) return fit;
    elements.push(fit.element);
    if (fit.adjusted) adjustedIds.push(element.id);
  }
  return { ok: true, spec: { ...spec, elements }, adjustedIds };
}
```

3. Создать `apps/standalone/src/office/templates/editor-model.ts`:

<!-- prettier-ignore -->
```ts
import {
  assertDuplicateTemplate,
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
  DomainError,
  EGAIS_PRODUCT_GROUP_CODE,
  labelTemplateSpecSchema,
  labelTemplateUsesField,
  type LabelTemplateSpec,
  type PrinterDpi,
} from "@markiro/domain";

import type { TemplatePurpose, TemplateSpec } from "../../host/protocol.js";
import { plainTextRule } from "../../lib/rules.js";
import { sameCategories, scopeCodes, type CategoryScope } from "./category-scope.js";
import { fitSpecElements } from "./label-geometry.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** The longest template name the host keeps (`validate::template_name`). */
export const MAX_TEMPLATE_NAME = 200;

/** A template's name: trimmed, 1 to 200 characters, as the host takes it. */
export const templateNameRule = plainTextRule(
  MAX_TEMPLATE_NAME,
  "office.templateEditor.errors.name",
);

/** A new box template: an empty 58×40 label at 203 dpi, filled by an import. */
export const BLANK_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};

/**
 * The layout a new template of a purpose starts from, as in the cloud
 * editor: a box an empty label, a product duplicate the domain's duplicate
 * 58×40, a pallet the stock pallet 100×150, whose large SSCC is the point of
 * the label.
 */
export function startingSpec(purpose: TemplatePurpose): LabelTemplateSpec {
  if (purpose === "product_duplicate") return buildDuplicateLabelTemplate();
  if (purpose === "pallet") return buildPalletLabelTemplates()[0]?.spec ?? BLANK_SPEC;
  return BLANK_SPEC;
}

/** The label sizes the size select offers, in millimetres; anything else is «Свой размер». */
export const SIZE_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "60x40", widthMm: 60, heightMm: 40 },
  { key: "75x120", widthMm: 75, heightMm: 120 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

export type SizePresetKey = (typeof SIZE_PRESETS)[number]["key"];

/** The preset of a size, or `null` when no preset has it. */
export function presetOf(widthMm: number, heightMm: number): SizePresetKey | null {
  return (
    SIZE_PRESETS.find((preset) => preset.widthMm === widthMm && preset.heightMm === heightMm)
      ?.key ?? null
  );
}

/** The bounds the domain puts on a label's width and height (`labelTemplateSpecSchema`). */
export const MIN_SIZE_MM = 10;
export const MAX_SIZE_MM = 300;

/**
 * A typed width or height in millimetres: digits with a comma or a point,
 * within 10–300 mm; `null` for anything else, so an empty, non-numeric or
 * out-of-range entry is refused as what it is instead of reaching the fit.
 */
export function parseSizeMm(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value >= MIN_SIZE_MM && value <= MAX_SIZE_MM ? value : null;
}

/** The resolutions a layout is authored in; the station prints in its printer's own. */
export const DPI_CHOICES: readonly PrinterDpi[] = [203, 300];

/** A select's value as a resolution: 300, else 203. */
export function toDpi(value: string): PrinterDpi {
  return value === "300" ? 300 : 203;
}

/**
 * A stored layout as the domain reads it (`labelTemplateSpecSchema`), or
 * `null` when it is not one. The host keeps a layout as an opaque object and
 * never checks it, so the editor reads it before it shows it.
 */
export function readSpec(spec: TemplateSpec): LabelTemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/**
 * The layout a save sends: what `labelTemplateSpecSchema` makes of it, or
 * `null` when it is not a layout. The host never checks a layout, so this is
 * the check (spec §5.5).
 */
export function checkedSpec(spec: LabelTemplateSpec): TemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/**
 * The layout at a new size with every element moved inside it
 * (`fitSpecElements`, measured with the purpose's sample data), or `null`
 * when an element is larger than the new label: the old layout stays, so a
 * size never cuts content.
 */
export function resizedSpec(
  spec: LabelTemplateSpec,
  widthMm: number,
  heightMm: number,
  purpose: TemplatePurpose,
): LabelTemplateSpec | null {
  const fitted = fitSpecElements(
    { ...spec, widthMm, heightMm },
    labelSampleData(purpose),
    labelRenderOptions(purpose),
  );
  return fitted.ok ? fitted.spec : null;
}

/**
 * Whether a product duplicate's layout breaks the domain's duplicate rule
 * (`assertDuplicateTemplate`: one Data Matrix of the full code inside the
 * label, no SSCC). Another purpose has no such rule.
 */
export function duplicateLayoutInvalid(spec: LabelTemplateSpec, purpose: TemplatePurpose): boolean {
  if (purpose !== "product_duplicate") return false;
  try {
    assertDuplicateTemplate(spec);
  } catch (error) {
    if (error instanceof DomainError) return true;
    throw error;
  }
  return false;
}

/**
 * Whether the layout prints the EGAIS code while the template is narrowed to
 * categories without beer (`EGAIS_PRODUCT_GROUP_CODE`): only beer has the
 * code, so the field would print empty, as the cloud editor warns.
 */
export function egaisOutsideScope(spec: LabelTemplateSpec, scope: CategoryScope): boolean {
  return (
    scope.mode === "selected" &&
    !scope.codes.includes(EGAIS_PRODUCT_GROUP_CODE) &&
    labelTemplateUsesField(spec, "product.egais")
  );
}

/** What the editor holds of a template. */
export interface TemplateDraft {
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  scope: CategoryScope;
  spec: LabelTemplateSpec;
}

/**
 * Whether the draft differs from the opened one in something a save would
 * send: the name as typed, the purpose, the flag, the categories as the host
 * reads them (`scopeCodes`; the order of codes and the codes kept under «Все
 * категории» do not count) or the layout.
 */
export function draftChanged(opened: TemplateDraft, draft: TemplateDraft): boolean {
  return (
    opened.name !== draft.name ||
    opened.purpose !== draft.purpose ||
    opened.enabled !== draft.enabled ||
    !sameCategories(scopeCodes(opened.scope), scopeCodes(draft.scope)) ||
    JSON.stringify(opened.spec) !== JSON.stringify(draft.spec)
  );
}

/**
 * The downloadable JSON of a template: `{ name, purpose, spec }` pretty
 * printed, in that order, with a final newline — the body the import's JSON
 * format takes back, as the cloud's `buildJsonBlob` writes it.
 */
export function templateJson(
  name: string,
  purpose: TemplatePurpose,
  spec: LabelTemplateSpec,
): string {
  return `${JSON.stringify({ name, purpose, spec }, null, 2)}\n`;
}

/** Everything but letters, digits, `_` and `-`: what a file name made of a template name drops. */
const UNSAFE_FILE_CHARACTERS = /[^\p{L}\p{N}_-]+/gu;

/**
 * A download's file name stem from a template's name: each run of other
 * characters becomes one `-`, edge dashes go, and a name with nothing left
 * is «label». Unlike the cloud's `safeFileName` it keeps Cyrillic letters,
 * since a Russian site's every template would otherwise download as
 * «label».
 */
export function templateFileName(name: string): string {
  const stem = name
    .trim()
    .replace(UNSAFE_FILE_CHARACTERS, "-")
    .replace(/^-+|-+$/g, "");
  return stem === "" ? "label" : stem;
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-geometry.test.ts test/editor-model.test.ts`
Expected: PASS — 2 файла, 20 тестов (`label-geometry` 6, `editor-model` 14).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/label-geometry.test.ts test/editor-model.test.ts`
Expected: PASS, 20; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 20; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/label-geometry.ts` не сдвигать элемент по вертикали: фрагмент

<!-- prettier-ignore -->
```ts
  const deltaY = Math.min(Math.max(bounds.y, 0), spec.heightMm - bounds.h) - bounds.y;
```

заменить на

<!-- prettier-ignore -->
```ts
  const deltaY = 0;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-geometry.test.ts -t "slides an element back"`
Expected: FAIL — `× slides an element back over the edges it hangs across`, `expected { ok: false } to strictly equal { ok: true, …(2) }`.

Мутация 2. В `apps/standalone/src/office/templates/label-geometry.ts` сдвигать у линии только начало: удалить фрагмент

<!-- prettier-ignore -->
```ts
          x2Mm: element.x2Mm + deltaX,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-geometry.test.ts -t "moves both ends of a line"`
Expected: FAIL — `× moves both ends of a line by the same amount`, `expected false to be true`: линия, у которой конец остался за краем, больше не помещается.

Мутация 3. В `apps/standalone/src/office/templates/label-geometry.ts` не называть сдвинутые элементы: удалить фрагмент

<!-- prettier-ignore -->
```ts
    if (fit.adjusted) adjustedIds.push(element.id);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-geometry.test.ts -t "names the elements it moved"`
Expected: FAIL — `× fits a whole layout and names the elements it moved`, `expected { ok: true, …(2) } to strictly equal { ok: true, …(2) }`.

Мутация 4. В `apps/standalone/src/office/templates/editor-model.ts` не принимать запятую: фрагмент

<!-- prettier-ignore -->
```ts
  const normalized = text.trim().replace(",", ".");
```

заменить на

<!-- prettier-ignore -->
```ts
  const normalized = text.trim();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "reads a typed size"`
Expected: FAIL — `× reads a typed size with a comma or a point within 10–300 mm and refuses the rest`, `expected null to be 58.5`.

Мутация 5. В `apps/standalone/src/office/templates/editor-model.ts` не принимать нижнюю границу 10 мм: фрагмент

<!-- prettier-ignore -->
```ts
  return value >= MIN_SIZE_MM && value <= MAX_SIZE_MM ? value : null;
```

заменить на

<!-- prettier-ignore -->
```ts
  return value > MIN_SIZE_MM && value <= MAX_SIZE_MM ? value : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "reads a typed size"`
Expected: FAIL — тот же тест, `expected null to be 10`.

Мутация 6. В `apps/standalone/src/office/templates/editor-model.ts` слать макет как он есть, без разбора схемой: фрагмент

<!-- prettier-ignore -->
```ts
export function checkedSpec(spec: LabelTemplateSpec): TemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
```

заменить на

<!-- prettier-ignore -->
```ts
export function checkedSpec(spec: LabelTemplateSpec): TemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? spec : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "unknown keys dropped"`
Expected: FAIL — `× sends a layout as the domain's schema makes it: unknown keys dropped, a broken layout refused`, `expected { widthMm: 58, heightMm: 40, …(3) } to strictly equal { widthMm: 58, heightMm: 40, …(3) }`: неизвестный ключ остался.

Мутация 7. В `apps/standalone/src/office/templates/editor-model.ts` держать правилом дубликата любой шаблон: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (purpose !== "product_duplicate") return false;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "duplicate rule"`
Expected: FAIL — `× holds a product duplicate to the domain's duplicate rule and no other purpose`, `expected true to be false`.

Мутация 8. В `apps/standalone/src/office/templates/editor-model.ts` предупреждать про ЕГАИС и при «Все категории»: удалить фрагмент

<!-- prettier-ignore -->
```ts
    scope.mode === "selected" &&
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "EGAIS field"`
Expected: FAIL — `× warns about the EGAIS field only on categories that leave beer out`, `expected true to be false`.

Мутация 9. В `apps/standalone/src/office/templates/editor-model.ts` не считать изменением правку названия: удалить фрагмент

<!-- prettier-ignore -->
```ts
    opened.name !== draft.name ||
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "finds a change"`
Expected: FAIL — `× finds a change in anything a save sends, and none in the order of categories`, `expected false to be true`.

Мутация 10. В `apps/standalone/src/office/templates/editor-model.ts` взять облачное имя файла (только латиница): фрагмент

<!-- prettier-ignore -->
```ts
const UNSAFE_FILE_CHARACTERS = /[^\p{L}\p{N}_-]+/gu;
```

заменить на

<!-- prettier-ignore -->
```ts
const UNSAFE_FILE_CHARACTERS = /[^a-zA-Z0-9_-]+/g;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-model.test.ts -t "keeping Cyrillic"`
Expected: FAIL — `× makes a file name of a template name, keeping Cyrillic letters`, `expected '58-40' to be 'Коробка-58-40'`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/label-geometry.test.ts apps/standalone/test/editor-model.test.ts apps/standalone/src/office/templates/label-samples.ts apps/standalone/src/office/templates/label-geometry.ts apps/standalone/src/office/templates/editor-model.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 49 файлов, 1133 теста (1113 + 20).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/label-geometry.test.ts apps/standalone/test/editor-model.test.ts apps/standalone/src/office/templates/label-samples.ts apps/standalone/src/office/templates/label-geometry.ts apps/standalone/src/office/templates/editor-model.ts
git commit -m "feat(standalone): модель редактора шаблона — размеры, проверка макета, подгонка элементов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Импорт кода этикетки: ZPL, TSPL и JSON с проверкой и полями шаблона (D1, D7)

Содержимое этикетки кладёт на неё только импорт, как в облачном редакторе после 2026-08-20. `import-analysis.ts` переносит облачный `analyzeImport`: исходник разбирают разборщики домена (`parseLabelCode` для ZPL и TSPL в выбранном разрешении, `parseLabelJson` для модели — голого макета или `{ name, purpose, spec }`), затем каждый элемент сдвигается в пределы этикетки (`fitSpecElements` задачи 1 с образцом назначения). Отказ — одно из трёх: сообщение разборщика, список нарушений схемы с путями или элемент больше этикетки. Ошибку, которая не `DomainError`, функция не глотает: это ошибка программы.

`ImportCodeDialog` — окно на `FormDialog` (кнопка отправки — «Заменить макет»), шириной 1040 px: формат, разрешение кода (у JSON его нет: он несёт своё), поле кода, «Проверить код», итог проверки (сколько элементов и какой размер, что отброшено и подтверждение, сколько элементов прижато к краю) и справа `ImportFieldsPanel` — поля шаблона с кнопкой «Копировать» (`{{field}}` для кода, голое имя для JSON; неудачное копирование говорит выделить поле вручную). Любая правка кода, формата или разрешения сбрасывает проверку, поэтому устаревший итог подтвердить нельзя. `FormDialog` получает необязательную `width`. Подписи полей — ключи `office.labelFields`, сопоставленные полям домена исчерпывающей записью `LABEL_FIELD_KEYS`.

**Files:**

- Create: `apps/standalone/src/office/templates/import-analysis.ts`, `apps/standalone/src/office/templates/ImportFieldsPanel.tsx`, `apps/standalone/src/office/templates/ImportCodeDialog.tsx`
- Modify: `apps/standalone/src/office/FormDialog.tsx` (ширина), `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/import-analysis.test.ts`, `apps/standalone/test/import-code-dialog.test.tsx` (Create)

**Interfaces:**

- Consumes: `parseLabelCode`, `parseLabelJson`, `DomainError`, `LABEL_FIELDS`, `type LabelImportFormat`, `type LabelImportResult`, `type LabelImportWarning`, `type LabelCodeLanguage`, `type PrinterDpi`, `type LabelField` — `@markiro/domain`; `fitSpecElements`, `labelSampleData`, `labelRenderOptions`, `DPI_CHOICES`, `toDpi` — задача 1; `FormDialog`.
- Produces:
  - `import-analysis.ts`: `interface ImportIssue`, `type ImportError`, `interface ImportAnalysis { result: LabelImportResult; adjustedIds: string[]; name?: string }`, `interface ImportInput`, `type ImportOutcome`, `analyzeImport(input): ImportOutcome`;
  - `ImportFieldsPanel.tsx`: `LABEL_FIELD_KEYS: Record<LabelField, string>`, `ImportFieldsPanel({ syntax: "placeholder" | "json" })`;
  - `ImportCodeDialog.tsx`: `ImportCodeDialog({ purpose, initialFormat: LabelCodeLanguage, initialDpi: PrinterDpi, unsaved, onClose, onReplace(analysis) })`;
  - `FormDialog`: необязательное `width?: number | string`;
  - ключи `office.templateImport.*`, `office.labelFields.*`; классы `template-import*`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/import-analysis.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { analyzeImport } from "../src/office/templates/import-analysis.js";

const NAME_FIELD = {
  kind: "field",
  id: "name",
  xMm: 2,
  yMm: 2,
  field: "product.printName",
  fontSizePt: 10,
  bold: true,
  maxWidthMm: 54,
  maxLines: 3,
};

/** A 58×40 layout at 203 dpi, as the JSON import takes it. */
const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    NAME_FIELD,
    { kind: "line", id: "sep", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
  ],
};

/** 58×40 mm at 203 dpi: 464 × 320 dots, one text line. */
const ZPL = ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FDПартия^FS", "^XZ"].join("\n");

describe("checking imported code", () => {
  it("reads JSON with its own resolution and language and keeps the elements", () => {
    const outcome = analyzeImport({
      source: JSON.stringify(JSON_SPEC),
      format: "json",
      dpi: 300,
      purpose: "pallet",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(outcome.analysis.result.spec.elements.map((element) => element.id)).toEqual([
      "name",
      "sep",
    ]);
    expect(outcome.analysis.result.warnings).toEqual([]);
    expect(outcome.analysis.adjustedIds).toEqual([]);
    expect(outcome.analysis).not.toHaveProperty("name");
  });

  it("passes a wrapper's name through and warns about another purpose", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ name: "Паллета 58×40", purpose: "pallet", spec: JSON_SPEC }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.name).toBe("Паллета 58×40");
    expect(outcome.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "PURPOSE_MISMATCH", source: 'purpose: "pallet"' }),
    ]);
  });

  it("moves an element that hangs over the edge inside and names it", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ ...JSON_SPEC, elements: [{ ...NAME_FIELD, xMm: 57 }] }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.adjustedIds).toEqual(["name"]);
    expect(outcome.analysis.result.spec.elements[0]?.xMm).toBeLessThan(57);
  });

  it("turns a schema failure into its issues with dotted paths", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "elements.0.fontSizePt" }),
        ]),
      },
    });
  });

  it("turns a JSON syntax error into one message and a too large element into its own error", () => {
    expect(analyzeImport({ source: "{", format: "json", dpi: 203, purpose: "box" })).toEqual({
      ok: false,
      error: { kind: "message", message: expect.stringMatching(/^invalid JSON: /) },
    });
    const box = {
      kind: "box",
      id: "b",
      xMm: 0,
      yMm: 0,
      widthMm: 200,
      heightMm: 20,
      thicknessMm: 1,
    };
    expect(
      analyzeImport({
        source: JSON.stringify({ ...JSON_SPEC, elements: [box] }),
        format: "json",
        dpi: 203,
        purpose: "box",
      }),
    ).toEqual({ ok: false, error: { kind: "elementTooLarge" } });
  });

  it("reads ZPL at the chosen resolution and reports a line it drops", () => {
    const at203 = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
    const at300 = analyzeImport({ source: ZPL, format: "zpl", dpi: 300, purpose: "box" });
    expect(at203.ok && at300.ok).toBe(true);
    if (!at203.ok || !at300.ok) return;
    expect(at203.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(at203.analysis.result.spec.elements).toHaveLength(1);
    expect(at300.analysis.result.spec.widthMm).toBeLessThan(at203.analysis.result.spec.widthMm);

    const unsupported = analyzeImport({
      source: ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ"),
      format: "zpl",
      dpi: 203,
      purpose: "box",
    });
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok) return;
    expect(unsupported.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_COMMAND", line: 5 }),
    ]);
  });

  it("turns a ZPL size over the domain's 300 mm into issues, as JSON", () => {
    expect(
      analyzeImport({
        source: ["^XA", "^PW4000", "^LL4000", "^XZ"].join("\n"),
        format: "zpl",
        dpi: 203,
        purpose: "box",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(/^(widthMm|heightMm)$/) }),
        ]),
      },
    });
  });

  it("reads TSPL", () => {
    const outcome = analyzeImport({
      source: ["SIZE 58 mm, 40 mm", "CLS", 'TEXT 40,40,"0",0,12,12,"{{qty}}"', "PRINT 1"].join(
        "\n",
      ),
      format: "tspl",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({
      widthMm: 58,
      heightMm: 40,
      language: "tspl",
    });
    expect(outcome.analysis.result.spec.elements).toEqual([
      expect.objectContaining({ kind: "field", field: "qty" }),
    ]);
  });
});
```

2. Создать `apps/standalone/test/import-code-dialog.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImportAnalysis } from "../src/office/templates/import-analysis.js";
import {
  ImportCodeDialog,
  type ImportCodeDialogProps,
} from "../src/office/templates/ImportCodeDialog.js";

/** 58×40 mm at 203 dpi, a text line and a `{{qty}}` field. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "box", id: "frame", xMm: 1, yMm: 1, widthMm: 56, heightMm: 38, thicknessMm: 0.5 },
  ],
};

function open(props: Partial<ImportCodeDialogProps> = {}) {
  const onReplace = vi.fn<(analysis: ImportAnalysis) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ImportCodeDialog
      purpose="box"
      initialFormat="zpl"
      initialDpi={203}
      unsaved={false}
      onClose={onClose}
      onReplace={onReplace}
      {...props}
    />,
  );
  return {
    onReplace,
    onClose,
    dialog: screen.getByRole("dialog", { name: "Импорт кода этикетки" }),
  };
}

function paste(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the template import dialog", () => {
  it("opens on the layout's format and resolution, wide, with both buttons off until there is code", () => {
    const { dialog } = open({ initialFormat: "tspl", initialDpi: 300 });
    expect(screen.getByRole("combobox", { name: "Формат кода" })).toHaveProperty("value", "tspl");
    expect(screen.getByRole("combobox", { name: "Разрешение кода" })).toHaveProperty(
      "value",
      "300",
    );
    expect(screen.getByLabelText("Код TSPL (TSC)")).toHaveProperty("value", "");
    expect(button("Проверить код")).toHaveProperty("disabled", true);
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
    expect(dialog.style.width).toBe("1040px");
    expect(
      screen.queryByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeNull();
  });

  it("checks ZPL, sums it up and replaces the layout with what it found", async () => {
    const { onReplace } = open();
    paste("Код ZPL", ZPL);
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Распознано элементов: 2 · размер 58,06 × 40,04 мм")).toBeTruthy();
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(button("Заменить макет"));
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
    const analysis = onReplace.mock.calls[0]?.[0];
    expect(analysis?.result.spec.elements).toHaveLength(2);
    expect(analysis?.result.spec.language).toBe("zpl");
  });

  it("drops the check when the code, the format or the resolution changes", () => {
    open();
    paste("Код ZPL", ZPL);
    fireEvent.click(button("Проверить код"));
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
    paste("Код ZPL", `${ZPL}\n`);
    expect(screen.queryByText(/Распознано элементов/)).toBeNull();
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    fireEvent.click(button("Проверить код"));
    fireEvent.change(screen.getByRole("combobox", { name: "Разрешение кода" }), {
      target: { value: "300" },
    });
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Распознано элементов: 2 · размер 39,29 × 27,09 мм")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "tspl" },
    });
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
  });

  it("lists the lines it drops and replaces only once they are acknowledged", () => {
    open();
    paste("Код ZPL", ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ"));
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Неподдерживаемые строки: 1")).toBeTruthy();
    const warning = screen.getByText("^GFA,10,10,1,FF");
    expect(warning.closest("li")?.textContent).toBe("Строка 6: ^GFA,10,10,1,FF");
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Импортировать без неподдерживаемых строк (1)" }),
    );
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
  });

  it("takes JSON without a resolution, passes a wrapper's name and warns about another purpose", async () => {
    const { onReplace } = open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(screen.queryByRole("combobox", { name: "Разрешение кода" })).toBeNull();
    paste(
      "JSON шаблона",
      JSON.stringify({ name: "Паллета <b>1</b>", purpose: "pallet", spec: JSON_SPEC }),
    );
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Предупреждения: 1")).toBeTruthy();
    expect(screen.getByText('purpose: "pallet"').closest("li")?.textContent).toBe(
      'purpose: "pallet" — не совпадает с назначением шаблона, макет импортируется как есть',
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Продолжить с этими предупреждениями (1)" }),
    );
    await act(async () => {
      fireEvent.click(button("Заменить макет"));
    });
    expect(onReplace.mock.calls[0]?.[0].name).toBe("Паллета <b>1</b>");
  });

  it("says why code cannot replace the layout: the parser's message, the schema's issues, a too large element", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    paste("JSON шаблона", "{");
    fireEvent.click(button("Проверить код"));
    expect(screen.getByRole("alert").textContent).toMatch(/^.Код не разобран: invalid JSON: /);
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    paste("JSON шаблона", JSON.stringify({ ...JSON_SPEC, elements: [{ kind: "text", id: "a" }] }));
    fireEvent.click(button("Проверить код"));
    const issues = screen.getByRole("alert");
    expect(within(issues).getByText(/^Ошибок в коде: /)).toBeTruthy();
    expect(within(issues).getByText("elements.0.xMm")).toBeTruthy();

    paste(
      "JSON шаблона",
      JSON.stringify({
        ...JSON_SPEC,
        elements: [{ ...JSON_SPEC.elements[0], widthMm: 120 }],
      }),
    );
    fireEvent.click(button("Проверить код"));
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Один из элементов больше этикетки. Исправьте код или разрешение.",
    );
  });

  it("warns that unsaved changes are replaced", () => {
    open({ unsaved: true });
    expect(
      screen.getByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeTruthy();
  });

  it("lists the fields as placeholders for code and as bare names for JSON, each with a copy button", () => {
    open();
    const fields = screen.getByRole("region", { name: "Поля шаблона" });
    expect(within(fields).getByText("Название товара")).toBeTruthy();
    expect(within(fields).getByText("{{product.name}}")).toBeTruthy();
    expect(within(fields).getAllByRole("button", { name: /^Копировать / })).toHaveLength(13);
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(within(fields).getByText("qty.boxes")).toBeTruthy();
    expect(within(fields).queryByText("{{qty.boxes}}")).toBeNull();
  });

  it("copies a field and says so, or says to copy it by hand", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    await act(async () => {
      fireEvent.click(button("Копировать {{sscc}}"));
    });
    expect(writeText).toHaveBeenCalledWith("{{sscc}}");
    expect(screen.getByText("Поле скопировано.")).toBeTruthy();

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(button("Копировать {{qty}}"));
    });
    expect(screen.queryByText("Поле скопировано.")).toBeNull();
    expect(screen.getByText("Не удалось скопировать. Выделите поле вручную.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-analysis.test.ts test/import-code-dialog.test.tsx`
Expected: FAIL — 2 файла, `Tests  no tests`: `Failed to resolve import "../src/office/templates/import-analysis.js" from "test/import-analysis.test.ts"` и `Failed to resolve import "../src/office/templates/ImportCodeDialog.js" from "test/import-code-dialog.test.tsx"`.

- [ ] **Step 3: Разбор импорта, окно и поля шаблона**

1. В `apps/standalone/src/office/FormDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** `false` hides a dialog that stays mounted between openings; open by default. */
  open?: boolean;
  /**
   * Sends the form; the dialog waits until the promise settles. It sorts its
```

заменить на

<!-- prettier-ignore -->
```tsx
  /** `false` hides a dialog that stays mounted between openings; open by default. */
  open?: boolean;
  /** The dialog's width (`Modal`'s); 480 px by default. */
  width?: number | string;
  /**
   * Sends the form; the dialog waits until the promise settles. It sorts its
```

2. В `apps/standalone/src/office/FormDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  submitVariant = "primary",
  open = true,
  onSubmit,
  onClose,
```

заменить на

<!-- prettier-ignore -->
```tsx
  submitVariant = "primary",
  open = true,
  width,
  onSubmit,
  onClose,
```

3. В `apps/standalone/src/office/FormDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
```

заменить на

<!-- prettier-ignore -->
```tsx
      onClose={close}
      closeLabel={t("office.common.close")}
      {...(width === undefined ? {} : { width })}
      footer={
        <>
```

4. Создать `apps/standalone/src/office/templates/import-analysis.ts`:

<!-- prettier-ignore -->
```ts
import {
  DomainError,
  parseLabelCode,
  parseLabelJson,
  type LabelImportFormat,
  type LabelImportResult,
  type PrinterDpi,
} from "@markiro/domain";

import type { TemplatePurpose } from "../../host/protocol.js";
import { fitSpecElements } from "./label-geometry.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** One schema issue of an imported layout, with its dotted path. */
export interface ImportIssue {
  path: string;
  message: string;
}

/** Why an import cannot replace the layout. */
export type ImportError =
  /** An element is larger than the label (`fitSpecElements`). */
  | { kind: "elementTooLarge" }
  /** One blocking message of the parser: a syntax error, a limit. */
  | { kind: "message"; message: string }
  /** The layout failed the domain's schema: every issue with its path. */
  | { kind: "issues"; issues: ImportIssue[] };

/** An import that can replace the layout. */
export interface ImportAnalysis {
  result: LabelImportResult;
  /** The elements moved back inside the label. */
  adjustedIds: string[];
  /** The `name` of a JSON `{ name, purpose, spec }`; absent for code and a bare layout. */
  name?: string;
}

export interface ImportInput {
  source: string;
  format: LabelImportFormat;
  /** The resolution ZPL or TSPL was written for; JSON carries its own. */
  dpi: PrinterDpi;
  purpose: TemplatePurpose;
}

export type ImportOutcome =
  { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportError };

/** Whether a `DomainError`'s cause is `parseLabelTemplate`'s issue list. */
function isIssueList(cause: unknown): cause is ImportIssue[] {
  return (
    Array.isArray(cause) &&
    cause.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        "path" in issue &&
        typeof issue.path === "string" &&
        "message" in issue &&
        typeof issue.message === "string",
    )
  );
}

/**
 * The import dialog's «Проверить код» as a function, after the cloud's
 * `analyzeImport` (`apps/admin/src/pages/labels/editor/import-analysis.ts`):
 * the source parsed by the domain (`parseLabelCode` for ZPL and TSPL at the
 * chosen resolution, `parseLabelJson` for the model itself), then every
 * element moved inside the label (`fitSpecElements`, measured with the
 * purpose's sample data). No DOM and no texts: the dialog words the outcome.
 */
export function analyzeImport(input: ImportInput): ImportOutcome {
  let parsed: LabelImportResult & { name?: string };
  try {
    parsed =
      input.format === "json"
        ? parseLabelJson(input.source, { purpose: input.purpose })
        : parseLabelCode(input.source, { language: input.format, dpi: input.dpi });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === "LABEL_INVALID" && isIssueList(error.cause)) {
      return { ok: false, error: { kind: "issues", issues: error.cause } };
    }
    return { ok: false, error: { kind: "message", message: error.message } };
  }
  const fitted = fitSpecElements(
    parsed.spec,
    labelSampleData(input.purpose),
    labelRenderOptions(input.purpose),
  );
  if (!fitted.ok) return { ok: false, error: { kind: "elementTooLarge" } };
  const { name, ...result } = parsed;
  return {
    ok: true,
    analysis: {
      result: { ...result, spec: fitted.spec },
      adjustedIds: fitted.adjustedIds,
      ...(name === undefined ? {} : { name }),
    },
  };
}
```

5. Создать `apps/standalone/src/office/templates/ImportFieldsPanel.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_FIELDS, type LabelField } from "@markiro/domain";
import { Button } from "@markiro/ui";

/** The i18n key of each field a layout can print, under `office.labelFields`. */
export const LABEL_FIELD_KEYS: Record<LabelField, string> = {
  "product.name": "office.labelFields.productName",
  "product.printName": "office.labelFields.productPrintName",
  "product.gtin": "office.labelFields.productGtin",
  "product.egais": "office.labelFields.productEgais",
  "km.code": "office.labelFields.kmCode",
  sscc: "office.labelFields.sscc",
  "shift.no": "office.labelFields.shiftNo",
  date: "office.labelFields.date",
  expiry: "office.labelFields.expiry",
  qty: "office.labelFields.qty",
  "qty.boxes": "office.labelFields.qtyBoxes",
  operator: "office.labelFields.operator",
  "counterparty.name": "office.labelFields.counterpartyName",
};

export interface ImportFieldsPanelProps {
  /**
   * `placeholder`: `{{field}}`, which ZPL or TSPL must hold whole to become a
   * field; `json`: the bare field, the value of a text's `field` or a
   * barcode's `data`.
   */
  syntax: "placeholder" | "json";
}

/**
 * The fields a layout can print, each with its token and «Копировать», after
 * the cloud's `ImportFieldsPanel`. A failed copy says so, and the token stays
 * selectable for copying by hand.
 */
export function ImportFieldsPanel({ syntax }: ImportFieldsPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async (token: string) => {
    setCopied(false);
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      setCopyFailed(true);
      return;
    }
    setCopied(true);
  };

  return (
    <section
      className="template-import__fields"
      aria-label={t("office.templateImport.fieldsTitle")}
    >
      <h3>{t("office.templateImport.fieldsTitle")}</h3>
      <p className="office-note">
        {t(
          syntax === "json"
            ? "office.templateImport.fieldsHintJson"
            : "office.templateImport.fieldsHint",
        )}
      </p>
      {LABEL_FIELDS.map((field) => {
        const token = syntax === "json" ? field : `{{${field}}}`;
        return (
          <div className="template-import__field" key={field}>
            <span>
              <strong>{t(LABEL_FIELD_KEYS[field])}</strong>
              <code>{token}</code>
            </span>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.templateImport.copy", { token })}
              onClick={() => void copy(token)}
            >
              {t("office.templateImport.copyShort")}
            </Button>
          </div>
        );
      })}
      <p className="office-note" aria-live="polite">
        {copied && t("office.templateImport.copied")}
        {copyFailed && t("office.templateImport.copyError")}
      </p>
    </section>
  );
}
```

6. Создать `apps/standalone/src/office/templates/ImportCodeDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LabelCodeLanguage,
  LabelImportFormat,
  LabelImportWarning,
  PrinterDpi,
} from "@markiro/domain";
import { Alert, Button, Checkbox, Select, Textarea } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import { FormDialog } from "../FormDialog.js";
import { DPI_CHOICES, toDpi } from "./editor-model.js";
import { analyzeImport, type ImportAnalysis, type ImportError } from "./import-analysis.js";
import { ImportFieldsPanel } from "./ImportFieldsPanel.js";

const FORMATS: readonly LabelImportFormat[] = ["zpl", "tspl", "json"];

function toFormat(value: string): LabelImportFormat {
  return value === "tspl" || value === "json" ? value : "zpl";
}

/** Millimetres as the office writes them: «58», «58,04». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

export interface ImportCodeDialogProps {
  purpose: TemplatePurpose;
  /** The format the dialog opens on: the layout's language. */
  initialFormat: LabelCodeLanguage;
  /** The resolution the dialog opens on: the layout's. */
  initialDpi: PrinterDpi;
  /** The editor holds unsaved changes, which the import replaces. */
  unsaved: boolean;
  onClose: () => void;
  /** Replaces the layout; the dialog closes. */
  onReplace: (analysis: ImportAnalysis) => void;
}

/**
 * The only way to put content on a label, after the cloud's
 * `ImportCodeDialog`: paste ZPL or TSPL code or the model's own JSON, check
 * it (`analyzeImport`), acknowledge what is dropped, replace the layout. Any
 * change of the code, the format or the resolution drops the check, so a
 * stale result is never confirmed. «Заменить макет» is the dialog's submit.
 */
export function ImportCodeDialog({
  purpose,
  initialFormat,
  initialDpi,
  unsaved,
  onClose,
  onReplace,
}: ImportCodeDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<LabelImportFormat>(initialFormat);
  const [dpi, setDpi] = useState<PrinterDpi>(initialDpi);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const isJson = format === "json";
  const warnings = analysis?.result.warnings ?? [];
  const canReplace = analysis !== null && (warnings.length === 0 || acknowledged);

  const forget = () => {
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  };

  const check = () => {
    forget();
    const outcome = analyzeImport({ source, format, dpi, purpose });
    if (outcome.ok) setAnalysis(outcome.analysis);
    else setError(outcome.error);
  };

  // `FormDialog` waits on a promise; replacing the layout is immediate.
  const replace = () => {
    if (analysis !== null && canReplace) onReplace(analysis);
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateImport.title")}
      submitLabel={t("office.templateImport.replace")}
      submitDisabled={!canReplace}
      width={1040}
      onSubmit={replace}
      onClose={onClose}
    >
      <div className="template-import">
        <div className="template-import__source">
          <div className="template-import__options">
            <Select
              native
              label={t("office.templateImport.format")}
              options={FORMATS.map((value) => ({
                value,
                label: t(`office.templateImport.formats.${value}`),
              }))}
              value={format}
              onValueChange={(value) => {
                setFormat(toFormat(value));
                forget();
              }}
            />
            {/* JSON carries its own resolution; this one rescales code only. */}
            {!isJson && (
              <Select
                native
                label={t("office.templateImport.dpi")}
                options={DPI_CHOICES.map((value) => ({
                  value: String(value),
                  label: t("office.templates.dpi", { dpi: value }),
                }))}
                value={String(dpi)}
                onValueChange={(value) => {
                  setDpi(toDpi(value));
                  forget();
                }}
              />
            )}
          </div>
          <Textarea
            label={
              isJson
                ? t("office.templateImport.json")
                : t("office.templateImport.code", {
                    format: t(`office.templateImport.formats.${format}`),
                  })
            }
            className="template-import__code"
            spellCheck={false}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              forget();
            }}
          />
          {unsaved && <p className="office-note">{t("office.templateImport.unsaved")}</p>}
          <div>
            <Button variant="secondary" onClick={check} disabled={source.trim() === ""}>
              {t("office.templateImport.check")}
            </Button>
          </div>
          {error !== null && <ImportErrorAlert error={error} />}
          {analysis !== null && (
            <div className="template-import__analysis" aria-live="polite">
              <strong>
                {t("office.templateImport.summary", {
                  n: analysis.result.spec.elements.length,
                  width: MM.format(analysis.result.spec.widthMm),
                  height: MM.format(analysis.result.spec.heightMm),
                })}
              </strong>
              {warnings.length > 0 && (
                <>
                  <p>
                    {t(
                      isJson
                        ? "office.templateImport.warningsTitle"
                        : "office.templateImport.unsupportedTitle",
                      { n: warnings.length },
                    )}
                  </p>
                  <ul className="template-import__warnings">
                    {warnings.map((warning, index) => (
                      <WarningRow key={`${index}-${warning.source}`} warning={warning} />
                    ))}
                  </ul>
                  <Checkbox
                    label={t(
                      isJson
                        ? "office.templateImport.acknowledgeWarnings"
                        : "office.templateImport.acknowledge",
                      { n: warnings.length },
                    )}
                    checked={acknowledged}
                    onCheckedChange={setAcknowledged}
                  />
                </>
              )}
              {analysis.adjustedIds.length > 0 && (
                <p>{t("office.templateImport.adjusted", { n: analysis.adjustedIds.length })}</p>
              )}
            </div>
          )}
        </div>
        <ImportFieldsPanel syntax={isJson ? "json" : "placeholder"} />
      </div>
    </FormDialog>
  );
}

/** One warning: a dropped line of code, or a JSON property or purpose. */
function WarningRow({ warning }: { warning: LabelImportWarning }) {
  const { t } = useTranslation();
  switch (warning.code) {
    case "UNSUPPORTED_COMMAND":
      return (
        <li>
          {t("office.templateImport.line", { line: warning.line })} <code>{warning.source}</code>
        </li>
      );
    case "UNKNOWN_PROPERTY":
      return (
        <li>
          <code>{warning.source}</code> {t("office.templateImport.unknownProperty")}
        </li>
      );
    case "PURPOSE_MISMATCH":
      return (
        <li>
          <code>{warning.source}</code> {t("office.templateImport.purposeMismatch")}
        </li>
      );
  }
}

/** A check that cannot replace the layout: the parser's message, the schema's issues, or a too large element. */
function ImportErrorAlert({ error }: { error: ImportError }) {
  const { t } = useTranslation();
  if (error.kind === "issues") {
    return (
      <Alert tone="error">
        <p>{t("office.templateImport.issuesTitle", { n: error.issues.length })}</p>
        <ul className="template-import__issues">
          {error.issues.map((issue, index) => (
            <li key={`${index}-${issue.path}`}>
              <code>{issue.path === "" ? "spec" : issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      </Alert>
    );
  }
  if (error.kind === "elementTooLarge") {
    return <Alert tone="error">{t("office.templateImport.elementTooLarge")}</Alert>;
  }
  return (
    <Alert tone="error">
      {t("office.templateImport.failed")} <code>{error.message}</code>
    </Alert>
  );
}
```

7. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "missing": "Шаблон {{id}}… — нет в списке"
    },
    "noAccess": {
      "title": "Нет доступа",
```

заменить на

<!-- prettier-ignore -->
```json
      "missing": "Шаблон {{id}}… — нет в списке"
    },
    "templateImport": {
      "title": "Импорт кода этикетки",
      "format": "Формат кода",
      "formats": {
        "zpl": "ZPL",
        "tspl": "TSPL (TSC)",
        "json": "JSON (Маркиро)"
      },
      "dpi": "Разрешение кода",
      "code": "Код {{format}}",
      "json": "JSON шаблона",
      "unsaved": "Несохранённый макет будет заменён, когда вы подтвердите импорт.",
      "check": "Проверить код",
      "replace": "Заменить макет",
      "summary": "Распознано элементов: {{n}} · размер {{width}} × {{height}} мм",
      "unsupportedTitle": "Неподдерживаемые строки: {{n}}",
      "acknowledge": "Импортировать без неподдерживаемых строк ({{n}})",
      "warningsTitle": "Предупреждения: {{n}}",
      "acknowledgeWarnings": "Продолжить с этими предупреждениями ({{n}})",
      "line": "Строка {{line}}:",
      "unknownProperty": "— этого свойства нет в модели, оно будет отброшено",
      "purposeMismatch": "— не совпадает с назначением шаблона, макет импортируется как есть",
      "adjusted": "Прижато к границам этикетки: {{n}}",
      "elementTooLarge": "Один из элементов больше этикетки. Исправьте код или разрешение.",
      "issuesTitle": "Ошибок в коде: {{n}}",
      "failed": "Код не разобран:",
      "fieldsTitle": "Поля шаблона",
      "fieldsHint": "Вставьте поле целиком в текст или штрихкод.",
      "fieldsHintJson": "Подставьте поле значением field у текста или data у штрихкода.",
      "copy": "Копировать {{token}}",
      "copyShort": "Копировать",
      "copied": "Поле скопировано.",
      "copyError": "Не удалось скопировать. Выделите поле вручную."
    },
    "labelFields": {
      "productName": "Название товара",
      "productPrintName": "Наименование для печати",
      "productGtin": "GTIN товара",
      "productEgais": "Код ЕГАИС",
      "kmCode": "Код маркировки",
      "sscc": "SSCC",
      "shiftNo": "№ смены",
      "date": "Дата",
      "expiry": "Годен до",
      "qty": "Количество",
      "qtyBoxes": "Коробов на паллете",
      "operator": "Оператор",
      "counterpartyName": "Контрагент"
    },
    "noAccess": {
      "title": "Нет доступа",
```

8. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  letter-spacing: 0.12em;
}
```

заменить на

<!-- prettier-ignore -->
```css
  letter-spacing: 0.12em;
}

/* The import dialog: the code and its check beside the fields a layout can print. */
.template-import {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr);
  gap: 20px;
  align-items: start;
}

.template-import__source,
.template-import__options,
.template-import__analysis {
  display: grid;
  gap: 12px;
}

.template-import__options {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.template-import__code {
  min-height: 240px;
  font-family: var(--font-mono);
}

.template-import__warnings,
.template-import__issues {
  margin: 0;
  padding-left: 20px;
}

.template-import__fields {
  display: grid;
  gap: 8px;
}

.template-import__fields h3 {
  margin: 0;
  font: var(--text-h3);
}

.template-import__field {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.template-import__field span {
  display: grid;
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-analysis.test.ts test/import-code-dialog.test.tsx`
Expected: PASS — 2 файла, 17 тестов (`import-analysis` 8, `import-code-dialog` 9).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/import-analysis.test.ts test/import-code-dialog.test.tsx`
Expected: PASS, 17; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 17; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/import-analysis.ts` отдавать макет без подгонки: фрагмент

<!-- prettier-ignore -->
```ts
      result: { ...result, spec: fitted.spec },
```

заменить на

<!-- prettier-ignore -->
```ts
      result: { ...result, spec: parsed.spec },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-analysis.test.ts -t "hangs over the edge"`
Expected: FAIL — `× moves an element that hangs over the edge inside and names it`, `expected 57 to be less than 57`.

Мутация 2. В `apps/standalone/src/office/templates/import-analysis.ts` терять название из JSON: удалить фрагмент

<!-- prettier-ignore -->
```ts
      ...(name === undefined ? {} : { name }),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-analysis.test.ts -t "wrapper's name"`
Expected: FAIL — `× passes a wrapper's name through and warns about another purpose`, `expected undefined to be 'Паллета 58×40'`.

Мутация 3. В `apps/standalone/src/office/templates/ImportCodeDialog.tsx` не сбрасывать проверку при правке кода: фрагмент

<!-- prettier-ignore -->
```tsx
            onChange={(event) => {
              setSource(event.target.value);
              forget();
```

заменить на

<!-- prettier-ignore -->
```tsx
            onChange={(event) => {
              setSource(event.target.value);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "drops the check"`
Expected: FAIL — `× drops the check when the code, the format or the resolution changes`, `expected <strong></strong> to be null`.

Мутация 4. В `apps/standalone/src/office/templates/ImportCodeDialog.tsx` заменять макет без подтверждения отброшенного: фрагмент

<!-- prettier-ignore -->
```tsx
  const canReplace = analysis !== null && (warnings.length === 0 || acknowledged);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const canReplace = analysis !== null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "acknowledged"`
Expected: FAIL — `× lists the lines it drops and replaces only once they are acknowledged`, `expected <button type="submit" …(3)></button> to have property "disabled" with value true`.

Мутация 5. В `apps/standalone/src/office/templates/ImportCodeDialog.tsx` разбирать код в начальном разрешении: фрагмент

<!-- prettier-ignore -->
```tsx
    const outcome = analyzeImport({ source, format, dpi, purpose });
```

заменить на

<!-- prettier-ignore -->
```tsx
    const outcome = analyzeImport({ source, format, dpi: initialDpi, purpose });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "drops the check"`
Expected: FAIL — тот же тест про сброс проверки, `Unable to find an element with the text: Распознано элементов: 2 · размер 39,29 × 27,09 мм`.

Мутация 6. В `apps/standalone/src/office/FormDialog.tsx` не передавать ширину окну: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      {...(width === undefined ? {} : { width })}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "wide"`
Expected: FAIL — `× opens on the layout's format and resolution, wide, with both buttons off until there is code`, `expected '480px' to be '1040px'`.

Мутация 7. В `apps/standalone/src/office/templates/ImportFieldsPanel.tsx` показывать у JSON заполнители кода: фрагмент

<!-- prettier-ignore -->
```tsx
        const token = syntax === "json" ? field : `{{${field}}}`;
```

заменить на

<!-- prettier-ignore -->
```tsx
        const token = `{{${field}}}`;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "bare names for JSON"`
Expected: FAIL — `× lists the fields as placeholders for code and as bare names for JSON, each with a copy button`, `Unable to find an element with the text: qty.boxes`.

Мутация 8. В `apps/standalone/src/office/templates/ImportFieldsPanel.tsx` молчать об удачном копировании: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    setCopied(true);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/import-code-dialog.test.tsx -t "copies a field"`
Expected: FAIL — `× copies a field and says so, or says to copy it by hand`, `Unable to find an element with the text: Поле скопировано.`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/import-analysis.test.ts apps/standalone/test/import-code-dialog.test.tsx apps/standalone/src/office/FormDialog.tsx apps/standalone/src/office/templates/import-analysis.ts apps/standalone/src/office/templates/ImportFieldsPanel.tsx apps/standalone/src/office/templates/ImportCodeDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 51 файл, 1150 тестов (1133 + 17).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/import-analysis.test.ts apps/standalone/test/import-code-dialog.test.tsx apps/standalone/src/office/FormDialog.tsx apps/standalone/src/office/templates/import-analysis.ts apps/standalone/src/office/templates/ImportFieldsPanel.tsx apps/standalone/src/office/templates/ImportCodeDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css
git commit -m "feat(standalone): импорт кода этикетки — ZPL, TSPL и JSON с проверкой и полями шаблона" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Редактор: новый шаблон — страница, импорт, категории, выгрузка JSON и создание (D1–D3, D6, D7)

«Шаблоны» получают «Создать шаблон» (обе роли), а маршрут `/templates/new` — `NewTemplatePage`: включённый короб для всех категорий с пустой этикеткой 58×40 и без названия. `TemplateEditor` — страница с тремя карточками («Шаблон»: название, назначение, «Включён»; «Макет»: размер и разрешение словами, число элементов или подсказка про импорт, «Импорт кода», «Скачать JSON», заметка про Zebra и TSC; «Категории»: `CategoryScopeField` плана 1e3 и подсказка облака про поле ЕГАИС) и строкой действий со заметкой о несохранённых правках и «Сохранить». У дубликата, макет которого нарушает правило домена, «Сохранить» выключена, а ошибка предлагает «Взять макет дубликата 58 × 40».

До «Сохранить» на хост не уходит ничего. Сохранение проверяет название (`templateNameRule`) и «Только выбранные» без кодов — отказ встаёт под поле, и фокус переходит на него; затем `checkedSpec`, затем `createTemplate(templateCreate(…))` с обрезанным названием и кодами по возрастанию. Отказ хоста раскладывает `editorFailure`: `validation_failed` на `name` и `chzProductGroupCodes` — под полями, `spec` — над формой своими словами, `template_is_default`, `stock_template`, `not_found` и `stale_revision` — над формой (последние три понадобятся правке задачи 5, функция покрыта своими тестами сразу). Пока запись идёт, поля выключены (`fieldset disabled`), второй щелчок ничего не шлёт. Успех выбрасывает кэш списка и возвращает к «Шаблонам» с уведомлением «Шаблон «…» создан.», которое страница списка читает из состояния перехода. «Скачать JSON» сохраняет `{ name, purpose, spec }` через `downloadFile` (blob URL и `<a download>`).

Три прежних теста `templates-page.test.tsx` рендерят `TemplatesPage` без маршрутизатора; страница теперь берёт `useLocation` и `useNavigate`, поэтому тесты оборачивают её в `MemoryRouter` (утверждения те же).

**Files:**

- Create: `apps/standalone/src/office/templates/download.ts`, `apps/standalone/src/office/templates/editor-failure.ts`, `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/office/templates/TemplateEditorPage.tsx`
- Modify: `apps/standalone/src/office/templates/TemplateFailureAlert.tsx` (`onReload` необязателен), `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/editor-failure.test.ts`, `apps/standalone/test/template-editor.test.tsx` (Create); `apps/standalone/test/templates-page.test.tsx` (Modify: `MemoryRouter`)

**Interfaces:**

- Consumes: задачи 1 и 2; `templateCreate` — `src/host/requests.ts`; `useOfficeMutation`, `officeKeys` — `src/office/office-query.ts`; `useProductGroups`; `CategoryScopeField`, `scopeCodes`; `writeFailure`, `type WriteFailure`, `type FieldMessage` — `src/office/form-errors.ts`; `defaultConflict`, `dpiText`, `sizeText`, `PURPOSES` — `template-text.ts`; `errorProp`.
- Produces:
  - `download.ts`: `downloadFile(blob: Blob, fileName: string): void`;
  - `editor-failure.ts`: `type EditorField = "name" | "scope"`, `type EditorFailure`, `editorFailure(error): EditorFailure`;
  - `TemplateEditor.tsx`: `interface TemplateEditorProps { title; opened: TemplateDraft }`, `TemplateEditor`;
  - `TemplateEditorPage.tsx`: `NewTemplatePage`; маршрут `templates/new`;
  - `TemplatesPage`: «Создать шаблон», уведомление из `location.state.notice`;
  - ключи `office.templates.create`, `office.templateEditor.*` (без `sizeDialog`, `deleteDialog`, `leave`).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

```

заменить на

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

```

2. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
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
```

заменить на

<!-- prettier-ignore -->
```tsx
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { enabled: false }));
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
```

3. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <TemplatesPage />
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
```

заменить на

<!-- prettier-ignore -->
```tsx
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
```

4. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <TemplatesPage />
        </OfficeSessionProvider>
      </QueryClientProvider>,
```

заменить на

<!-- prettier-ignore -->
```tsx
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
```

5. Создать `apps/standalone/test/editor-failure.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { editorFailure } from "../src/office/templates/editor-failure.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, message: code, details });
}

describe("a refused template save", () => {
  it("says whose default a template is", () => {
    expect(
      editorFailure(
        api("conflict", {
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: true, categories: [8] } });
  });

  it("puts a refused name or categories under the control", () => {
    expect(editorFailure(api("validation_failed", { field: "name" }))).toStrictEqual({
      kind: "field",
      field: "name",
      message: "rules.rejected",
    });
    expect(
      editorFailure(api("validation_failed", { field: "chzProductGroupCodes" })),
    ).toStrictEqual({
      kind: "field",
      field: "scope",
      message: "office.templateEditor.errors.scopeRejected",
    });
  });

  it("explains a stock template, a refused layout and a deleted template above the form", () => {
    expect(editorFailure(api("conflict", { constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.stock",
    });
    expect(editorFailure(api("validation_failed", { field: "spec" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.specRejected",
    });
    expect(editorFailure(api("not_found"))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.missing",
    });
  });

  it("offers to reload a stale save and explains the rest by its code", () => {
    expect(editorFailure(api("stale_revision", { currentRev: 9 }))).toStrictEqual({
      kind: "stale",
    });
    expect(editorFailure(api("conflict", { constraint: "line_name" }))).toStrictEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(
      editorFailure(new HostError({ kind: "transport", code: "unreachable", message: "down" })),
    ).toStrictEqual({ kind: "alert", message: "errors.transport.unreachable" });
  });
});
```

6. Создать `apps/standalone/test/template-editor.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, buildPalletLabelTemplates } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 15, alias: "beer", name: "Пиво и пивные напитки" },
];

const BOX_58: LabelTemplateSummary = {
  id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  name: "Коробка 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: true,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 60,
};

/** 58×40 mm at 203 dpi: a text line and a `{{qty}}` field. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

/** The layout the import makes of `ZPL`. */
function importedSpec(source = ZPL) {
  const outcome = analyzeImport({ source, format: "zpl", dpi: 203, purpose: "box" });
  if (!outcome.ok) throw new Error("the sample does not import");
  return outcome.analysis.result.spec;
}

/** What the host answers for a created template. */
function created(name: string, data: Partial<LabelTemplate> = {}): LabelTemplate {
  return {
    id: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    spec: importedSpec(),
    rev: 70,
    ...data,
  };
}

function session(user = TECHNOLOGIST) {
  const fake = fakeOfficeSession({ user });
  fake.api.listTemplates.mockResolvedValue([BOX_58]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function openTemplates(fake: FakeOfficeSession): Promise<RenderResult> {
  const view = renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  return view;
}

async function openNew(fake: FakeOfficeSession): Promise<RenderResult> {
  const view = await openTemplates(fake);
  fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
  await screen.findByRole("heading", { name: "Новый шаблон" });
  await settle();
  return view;
}

/** Blob URLs, which jsdom lacks, recorded instead of made. */
function recordBlobUrls() {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return "blob:template";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  return {
    blobs,
    revoked,
    restore: () => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Imports code through the dialog and replaces the layout. */
async function importCode(source: string, format: "zpl" | "json" = "zpl"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Формат кода" }), {
    target: { value: format },
  });
  fireEvent.change(within(dialog).getByLabelText(format === "json" ? "JSON шаблона" : "Код ZPL"), {
    target: { value: source },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

function chooseCategories(...names: string[]): void {
  fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
  for (const name of names) fireEvent.click(screen.getByRole("checkbox", { name }));
}

async function save(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  });
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Сохранить" });
}

function nameError(): string | null | undefined {
  const name = screen.getByLabelText("Название");
  const describedBy = name.getAttribute("aria-describedby");
  return describedBy === null ? null : document.getElementById(describedBy)?.textContent;
}

describe("a new label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens from «Создать шаблон» for both roles as an unnamed, enabled box template for every category with an empty 58×40 label", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openNew(session(user));
      expect(screen.getByLabelText("Название")).toHaveProperty("value", "");
      expect(screen.getByRole("combobox", { name: "Назначение" })).toHaveProperty("value", "box");
      expect(screen.getByRole("checkbox", { name: "Включён" }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(
        screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
      expect(
        screen.getByText("Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON."),
      ).toBeTruthy();
      expect(saveButton()).toHaveProperty("disabled", false);
      fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
      view.unmount();
    }
  });

  it("creates the template from the trimmed name, the imported layout and the categories ascending, then lists the templates again with a notice", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(
      created("Молоко 58×40", { chzProductGroupCodes: [8, 13] }),
    );
    await openNew(fake);
    type("Название", "  Молоко 58×40 ");
    await importCode(ZPL);
    expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
    expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
    chooseCategories("Упакованная вода", "Молочная продукция");
    // The list is read again once the editor is back: that read is held open.
    let listed: (list: LabelTemplateSummary[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValue(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        listed = resolve;
      }),
    );
    await save();
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Молоко 58×40",
      purpose: "box",
      enabled: true,
      chzProductGroupCodes: [8, 13],
      spec: importedSpec(),
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 58×40» создан.")).toBeTruthy();
    // The cached list was dropped, so no row of the old list shows while it is read.
    expect(screen.getByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => {
      listed([BOX_58]);
    });
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
  });

  it("sends a disabled template, and a purpose with its own starting layout", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Паллета", { purpose: "pallet" }));
    await openNew(fake);
    type("Название", "Паллета");
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(screen.getByText("Размер: 100 × 150 мм · 203 dpi")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Паллета",
      purpose: "pallet",
      enabled: false,
      chzProductGroupCodes: null,
      spec: buildPalletLabelTemplates()[0]?.spec,
    });
  });

  it("keeps an imported layout when the purpose changes", async () => {
    const fake = session();
    await openNew(fake);
    await importCode(ZPL);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
    expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
  });

  it("refuses an empty name and an empty choice of categories before sending, and focuses the refused control", async () => {
    const fake = session();
    await openNew(fake);
    type("Название", "   ");
    await save();
    expect(nameError()).toBe("Укажите название, до 200 символов");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Название")));
    type("Название", "Молоко");
    expect(nameError()).toBeNull();
    chooseCategories();
    await save();
    expect(
      screen.getByText("Выберите хотя бы одну категорию или переключитесь на «Все категории»."),
    ).toBeTruthy();
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
  });

  it("puts the host's refusal under the name or the categories, and explains a refused layout or a lost host above the form", async () => {
    const fake = session();
    fake.api.createTemplate
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "name",
          details: { field: "name" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "codes",
          details: { field: "chzProductGroupCodes" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "spec",
          details: { field: "spec" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      );
    await openNew(fake);
    type("Название", "Молоко");
    await save();
    expect(nameError()).toBe("Хост не принял это значение. Проверьте его.");
    await save();
    expect(nameError()).toBeNull();
    expect(
      screen.getByText("Хост не принял эти категории: справочник групп мог измениться."),
    ).toBeTruthy();
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.",
    );
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(4);
  });

  it("holds a product duplicate to the duplicate rule and offers the domain's duplicate layout back", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await importCode(ZPL);
    expect(screen.getByRole("alert").textContent).toContain(
      "Дубликату нужен один Data Matrix с полным кодом маркировки внутри этикетки; поле SSCC недопустимо.",
    );
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Взять макет дубликата 58 × 40" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(
      screen.getByText(`Элементов в макете: ${buildDuplicateLabelTemplate().elements.length}`),
    ).toBeTruthy();
  });

  it("takes a JSON import's name for an unnamed template and never over a typed one", async () => {
    const fake = session();
    await openNew(fake);
    const body = JSON.stringify({ name: "Из файла", purpose: "box", spec: importedSpec() });
    await importCode(body, "json");
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Из файла");
    type("Название", "Своё");
    await importCode(body, "json");
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Своё");
  });

  it("warns that the EGAIS field prints empty on categories without beer", async () => {
    const fake = session();
    await openNew(fake);
    await importCode(
      ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FD{{product.egais}}^FS", "^XZ"].join("\n"),
    );
    const hint =
      "Поле ЕГАИС заполняется только у товаров категории «Пиво»: на выбранных категориях оно напечатается пустым.";
    expect(screen.queryByText(hint)).toBeNull();
    chooseCategories("Молочная продукция");
    expect(screen.getByText(hint)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Пиво и пивные напитки" }));
    expect(screen.queryByText(hint)).toBeNull();
  });

  it("downloads the layout as `{ name, purpose, spec }` under a file name made of the name", async () => {
    const urls = recordBlobUrls();
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.getAttribute("href") ?? "" });
    });
    const fake = session();
    await openNew(fake);
    type("Название", " Молоко 58×40 ");
    await importCode(ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Скачать JSON" }));
    urls.restore();
    expect(clicked).toEqual([{ download: "Молоко-58-40.json", href: "blob:template" }]);
    expect(urls.revoked).toEqual(["blob:template"]);
    expect(urls.blobs[0]?.type).toBe("application/json");
    // As the file has it: JSON leaves out the keys the import left undefined.
    expect(JSON.parse(await (urls.blobs[0]?.text() ?? Promise.resolve("")))).toStrictEqual({
      name: "Молоко 58×40",
      purpose: "box",
      spec: JSON.parse(JSON.stringify(importedSpec())),
    });
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("says there are unsaved changes until they are taken back, and tells the import so", async () => {
    const fake = session();
    await openNew(fake);
    const note = "Есть несохранённые изменения.";
    expect(screen.queryByText(note)).toBeNull();
    type("Название", "Молоко");
    expect(screen.getByText(note).getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    expect(
      screen.getByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    type("Название", "");
    expect(screen.queryByText(note)).toBeNull();
  });

  it("sends once for a double click and keeps the form off until the answer", async () => {
    const fake = session();
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.createTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    await openNew(fake);
    type("Название", "Молоко");
    await act(async () => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(1);
    // The fieldset turns its controls off; their own `disabled` stays false.
    expect(screen.getByLabelText("Название").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Импорт кода" }).matches(":disabled")).toBe(true);
    await act(async () => {
      answer(created("Молоко"));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  });

  it("shows a name with markup as text in the notice", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("<b>Молоко</b>"));
    await openNew(fake);
    type("Название", "<b>Молоко</b>");
    await save();
    const notice = await screen.findByText("Шаблон «<b>Молоко</b>» создан.");
    expect(notice.querySelector("b")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: FAIL — 3 файла, `Tests  13 failed | 47 passed (60)`: `Failed to resolve import "../src/office/templates/editor-failure.js" from "test/editor-failure.test.ts"`, все 13 тестов `template-editor.test.tsx` — `Unable to find an accessible element with the role "button" and name "Создать шаблон"`; тесты списка в `MemoryRouter` проходят и до реализации.

- [ ] **Step 3: Страница, редактор, отказы, выгрузка и маршрут**

1. Создать `apps/standalone/src/office/templates/download.ts`:

<!-- prettier-ignore -->
```ts
/**
 * Saves a file through a throwaway `<a download>` and a blob URL: the
 * webview's own download, with no host round trip. The URL is revoked right
 * after the synchronous click, by which time the download has its data.
 */
export function downloadFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

2. Создать `apps/standalone/src/office/templates/editor-failure.ts`:

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";
import { defaultConflict, type DefaultConflict } from "./template-text.js";

/** The editor's controls a refusal can go under. */
export type EditorField = "name" | "scope";

/** A refused save: under a control, above the form, or the defaults in its way. */
export type EditorFailure =
  WriteFailure<EditorField> | { kind: "default"; conflict: DefaultConflict };

const EDITOR_FIELDS: Readonly<Record<string, EditorField | FieldMessage<EditorField>>> = {
  name: "name",
  chzProductGroupCodes: { field: "scope", message: "office.templateEditor.errors.scopeRejected" },
};

/**
 * Sorts a refused create or update of a template: a template that is a
 * default (`template_is_default`: switched off or narrowed out of its slot)
 * says whose; a stock template's name or layout (`stock_template`), a layout
 * the host would not keep (`spec`: over 256 KB or 64 levels) and a template
 * deleted since it was opened (`not_found`) are explained above the form; a
 * name or categories the host refused go under their control; the rest is
 * `writeFailure`'s (`stale_revision` offers to reload).
 */
export function editorFailure(error: unknown): EditorFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError) {
    if (error.code === "conflict" && error.details.constraint === "stock_template") {
      return { kind: "alert", message: "office.templateEditor.errors.stock" };
    }
    if (error.code === "validation_failed" && error.field === "spec") {
      return { kind: "alert", message: "office.templateEditor.errors.specRejected" };
    }
    if (error.code === "not_found") {
      return { kind: "alert", message: "office.templateEditor.errors.missing" };
    }
  }
  return writeFailure(error, EDITOR_FIELDS);
}
```

3. В `apps/standalone/src/office/templates/TemplateFailureAlert.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** The ЧЗ product groups, to name a category; `undefined` names it by its code. */
  groups: readonly ProductGroup[] | undefined;
  /** Loads the templates again after a stale write. */
  onReload: () => void;
}

```

заменить на

<!-- prettier-ignore -->
```tsx
  /** The ЧЗ product groups, to name a category; `undefined` names it by its code. */
  groups: readonly ProductGroup[] | undefined;
  /** Loads the template again after a stale write; without it a stale write is only explained. */
  onReload?: () => void;
}

```

4. В `apps/standalone/src/office/templates/TemplateFailureAlert.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    return <Alert tone="error">{describeDefaultConflict(failure.conflict, groups, t)}</Alert>;
  }
  return <WriteFailureAlert failure={failure} onReload={onReload} />;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    return <Alert tone="error">{describeDefaultConflict(failure.conflict, groups, t)}</Alert>;
  }
  return <WriteFailureAlert failure={failure} {...(onReload === undefined ? {} : { onReload })} />;
}
```

5. Создать `apps/standalone/src/office/templates/TemplateEditor.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";

import type { LabelTemplate, TemplateCreate, TemplatePurpose } from "../../host/protocol.js";
import { templateCreate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { scopeCodes } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { downloadFile } from "./download.js";
import { editorFailure, type EditorFailure, type EditorField } from "./editor-failure.js";
import {
  checkedSpec,
  draftChanged,
  duplicateLayoutInvalid,
  egaisOutsideScope,
  startingSpec,
  templateFileName,
  templateJson,
  templateNameRule,
  type TemplateDraft,
} from "./editor-model.js";
import type { ImportAnalysis } from "./import-analysis.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { dpiText, PURPOSES, sizeText } from "./template-text.js";

export interface TemplateEditorProps {
  /** The page's heading. */
  title: string;
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
}

/**
 * A label template's editor (spec §5.5), after the cloud's
 * `LabelEditorPage`: the name, the purpose, the flag, the categories
 * (`CategoryScopeField`, with the cloud's EGAIS hint) and the layout, which
 * only an import puts on the label (`ImportCodeDialog`); a layout downloads
 * as JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
 * (`templateNameRule`), the layout is what `labelTemplateSpecSchema` makes
 * of it (`checkedSpec`), the categories go ascending (`scopeCodes`). A saved
 * template takes the office back to «Шаблоны» with a notice, and the list,
 * which holds no layouts, is read again.
 */
export function TemplateEditor({ title, opened }: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const groups = useProductGroups();
  const [draft, setDraft] = useState(opened);
  const [fieldError, setFieldError] = useState<{ field: EditorField; message: string } | null>(
    null,
  );
  const [failure, setFailure] = useState<Exclude<EditorFailure, { kind: "field" }> | null>(null);
  const [importing, setImporting] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const create = useOfficeMutation((api, token, body: TemplateCreate) =>
    api.createTemplate(token, body),
  );
  const ids = useId();
  const nameId = `${ids}-name`;
  const scopeId = `${ids}-scope`;
  // The refused control, focused once the form is on again after a save.
  const focusAfterRender = useRef<string | null>(null);
  const dirty = draftChanged(opened, draft);
  const duplicateInvalid = duplicateLayoutInvalid(draft.spec, draft.purpose);

  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null || saving) return;
    focusAfterRender.current = null;
    document.getElementById(target)?.focus();
  });

  const change = (next: Partial<TemplateDraft>, field?: EditorField) => {
    setDraft((current) => ({ ...current, ...next }));
    if (field !== undefined && fieldError?.field === field) setFieldError(null);
  };

  const choosePurpose = (purpose: TemplatePurpose) => {
    setDraft((current) => ({
      ...current,
      purpose,
      // An untouched starting layout follows the purpose; anything imported stays.
      spec:
        JSON.stringify(current.spec) === JSON.stringify(startingSpec(current.purpose))
          ? startingSpec(purpose)
          : current.spec,
    }));
  };

  const replaceLayout = (analysis: ImportAnalysis) => {
    setDraft((current) => ({
      ...current,
      spec: analysis.result.spec,
      // A JSON `{ name, purpose, spec }` names a template that has no name yet.
      name:
        analysis.name !== undefined && current.name.trim() === "" ? analysis.name : current.name,
    }));
    setImporting(false);
  };

  const refuse = (field: EditorField, message: string) => {
    setFieldError({ field, message });
    focusAfterRender.current = field === "name" ? nameId : scopeId;
  };

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    const name = templateNameRule.safeParse(draft.name);
    if (!name.success) {
      refuse("name", name.error.issues[0]?.message ?? "office.templateEditor.errors.name");
      return;
    }
    const codes = scopeCodes(draft.scope);
    if (codes !== null && codes.length === 0) {
      refuse("scope", "office.categoryScope.empty");
      return;
    }
    const spec = checkedSpec(draft.spec);
    if (spec === null) {
      setFailure({ kind: "alert", message: "office.templateEditor.errors.spec" });
      return;
    }
    let saved: LabelTemplate;
    try {
      saved = await create.mutateAsync(
        templateCreate({
          name: name.data,
          purpose: draft.purpose,
          enabled: draft.enabled,
          chzProductGroupCodes: codes,
          spec,
        }),
      );
    } catch (error) {
      const outcome = editorFailure(error);
      if (outcome.kind === "field") refuse(outcome.field, outcome.message);
      else setFailure(outcome);
      return;
    }
    // The list holds no layouts and is read again; nothing of this template is kept.
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", {
      state: { notice: t("office.templateEditor.created", { name: saved.name }) },
    });
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

  const downloadJson = () =>
    downloadFile(
      new Blob([templateJson(draft.name.trim(), draft.purpose, draft.spec)], {
        type: "application/json",
      }),
      `${templateFileName(draft.name)}.json`,
    );

  const errorOf = (field: EditorField) =>
    errorProp(fieldError?.field === field ? t(fieldError.message) : undefined);

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <Button variant="secondary" onClick={() => void navigate("/templates")}>
            {t("office.templateEditor.back")}
          </Button>
        }
      />
      <form className="standalone-form" onSubmit={send} noValidate>
        <TemplateFailureAlert failure={failure} groups={groups.data} />
        {/* Off while a save is on its way: an edit made then would be lost. */}
        <fieldset className="template-editor__fields" disabled={saving}>
          <Card title={t("office.templateEditor.general")} titleAs="h2">
            <div className="standalone-form">
              <Input
                id={nameId}
                label={t("office.templateEditor.name")}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value }, "name")}
                {...errorOf("name")}
              />
              <Select
                native
                label={t("office.templateEditor.purpose")}
                options={PURPOSES.map((value) => ({
                  value,
                  label: t(`office.templates.purposes.${value}`),
                }))}
                value={draft.purpose}
                onValueChange={choosePurpose}
              />
              <Checkbox
                label={t("office.templateEditor.enabled")}
                hint={t("office.templateEditor.enabledHint")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => change({ enabled })}
              />
            </div>
          </Card>
          <Card title={t("office.templateEditor.layout")} titleAs="h2">
            <div className="standalone-form">
              <p>
                {t("office.templateEditor.sizeValue", {
                  size: sizeText(draft.spec, t),
                  dpi: dpiText(draft.spec.dpi, t),
                })}
              </p>
              <p>
                {draft.spec.elements.length === 0
                  ? t("office.templateEditor.empty")
                  : t("office.templateEditor.elements", { n: draft.spec.elements.length })}
              </p>
              {duplicateInvalid && (
                <Alert
                  tone="error"
                  action={
                    <Button
                      variant="secondary"
                      size="compact"
                      onClick={() => change({ spec: startingSpec("product_duplicate") })}
                    >
                      {t("office.templateEditor.duplicateReset")}
                    </Button>
                  }
                >
                  {t("office.templateEditor.duplicateInvalid")}
                </Alert>
              )}
              <div className="template-editor__actions">
                <Button variant="secondary" onClick={() => setImporting(true)}>
                  {t("office.templateEditor.import")}
                </Button>
                <Button variant="secondary" onClick={downloadJson}>
                  {t("office.templateEditor.downloadJson")}
                </Button>
              </div>
              <p className="office-note">{t("office.templateEditor.languages")}</p>
            </div>
          </Card>
          <Card title={t("office.templateEditor.categories")} titleAs="h2">
            <div id={scopeId} tabIndex={-1} className="standalone-form">
              <CategoryScopeField
                value={draft.scope}
                onChange={(scope) => change({ scope }, "scope")}
                {...errorOf("scope")}
              />
              {egaisOutsideScope(draft.spec, draft.scope) && (
                <Alert tone="warn">{t("office.templateEditor.egais")}</Alert>
              )}
            </div>
          </Card>
        </fieldset>
        <div className="standalone-form__actions">
          <p className="office-note" aria-live="polite">
            {dirty ? t("office.templateEditor.dirty") : ""}
          </p>
          <Button type="submit" loading={saving} disabled={duplicateInvalid}>
            {t("office.common.save")}
          </Button>
        </div>
      </form>
      {/* Outside the page's form: the dialog has a form of its own. */}
      {importing && (
        <ImportCodeDialog
          purpose={draft.purpose}
          initialFormat={draft.spec.language}
          initialDpi={draft.spec.dpi}
          unsaved={dirty}
          onClose={() => setImporting(false)}
          onReplace={replaceLayout}
        />
      )}
    </>
  );
}
```

6. Создать `apps/standalone/src/office/templates/TemplateEditorPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { startingSpec } from "./editor-model.js";
import { TemplateEditor } from "./TemplateEditor.js";

/**
 * «Новый шаблон» (`/templates/new`): an enabled box template for every
 * category with an empty 58×40 label, and no name until one is typed or a
 * JSON import brings one.
 */
export function NewTemplatePage() {
  const { t } = useTranslation();
  return (
    <TemplateEditor
      title={t("office.templateEditor.newTitle")}
      opened={{
        name: "",
        purpose: "box",
        enabled: true,
        scope: { mode: "all", codes: [] },
        spec: startingSpec("box"),
      }}
    />
  );
}
```

7. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { NewTemplatePage } from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

8. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "products", element: <ProductsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "products", element: <ProductsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

9. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";

import {
```

10. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
type TemplatesDialog = { kind: "state" | "categories"; template: LabelTemplateSummary };

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
```

заменить на

<!-- prettier-ignore -->
```tsx
type TemplatesDialog = { kind: "state" | "categories"; template: LabelTemplateSummary };

/** What the editor leaves in the location when it comes back after a save. */
const EDITOR_RETURN = z.object({ notice: z.string() });

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
```

11. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const groups = useProductGroups();
  const changeList = useChangeList<LabelTemplateSummary>(officeKeys.templates);
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");
  const [dialog, setDialog] = useState<TemplatesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: TemplatesDialog) => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  const groups = useProductGroups();
  const changeList = useChangeList<LabelTemplateSummary>(officeKeys.templates);
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");
  const [dialog, setDialog] = useState<TemplatesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const back = EDITOR_RETURN.safeParse(location.state);
    return back.success ? back.data.notice : null;
  });

  const open = (next: TemplatesDialog) => {
```

12. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader title={t("office.templates.title")} />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
```

заменить на

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader
        title={t("office.templates.title")}
        actions={
          canEdit ? (
            <Button onClick={() => void navigate("/templates/new")}>
              {t("office.templates.create")}
            </Button>
          ) : undefined
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
```

13. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "templates": {
      "title": "Шаблоны этикеток",
      "empty": "Шаблонов пока нет.",
      "nothingFound": "Ничего не найдено. Измените поиск или отбор.",
```

заменить на

<!-- prettier-ignore -->
```json
    "templates": {
      "title": "Шаблоны этикеток",
      "create": "Создать шаблон",
      "empty": "Шаблонов пока нет.",
      "nothingFound": "Ничего не найдено. Измените поиск или отбор.",
```

14. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "counterpartyName": "Контрагент"
    },
    "noAccess": {
      "title": "Нет доступа",
```

заменить на

<!-- prettier-ignore -->
```json
      "counterpartyName": "Контрагент"
    },
    "templateEditor": {
      "newTitle": "Новый шаблон",
      "back": "К шаблонам",
      "general": "Шаблон",
      "name": "Название",
      "purpose": "Назначение",
      "enabled": "Включён",
      "enabledHint": "Выключенный шаблон не предлагается для товаров и умолчаний.",
      "layout": "Макет",
      "sizeValue": "Размер: {{size}} · {{dpi}}",
      "elements": "Элементов в макете: {{n}}",
      "empty": "Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON.",
      "duplicateInvalid": "Дубликату нужен один Data Matrix с полным кодом маркировки внутри этикетки; поле SSCC недопустимо.",
      "duplicateReset": "Взять макет дубликата 58 × 40",
      "import": "Импорт кода",
      "downloadJson": "Скачать JSON",
      "languages": "Один шаблон печатается и на Zebra, и на TSC: станция выбирает язык по своему принтеру.",
      "categories": "Категории",
      "egais": "Поле ЕГАИС заполняется только у товаров категории «Пиво»: на выбранных категориях оно напечатается пустым.",
      "dirty": "Есть несохранённые изменения.",
      "created": "Шаблон «{{name}}» создан.",
      "errors": {
        "name": "Укажите название, до 200 символов",
        "scopeRejected": "Хост не принял эти категории: справочник групп мог измениться.",
        "spec": "Макет не проходит проверку. Импортируйте код заново.",
        "specRejected": "Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.",
        "stock": "Типовой шаблон не переименовывается и не меняет макет: сделайте копию.",
        "missing": "Шаблона больше нет на хосте: его удалили на другом рабочем месте."
      }
    },
    "noAccess": {
      "title": "Нет доступа",
```

15. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
.template-import__field span {
  display: grid;
}
```

заменить на

<!-- prettier-ignore -->
```css
.template-import__field span {
  display: grid;
}

/* The template editor: its cards, off together while a save is on its way. */
.template-editor__fields {
  display: grid;
  gap: 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.template-editor__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: PASS — 3 файла, 64 теста (`templates-page` 47, `editor-failure` 4, `template-editor` 13).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: PASS, 64; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 64; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateEditor.tsx` слать название как набрано: фрагмент

<!-- prettier-ignore -->
```tsx
          name: name.data,
```

заменить на

<!-- prettier-ignore -->
```tsx
          name: draft.name,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "creates the template"`
Expected: FAIL — `× creates the template from the trimmed name, the imported layout and the categories ascending, then lists the templates again with a notice`, `expected { name: '  Молоко 58×40 ', …(4) } to strictly equal { name: 'Молоко 58×40', …(4) }`.

Мутация 2. В `apps/standalone/src/office/templates/TemplateEditor.tsx` слать коды в порядке выбора: фрагмент

<!-- prettier-ignore -->
```tsx
          chzProductGroupCodes: codes,
```

заменить на

<!-- prettier-ignore -->
```tsx
          chzProductGroupCodes: draft.scope.mode === "all" ? null : [...draft.scope.codes],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "creates the template"`
Expected: FAIL — тот же тест, `expected { name: 'Молоко 58×40', …(4) } to strictly equal { name: 'Молоко 58×40', …(4) }`: `[13, 8]` вместо `[8, 13]`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не выбрасывать кэш списка после создания: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    // The list holds no layouts and is read again; nothing of this template is kept.
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "creates the template"`
Expected: FAIL — тот же тест, `Unable to find an element with the text: Загрузка…`: список показал старые строки, не дожидаясь чтения.

Мутация 4. В `apps/standalone/src/office/templates/TemplateEditor.tsx` брать название из JSON поверх набранного: фрагмент

<!-- prettier-ignore -->
```tsx
        analysis.name !== undefined && current.name.trim() === "" ? analysis.name : current.name,
```

заменить на

<!-- prettier-ignore -->
```tsx
        analysis.name !== undefined ? analysis.name : current.name,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "JSON import's name"`
Expected: FAIL — `× takes a JSON import's name for an unnamed template and never over a typed one`, `expected <input …> to have property "value" with value 'Своё'`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не выключать поля на время записи: фрагмент

<!-- prettier-ignore -->
```tsx
        <fieldset className="template-editor__fields" disabled={saving}>
```

заменить на

<!-- prettier-ignore -->
```tsx
        <fieldset className="template-editor__fields">
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "double click"`
Expected: FAIL — `× sends once for a double click and keeps the form off until the answer`, `expected false to be true`.

Мутация 6. В `apps/standalone/src/office/templates/TemplateEditor.tsx` снять ref-страж двойной отправки: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    if (inFlight.current) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "double click"`
Expected: FAIL — тот же тест, `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 7. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не выключать «Сохранить» у сломанного дубликата: фрагмент

<!-- prettier-ignore -->
```tsx
          <Button type="submit" loading={saving} disabled={duplicateInvalid}>
```

заменить на

<!-- prettier-ignore -->
```tsx
          <Button type="submit" loading={saving}>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "duplicate rule"`
Expected: FAIL — `× holds a product duplicate to the duplicate rule and offers the domain's duplicate layout back`, `expected <button type="submit" …(2)></button> to have property "disabled" with value true`.

Мутация 8. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не менять стартовый макет со сменой назначения: фрагмент

<!-- prettier-ignore -->
```tsx
        JSON.stringify(current.spec) === JSON.stringify(startingSpec(current.purpose))
          ? startingSpec(purpose)
          : current.spec,
```

заменить на

<!-- prettier-ignore -->
```tsx
        current.spec,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "its own starting layout"`
Expected: FAIL — `× sends a disabled template, and a purpose with its own starting layout`, `Unable to find an element with the text: Размер: 100 × 150 мм · 203 dpi`.

Мутация 9. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не переводить фокус на отвергнутое поле: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    focusAfterRender.current = field === "name" ? nameId : scopeId;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "focuses the refused control"`
Expected: FAIL — `× refuses an empty name and an empty choice of categories before sending, and focuses the refused control`, `expected <main tabindex="-1" …(1)>…(2)</main> to be <input …>`.

Мутация 10. В `apps/standalone/src/office/templates/TemplateEditor.tsx` никогда не показывать подсказку про ЕГАИС: фрагмент

<!-- prettier-ignore -->
```tsx
              {egaisOutsideScope(draft.spec, draft.scope) && (
```

заменить на

<!-- prettier-ignore -->
```tsx
              {false && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "EGAIS"`
Expected: FAIL — `× warns that the EGAIS field prints empty on categories without beer`, `Unable to find an element with the text: Поле ЕГАИС заполняется только у товаров категории «Пиво»: …`.

Мутация 11. В `apps/standalone/src/office/templates/TemplatesPage.tsx` не читать уведомление из перехода: фрагмент

<!-- prettier-ignore -->
```tsx
    return back.success ? back.data.notice : null;
```

заменить на

<!-- prettier-ignore -->
```tsx
    return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "creates the template"`
Expected: FAIL — `× creates the template from the trimmed name, …`, `Unable to find an element with the text: Шаблон «Молоко 58×40» создан.`.

Мутация 12. В `apps/standalone/src/office/templates/editor-failure.ts` не раскладывать отказ по категориям под поле: удалить фрагмент

<!-- prettier-ignore -->
```ts
  chzProductGroupCodes: { field: "scope", message: "office.templateEditor.errors.scopeRejected" },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/editor-failure.test.ts test/template-editor.test.tsx -t "refusal under the name or the categories|refused name or categories"`
Expected: FAIL — `Tests  2 failed`: `× puts a refused name or categories under the control` (`expected { kind: 'alert', …(1) } to strictly equal { kind: 'field', field: 'scope', …(1) }`) и `× puts the host's refusal under the name or the categories, …` (`Unable to find an element with the text: Хост не принял эти категории: справочник групп мог измениться.`).

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/templates-page.test.tsx apps/standalone/test/editor-failure.test.ts apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/download.ts apps/standalone/src/office/templates/editor-failure.ts apps/standalone/src/office/templates/TemplateFailureAlert.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1167 тестов (1150 + 17).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/templates-page.test.tsx apps/standalone/test/editor-failure.test.ts apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/download.ts apps/standalone/src/office/templates/editor-failure.ts apps/standalone/src/office/templates/TemplateFailureAlert.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css
git commit -m "feat(standalone): редактор шаблона — новый шаблон с импортом, категориями и выгрузкой JSON" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Редактор: размер этикетки и разрешение макета (форма размеров)

«Изменить размер» в карточке «Макет» открывает `LabelSizeDialog` — форму размеров вместо облачных полей, которые подтверждаются уходом фокуса: заготовка («58 × 40 мм» … и «Свой размер»), ширина и высота текстом (запятая или точка, 10–300 мм, `parseSizeMm`), разрешение макета с подсказкой, что станция печатает в разрешении своего принтера. Заготовка заполняет оба поля; набранный размер показывается заготовкой, если она у него есть, иначе «Свой размер». «Применить» сдвигает все элементы внутрь новой этикетки (`resizedSpec`) или, когда элемент больше её, оставляет макет и говорит об этом над полями; неверное число — ошибкой под своим полем. Ось, которую не трогали, сохраняет точное значение: поле показывает «58,06», а в макете 58,0571… мм, и запись не должна молча его округлить.

**Files:**

- Create: `apps/standalone/src/office/templates/LabelSizeDialog.tsx`
- Modify: `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/template-editor.test.tsx` (Modify)

**Interfaces:**

- Consumes: `SIZE_PRESETS`, `presetOf`, `parseSizeMm`, `DPI_CHOICES`, `toDpi`, `resizedSpec` — задача 1; `FormDialog`; `errorProp`.
- Produces: `LabelSizeDialog({ spec, purpose, onClose, onResize(spec) })`; в редакторе — «Изменить размер»; ключи `office.templateEditor.changeSize`, `office.templateEditor.sizeDialog.*`; классы `template-editor__size`, `template-size`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
```

заменить на

<!-- prettier-ignore -->
```tsx
import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { resizedSpec } from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
```

2. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
  });
});

/** About 100 × 100 mm at 203 dpi, with a text about 32 mm long near the right edge. */
const WIDE_ZPL = ["^XA", "^PW800", "^LL800", "^FO480,40^A0N,34,34^FDACME LOGISTICS^FS", "^XZ"].join(
  "\n",
);

function sizeDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Размер этикетки" });
}

async function applySize(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Применить" }));
  });
}

/** The layout a save sends. */
async function savedSpec(fake: FakeOfficeSession): Promise<unknown> {
  type("Название", "Молоко");
  await save();
  return fake.api.createTemplate.mock.calls[0]?.[1].spec;
}

describe("the label's size", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("opens on the layout's size and resolution, takes a preset and sends the new size", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    const dialog = sizeDialog();
    expect(within(dialog).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "58x40",
    );
    expect(within(dialog).getByLabelText("Ширина, мм")).toHaveProperty("value", "58");
    expect(within(dialog).getByLabelText("Высота, мм")).toHaveProperty("value", "40");
    expect(within(dialog).getByRole("combobox", { name: "Разрешение макета" })).toHaveProperty(
      "value",
      "203",
    );
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Размер" }), {
      target: { value: "100x150" },
    });
    expect(within(dialog).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
    expect(within(dialog).getByLabelText("Высота, мм")).toHaveProperty("value", "150");
    await applySize();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Размер: 100 × 150 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      language: "zpl",
      elements: [],
    });
  });

  it("takes a typed size with a comma as «Свой размер», and a resolution", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "58,5");
    expect(within(sizeDialog()).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "custom",
    );
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), {
      target: { value: "300" },
    });
    await applySize();
    expect(screen.getByText("Размер: 58,5 × 40 мм · 300 dpi")).toBeTruthy();
  });

  it("refuses a size outside 10–300 mm under its field and keeps the layout", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "9");
    type("Высота, мм", "сорок");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    type("Ширина, мм", "90");
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(1);
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
  });

  it("moves the elements inside a smaller label, and keeps the layout when one is larger than the label", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(WIDE_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "10");
    type("Высота, мм", "10");
    await applySize();
    expect(within(sizeDialog()).getByRole("alert").textContent).toBe(
      "✕Элемент макета больше этой этикетки. Увеличьте размер или импортируйте код заново.",
    );
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "58x40" },
    });
    expect(within(sizeDialog()).queryByRole("alert")).toBeNull();
    await applySize();
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual(resizedSpec(importedSpec(WIDE_ZPL), 58, 40, "box"));
  });

  it("keeps the exact size of an axis left as it was", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "58,06");
    type("Высота, мм", "50");
    await applySize();
    expect(screen.getByText("Размер: 58,06 × 50 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({
      ...importedSpec(),
      heightMm: 50,
    });
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx`
Expected: FAIL — 1 файл, `Tests  5 failed | 13 passed (18)`: все пять новых тестов — `Unable to find an accessible element with the role "button" and name "Изменить размер"`.

- [ ] **Step 3: Форма размеров**

1. Создать `apps/standalone/src/office/templates/LabelSizeDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplateSpec } from "@markiro/domain";
import { Alert, Input, Select } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { FormDialog } from "../FormDialog.js";
import {
  DPI_CHOICES,
  parseSizeMm,
  presetOf,
  resizedSpec,
  SIZE_PRESETS,
  toDpi,
} from "./editor-model.js";

/** Millimetres as the office writes them: «58», «58,06». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

export interface LabelSizeDialogProps {
  spec: LabelTemplateSpec;
  /** Whose sample data measures the elements. */
  purpose: TemplatePurpose;
  onClose: () => void;
  /** The layout at its new size and resolution; the dialog closes. */
  onResize: (spec: LabelTemplateSpec) => void;
}

/**
 * The label's size and the layout's resolution, after the cloud editor's
 * size select and «Свой размер» fields: a preset fills both fields, and a
 * typed size (10–300 mm, a comma or a point) shows as «Свой размер» unless a
 * preset has it. «Применить» moves every element inside the new label
 * (`resizedSpec`) or, when an element is larger than it, keeps the layout
 * and says so. An axis left as it was keeps its exact value, which the field
 * shows rounded.
 */
export function LabelSizeDialog({ spec, purpose, onClose, onResize }: LabelSizeDialogProps) {
  const { t } = useTranslation();
  const shownWidth = MM.format(spec.widthMm);
  const shownHeight = MM.format(spec.heightMm);
  const [width, setWidth] = useState(shownWidth);
  const [height, setHeight] = useState(shownHeight);
  const [dpi, setDpi] = useState(String(spec.dpi));
  const [invalid, setInvalid] = useState({ width: false, height: false });
  const [tooLarge, setTooLarge] = useState(false);
  const widthMm = width === shownWidth ? spec.widthMm : parseSizeMm(width);
  const heightMm = height === shownHeight ? spec.heightMm : parseSizeMm(height);
  const preset = widthMm === null || heightMm === null ? null : presetOf(widthMm, heightMm);

  const choosePreset = (key: string) => {
    // «Свой размер» leaves the fields as they are, to be typed over.
    const chosen = SIZE_PRESETS.find((each) => each.key === key);
    if (chosen === undefined) return;
    setWidth(MM.format(chosen.widthMm));
    setHeight(MM.format(chosen.heightMm));
    setInvalid({ width: false, height: false });
    setTooLarge(false);
  };

  // `FormDialog` waits on a promise; resizing is immediate.
  const submit = () => {
    setTooLarge(false);
    setInvalid({ width: widthMm === null, height: heightMm === null });
    if (widthMm === null || heightMm === null) return Promise.resolve();
    const next = resizedSpec({ ...spec, dpi: toDpi(dpi) }, widthMm, heightMm, purpose);
    if (next === null) setTooLarge(true);
    else onResize(next);
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateEditor.sizeDialog.title")}
      submitLabel={t("office.templateEditor.sizeDialog.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={
        tooLarge ? (
          <Alert tone="error">{t("office.templateEditor.sizeDialog.tooLarge")}</Alert>
        ) : undefined
      }
    >
      <Select
        native
        label={t("office.templateEditor.sizeDialog.preset")}
        options={[
          ...SIZE_PRESETS.map((each) => ({
            value: each.key,
            label: t("office.templates.size", {
              width: MM.format(each.widthMm),
              height: MM.format(each.heightMm),
            }),
          })),
          { value: "custom", label: t("office.templateEditor.sizeDialog.custom") },
        ]}
        value={preset ?? "custom"}
        onValueChange={choosePreset}
      />
      <div className="template-size">
        <Input
          label={t("office.templateEditor.sizeDialog.width")}
          inputMode="decimal"
          mono
          value={width}
          onChange={(event) => {
            setWidth(event.target.value);
            setInvalid((current) => ({ ...current, width: false }));
            setTooLarge(false);
          }}
          {...errorProp(invalid.width ? t("office.templateEditor.sizeDialog.invalid") : undefined)}
        />
        <Input
          label={t("office.templateEditor.sizeDialog.height")}
          inputMode="decimal"
          mono
          value={height}
          onChange={(event) => {
            setHeight(event.target.value);
            setInvalid((current) => ({ ...current, height: false }));
            setTooLarge(false);
          }}
          {...errorProp(invalid.height ? t("office.templateEditor.sizeDialog.invalid") : undefined)}
        />
      </div>
      <Select
        native
        label={t("office.templateEditor.sizeDialog.dpi")}
        hint={t("office.templateEditor.sizeDialog.dpiHint")}
        options={DPI_CHOICES.map((value) => ({
          value: String(value),
          label: t("office.templates.dpi", { dpi: value }),
        }))}
        value={dpi}
        onValueChange={setDpi}
      />
    </FormDialog>
  );
}
```

2. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { ImportAnalysis } from "./import-analysis.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { dpiText, PURPOSES, sizeText } from "./template-text.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { ImportAnalysis } from "./import-analysis.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { LabelSizeDialog } from "./LabelSizeDialog.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { dpiText, PURPOSES, sizeText } from "./template-text.js";
```

3. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<Exclude<EditorFailure, { kind: "field" }> | null>(null);
  const [importing, setImporting] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
```

заменить на

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<Exclude<EditorFailure, { kind: "field" }> | null>(null);
  const [importing, setImporting] = useState(false);
  const [sizing, setSizing] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
```

4. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          <Card title={t("office.templateEditor.layout")} titleAs="h2">
            <div className="standalone-form">
              <p>
                {t("office.templateEditor.sizeValue", {
                  size: sizeText(draft.spec, t),
                  dpi: dpiText(draft.spec.dpi, t),
                })}
              </p>
              <p>
                {draft.spec.elements.length === 0
```

заменить на

<!-- prettier-ignore -->
```tsx
          <Card title={t("office.templateEditor.layout")} titleAs="h2">
            <div className="standalone-form">
              <div className="template-editor__size">
                <p>
                  {t("office.templateEditor.sizeValue", {
                    size: sizeText(draft.spec, t),
                    dpi: dpiText(draft.spec.dpi, t),
                  })}
                </p>
                <Button variant="secondary" size="compact" onClick={() => setSizing(true)}>
                  {t("office.templateEditor.changeSize")}
                </Button>
              </div>
              <p>
                {draft.spec.elements.length === 0
```

5. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        </div>
      </form>
      {/* Outside the page's form: the dialog has a form of its own. */}
      {importing && (
        <ImportCodeDialog
```

заменить на

<!-- prettier-ignore -->
```tsx
        </div>
      </form>
      {/* Outside the page's form: each dialog has a form of its own. */}
      {sizing && (
        <LabelSizeDialog
          spec={draft.spec}
          purpose={draft.purpose}
          onClose={() => setSizing(false)}
          onResize={(spec) => {
            change({ spec });
            setSizing(false);
          }}
        />
      )}
      {importing && (
        <ImportCodeDialog
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "layout": "Макет",
      "sizeValue": "Размер: {{size}} · {{dpi}}",
      "elements": "Элементов в макете: {{n}}",
      "empty": "Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON.",
```

заменить на

<!-- prettier-ignore -->
```json
      "layout": "Макет",
      "sizeValue": "Размер: {{size}} · {{dpi}}",
      "changeSize": "Изменить размер",
      "elements": "Элементов в макете: {{n}}",
      "empty": "Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON.",
```

7. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "dirty": "Есть несохранённые изменения.",
      "created": "Шаблон «{{name}}» создан.",
      "errors": {
        "name": "Укажите название, до 200 символов",
```

заменить на

<!-- prettier-ignore -->
```json
      "dirty": "Есть несохранённые изменения.",
      "created": "Шаблон «{{name}}» создан.",
      "sizeDialog": {
        "title": "Размер этикетки",
        "preset": "Размер",
        "custom": "Свой размер",
        "width": "Ширина, мм",
        "height": "Высота, мм",
        "invalid": "Размер — от 10 до 300 мм",
        "dpi": "Разрешение макета",
        "dpiHint": "Станция печатает в разрешении своего принтера; это значение — для импорта кода и предпросмотра.",
        "submit": "Применить",
        "tooLarge": "Элемент макета больше этой этикетки. Увеличьте размер или импортируйте код заново."
      },
      "errors": {
        "name": "Укажите название, до 200 символов",
```

8. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  flex-wrap: wrap;
  gap: 8px;
}
```

заменить на

<!-- prettier-ignore -->
```css
  flex-wrap: wrap;
  gap: 8px;
}

.template-editor__size {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

/* The size dialog's width and height side by side. */
.template-size {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx`
Expected: PASS — 1 файл, 18 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-editor.test.tsx`
Expected: PASS, 18; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 18; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` округлять нетронутую ось до показанного: фрагмент

<!-- prettier-ignore -->
```tsx
  const widthMm = width === shownWidth ? spec.widthMm : parseSizeMm(width);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const widthMm = parseSizeMm(width);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "exact size"`
Expected: FAIL — `× keeps the exact size of an axis left as it was`, `expected { widthMm: 58.06, heightMm: 50, …(3) } to strictly equal { widthMm: 58.05714285714285, …(4) }`.

Мутация 2. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` менять размер без подгонки элементов: фрагмент

<!-- prettier-ignore -->
```tsx
    const next = resizedSpec({ ...spec, dpi: toDpi(dpi) }, widthMm, heightMm, purpose);
```

заменить на

<!-- prettier-ignore -->
```tsx
    const next = { ...spec, dpi: toDpi(dpi), widthMm, heightMm };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "moves the elements inside"`
Expected: FAIL — `× moves the elements inside a smaller label, and keeps the layout when one is larger than the label`, `Unable to find an accessible element with the role "dialog" and name "Размер этикетки"`: окно закрылось на 10 × 10 мм.

Мутация 3. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` не применять выбранное разрешение: фрагмент

<!-- prettier-ignore -->
```tsx
    const next = resizedSpec({ ...spec, dpi: toDpi(dpi) }, widthMm, heightMm, purpose);
```

заменить на

<!-- prettier-ignore -->
```tsx
    const next = resizedSpec(spec, widthMm, heightMm, purpose);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "and a resolution"`
Expected: FAIL — `× takes a typed size with a comma as «Свой размер», and a resolution`, `Unable to find an element with the text: Размер: 58,5 × 40 мм · 300 dpi`.

Мутация 4. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` не заполнять ширину заготовкой: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    setWidth(MM.format(chosen.widthMm));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "takes a preset"`
Expected: FAIL — `× opens on the layout's size and resolution, takes a preset and sends the new size`, `expected <input …> to have property "value" with value '100'`.

Мутация 5. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` не показывать ошибку размера: фрагмент

<!-- prettier-ignore -->
```tsx
    setInvalid({ width: widthMm === null, height: heightMm === null });
```

заменить на

<!-- prettier-ignore -->
```tsx
    setInvalid({ width: false, height: false });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "outside 10–300"`
Expected: FAIL — `× refuses a size outside 10–300 mm under its field and keeps the layout`, `Unable to find an element with the text: Размер — от 10 до 300 мм`.

Мутация 6. В `apps/standalone/src/office/templates/LabelSizeDialog.tsx` показывать чужой размер заготовкой 58 × 40: фрагмент

<!-- prettier-ignore -->
```tsx
        value={preset ?? "custom"}
```

заменить на

<!-- prettier-ignore -->
```tsx
        value={preset ?? "58x40"}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "Свой размер"`
Expected: FAIL — `× takes a typed size with a comma as «Свой размер», and a resolution`, `expected <select …(3)>…(6)</select> to have property "value" with value 'custom'`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/LabelSizeDialog.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1172 теста (1167 + 5).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/LabelSizeDialog.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css
git commit -m "feat(standalone): редактор шаблона — размер этикетки и разрешение макета" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Редактор: правка шаблона с ревизией открытой записи (D2, D3, D6)

Строка своего шаблона получает «Изменить» (у типового её нет: хост не даёт менять его название и макет), маршрут `/templates/:id` — `EditTemplatePage`. Страница читает шаблон с макетом под ключом `officeKeys.template(id)` при каждом открытии и показывает редактор, только когда шаблон прочитан в это посещение (`isFetchedAfterMount`), поэтому кэш прошлого визита никогда не попадает под правку. Шаблон, которого нет (`not_found`), объясняется словами с «К шаблонам»; сбой чтения — `LoadError` с «Повторить»; типовой шаблон и макет, который домен не читает, объясняются, и редактор не открывается.

Редактор получает `template` (открытая запись) и `onReload`. У правки назначение выключено с подсказкой, «Сохранить» выключена, пока ничего не изменилось, а запись — `updateTemplate(id, templateUpdate(template, { name, enabled, chzProductGroupCodes, spec }))`: изменившееся, макет и ревизия открытой записи. `stale_revision` показывает «Загрузить заново», которое перечитывает шаблон; редактор собран с `key={template.rev}`, поэтому начинается заново без правок. `template_is_default` объясняет, чьё это умолчание, `not_found` — что шаблона больше нет (список перечитается, когда «Шаблоны» откроются). Успех — «Шаблон «…» сохранён.» на списке. Прежний тест кнопок строки теперь закрепляет третью кнопку «Изменить» у своего шаблона и её отсутствие у типового.

**Files:**

- Modify: `apps/standalone/src/office/office-query.ts` (`officeKeys.template`), `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/office/templates/TemplateEditorPage.tsx` (целиком), `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/template-editor.test.tsx`, `apps/standalone/test/templates-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `templateUpdate`; `getTemplate`, `updateTemplate` — `HostApi`; `readSpec` — задача 1; `scopeOf` — `category-scope.ts`; `LoadError`, `PageLoading`.
- Produces: `officeKeys.template(id: string)`; `TemplateEditorProps` с `template: LabelTemplate | null` и `onReload?: () => void`; `EditTemplatePage`; маршрут `templates/:id`; кнопка строки «Изменить» (`office.templates.editNamed`); ключи `office.templateEditor.{editTitle,namedTitle,gone,stockLocked,unreadable,purposeFixed,saved}`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  });

  it("puts a row's two actions in one box, the switch first and «Категории» second, each a compact secondary button named after its template", async () => {
    await openTemplates(session());
    for (const [name, label] of [
      ["Коробка 58×40", "Выключить"],
      ["Вода и молоко", "Включить"],
    ] as const) {
      const buttons = within(rowOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual([label, "Категории"]);
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        `${label} шаблон «${name}»`,
        `Категории шаблона «${name}»`,
      ]);
      expect(buttons[0]?.parentElement).toBe(buttons[1]?.parentElement);
      for (const button of buttons) {
        expect(button.parentElement?.classList.contains("mk-row-actions")).toBe(true);
```

заменить на

<!-- prettier-ignore -->
```tsx
  });

  it("puts a row's actions in one box, the switch, «Категории» and, for a template that is not stock, «Изменить», each a compact secondary button named after its template", async () => {
    await openTemplates(session());
    for (const [name, label, edit] of [
      ["Коробка 58×40", "Выключить", false],
      ["Вода и молоко", "Включить", true],
    ] as const) {
      const buttons = within(rowOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(
        edit ? [label, "Категории", "Изменить"] : [label, "Категории"],
      );
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(
        edit
          ? [
              `${label} шаблон «${name}»`,
              `Категории шаблона «${name}»`,
              `Изменить шаблон «${name}»`,
            ]
          : [`${label} шаблон «${name}»`, `Категории шаблона «${name}»`],
      );
      expect(new Set(buttons.map((button) => button.parentElement)).size).toBe(1);
      for (const button of buttons) {
        expect(button.parentElement?.classList.contains("mk-row-actions")).toBe(true);
```

2. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    });
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    });
  });
});

const MILK_ID = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";

/** «Молоко 58×40» in the list: a template of the site's own, for milk. */
const MILK_ROW: LabelTemplateSummary = {
  ...BOX_58,
  id: MILK_ID,
  name: "Молоко 58×40",
  stock: false,
  chzProductGroupCodes: [8],
  widthMm: 58.06,
  heightMm: 40.04,
  rev: 61,
};

/** «Молоко 58×40» as `GET /v1/office/templates/{id}` answers. */
function milk(data: Partial<LabelTemplate> = {}): LabelTemplate {
  return {
    id: MILK_ID,
    name: "Молоко 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: [8],
    stock: false,
    spec: importedSpec(),
    rev: 61,
    ...data,
  };
}

function editSession(user = TECHNOLOGIST) {
  const fake = session(user);
  fake.api.listTemplates.mockResolvedValue([BOX_58, MILK_ROW]);
  fake.api.getTemplate.mockResolvedValue(milk());
  return fake;
}

async function openEdit(fake: FakeOfficeSession, name = "Молоко 58×40"): Promise<void> {
  await openTemplates(fake);
  fireEvent.click(screen.getByRole("button", { name: `Изменить шаблон «${name}»` }));
  await screen.findByRole("heading", { name: `Шаблон «${name}»` });
  await settle();
}

function hostError(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, message: code, details });
}

describe("changing a label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("opens the template as the host has it, with its purpose fixed and «Сохранить» off until something changes", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const fake = editSession(user);
      const view = await openTemplates(fake);
      expect(screen.queryByRole("button", { name: "Изменить шаблон «Коробка 58×40»" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
      expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", MILK_ID);
      expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
      const purpose = screen.getByRole("combobox", { name: "Назначение" });
      expect(purpose).toHaveProperty("disabled", true);
      expect(screen.getByText("Назначение не меняется после создания.")).toBeTruthy();
      expect(
        screen.getByRole("radio", { name: "Только выбранные" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        (await screen.findByRole("checkbox", { name: "Молочная продукция" })).getAttribute(
          "aria-checked",
        ),
      ).toBe("true");
      expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
      expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
      expect(saveButton()).toHaveProperty("disabled", true);
      type("Название", "Молоко 60×40");
      expect(saveButton()).toHaveProperty("disabled", false);
      type("Название", "Молоко 58×40");
      expect(saveButton()).toHaveProperty("disabled", true);
      view.unmount();
    }
  });

  it("sends what changed and the layout with the opened revision, then lists the templates again with a notice", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockResolvedValue(
      milk({ name: "Молоко 60×40", enabled: false, rev: 62 }),
    );
    await openEdit(fake);
    type("Название", " Молоко 60×40 ");
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.updateTemplate.mock.calls[0]?.slice(1)).toStrictEqual([
      MILK_ID,
      { expectedRev: 61, name: "Молоко 60×40", enabled: false, spec: importedSpec() },
    ]);
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 60×40» сохранён.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("offers to load the template again after a stale save, which drops the edits and sends the new revision", async () => {
    const fake = editSession();
    fake.api.updateTemplate
      .mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }))
      .mockResolvedValueOnce(milk({ name: "Молоко 70×40", rev: 65 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    const stale = screen.getByRole("alert");
    expect(stale.textContent).toContain("Данные изменились");
    fake.api.getTemplate.mockResolvedValue(milk({ name: "Молоко (со склада)", rev: 64 }));
    fireEvent.click(within(stale).getByRole("button", { name: "Загрузить заново" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко (со склада)»" });
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко (со склада)");
    expect(screen.queryByRole("alert")).toBeNull();
    type("Название", "Молоко 70×40");
    await save();
    expect(fake.api.updateTemplate.mock.calls[1]?.[2]).toMatchObject({ expectedRev: 64 });
  });

  it("says whose default a template is when switching it off is refused", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", {
        constraint: "template_is_default",
        organizationDefault: false,
        categoryDefaults: [8],
      }),
    );
    await openEdit(fake);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Шаблон выбран по умолчанию для категорий: Молочная продукция. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
  });

  it("says the template is gone when it was deleted elsewhere, and the list is read again", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValue(hostError("not_found"));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Шаблона больше нет на хосте: его удалили на другом рабочем месте.",
    );
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("reads the template again on every opening and shows the editor only with what this visit read", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.getTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByText("Загрузка…");
    expect(screen.queryByLabelText("Название")).toBeNull();
    await act(async () => {
      answer(milk({ name: "Молоко 2", rev: 63 }));
    });
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 2");
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(2);
  });

  it("explains a template it cannot open: deleted, unreachable, stock or with a layout this version cannot read", async () => {
    const opening = async (fake: FakeOfficeSession, text: string) => {
      const view = await openTemplates(fake);
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      return view;
    };
    const gone = editSession();
    gone.api.getTemplate.mockRejectedValue(hostError("not_found"));
    let view = await opening(gone, "⧉Шаблона нет на хосте: его удалили на другом рабочем месте.");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    view.unmount();

    const stock = editSession();
    stock.api.getTemplate.mockResolvedValue(milk({ stock: true }));
    view = await opening(
      stock,
      "⧉Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны».",
    );
    view.unmount();

    const unreadable = editSession();
    unreadable.api.getTemplate.mockResolvedValue(milk({ spec: { widthMm: 58 } }));
    view = await opening(
      unreadable,
      "⧉Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
    );
    view.unmount();

    const down = editSession();
    down.api.getTemplate
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(milk());
    await opening(
      down,
      "✕Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.Повторить",
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/template-editor.test.tsx`
Expected: FAIL — 2 файла, `Tests  8 failed | 64 passed (72)`: семь новых тестов — `Unable to find an accessible element with the role "button" and name "Изменить шаблон «Молоко 58×40»"`, тест кнопок строки — `expected [ 'Включить', 'Категории' ] to deeply equal [ 'Включить', 'Категории', 'Изменить' ]`.

- [ ] **Step 3: Страница правки и запись правки**

1. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
} as const;

```

заменить на

<!-- prettier-ignore -->
```ts
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
} as const;

```

2. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";

import type { LabelTemplate, TemplateCreate, TemplatePurpose } from "../../host/protocol.js";
import { templateCreate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";

import type {
  LabelTemplate,
  TemplateCreate,
  TemplatePurpose,
  TemplateUpdate,
} from "../../host/protocol.js";
import { templateCreate, templateUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
```

3. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** The page's heading. */
  title: string;
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
}

```

заменить на

<!-- prettier-ignore -->
```tsx
  /** The page's heading. */
  title: string;
  /**
   * The template being changed, as it was read when the page opened: its
   * revision goes with the save. `null` for a new template.
   */
  template: LabelTemplate | null;
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
  /** Reads the template again after a stale save; the editor then starts afresh. */
  onReload?: () => void;
}

```

4. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * as JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
 * (`templateNameRule`), the layout is what `labelTemplateSpecSchema` makes
 * of it (`checkedSpec`), the categories go ascending (`scopeCodes`). A saved
 * template takes the office back to «Шаблоны» with a notice, and the list,
 * which holds no layouts, is read again.
 */
export function TemplateEditor({ title, opened }: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
```

заменить на

<!-- prettier-ignore -->
```tsx
 * as JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
 * (`templateNameRule`), the layout is what `labelTemplateSpecSchema` makes
 * of it (`checkedSpec`), the categories go ascending (`scopeCodes`). A new
 * template is created (`templateCreate`); a template being changed keeps its
 * purpose and sends what differs and its layout with the opened revision
 * (`templateUpdate`), «Сохранить» staying off until something changed. A
 * saved template takes the office back to «Шаблоны» with a notice, and the
 * list, which holds no layouts, is read again.
 */
export function TemplateEditor({ title, template, opened, onReload }: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
```

5. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const create = useOfficeMutation((api, token, body: TemplateCreate) =>
    api.createTemplate(token, body),
  );
  const ids = useId();
```

заменить на

<!-- prettier-ignore -->
```tsx
  const create = useOfficeMutation((api, token, body: TemplateCreate) =>
    api.createTemplate(token, body),
  );
  const update = useOfficeMutation(
    (api, token, { id, body }: { id: string; body: TemplateUpdate }) =>
      api.updateTemplate(token, id, body),
  );
  const ids = useId();
```

6. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    let saved: LabelTemplate;
    try {
      saved = await create.mutateAsync(
        templateCreate({
          name: name.data,
          purpose: draft.purpose,
          enabled: draft.enabled,
          chzProductGroupCodes: codes,
          spec,
        }),
      );
    } catch (error) {
      const outcome = editorFailure(error);
```

заменить на

<!-- prettier-ignore -->
```tsx
    let saved: LabelTemplate;
    try {
      saved =
        template === null
          ? await create.mutateAsync(
              templateCreate({
                name: name.data,
                purpose: draft.purpose,
                enabled: draft.enabled,
                chzProductGroupCodes: codes,
                spec,
              }),
            )
          : await update.mutateAsync({
              id: template.id,
              body: templateUpdate(template, {
                name: name.data,
                enabled: draft.enabled,
                chzProductGroupCodes: codes,
                spec,
              }),
            });
    } catch (error) {
      const outcome = editorFailure(error);
```

7. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", {
      state: { notice: t("office.templateEditor.created", { name: saved.name }) },
    });
  };
```

заменить на

<!-- prettier-ignore -->
```tsx
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", {
      state: {
        notice: t(
          template === null ? "office.templateEditor.created" : "office.templateEditor.saved",
          { name: saved.name },
        ),
      },
    });
  };
```

8. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      />
      <form className="standalone-form" onSubmit={send} noValidate>
        <TemplateFailureAlert failure={failure} groups={groups.data} />
        {/* Off while a save is on its way: an edit made then would be lost. */}
        <fieldset className="template-editor__fields" disabled={saving}>
```

заменить на

<!-- prettier-ignore -->
```tsx
      />
      <form className="standalone-form" onSubmit={send} noValidate>
        <TemplateFailureAlert
          failure={failure}
          groups={groups.data}
          {...(onReload === undefined ? {} : { onReload })}
        />
        {/* Off while a save is on its way: an edit made then would be lost. */}
        <fieldset className="template-editor__fields" disabled={saving}>
```

9. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
                native
                label={t("office.templateEditor.purpose")}
                options={PURPOSES.map((value) => ({
                  value,
```

заменить на

<!-- prettier-ignore -->
```tsx
                native
                label={t("office.templateEditor.purpose")}
                // The host has no way to change a purpose.
                disabled={template !== null}
                {...(template === null ? {} : { hint: t("office.templateEditor.purposeFixed") })}
                options={PURPOSES.map((value) => ({
                  value,
```

10. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
            {dirty ? t("office.templateEditor.dirty") : ""}
          </p>
          <Button type="submit" loading={saving} disabled={duplicateInvalid}>
            {t("office.common.save")}
          </Button>
```

заменить на

<!-- prettier-ignore -->
```tsx
            {dirty ? t("office.templateEditor.dirty") : ""}
          </p>
          <Button
            type="submit"
            loading={saving}
            disabled={duplicateInvalid || (template !== null && !dirty)}
          >
            {t("office.common.save")}
          </Button>
```

11. Заменить содержимое `apps/standalone/src/office/templates/TemplateEditorPage.tsx` целиком:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { Alert, Button, PageHeader } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { scopeOf } from "./category-scope.js";
import { readSpec, startingSpec } from "./editor-model.js";
import { TemplateEditor } from "./TemplateEditor.js";

/**
 * «Новый шаблон» (`/templates/new`): an enabled box template for every
 * category with an empty 58×40 label, and no name until one is typed or a
 * JSON import brings one.
 */
export function NewTemplatePage() {
  const { t } = useTranslation();
  return (
    <TemplateEditor
      title={t("office.templateEditor.newTitle")}
      template={null}
      opened={{
        name: "",
        purpose: "box",
        enabled: true,
        scope: { mode: "all", codes: [] },
        spec: startingSpec("box"),
      }}
    />
  );
}

/** A page that cannot show the editor: why, and the way back to the list. */
function EditorUnavailable({ title, message }: { title: string; message: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title={title}
        actions={
          <Button variant="secondary" onClick={() => void navigate("/templates")}>
            {t("office.templateEditor.back")}
          </Button>
        }
      />
      <Alert tone="warn">{message}</Alert>
    </>
  );
}

/**
 * A template opened for a change (`/templates/:id`): read with its layout
 * whenever the page opens, and shown only once read on this visit, so the
 * revision a save sends is the one on screen. A stock template keeps its
 * name and layout, a layout the domain cannot read is not shown, and a
 * template deleted elsewhere is said to be gone. After a stale save the
 * template is read again and the editor starts afresh with it (`key`).
 */
export function EditTemplatePage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const template = useOfficeQuery(officeKeys.template(id), (api, token) =>
    api.getTemplate(token, id),
  );
  const title = t("office.templateEditor.editTitle");

  if (template.isError) {
    if (template.error instanceof HostError && template.error.code === "not_found") {
      return <EditorUnavailable title={title} message={t("office.templateEditor.gone")} />;
    }
    return (
      <>
        <PageHeader title={title} />
        <LoadError error={template.error} onRetry={() => void template.refetch()} />
      </>
    );
  }
  if (!template.isFetchedAfterMount || template.data === undefined) return <PageLoading />;
  const opened = template.data;
  if (opened.stock) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.stockLocked")} />;
  }
  const spec = readSpec(opened.spec);
  if (spec === null) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.unreadable")} />;
  }
  return (
    <TemplateEditor
      key={opened.rev}
      title={t("office.templateEditor.namedTitle", { name: opened.name })}
      template={opened}
      opened={{
        name: opened.name,
        purpose: opened.purpose,
        enabled: opened.enabled,
        scope: scopeOf(opened.chzProductGroupCodes),
        spec,
      }}
      onReload={() => void template.refetch()}
    />
  );
}
```

12. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { NewTemplatePage } from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { EditTemplatePage, NewTemplatePage } from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

13. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "templates/:id", element: <EditTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

14. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
            {t("office.templates.categories")}
          </Button>
        </RowActions>
      ),
```

заменить на

<!-- prettier-ignore -->
```tsx
            {t("office.templates.categories")}
          </Button>
          {/* A stock template keeps its name and layout (the host refuses a change). */}
          {!template.stock && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.templates.editNamed", { name: template.name })}
              onClick={() => void navigate(`/templates/${template.id}`)}
            >
              {t("office.templates.edit")}
            </Button>
          )}
        </RowActions>
      ),
```

15. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "categoriesIntro": "Шаблон будет предлагаться только товарам выбранных категорий. Умолчанием организации может быть только шаблон для всех категорий.",
      "categoriesNotice": "Категории шаблона «{{name}}» сохранены.",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
```

заменить на

<!-- prettier-ignore -->
```json
      "categoriesIntro": "Шаблон будет предлагаться только товарам выбранных категорий. Умолчанием организации может быть только шаблон для всех категорий.",
      "categoriesNotice": "Категории шаблона «{{name}}» сохранены.",
      "edit": "Изменить",
      "editNamed": "Изменить шаблон «{{name}}»",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
```

16. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "templateEditor": {
      "newTitle": "Новый шаблон",
      "back": "К шаблонам",
      "general": "Шаблон",
      "name": "Название",
      "purpose": "Назначение",
      "enabled": "Включён",
      "enabledHint": "Выключенный шаблон не предлагается для товаров и умолчаний.",
```

заменить на

<!-- prettier-ignore -->
```json
    "templateEditor": {
      "newTitle": "Новый шаблон",
      "editTitle": "Шаблон",
      "namedTitle": "Шаблон «{{name}}»",
      "gone": "Шаблона нет на хосте: его удалили на другом рабочем месте.",
      "stockLocked": "Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны».",
      "unreadable": "Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
      "back": "К шаблонам",
      "general": "Шаблон",
      "name": "Название",
      "purpose": "Назначение",
      "purposeFixed": "Назначение не меняется после создания.",
      "enabled": "Включён",
      "enabledHint": "Выключенный шаблон не предлагается для товаров и умолчаний.",
```

17. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "dirty": "Есть несохранённые изменения.",
      "created": "Шаблон «{{name}}» создан.",
      "sizeDialog": {
        "title": "Размер этикетки",
```

заменить на

<!-- prettier-ignore -->
```json
      "dirty": "Есть несохранённые изменения.",
      "created": "Шаблон «{{name}}» создан.",
      "saved": "Шаблон «{{name}}» сохранён.",
      "sizeDialog": {
        "title": "Размер этикетки",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/template-editor.test.tsx`
Expected: PASS — 2 файла, 72 теста (`templates-page` 47, `template-editor` 25).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx test/template-editor.test.tsx`
Expected: PASS, 72; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 72; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateEditorPage.tsx` не пересобирать редактор на новой ревизии: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      key={opened.rev}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "stale save"`
Expected: FAIL — `× offers to load the template again after a stale save, which drops the edits and sends the new revision`, `expected <input …> to have property "value" with value 'Молоко (со склада)'`.

Мутация 2. В `apps/standalone/src/office/templates/TemplateEditorPage.tsx` показывать редактор по кэшу прошлого визита: фрагмент

<!-- prettier-ignore -->
```tsx
  if (!template.isFetchedAfterMount || template.data === undefined) return <PageLoading />;
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (template.data === undefined) return <PageLoading />;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "on every opening"`
Expected: FAIL — `× reads the template again on every opening and shows the editor only with what this visit read`, `Unable to find an element with the text: Загрузка…`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateEditorPage.tsx` открывать типовой шаблон на правку: фрагмент

<!-- prettier-ignore -->
```tsx
  if (opened.stock) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (opened.stock && false) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "cannot open"`
Expected: FAIL — `× explains a template it cannot open: deleted, unreachable, stock or with a layout this version cannot read`, `Unable to find role="alert"`.

Мутация 4. В `apps/standalone/src/office/templates/TemplateEditor.tsx` давать менять назначение при правке: удалить фрагмент

<!-- prettier-ignore -->
```tsx
                disabled={template !== null}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "purpose fixed"`
Expected: FAIL — `× opens the template as the host has it, with its purpose fixed and «Сохранить» off until something changes`, `expected <select …(4)>…(3)</select> to have property "disabled" with value true`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateEditor.tsx` включать «Сохранить» без изменений: фрагмент

<!-- prettier-ignore -->
```tsx
            disabled={duplicateInvalid || (template !== null && !dirty)}
```

заменить на

<!-- prettier-ignore -->
```tsx
            disabled={duplicateInvalid}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "purpose fixed"`
Expected: FAIL — тот же тест, `expected <button type="submit" …(2)></button> to have property "disabled" with value true`.

Мутация 6. В `apps/standalone/src/office/templates/TemplateEditor.tsx` слать не ту ревизию: фрагмент

<!-- prettier-ignore -->
```tsx
              body: templateUpdate(template, {
```

заменить на

<!-- prettier-ignore -->
```tsx
              body: templateUpdate({ ...template, rev: 0 }, {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "opened revision"`
Expected: FAIL — `× sends what changed and the layout with the opened revision, then lists the templates again with a notice`, `expected [ …(2) ] to strictly equal [ …(2) ]`: `expectedRev: 0`.

Мутация 7. В `apps/standalone/src/office/templates/TemplatesPage.tsx` показывать «Изменить» и у типового шаблона: фрагмент

<!-- prettier-ignore -->
```tsx
          {!template.stock && (
```

заменить на

<!-- prettier-ignore -->
```tsx
          {(
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "«Изменить»"`
Expected: FAIL — `× puts a row's actions in one box, the switch, «Категории» and, for a template that is not stock, «Изменить», …`, `expected [ Array(3) ] to deeply equal [ 'Выключить', 'Категории' ]`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/templates-page.test.tsx apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1179 тестов (1172 + 7).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/templates-page.test.tsx apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json
git commit -m "feat(standalone): редактор шаблона — правка шаблона с ревизией открытой записи" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Копия и удаление шаблона (D3)

Типовой шаблон меняется только копией: его строка получает «Копировать», а адрес `/templates/:id` типового шаблона — объяснение и «Копировать». Маршрут `/templates/:id/copy` — `CopyTemplatePage`: исходный шаблон (и типовой) читается так же, как для правки (общий `OpenedTemplate`: прочитан в это посещение, `not_found`, сбой чтения, нечитаемый макет), а редактор открывается новым шаблоном с названием «<название> — копия», назначением, признаком, категориями и макетом исходного; назначение копии можно сменить, макет при этом остаётся (`layoutFollowsPurpose` — только у пустой заготовки). Сохранение копии — обычное создание.

Шапка редактора при правке получает «Копировать» и «Удалить» (`destructive-outline`). `DeleteTemplateDialog` спрашивает с `destructive` отправкой и говорит, что станции перестанут получать шаблон, товары, у которых он выбран, останутся без него, а удаление не отменить; `deleteFailure` объясняет умолчание, типовой шаблон и `not_found` (хост отвечает так только на id, которого не было: защита на всякий случай). Удаление возвращает к списку с «Шаблон «…» удалён.» (общий `backToList`). Два прежних теста меняются: кнопки строки закрепляют «Копировать» у типового шаблона, а объяснение типового шаблона — дописанную фразу и кнопку копии.

**Files:**

- Create: `apps/standalone/src/office/templates/DeleteTemplateDialog.tsx`
- Modify: `apps/standalone/src/office/templates/editor-failure.ts`, `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/office/templates/TemplateEditorPage.tsx` (целиком), `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/template-editor.test.tsx`, `apps/standalone/test/editor-failure.test.ts`, `apps/standalone/test/templates-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `deleteTemplate` — `HostApi`; `alertFailure`; `type TemplateFailure`; задача 5.
- Produces: `deleteFailure(error): TemplateFailure`; `DeleteTemplateDialog({ template, onClose, onDeleted })`; `TemplateEditorProps.layoutFollowsPurpose?: boolean`; `CopyTemplatePage`; маршрут `templates/:id/copy`; кнопка строки «Копировать» (`office.templates.copyNamed`); ключи `office.templateEditor.{copyTitle,copyNamedTitle,copyName,copy,delete,deleted,deleteDialog.*,errors.stockDelete}`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  });

  it("puts a row's actions in one box, the switch, «Категории» and, for a template that is not stock, «Изменить», each a compact secondary button named after its template", async () => {
    await openTemplates(session());
    for (const [name, label, edit] of [
      ["Коробка 58×40", "Выключить", false],
      ["Вода и молоко", "Включить", true],
    ] as const) {
      const buttons = within(rowOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(
        edit ? [label, "Категории", "Изменить"] : [label, "Категории"],
      );
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(
        edit
          ? [
              `${label} шаблон «${name}»`,
              `Категории шаблона «${name}»`,
              `Изменить шаблон «${name}»`,
            ]
          : [`${label} шаблон «${name}»`, `Категории шаблона «${name}»`],
      );
      expect(new Set(buttons.map((button) => button.parentElement)).size).toBe(1);
      for (const button of buttons) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  });

  it("puts a row's actions in one box, the switch, «Категории» and «Изменить», or «Копировать» for a stock template, each a compact secondary button named after its template", async () => {
    await openTemplates(session());
    for (const [name, label, last] of [
      ["Коробка 58×40", "Выключить", "Копировать"],
      ["Вода и молоко", "Включить", "Изменить"],
    ] as const) {
      const buttons = within(rowOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual([label, "Категории", last]);
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        `${label} шаблон «${name}»`,
        `Категории шаблона «${name}»`,
        `${last} шаблон «${name}»`,
      ]);
      expect(new Set(buttons.map((button) => button.parentElement)).size).toBe(1);
      for (const button of buttons) {
```

2. В `apps/standalone/test/editor-failure.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import { HostError } from "../src/host/client.js";
import { editorFailure } from "../src/office/templates/editor-failure.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
```

заменить на

<!-- prettier-ignore -->
```ts

import { HostError } from "../src/host/client.js";
import { deleteFailure, editorFailure } from "../src/office/templates/editor-failure.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
```

3. В `apps/standalone/test/editor-failure.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("a refused template delete", () => {
  it("says whose default it is, that a stock template stays, that the template is gone, and the rest by its code", () => {
    expect(
      deleteFailure(
        api("conflict", {
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [13, 8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: false, categories: [13, 8] } });
    expect(deleteFailure(api("conflict", { constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.stockDelete",
    });
    expect(deleteFailure(api("not_found"))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.missing",
    });
    expect(deleteFailure(api("forbidden"))).toStrictEqual({
      kind: "alert",
      message: "errors.api.forbidden",
    });
  });
});
```

4. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { resizedSpec } from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
```

заменить на

<!-- prettier-ignore -->
```tsx
import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { resizedSpec, startingSpec } from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
```

5. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    view = await opening(
      stock,
      "⧉Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны».",
    );
    view.unmount();

```

заменить на

<!-- prettier-ignore -->
```tsx
    view = await opening(
      stock,
      "⧉Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны», а изменить — в копии.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    view.unmount();

```

6. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
  });
});

/** «Коробка 58×40» as the host has it: the stock box template. */
function stockBox(): LabelTemplate {
  return {
    id: BOX_58.id,
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    spec: importedSpec(),
    rev: 60,
  };
}

function deleteDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Удалить шаблон?" });
}

describe("copying and deleting a label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("copies a stock template from its row: a new template under «— копия» with the source's purpose, flag, categories and layout", async () => {
    const fake = editSession();
    fake.api.getTemplate.mockResolvedValue({
      ...stockBox(),
      chzProductGroupCodes: [13],
      enabled: false,
    });
    fake.api.createTemplate.mockResolvedValue(created("Коробка 58×40 — копия"));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Коробка 58×40»" });
    expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", BOX_58.id);
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Коробка 58×40 — копия");
    expect(screen.getByRole("combobox", { name: "Назначение" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Коробка 58×40 — копия",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: [13],
      spec: importedSpec(),
    });
    expect(await screen.findByText("Шаблон «Коробка 58×40 — копия» создан.")).toBeTruthy();
  });

  it("copies a template from its editor and keeps the layout when the copy's purpose changes", async () => {
    const fake = editSession();
    // An empty 58×40 box, a new box template's starting layout, which a copy keeps all the same.
    fake.api.getTemplate.mockResolvedValue(milk({ spec: startingSpec("box") }));
    fake.api.createTemplate.mockResolvedValue(created("Молоко 58×40 — копия"));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    await settle();
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toMatchObject({
      purpose: "pallet",
      spec: startingSpec("box"),
    });
  });

  it("deletes a template after a destructive confirmation and lists the templates again with a notice", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(
      within(deleteDialog()).getByText(
        "Шаблон «Молоко 58×40» будет удалён: станции его больше не получат, а товары, у которых он выбран, останутся без этого шаблона. Отменить удаление нельзя.",
      ),
    ).toBeTruthy();
    const submit = within(deleteDialog()).getByRole("button", { name: "Удалить" });
    expect(submit.classList.contains("mk-btn--destructive")).toBe(true);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(fake.api.deleteTemplate).toHaveBeenCalledWith("office-session-token", MILK_ID);
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 58×40» удалён.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("sends nothing when the deletion is cancelled", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.api.deleteTemplate).not.toHaveBeenCalled();
  });

  it("says why a deletion is refused: a default, a stock template, a template already gone", async () => {
    const fake = editSession();
    fake.api.deleteTemplate
      .mockRejectedValueOnce(
        hostError("conflict", {
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [],
        }),
      )
      .mockRejectedValueOnce(hostError("conflict", { constraint: "stock_template" }))
      .mockRejectedValueOnce(hostError("not_found"));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const confirm = async () => {
      await act(async () => {
        fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
      });
      return within(deleteDialog()).getByRole("alert").textContent;
    };
    expect(await confirm()).toBe(
      "✕Шаблон выбран по умолчанию для организации. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
    expect(await confirm()).toBe("✕Типовой шаблон не удаляется: его можно выключить.");
    expect(await confirm()).toBe(
      "✕Шаблона больше нет на хосте: его удалили на другом рабочем месте.",
    );
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: FAIL — 3 файла, `Tests  8 failed | 74 passed (82)`: `TypeError: deleteFailure is not a function`; `Unable to find an accessible element with the role "button" and name "Копировать шаблон «Коробка 58×40»"`, `… name "Копировать"`, трижды `… name "Удалить"`; объяснение типового шаблона без копии; кнопки строки без «Копировать».

- [ ] **Step 3: Копия, удаление и общий загрузчик страниц**

1. В `apps/standalone/src/office/templates/editor-failure.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";
import { defaultConflict, type DefaultConflict } from "./template-text.js";

/** The editor's controls a refusal can go under. */
```

заменить на

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import {
  alertFailure,
  writeFailure,
  type FieldMessage,
  type WriteFailure,
} from "../form-errors.js";
import { defaultConflict, type DefaultConflict, type TemplateFailure } from "./template-text.js";

/** The editor's controls a refusal can go under. */
```

2. В `apps/standalone/src/office/templates/editor-failure.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return writeFailure(error, EDITOR_FIELDS);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  return writeFailure(error, EDITOR_FIELDS);
}

/**
 * A refused delete, above the dialog: a default says whose (`template_is_default`),
 * a stock template is never deleted (`stock_template`), a template deleted
 * elsewhere is gone (`not_found`, which the host answers only for an id it
 * never had, so this is defensive), the rest is explained by its code.
 */
export function deleteFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError) {
    if (error.code === "conflict" && error.details.constraint === "stock_template") {
      return { kind: "alert", message: "office.templateEditor.errors.stockDelete" };
    }
    if (error.code === "not_found") {
      return { kind: "alert", message: "office.templateEditor.errors.missing" };
    }
  }
  return alertFailure(error);
}
```

3. Создать `apps/standalone/src/office/templates/DeleteTemplateDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplate } from "../../host/protocol.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { deleteFailure } from "./editor-failure.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import type { TemplateFailure } from "./template-text.js";

export interface DeleteTemplateDialogProps {
  template: Pick<LabelTemplate, "id" | "name">;
  onClose: () => void;
  /** The host deleted the template (204). */
  onDeleted: () => void;
}

/**
 * Deletes a template after saying what it means (`DELETE /v1/office/templates/{id}`,
 * the `destructive` submit): the stations stop getting it, the products that
 * prefer it lose the preference, and there is no undo. A default cannot be
 * deleted (`template_is_default`: the dialog says whose default it is), nor
 * can a stock template; the host answers a delete repeated after a lost
 * answer with 204 again.
 */
export function DeleteTemplateDialog({ template, onClose, onDeleted }: DeleteTemplateDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const remove = useOfficeMutation((api, token, id: string) => api.deleteTemplate(token, id));

  const submit = async () => {
    setFailure(null);
    try {
      await remove.mutateAsync(template.id);
    } catch (error) {
      setFailure(deleteFailure(error));
      return;
    }
    onDeleted();
  };

  return (
    <FormDialog
      title={t("office.templateEditor.deleteDialog.title")}
      submitLabel={t("office.templateEditor.deleteDialog.submit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} />}
    >
      <p>{t("office.templateEditor.deleteDialog.body", { name: template.name })}</p>
    </FormDialog>
  );
}
```

4. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { scopeCodes } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { downloadFile } from "./download.js";
import { editorFailure, type EditorFailure, type EditorField } from "./editor-failure.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { scopeCodes } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { DeleteTemplateDialog } from "./DeleteTemplateDialog.js";
import { downloadFile } from "./download.js";
import { editorFailure, type EditorFailure, type EditorField } from "./editor-failure.js";
```

5. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
  /** Reads the template again after a stale save; the editor then starts afresh. */
  onReload?: () => void;
```

заменить на

<!-- prettier-ignore -->
```tsx
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
  /**
   * A new blank template: its untouched starting layout follows a change of
   * the purpose. A copy keeps its layout whatever the purpose.
   */
  layoutFollowsPurpose?: boolean;
  /** Reads the template again after a stale save; the editor then starts afresh. */
  onReload?: () => void;
```

6. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * template is created (`templateCreate`); a template being changed keeps its
 * purpose and sends what differs and its layout with the opened revision
 * (`templateUpdate`), «Сохранить» staying off until something changed. A
 * saved template takes the office back to «Шаблоны» with a notice, and the
 * list, which holds no layouts, is read again.
 */
export function TemplateEditor({ title, template, opened, onReload }: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
```

заменить на

<!-- prettier-ignore -->
```tsx
 * template is created (`templateCreate`); a template being changed keeps its
 * purpose and sends what differs and its layout with the opened revision
 * (`templateUpdate`), «Сохранить» staying off until something changed; it
 * can be copied («Копировать» opens a copy of the template as the host has
 * it) or deleted. A saved or deleted template takes the office back to
 * «Шаблоны» with a notice, and the list, which holds no layouts, is read
 * again.
 */
export function TemplateEditor({
  title,
  template,
  opened,
  layoutFollowsPurpose = false,
  onReload,
}: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
```

7. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const [importing, setImporting] = useState(false);
  const [sizing, setSizing] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
```

заменить на

<!-- prettier-ignore -->
```tsx
  const [importing, setImporting] = useState(false);
  const [sizing, setSizing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
```

8. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      // An untouched starting layout follows the purpose; anything imported stays.
      spec:
        JSON.stringify(current.spec) === JSON.stringify(startingSpec(current.purpose))
          ? startingSpec(purpose)
```

заменить на

<!-- prettier-ignore -->
```tsx
      // An untouched starting layout follows the purpose; anything imported stays.
      spec:
        layoutFollowsPurpose &&
        JSON.stringify(current.spec) === JSON.stringify(startingSpec(current.purpose))
          ? startingSpec(purpose)
```

9. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      return;
    }
    // The list holds no layouts and is read again; nothing of this template is kept.
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", {
      state: {
        notice: t(
          template === null ? "office.templateEditor.created" : "office.templateEditor.saved",
          { name: saved.name },
        ),
      },
    });
  };

```

заменить на

<!-- prettier-ignore -->
```tsx
      return;
    }
    backToList(
      t(template === null ? "office.templateEditor.created" : "office.templateEditor.saved", {
        name: saved.name,
      }),
    );
  };

  // The list holds no layouts and is read again; nothing of this template is kept.
  const backToList = (notice: string) => {
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", { state: { notice } });
  };

```

10. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        title={title}
        actions={
          <Button variant="secondary" onClick={() => void navigate("/templates")}>
            {t("office.templateEditor.back")}
          </Button>
        }
      />
```

заменить на

<!-- prettier-ignore -->
```tsx
        title={title}
        actions={
          <>
            {template !== null && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void navigate(`/templates/${template.id}/copy`)}
                >
                  {t("office.templateEditor.copy")}
                </Button>
                <Button variant="destructive-outline" onClick={() => setDeleting(true)}>
                  {t("office.templateEditor.delete")}
                </Button>
              </>
            )}
            <Button variant="secondary" onClick={() => void navigate("/templates")}>
              {t("office.templateEditor.back")}
            </Button>
          </>
        }
      />
```

11. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        />
      )}
      {importing && (
        <ImportCodeDialog
```

заменить на

<!-- prettier-ignore -->
```tsx
        />
      )}
      {template !== null && deleting && (
        <DeleteTemplateDialog
          template={template}
          onClose={() => setDeleting(false)}
          onDeleted={() => backToList(t("office.templateEditor.deleted", { name: template.name }))}
        />
      )}
      {importing && (
        <ImportCodeDialog
```

12. Заменить содержимое `apps/standalone/src/office/templates/TemplateEditorPage.tsx` целиком:

<!-- prettier-ignore -->
```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import type { LabelTemplateSpec } from "@markiro/domain";
import { Alert, Button, PageHeader } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { LabelTemplate } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { scopeOf } from "./category-scope.js";
import { readSpec, startingSpec } from "./editor-model.js";
import { TemplateEditor } from "./TemplateEditor.js";

/**
 * «Новый шаблон» (`/templates/new`): an enabled box template for every
 * category with an empty 58×40 label, and no name until one is typed or a
 * JSON import brings one.
 */
export function NewTemplatePage() {
  const { t } = useTranslation();
  return (
    <TemplateEditor
      title={t("office.templateEditor.newTitle")}
      template={null}
      opened={{
        name: "",
        purpose: "box",
        enabled: true,
        scope: { mode: "all", codes: [] },
        spec: startingSpec("box"),
      }}
      layoutFollowsPurpose
    />
  );
}

/** A page that cannot show the editor: why, a copy where one helps, and the way back. */
function EditorUnavailable({
  title,
  message,
  copyOf,
}: {
  title: string;
  message: string;
  /** The template to offer a copy of. */
  copyOf?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            {copyOf !== undefined && (
              <Button
                variant="secondary"
                onClick={() => void navigate(`/templates/${copyOf}/copy`)}
              >
                {t("office.templateEditor.copy")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void navigate("/templates")}>
              {t("office.templateEditor.back")}
            </Button>
          </>
        }
      />
      <Alert tone="warn">{message}</Alert>
    </>
  );
}

/**
 * The template a page opens (`/templates/:id`, `/templates/:id/copy`), read
 * with its layout whenever the page opens and passed on only once read on
 * this visit, so a save works on what is on screen. A template deleted
 * elsewhere is said to be gone and a layout the domain cannot read is not
 * shown; `render` gets the template, its layout and a way to read it again.
 */
function OpenedTemplate({
  title,
  render,
}: {
  title: string;
  render: (template: LabelTemplate, spec: LabelTemplateSpec, reload: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const template = useOfficeQuery(officeKeys.template(id), (api, token) =>
    api.getTemplate(token, id),
  );
  if (template.isError) {
    if (template.error instanceof HostError && template.error.code === "not_found") {
      return <EditorUnavailable title={title} message={t("office.templateEditor.gone")} />;
    }
    return (
      <>
        <PageHeader title={title} />
        <LoadError error={template.error} onRetry={() => void template.refetch()} />
      </>
    );
  }
  if (!template.isFetchedAfterMount || template.data === undefined) return <PageLoading />;
  const spec = readSpec(template.data.spec);
  if (spec === null) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.unreadable")} />;
  }
  return render(template.data, spec, () => void template.refetch());
}

/**
 * A template opened for a change (`/templates/:id`). A stock template keeps
 * its name and layout, so it offers a copy instead. After a stale save the
 * template is read again and the editor starts afresh with it (`key`).
 */
export function EditTemplatePage() {
  const { t } = useTranslation();
  const title = t("office.templateEditor.editTitle");
  return (
    <OpenedTemplate
      title={title}
      render={(template, spec, reload) =>
        template.stock ? (
          <EditorUnavailable
            title={title}
            message={t("office.templateEditor.stockLocked")}
            copyOf={template.id}
          />
        ) : (
          <TemplateEditor
            key={template.rev}
            title={t("office.templateEditor.namedTitle", { name: template.name })}
            template={template}
            opened={{
              name: template.name,
              purpose: template.purpose,
              enabled: template.enabled,
              scope: scopeOf(template.chzProductGroupCodes),
              spec,
            }}
            onReload={reload}
          />
        )
      }
    />
  );
}

/**
 * A copy of a template (`/templates/:id/copy`), stock ones included: a new
 * template with the source's purpose, flag, categories and layout under
 * «<name> — копия», saved as an ordinary create. The purpose may change and
 * the layout stays.
 */
export function CopyTemplatePage() {
  const { t } = useTranslation();
  return (
    <OpenedTemplate
      title={t("office.templateEditor.copyTitle")}
      render={(source, spec) => (
        <TemplateEditor
          title={t("office.templateEditor.copyNamedTitle", { name: source.name })}
          template={null}
          opened={{
            name: t("office.templateEditor.copyName", { name: source.name }),
            purpose: source.purpose,
            enabled: source.enabled,
            scope: scopeOf(source.chzProductGroupCodes),
            spec,
          }}
        />
      )}
    />
  );
}
```

13. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import { EditTemplatePage, NewTemplatePage } from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import {
  CopyTemplatePage,
  EditTemplatePage,
  NewTemplatePage,
} from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";
```

14. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "templates/:id", element: <EditTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "templates/:id", element: <EditTemplatePage /> },
      { path: "templates/:id/copy", element: <CopyTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
```

15. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
            {t("office.templates.categories")}
          </Button>
          {/* A stock template keeps its name and layout (the host refuses a change). */}
          {!template.stock && (
            <Button
              variant="secondary"
```

заменить на

<!-- prettier-ignore -->
```tsx
            {t("office.templates.categories")}
          </Button>
          {/* A stock template keeps its name and layout (the host refuses a change): it is copied. */}
          {template.stock ? (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.templates.copyNamed", { name: template.name })}
              onClick={() => void navigate(`/templates/${template.id}/copy`)}
            >
              {t("office.templates.copy")}
            </Button>
          ) : (
            <Button
              variant="secondary"
```

16. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "edit": "Изменить",
      "editNamed": "Изменить шаблон «{{name}}»",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
```

заменить на

<!-- prettier-ignore -->
```json
      "edit": "Изменить",
      "editNamed": "Изменить шаблон «{{name}}»",
      "copy": "Копировать",
      "copyNamed": "Копировать шаблон «{{name}}»",
      "size": "{{width}} × {{height}} мм",
      "dpi": "{{dpi}} dpi",
```

17. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "editTitle": "Шаблон",
      "namedTitle": "Шаблон «{{name}}»",
      "gone": "Шаблона нет на хосте: его удалили на другом рабочем месте.",
      "stockLocked": "Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны».",
      "unreadable": "Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
      "back": "К шаблонам",
```

заменить на

<!-- prettier-ignore -->
```json
      "editTitle": "Шаблон",
      "namedTitle": "Шаблон «{{name}}»",
      "copyTitle": "Копия шаблона",
      "copyNamedTitle": "Копия шаблона «{{name}}»",
      "copyName": "{{name}} — копия",
      "copy": "Копировать",
      "delete": "Удалить",
      "gone": "Шаблона нет на хосте: его удалили на другом рабочем месте.",
      "stockLocked": "Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны», а изменить — в копии.",
      "unreadable": "Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
      "back": "К шаблонам",
```

18. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "created": "Шаблон «{{name}}» создан.",
      "saved": "Шаблон «{{name}}» сохранён.",
      "sizeDialog": {
        "title": "Размер этикетки",
```

заменить на

<!-- prettier-ignore -->
```json
      "created": "Шаблон «{{name}}» создан.",
      "saved": "Шаблон «{{name}}» сохранён.",
      "deleted": "Шаблон «{{name}}» удалён.",
      "deleteDialog": {
        "title": "Удалить шаблон?",
        "body": "Шаблон «{{name}}» будет удалён: станции его больше не получат, а товары, у которых он выбран, останутся без этого шаблона. Отменить удаление нельзя.",
        "submit": "Удалить"
      },
      "sizeDialog": {
        "title": "Размер этикетки",
```

19. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "specRejected": "Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.",
        "stock": "Типовой шаблон не переименовывается и не меняет макет: сделайте копию.",
        "missing": "Шаблона больше нет на хосте: его удалили на другом рабочем месте."
      }
```

заменить на

<!-- prettier-ignore -->
```json
        "specRejected": "Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.",
        "stock": "Типовой шаблон не переименовывается и не меняет макет: сделайте копию.",
        "stockDelete": "Типовой шаблон не удаляется: его можно выключить.",
        "missing": "Шаблона больше нет на хосте: его удалили на другом рабочем месте."
      }
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: PASS — 3 файла, 82 теста (`templates-page` 47, `editor-failure` 5, `template-editor` 30).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx`
Expected: PASS, 82; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 82; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateEditorPage.tsx` называть копию как исходный шаблон: фрагмент

<!-- prettier-ignore -->
```tsx
            name: t("office.templateEditor.copyName", { name: source.name }),
```

заменить на

<!-- prettier-ignore -->
```tsx
            name: source.name,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "copies a stock template"`
Expected: FAIL — `× copies a stock template from its row: …`, `expected <input …> to have property "value" with value 'Коробка 58×40 — копия'`.

Мутация 2. В `apps/standalone/src/office/templates/TemplateEditor.tsx` менять макет копии со сменой назначения: удалить фрагмент

<!-- prettier-ignore -->
```tsx
        layoutFollowsPurpose &&
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "keeps the layout when the copy"`
Expected: FAIL — `× copies a template from its editor and keeps the layout when the copy's purpose changes`, `Unable to find an element with the text: Размер: 58 × 40 мм · 203 dpi`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateEditorPage.tsx` не предлагать копию у типового шаблона: удалить фрагмент

<!-- prettier-ignore -->
```tsx
            copyOf={template.id}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "cannot open"`
Expected: FAIL — `× explains a template it cannot open: …`, `Unable to find an accessible element with the role "button" and name "Копировать"`.

Мутация 4. В `apps/standalone/src/office/templates/DeleteTemplateDialog.tsx` спрашивать об удалении лёгким окном: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      submitVariant="destructive"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "destructive confirmation"`
Expected: FAIL — `× deletes a template after a destructive confirmation and lists the templates again with a notice`, `expected false to be true`.

Мутация 5. В `apps/standalone/src/office/templates/DeleteTemplateDialog.tsx` закрывать окно вместо возврата к списку: фрагмент

<!-- prettier-ignore -->
```tsx
    onDeleted();
```

заменить на

<!-- prettier-ignore -->
```tsx
    onClose();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "destructive confirmation"`
Expected: FAIL — тот же тест, `Unable to find role="heading" and name "Шаблоны этикеток"`.

Мутация 6. В `apps/standalone/src/office/templates/editor-failure.ts` объяснять отказ типового шаблона общим текстом: фрагмент

<!-- prettier-ignore -->
```ts
      return { kind: "alert", message: "office.templateEditor.errors.stockDelete" };
```

заменить на

<!-- prettier-ignore -->
```ts
      return { kind: "alert", message: "errors.api.conflict" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx test/editor-failure.test.ts -t "deletion is refused|refused template delete"`
Expected: FAIL — `Tests  2 failed`: `× says whose default it is, that a stock template stays, …` и `× says why a deletion is refused: …` (`expected '✕Такая запись уже есть.' to be '✕Типовой шаблон не удаляется: его мож…'`).

Мутация 7. В `apps/standalone/src/office/templates/TemplatesPage.tsx` показывать «Изменить» вместо «Копировать» у типового шаблона: фрагмент

<!-- prettier-ignore -->
```tsx
          {template.stock ? (
```

заменить на

<!-- prettier-ignore -->
```tsx
          {false ? (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "«Копировать» for a stock template"`
Expected: FAIL — `× puts a row's actions in one box, …`, `expected [ Array(3) ] to deeply equal [ 'Выключить', 'Категории', …(1) ]`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/templates-page.test.tsx apps/standalone/test/editor-failure.test.ts apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/editor-failure.ts apps/standalone/src/office/templates/DeleteTemplateDialog.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1185 тестов (1179 + 6).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/templates-page.test.tsx apps/standalone/test/editor-failure.test.ts apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/editor-failure.ts apps/standalone/src/office/templates/DeleteTemplateDialog.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/templates/TemplateEditorPage.tsx apps/standalone/src/office/routes.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/i18n/ru.json
git commit -m "feat(standalone): копия и удаление шаблона этикетки" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Редактор спрашивает, прежде чем уйти с несохранёнными правками (D6)

Любой уход со страницы редактора на другую страницу при несохранённых правках — «К шаблонам», пункт меню, «Копировать» — спрашивает «Уйти со страницы?» (`useBlocker` маршрутизатора, `destructive` «Уйти без сохранения», «Отмена» оставляет правки). После сохранения и удаления редактор уходит сам и не спрашивает (`leaving` ставится в `backToList` до перехода). Конец сессии размонтирует офис без вопроса, как записано в `AGENTS.md`. Прежний тест «шаблона больше нет» теперь подтверждает уход: правки после отказа всё ещё не сохранены.

**Files:**

- Modify: `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/template-editor.test.tsx` (Modify)

**Interfaces:**

- Consumes: `useBlocker`, `type BlockerFunction` — `react-router`; `FormDialog`; `draftChanged`.
- Produces: окно «Уйти со страницы?»; ключи `office.templateEditor.leave.*`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    );
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
```

заменить на

<!-- prettier-ignore -->
```tsx
    );
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    // The edits are still unsaved, so leaving asks first.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
```

2. В `apps/standalone/test/template-editor.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });
});

function leaveDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Уйти со страницы?" });
}

describe("leaving a label template with unsaved changes", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("asks before «К шаблонам» drops the changes, and «Отмена» keeps them", async () => {
    const fake = editSession();
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    expect(
      within(leaveDialog()).getByText("Изменения шаблона не сохранены и пропадут."),
    ).toBeTruthy();
    const leave = within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" });
    expect(leave.classList.contains("mk-btn--destructive")).toBe(true);
    fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
  });

  it("asks before the menu and «Копировать» leave a changed template too", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    expect(leaveDialog()).toBeTruthy();
    fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(leaveDialog()).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
  });

  it("leaves without asking when nothing changed, a new template is untouched, or after a delete", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
    await settle();
    type("Название", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» удалён.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx`
Expected: FAIL — 1 файл, `Tests  3 failed | 30 passed (33)`: `Unable to find an accessible element with the role "dialog" and name "Уйти со страницы?"` (дважды) и `… name "Уйти без сохранения"` в прежнем тесте «шаблона больше нет».

- [ ] **Step 3: Блокировщик ухода**

1. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useNavigate, type BlockerFunction } from "react-router";

import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";
```

2. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { scopeCodes } from "./category-scope.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { scopeCodes } from "./category-scope.js";
```

3. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const dirty = draftChanged(opened, draft);
  const duplicateInvalid = duplicateLayoutInvalid(draft.spec, draft.purpose);

  useEffect(() => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  const dirty = draftChanged(opened, draft);
  const duplicateInvalid = duplicateLayoutInvalid(draft.spec, draft.purpose);
  // Set right before the editor leaves on its own, after a save or a delete.
  const leaving = useRef(false);
  // Any navigation to another page with unsaved changes asks first: the
  // header's «К шаблонам», the menu, «Копировать». The end of the session
  // unmounts the office instead, and its edits are lost (`AGENTS.md`).
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  useEffect(() => {
```

4. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const backToList = (notice: string) => {
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", { state: { notice } });
  };
```

заменить на

<!-- prettier-ignore -->
```tsx
  const backToList = (notice: string) => {
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    leaving.current = true;
    void navigate("/templates", { state: { notice } });
  };
```

5. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        />
      )}
    </>
  );
```

заменить на

<!-- prettier-ignore -->
```tsx
        />
      )}
      {blocker.state === "blocked" && (
        <FormDialog
          title={t("office.templateEditor.leave.title")}
          submitLabel={t("office.templateEditor.leave.submit")}
          submitVariant="destructive"
          onSubmit={() => {
            blocker.proceed();
            return Promise.resolve();
          }}
          onClose={() => blocker.reset()}
        >
          <p>{t("office.templateEditor.leave.body")}</p>
        </FormDialog>
      )}
    </>
  );
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "saved": "Шаблон «{{name}}» сохранён.",
      "deleted": "Шаблон «{{name}}» удалён.",
      "deleteDialog": {
        "title": "Удалить шаблон?",
```

заменить на

<!-- prettier-ignore -->
```json
      "saved": "Шаблон «{{name}}» сохранён.",
      "deleted": "Шаблон «{{name}}» удалён.",
      "leave": {
        "title": "Уйти со страницы?",
        "body": "Изменения шаблона не сохранены и пропадут.",
        "submit": "Уйти без сохранения"
      },
      "deleteDialog": {
        "title": "Удалить шаблон?",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx`
Expected: PASS — 1 файл, 33 теста.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-editor.test.tsx`
Expected: PASS, 33; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 33; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не отмечать уход после сохранения: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    leaving.current = true;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "creates the template"`
Expected: FAIL — `× creates the template from the trimmed name, …`, `Unable to find role="heading" and name "Шаблоны этикеток"`: уход после сохранения остановлен вопросом.

Мутация 2. В `apps/standalone/src/office/templates/TemplateEditor.tsx` спрашивать и без правок: фрагмент

<!-- prettier-ignore -->
```tsx
        dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
```

заменить на

<!-- prettier-ignore -->
```tsx
        !leaving.current && currentLocation.pathname !== nextLocation.pathname,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "leaves without asking"`
Expected: FAIL — `× leaves without asking when nothing changed, a new template is untouched, or after a delete`, `Unable to find role="heading" and name "Шаблоны этикеток"`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateEditor.tsx` никогда не спрашивать: фрагмент

<!-- prettier-ignore -->
```tsx
        dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
```

заменить на

<!-- prettier-ignore -->
```tsx
        false,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "asks before"`
Expected: FAIL — `Tests  2 failed`: `Unable to find an accessible element with the role "dialog" and name "Уйти со страницы?"`.

Мутация 4. В `apps/standalone/src/office/templates/TemplateEditor.tsx` уходить по «Отмена»: фрагмент

<!-- prettier-ignore -->
```tsx
          onClose={() => blocker.reset()}
```

заменить на

<!-- prettier-ignore -->
```tsx
          onClose={() => blocker.proceed()}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "«Отмена» keeps them"`
Expected: FAIL — `× asks before «К шаблонам» drops the changes, and «Отмена» keeps them`, `Unable to find a label with the text of: Название`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateEditor.tsx` спрашивать лёгкой кнопкой: фрагмент

<!-- prettier-ignore -->
```tsx
          submitVariant="destructive"
          onSubmit={() => {
            blocker.proceed();
```

заменить на

<!-- prettier-ignore -->
```tsx
          onSubmit={() => {
            blocker.proceed();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-editor.test.tsx -t "«Отмена» keeps them"`
Expected: FAIL — тот же тест, `expected false to be true`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1188 тестов (1185 + 3).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/template-editor.test.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json
git commit -m "feat(standalone): редактор шаблона спрашивает, прежде чем уйти с несохранёнными правками" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: «Шаблоны»: шаблон, удалённый на другом рабочем месте, и один порядок названий (пункты 1e3 «Перенесено»)

Два хвоста плана 1e3, которые приходят с удалением и копией. Окна «Выключить…» и «Категории» на ответ `not_found` (шаблон удалили на другом рабочем месте, пока список был открыт) говорят «Шаблона больше нет на хосте…» (`templateFailure` теперь знает `not_found`), остаются открытыми и перечитывают список под собой (`onMissing`), поэтому строка исчезает. Одинаковые названия станут обычными с копией и переименованием, поэтому порядок «по названию, затем по id» выносится в `byNameThenId` (`src/office/records.tsx`) и берётся `activeFirstByName`, `templatesByName` и `templateOptions`: прежде выбор шаблона в товаре и умолчаниях сортировал без id, и два шаблона одного названия могли стоять там иначе, чем на «Шаблонах».

**Files:**

- Modify: `apps/standalone/src/office/records.tsx`, `apps/standalone/src/office/templates/template-list.ts`, `apps/standalone/src/office/template-options.ts`, `apps/standalone/src/office/templates/template-text.ts`, `apps/standalone/src/office/templates/TemplateStateDialog.tsx`, `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx`
- Test: `apps/standalone/test/template-options.test.ts`, `apps/standalone/test/template-text.test.ts`, `apps/standalone/test/templates-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `HostError`.
- Produces: `byNameThenId(a: { id; name }, b: { id; name }): number` — `src/office/records.tsx`; `onMissing?: () => void` у `TemplateStateDialog` и `TemplateCategoriesDialog`; `templateFailure` отвечает на `not_found` ключом `office.templateEditor.errors.missing`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/template-options.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    ]);
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    ]);
  });

  it("put templates of the same name in the order of their ids, as «Шаблоны» lists them", () => {
    const later = summary("9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c", "Коробка 58×40");
    const earlier = summary("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "Коробка 58×40");
    for (const list of [
      [later, earlier],
      [earlier, later],
    ]) {
      expect(templateOptions(list, "box", null, [], t).map((option) => option.value)).toStrictEqual(
        ["", earlier.id, later.id],
      );
    }
  });
});
```

2. В `apps/standalone/test/template-text.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      message: "errors.api.conflict",
    });
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
      message: "errors.api.conflict",
    });
  });

  it("says a template deleted on another workstation is gone", () => {
    expect(
      templateFailure(
        new HostError({ kind: "api", code: "not_found", status: 404, message: "gone" }),
      ),
    ).toStrictEqual({ kind: "alert", message: "office.templateEditor.errors.missing" });
  });
});
```

3. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    const notice = await screen.findByText(`Категории шаблона «${name}» сохранены.`);
    expect(notice.closest(".mk-alert")?.querySelector("b, i")).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    const notice = await screen.findByText(`Категории шаблона «${name}» сохранены.`);
    expect(notice.closest(".mk-alert")?.querySelector("b, i")).toBeNull();
  });
});

describe("office label templates: a template deleted on another workstation", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("says so in either dialog, keeps the dialog open and reads the list again, which drops the row", async () => {
    for (const [action, title] of [
      ["Выключить шаблон «Молоко 58×40»", "Выключить шаблон?"],
      ["Категории шаблона «Молоко 58×40»", "Категории шаблона «Молоко 58×40»"],
    ] as const) {
      const fake = session();
      fake.api.updateTemplate.mockRejectedValue(hostError("not_found", 404));
      const view = renderOffice(fake);
      fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
      fireEvent.click(await screen.findByRole("button", { name: action }));
      fake.api.listTemplates.mockResolvedValue(TEMPLATES.filter((each) => each.id !== MILK.id));
      const submit = within(dialog()).getByRole("button", {
        name: title === "Выключить шаблон?" ? "Выключить" : "Сохранить",
      });
      if (title !== "Выключить шаблон?") {
        fireEvent.click(within(dialog()).getByRole("radio", { name: "Все категории" }));
      }
      await act(async () => {
        fireEvent.click(submit);
      });
      expect(within(dialog()).getByRole("alert").textContent).toBe(
        "✕Шаблона больше нет на хосте: его удалили на другом рабочем месте.",
      );
      expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
      await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.queryByText("Молоко 58×40", { selector: "td span" })).toBeNull(),
      );
      view.unmount();
    }
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-options.test.ts test/template-text.test.ts test/templates-page.test.tsx`
Expected: FAIL — 3 файла, `Tests  3 failed | 61 passed (64)`: порядок двух шаблонов одного названия (`expected [ '', …(2) ] to strictly equal [ '', …(2) ]`), `templateFailure` для `not_found` (`expected { kind: 'alert', …(1) } to strictly equal { kind: 'alert', …(1) }`) и окно (`expected '✕Запись не найдена.' to be '✕Шаблона больше нет на хосте: его уда…'`).

- [ ] **Step 3: Общий порядок и отказ `not_found` в окнах списка**

1. В `apps/standalone/src/office/records.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

/**
 * Active records before archived ones, each group by name (`NAMES`), then by
 * id so equal names keep one order. The host sorts bytewise («Линия 10»
 * before «Линия 2»), so a page sorts what it shows itself.
 */
export function activeFirstByName<T extends ArchivableRecord>(records: readonly T[]): T[] {
  return [...records].sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      NAMES.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

```

заменить на

<!-- prettier-ignore -->
```tsx

/**
 * Records by name (`NAMES`), then by id so equal names keep one order: the
 * one order of names in the office's lists and choices. The host sorts
 * bytewise («Линия 10» before «Линия 2»), so a page sorts what it shows itself.
 */
export function byNameThenId(
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  return NAMES.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Active records before archived ones, each group by name, then by id (`byNameThenId`). */
export function activeFirstByName<T extends ArchivableRecord>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => Number(a.archived) - Number(b.archived) || byNameThenId(a, b));
}

```

2. В `apps/standalone/src/office/templates/template-list.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { LabelTemplate, LabelTemplateSummary, TemplatePurpose } from "../../host/protocol.js";

/** What the purpose filter keeps. */
```

заменить на

<!-- prettier-ignore -->
```ts
import type { LabelTemplate, LabelTemplateSummary, TemplatePurpose } from "../../host/protocol.js";
import { byNameThenId } from "../records.js";

/** What the purpose filter keeps. */
```

3. В `apps/standalone/src/office/templates/template-list.ts`, фрагмент

<!-- prettier-ignore -->
```ts
}

/** Template names in Russian order, with numbers by value: «Коробка 58×40» before «Коробка 100×100». */
const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * Templates by name (`NAMES`), then by id so equal names keep one order. The
 * host sorts bytewise, and a write changes the cached list in place, so a page
 * sorts what it shows itself.
```

заменить на

<!-- prettier-ignore -->
```ts
}

/**
 * Templates by name with numbers by value («Коробка 58×40» before «Коробка
 * 100×100»), then by id so equal names keep one order (`byNameThenId`). The
 * host sorts bytewise, and a write changes the cached list in place, so a page
 * sorts what it shows itself.
```

4. В `apps/standalone/src/office/templates/template-list.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  templates: readonly T[],
): T[] {
  return [...templates].sort(
    (a, b) => NAMES.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

```

заменить на

<!-- prettier-ignore -->
```ts
  templates: readonly T[],
): T[] {
  return [...templates].sort(byNameThenId);
}

```

5. В `apps/standalone/src/office/template-options.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { LabelTemplateSummary, TemplatePurpose } from "../host/protocol.js";
import { templateFitsSlot } from "../lib/template-eligibility.js";

/** Template names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface TemplateOption {
```

заменить на

<!-- prettier-ignore -->
```ts
import type { LabelTemplateSummary, TemplatePurpose } from "../host/protocol.js";
import { templateFitsSlot } from "../lib/template-eligibility.js";
import { byNameThenId } from "./records.js";

export interface TemplateOption {
```

6. В `apps/standalone/src/office/template-options.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * that fits the slot for the category (`templateFitsSlot`: enabled, of the
 * slot's purpose, covering the category; `null` is a product without a group
 * and the organization's slot), by name. Each id in `kept` that does not fit
 * stays a choice of its own, marked: the loaded choice, which a template
 * disabled or narrowed since, or a category changed in the form, does not
```

заменить на

<!-- prettier-ignore -->
```ts
 * that fits the slot for the category (`templateFitsSlot`: enabled, of the
 * slot's purpose, covering the category; `null` is a product without a group
 * and the organization's slot), by name, then by id, as «Шаблоны» lists them
 * (`byNameThenId`). Each id in `kept` that does not fit
 * stays a choice of its own, marked: the loaded choice, which a template
 * disabled or narrowed since, or a category changed in the form, does not
```

7. В `apps/standalone/src/office/template-options.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const options: TemplateOption[] = [
    { value: "", label: t("office.templateChoice.none") },
```

заменить на

<!-- prettier-ignore -->
```ts
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort(byNameThenId);
  const options: TemplateOption[] = [
    { value: "", label: t("office.templateChoice.none") },
```

8. В `apps/standalone/src/office/templates/template-text.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export type TemplateFailure = AlertFailure | { kind: "default"; conflict: DefaultConflict };

export function templateFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  return conflict === null ? alertFailure(error) : { kind: "default", conflict };
}
```

заменить на

<!-- prettier-ignore -->
```ts
export type TemplateFailure = AlertFailure | { kind: "default"; conflict: DefaultConflict };

/**
 * A refused write of a row's template: the defaults in its way, a template
 * deleted on another workstation since the list was read (`not_found`), or
 * what `alertFailure` makes of it.
 */
export function templateFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError && error.code === "not_found") {
    return { kind: "alert", message: "office.templateEditor.errors.missing" };
  }
  return alertFailure(error);
}
```

9. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
```

10. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
}

```

заменить на

<!-- prettier-ignore -->
```tsx
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
  /** The host has no such template any more: the list is read again under the dialog. */
  onMissing?: () => void;
}

```

11. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  onSaved,
  onReload,
}: TemplateStateDialogProps) {
  const { t } = useTranslation();
```

заменить на

<!-- prettier-ignore -->
```tsx
  onSaved,
  onReload,
  onMissing,
}: TemplateStateDialogProps) {
  const { t } = useTranslation();
```

12. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      setFailure(templateFailure(error));
      return;
    }
```

заменить на

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      setFailure(templateFailure(error));
      if (error instanceof HostError && error.code === "not_found") onMissing?.();
      return;
    }
```

13. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
```

14. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
}

```

заменить на

<!-- prettier-ignore -->
```tsx
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
  /** The host has no such template any more: the list is read again under the dialog. */
  onMissing?: () => void;
}

```

15. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  onSaved,
  onReload,
}: TemplateCategoriesDialogProps) {
  const { t } = useTranslation();
```

заменить на

<!-- prettier-ignore -->
```tsx
  onSaved,
  onReload,
  onMissing,
}: TemplateCategoriesDialogProps) {
  const { t } = useTranslation();
```

16. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      setFailure(templateFailure(error));
      return;
    }
```

заменить на

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      setFailure(templateFailure(error));
      if (error instanceof HostError && error.code === "not_found") onMissing?.();
      return;
    }
```

17. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    void templates.refetch();
  };

  const columns: TableColumn<LabelTemplateSummary>[] = [
```

заменить на

<!-- prettier-ignore -->
```tsx
    void templates.refetch();
  };
  // A template deleted elsewhere leaves the list; the dialog stays and says why.
  const missing = () => void templates.refetch();

  const columns: TableColumn<LabelTemplateSummary>[] = [
```

18. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
            )
          }
          onReload={reload}
        />
      )}
      {canEdit && dialog?.kind === "categories" && (
```

заменить на

<!-- prettier-ignore -->
```tsx
            )
          }
          onReload={reload}
          onMissing={missing}
        />
      )}
      {canEdit && dialog?.kind === "categories" && (
```

19. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          }
          onReload={reload}
        />
      )}
```

заменить на

<!-- prettier-ignore -->
```tsx
          }
          onReload={reload}
          onMissing={missing}
        />
      )}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-options.test.ts test/template-text.test.ts test/templates-page.test.tsx`
Expected: PASS — 3 файла, 64 теста (`template-options` 4, `template-text` 12, `templates-page` 48).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-options.test.ts test/template-text.test.ts test/templates-page.test.tsx`
Expected: PASS, 64; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 64; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/template-options.ts` сортировать выбор шаблона без id: фрагмент

<!-- prettier-ignore -->
```ts
    .sort(byNameThenId);
```

заменить на

<!-- prettier-ignore -->
```ts
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-options.test.ts -t "same name"`
Expected: FAIL — `× put templates of the same name in the order of their ids, as «Шаблоны» lists them`, `expected [ '', …(2) ] to strictly equal [ '', …(2) ]`.

Мутация 2. В `apps/standalone/src/office/templates/template-text.ts` не узнавать `not_found`: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (error instanceof HostError && error.code === "not_found") {
    return { kind: "alert", message: "office.templateEditor.errors.missing" };
  }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-text.test.ts test/templates-page.test.tsx -t "deleted on another workstation"`
Expected: FAIL — `Tests  2 failed`: `× says a template deleted on another workstation is gone` и `× says so in either dialog, …` (`expected '✕Запись не найдена.' to be '✕Шаблона больше нет на хосте: его уда…'`).

Мутация 3. В `apps/standalone/src/office/templates/TemplateStateDialog.tsx` не перечитывать список из окна включения: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (error instanceof HostError && error.code === "not_found") onMissing?.();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "deleted on another workstation"`
Expected: FAIL — `× says so in either dialog, keeps the dialog open and reads the list again, which drops the row`, `expected "vi.fn()" to be called 2 times, but got 1 times`.

Мутация 4. В `apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx` не перечитывать список из окна категорий: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (error instanceof HostError && error.code === "not_found") onMissing?.();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "deleted on another workstation"`
Expected: FAIL — тот же тест, то же сообщение.

Мутация 5. В `apps/standalone/src/office/records.tsx` снять id из общего порядка: фрагмент

<!-- prettier-ignore -->
```tsx
  return NAMES.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
```

заменить на

<!-- prettier-ignore -->
```tsx
  return NAMES.compare(a.name, b.name);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-options.test.ts test/template-list.test.ts test/records.test.tsx`
Expected: FAIL — `Tests  3 failed | 17 passed (20)`: `× sorts by name with numbers by value, then by id, …`, `× orders records with equal names by id, …`, `× put templates of the same name in the order of their ids, …`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/test/template-options.test.ts apps/standalone/test/template-text.test.ts apps/standalone/test/templates-page.test.tsx apps/standalone/src/office/records.tsx apps/standalone/src/office/templates/template-list.ts apps/standalone/src/office/template-options.ts apps/standalone/src/office/templates/template-text.ts apps/standalone/src/office/templates/TemplateStateDialog.tsx apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1191 тест (1188 + 3).

<!-- prettier-ignore -->
```bash
git add apps/standalone/test/template-options.test.ts apps/standalone/test/template-text.test.ts apps/standalone/test/templates-page.test.tsx apps/standalone/src/office/records.tsx apps/standalone/src/office/templates/template-list.ts apps/standalone/src/office/template-options.ts apps/standalone/src/office/templates/template-text.ts apps/standalone/src/office/templates/TemplateStateDialog.tsx apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx apps/standalone/src/office/templates/TemplatesPage.tsx
git commit -m "fix(standalone): «Шаблоны» — шаблон, удалённый на другом рабочем месте, и один порядок названий" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Документы: редактор шаблона в `AGENTS.md` и спецификации

Задачи 1–8 меняли только код и тесты; эта задача приводит к ним документы. `AGENTS.md` «Catalog and label templates» говорит, что редактор плана 1e4 есть и что предпросмотр, выгрузки кода и миниатюры — часть 1e4b; «Protocol» — что редактор зовёт `templateCreate` и `templateUpdate` с макетом; «Office pages» — общий порядок шаблонов (`byNameThenId`), новые действия «Шаблонов» и `not_found` в их окнах, и отдельный пункт о редакторе. Спецификация §5.5 — то же по-русски, отдельным пунктом «Редактор шаблона (план 1e4)». Комментарии `src/host/protocol.ts`, `CategoryScopeField.tsx` и `TemplatesPage.tsx` перестают говорить о редакторе в будущем времени. Строка §8 («1e4 (редактор шаблона)») остаётся верной и не меняется.

**Files:**

- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Protocol», «Office pages»), `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5), `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/office/templates/CategoryScopeField.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx` (комментарии)

**Interfaces:**

- Consumes: задачи 1–8.
- Produces: документы; кода не меняет.

- [ ] **Step 1: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
the wizard's stock templates (above) and the office's «Шаблоны» and
«Умолчания шаблонов» pages («Office pages»), which call `listTemplates`,
`updateTemplate`, `getTemplateDefaults` and `updateTemplateDefaults`. The
template editor (creating, copying and renaming a template, importing
ZPL/TSPL/JSON, the size form, the preview, downloads and deleting) is plan
1e4's, with `getTemplate`, `createTemplate` and `deleteTemplate`, whose
methods and builders are in place.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
the wizard's stock templates (above) and the office's «Шаблоны» and
«Умолчания шаблонов» pages («Office pages»), which call `listTemplates`,
`updateTemplate`, `getTemplateDefaults` and `updateTemplateDefaults`. Plan
1e4 added the template editor («Office pages»), which calls `getTemplate`,
`createTemplate`, `updateTemplate` with a layout and `deleteTemplate`, and
checks a layout against `labelTemplateSpecSchema` before it saves. Its first
part draws no layout: the preview, the ZPL and TSPL downloads and the list's
thumbnails come with its second part (1e4b), with the rasterizer and the
`opentype.js` dependency.

## Reference sync
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
The catalog's builders (plan 1e2) cover the template routes too, which plan
1e3's pages call (`templateUpdate` for a flag or categories,
`templateDefaultsUpdate`) and plan 1e4's editor will (`templateCreate`, a
layout through `templateUpdate`): `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateCreate` sends the name, the purpose,
```

заменить на

<!-- prettier-ignore -->
```text
The catalog's builders (plan 1e2) cover the template routes too, which plan
1e3's pages call (`templateUpdate` for a flag or categories,
`templateDefaultsUpdate`) and plan 1e4's editor calls (`templateCreate`, a
layout through `templateUpdate`): `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateCreate` sends the name, the purpose,
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
- Lists of archivable records (counterparties, lines, products) show active
  records before archived ones, each by name in Russian order with numbers by
  value (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2».
- «Контрагенты» is read by every role and changed by administrators. An edit
  sends the whole record with `expectedRev`; archiving is the dialog's «В
```

заменить на

<!-- prettier-ignore -->
```text
- Lists of archivable records (counterparties, lines, products) show active
  records before archived ones, each by name in Russian order with numbers by
  value, then by id (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2». Templates take the same order on
  «Шаблоны» and in every template choice (`byNameThenId`), so two templates of
  one name, which a copy or a rename can make, keep one order everywhere.
- «Контрагенты» is read by every role and changed by administrators. An edit
  sends the whole record with `expectedRev`; archiving is the dialog's «В
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards with
  thumbnails (nothing here renders a layout), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
```

заменить на

<!-- prettier-ignore -->
```text
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards with
  thumbnails (no layout is drawn before 1e4b), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
```

5. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  «Загрузить заново», which closes the dialog and reads the list again.
  «Категории» opens a dialog on `CategoryScopeField`
  (`src/office/templates/CategoryScopeField.tsx`, which the editor of plan 1e4
  is to reuse): «Все категории» or «Только выбранные», the product groups by
  name with a search and a live count of the chosen ones; the chosen codes stay
  while «Все категории» is picked, so switching back brings them back, and while
```

заменить на

<!-- prettier-ignore -->
```text
  «Загрузить заново», which closes the dialog and reads the list again.
  «Категории» opens a dialog on `CategoryScopeField`
  (`src/office/templates/CategoryScopeField.tsx`, which the template editor
  reuses): «Все категории» or «Только выбранные», the product groups by
  name with a search and a live count of the chosen ones; the chosen codes stay
  while «Все категории» is picked, so switching back brings them back, and while
```

6. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
```

заменить на

<!-- prettier-ignore -->
```text
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place. «Создать шаблон» (both
  roles) opens the editor, and a row's last action is «Изменить» (the editor)
  or, for a stock template, «Копировать» (a copy in the editor). Either dialog
  refused with `not_found` (the template was deleted on another workstation)
  says the template is gone, stays open and reads the list again, which drops
  the row.
- The template editor (plan 1e4; `/templates/new`, `/templates/:id` and
  `/templates/:id/copy`, pages without a menu item of their own) follows the
  cloud's `LabelEditorPage`, whose sources it ports into
  `src/office/templates/` (`label-geometry.ts`, `label-samples.ts`,
  `import-analysis.ts`, `ImportCodeDialog.tsx`, `ImportFieldsPanel.tsx`)
  instead of importing them: the apps stay independent, and the label rules
  themselves stay in `@markiro/domain`. Both roles use it. A template is a
  name (trimmed, 1–200 characters, `templateNameRule`), a purpose, a flag,
  its categories (`CategoryScopeField`, with the cloud's warning that the
  EGAIS field prints empty on categories without beer) and a layout, which
  only an import puts on the label. The import dialog takes ZPL or TSPL at a
  chosen resolution or the model's own JSON (`{ name, purpose, spec }` or a
  bare layout), checks it (`analyzeImport`: the domain's parsers, then every
  element moved inside the label, measured with the purpose's sample data),
  lists the lines or properties it drops for an acknowledgement and replaces
  the layout; a JSON's name names a template that has none yet, and the field
  list copies each field's token (`navigator.clipboard`; a failed copy says to
  copy by hand). «Изменить размер» opens the size form: a preset or a typed
  size of 10–300 mm with a comma or a point, and the layout's resolution;
  every element is moved inside the new label (`resizedSpec`), a size an
  element does not fit is refused and the layout stays, and an axis left as
  it was keeps its exact value. A product duplicate's layout must keep the
  domain's duplicate rule (`assertDuplicateTemplate`): while it does not,
  «Сохранить» is off and the editor offers the domain's duplicate 58×40 back.
  «Скачать JSON» saves `{ name, purpose, spec }` through a blob URL and
  `<a download>` under a file name made of the template's name, Cyrillic
  letters kept. Nothing reaches the host before «Сохранить»: the layout goes
  as `labelTemplateSpecSchema` makes it (`checkedSpec`), the categories as
  `null` or ascending. A new template or a copy is a create
  (`templateCreate`); a new blank template's untouched starting layout follows
  its purpose (a box an empty 58×40, a duplicate the domain's duplicate, a
  pallet the stock pallet 100×150), and a copy keeps its layout under
  «<name> — копия». A template opened for a change is read whenever the page
  opens and shown only once read on this visit; its purpose is fixed,
  «Сохранить» is off until something changed, and the save sends what differs
  and the layout with the opened revision (`templateUpdate`). A stock template
  is not opened for a change (its row offers «Копировать», and its address
  explains and offers a copy), nor is a layout the domain cannot read; a
  template deleted elsewhere is said to be gone. The form is off while a save
  is on its way. A refusal goes under the name or the categories, which then
  take focus, or above the form (`editorFailure`): a default the change would
  break says whose default it is, `stale_revision` offers «Загрузить заново»,
  which reads the template again and starts the editor afresh without the
  edits, and `not_found` says the template is gone.
  «Удалить» asks first, with the `destructive` submit, and says that the
  stations stop getting the template, that the products preferring it lose
  the preference and that there is no undo; a default or a stock template is
  refused in words (`deleteFailure`). A save or a delete returns to «Шаблоны»
  with a notice and drops the cached list, which holds no layouts, so it is
  read again. Leaving the page with unsaved changes («К шаблонам», the menu,
  «Копировать») asks first (`useBlocker`), except right after a save or a
  delete; the end of the session unmounts the office without asking. The
  preview, the ZPL and TSPL downloads and the thumbnails come with plan 1e4b.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
```

7. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  говорит, у кого он стоит по умолчанию — у организации или у каких категорий, — и
  что сначала нужно выбрать другой шаблон на странице «Умолчания шаблонов».
  Категории шаблона обе роли меняют окном на `CategoryScopeField` (его возьмёт и
  редактор плана 1e4): все категории или только выбранные, поиск групп по названию;
  на хост уходят `null` или выбранные коды по возрастанию (переставленный список
  хост счёл бы изменением и разослал бы макет всем станциям заново), «Сохранить»
```

заменить на

<!-- prettier-ignore -->
```text
  говорит, у кого он стоит по умолчанию — у организации или у каких категорий, — и
  что сначала нужно выбрать другой шаблон на странице «Умолчания шаблонов».
  Категории шаблона обе роли меняют окном на `CategoryScopeField` (его берёт и
  редактор шаблона): все категории или только выбранные, поиск групп по названию;
  на хост уходят `null` или выбранные коды по возрастанию (переставленный список
  хост счёл бы изменением и разослал бы макет всем станциям заново), «Сохранить»
```

8. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  фокус переходит в строку поиска. Сужение, которое выводит шаблон из категории, где
  он стоит по умолчанию, и любое сужение шаблона, который стоит по умолчанию у
  организации, хост отвергает так же, и окно объясняет это теми же словами. Редактор
  шаблона — создание, копия, переименование, импорт ZPL/TSPL/JSON, форма размеров,
  предпросмотр, выгрузки и удаление — план 1e4: он переносит
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
- Умолчания шаблонов (план 1e3): один документ
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
```

заменить на

<!-- prettier-ignore -->
```text
  фокус переходит в строку поиска. Сужение, которое выводит шаблон из категории, где
  он стоит по умолчанию, и любое сужение шаблона, который стоит по умолчанию у
  организации, хост отвергает так же, и окно объясняет это теми же словами.
  «Создать шаблон» открывает редактор; последнее действие строки — «Изменить» или, у
  типового шаблона, «Копировать». Окно, которому хост ответил `not_found` (шаблон
  удалили на другом рабочем месте), говорит об этом, остаётся открытым и перечитывает
  список.
- Редактор шаблона (план 1e4): страницы нового шаблона, правки и копии без своего
  пункта меню; переносит облачный `LabelEditorPage` (`apps/admin/src/pages/labels`)
  своими модулями, не импортом из админки, а правила этикетки берёт из
  `@markiro/domain`. Обе роли. Название (обрезанное, 1–200 символов), назначение,
  признак «Включён», категории на `CategoryScopeField` с подсказкой облака про поле
  ЕГАИС и макет, который на этикетку кладёт только импорт: ZPL или TSPL в выбранном
  разрешении или JSON модели, проверка разборщиками домена и подгонка элементов в
  пределы этикетки, список отброшенного с подтверждением; имя из JSON получает
  шаблон без имени. Форма размеров — заготовка или свой размер 10–300 мм и
  разрешение макета; элементы сдвигаются внутрь новой этикетки, размер, в который
  элемент не помещается, не принимается. Дубликат держит правило домена, иначе
  «Сохранить» выключена и предлагается макет дубликата 58 × 40. «Скачать JSON»
  отдаёт `{ name, purpose, spec }` с именем файла из названия (кириллица остаётся).
  До «Сохранить» на хост ничего не уходит; макет проверяется `labelTemplateSpecSchema`
  и уходит в его разборе. Новый шаблон и копия («<название> — копия») создаются;
  шаблон на правку читается при каждом открытии и показывается только прочитанным
  в это посещение, назначение не меняется, «Сохранить» выключена до изменения, на
  хост уходит изменённое и макет с ревизией открытой записи. Типовой шаблон на
  правку не открывается (предлагается копия), как и макет, который домен не читает.
  Отказ встаёт под название или категории или над формой: умолчание, которое
  правка сломала бы, объясняется, `stale_revision` предлагает загрузить шаблон
  заново без правок, `not_found` говорит, что шаблона больше нет. «Удалить»
  спрашивает подтверждение и объясняет последствия; умолчание и типовой шаблон
  хост удалить не даёт. После сохранения или удаления офис возвращается к списку с
  уведомлением, и список перечитывается; уход со страницы с несохранёнными правками
  спрашивает подтверждение. Предпросмотр, выгрузки ZPL и TSPL и миниатюры в списке —
  вторая часть плана (1e4b) вместе с растеризатором, покрытием шрифтов и
  зависимостью `opentype.js`.
- Умолчания шаблонов (план 1e3): один документ
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
```

9. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (plan 1e4)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
```

заменить на

<!-- prettier-ignore -->
```ts
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (`checkedSpec`)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
```

10. В `apps/standalone/src/office/templates/CategoryScopeField.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * or when they fail, «Только выбранные» keeps its codes and says why it lists
 * nothing. A chosen code the lookup lacks is listed after the groups as «Код N»,
 * so it can be unchecked. The template editor of plan 1e4 is to take this field
 * as well.
 */
export function CategoryScopeField({ value, onChange, error }: CategoryScopeFieldProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx
 * or when they fail, «Только выбранные» keeps its codes and says why it lists
 * nothing. A chosen code the lookup lacks is listed after the groups as «Код N»,
 * so it can be unchecked. The template editor takes this field as well.
 */
export function CategoryScopeField({ value, onChange, error }: CategoryScopeFieldProps) {
```

11. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4b). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
```

12. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * templates on and off and change their categories (`editCatalog`); a write's
 * answer goes into the cached row in place (`withTemplateChange`), and the
 * list is not read again.
 */
export function TemplatesPage() {
```

заменить на

<!-- prettier-ignore -->
```tsx
 * templates on and off and change their categories (`editCatalog`); a write's
 * answer goes into the cached row in place (`withTemplateChange`), and the
 * list is not read again. «Создать шаблон», «Изменить» and «Копировать» open
 * the editor, which comes back here with a notice after a save or a delete.
 */
export function TemplatesPage() {
```

- [ ] **Step 2: Перечитать**

Перечитать в `AGENTS.md` разделы «Catalog and label templates», «Protocol» и «Office pages» (пункты «Lists of archivable records», «Шаблоны», новый пункт о редакторе, «Умолчания шаблонов»), в спецификации — §5.5 целиком: нигде не осталось «редактор будет», «is plan 1e4's» или «его возьмёт»; всё, что задачи 1–8 сделали, названо; предпросмотр, выгрузки ZPL и TSPL и миниатюры названы частью 1e4b.

- [ ] **Step 3: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md apps/standalone/src/host/protocol.ts apps/standalone/src/office/templates/CategoryScopeField.tsx apps/standalone/src/office/templates/TemplatesPage.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1191 тест (без изменений).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md apps/standalone/src/host/protocol.ts apps/standalone/src/office/templates/CategoryScopeField.tsx apps/standalone/src/office/templates/TemplatesPage.tsx
git commit -m "docs(standalone): план 1e4 — редактор шаблона в документах" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 53 файла, 1191 тест (до плана 47 и 1113).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/label-geometry.test.ts test/editor-model.test.ts test/import-analysis.test.ts test/import-code-dialog.test.tsx test/editor-failure.test.ts test/template-editor.test.tsx test/templates-page.test.tsx test/template-text.test.ts test/template-options.test.ts test/template-list.test.ts test/records.test.tsx test/form-dialog.test.tsx test/template-defaults-page.test.tsx test/product-dialog.test.tsx test/category-scope-field.test.tsx`
Expected: PASS — 15 файлов, 262 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 262; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB (главный чанк вырос с 812,67 до 864,49 kB, примерно на 52 kB: разборщики ZPL, TSPL и JSON домена, страницы и окна редактора).

- [ ] **Step 2: Cargo**

Rust план не меняет (шаг 3 это проверяет), поэтому наборы Cargo не перезапускаются: 41 набор, 453 теста, как до плана. Оболочка встраивает сборку вебвью из шага 1 (`apps/standalone/dist`), поэтому проверка сборки идёт после неё.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: чисто, без предупреждений.

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check 3e15e562b`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat 3e15e562b -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri pnpm-lock.yaml apps/standalone/package.json`
Expected: пусто (D5, D8).

- [ ] **Step 4: Что не проверить в песочнице и без Windows**

Записать в отчёт, что не проверено (а не «проверено»):

- выгрузка JSON в настоящем WebView2: `<a download>` с blob URL сохраняет файл в «Загрузки» стандартным диалогом WebView2; в jsdom проверено только, что ссылка создана, нажата, убрана и URL отозван. Если WebView2 в оболочке Tauri загрузку не пропустит, нужен свой вызов оболочки (сохранение файла через диалог) — это изменение `src-tauri` и вопрос владельцу;
- копирование поля в буфер (`navigator.clipboard.writeText`) в WebView2 Tauri: в тестах `navigator` подменён;
- раскладка страницы редактора и окна импорта шириной 1040 px на настоящем экране, фокус и Escape в окнах, озвучивание ошибок и живых заметок скринридером;
- что станции получают созданный, изменённый и удалённый шаблон: копии станции проверялись тестами плана 1e2, вживую — нет;
- запросы к живому хосту: тела проверены сборщиками и их фикстурами плана 1e2 и моками `HostApi`, порядок проверок хоста — по `host/src/routes/templates.rs` и наборам Cargo плана 1e1.

---

## Часть 1e4b — схема (пишется отдельным планом, когда зависимость поставлена)

Цель: предпросмотр макета в редакторе («предпросмотр = печать»), выгрузки ZPL и TSPL и миниатюры в списке «Шаблоны», как в облаке, без сетевых зависимостей. Задачи ниже — не исполняемый план, а точная схема: код для них пишется после задачи 10, когда `opentype.js` есть в `node_modules`, и проверяется тем же способом, что задачи 1–9.

### Task 10: Зависимость `opentype.js` 2.0.0 (выполняет владелец вне песочницы)

Песочница не пускает pnpm в реестр и не даёт менять `pnpm-lock.yaml` установкой; исполнитель плана эту задачу не выполняет. Пакет уже в lockfile (его держит `apps/admin`), поэтому ничего не скачивается заново и выдержка `minimum-release-age=10080` (7 дней, `.npmrc`) не задевается: 2.0.0 вышел давно и разрешён прежде.

- [ ] **Step 1: Поставить зависимость** (из корня репозитория, вне песочницы):

<!-- prettier-ignore -->
```bash
pnpm --filter @markiro/standalone add opentype.js@2.0.0
```

- [ ] **Step 2: Проверить дифф.** Expected: ровно два файла.
  - `apps/standalone/package.json`: в `dependencies` между `"i18next": "26.3.6",` и `"react": "19.2.8",` — строка `"opentype.js": "2.0.0",` (точная версия: `save-exact=true` в `.npmrc`);
  - `pnpm-lock.yaml`: в импортёре `apps/standalone` → `dependencies` между `i18next` и `react` — три строки `opentype.js:`, `specifier: 2.0.0`, `version: 2.0.0`; разделы `packages:` и `snapshots:` не меняются (`opentype.js@2.0.0` там уже есть).

  Run: `git diff --stat`; `git diff pnpm-lock.yaml`
  Expected: `apps/standalone/package.json | 1 +`, `pnpm-lock.yaml | 3 +++`.

- [ ] **Step 3: Политика зависимостей.**

  Run: `pnpm check:deps`
  Expected: без нарушений (`tools/dependency-baseline.json` уже держит `"opentype.js": "2.0.0"`, базу не перезаписывать).

  Run: `pnpm install --frozen-lockfile`
  Expected: успех без изменений lockfile.

- [ ] **Step 4: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/standalone/package.json pnpm-lock.yaml
git commit -m "build(standalone): opentype.js 2.0.0 для растеризатора шаблонов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11 (схема): растеризатор и покрытие шрифтов

- Create `src/office/templates/rasterizer.ts` — перенос `apps/admin/src/labels/rasterizer.ts` (`rasterizeText: RasterizeTextFn` домена: текст рисуется на `<canvas>` 2D уже вложенным шрифтом IBM Plex, пиксели упаковывают чистые функции домена `convertToMonochrome` и `bitmapToZplHex`; без 2D-контекста — `RasterUnavailableError`), и `src/office/templates/font-coverage.ts` — перенос `apps/admin/src/labels/fontCoverage.ts` (`checkFamilyCoverage`: opentype.js читает файл шрифта и проверяет глифы кириллицы; шрифты — `@fontsource/ibm-plex-sans` и `@fontsource/ibm-plex-mono` в формате `.woff` через `?url` Vite, по одному файлу кириллицы и латиницы; `.woff2` opentype.js не читает). Объявление типов — перенос `apps/admin/src/labels/opentype.d.ts` (у opentype.js 2.0.0 своих типов нет). opentype.js нужен только проверке покрытия.
- Обе функции — внедряемые зависимости редактора (свойства страницы с настоящими реализациями по умолчанию, как `LabelEditorPageProps` облака), потому что в jsdom нет 2D-контекста canvas: тесты подставляют подделки.
- Тесты: перенос `apps/admin/test/labels-raster.test.ts` (чистые части: упаковка битов, выравнивание) и проверка, что шрифты берутся из вложенных ассетов (нет `http`).

### Task 12 (схема): предпросмотр в редакторе

- Перенос `apps/admin/src/pages/labels/renderer.ts` (рисование макета на canvas с образцом назначения из `label-samples.ts`), `editor/raster-preview.ts` и `editor/PreviewPane.tsx` в `src/office/templates/`; карточка «Макет» получает предпросмотр, предупреждение о шрифте без кириллицы и об отказе проверки шрифта (`office.templateEditor.preview.*`).
- Тесты: предпросмотр вызывает внедрённые `rasterizeText` и `checkFamilyCoverage`, показывает предупреждения; рисование пикселей в jsdom не проверяется (как в облаке).

### Task 13 (схема): выгрузки ZPL и TSPL

- `download.ts` получает `latin1ToUint8Array`, `zplBlob`, `tsplBlob` (перенос облачного `download.ts`: байт на символ, иначе `Blob` перекодирует байты ≥ 0x80 в UTF-8); кнопки «Скачать ZPL» и «Скачать TSPL (TSC)» генерируют документ `generateZpl` и `generateTspl` с внедрённым `rasterizeText` и образцом назначения; у сломанного дубликата выгрузки кода выключены, JSON — нет.
- Тесты: байты TSPL `BITMAP` и Latin-1 в ZPL доходят до файла один к одному; имя файла — `templateFileName`.

### Task 14 (схема): миниатюры в списке и документы

- Столбец миниатюры на «Шаблонах»: `getTemplate` по строке по требованию с кэшем макета по ключу `["office", "template-layout", id, rev]` и `staleTime: Infinity` (ревизия меняется с любой записью, поэтому кэш по паре не устаревает; сводки по-прежнему без макетов, D2); пока макет читается или не прочитался — пустая рамка размером этикетки; рисует `renderer.ts`. Решить вместе с этим пункт 6 очереди 1e3 (полный список категорий только в `title`).
- Документы: `AGENTS.md` «Office pages» и спецификация §5.5 — предпросмотр, выгрузки кода, миниатюры; убрать оговорки «до 1e4b».

---

## Перенесено

- Часть 1e4b (схема выше): `opentype.js`, растеризатор и покрытие шрифтов, предпросмотр, выгрузки ZPL и TSPL, миниатюры; вместе с ней — пункт 6 очереди 1e3 (полный список категорий шаблона только в подсказке-`title`).
- Перенос `fitSpecElements` и образцов назначения в `@markiro/domain` с переводом на них `apps/admin` и `apps/standalone` (сейчас две копии: облачная и этого плана) — решение владельца.
- Общая нормализация поиска (`product-list.ts`, `template-list.ts`, `visibleGroups`; пункт 8 очереди 1e3): поведения не меняет, сделать при следующей правке этих модулей или отбросить.
- Две «Повторить» с одним доступным именем на странице умолчаний, когда не загрузились и шаблоны, и группы (пункт 27 очереди 1e3) — по-прежнему план полировки.
- Объявление ошибок полей скринридером и фокус на первое неверное поле на уровне `FormDialog` (пункт 13 очереди 1e3) — план полировки.
- Если редактору понадобится «вернуть» снятый флажок «Код N» в `CategoryScopeField`, ему нужен набор уже виденных кодов (строка кода без справочника берётся из значения и исчезает после снятия до сохранения) — как в плане 1e3.
- Случаи дубликата с категориями в `proto/fixtures/template-eligibility.json` — по-прежнему первому плану, который меняет `proto`.
- Комментарий-пример «шаблоны мастера» в `apps/standalone/src-tauri/tests/local_db.rs` (ревизия больше 1 МиБ) — одной строкой при следующей правке этого Rust-теста.
- Выгрузка файлов в WebView2 Tauri: если `<a download>` не сохраняет файл (см. «Итоговая проверка», шаг 4), нужен вызов оболочки с диалогом сохранения — изменение `src-tauri`, решение владельца.
- Площадки, созданные до плана 1e3, остались без типовых шаблонов: теперь их можно создать редактором (импорт JSON типового шаблона или пустая заготовка), а отдельная кнопка засева — по-прежнему решение владельца.
- Закрытие окна вебвью с несохранёнными правками редактора не охраняется: `CloseRequested` живёт в оболочке (`src-tauri`), это дело плана оболочки или владельца; редактор спрашивает только при уходе внутри офиса.
- Фокус после неудачного «Применить» в форме размеров остаётся на кнопке (как в других `FormDialog`); общий план полировки вместе с пунктами 13 и 26 очереди 1e3.
- Длинное название источника (193–200 знаков) плюс « — копия» превышает 200 знаков: сохранение отказано под полем названия до отправки; вопрос владельцу, обрезать ли исходное название перед суффиксом.
- Сообщения разборщиков кода показываются как есть, по-английски и без номера строки (`LABEL_CODE_INVALID` несёт `cause.line`): перевести ключами `ru.json` и показать «Строка N» — план полировки; ошибка разборщика вне `DomainError` пользователю не видна (в консоли): общее «Проверка не удалась» с повторным выбросом — туда же.
- План 2a (смена на станции) и план 5 (политика версий протокола) — без изменений с плана 1e3.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-06. Там, где задачи выше расходятся с кодом в ветке, верен этот раздел. Часть 1e4б (схема выше) не исполнялась.

**Поправки плана по ходу исполнения**

- Счёт тестов. План заканчивается на Vitest 53 файла и 1191 тест (из 47 и 1113); сборка — на 54 файлах и 1295 тестах (+104 сверх плана). До итоговой волны: задача 1 +8 (6 своих и 2 правки), 2 +17, 3 +11, 4 +12 (9 своих и 3 правки), 5 +7, 6 +7, 7 +4, 8 +2, задача 9 — 0 (всего 1259, +68); итоговая волна +34 (1293: перенос ошибок без приведения типов, проверка размера макета, блокировка кнопок шапки при сохранении, доступность) и ещё +2 (1295: список после ухода из редактора во время сохранения). Каждый лишний тест убивает однострочную мутацию, пережившую тесты плана. Cargo не перезапускался: Rust не менялся (41 набор и 453 теста); `cargo fmt` и `cargo check` частью 1e3 были чисты.
- Исправленные тесты плана. Тест, который перебирал `[undefined, TECHNOLOGIST]` и так ни разу не проверял администратора, в правке задачи 3 и в задаче 5 перебирает `[SESSION.user, TECHNOLOGIST]`. Утверждение о «равнозначных мутантах» неверно оказалось трижды (задача 1: ранние проверки размера в `fitElementWithinLabel`; задача 3: роль администратора; задача 4: выбор заготовки) — после этого рецензенты пытались убить каждый заявленный равнозначный мутант.
- Решения контроллера после ревью задач. Задача 1: два теста ранних проверок размера. Задача 4: признаки «ось тронута» для ширины и высоты в `LabelSizeDialog` (иначе заготовку нельзя было выбрать, когда сохранённый размер округлялся до её текста: импорт 58-мм этикетки в 300 dpi даёт 57,9967 мм) — отступление от кода брифа, одобрено контроллером.
- Брифы, которые поправил контроллер: тесты сверх плана сдвигали якоря конца `template-editor.test.tsx` и блока импортов (брифы задач 4, 5 и 6). Это заметка о процессе, не отклонение плана.
- Отступления планировщика от замысла (приняты): после создания, правки и удаления кэш списка шаблонов сбрасывается (в плане D2 стояло `removeQueries`, в ходе исполнения стало `resetQueries`, чтобы открытый на экране список перечитывался); редактор читает шаблон под `officeKeys.template(id)` и показывает его, только когда он прочитан в это посещение; удаление — в шапке редактора, строка типового шаблона предлагает «Копировать»; выгрузки ZPL и TSPL перенесены в 1e4б (нужен растеризатор); `fitSpecElements` и образцы назначения перенесены в приложение, `packages/*` не тронуты; после сохранения и удаления офис возвращается к «Шаблонам» с уведомлением; новый шаблон начинается без названия.
- Итоговая проверка части 1e4а: Critical и Important нет; очередь из 31 замечания разобрана (18 исправлены, 5 перенесены, 8 отброшены); отброшен пункт 11 (офис на `createMemoryRouter`: состояние перехода не переживает перезагрузку, «Назад» браузера нет); пункт 13 оставлен как страж для `requestSubmit` (в браузере Enter не отправляет форму, пока «Сохранить» выключена); размер макета в 256 КБ проверяется на клиенте (262 144 байта, как `serde_json::to_string` хоста), отказ хоста остаётся запасным; боковое меню: у «Шаблонов» убран `end`, и пункт подсвечен на страницах редактора, но не на «Умолчаниях шаблонов»; фокусная группа области — `role="group"` с `aria-label` вместо `aria-labelledby` (у заголовка `Card` нет `id`, `packages/ui` не менялся). Повторное ревью волны нашло одну мелочь (после ухода на список во время сохранения список показывал старую строку) — исправлено (`b637609b1`).

**Что не проверено**

Ни реального вебвью Tauri (скачивание JSON через `<a download>` и буфер обмена), ни WebView2/WKWebView, ни Windows, ни живых хоста и станций, ни скринридера; раскладка окна импорта шириной 1040 пикселей, формы размеров, шрифт поля кода и пустой промежуток в 12 пикселей под областью проверки проверены только как факты DOM в jsdom. Совпадение счёта байтов с хостом доказано чтением `validate.rs`, а не прогоном против живого хоста.
