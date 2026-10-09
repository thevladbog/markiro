# План 2a3: офис — «Смены» (список, период, планирование, правка, удаление, закрытие с причиной, итоги), слой протокола смен и мелочи офиса из очереди ревью — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В офисе автономного продукта появляется страница «Смены» (раздел «Производство», сразу после «Линии»): список смен хоста с названиями из списков офиса, отбором, поиском, периодом дат производства и страницами по 25; запланированная смена, которую станция не откроет, помечена словами. Обе роли планируют смену (товар, линия, дата производства «сегодня» по часовому поясу организации, план, вместимость и шаблон короба из товара, контрагент), правят запланированную, меняют план активной, удаляют запланированную и закрывают активную с причиной; окно «Итоги» показывает числа смены (последняя задача, после плана 2a2). Попутно — четыре пункта очереди ревью для офиса: счётчик SSCC за последним номером, похожий табельный номер, предупреждение о смене при переводе станции на другую линию, старые образцы протокола 1 в тестах вебвью.

**Architecture:**

- `src/host/protocol.ts`, `src/host/requests.ts`, `src/host/api.ts` — схемы Zod смен по фикстурам плана 2a1 (`officeShiftSchema` и три тела запросов), построители `shiftCreate`, `shiftUpdate`, `shiftClose`, методы `HostApi` `listShifts`, `createShift`, `updateShift`, `deleteShift`, `closeShift`; в задаче 9 — `shiftTotalsSchema`, `officeShiftDetailSchema` и `getShift`.
- `src/lib/civil-date.ts` (`isCivilDate` по фикстуре хоста `shift-numbers.json`, `civilDaysBetween`, `civilToday` по часовому поясу), `src/lib/box-template-choice.ts` (`suggestBoxTemplate` — правило решения 7, общее с новой сменой станции в плане 2a5), правила формы в `src/lib/rules.ts` (план, вместимость, дата, причина закрытия в кодовых точках).
- `src/office/shifts/` — `shift-list.ts` (названия, пометка «не откроется», отбор, период), `shift-form.ts` (форма и разбор отказов), `shift-text.ts`, страница `ShiftsPage` и окна `ShiftDialog` (план и правка запланированной), `ShiftPlanDialog`, `DeleteShiftDialog`, `CloseShiftDialog`, `ShiftTotalsDialog`; общий `src/office/OfficePager.tsx` вынесен из «Товаров».
- Хост, `proto/src`, оболочка, станция и `packages/*` не меняются; в `proto/fixtures` план 2a3 ничего не добавляет (фикстура итогов — плана 2a2).

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, react-hook-form с `@hookform/resolvers/zod`, TanStack Query 5, i18next, `@markiro/ui` (`Table`, `FilterBar`, `Select` с `native`, `DatePicker`, `Textarea`, `StatusChip`, `Badge`, `RowActions`, `DefinitionGrid`, `Modal`, `Alert`), `@markiro/domain` (`isShiftCloseReasonCode`, правило слота через `templateFitsSlot`), Vitest 4 с jsdom.

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — черновик этапа 2a: решения 1–8, 18, 32, 33, §4.2, §4.7–4.9, §5.6, §6, строки 2a2 и 2a3 раздела 8, §11 (вопросы владельцу), §15 (уточнения плана 2a1); задача 8 дописывает §16 «Уточнения плана 2a3» (или следующий свободный номер, если раньше исполнен план 2a4, который дописывает свой раздел).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §4.8 (роли), §5.5 (офис: правила страниц).
- `docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md` — маршруты, фикстуры и «Перенесено» (пункты для 2a3); `host/src/routes/office_shifts.rs`, `proto/src/lib.rs` (`OfficeShift`, `ShiftCreate`, `ShiftUpdate`, `ShiftClose`), `proto/fixtures/{office-shift,shift-create,shift-update,shift-close,error-shift-busy,error-sscc-exhausted}.json`.
- Очередь ревью плана 2a1 — `.superpowers/sdd/2a1-minors.md`, пункты 4, 9, 14, 22, 23.
- `apps/standalone/AGENTS.md` — «Office pages», «Protocol», «Shifts», «Operators and badges», «Catalog and label templates», «Verification»; образцы — планы 1e3 и 1e4 (`docs/superpowers/plans/2026-10-05-standalone-1e3-templates-defaults-wizard.md`, `docs/superpowers/plans/2026-10-06-standalone-1e4-template-editor.md`).
- Облако, с которого сняты слова и тона: `apps/admin/src/pages/shifts/index.tsx` (`SHIFT_STATUS_TO_PHASE`, `SHIFT_MODE_TO_TONE`), `apps/admin/src/i18n/ru.json` (`pages.shifts.*`), `apps/station/src/i18n/ru.json` (`work.closeReasons`).

## Допущения по вопросам владельцу

Владелец ответил «по порядку», не выбрав варианты раздела 11 спецификации 2a. План принимает рекомендованный вариант каждого вопроса, который касается офиса; ниже — что принято и что поменять, если ответ будет другим.

- **В1 — граница 2a и 2b: вариант А.** На смене одно устройство; офис только читает `ownerDeviceId` (в итогах — число устройств). Вариант Б офиса не меняет.
- **В2 — контрактное производство: вариант А.** Контрагент — необязательное поле формы, только подпись на этикетке; выбора эмитента SSCC в форме нет (задача 4). Вариант Б — новое поле «Эмитент» в `ShiftDialog` и в `shiftCreate` после правки хоста.
- **В3 — одна дата смены: вариант А.** Одно обязательное поле «Дата производства», по умолчанию «сегодня» по часовому поясу организации (задачи 2, 4). Вариант Б — второе поле даты в форме и в построителях после правки хоста.
- **В4 — закрытие активной смены из офиса: вариант А.** Обе роли, текст причины 3–500 символов, посчитанных как на хосте (задачи 2, 6). Вариант Б — задача 6 исполняется без `CloseShiftDialog` и кнопки «Закрыть».
- **В6 — значения раздела 15: принять.** Офис их не показывает и не меняет; размер блока правится прежней формой «SSCC → Размеры блоков».
- **В9 — смена линии при идущей смене: вариант А с предупреждением.** Диалог «Устройства» не мешает перевести станцию, но, если у неё есть активная смена, говорит, что станция доделает работу, выведет оператора и покажет смены новой линии, а смена останется открытой (задача 7). Вариант Б — хост отказывал бы в переводе (`conflict`), и диалог показывал бы отказ вместо предупреждения.
- **В13 — табельные номера с ведущими нулями: вариант А** (хост его уже исполняет, план 2a1): форма оператора называет похожий номер из `details.similarLogin` (задача 7).
- В5, В7, В8, В10, В11, В12 и В14 офиса не касаются (оболочка и цех).

## Global Constraints

**Решения спецификации, обязательные для 2a3**

1. Страница «Смены» — раздел «Производство», сразу после «Линии», для обеих ролей (решение 32, §5.6); полная карточка смены (короба, исключения, конфликты, поздние данные, отклонённые записи) — этап 4.
2. Список — `GET /v1/office/shifts`: без параметров — все запланированные и активные и закрытые с датой производства за 31 день по часам хоста; `?from=&to=` — по дате производства включительно; новые сначала. `OfficeShift` несёт идентификаторы, а не имена: офис называет записи по своим спискам (§15).
3. Планирование (решения 4–8): товар `active` и не в архиве, линия активная, дата производства — гражданская дата `YYYY-MM-DD` (по умолчанию сегодня по часовому поясу организации), план 1–10 000 000 или нет, вместимость 1–100 000 (из товара, правится), шаблон короба, подходящий группе товара, по правилу «предпочтение товара → умолчание категории → умолчание организации → выбор человека», «Не выбран» отсутствует; контрагент необязателен. `mode: "aggregation"` и `palletsEnabled: false` — единственные значения 2a.
4. Правка (`PUT`, `expectedRev`): запланированная — всё, кроме товара; активная — только план; закрытая — ничего. `plannedQty: null` и `counterpartyId: null` очищают; `null` в другом поле хост читает как «не прислано».
5. Удаление — только запланированной (204; повтор после потерянного ответа — `not_found`). Закрытие офисом — только активной, `{ reason, expectedRev }`, причина 3–500 символов без управляющих (`validate::close_reason`).
6. Отказы хоста: `conflict` с `constraint` `shift_status` (и `details.status`), `product_inactive`; `validation_failed` на поле запроса; `stale_revision`; `not_found`.
7. Роли (§4.9): читают смены все роли, пишут администратор и технолог — `useCan("planShifts")` в `src/office/access.ts`; права проверяет хост.

**Правила офиса** (`apps/standalone/AGENTS.md`, «Office pages»)

- Каждый запрос — через `session.call` (`useOfficeQuery`, `useOfficeMutation`); страницы читают данные при каждом открытии (`staleTime` 0); ошибка хоста — ответ, который страница объясняет, с «Повторить».
- Каждая правка записи с ревизией шлёт `expectedRev` загруженной записи; на `stale_revision` — «Загрузить заново», правки пропадают; повтор с `details.currentRev` — никогда.
- Окно вокруг одной формы — `FormDialog`; `onSubmit` никогда не отклоняется; в `try` — только ожидаемая запись, колбэк после записи — после `try/catch`, каждый `catch` кончается `return`. Подтверждение, выводящее запись из оборота, — вариант `destructive`.
- Тела запросов собираются поле за полем, не распаковкой значений формы; идентификаторы — только в пути.
- У каждой таблицы — свой `empty`, у каждого окна — `closeLabel`; состояние — словами, не одним цветом; где текст меняется без перехода — `aria-live`.

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`; тексты даны в шагах целиком и переносятся буква в букву; кавычки — «ёлочки». Новые ключи: `office.nav.shifts`, группа `office.shifts`, `office.common.pager` (перенос трёх ключей `office.products.pager` теми же словами), `rules.plannedQty`, `rules.shiftBoxCapacity`, `rules.productionDate`, `rules.closeReason`, `office.sscc.exhausted`, `office.operators.errors.loginSimilar`, `office.devices.shiftOnStation`. Прежние тексты не меняются.
- Числа в текстах — именованные переменные (`number`, `shown`, `total`, `similar`), не `count`: с `count` i18next ищет формы множественного числа.
- `i18n` стоит с `escapeValue: false`: интерполированные значения попадают в React только детьми и атрибутами, никогда через `dangerouslySetInnerHTML`; тесты страницы показывают название с разметкой как текст.

**Решения планировщика** (открытые места спецификации; задача 8 записывает их в §16)

- Список хоста не несёт итогов, поэтому строка показывает план, а «принято единиц и коробов» — окно «Итоги» активной и закрытой смены (`GET /v1/office/shifts/{id}`, задача 9, после 2a2), которое видят обе роли.
- Период — два поля `DatePicker`; запрос уходит, только когда заданы обе даты, конец не раньше начала и период не длиннее 366 дней с обоими концами (`MAX_PERIOD_DAYS`): хост отдаёт период целиком и без страниц (пункт 4 очереди 2a1), предел ограничивает один запрос. Пока период неполный или неверный, показан прежний список и заметка; обе даты пусты — список хоста по умолчанию.
- Поиск (номер или название товара, без регистра), отбор по статусу и по линии и страницы по 25 работают в странице; страницы — общий `OfficePager`, вынесенный из «Товаров» (второй потребитель; разделы офиса друг друга не импортируют).
- Пометка «Не откроется» — по спискам офиса (`openBlocker`): товар в архиве, товар-черновик, шаблон не подходит группе товара (выключен, сужен, не той группы). Нет нужного списка или записи — пометки нет. Архивная линия открытию не мешает.
- Тон режима — облачный `SHIFT_MODE_TO_TONE` (агрегация `teal`, валидация `violet`); фаза статуса — облачный `SHIFT_STATUS_TO_PHASE` (`planned`, `active`, закрытая — `done`); поздние данные и «Не откроется» — фаза `attention`.
- Окно новой смены ждёт профиль организации ради «сегодня» (`civilToday`); профиль не загрузился — дата этого ПК и подпись об этом. Выбор товара ставит вместимость и шаблон из товара; товар ждёт списков шаблонов и умолчаний, чтобы подсказка шаблона не потерялась. Список шаблонов пуст, пока товар не выбран; у пустого выбора — подсказка «Выберите шаблон», а не вариант «Не выбран».
- Правка запланированной смены — то же окно без поля товара (товар назван словами); её линия, контрагент и шаблон остаются выбором с пометкой «(в архиве)», «— не подходит» или «— нет в списке». План активной смены — отдельное окно с одним полем.
- `shift_status` и `not_found` на записи — предупреждение своими словами (`shiftWriteFailure`), окно остаётся, список перечитывается за ним; `not_found` на удалении — смена считается удалённой. Отказ на шаблоне перечитывает список шаблонов, чтобы он показался с пометкой.
- После любой записи страница перечитывает все списки смен (`officeKeys.shifts` — префикс ключей всех периодов), а не вставляет ответ: принадлежность смены периоду и отбору решает хост.
- Причина закрытия — `Textarea` из `@markiro/ui` (у него нет `error`): подсказка и отказ — строка под полем с `aria-describedby` и `aria-invalid`, классы `shift-note`.
- Окно «Итоги» — `Modal` без формы, `DefinitionGrid`: план, принято единиц, закрыто и открыто коробов, время последних данных (по часовому поясу организации), число устройств; имена устройств — только администратору, поэтому число.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений типов в исходниках и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля в `src/`). Кнопки офиса — офисного размера (`size="compact"` в строках, как на прочих страницах офиса); правило 64 px — для экранов цеха, которых план не трогает.
- CSS — только переменные, объявленные в `packages/ui/src/tokens.css` (`--fg-2`, `--fg-3`, `--err-fg`, `--text-body-sm`); итоговая проверка сверяет каждую новую.
- Новых зависимостей нет. Не меняются: `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto` (фикстура итогов — плана 2a2, см. шаг 0 задачи 9), `apps/standalone/src-tauri`, Rust.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на момент применения он встречается в файле один раз (план применён к копии репозитория по шагам, задача за задачей). Правки внутри шага идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке; «заменить содержимое целиком» — файл становится ровно таким, как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier: расхождение при проверке значит опечатку.
- Правки `src/i18n/ru.json` даны фрагментами; JSON после каждой правки — валидный, и prettier его не меняет.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`. Неразрывный пробел в ожидаемых числах тестов записан как `\u00a0` — его не видно глазом, и буквальный символ при копировании пропадает.
- Параллельно с этим планом идут план 2a2 (хост) и план 2a4 (оболочка, `src/hardware/*`). План 2a4 меняет в вебвью `deviceStatusSchema` (`deviceName`) и `TRANSPORT_CODES`, а значит, и `test/support/fixtures.ts` (`DEVICE_STATUS`): этот план `src/host/client.ts` не трогает, а его фрагменты в `src/host/protocol.ts` (конец разделов ответов и запросов) и в `test/support/fixtures.ts` (импорт и `observation`) лежат вдали от этих мест. Если фрагмент не нашёлся из-за чужой правки рядом, правку переносят по смыслу и записывают в «Отклонения при исполнении».

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Каталог `/tmp/claude` один внутри и вне песочницы.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- React 19.2 запускает пассивные эффекты и коммиты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от следующего коммита, — скрытый флейк. Пример этого плана: после отказа формы текст ошибки появляется раньше, чем кнопка отправки перестаёт быть занятой, и второй щелчок по занятой кнопке не отправляет ничего; поэтому тест ждёт `disabled === false` перед вторым щелчком. Два щелчка, которые должны быть одновременными, — в одном `act`.
- `freezeToday()` (`test/support/shifts.ts`) подделывает только `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`): таймеры React Query и Testing Library идут как обычно; `afterEach` возвращает настоящие часы.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`), поэтому опечатка в ключе роняет тест, а не показывает ключ. Поэтому же код причины закрытия, неизвестный этой сборке, не переводится через `t` с `defaultValue` (ключа нет — исключение), а показывается как есть.
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

- До плана (HEAD `366e87f06`): Vitest — 67 файлов, 1744 теста; cargo не затрагивается (46 наборов, 494 теста по плану 2a1). Каждое «Expected» ниже измерено на копии репозитория с кодом самого плана, задача за задачей. Если до 2a3 исполнен план 2a4 (он добавляет тесты вебвью), база — прогон перед задачей 1, а к ней прибавляются числа этого плана: задача 1 — +24 теста, 2 — +2 файла и +38, 3 — +2 и +16, 4 — +1 и +17, 5 — +2 и +14, 6 — +1 и +11, 7 — +5, 8 — 0, 9 — +1 и +8. Расхождение значит, что шаг применён не так (тесты, добавленные исполнителем сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку; задача 9 — только после плана 2a2.

<!-- prettier-ignore -->
```text
apps/standalone/src/host/{protocol,requests,api}.ts                                        задачи 1, 9
apps/standalone/test/{protocol,api,probe}.test.ts, test/support/{fixtures.ts,office.tsx}   задачи 1, 9
apps/standalone/src/lib/{civil-date,box-template-choice,rules}.ts                          задача 2
apps/standalone/test/{civil-date,box-template-choice,rules}.test.ts                        задача 2
apps/standalone/src/office/{nav.ts,routes.tsx,office-query.ts,OfficePager.tsx}              задачи 3, 9
apps/standalone/src/office/products/ProductsPage.tsx                                       задача 3
apps/standalone/src/office/shifts/{shift-list.ts,shift-text.ts,ShiftsPage.tsx}              задачи 3–6, 9
apps/standalone/test/{shifts-page.test.tsx,shift-list.test.ts}, test/support/shifts.ts      задачи 3–5
apps/standalone/test/operators-page.test.tsx                                               задачи 3, 7
apps/standalone/src/office/access.ts                                                       задача 4
apps/standalone/src/office/shifts/{shift-form.ts,ShiftDialog.tsx}, test/shift-dialog.test.tsx   задачи 4, 5
apps/standalone/src/office/shifts/ShiftPlanDialog.tsx                                      задача 5
apps/standalone/test/shift-edit.test.tsx, test/shift-form.test.ts                          задачи 5, 6, 9
apps/standalone/src/office/shifts/{DeleteShiftDialog,CloseShiftDialog}.tsx                  задача 6
apps/standalone/test/shift-delete-close.test.tsx                                           задача 6
apps/standalone/src/office/sscc/{SsccPage.tsx,counter-kind.ts}, test/sscc-page.test.tsx     задача 7
apps/standalone/src/office/operators/{CreateOperatorDialog.tsx,operator-forms.ts}           задача 7
apps/standalone/src/office/devices/{DeviceDialog.tsx,station-shift.ts}, test/devices-page.test.tsx   задача 7
apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx, test/shift-totals.test.tsx         задача 9
apps/standalone/src/app/shell.css                                                          задачи 3, 6
apps/standalone/src/i18n/ru.json                                                           задачи 2–7, 9
apps/standalone/AGENTS.md                                                                  задачи 8, 9
docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md                  задача 8
```

Слой протокола (задача 1) и правила с чистыми функциями (задача 2) идут первыми: страница опирается на оба, а их тесты не зависят от экранов. Страница приходит сначала без кнопок записи (задача 3: список, названия, пометки, отбор, период, страницы), затем каждое действие — со своим окном: планирование (задача 4), правка запланированной и план активной (задача 5), удаление и закрытие (задача 6), поэтому мёртвых кнопок нет ни на одном коммите. Задача 7 — три мелочи офиса из очереди ревью и вопроса В9, независимые от страницы смен (предупреждение в «Устройствах» читает тот же список смен хоста). Задача 8 переносит решения плана в `AGENTS.md` и §16 спецификации. Задача 9 — итоги смены: она зависит от поля `totals`, которое добавляет план 2a2, и исполняется после него; задачи 1–8 от плана 2a2 не зависят.

---

### Task 1: Слой протокола смен — схемы Zod, построители тел, методы `HostApi`

Офисные маршруты смен плана 2a1 получают зеркало в вебвью. `officeShiftSchema` — ответ хоста, поэтому терпит новые поля (как `OfficeShift` в `proto`); `shiftCreateSchema`, `shiftUpdateSchema` и `shiftCloseSchema` — тела запросов, строгие, как `deny_unknown_fields` хоста. В `shiftUpdateSchema` `null` допускают только `plannedQty` и `counterpartyId`: в остальных полях хост читает `null` как «не прислано», и построитель не должен его слать. `closeReasonCode` читается текстом, а не перечнем: код, который добавит более новый хост, не должен ронять весь список (страница покажет его как есть).

Построители, как все офисные, называют каждое поле: `shiftCreate` шлёт всё, `null` за пустой план и контрагента, и явно `mode: "aggregation"`, `palletsEnabled: false` — значения по умолчанию хоста не решают, что запланировано; `shiftUpdate` шлёт только отличное от загруженной смены с её ревизией; `shiftClose` — причину и ревизию. `test/protocol.test.ts` проверяет, что каждый строит свою фикстуру плана 2a1 точно, а `test/api.test.ts` — маршрут и тело каждого метода. Две фикстуры отказов (`error-shift-busy.json`, `error-sscc-exhausted.json`) разбираются общей `errorBodySchema`.

Попутно (пункт 9 очереди 2a1): два образца ответа `hello` в тестах вебвью ещё говорят «протокол 1»; они берут `PROTOCOL_VERSION`, чтобы не устаревать снова. Фикстура `proto/fixtures/error-with-details.json` (тоже «1..=1») — общая с Rust; её чинит итоговая волна плана 2a1 или следующий план хоста, этот план `proto` не трогает.

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`
- Test (Modify): `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/probe.test.ts`, `apps/standalone/test/support/fixtures.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: фикстуры плана 2a1 `proto/fixtures/{office-shift,shift-create,shift-update,shift-close,error-shift-busy,error-sscc-exhausted}.json`; `HostClient.request` (`src/host/client.ts`).
- Produces:
  - `src/host/protocol.ts`: `shiftStatusSchema` / `ShiftStatus` (`"planned" | "active" | "closed"`), `shiftModeSchema` / `ShiftMode`, `shiftOriginSchema` / `ShiftOrigin`, `officeShiftSchema` / `OfficeShift`, `shiftCreateSchema` / `ShiftCreate`, `shiftUpdateSchema` / `ShiftUpdate`, `shiftCloseSchema` / `ShiftClose`;
  - `src/host/requests.ts`: `interface ShiftInput { productId; lineId; productionDate; boxTemplateId; boxCapacity: number; plannedQty: number | null; counterpartyId: string | null }`, `shiftCreate(shift: ShiftInput): ShiftCreate`, `interface ShiftChange` (все поля необязательны; `plannedQty` и `counterpartyId` принимают `null`), `shiftUpdate(shift: Pick<OfficeShift, "lineId" | "productionDate" | "boxTemplateId" | "boxCapacity" | "plannedQty" | "counterpartyId" | "rev">, next: ShiftChange): ShiftUpdate`, `shiftClose(reason: string, expectedRev: number): ShiftClose`;
  - `src/host/api.ts`: `interface ShiftPeriod { from: string; to: string }`; методы `HostApi`: `listShifts(token, period?: ShiftPeriod): Promise<OfficeShift[]>`, `createShift(token, create): Promise<OfficeShift>`, `updateShift(token, id, update): Promise<OfficeShift>`, `deleteShift(token, id): Promise<void>`, `closeShift(token, id, close): Promise<OfficeShift>`;
  - `test/support/office.tsx`: `fakeHostApi` с теми же пятью методами (без заглушки — громкий отказ).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  templateCreateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftUpdateSchema,
  templateCreateSchema,
```

2. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  fixture("template-defaults-update.json"),
);

type Case = [
```

заменить на

<!-- prettier-ignore -->
```ts
  fixture("template-defaults-update.json"),
);
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));

type Case = [
```

3. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  [
    "setUserPassword",
```

заменить на

<!-- prettier-ignore -->
```ts
  [
    "listShifts",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN),
    { method: "GET", path: "/v1/office/shifts", body: undefined },
  ],
  [
    "listShifts for a period",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN, { from: "2026-09-01", to: "2026-10-08" }),
    { method: "GET", path: "/v1/office/shifts?from=2026-09-01&to=2026-10-08", body: undefined },
  ],
  [
    "createShift",
    fixture("office-shift.json"),
    (api) => api.createShift(TOKEN, SHIFT_CREATE),
    { method: "POST", path: "/v1/office/shifts", body: SHIFT_CREATE },
  ],
  [
    "updateShift",
    fixture("office-shift.json"),
    (api) => api.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE),
    { method: "PUT", path: `/v1/office/shifts/${SHIFT_ID}`, body: SHIFT_UPDATE },
  ],
  [
    "deleteShift",
    null,
    (api) => api.deleteShift(TOKEN, SHIFT_ID),
    { method: "DELETE", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "closeShift",
    fixture("office-shift.json"),
    (api) => api.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/close`, body: SHIFT_CLOSE },
  ],
  [
    "setUserPassword",
```

4. В `apps/standalone/test/probe.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { createTauriHostProbe, HostProbeError } from "../src/host/probe.js";

const RAW = {
  hello: {
    product: "markiro-host",
    protocol: 1,
    minProtocol: 1,
```

заменить на

<!-- prettier-ignore -->
```ts
import { createTauriHostProbe, HostProbeError } from "../src/host/probe.js";
import { PROTOCOL_VERSION } from "../src/host/protocol.js";

const RAW = {
  hello: {
    product: "markiro-host",
    protocol: PROTOCOL_VERSION,
    minProtocol: 1,
```

5. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  officeSessionSchema,
  officeUserCreateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  officeSessionSchema,
  officeShiftSchema,
  officeUserCreateSchema,
```

6. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  siteRecordSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftUpdateSchema,
  siteRecordSchema,
```

7. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productUpdate,
  templateCreate,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdate,
  shiftClose,
  shiftCreate,
  shiftUpdate,
  templateCreate,
```

8. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["error-template-is-default.json", errorBodySchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

9. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
  ["shift-create.json", shiftCreateSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
] as const;
```

10. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });

  it("template defaults that keep each slot's own template and send only the fields they name", () => {
    const box = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
```

заменить на

<!-- prettier-ignore -->
```ts
  });

  it("a shift to plan, one moved to another line and day with its plan cleared, and one to close", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    // A form holds more than the builder names: the product's name must not go.
    const typed = {
      productId: shift.productId,
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: shift.boxCapacity,
      plannedQty: 1200,
      counterpartyId: shift.counterpartyId,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(shiftCreate(typed)).toStrictEqual(fixture("shift-create.json"));
    // Loaded on another line, moved back to the fixture's line.
    const elsewhere = { ...shift, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" };
    expect(
      shiftUpdate(elsewhere, {
        lineId: shift.lineId,
        productionDate: "2026-10-09",
        boxTemplateId: shift.boxTemplateId,
        boxCapacity: shift.boxCapacity,
        plannedQty: null,
        counterpartyId: shift.counterpartyId,
      }),
    ).toStrictEqual(fixture("shift-update.json"));
    expect(shiftClose("Станция линии 2 вышла из строя", shift.rev)).toStrictEqual(
      fixture("shift-close.json"),
    );
  });

  it("template defaults that keep each slot's own template and send only the fields they name", () => {
    const box = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
```

11. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      expect(templateUpdateSchema.parse(body)).toStrictEqual(body);
    }
```

заменить на

<!-- prettier-ignore -->
```ts
      expect(templateUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  it("names only the shift fields that differ, clears a plan or a counterparty with null and never sends null elsewhere", () => {
    const shift = {
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      productionDate: "2026-10-08",
      boxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
      rev: 71,
    };
    const same = {
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: shift.boxCapacity,
      plannedQty: shift.plannedQty,
      counterpartyId: shift.counterpartyId,
    };
    const other = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    const bodies = [
      [shiftUpdate(shift, {}), { expectedRev: 71 }],
      [shiftUpdate(shift, same), { expectedRev: 71 }],
      [shiftUpdate(shift, { ...same, lineId: other }), { lineId: other, expectedRev: 71 }],
      [
        shiftUpdate(shift, { ...same, productionDate: "2026-10-09" }),
        { productionDate: "2026-10-09", expectedRev: 71 },
      ],
      [
        shiftUpdate(shift, { ...same, boxTemplateId: other }),
        { boxTemplateId: other, expectedRev: 71 },
      ],
      [shiftUpdate(shift, { ...same, boxCapacity: 24 }), { boxCapacity: 24, expectedRev: 71 }],
      [shiftUpdate(shift, { ...same, plannedQty: 1500 }), { plannedQty: 1500, expectedRev: 71 }],
      [shiftUpdate(shift, { ...same, plannedQty: null }), { plannedQty: null, expectedRev: 71 }],
      [
        shiftUpdate(shift, { ...same, counterpartyId: null }),
        { counterpartyId: null, expectedRev: 71 },
      ],
      // No plan and no counterparty, given one: the change goes.
      [
        shiftUpdate(
          { ...shift, plannedQty: null, counterpartyId: null },
          { plannedQty: 800, counterpartyId: other },
        ),
        { plannedQty: 800, counterpartyId: other, expectedRev: 71 },
      ],
      // `null` over `null` is no change.
      [
        shiftUpdate(
          { ...shift, plannedQty: null, counterpartyId: null },
          {
            plannedQty: null,
            counterpartyId: null,
          },
        ),
        { expectedRev: 71 },
      ],
    ] as const;
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
```

12. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
});

describe("shift shapes", () => {
  it("read a planned shift without a plan, a counterparty, an owner or times, and a closed one", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const planned = {
      ...shift,
      status: "planned",
      counterpartyId: null,
      plannedQty: null,
      ownerDeviceId: null,
      openedAt: null,
    };
    expect(officeShiftSchema.parse(planned)).toEqual(planned);
    const closed = {
      ...shift,
      status: "closed",
      createdFrom: "station",
      number: "OCT26-005/S",
      closedAt: "2026-10-08T14:00:00Z",
      closeReasonCode: "equipment_stop",
      lateDataAt: "2026-10-08T14:30:00Z",
    };
    expect(officeShiftSchema.parse(closed)).toEqual(closed);
  });

  it("refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive whole number and a date of another form", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const refused: Record<string, unknown[]> = {
      status: ["open", null],
      mode: ["boxes", null],
      createdFrom: ["admin", null],
      id: ["42"],
      productId: ["42", null],
      lineId: ["42", null],
      boxTemplateId: ["42", null],
      counterpartyId: ["42"],
      ownerDeviceId: ["42"],
      plannedQty: [0, 1.5, -1, "1200"],
      boxCapacity: [0, 1.5, null],
      productionDate: ["08.10.2026", "2026-10-8", 20261008, null],
      openedAt: ["yesterday"],
      rev: [1.5, null],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = officeShiftSchema.safeParse({ ...shift, [field]: value });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it("refuse null in a shift's update where the host would read it as keep, and take it for the plan and the counterparty", () => {
    for (const field of [
      "lineId",
      "productionDate",
      "boxTemplateId",
      "boxCapacity",
      "mode",
      "palletsEnabled",
    ]) {
      expect(shiftUpdateSchema.safeParse({ [field]: null, expectedRev: 71 }).success, field).toBe(
        false,
      );
    }
    for (const field of ["plannedQty", "counterpartyId"]) {
      expect(shiftUpdateSchema.safeParse({ [field]: null, expectedRev: 71 }).success, field).toBe(
        true,
      );
    }
  });

  it("read the refusals of a busy shift and of a prefix with no serials left", () => {
    expect(errorBodySchema.parse(fixture("error-shift-busy.json")).error).toMatchObject({
      code: "conflict",
      details: { constraint: "shift_busy" },
    });
    expect(errorBodySchema.parse(fixture("error-sscc-exhausted.json")).error).toMatchObject({
      code: "sscc_exhausted",
      details: { issuerPrefix: "460068200", extension: 0 },
    });
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
```

13. В `apps/standalone/test/support/fixtures.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { DeviceStatus, OfficeSession } from "../../src/host/protocol.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  PROTOCOL_VERSION,
  type DeviceStatus,
  type OfficeSession,
} from "../../src/host/protocol.js";
```

14. В `apps/standalone/test/support/fixtures.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      protocol: 1,
```

заменить на

<!-- prettier-ignore -->
```ts
      protocol: PROTOCOL_VERSION,
```

15. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    ),
    ...overrides,
```

заменить на

<!-- prettier-ignore -->
```tsx
    ),
    listShifts: vi.fn<HostApi["listShifts"]>(() => unexpected("listShifts")),
    createShift: vi.fn<HostApi["createShift"]>(() => unexpected("createShift")),
    updateShift: vi.fn<HostApi["updateShift"]>(() => unexpected("updateShift")),
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    ...overrides,
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts test/probe.test.ts`
Expected: FAIL — `test/api.test.ts` не загружается (`TypeError: Cannot read properties of undefined (reading 'parse')`: файл разбирает фикстуры смен схемами, которых ещё нет); в `test/protocol.test.ts` падают 13 новых тестов (`Cannot read properties of undefined (reading 'parse')` и `'safeParse'`, `shiftUpdate is not a function`), прежние проходят; `test/probe.test.ts` проходит.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  ssccCounterSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  officeShiftSchema,
  ssccCounterSchema,
```

2. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type OfficeSession,
  type OfficeUser,
```

заменить на

<!-- prettier-ignore -->
```ts
  type OfficeSession,
  type OfficeShift,
  type OfficeUser,
```

3. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type SsccCounter,
```

заменить на

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftUpdate,
  type SsccCounter,
```

4. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  extension: number;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  extension: number;
}

/** A period of production dates, both ends included, `YYYY-MM-DD`. */
export interface ShiftPeriod {
  from: string;
  to: string;
}
```

5. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ) => Promise<TemplateDefaults>;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  ) => Promise<TemplateDefaults>;
  /**
   * Without a period every planned and active shift and the closed ones
   * produced in the last 31 days of the host's clock; with one, every shift
   * produced in it. Newest production date first.
   */
  listShifts: (token: string, period?: ShiftPeriod) => Promise<OfficeShift[]>;
  createShift: (token: string, create: ShiftCreate) => Promise<OfficeShift>;
  updateShift: (token: string, id: string, update: ShiftUpdate) => Promise<OfficeShift>;
  /** `204`, only a planned shift; a delete repeated after a lost answer is `not_found`. */
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
}
```

6. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        schema: templateDefaultsSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        schema: templateDefaultsSchema,
      }),
    listShifts: (token, period) =>
      client.request(
        "GET",
        period === undefined
          ? "/v1/office/shifts"
          : `/v1/office/shifts?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
        { officeToken: token, schema: z.array(officeShiftSchema) },
      ),
    createShift: (token, create) =>
      client.request("POST", "/v1/office/shifts", {
        body: create,
        officeToken: token,
        schema: officeShiftSchema,
      }),
    updateShift: (token, id, update) =>
      client.request("PUT", `/v1/office/shifts/${id}`, {
        body: update,
        officeToken: token,
        schema: officeShiftSchema,
      }),
    deleteShift: async (token, id) => {
      await client.request("DELETE", `/v1/office/shifts/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
        body: close,
        officeToken: token,
        schema: officeShiftSchema,
      }),
  };
}
```

7. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;

/** Mirrors `markiro_proto::ShiftStatus`: planned in the office, active once a station opened it, closed for good. */
export const shiftStatusSchema = z.enum(["planned", "active", "closed"]);
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

/** Mirrors `markiro_proto::ShiftMode`: the host takes only `aggregation` in stage 2a. */
export const shiftModeSchema = z.enum(["aggregation", "validation"]);
export type ShiftMode = z.infer<typeof shiftModeSchema>;

/** Mirrors `markiro_proto::ShiftOrigin`: planned in the office or created at a station (`/S`). */
export const shiftOriginSchema = z.enum(["office", "station"]);
export type ShiftOrigin = z.infer<typeof shiftOriginSchema>;

/** A civil date as the host writes it, `YYYY-MM-DD`; the host has checked it is a real date. */
const civilDateTextSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

/**
 * `GET /v1/office/shifts` and the answer of every office write of a shift. It
 * carries ids, not names: the office names products, lines and counterparties
 * from its own lists. `closeReasonCode` is one of the domain's six codes of a
 * station's close (plan 2a2), read as text so a code a newer host adds does
 * not fail the list; `closeReasonText` is the office's words.
 */
export const officeShiftSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  status: shiftStatusSchema,
  mode: shiftModeSchema,
  palletsEnabled: z.boolean(),
  createdFrom: shiftOriginSchema,
  productId: z.uuid(),
  lineId: z.uuid(),
  counterpartyId: z.uuid().nullable(),
  productionDate: civilDateTextSchema,
  plannedQty: z.number().int().positive().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closeReasonCode: z.string().nullable(),
  closeReasonText: z.string().nullable(),
  lateDataAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  rev: z.number().int(),
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

8. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export type TemplateDefaultsUpdate = z.infer<typeof templateDefaultsUpdateSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
export type TemplateDefaultsUpdate = z.infer<typeof templateDefaultsUpdateSchema>;

/**
 * `POST /v1/office/shifts`: a planned shift. The office always sends the box
 * capacity, `null` for no plan or no counterparty, and `mode` and
 * `palletsEnabled` as the only values stage 2a takes.
 */
export const shiftCreateSchema = z
  .object({
    productId: z.uuid(),
    lineId: z.uuid(),
    productionDate: z.string(),
    boxTemplateId: z.uuid(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
  })
  .strict();
export type ShiftCreate = z.infer<typeof shiftCreateSchema>;

/**
 * `PUT /v1/office/shifts/{id}`: only the fields sent change, over the loaded
 * revision. `plannedQty: null` and `counterpartyId: null` clear them; every
 * other field is left out or a value, never `null`, which the host would read
 * as «keep». The product never changes, so it is no field.
 */
export const shiftUpdateSchema = z
  .object({
    lineId: z.uuid().optional(),
    productionDate: z.string().optional(),
    boxTemplateId: z.uuid().optional(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type ShiftUpdate = z.infer<typeof shiftUpdateSchema>;

/** `POST /v1/office/shifts/{id}/close`: the office's reason in words, over the loaded revision. */
export const shiftCloseSchema = z
  .object({ reason: z.string(), expectedRev: z.number().int() })
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;
```

9. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  OfficeOperator,
  OperatorCreate,
```

заменить на

<!-- prettier-ignore -->
```ts
  OfficeOperator,
  OfficeShift,
  OperatorCreate,
```

10. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ProductUpdate,
  TemplateCreate,
```

заменить на

<!-- prettier-ignore -->
```ts
  ProductUpdate,
  ShiftClose,
  ShiftCreate,
  ShiftUpdate,
  TemplateCreate,
```

11. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    })),
    expectedRev,
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
    })),
    expectedRev,
  };
}

/**
 * A planned shift's fields: ids the form chose, the production date
 * `YYYY-MM-DD`, the counts the form accepted, `null` for no plan or no
 * counterparty.
 */
export interface ShiftInput {
  productId: string;
  lineId: string;
  productionDate: string;
  boxTemplateId: string;
  boxCapacity: number;
  plannedQty: number | null;
  counterpartyId: string | null;
}

/**
 * `POST /v1/office/shifts` (`shift-create.json`): every field, `null` for
 * none, and the mode and pallets stage 2a takes, so the host's defaults never
 * decide what was planned.
 */
export function shiftCreate(shift: ShiftInput): ShiftCreate {
  return {
    productId: shift.productId,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    boxTemplateId: shift.boxTemplateId,
    boxCapacity: shift.boxCapacity,
    plannedQty: shift.plannedQty,
    counterpartyId: shift.counterpartyId,
    mode: "aggregation",
    palletsEnabled: false,
  };
}

/**
 * What a shift is to become; a field left out stays as it is. `plannedQty`
 * and `counterpartyId` take `null` for none.
 */
export interface ShiftChange {
  lineId?: string;
  productionDate?: string;
  boxTemplateId?: string;
  boxCapacity?: number;
  plannedQty?: number | null;
  counterpartyId?: string | null;
}

/**
 * `PUT /v1/office/shifts/{id}` (`shift-update.json`): only the fields that
 * differ from the loaded shift, with its revision; `null` clears the plan or
 * the counterparty. An active shift takes only its plan, which the caller
 * alone changes.
 */
export function shiftUpdate(
  shift: Pick<
    OfficeShift,
    | "lineId"
    | "productionDate"
    | "boxTemplateId"
    | "boxCapacity"
    | "plannedQty"
    | "counterpartyId"
    | "rev"
  >,
  next: ShiftChange,
): ShiftUpdate {
  const update: ShiftUpdate = { expectedRev: shift.rev };
  if (next.lineId !== undefined && next.lineId !== shift.lineId) update.lineId = next.lineId;
  if (next.productionDate !== undefined && next.productionDate !== shift.productionDate) {
    update.productionDate = next.productionDate;
  }
  if (next.boxTemplateId !== undefined && next.boxTemplateId !== shift.boxTemplateId) {
    update.boxTemplateId = next.boxTemplateId;
  }
  if (next.boxCapacity !== undefined && next.boxCapacity !== shift.boxCapacity) {
    update.boxCapacity = next.boxCapacity;
  }
  if (next.plannedQty !== undefined && next.plannedQty !== shift.plannedQty) {
    update.plannedQty = next.plannedQty;
  }
  if (next.counterpartyId !== undefined && next.counterpartyId !== shift.counterpartyId) {
    update.counterpartyId = next.counterpartyId;
  }
  return update;
}

/**
 * `POST /v1/office/shifts/{id}/close` (`shift-close.json`): the trimmed
 * reason `closeReasonRule` accepted, with the loaded revision.
 */
export function shiftClose(reason: string, expectedRev: number): ShiftClose {
  return { reason, expectedRev };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts test/probe.test.ts --reporter=verbose`
Expected: PASS — 3 файла, 260 тестов (было 236); stderr пуст.

- [ ] **Step 5: Мутации**

Мутация 1 — `shiftCreate` перестаёт слать `mode` (решает значение хоста по умолчанию). В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
    mode: "aggregation",
    palletsEnabled: false,
  };
```

заменить на

<!-- prettier-ignore -->
```ts
    palletsEnabled: false,
  };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "a shift to plan"`
Expected: FAIL — «request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its plan cleared, and one to close» — `AssertionError: expected { …(8) } to strictly equal { …(9) }`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — `shiftUpdate` шлёт план, даже когда он не изменился. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (next.plannedQty !== undefined && next.plannedQty !== shift.plannedQty) {
```

заменить на

<!-- prettier-ignore -->
```ts
  if (next.plannedQty !== undefined) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "names only the shift fields that differ"`
Expected: FAIL — «request builders send only what changes > names only the shift fields that differ, clears a plan or a counterparty with null and never sends null elsewhere» — `AssertionError: expected { expectedRev: 71, plannedQty: 1200 } to strictly equal { expectedRev: 71 }`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — `shiftUpdateSchema` берёт `null` в `lineId`, который хост прочёл бы как «не прислано». В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    lineId: z.uuid().optional(),
    productionDate: z.string().optional(),
```

заменить на

<!-- prettier-ignore -->
```ts
    lineId: z.uuid().nullable().optional(),
    productionDate: z.string().optional(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "refuse null in a shift"`
Expected: FAIL — «shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan and the counterparty» — `AssertionError: lineId: expected true to be false // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — путь периода повторяет начало вместо конца. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
&to=${encodeURIComponent(period.to)}
```

заменить на

<!-- prettier-ignore -->
```ts
&to=${encodeURIComponent(period.from)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts -t "listShifts for a period"`
Expected: FAIL — «HostApi office endpoints > listShifts for a period sends the office token to the right route» — `AssertionError: expected [ { method: 'GET', …(3) } ] to deeply equal [ { method: 'GET', …(3) } ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — план смены принимает 0. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  plannedQty: z.number().int().positive().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  ownerDeviceId
```

заменить на

<!-- prettier-ignore -->
```ts
  plannedQty: z.number().int().nonnegative().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  ownerDeviceId
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "refuse an unknown status"`
Expected: FAIL — «shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive whole number and a date of another form» — `AssertionError: plannedQty: 0: expected true to be false // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/probe.test.ts apps/standalone/test/support/fixtures.ts apps/standalone/test/support/office.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 67 файлов, 1768 тестов (1744 + 24).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/probe.test.ts apps/standalone/test/support/fixtures.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the webview's shift schemas, request builders and HostApi methods" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Гражданские даты, правила формы смены и шаблон короба новой смены

Три чистых модуля, на которые опираются окна задач 4–6 (и станция плана 2a5).

`src/lib/civil-date.ts`: `isCivilDate` читает дату так же, как хост (`shifts::civil_date`: ровно `YYYY-MM-DD` ASCII-цифрами, годы 0001–9999, день, который есть в месяце). Тест сверяет его со всеми датами `proto/fixtures/shift-numbers.json`, которую хост и домен уже читают: дата с ключом месяца принимается, без него — нет; год 0000, которого в фикстуре нет, проверяется отдельно. `civilDaysBetween` считает дни через `setUTCFullYear`, а не `Date.UTC`, который читает годы 0–99 как 1900–1999. `civilToday(timeZone, now)` — сегодняшняя дата в часовом поясе организации (`Intl.DateTimeFormat` с `timeZone`); без пояса или с незнакомым поясом — дата этого ПК.

`src/lib/rules.ts`: план (1–10 000 000 или пусто, `MAX_PLANNED_QTY` — зеркало `validate::MAX_PLANNED_QTY`), вместимость короба смены (1–100 000, обязательна: форма всегда шлёт её), дата производства, причина закрытия (3–500 символов). Причина — пункт 14 очереди 2a1: zod считает длину в единицах UTF-16, а хост — в символах (`chars()`), поэтому два эмодзи (4 единицы) прошли бы `min(3)` и были бы отвергнуты хостом, а 500 эмодзи — наоборот. Правило строится на прежнем `plainTextRule`, который считает `characters()` (кодовые точки); у него появляется необязательный нижний предел `min` (по умолчанию 1, остальные поля не меняются). Тест держит обе стороны ловушки: показывает, что `z.string().min(3)` берёт «😀😀», а правило — нет, и что `max(500)` отвергает 500 эмодзи, а правило — берёт.

`src/lib/box-template-choice.ts`: `suggestBoxTemplate(product, templates, defaults)` — правило решения 7 и этапа 1: предпочтение товара, затем умолчание короба его категории, затем умолчание организации — первое, что есть в списке и подходит группе товара (`templateFitsSlot`); ничего — `null`, выбирает человек. Типы входа минимальные, чтобы новая смена станции (план 2a5) взяла функцию со своими копиями.

Тексты четырёх правил приходят здесь же; тест проверяет их слова, потому что окна, которые их покажут, приходят в задачах 4–6.

**Files:**

- Create: `apps/standalone/src/lib/civil-date.ts`, `apps/standalone/src/lib/box-template-choice.ts`
- Modify: `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/civil-date.test.ts`, `apps/standalone/test/box-template-choice.test.ts` (Create); `apps/standalone/test/rules.test.ts` (Modify)

**Interfaces:**

- Consumes: `templateFitsSlot`, `type TemplateScope` (`src/lib/template-eligibility.ts`); `characters`, `countRule`, `plainTextRule`, `WHOLE_NUMBER`, `MAX_BOX_CAPACITY` (`src/lib/rules.ts`).
- Produces:
  - `src/lib/civil-date.ts`: `isCivilDate(text: string): boolean`, `civilDaysBetween(from: string, to: string): number` (бросает `RangeError` на не-дату), `civilToday(timeZone: string | null, now?: Date): string`;
  - `src/lib/rules.ts`: `plainTextRule(max, message, min = 1)`, `requiredCountRule(max, message)`, `MAX_PLANNED_QTY = 10_000_000`, `plannedQtyRule`, `shiftBoxCapacityRule`, `productionDateRule`, `MIN_CLOSE_REASON = 3`, `MAX_CLOSE_REASON = 500`, `closeReasonRule`;
  - `src/lib/box-template-choice.ts`: `interface BoxTemplateProduct { chzProductGroupCode: number | null; defaultBoxTemplateId: string | null }`, `interface BoxTemplateCandidate extends TemplateScope { id: string }`, `interface BoxTemplateDefaults { defaultBoxTemplateId: string | null; categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[] }`, `suggestBoxTemplate(product, templates, defaults: BoxTemplateDefaults | null): string | null`;
  - ключи `rules.plannedQty`, `rules.shiftBoxCapacity`, `rules.productionDate`, `rules.closeReason`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/box-template-choice.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  suggestBoxTemplate,
  type BoxTemplateCandidate,
  type BoxTemplateDefaults,
} from "../src/lib/box-template-choice.js";

const PREFERRED = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

/** An enabled box template for every category. */
function box(id: string, scope: Partial<BoxTemplateCandidate> = {}): BoxTemplateCandidate {
  return { id, purpose: "box", enabled: true, chzProductGroupCodes: null, ...scope };
}

const TEMPLATES = [box(PREFERRED), box(CATEGORY, { chzProductGroupCodes: [8] }), box(ORGANIZATION)];

const DEFAULTS: BoxTemplateDefaults = {
  defaultBoxTemplateId: ORGANIZATION,
  categories: [
    { chzProductGroupCode: 8, purpose: "pallet", templateId: OTHER },
    { chzProductGroupCode: 13, purpose: "box", templateId: OTHER },
    { chzProductGroupCode: 8, purpose: "box", templateId: CATEGORY },
  ],
};

const MILK = { chzProductGroupCode: 8, defaultBoxTemplateId: PREFERRED };

describe("the box template a new shift starts with", () => {
  it("takes the product's preference when it fits", () => {
    expect(suggestBoxTemplate(MILK, TEMPLATES, DEFAULTS)).toBe(PREFERRED);
  });

  it("passes over a preference that is off, of another purpose, narrowed away or gone, to the category's box default", () => {
    for (const preferred of [
      box(PREFERRED, { enabled: false }),
      box(PREFERRED, { purpose: "pallet" }),
      box(PREFERRED, { chzProductGroupCodes: [13] }),
    ]) {
      const templates = [preferred, ...TEMPLATES.slice(1)];
      expect(suggestBoxTemplate(MILK, templates, DEFAULTS), JSON.stringify(preferred)).toBe(
        CATEGORY,
      );
    }
    expect(suggestBoxTemplate(MILK, TEMPLATES.slice(1), DEFAULTS)).toBe(CATEGORY);
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, DEFAULTS)).toBe(
      CATEGORY,
    );
  });

  it("takes the organization's default when the category has no box default, or its default does not fit or is gone", () => {
    const noPreference = { chzProductGroupCode: 8, defaultBoxTemplateId: null };
    const withoutCategory = { ...DEFAULTS, categories: DEFAULTS.categories.slice(0, 2) };
    expect(suggestBoxTemplate(noPreference, TEMPLATES, withoutCategory)).toBe(ORGANIZATION);
    const categoryOff = [
      box(PREFERRED),
      box(CATEGORY, { enabled: false, chzProductGroupCodes: [8] }),
      box(ORGANIZATION),
    ];
    expect(suggestBoxTemplate(noPreference, categoryOff, DEFAULTS)).toBe(ORGANIZATION);
    // Group 13's box default is not in the list.
    const water = { chzProductGroupCode: 13, defaultBoxTemplateId: null };
    expect(suggestBoxTemplate(water, TEMPLATES, DEFAULTS)).toBe(ORGANIZATION);
  });

  it("reads only the box default of the product's own group", () => {
    const noPreference = { chzProductGroupCode: 8, defaultBoxTemplateId: null };
    // `OTHER` fits as a box template, but it is group 8's pallet default and group 13's box default.
    const templates = [...TEMPLATES, box(OTHER)];
    const others = { ...DEFAULTS, categories: DEFAULTS.categories.slice(0, 2) };
    expect(suggestBoxTemplate(noPreference, templates, others)).toBe(ORGANIZATION);
  });

  it("skips the category for a product without a group, and gives none when nothing fits", () => {
    const noGroup = { chzProductGroupCode: null, defaultBoxTemplateId: null };
    expect(suggestBoxTemplate(noGroup, TEMPLATES, DEFAULTS)).toBe(ORGANIZATION);
    const narrowed = [box(ORGANIZATION, { chzProductGroupCodes: [13] })];
    expect(suggestBoxTemplate(noGroup, narrowed, DEFAULTS)).toBeNull();
    expect(suggestBoxTemplate(noGroup, [], DEFAULTS)).toBeNull();
  });

  it("counts only the preference while the defaults are not read", () => {
    expect(suggestBoxTemplate(MILK, TEMPLATES, null)).toBe(PREFERRED);
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, null)).toBeNull();
  });
});
```

2. Создать `apps/standalone/test/civil-date.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { civilDaysBetween, civilToday, isCivilDate } from "../src/lib/civil-date.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** The dates of `shift-numbers.json`: the host takes those with a month key and refuses the rest. */
const DATES = z
  .object({ monthKeys: z.array(z.object({ date: z.string(), monthKey: z.string().nullable() })) })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-numbers.json", testModuleUrl), "utf8"),
    ),
  ).monthKeys;

describe("civil dates", () => {
  it.each(DATES.map((each) => [each.date, each.monthKey !== null] as const))(
    "reads %j as the host does: taken %s",
    (date, taken) => {
      expect(isCivilDate(date)).toBe(taken);
    },
  );

  it("refuses the year 0000, which the host refuses and the fixture leaves out, and takes 0001 and 9999", () => {
    expect(isCivilDate("0000-01-01")).toBe(false);
    expect(isCivilDate("0001-01-01")).toBe(true);
    expect(isCivilDate("9999-12-31")).toBe(true);
    // Every month's last day, and the one after it.
    const last = ["31", "28", "31", "30", "31", "30", "31", "31", "30", "31", "30", "31"];
    last.forEach((day, index) => {
      const month = String(index + 1).padStart(2, "0");
      expect(isCivilDate(`2026-${month}-${day}`), `2026-${month}-${day}`).toBe(true);
      const after = String(Number(day) + 1);
      expect(isCivilDate(`2026-${month}-${after}`), `2026-${month}-${after}`).toBe(false);
    });
  });

  it("counts the days between two dates across a month, a leap day, a year and the first years", () => {
    expect(civilDaysBetween("2026-10-08", "2026-10-08")).toBe(0);
    expect(civilDaysBetween("2026-10-08", "2026-10-09")).toBe(1);
    expect(civilDaysBetween("2026-10-09", "2026-10-08")).toBe(-1);
    expect(civilDaysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(civilDaysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(civilDaysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(civilDaysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(civilDaysBetween("2028-01-01", "2029-01-01")).toBe(366);
    // `Date.UTC` would read the year 24 as 1924; the days of 0024 are counted as they are.
    expect(civilDaysBetween("0024-02-28", "0024-03-01")).toBe(2);
    expect(civilDaysBetween("0099-12-31", "0100-01-01")).toBe(1);
    expect(() => civilDaysBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
  });

  it("gives today's date in the organization's zone, not this PC's", () => {
    const evening = new Date("2026-10-08T21:30:00Z");
    expect(civilToday("Europe/Moscow", evening)).toBe("2026-10-09");
    expect(civilToday("UTC", evening)).toBe("2026-10-08");
    expect(civilToday("America/New_York", new Date("2026-10-09T02:00:00Z"))).toBe("2026-10-08");
    expect(civilToday("Asia/Kamchatka", new Date("2026-12-31T12:30:00Z"))).toBe("2027-01-01");
  });

  it("falls back to this PC's date without a zone or with one the runtime does not know", () => {
    const now = new Date(2026, 9, 8, 23, 59);
    expect(civilToday(null, now)).toBe("2026-10-08");
    expect(civilToday("Mars/Olympus_Mons", now)).toBe("2026-10-08");
  });
});
```

3. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { z } from "zod";
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";
```

4. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  boxCapacityRule,
  companyNameRule,
```

заменить на

<!-- prettier-ignore -->
```ts
  boxCapacityRule,
  closeReasonRule,
  companyNameRule,
```

5. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  MAX_PALLET_BOX_CAPACITY,
  MAX_PRODUCT_NAME,
  MAX_SHELF_LIFE_DAYS,
```

заменить на

<!-- prettier-ignore -->
```ts
  MAX_CLOSE_REASON,
  MAX_PALLET_BOX_CAPACITY,
  MAX_PLANNED_QTY,
  MAX_PRODUCT_NAME,
  MAX_SHELF_LIFE_DAYS,
  MIN_CLOSE_REASON,
```

6. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  printNameRule,
  productGroupRule,
  productNameRule,
  shelfLifeDaysRule,
```

заменить на

<!-- prettier-ignore -->
```ts
  plannedQtyRule,
  printNameRule,
  productGroupRule,
  productionDateRule,
  productNameRule,
  shelfLifeDaysRule,
  shiftBoxCapacityRule,
```

7. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
});

describe("shift rules", () => {
  it("pins the host's caps: a plan of 10 000 000 units, a reason of 3 to 500 characters", () => {
    expect(MAX_PLANNED_QTY).toBe(10_000_000);
    expect(MIN_CLOSE_REASON).toBe(3);
    expect(MAX_CLOSE_REASON).toBe(500);
  });

  it("takes a plan of 1 to 10 000 000 whole units or none, and a box capacity that must be given", () => {
    for (const text of ["", " ", "1", "10000000"]) {
      expect(message(plannedQtyRule, text), text).toBeUndefined();
    }
    for (const text of ["0", "10000001", "1e3", "12.0", "-5", "012"]) {
      expect(message(plannedQtyRule, text), text).toBe("rules.plannedQty");
    }
    for (const text of ["1", " 12 ", "100000"]) {
      expect(message(shiftBoxCapacityRule, text), text).toBeUndefined();
    }
    for (const text of ["", "  ", "0", "100001", "1e3", "12.0", "012"]) {
      expect(message(shiftBoxCapacityRule, text), text).toBe("rules.shiftBoxCapacity");
    }
  });

  it("takes a production date only as a real civil date", () => {
    expect(message(productionDateRule, "2026-10-08")).toBeUndefined();
    expect(message(productionDateRule, "2028-02-29")).toBeUndefined();
    for (const text of ["", "2026-02-29", "08.10.2026", " 2026-10-08", "0000-01-01"]) {
      expect(message(productionDateRule, text), text).toBe("rules.productionDate");
    }
  });

  it("counts a close reason in characters as the host does, not in UTF-16 units as zod's min and max", () => {
    // Two emoji are four UTF-16 units: zod's `min(3)` would take them, the host does not.
    expect(z.string().min(3).safeParse("😀😀").success).toBe(true);
    expect(message(closeReasonRule, "😀😀")).toBe("rules.closeReason");
    expect(message(closeReasonRule, "😀😀😀")).toBeUndefined();
    // 500 emoji are 1000 UTF-16 units: zod's `max(500)` would refuse them, the host takes them.
    expect(z.string().max(500).safeParse("😀".repeat(500)).success).toBe(false);
    expect(message(closeReasonRule, "😀".repeat(500))).toBeUndefined();
    expect(message(closeReasonRule, "😀".repeat(501))).toBe("rules.closeReason");
    expect(message(closeReasonRule, "я".repeat(500))).toBeUndefined();
    expect(message(closeReasonRule, "я".repeat(501))).toBe("rules.closeReason");
    expect(message(closeReasonRule, "абв")).toBeUndefined();
  });

  it("trims a close reason before it counts and refuses a control character or an unpaired surrogate inside", () => {
    expect(closeReasonRule.safeParse("  Станция сломалась  ").data).toBe("Станция сломалась");
    expect(message(closeReasonRule, "  аб  ")).toBe("rules.closeReason");
    expect(message(closeReasonRule, "Станция\tсломалась")).toBe("rules.controlCharacter");
    expect(message(closeReasonRule, "Станция\ud800сломалась")).toBe("rules.controlCharacter");
    // The other free-text fields still take a single character.
    expect(message(personNameRule, "Я")).toBeUndefined();
  });

  it("words each shift rule's message", () => {
    expect(i18n.t("rules.plannedQty")).toBe(
      "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    );
    expect(i18n.t("rules.shiftBoxCapacity")).toBe("Укажите целое число от 1 до 100 000");
    expect(i18n.t("rules.productionDate")).toBe("Укажите дату производства");
    expect(i18n.t("rules.closeReason")).toBe("Опишите причину: от 3 до 500 символов");
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/civil-date.test.ts test/box-template-choice.test.ts`
Expected: FAIL — `test/civil-date.test.ts` и `test/box-template-choice.test.ts` не загружаются (`Failed to resolve import "../src/lib/civil-date.js"`, `…box-template-choice.js`); в `test/rules.test.ts` падают 6 новых тестов «shift rules» (`expected undefined to be 10000000`, `Cannot read properties of undefined (reading 'safeParse')`), 46 прежних проходят.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "productGroup": "Выберите группу из списка"
```

заменить на

<!-- prettier-ignore -->
```json
    "productGroup": "Выберите группу из списка",
    "plannedQty": "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    "shiftBoxCapacity": "Укажите целое число от 1 до 100 000",
    "productionDate": "Укажите дату производства",
    "closeReason": "Опишите причину: от 3 до 500 символов"
```

2. Создать `apps/standalone/src/lib/box-template-choice.ts`:

<!-- prettier-ignore -->
```ts
import { templateFitsSlot, type TemplateScope } from "./template-eligibility.js";

/** What the choice reads of a product: its group and its box template preference. */
export interface BoxTemplateProduct {
  chzProductGroupCode: number | null;
  defaultBoxTemplateId: string | null;
}

/** A template the choice may pick: its id and what decides whether it fits. */
export interface BoxTemplateCandidate extends TemplateScope {
  id: string;
}

/** The defaults the choice falls back on: the organization's box default and the categories'. */
export interface BoxTemplateDefaults {
  defaultBoxTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/**
 * The box template a new shift of `product` starts with (stage 1 rule,
 * `apps/standalone/AGENTS.md` «Catalog and label templates»; stage 2a spec,
 * decision 7): the product's preference, then its category's box default,
 * then the organization's, the first that fits the product's group
 * (`templateFitsSlot`: enabled, of the box purpose, covering the group) and
 * is in `templates`. `null` when none does: the person chooses. `defaults`
 * is `null` while the defaults are not read; then only the preference counts.
 * The station's new shift (plan 2a5) takes the same rule.
 */
export function suggestBoxTemplate(
  product: BoxTemplateProduct,
  templates: readonly BoxTemplateCandidate[],
  defaults: BoxTemplateDefaults | null,
): string | null {
  const group = product.chzProductGroupCode;
  const categoryDefault =
    group === null
      ? undefined
      : defaults?.categories.find(
          (entry) => entry.purpose === "box" && entry.chzProductGroupCode === group,
        )?.templateId;
  const candidates = [
    product.defaultBoxTemplateId,
    categoryDefault ?? null,
    defaults?.defaultBoxTemplateId ?? null,
  ];
  for (const id of candidates) {
    if (id === null) continue;
    const template = templates.find((each) => each.id === id);
    if (
      template !== undefined &&
      templateFitsSlot(template, { purpose: "box", chzProductGroupCode: group })
    ) {
      return id;
    }
  }
  return null;
}
```

3. Создать `apps/standalone/src/lib/civil-date.ts`:

<!-- prettier-ignore -->
```ts
// Civil dates (`YYYY-MM-DD`) as the host reads them (`shifts::civil_date`):
// the calendar's days of the years 0001–9999, with no time and no zone. A
// production date is one, and the label never depends on a clock (stage 2a
// spec, decision 4).

const CIVIL_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Days in `month` (1–12) of `year` in the Gregorian calendar. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The year, month and day of a civil date, or `null` for any other text. */
function parts(text: string): [year: number, month: number, day: number] | null {
  const match = CIVIL_DATE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return [year, month, day];
}

/**
 * Whether `text` is a civil date the host takes: exactly `YYYY-MM-DD` in ASCII
 * digits, a year from 0001, a day the month has. `proto/fixtures/shift-numbers.json`
 * holds the dates the host takes and refuses, and the tests read it.
 */
export function isCivilDate(text: string): boolean {
  return parts(text) !== null;
}

/** Days since 0001-01-01 of a civil date `isCivilDate` accepted. */
function dayNumber(text: string): number {
  const date = parts(text);
  if (date === null) throw new RangeError(`not a civil date: ${JSON.stringify(text)}`);
  const [year, month, day] = date;
  const utc = new Date(0);
  // `Date.UTC` reads the years 0–99 as 1900–1999; `setUTCFullYear` does not.
  utc.setUTCFullYear(year, month - 1, day);
  return Math.round(utc.getTime() / 86_400_000);
}

/** How many days `to` lies after `from` (negative before it); both are civil dates. */
export function civilDaysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Today's civil date in `timeZone` (the organization's IANA zone) at `now`:
 * the office plans a shift for the site's day, not for this PC's. Without a
 * zone, or with one this runtime does not know, it is this PC's own date.
 */
export function civilToday(timeZone: string | null, now: Date = new Date()): string {
  if (timeZone !== null) {
    try {
      const fields = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(now);
      const field = (type: "year" | "month" | "day") =>
        Number(fields.find((part) => part.type === type)?.value);
      return `${pad(field("year"), 4)}-${pad(field("month"), 2)}-${pad(field("day"), 2)}`;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}
```

4. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { hasCyrillic } from "../host/pairing-code.js";
import type { OrgProfileInput } from "../host/protocol.js";

// Field rules shared by the first-run wizard and the office pages. They
```

заменить на

<!-- prettier-ignore -->
```ts
import { hasCyrillic } from "../host/pairing-code.js";
import type { OrgProfileInput } from "../host/protocol.js";
import { isCivilDate } from "./civil-date.js";

// Field rules shared by the first-run wizard and the office pages. They
```

5. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * A free-text field of 1 to `max` characters (`isPlainText`); the value is
 * trimmed. A wrong length says `message`; a control character or an unpaired
 * surrogate says `rules.controlCharacter`, since a tab pasted from a
 * spreadsheet is invisible and a length message would not explain it.
 */
export function plainTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) >= 1 && characters(text) <= max, message)
```

заменить на

<!-- prettier-ignore -->
```ts
 * A free-text field of `min` (1 unless given) to `max` characters, counted as
 * the host counts them (`characters`: code points, where zod's own `min` and
 * `max` count UTF-16 units and an emoji twice); the value is trimmed. A wrong
 * length says `message`; a control character or an unpaired surrogate says
 * `rules.controlCharacter`, since a tab pasted from a spreadsheet is invisible
 * and a length message would not explain it.
 */
export function plainTextRule(max: number, message: string, min = 1): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) >= min && characters(text) <= max, message)
```

6. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
}

/** An optional count `countRule` accepted, as the host takes it: `null` when blank. */
export function toCount(text: string): number | null {
```

заменить на

<!-- prettier-ignore -->
```ts
}

/**
 * A count the form always sends: a whole number from 1 to `max`, checked as
 * text as `countRule` checks it, never blank. `toCount` of an accepted value
 * is its number.
 */
export function requiredCountRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => WHOLE_NUMBER.test(text) && Number(text) <= max, message);
}

/** An optional count `countRule` accepted, as the host takes it: `null` when blank. */
export function toCount(text: string): number | null {
```

7. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return value === "" ? null : Number(value);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  return value === "" ? null : Number(value);
}

// --- Shifts (plan 2a1's `validate.rs`) ---

/** The largest plan of a shift, in units (`validate::MAX_PLANNED_QTY`). */
export const MAX_PLANNED_QTY = 10_000_000;

/** A shift's plan: 1 to `MAX_PLANNED_QTY` units, or none. */
export const plannedQtyRule = countRule(MAX_PLANNED_QTY, "rules.plannedQty");

/** A shift's box capacity: 1 to `MAX_BOX_CAPACITY` units, always sent. */
export const shiftBoxCapacityRule = requiredCountRule(MAX_BOX_CAPACITY, "rules.shiftBoxCapacity");

/** A production date: a civil date the host takes (`validate::civil_date`). */
export const productionDateRule = z.string().refine(isCivilDate, "rules.productionDate");

/** The shortest and the longest reason the office gives for closing a shift. */
export const MIN_CLOSE_REASON = 3;
export const MAX_CLOSE_REASON = 500;

/**
 * The office's reason for closing a shift (`validate::close_reason`): trimmed,
 * 3 to 500 characters counted as the host counts them, with no control
 * character and no unpaired surrogate.
 */
export const closeReasonRule = plainTextRule(
  MAX_CLOSE_REASON,
  "rules.closeReason",
  MIN_CLOSE_REASON,
);
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/civil-date.test.ts test/box-template-choice.test.ts --reporter=verbose`
Expected: PASS — 3 файла, 84 теста (`rules` 52, `civil-date` 26, `box-template-choice` 6); stderr пуст.

- [ ] **Step 5: Мутации**

Мутация 1 — длина свободного текста — в единицах UTF-16 (`text.length`), как у zod. В `apps/standalone/src/lib/rules.ts` фрагмент

<!-- prettier-ignore -->
```ts
    .refine((text) => characters(text) >= min && characters(text) <= max, message)
```

заменить на

<!-- prettier-ignore -->
```ts
    .refine((text) => text.length >= min && text.length <= max, message)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "counts a close reason in characters"`
Expected: FAIL — «shift rules > counts a close reason in characters as the host does, not in UTF-16 units as zod's min and max» — `AssertionError: expected undefined to be 'rules.closeReason' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — год 0000 считается датой. В `apps/standalone/src/lib/civil-date.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (year < 1 || month < 1
```

заменить на

<!-- prettier-ignore -->
```ts
  if (year < 0 || month < 1
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/civil-date.test.ts -t "refuses the year 0000"`
Expected: FAIL — «civil dates > refuses the year 0000, which the host refuses and the fixture leaves out, and takes 0001 and 9999» — `AssertionError: expected true to be false // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — високосный год без правила 400 лет (2000-02-29 отвергнута). В `apps/standalone/src/lib/civil-date.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
```

заменить на

<!-- prettier-ignore -->
```ts
    const leap = year % 4 === 0 && year % 100 !== 0;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/civil-date.test.ts -t "2000-02-29"`
Expected: FAIL — «civil dates > reads "2000-02-29" as the host does: taken true» — `AssertionError: expected false to be true // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — дни считаются через `Date.UTC`, который читает годы 0–99 как 1900–1999. В `apps/standalone/src/lib/civil-date.ts` фрагмент

<!-- prettier-ignore -->
```ts
  utc.setUTCFullYear(year, month - 1, day);
  return Math.round(utc.getTime() / 86_400_000);
```

заменить на

<!-- prettier-ignore -->
```ts
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/civil-date.test.ts -t "counts the days between"`
Expected: FAIL — «civil dates > counts the days between two dates across a month, a leap day, a year and the first years» — `AssertionError: expected -693959 to be 1 // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — часовой пояс организации не учитывается. В `apps/standalone/src/lib/civil-date.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (timeZone !== null) {
```

заменить на

<!-- prettier-ignore -->
```ts
  if (timeZone === "never") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/civil-date.test.ts -t "organization's zone"`
Expected: FAIL — «civil dates > gives today's date in the organization's zone, not this PC's» — `AssertionError: expected '2026-10-09' to be '2026-10-08' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 6 — подсказка шаблона не проверяет, подходит ли он. В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
      template !== undefined &&
      templateFitsSlot(template, { purpose: "box", chzProductGroupCode: group })
```

заменить на

<!-- prettier-ignore -->
```ts
      template !== undefined
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts -t "passes over a preference"`
Expected: FAIL — «the box template a new shift starts with > passes over a preference that is off, of another purpose, narrowed away or gone, to the category's box default» — `AssertionError: {"id":"11111111-1111-4111-8111-111111111111","purpose":"box","enabled":false,"chzProductGroupCodes":null}: expected '11111111-1111-4111-8111-111111111111'…`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 7 — умолчание категории берётся любого назначения. В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
          (entry) => entry.purpose === "box" && entry.chzProductGroupCode === group,
```

заменить на

<!-- prettier-ignore -->
```ts
          (entry) => entry.chzProductGroupCode === group,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts -t "own group"`
Expected: FAIL — «the box template a new shift starts with > reads only the box default of the product's own group» — `AssertionError: expected '44444444-4444-4444-8444-444444444444' to be '33333333-3333-4333-8333-333333333333' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/lib/civil-date.ts apps/standalone/src/lib/box-template-choice.ts apps/standalone/src/lib/rules.ts apps/standalone/src/i18n/ru.json apps/standalone/test/civil-date.test.ts apps/standalone/test/box-template-choice.test.ts apps/standalone/test/rules.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 69 файлов, 1806 тестов (1768 + 38).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/lib/civil-date.ts apps/standalone/src/lib/box-template-choice.ts apps/standalone/src/lib/rules.ts apps/standalone/src/i18n/ru.json apps/standalone/test/civil-date.test.ts apps/standalone/test/box-template-choice.test.ts apps/standalone/test/rules.test.ts
git commit -m "feat(standalone): civil dates, shift form rules and the box template a new shift starts with" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Страница «Смены» — меню, список с названиями и пометками, отбор, период, страницы

Страница приходит без кнопок записи. Пункт меню — в «Производстве» сразу после «Линии», для обеих ролей; маршрут без `RequireRole`. Тест «Операторов», который держит порядок «Линии — Операторы — Устройства», получает «Смены» между первыми двумя.

Список — в порядке хоста. Названия товара, линии и контрагента — из `listProducts`, `listLines`, `listCounterparties`, которые страница читает сама (`recordLabel`: архивная запись с «(в архиве)», отсутствующая или не загруженная — по первым восьми знакам id). Не загрузился один из справочников — список остаётся, одно предупреждение и «Повторить», которое перечитывает только упавшие. Не загрузился сам список — только ошибка с «Повторить» (она же перечитывает упавшие справочники). Пометка «Не откроется» (`openBlocker`) — только у запланированной смены и только по загруженным спискам: товар в архиве, товар-черновик, шаблон, который не подходит группе товара (`templateFitsSlot` для слота короба), — то, что хост ответит при открытии `product_inactive` или `template_not_fit`. У закрытой смены — причина словами (офиса — как есть, станции — по коду домена через `isShiftCloseReasonCode`; незнакомый код — как есть, потому что `t` с отсутствующим ключом в тестах бросает), поздние данные — тег `attention`.

Отбор по статусу и линии, поиск по номеру и названию товара и страницы по 25 — в странице; новый поиск или отбор возвращает на первую страницу. Страницы — общий `OfficePager`, вынесенный из «Товаров» (тексты переносятся из `office.products.pager` в `office.common.pager` теми же словами, подпись навигации остаётся у каждого списка своя).

Период — два `DatePicker` «Дата производства с/по». `periodState` решает: обе пусты — список хоста по умолчанию; одна пуста — `partial`; конец раньше начала — `reversed`; больше 366 дней с обоими концами — `too_long`; иначе — `ready`. Запрошенный период (`asked`) меняется только на `ready` или обратно на «нет» (присваивание во время рендера — приём React для значения из прошлого рендера, не эффект), поэтому, пока период неполный или неверный, показан прежний список, а заметка и ошибка под полем «по» объясняют почему. Ключ запроса — `officeKeys.shiftList(period)`; все ключи списков смен начинаются с `officeKeys.shifts`, по которому задачи 4–6 перечитывают их после записи.

Тесты держат «сегодня» постоянным (`freezeToday`, только `Date`), потому что календарь `DatePicker` открывается на текущем месяце.

**Files:**

- Create: `apps/standalone/src/office/OfficePager.tsx`, `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/office/shifts/shift-list.ts`, `apps/standalone/src/office/shifts/shift-text.ts`
- Modify: `apps/standalone/src/office/products/ProductsPage.tsx`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shifts-page.test.tsx`, `apps/standalone/test/shift-list.test.ts`, `apps/standalone/test/support/shifts.ts` (Create); `apps/standalone/test/operators-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `OfficeShift`, `listShifts`, `ShiftPeriod` (задача 1); `isCivilDate`, `civilDaysBetween` (задача 2); `templateFitsSlot`; `useTemplates` (`src/office/catalog-queries.ts`); `activeFirstByName` (`src/office/records.tsx`); `isShiftCloseReasonCode` (`@markiro/domain`).
- Produces:
  - `src/office/OfficePager.tsx`: `OfficePager({ label, page, pageCount, onPage })`;
  - `src/office/office-query.ts`: `officeKeys.shifts` (`["office", "shifts"]`), `officeKeys.shiftList(period: { from: string; to: string } | null)`;
  - `src/office/shifts/shift-list.ts`: `type ShiftStatusFilter`, `SHIFT_PAGE_SIZE = 25`, `MAX_PERIOD_DAYS = 366`, `civilDateLabel(date): string`, `recordLabel(kind: "product" | "line" | "counterparty", records, id, t): string`, `type OpenBlocker = "product_archived" | "product_draft" | "template_unfit"`, `openBlocker(shift, products, templates): OpenBlocker | null`, `interface ShiftFilters`, `findShifts(shifts, filters, productName)`, `type PeriodState`, `periodState(from, to): PeriodState`;
  - `src/office/shifts/shift-text.ts`: `datePickerTexts(t)` — тексты `DatePicker` (задача 4 берёт их для даты производства);
  - `src/office/shifts/ShiftsPage.tsx`: `ShiftsPage`;
  - `test/support/shifts.ts`: записи `LINE_2`, `LINE_10`, `OLD_LINE`, `BOX_58`, `MILK_BOX`, `OLD_BOX`, `PALLET`, `MILK`, `WATER`, `KEFIR_DRAFT`, `AYRAN_ARCHIVED`, `NORTH`, `SOUTH_ARCHIVED`, `DEFAULTS`, смены `ACTIVE`, `PLANNED`, `CLOSED`; `shiftsSession(shifts?)`, `openShifts(session)`, `shiftRows()`, `shiftRow(number)`, `pickDate(label, day, monthsBack?)`, `freezeToday()`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/operators-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      "Линии",
      "Операторы",
```

заменить на

<!-- prettier-ignore -->
```tsx
      "Линии",
      "Смены",
      "Операторы",
```

2. Создать `apps/standalone/test/shift-list.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  civilDateLabel,
  MAX_PERIOD_DAYS,
  openBlocker,
  periodState,
} from "../src/office/shifts/shift-list.js";
import { BOX_58, KEFIR_DRAFT, MILK, MILK_BOX, OLD_BOX, PLANNED, WATER } from "./support/shifts.js";

describe("the shifts list's rules", () => {
  it("writes a civil date as day, month and year", () => {
    expect(civilDateLabel("2026-10-08")).toBe("08.10.2026");
    expect(civilDateLabel("0024-02-29")).toBe("29.02.0024");
  });

  it("reads the two date fields as no period, half a period, a wrong one or one to ask for", () => {
    expect(periodState("", "")).toEqual({ kind: "none" });
    expect(periodState("2026-10-01", "")).toEqual({ kind: "partial" });
    expect(periodState("", "2026-10-01")).toEqual({ kind: "partial" });
    expect(periodState("2026-10-02", "2026-10-01")).toEqual({ kind: "reversed" });
    expect(periodState("2026-10-01", "2026-10-01")).toEqual({
      kind: "ready",
      from: "2026-10-01",
      to: "2026-10-01",
    });
    expect(MAX_PERIOD_DAYS).toBe(366);
    // 366 days with both ends, across the leap day of 2028.
    expect(periodState("2028-01-01", "2028-12-31")).toEqual({
      kind: "ready",
      from: "2028-01-01",
      to: "2028-12-31",
    });
    expect(periodState("2028-01-01", "2029-01-01")).toEqual({ kind: "too_long" });
  });

  it("claims nothing for a shift that is not planned, or whose product or template the lists lack", () => {
    const products = [MILK, WATER, KEFIR_DRAFT];
    const templates = [BOX_58, MILK_BOX, OLD_BOX];
    const unfit = { ...PLANNED, boxTemplateId: OLD_BOX.id };
    expect(openBlocker(unfit, products, templates)).toBe("template_unfit");
    expect(openBlocker({ ...unfit, status: "active" }, products, templates)).toBeNull();
    expect(openBlocker({ ...unfit, status: "closed" }, products, templates)).toBeNull();
    expect(openBlocker(unfit, undefined, templates)).toBeNull();
    expect(openBlocker(unfit, [MILK], templates)).toBeNull();
    expect(openBlocker(unfit, products, undefined)).toBeNull();
    expect(openBlocker(unfit, products, [BOX_58])).toBeNull();
    // A draft is named before the template is looked at.
    expect(openBlocker({ ...unfit, productId: KEFIR_DRAFT.id }, products, undefined)).toBe(
      "product_draft",
    );
  });
});
```

3. Создать `apps/standalone/test/shifts-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, TECHNOLOGIST } from "./support/office.js";
import {
  ACTIVE,
  AYRAN_ARCHIVED,
  BOX_58,
  CLOSED,
  freezeToday,
  KEFIR_DRAFT,
  LINE_10,
  LINE_2,
  MILK,
  MILK_BOX,
  OLD_BOX,
  openShifts,
  pickDate,
  PLANNED,
  shiftRow,
  shiftRows,
  shiftsSession,
  WATER,
} from "./support/shifts.js";

const SESSION_TOKEN = "office-session-token";

/** The text of the cells of the shift numbered `number`, left to right. */
function cells(number: string): (string | null)[] {
  return within(shiftRow(number))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

/** `count` planned shifts numbered OCT26-001… on line 2. */
function numbered(count: number): OfficeShift[] {
  return Array.from({ length: count }, (_, n) => ({
    ...PLANNED,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `OCT26-${String(n + 1).padStart(3, "0")}`,
  }));
}

describe("office shifts: the list", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is in the menu under «Производство», right after «Линии», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      await screen.findByRole("link", { name: "Смены" });
      const links = screen.getAllByRole("link").map((link) => link.textContent);
      expect(links[links.indexOf("Линии") + 1]).toBe("Смены");
      expect(screen.getByText("Производство")).toBeTruthy();
      view.unmount();
    }
  });

  it("lists the shifts in the host's order with their date, line, product, mode, plan and status", async () => {
    const session = shiftsSession();
    await openShifts(session);
    expect(session.api.listShifts).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "OCT26-005",
      "OCT26-004",
      "OCT26-001/S",
    ]);
    expect(cells("OCT26-005")).toEqual([
      "OCT26-005",
      "09.10.2026",
      "Линия 10",
      "Вода 0,5 л",
      "Агрегация",
      "—",
      "◷Запланирована",
    ]);
    expect(cells("OCT26-004")).toEqual([
      "OCT26-004",
      "08.10.2026",
      "Линия 2",
      "Молоко 3,2% 0,9 лдля: ООО «Северный берег»",
      "Агрегация",
      // A no-break space between the thousands.
      "1\u00a0200",
      "▸Активна",
    ]);
    expect(screen.getByText("Показано 3 из 3")).toBeTruthy();
    expect(
      screen.getByText(
        "Показаны запланированные и активные смены и закрытые за последний 31 день. Чтобы найти другие, выберите период.",
      ),
    ).toBeTruthy();
  });

  it("says why a closed shift closed, with data after closing, a station's reason in words and the office's in its own", async () => {
    const byOffice: OfficeShift = {
      ...ACTIVE,
      id: "3e1b7a5d-9f4a-4c6b-8d0e-5a8f1b4c7d9e",
      number: "OCT26-002",
      status: "closed",
      closeReasonText: "Станция линии 2 вышла из строя",
      closedAt: "2026-10-08T15:00:00Z",
    };
    const newerCode: OfficeShift = {
      ...CLOSED,
      id: "4f2c8b6e-0a5b-4d7c-9e1f-6b9a2c5d8e0f",
      number: "OCT26-003/S",
      closeReasonCode: "power_cut",
      lateDataAt: null,
    };
    await openShifts(shiftsSession([CLOSED, byOffice, newerCode]));
    expect(cells("OCT26-001/S")[6]).toBe(
      "✓Закрыта!Данные после закрытияПричина расхождения: Остановка оборудования",
    );
    expect(cells("OCT26-002")[6]).toBe("✓ЗакрытаЗакрыта в офисе: Станция линии 2 вышла из строя");
    // A code a newer host adds is shown as it is.
    expect(cells("OCT26-003/S")[6]).toBe("✓ЗакрытаПричина расхождения: power_cut");
  });

  it("marks a planned shift a station will not open: an archived or draft product, a template off or not of the product's group", async () => {
    const shifts: OfficeShift[] = [
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000001",
        number: "A-1",
        productId: AYRAN_ARCHIVED.id,
      },
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000002",
        number: "A-2",
        productId: KEFIR_DRAFT.id,
      },
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000003",
        number: "A-3",
        boxTemplateId: OLD_BOX.id,
      },
      // Milk's template on water: water is not of group 8.
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000004",
        number: "A-4",
        boxTemplateId: MILK_BOX.id,
      },
      { ...PLANNED, id: "10000000-0000-4000-8000-000000000005", number: "A-5" },
      // An open shift has its layout in its snapshot: no mark.
      {
        ...ACTIVE,
        id: "10000000-0000-4000-8000-000000000006",
        number: "A-6",
        boxTemplateId: OLD_BOX.id,
      },
    ];
    await openShifts(shiftsSession(shifts));
    expect(cells("A-1")[6]).toBe("◷Запланирована!Не откроется: товар в архиве");
    expect(cells("A-2")[6]).toBe("◷Запланирована!Не откроется: товар — черновик");
    expect(cells("A-3")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(cells("A-4")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(cells("A-5")[6]).toBe("◷Запланирована");
    expect(cells("A-6")[6]).toBe("▸Активна");
  });

  it("keeps the list when a list of names does not load, names records by their ids and claims no mark it cannot check", async () => {
    const session = shiftsSession([{ ...PLANNED, boxTemplateId: OLD_BOX.id }, ACTIVE]);
    session.api.listLines.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    session.api.listTemplates.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openShifts(session);
    await screen.findByText(/Не все справочники загрузились/);
    expect(cells("OCT26-005").slice(2, 4)).toEqual(["Линия 0b7e7dcb…", "Вода 0,5 л"]);
    expect(cells("OCT26-005")[6]).toBe("◷Запланирована");
    session.api.listLines.mockResolvedValue([LINE_10, LINE_2]);
    session.api.listTemplates.mockResolvedValue([BOX_58, OLD_BOX]);
    session.api.listProducts.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(cells("OCT26-005")[2]).toBe("Линия 10"));
    expect(cells("OCT26-005")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(screen.queryByText(/Не все справочники загрузились/)).toBeNull();
    // Only what failed is read again.
    expect(session.api.listProducts).not.toHaveBeenCalled();
  });

  it("names an archived line and counterparty as archived, and an unknown product by its id", async () => {
    const shift: OfficeShift = {
      ...ACTIVE,
      lineId: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
      counterpartyId: "e3c8d0f2-5a4b-4c7d-9e6f-0a1b2c3d4e5f",
      productId: "5e6f7081-92a3-4b45-8d6e-7f8091a2b3c4",
    };
    await openShifts(shiftsSession([shift]));
    expect(cells("OCT26-004").slice(2, 4)).toEqual([
      "Линия 1 (в архиве)",
      "Товар 5e6f7081…для: ООО «Юг» (в архиве)",
    ]);
  });

  it("shows only an error with «Повторить» when the shifts do not load, and reads them again", async () => {
    const session = shiftsSession();
    session.api.listShifts.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("OCT26-004")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
  });

  it("filters by status and line and searches the number and the product's name, without case", async () => {
    await openShifts(shiftsSession());
    const numbers = () =>
      shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "active" } });
    expect(numbers()).toEqual(["OCT26-004"]);
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: LINE_10.id } });
    expect(numbers()).toEqual(["OCT26-005"]);
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "мОЛОКО" },
    });
    expect(numbers()).toEqual(["OCT26-004", "OCT26-001/S"]);
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: " /s " },
    });
    expect(numbers()).toEqual(["OCT26-001/S"]);
    expect(screen.getByText("Показано 1 из 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "кефир" },
    });
    expect(screen.getByText("Ничего не найдено. Измените отбор.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(numbers()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("says when there are no shifts at all", async () => {
    await openShifts(shiftsSession([]));
    expect(screen.getByText("Смен пока нет.")).toBeTruthy();
  });

  it("pages 25 shifts at a time, and a new filter goes back to the first page", async () => {
    await openShifts(shiftsSession(numbered(26)));
    expect(shiftRows()).toHaveLength(25);
    const pager = screen.getByRole("navigation", { name: "Страницы списка смен" });
    fireEvent.click(within(pager).getByRole("button", { name: "Вперёд" }));
    expect(shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "OCT26-026",
    ]);
    expect(within(pager).getByText("Страница 2 из 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "OCT26" },
    });
    expect(shiftRows()).toHaveLength(25);
  });

  it("asks the host for a chosen period of production dates, and for its own list again once both dates are cleared", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "1 сентября 2026", 1);
    // One date is not a period: the list stays and nothing more is asked.
    expect(screen.getByText("Укажите обе даты периода. Пока показан прежний список.")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
    pickDate("Дата производства по", "8 октября 2026");
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2026-09-01",
        to: "2026-10-08",
      }),
    );
    expect(
      await screen.findByText("Показаны смены с датой производства с 01.09.2026 по 08.10.2026."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства по" }));
    await screen.findByText(/Показаны запланированные и активные смены/);
    // The host's own list is cached: shown again at once and read again in the background.
    await waitFor(() => expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN));
  });

  it("refuses a period that ends before it starts or is longer than 366 days, and asks nothing", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "8 октября 2026");
    pickDate("Дата производства по", "1 октября 2026");
    expect(screen.getByText("Период заканчивается раньше, чем начинается")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    pickDate("Дата производства с", "30 сентября 2025", 12);
    expect(screen.getByText("Период — не больше 366 дней")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
    // 366 days with both ends, 1 October 2025 to 1 October 2026: asked.
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    pickDate("Дата производства с", "1 октября 2025", 12);
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2025-10-01",
        to: "2026-10-01",
      }),
    );
    expect(screen.queryByText("Период — не больше 366 дней")).toBeNull();
  });

  it("shows names with markup as text", async () => {
    const session = shiftsSession([{ ...ACTIVE, closeReasonText: null }]);
    session.api.listProducts.mockResolvedValue([{ ...MILK, name: "<b>Молоко</b>" }, WATER]);
    await openShifts(session);
    expect(screen.getByText("<b>Молоко</b>")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
});
```

4. Создать `apps/standalone/test/support/shifts.ts`:

<!-- prettier-ignore -->
```ts
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";

import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  TemplateDefaults,
} from "../../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./office.js";

export const LINE_2: OfficeLine = {
  id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  name: "Линия 2",
  archived: false,
  rev: 40,
};
export const LINE_10: OfficeLine = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  name: "Линия 10",
  archived: false,
  rev: 41,
};
export const OLD_LINE: OfficeLine = {
  id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
  name: "Линия 1",
  archived: true,
  rev: 30,
};

/** Box templates: for every category, for milk only (group 8), and switched off. */
export const BOX_58: LabelTemplateSummary = {
  id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  name: "Коробка 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: true,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 62,
};
export const MILK_BOX: LabelTemplateSummary = {
  ...BOX_58,
  id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  name: "Молоко 100×72",
  chzProductGroupCodes: [8],
  stock: false,
  rev: 63,
};
export const OLD_BOX: LabelTemplateSummary = {
  ...BOX_58,
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Старая коробка",
  enabled: false,
  stock: false,
  rev: 64,
};
export const PALLET: LabelTemplateSummary = {
  ...BOX_58,
  id: "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e",
  name: "Паллета 100×150",
  purpose: "pallet",
  rev: 65,
};

export const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: MILK_BOX.id,
  defaultPalletTemplateId: null,
  archived: false,
  status: "active",
  rev: 65,
};
export const WATER: OfficeProduct = {
  ...MILK,
  id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
  gtin14: "04601234000017",
  name: "Вода 0,5 л",
  printName: null,
  chzProductGroupCode: 13,
  boxCapacity: 24,
  defaultBoxTemplateId: null,
  rev: 70,
};
export const KEFIR_DRAFT: OfficeProduct = {
  ...MILK,
  id: "3c4d5e6f-7081-4923-8b4c-5d6e7f809102",
  gtin14: "04602222000026",
  name: "Кефир",
  printName: null,
  palletBoxCapacity: null,
  defaultBoxTemplateId: null,
  status: "draft",
  rev: 71,
};
export const AYRAN_ARCHIVED: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  defaultBoxTemplateId: null,
  archived: true,
  rev: 72,
};

export const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: null,
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
export const SOUTH_ARCHIVED: CounterpartyRecord = {
  ...NORTH,
  id: "e3c8d0f2-5a4b-4c7d-9e6f-0a1b2c3d4e5f",
  name: "ООО «Юг»",
  archived: true,
  rev: 13,
};

export const DEFAULTS: TemplateDefaults = {
  defaultBoxTemplateId: BOX_58.id,
  defaultPalletTemplateId: PALLET.id,
  defaultDuplicateTemplateId: null,
  categories: [],
  rev: 80,
};

/** An active shift of milk on line 2 for a counterparty, as `office-shift.json`. */
export const ACTIVE: OfficeShift = {
  id: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  number: "OCT26-004",
  status: "active",
  mode: "aggregation",
  palletsEnabled: false,
  createdFrom: "office",
  productId: MILK.id,
  lineId: LINE_2.id,
  counterpartyId: NORTH.id,
  productionDate: "2026-10-08",
  plannedQty: 1200,
  boxCapacity: 12,
  boxTemplateId: MILK_BOX.id,
  ownerDeviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  openedAt: "2026-10-08T06:02:00Z",
  closedAt: null,
  closeReasonCode: null,
  closeReasonText: null,
  lateDataAt: null,
  createdAt: "2026-10-07T15:30:00Z",
  rev: 71,
};

/** A planned shift of water on line 10, no plan and no counterparty. */
export const PLANNED: OfficeShift = {
  ...ACTIVE,
  id: "1c9f5e3b-7d2e-4a4f-8b8c-3e6d9f2a5b7c",
  number: "OCT26-005",
  status: "planned",
  productId: WATER.id,
  lineId: LINE_10.id,
  counterpartyId: null,
  productionDate: "2026-10-09",
  plannedQty: null,
  boxCapacity: 24,
  boxTemplateId: BOX_58.id,
  ownerDeviceId: null,
  openedAt: null,
  rev: 72,
};

/** A shift a station created and closed with a reason, data arriving after. */
export const CLOSED: OfficeShift = {
  ...ACTIVE,
  id: "2d0a6f4c-8e3f-4b5a-9c9d-4f7e0a3b6c8d",
  number: "OCT26-001/S",
  status: "closed",
  createdFrom: "station",
  counterpartyId: null,
  productionDate: "2026-10-01",
  plannedQty: 500,
  closedAt: "2026-10-01T14:00:00Z",
  closeReasonCode: "equipment_stop",
  lateDataAt: "2026-10-01T14:30:00Z",
  rev: 60,
};

/** The office's session with every list the shifts page and its dialogs read. */
export function shiftsSession(
  shifts: OfficeShift[] = [PLANNED, ACTIVE, CLOSED],
): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listShifts.mockResolvedValue(shifts);
  session.api.listProducts.mockResolvedValue([MILK, WATER, KEFIR_DRAFT, AYRAN_ARCHIVED]);
  session.api.listLines.mockResolvedValue([LINE_10, LINE_2, OLD_LINE]);
  session.api.listCounterparties.mockResolvedValue([NORTH, SOUTH_ARCHIVED]);
  session.api.listTemplates.mockResolvedValue([BOX_58, MILK_BOX, OLD_BOX, PALLET]);
  return session;
}

/** Opens «Смены» from the menu and waits for the list. */
export async function openShifts(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  await screen.findByRole("heading", { name: "Смены" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

/** The rows of the list, without the header. */
export function shiftRows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The row of the shift numbered `number`. */
export function shiftRow(number: string): HTMLElement {
  const row = screen.getByText(number).closest("tr");
  if (!row) throw new Error(`no row for ${number}`);
  return row;
}

/**
 * Picks `day` (as the calendar names it, «8 октября 2026») in the date picker
 * labelled `label`, going back `monthsBack` months from the one it opens on.
 */
export function pickDate(label: string, day: string, monthsBack = 0): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
  const calendar = screen.getByRole("dialog", { name: "Календарь" });
  for (let step = 0; step < monthsBack; step++) {
    fireEvent.click(within(calendar).getByRole("button", { name: "Предыдущий месяц" }));
  }
  fireEvent.click(within(calendar).getByRole("button", { name: day }));
}

/** «Today» for the date pickers and the production date: the organization's day is 9 October 2026. */
export function freezeToday(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
}
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx test/shift-list.test.ts test/operators-page.test.tsx`
Expected: FAIL — `test/shift-list.test.ts` не загружается (`Failed to resolve import "../src/office/shifts/shift-list.js"`); в `test/shifts-page.test.tsx` падают все 13 (`Unable to find role="link" and name "Смены"`); в `test/operators-page.test.tsx` — «sits between «Линии» and «Устройства»…» (`expected [ 'Линии', 'Операторы', 'Устройства' ] to deeply equal …`), остальные 18 проходят.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
}

.office-pager {
  display: flex;
```

заменить на

<!-- prettier-ignore -->
```css
}

/* A shift's cell of several lines: a name, its counterparty, its status and its marks. */
.shift-cell {
  display: grid;
  justify-items: start;
  gap: 4px;
}

.shift-cell__quiet {
  color: var(--fg-2);
}

.office-pager {
  display: flex;
```

2. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "lines": "Линии",
      "operators": "Операторы",
```

заменить на

<!-- prettier-ignore -->
```json
      "lines": "Линии",
      "shifts": "Смены",
      "operators": "Операторы",
```

3. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "archivedName": "{{name}} (в архиве)"
```

заменить на

<!-- prettier-ignore -->
```json
      "archivedName": "{{name}} (в архиве)",
      "pager": {
        "previous": "Назад",
        "next": "Вперёд",
        "page": "Страница {{page}} из {{pages}}"
      }
```

4. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "nameTaken": "Активная линия с таким названием уже есть"
      }
    },
    "operators": {
```

заменить на

<!-- prettier-ignore -->
```json
        "nameTaken": "Активная линия с таким названием уже есть"
      }
    },
    "shifts": {
      "title": "Смены",
      "filters": "Отбор смен",
      "search": "Поиск по номеру и товару",
      "statusFilter": "Статус",
      "statusFilters": {
        "all": "Все статусы",
        "planned": "Запланирована",
        "active": "Активна",
        "closed": "Закрыта"
      },
      "lineFilter": "Линия",
      "allLines": "Все линии",
      "reset": "Сбросить",
      "found": "Показано {{shown}} из {{total}}",
      "period": {
        "from": "Дата производства с",
        "to": "Дата производства по",
        "recent": "Показаны запланированные и активные смены и закрытые за последний 31 день. Чтобы найти другие, выберите период.",
        "shown": "Показаны смены с датой производства с {{from}} по {{to}}.",
        "partial": "Укажите обе даты периода. Пока показан прежний список.",
        "reversed": "Период заканчивается раньше, чем начинается",
        "tooLong": "Период — не больше 366 дней"
      },
      "date": {
        "placeholder": "Не выбрана",
        "clear": "Очистить дату",
        "calendar": "Календарь",
        "previousMonth": "Предыдущий месяц",
        "nextMonth": "Следующий месяц"
      },
      "table": {
        "number": "Номер",
        "productionDate": "Дата производства",
        "line": "Линия",
        "product": "Товар",
        "mode": "Режим",
        "plannedQty": "План, шт",
        "status": "Статус"
      },
      "forCounterparty": "для: {{name}}",
      "modes": {
        "aggregation": "Агрегация",
        "validation": "Валидация"
      },
      "statuses": {
        "planned": "Запланирована",
        "active": "Активна",
        "closed": "Закрыта"
      },
      "blockers": {
        "product_archived": "Не откроется: товар в архиве",
        "product_draft": "Не откроется: товар — черновик",
        "template_unfit": "Не откроется: шаблон выключен или не подходит товару"
      },
      "lateData": "Данные после закрытия",
      "closedByOffice": "Закрыта в офисе: {{reason}}",
      "closeReason": "Причина расхождения: {{reason}}",
      "closeReasons": {
        "production_defect": "Производственный брак",
        "material_shortage": "Недостаток сырья",
        "equipment_stop": "Остановка оборудования",
        "production_order_changed": "Изменение производственного задания",
        "planned_quantity_error": "Ошибка в плановом количестве",
        "other_production_deviation": "Другое производственное отклонение"
      },
      "unknown": {
        "product": "Товар {{id}}…",
        "line": "Линия {{id}}…",
        "counterparty": "Контрагент {{id}}…"
      },
      "lookupsFailed": "Не все справочники загрузились: вместо названий показаны начала кодов, а смены, которые не откроются, могут быть не помечены.",
      "empty": "Смен пока нет.",
      "nothingFound": "Ничего не найдено. Измените отбор.",
      "pager": "Страницы списка смен"
    },
    "operators": {
```

5. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "label": "Страницы списка товаров",
        "previous": "Назад",
        "next": "Вперёд",
        "page": "Страница {{page}} из {{pages}}"
```

заменить на

<!-- prettier-ignore -->
```json
        "label": "Страницы списка товаров"
```

6. Создать `apps/standalone/src/office/OfficePager.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

export interface OfficePagerProps {
  /** The navigation's accessible name: whose pages these are. */
  label: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

/**
 * A list's pages, in the office's words. The shared `@markiro/ui` `Pager` is
 * not used: its buttons are floor-sized and full width with no size prop, and
 * the office leaves `packages/*` alone (the cloud's own catalog page has a
 * compact pager too).
 */
export function OfficePager({ label, page, pageCount, onPage }: OfficePagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={label} className="office-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t("office.common.pager.previous")}
      </Button>
      <span aria-live="polite">{t("office.common.pager.page", { page, pages: pageCount })}</span>
      <Button
        variant="secondary"
        size="compact"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t("office.common.pager.next")}
      </Button>
    </nav>
  );
}
```

7. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  {
    to: "/operators",
```

заменить на

<!-- prettier-ignore -->
```ts
  {
    to: "/shifts",
    labelKey: "office.nav.shifts",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/operators",
```

8. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  templateDefaults: ["office", "template-defaults"],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
```

заменить на

<!-- prettier-ignore -->
```ts
  templateDefaults: ["office", "template-defaults"],
  /** Every list of shifts, whatever its period: a write reads them all again. */
  shifts: ["office", "shifts"],
  /** The list of shifts of a period of production dates, or the host's own list (`null`). */
  shiftList: (period: { from: string; to: string } | null) => [
    "office",
    "shifts",
    period?.from ?? null,
    period?.to ?? null,
  ],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
```

9. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
```

10. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

type ProductsDialog = { kind: "create" } | { kind: "edit"; product: OfficeProduct };

interface ProductsPagerProps {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

/**
 * The list's pages, in the office's words. The shared `@markiro/ui` `Pager` is not
 * used: its buttons are floor-sized and full width with no size prop, and this plan
 * leaves `packages/*` alone (the cloud's own catalog page has a compact pager too).
 */
function ProductsPager({ page, pageCount, onPage }: ProductsPagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("office.products.pager.label")} className="office-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t("office.products.pager.previous")}
      </Button>
      <span aria-live="polite">{t("office.products.pager.page", { page, pages: pageCount })}</span>
      <Button
        variant="secondary"
        size="compact"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t("office.products.pager.next")}
      </Button>
    </nav>
  );
}

/**
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
```

заменить на

<!-- prettier-ignore -->
```tsx
const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

type ProductsDialog = { kind: "create" } | { kind: "edit"; product: OfficeProduct };

/**
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
```

11. В `apps/standalone/src/office/products/ProductsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          {pageCount > 1 && <ProductsPager page={shown} pageCount={pageCount} onPage={setPage} />}
```

заменить на

<!-- prettier-ignore -->
```tsx
          {pageCount > 1 && (
            <OfficePager
              label={t("office.products.pager.label")}
              page={shown}
              pageCount={pageCount}
              onPage={setPage}
            />
          )}
```

12. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { RequireRole } from "./RequireRole.js";
import { ShiftsPage } from "./shifts/ShiftsPage.js";
import { SsccPage } from "./sscc/SsccPage.js";
```

13. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "lines", element: <LinesPage /> },
      {
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "lines", element: <LinesPage /> },
      { path: "shifts", element: <ShiftsPage /> },
      {
```

14. Создать `apps/standalone/src/office/shifts/ShiftsPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  DatePicker,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type BadgeTone,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeShift, ShiftMode, ShiftStatus } from "../../host/protocol.js";
import { useTemplates } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import {
  civilDateLabel,
  findShifts,
  openBlocker,
  periodState,
  recordLabel,
  SHIFT_PAGE_SIZE,
  type ShiftStatusFilter,
} from "./shift-list.js";
import { datePickerTexts } from "./shift-text.js";

/** A status in its phase, after the cloud's `SHIFT_STATUS_TO_PHASE`. */
const STATUS_PHASE = {
  planned: "planned",
  active: "active",
  closed: "done",
} as const satisfies Record<ShiftStatus, TagPhase>;

/** A mode's category tone, the cloud's `SHIFT_MODE_TO_TONE`: one mode, one colour in both products. */
const MODE_TONE = {
  validation: "violet",
  aggregation: "teal",
} as const satisfies Record<ShiftMode, BadgeTone>;

const STATUS_FILTERS: readonly ShiftStatusFilter[] = ["all", "planned", "active", "closed"];

/** Units with the thousands apart by a no-break space, as Russian writes counts: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
 * the planned and active shifts and the closed ones of the last 31 days, or
 * every shift of a chosen period; the filters, the search and the pages work
 * here. A shift names its product, line and counterparty by id, and the page
 * names them from its own lists; a list that does not load leaves the shifts
 * in place, named by the first characters of their ids.
 */
export function ShiftsPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<ShiftStatusFilter>("all");
  const [lineId, setLineId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const period = periodState(from, to);
  // The period last asked for changes only to a ready period or back to none
  // (set while rendering, React's way to follow a value from an earlier render),
  // so while the period is incomplete or wrong the list stays the one it was.
  const [asked, setAsked] = useState<{ from: string; to: string } | null>(null);
  if (period.kind === "ready" && (asked?.from !== period.from || asked.to !== period.to)) {
    setAsked({ from: period.from, to: period.to });
  } else if (period.kind === "none" && asked !== null) {
    setAsked(null);
  }
  const shifts = useOfficeQuery(officeKeys.shiftList(asked), (api, token) =>
    asked === null ? api.listShifts(token) : api.listShifts(token, asked),
  );
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const templates = useTemplates();
  const lookups = [products, lines, counterparties, templates];

  const productName = (shift: OfficeShift) =>
    recordLabel("product", products.data, shift.productId, t);
  const filtersOn =
    from !== "" || to !== "" || status !== "all" || lineId !== "" || search.trim() !== "";
  const resetFilters = () => {
    setFrom("");
    setTo("");
    setStatus("all");
    setLineId("");
    setSearch("");
    setPage(1);
  };
  const periodError =
    period.kind === "reversed"
      ? t("office.shifts.period.reversed")
      : period.kind === "too_long"
        ? t("office.shifts.period.tooLong")
        : undefined;
  // The shifts the filters keep, in the host's order; none while the list is not loaded.
  const found = shifts.isSuccess
    ? findShifts(shifts.data, { status, lineId, search }, productName)
    : [];

  const columns: TableColumn<OfficeShift>[] = [
    {
      key: "number",
      title: t("office.shifts.table.number"),
      mono: true,
      render: (shift) => shift.number,
    },
    {
      key: "productionDate",
      title: t("office.shifts.table.productionDate"),
      mono: true,
      render: (shift) => civilDateLabel(shift.productionDate),
    },
    {
      key: "line",
      title: t("office.shifts.table.line"),
      wrap: true,
      render: (shift) => recordLabel("line", lines.data, shift.lineId, t),
    },
    {
      key: "product",
      title: t("office.shifts.table.product"),
      wrap: true,
      render: (shift) => (
        <span className="shift-cell">
          <span>{productName(shift)}</span>
          {shift.counterpartyId !== null && (
            <span className="shift-cell__quiet">
              {t("office.shifts.forCounterparty", {
                name: recordLabel("counterparty", counterparties.data, shift.counterpartyId, t),
              })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "mode",
      title: t("office.shifts.table.mode"),
      render: (shift) => (
        <Badge tone={MODE_TONE[shift.mode]}>{t(`office.shifts.modes.${shift.mode}`)}</Badge>
      ),
    },
    {
      key: "plannedQty",
      title: t("office.shifts.table.plannedQty"),
      mono: true,
      align: "right",
      render: (shift) =>
        shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
    },
    {
      key: "status",
      title: t("office.shifts.table.status"),
      wrap: true,
      render: (shift) => {
        const blocker = openBlocker(shift, products.data, templates.data);
        return (
          <span className="shift-cell">
            <StatusChip
              phase={STATUS_PHASE[shift.status]}
              label={t(`office.shifts.statuses.${shift.status}`)}
            />
            {blocker !== null && (
              <StatusChip phase="attention" wrap label={t(`office.shifts.blockers.${blocker}`)} />
            )}
            {shift.lateDataAt !== null && (
              <StatusChip phase="attention" label={t("office.shifts.lateData")} />
            )}
            {shift.closeReasonText !== null && (
              <span className="shift-cell__quiet">
                {t("office.shifts.closedByOffice", { reason: shift.closeReasonText })}
              </span>
            )}
            {shift.closeReasonCode !== null && (
              <span className="shift-cell__quiet">
                {t("office.shifts.closeReason", {
                  // A code a newer host adds is shown as it is.
                  reason: isShiftCloseReasonCode(shift.closeReasonCode)
                    ? t(`office.shifts.closeReasons.${shift.closeReasonCode}`)
                    : shift.closeReasonCode,
                })}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  const content = () => {
    if (shifts.isPending) return <PageLoading />;
    if (shifts.isError) {
      return (
        <LoadError
          error={shifts.error}
          onRetry={() => {
            void shifts.refetch();
            // One click recovers the names too when they failed as well.
            for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
          }}
        />
      );
    }
    const pageCount = Math.max(1, Math.ceil(found.length / SHIFT_PAGE_SIZE));
    // A shorter list never shows an empty page.
    const shown = Math.min(page, pageCount);
    return (
      <Card>
        <Table
          columns={columns}
          rows={found.slice((shown - 1) * SHIFT_PAGE_SIZE, shown * SHIFT_PAGE_SIZE)}
          getRowKey={(shift) => shift.id}
          empty={t(shifts.data.length === 0 ? "office.shifts.empty" : "office.shifts.nothingFound")}
          scrollLabel={t("office.shifts.title")}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.shifts.pager")}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </Card>
    );
  };

  return (
    <>
      <PageHeader title={t("office.shifts.title")} />
      {/* About the names and the marks: with no list on screen the shifts' error stands alone. */}
      {shifts.isSuccess && lookups.some((lookup) => lookup.isError) && (
        <Alert
          tone="warn"
          action={
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
              }}
            >
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.shifts.lookupsFailed")}
        </Alert>
      )}
      <FilterBar
        label={t("office.shifts.filters")}
        resultSummary={
          shifts.isSuccess
            ? t("office.shifts.found", {
                shown: found.length,
                total: shifts.data.length,
              })
            : ""
        }
        {...(filtersOn ? { resetLabel: t("office.shifts.reset"), onReset: resetFilters } : {})}
      >
        <Input
          label={t("office.shifts.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <Select
          native
          label={t("office.shifts.statusFilter")}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label: t(`office.shifts.statusFilters.${value}`),
          }))}
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <Select
          native
          label={t("office.shifts.lineFilter")}
          options={[
            { value: "", label: t("office.shifts.allLines") },
            ...activeFirstByName(lines.data ?? []).map((line) => ({
              value: line.id,
              label: line.archived
                ? t("office.common.archivedName", { name: line.name })
                : line.name,
            })),
          ]}
          value={lineId}
          onValueChange={(value) => {
            setLineId(value);
            setPage(1);
          }}
        />
        <DatePicker
          label={t("office.shifts.period.from")}
          {...datePickerTexts(t)}
          {...(from === "" ? {} : { value: from })}
          onValueChange={(value) => {
            setFrom(value ?? "");
            setPage(1);
          }}
        />
        <DatePicker
          label={t("office.shifts.period.to")}
          {...datePickerTexts(t)}
          {...(to === "" ? {} : { value: to })}
          {...(periodError === undefined ? {} : { error: periodError })}
          onValueChange={(value) => {
            setTo(value ?? "");
            setPage(1);
          }}
        />
      </FilterBar>
      <p className="office-note" aria-live="polite">
        {period.kind === "partial"
          ? t("office.shifts.period.partial")
          : asked === null
            ? t("office.shifts.period.recent")
            : t("office.shifts.period.shown", {
                from: civilDateLabel(asked.from),
                to: civilDateLabel(asked.to),
              })}
      </p>
      {content()}
    </>
  );
}
```

15. Создать `apps/standalone/src/office/shifts/shift-list.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  ShiftStatus,
} from "../../host/protocol.js";
import { civilDaysBetween, isCivilDate } from "../../lib/civil-date.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";

/** What the status filter keeps. */
export type ShiftStatusFilter = "all" | ShiftStatus;

/** Rows on one page of the list. */
export const SHIFT_PAGE_SIZE = 25;

/** The longest period the list asks the host for, in days with both ends. */
export const MAX_PERIOD_DAYS = 366;

/** A civil date as the list writes it: `08.10.2026`. */
export function civilDateLabel(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day ?? ""}.${month ?? ""}.${year ?? ""}`;
}

/** The kinds of record a shift names by id. */
type NamedKind = "product" | "line" | "counterparty";

/**
 * How the list names a record a shift points to: its name, marked when it is
 * archived; while its list is not loaded, or when the list lacks it, the first
 * eight characters of its id.
 */
export function recordLabel(
  kind: NamedKind,
  records: readonly (OfficeProduct | OfficeLine | CounterpartyRecord)[] | undefined,
  id: string,
  t: TFunction,
): string {
  const record = records?.find((each) => each.id === id);
  if (record === undefined) return t(`office.shifts.unknown.${kind}`, { id: id.slice(0, 8) });
  return record.archived ? t("office.common.archivedName", { name: record.name }) : record.name;
}

/** Why a planned shift will not open on a station (`shift.open` refuses it). */
export type OpenBlocker = "product_archived" | "product_draft" | "template_unfit";

/**
 * Why a planned shift would be refused when a station opens it, by the lists
 * the office read: its product archived or a draft (`product_inactive`), its
 * box template switched off, narrowed or no longer of the product's group
 * (`template_not_fit`). `null` when it opens, or while a list it needs is not
 * loaded or lacks the record: then nothing is claimed.
 */
export function openBlocker(
  shift: Pick<OfficeShift, "status" | "productId" | "boxTemplateId">,
  products: readonly OfficeProduct[] | undefined,
  templates: readonly LabelTemplateSummary[] | undefined,
): OpenBlocker | null {
  if (shift.status !== "planned") return null;
  const product = products?.find((each) => each.id === shift.productId);
  if (product === undefined) return null;
  if (product.archived) return "product_archived";
  if (product.status !== "active") return "product_draft";
  const template = templates?.find((each) => each.id === shift.boxTemplateId);
  if (template === undefined) return null;
  const fits = templateFitsSlot(template, {
    purpose: "box",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  return fits ? null : "template_unfit";
}

/** What the filters of the list hold. */
export interface ShiftFilters {
  status: ShiftStatusFilter;
  /** `""` for every line. */
  lineId: string;
  search: string;
}

/**
 * The shifts the filters keep, in the host's order: the status, the line, and
 * a search for the text in the number or the product's name, without case.
 * `productName` names a shift's product as the list shows it.
 */
export function findShifts(
  shifts: readonly OfficeShift[],
  filters: ShiftFilters,
  productName: (shift: OfficeShift) => string,
): OfficeShift[] {
  const text = filters.search.trim().toLocaleLowerCase("ru");
  return shifts.filter(
    (shift) =>
      (filters.status === "all" || shift.status === filters.status) &&
      (filters.lineId === "" || shift.lineId === filters.lineId) &&
      (text === "" ||
        shift.number.toLocaleLowerCase("ru").includes(text) ||
        productName(shift).toLocaleLowerCase("ru").includes(text)),
  );
}

/** A period the list can ask for, or why it cannot. */
export type PeriodState =
  | { kind: "none" }
  | { kind: "partial" }
  | { kind: "reversed" }
  | { kind: "too_long" }
  | { kind: "ready"; from: string; to: string };

/**
 * The period of production dates the two date fields give: none while both
 * are empty (the host's own list), `partial` while one is empty, `reversed`
 * when it ends before it starts, `too_long` beyond `MAX_PERIOD_DAYS` days
 * with both ends, otherwise ready to send.
 */
export function periodState(from: string, to: string): PeriodState {
  if (from === "" && to === "") return { kind: "none" };
  if (!isCivilDate(from) || !isCivilDate(to)) return { kind: "partial" };
  const days = civilDaysBetween(from, to);
  if (days < 0) return { kind: "reversed" };
  if (days + 1 > MAX_PERIOD_DAYS) return { kind: "too_long" };
  return { kind: "ready", from, to };
}
```

16. Создать `apps/standalone/src/office/shifts/shift-text.ts`:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

/**
 * The date pickers' texts in the office's words: `@markiro/ui`'s `DatePicker`
 * has Russian defaults of its own, and every text of the app goes through
 * i18n.
 */
export function datePickerTexts(t: TFunction) {
  return {
    placeholder: t("office.shifts.date.placeholder"),
    clearLabel: t("office.shifts.date.clear"),
    calendarLabel: t("office.shifts.date.calendar"),
    previousMonthLabel: t("office.shifts.date.previousMonth"),
    nextMonthLabel: t("office.shifts.date.nextMonth"),
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx test/shift-list.test.ts test/operators-page.test.tsx test/products-page.test.tsx --reporter=verbose`
Expected: PASS — 4 файла, 55 тестов (`shifts-page` 13, `shift-list` 3, `operators-page` 19, `products-page` 20); stderr пуст. Затем те же файлы — под стендом с задержкой `setImmediate` (см. «Заметки для исполнения»): PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — товар в архиве не мешает открытию. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (product.archived) return "product_archived";
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "marks a planned shift"`
Expected: FAIL — «office shifts: the list > marks a planned shift a station will not open: an archived or draft product, a template off or not of the product's group» — `AssertionError: expected '◷Запланирована' to be '◷Запланирована!Не откроется: товар в …' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — пометка «Не откроется» ставится и у открытой смены. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (shift.status !== "planned") return null;
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "marks a planned shift"`
Expected: FAIL — «office shifts: the list > marks a planned shift a station will not open: an archived or draft product, a template off or not of the product's group» — `AssertionError: expected '▸Активна!Не откроется: шаблон выключе…' to be '▸Активна' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — предел периода считается без одного из концов. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (days + 1 > MAX_PERIOD_DAYS) return { kind: "too_long" };
```

заменить на

<!-- prettier-ignore -->
```ts
  if (days > MAX_PERIOD_DAYS) return { kind: "too_long" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "longer than 366 days"`
Expected: FAIL — «office shifts: the list > refuses a period that ends before it starts or is longer than 366 days, and asks nothing» — `TestingLibraryElementError: Unable to find an element with the text: Период — не больше 366 дней`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — обе очищенные даты не возвращают список хоста по умолчанию. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  } else if (period.kind === "none" && asked !== null) {
    setAsked(null);
  }
```

заменить на

<!-- prettier-ignore -->
```tsx
  }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "once both dates are cleared"`
Expected: FAIL — «office shifts: the list > asks the host for a chosen period of production dates, and for its own list again once both dates are cleared» — `TestingLibraryElementError: Unable to find an element with the text: /Показаны запланированные и активные смены/`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — поиск только по номеру. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
        shift.number.toLocaleLowerCase("ru").includes(text) ||
        productName(shift).toLocaleLowerCase("ru").includes(text)),
```

заменить на

<!-- prettier-ignore -->
```ts
        shift.number.toLocaleLowerCase("ru").includes(text)),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "filters by status and line"`
Expected: FAIL — «office shifts: the list > filters by status and line and searches the number and the product's name, without case» — `AssertionError: expected [ Array(1) ] to deeply equal [ 'OCT26-004', 'OCT26-001/S' ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 6 — «Повторить» перечитывает и справочники, которые загрузились. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              onClick={() => {
                for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
              }}
```

заменить на

<!-- prettier-ignore -->
```tsx
              onClick={() => {
                for (const lookup of lookups) void lookup.refetch();
              }}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx -t "keeps the list when a list of names"`
Expected: FAIL — «office shifts: the list > keeps the list when a list of names does not load, names records by their ids and claims no mark it cannot check» — `AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/OfficePager.tsx apps/standalone/src/office/shifts apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/shifts-page.test.tsx apps/standalone/test/shift-list.test.ts apps/standalone/test/support/shifts.ts apps/standalone/test/operators-page.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 71 файл, 1822 теста (1806 + 16).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/OfficePager.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/office/shifts/shift-list.ts apps/standalone/src/office/shifts/shift-text.ts apps/standalone/src/office/products/ProductsPage.tsx apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/shifts-page.test.tsx apps/standalone/test/shift-list.test.ts apps/standalone/test/support/shifts.ts apps/standalone/test/operators-page.test.tsx
git commit -m "feat(standalone): the office lists shifts with their names, marks, filters and period" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Планирование смены

«Запланировать смену» в шапке страницы видят обе роли (`useCan("planShifts")`; новая возможность в `src/office/access.ts`, роли — по §4.9). Окно `ShiftDialog` ждёт профиль организации и начинает дату производства с сегодняшней даты в её часовом поясе; пока профиль читается — окно с индикатором и выключенной кнопкой; профиль не загрузился — дата этого ПК и подпись об этом под датой.

Поля — в порядке облачной формы: товар (только `active` и не в архиве, по названию, с GTIN в подписи), линия (активные), дата производства (`DatePicker`; крестик очищает дату, и пустая дата отвергается правилом), план (необязательно), вместимость короба, шаблон этикетки короба, контрагент (необязательно, «Не выбран»). Выбор товара ставит вместимость из товара и шаблон по `suggestBoxTemplate` (предпочтение товара → умолчание категории → умолчание организации); каждая смена товара ставит их заново. Чтобы подсказка не потерялась, выбор товара ждёт списков шаблонов и умолчаний (`useTemplateDefaults`). Шаблоны предлагаются те, что подходят группе выбранного товара (`templateOptions` без «Не выбран»); пока товара нет, список пуст и подсказка — «Сначала выберите товар».

Тело — `shiftCreate(toShiftInput(values))`. Отказы (`writeFailure` с картами `SHIFT_FIELDS` и `SHIFT_CONFLICTS`): `conflict` `product_inactive` — под товаром; `validation_failed` на `lineId`, `boxTemplateId`, `counterpartyId`, `productId` — под своим выбором словами (запись убрали в архив, выключили или сузили, пока окно было открыто); на `boxTemplateId` окно ещё и перечитывает шаблоны, чтобы отказанный показался с пометкой «— не подходит»; на счётчиках и дате — «Хост не принял это значение». Остальное — предупреждение над полями. Сохранённая смена закрывает окно, страница говорит «Смена OCT26-006 запланирована.» и перечитывает все списки смен (`officeKeys.shifts`): попадёт ли смена в показанный период и отбор, решает хост.

`test/support/shifts.ts` получает `user` у `shiftsSession` (обе роли), профиль и умолчания по умолчанию, а `openShifts` возвращает результат `render`, чтобы цикл по ролям размонтировал страницу.

**Files:**

- Create: `apps/standalone/src/office/shifts/shift-form.ts`, `apps/standalone/src/office/shifts/ShiftDialog.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/office/access.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shift-dialog.test.tsx` (Create); `apps/standalone/test/support/shifts.ts` (Modify)

**Interfaces:**

- Consumes: `shiftCreate`, `ShiftInput`, `createShift` (задача 1); `plannedQtyRule`, `productionDateRule`, `shiftBoxCapacityRule`, `toCount`, `civilToday`, `suggestBoxTemplate` (задача 2); `datePickerTexts`, `officeKeys.shifts` (задача 3); `useTemplates`, `useTemplateDefaults`, `templateOptions`, `writeFailure`, `FormDialog`.
- Produces:
  - `src/office/access.ts`: возможность `planShifts` (`["admin", "technologist"]`);
  - `src/office/shifts/shift-form.ts`: `shiftFieldsSchema`, `type ShiftFields`, `newShiftFields(today: string): ShiftFields`, `toShiftInput(values): ShiftInput`, `SHIFT_FIELDS`, `SHIFT_CONFLICTS`;
  - `src/office/shifts/ShiftDialog.tsx`: `ShiftDialog({ onClose, onSaved })` (задача 5 добавляет `shift`, `onReload`, `onOutdated`);
  - `test/support/shifts.ts`: `shiftsSession(shifts?, user?)`, `openShifts(session): Promise<RenderResult>`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/shift-dialog.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift, TemplateDefaults } from "../src/host/protocol.js";
import { ORG_PROFILE, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  BOX_58,
  DEFAULTS,
  freezeToday,
  LINE_10,
  LINE_2,
  MILK,
  MILK_BOX,
  NORTH,
  openShifts,
  pickDate,
  shiftsSession,
  WATER,
} from "./support/shifts.js";

const TOKEN = "office-session-token";

/** The shift the host answers a plan with. */
const CREATED: OfficeShift = {
  ...ACTIVE,
  id: "5a3d9c7f-1b6c-4e8d-9f2a-7c0b3d6e9f1a",
  number: "OCT26-006",
  status: "planned",
  ownerDeviceId: null,
  openedAt: null,
};

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Новая смена" });
}

function field(label: string): HTMLElement {
  return within(dialog()).getByLabelText(label);
}

function set(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } });
}

/** The texts of the options of the select labelled `label`. */
function options(label: string): string[] {
  return within(field(label))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

function valueOf(label: string): string {
  const control = field(label);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`${label} holds no value`);
  }
  return control.value;
}

/** The message under the field labelled `label`, by its `aria-describedby`. */
function messageOf(label: string): string | null | undefined {
  const id = field(label).getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

async function openCreate(session: FakeOfficeSession): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
  await screen.findByRole("dialog", { name: "Новая смена" });
  // The product waits for the products, the templates and the defaults.
  await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
}

function submit(): void {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Запланировать" }));
}

/** Milk on line 2, a plan of 1200, for the northern counterparty. */
function fillMilk(): void {
  set("Товар", MILK.id);
  set("Линия", LINE_2.id);
  set("План, шт", " 1200 ");
  set("Контрагент", NORTH.id);
}

describe("office shifts: planning a shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers «Запланировать смену» to both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(screen.getByRole("button", { name: "Запланировать смену" })).toBeTruthy();
      view.unmount();
    }
  });

  it("starts on today in the organization's time zone", async () => {
    // 13:00 UTC on 9 October is already 10 October in Kamchatka (UTC+12).
    vi.setSystemTime(new Date("2026-10-09T13:00:00Z"));
    const session = shiftsSession();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    await openCreate(session);
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "10 октября 2026",
    );
    expect(within(dialog()).queryByText(/Часовой пояс организации не загрузился/)).toBeNull();
  });

  it("starts on this PC's date and says so when the organization does not load", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockRejectedValue(api("internal"));
    await openCreate(session);
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "9 октября 2026",
    );
    expect(
      within(dialog()).getByText(
        "Часовой пояс организации не загрузился: «сегодня» — по часам этого ПК.",
      ),
    ).toBeTruthy();
  });

  it("offers the products in use by name with their GTINs, the active lines and the counterparties in use", async () => {
    await openCreate(shiftsSession());
    expect(options("Товар")).toEqual([
      "Выберите товар",
      "Вода 0,5 л — 04601234000017",
      "Молоко 3,2% 0,9 л — 04600682000013",
    ]);
    expect(options("Линия")).toEqual(["Выберите линию", "Линия 2", "Линия 10"]);
    expect(options("Контрагент")).toEqual(["Не выбран", "ООО «Северный берег»"]);
    expect(options("Шаблон этикетки короба")).toEqual(["Сначала выберите товар"]);
    expect((field("Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(true);
  });

  it("takes the box capacity and the template from the product: its preference, else the organization's default", async () => {
    await openCreate(shiftsSession());
    set("Товар", MILK.id);
    expect(valueOf("Вместимость короба, шт")).toBe("12");
    expect(valueOf("Шаблон этикетки короба")).toBe(MILK_BOX.id);
    expect(options("Шаблон этикетки короба")).toEqual([
      "Выберите шаблон",
      "Коробка 58×40",
      "Молоко 100×72",
    ]);
    // Water has no preference and its group no default; milk's template is not of its group.
    set("Вместимость короба, шт", "6");
    set("Товар", WATER.id);
    expect(valueOf("Вместимость короба, шт")).toBe("24");
    expect(valueOf("Шаблон этикетки короба")).toBe(BOX_58.id);
    expect(options("Шаблон этикетки короба")).toEqual(["Выберите шаблон", "Коробка 58×40"]);
  });

  it("lets the product be chosen only once the templates and the defaults are read, so the template follows it", async () => {
    const session = shiftsSession();
    let answer: (defaults: TemplateDefaults) => void = () => undefined;
    session.api.getTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        answer = resolve;
      }),
    );
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    await waitFor(() => expect(options("Товар")).toHaveLength(3));
    expect((field("Товар") as HTMLSelectElement).disabled).toBe(true);
    act(() => answer(DEFAULTS));
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    set("Товар", WATER.id);
    expect(valueOf("Шаблон этикетки короба")).toBe(BOX_58.id);
  });

  it("asks the person to choose when no template fits by the rule", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockResolvedValue({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: [],
      rev: 80,
    });
    await openCreate(session);
    set("Товар", WATER.id);
    expect(valueOf("Шаблон этикетки короба")).toBe("");
    expect(options("Шаблон этикетки короба")).toEqual(["Выберите шаблон", "Коробка 58×40"]);
  });

  it("plans the shift with the body built field by field, then closes, says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    pickDate("Дата производства", "12 октября 2026");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: MILK.id,
      lineId: LINE_2.id,
      productionDate: "2026-10-12",
      boxTemplateId: MILK_BOX.id,
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: NORTH.id,
      mode: "aggregation",
      palletsEnabled: false,
    });
    expect(screen.queryByRole("dialog", { name: "Новая смена" })).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("sends no plan and no counterparty as null, and a capacity typed over the product's", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    set("Товар", WATER.id);
    set("Линия", LINE_10.id);
    set("Вместимость короба, шт", " 20 ");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: WATER.id,
      lineId: LINE_10.id,
      productionDate: "2026-10-09",
      boxTemplateId: BOX_58.id,
      boxCapacity: 20,
      plannedQty: null,
      counterpartyId: null,
      mode: "aggregation",
      palletsEnabled: false,
    });
  });

  it("refuses an empty product, line, template, capacity and date before sending, and a bad plan", async () => {
    const session = shiftsSession();
    await openCreate(session);
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Очистить дату: Дата производства" }),
    );
    set("План, шт", "0");
    submit();
    await waitFor(() => expect(messageOf("Товар")).toBe("Выберите товар"));
    expect(messageOf("Линия")).toBe("Выберите линию");
    expect(messageOf("Шаблон этикетки короба")).toBe("Выберите шаблон этикетки короба");
    expect(messageOf("Вместимость короба, шт")).toBe("Укажите целое число от 1 до 100 000");
    expect(within(dialog()).getByText("Укажите дату производства")).toBeTruthy();
    expect(messageOf("План, шт")).toBe(
      "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a product no longer in use",
      api("conflict", { constraint: "product_inactive" }),
      "Товар",
      "Товар больше не в работе: он в архиве или стал черновиком",
    ],
    [
      "an archived line",
      api("validation_failed", { field: "lineId" }),
      "Линия",
      "Линия в архиве. Выберите другую.",
    ],
    [
      "a counterparty archived meanwhile",
      api("validation_failed", { field: "counterpartyId" }),
      "Контрагент",
      "Контрагент в архиве. Выберите другого.",
    ],
    [
      "a plan the host does not take",
      api("validation_failed", { field: "plannedQty" }),
      "План, шт",
      "Хост не принял это значение. Проверьте его.",
    ],
  ])("puts %s under its field and keeps the dialog", async (_what, refusal, label, message) => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(refusal);
    await openCreate(session);
    fillMilk();
    submit();
    await waitFor(() => expect(messageOf(label)).toBe(message));
    expect(dialog()).toBeTruthy();
  });

  it("puts a template switched off meanwhile under the template and reads the templates again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("validation_failed", { field: "boxTemplateId" }));
    await openCreate(session);
    fillMilk();
    session.api.listTemplates.mockResolvedValue([BOX_58, { ...MILK_BOX, enabled: false }]);
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки короба")).toBe(
        "Шаблон выключен или больше не подходит товару. Выберите другой.",
      ),
    );
    await waitFor(() =>
      expect(options("Шаблон этикетки короба")).toEqual([
        "Выберите шаблон",
        "Коробка 58×40",
        "Молоко 100×72 — не подходит",
      ]),
    );
  });

  it("explains any other failure above the fields and sends one request for a double click", async () => {
    const session = shiftsSession();
    let fail: (error: unknown) => void = () => undefined;
    session.api.createShift.mockReturnValue(
      new Promise<OfficeShift>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await openCreate(session);
    fillMilk();
    act(() => {
      submit();
      submit();
    });
    await act(async () => {
      fail(new HostError({ kind: "transport", code: "unreachable", message: "x" }));
      await Promise.resolve();
    });
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    expect(session.api.createShift).toHaveBeenCalledTimes(1);
  });

  it("keeps the template off and says why while the templates do not load", async () => {
    const session = shiftsSession();
    session.api.listTemplates.mockRejectedValue(api("internal"));
    await openCreate(session);
    set("Товар", MILK.id);
    expect((field("Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(true);
    expect(
      within(dialog()).getByText(
        "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
      ),
    ).toBeTruthy();
  });
});
```

2. В `apps/standalone/test/support/shifts.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
```

заменить на

<!-- prettier-ignore -->
```ts
import { fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
```

3. В `apps/standalone/test/support/shifts.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  TemplateDefaults,
} from "../../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./office.js";
```

заменить на

<!-- prettier-ignore -->
```ts
  OfficeUser,
  TemplateDefaults,
} from "../../src/host/protocol.js";
import { fakeOfficeSession, ORG_PROFILE, renderOffice, type FakeOfficeSession } from "./office.js";
```

4. В `apps/standalone/test/support/shifts.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** The office's session with every list the shifts page and its dialogs read. */
export function shiftsSession(
  shifts: OfficeShift[] = [PLANNED, ACTIVE, CLOSED],
): FakeOfficeSession {
  const session = fakeOfficeSession();
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * The office's session, the administrator's unless `user` says, with every
 * list the shifts page and its dialogs read.
 */
export function shiftsSession(
  shifts: OfficeShift[] = [PLANNED, ACTIVE, CLOSED],
  user?: OfficeUser,
): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
```

5. В `apps/standalone/test/support/shifts.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return session;
}

/** Opens «Смены» from the menu and waits for the list. */
export async function openShifts(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  await screen.findByRole("heading", { name: "Смены" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
```

заменить на

<!-- prettier-ignore -->
```ts
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getTemplateDefaults.mockResolvedValue(DEFAULTS);
  return session;
}

/** Opens «Смены» from the menu and waits for the list. */
export async function openShifts(session: FakeOfficeSession): Promise<RenderResult> {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  await screen.findByRole("heading", { name: "Смены" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  return view;
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx`
Expected: FAIL — все 17 тестов (`Unable to find an accessible element with the role "button" and name "Запланировать смену"`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "title": "Смены",
      "filters": "Отбор смен",
```

заменить на

<!-- prettier-ignore -->
```json
      "title": "Смены",
      "add": "Запланировать смену",
      "filters": "Отбор смен",
```

2. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "pager": "Страницы списка смен"
```

заменить на

<!-- prettier-ignore -->
```json
      "pager": "Страницы списка смен",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
      "productOption": "{{name}} — {{gtin}}",
      "fields": {
        "product": "Товар",
        "productPlaceholder": "Выберите товар",
        "productsUnavailable": "Список товаров не загрузился. Закройте окно и откройте его снова.",
        "line": "Линия",
        "linePlaceholder": "Выберите линию",
        "linesUnavailable": "Список линий не загрузился. Закройте окно и откройте его снова.",
        "productionDate": "Дата производства",
        "localDate": "Часовой пояс организации не загрузился: «сегодня» — по часам этого ПК.",
        "plannedQty": "План, шт",
        "optional": "Необязательно",
        "boxCapacity": "Вместимость короба, шт",
        "boxCapacityHint": "Берётся из товара; можно изменить",
        "boxTemplate": "Шаблон этикетки короба",
        "templatePlaceholder": "Выберите шаблон",
        "templateAfterProduct": "Сначала выберите товар",
        "templatesUnavailable": "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
        "counterparty": "Контрагент",
        "noCounterparty": "Не выбран",
        "counterpartyHint": "Необязательно: его название будет на этикетке короба",
        "counterpartiesUnavailable": "Список контрагентов не загрузился: смена будет без контрагента."
      },
      "errors": {
        "productRequired": "Выберите товар",
        "lineRequired": "Выберите линию",
        "templateRequired": "Выберите шаблон этикетки короба",
        "productRejected": "Хост не нашёл этот товар. Выберите другой.",
        "productInactive": "Товар больше не в работе: он в архиве или стал черновиком",
        "lineRejected": "Линия в архиве. Выберите другую.",
        "templateRejected": "Шаблон выключен или больше не подходит товару. Выберите другой.",
        "counterpartyRejected": "Контрагент в архиве. Выберите другого."
      }
```

3. В `apps/standalone/src/office/access.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  editCatalog: ["admin", "technologist"],
} as const satisfies Record<string, readonly OfficeRole[]>;
```

заменить на

<!-- prettier-ignore -->
```ts
  editCatalog: ["admin", "technologist"],
  /** Shifts: plan, change, delete a planned one, close an active one (stage 2a spec §4.9). */
  planShifts: ["admin", "technologist"],
} as const satisfies Record<string, readonly OfficeRole[]>;
```

4. Создать `apps/standalone/src/office/shifts/ShiftDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { DatePicker, Input, Select } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftCreate } from "../../host/requests.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { PageLoading, WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { templateOptions } from "../template-options.js";
import {
  newShiftFields,
  SHIFT_CONFLICTS,
  SHIFT_FIELDS,
  shiftFieldsSchema,
  toShiftInput,
  type ShiftFields,
} from "./shift-form.js";
import { datePickerTexts } from "./shift-text.js";

export interface ShiftDialogProps {
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
}

/**
 * Plans a shift (stage 2a spec §5.6). The production date starts as today in
 * the organization's time zone, so the dialog waits for the organization's
 * profile; when the profile does not load, it starts as this PC's date and
 * says so.
 */
export function ShiftDialog(props: ShiftDialogProps) {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  if (org.isPending) {
    return (
      <FormDialog
        title={t("office.shifts.createTitle")}
        submitLabel={t("office.shifts.create")}
        submitDisabled
        onSubmit={() => Promise.resolve()}
        onClose={props.onClose}
      >
        <PageLoading />
      </FormDialog>
    );
  }
  return (
    <ShiftForm
      {...props}
      today={civilToday(org.isSuccess ? org.data.timeZone : null)}
      zoneKnown={org.isSuccess}
    />
  );
}

interface ShiftFormProps extends ShiftDialogProps {
  today: string;
  /** Whether `today` is the organization's date, not this PC's. */
  zoneKnown: boolean;
}

function ShiftForm({ onClose, onSaved, today, zoneKnown }: ShiftFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const templates = useTemplates();
  const defaults = useTemplateDefaults();
  const save = useOfficeMutation((api, token, values: ShiftFields) =>
    api.createShift(token, shiftCreate(toShiftInput(values))),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ShiftFields>({
    resolver: zodResolver(shiftFieldsSchema),
    defaultValues: newShiftFields(today),
  });
  const productId = watch("productId");
  const product = products.data?.find((each) => each.id === productId);

  // A product in use: active and not archived, by name, its GTIN beside it.
  const productOptions = activeFirstByName(products.data ?? [])
    .filter((each) => !each.archived && each.status === "active")
    .map((each) => ({
      value: each.id,
      label: t("office.shifts.productOption", { name: each.name, gtin: each.gtin14 }),
    }));
  const lineOptions = activeFirstByName(lines.data ?? [])
    .filter((line) => !line.archived)
    .map((line) => ({ value: line.id, label: line.name }));
  const counterpartyOptions = [
    { value: "", label: t("office.shifts.fields.noCounterparty") },
    ...activeFirstByName(counterparties.data ?? [])
      .filter((each) => !each.archived)
      .map((each) => ({ value: each.id, label: each.name })),
  ];

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
    onChange(id);
    const chosen = products.data?.find((each) => each.id === id);
    if (chosen === undefined) return;
    // The capacity and the template follow the product whenever it changes.
    setValue("boxCapacity", chosen.boxCapacity === null ? "" : String(chosen.boxCapacity), {
      shouldDirty: true,
    });
    const suggested = suggestBoxTemplate(chosen, templates.data ?? [], defaults.data ?? null);
    setValue("boxTemplateId", suggested ?? "", { shouldDirty: true });
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(values);
    } catch (error) {
      const outcome = writeFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
        // A template switched off or narrowed meanwhile shows as marked once read again.
        if (outcome.field === "boxTemplateId") void templates.refetch();
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.shifts.createTitle")}
      submitLabel={t("office.shifts.create")}
      width={560}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Controller
        control={control}
        name="productId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.product")}
            placeholder={t("office.shifts.fields.productPlaceholder")}
            options={productOptions}
            value={field.value}
            onValueChange={(id) => chooseProduct(id, field.onChange)}
            // The template follows the product, so the product waits for the templates and the defaults.
            disabled={!products.isSuccess || templates.isPending || defaults.isPending}
            {...(products.isError ? { hint: t("office.shifts.fields.productsUnavailable") } : {})}
            {...fieldError(errors.productId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="lineId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.line")}
            placeholder={t("office.shifts.fields.linePlaceholder")}
            options={lineOptions}
            value={field.value}
            onValueChange={field.onChange}
            disabled={!lines.isSuccess}
            {...(lines.isError ? { hint: t("office.shifts.fields.linesUnavailable") } : {})}
            {...fieldError(errors.lineId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="productionDate"
        render={({ field }) => (
          <DatePicker
            label={t("office.shifts.fields.productionDate")}
            {...datePickerTexts(t)}
            {...(field.value === "" ? {} : { value: field.value })}
            onValueChange={(value) => field.onChange(value ?? "")}
            {...(zoneKnown ? {} : { hint: t("office.shifts.fields.localDate") })}
            {...fieldError(errors.productionDate?.message)}
          />
        )}
      />
      <Input
        label={t("office.shifts.fields.plannedQty")}
        hint={t("office.shifts.fields.optional")}
        inputMode="numeric"
        mono
        {...fieldError(errors.plannedQty?.message)}
        {...register("plannedQty")}
      />
      <Input
        label={t("office.shifts.fields.boxCapacity")}
        hint={t("office.shifts.fields.boxCapacityHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.boxCapacity?.message)}
        {...register("boxCapacity")}
      />
      <Controller
        control={control}
        name="boxTemplateId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.boxTemplate")}
            placeholder={t(
              product === undefined
                ? "office.shifts.fields.templateAfterProduct"
                : "office.shifts.fields.templatePlaceholder",
            )}
            // «Не выбран» is no choice here: a shift prints with a template. Before a
            // product is chosen there is nothing to fit.
            options={
              product === undefined
                ? []
                : templateOptions(
                    templates.data,
                    "box",
                    product.chzProductGroupCode,
                    [field.value],
                    t,
                  ).filter((option) => option.value !== "")
            }
            value={field.value}
            onValueChange={field.onChange}
            disabled={!templates.isSuccess || product === undefined}
            {...(templates.isError ? { hint: t("office.shifts.fields.templatesUnavailable") } : {})}
            {...fieldError(errors.boxTemplateId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="counterpartyId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.counterparty")}
            hint={t(
              counterparties.isError
                ? "office.shifts.fields.counterpartiesUnavailable"
                : "office.shifts.fields.counterpartyHint",
            )}
            options={counterpartyOptions}
            value={field.value}
            onValueChange={field.onChange}
            disabled={!counterparties.isSuccess}
            {...fieldError(errors.counterpartyId?.message)}
          />
        )}
      />
    </FormDialog>
  );
}
```

5. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useState } from "react";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
```

6. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { OfficeShift, ShiftMode, ShiftStatus } from "../../host/protocol.js";
import { useTemplates } from "../catalog-queries.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { OfficeShift, ShiftMode, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useTemplates } from "../catalog-queries.js";
```

7. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
} from "./shift-list.js";
import { datePickerTexts } from "./shift-text.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
} from "./shift-list.js";
import { ShiftDialog } from "./ShiftDialog.js";
import { datePickerTexts } from "./shift-text.js";
```

8. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
const UNITS = new Intl.NumberFormat("ru");

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
```

заменить на

<!-- prettier-ignore -->
```tsx
const UNITS = new Intl.NumberFormat("ru");

type ShiftsDialog = { kind: "create" };

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
```

9. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
```

заменить на

<!-- prettier-ignore -->
```tsx
  const { t } = useTranslation();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ShiftsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [from, setFrom] = useState("");
```

10. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const templates = useTemplates();
  const lookups = [products, lines, counterparties, templates];

  const productName = (shift: OfficeShift) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
  const templates = useTemplates();
  const lookups = [products, lines, counterparties, templates];

  const open = (next: ShiftsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  /** After a write: every list of shifts is read again, whatever its period. */
  const readAgain = () => void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });

  const productName = (shift: OfficeShift) =>
```

11. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      <PageHeader title={t("office.shifts.title")} />
```

заменить на

<!-- prettier-ignore -->
```tsx
      <PageHeader
        title={t("office.shifts.title")}
        actions={
          canPlan ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.shifts.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
```

12. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      {content()}
    </>
```

заменить на

<!-- prettier-ignore -->
```tsx
      {content()}
      {canPlan && dialog?.kind === "create" && (
        <ShiftDialog
          onClose={() => setDialog(null)}
          onSaved={(shift) => {
            setDialog(null);
            setNotice(t("office.shifts.created", { number: shift.number }));
            readAgain();
          }}
        />
      )}
    </>
```

13. Создать `apps/standalone/src/office/shifts/shift-form.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { ShiftInput } from "../../host/requests.js";
import {
  plannedQtyRule,
  productionDateRule,
  shiftBoxCapacityRule,
  toCount,
} from "../../lib/rules.js";

/**
 * A shift as the form holds it: the ids its selects hold (`""` for none), the
 * production date `YYYY-MM-DD` and the counts as typed.
 */
export const shiftFieldsSchema = z.object({
  productId: z.string().min(1, "office.shifts.errors.productRequired"),
  lineId: z.string().min(1, "office.shifts.errors.lineRequired"),
  productionDate: productionDateRule,
  plannedQty: plannedQtyRule,
  boxCapacity: shiftBoxCapacityRule,
  boxTemplateId: z.string().min(1, "office.shifts.errors.templateRequired"),
  counterpartyId: z.string(),
});
export type ShiftFields = z.input<typeof shiftFieldsSchema>;

/** The form's values for a new shift on `today`, the organization's civil date. */
export function newShiftFields(today: string): ShiftFields {
  return {
    productId: "",
    lineId: "",
    productionDate: today,
    plannedQty: "",
    boxCapacity: "",
    boxTemplateId: "",
    counterpartyId: "",
  };
}

/**
 * The host's fields for values the form accepted: the counts as numbers,
 * `null` for no plan or no counterparty.
 */
export function toShiftInput(values: ShiftFields): ShiftInput {
  return {
    productId: values.productId,
    lineId: values.lineId,
    productionDate: values.productionDate,
    boxTemplateId: values.boxTemplateId,
    boxCapacity: Number(values.boxCapacity.trim()),
    plannedQty: toCount(values.plannedQty),
    counterpartyId: values.counterpartyId === "" ? null : values.counterpartyId,
  };
}

/**
 * Where a refusal of a shift's write goes: a `validation_failed` on a record
 * goes under its select in words of its own (the record was archived, turned
 * off or narrowed while the form was open), one on a count or the date says
 * that the host did not take the value.
 */
export const SHIFT_FIELDS = {
  productId: { field: "productId", message: "office.shifts.errors.productRejected" },
  lineId: { field: "lineId", message: "office.shifts.errors.lineRejected" },
  boxTemplateId: { field: "boxTemplateId", message: "office.shifts.errors.templateRejected" },
  counterpartyId: { field: "counterpartyId", message: "office.shifts.errors.counterpartyRejected" },
  productionDate: "productionDate",
  plannedQty: "plannedQty",
  boxCapacity: "boxCapacity",
} as const;

/** A draft or archived product (`product_inactive`) goes under the product. */
export const SHIFT_CONFLICTS = {
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
} as const;
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx test/shifts-page.test.tsx --reporter=verbose`
Expected: PASS — 2 файла, 30 тестов; stderr пуст (без предупреждений `act(...)`: выбор товара не запускает проверку формы — она асинхронная и закончилась бы после теста). Затем те же файлы — под стендом с задержкой `setImmediate`: PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — выбор товара не ставит вместимость. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    setValue("boxCapacity", chosen.boxCapacity === null ? "" : String(chosen.boxCapacity), {
      shouldDirty: true,
    });
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "takes the box capacity"`
Expected: FAIL — «office shifts: planning a shift > takes the box capacity and the template from the product: its preference, else the organization's default» — `AssertionError: expected '' to be '12' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — товар-черновик предлагается в выборе. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    .filter((each) => !each.archived && each.status === "active")
```

заменить на

<!-- prettier-ignore -->
```tsx
    .filter((each) => !each.archived)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "offers the products in use"`
Expected: FAIL — «office shifts: planning a shift > offers the products in use by name with their GTINs, the active lines and the counterparties in use» — `AssertionError: expected [ 'Выберите товар', …(3) ] to deeply equal [ 'Выберите товар', …(2) ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — отказ на шаблоне не перечитывает шаблоны. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (outcome.field === "boxTemplateId") void templates.refetch();
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "switched off meanwhile"`
Expected: FAIL — «office shifts: planning a shift > puts a template switched off meanwhile under the template and reads the templates again» — `AssertionError: expected [ 'Выберите шаблон', …(2) ] to deeply equal [ 'Выберите шаблон', …(2) ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — «сегодня» — по часам этого ПК, а не организации. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      today={civilToday(org.isSuccess ? org.data.timeZone : null)}
```

заменить на

<!-- prettier-ignore -->
```tsx
      today={civilToday(null)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "organization's time zone"`
Expected: FAIL — «office shifts: planning a shift > starts on today in the organization's time zone» — `AssertionError: expected '9 октября 2026' to be '10 октября 2026' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — `product_inactive` не идёт под товар. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "a product no longer in use"`
Expected: FAIL — «office shifts: planning a shift > puts a product no longer in use under its field and keeps the dialog» — `AssertionError: expected undefined to be 'Товар больше не в работе: он в архиве…' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 6 — товар можно выбрать до того, как прочитаны умолчания. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            disabled={!products.isSuccess || templates.isPending || defaults.isPending}
```

заменить на

<!-- prettier-ignore -->
```tsx
            disabled={!products.isSuccess}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx -t "only once the templates"`
Expected: FAIL — «office shifts: planning a shift > lets the product be chosen only once the templates and the defaults are read, so the template follows it» — `AssertionError: expected false to be true // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/shifts apps/standalone/src/office/access.ts apps/standalone/src/i18n/ru.json apps/standalone/test/shift-dialog.test.tsx apps/standalone/test/support/shifts.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 72 файла, 1839 тестов (1822 + 17).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/shifts/shift-form.ts apps/standalone/src/office/shifts/ShiftDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/office/access.ts apps/standalone/src/i18n/ru.json apps/standalone/test/shift-dialog.test.tsx apps/standalone/test/support/shifts.ts
git commit -m "feat(standalone): the office plans a shift" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Правка запланированной смены и план активной

Строка запланированной смены получает «Изменить» (`aria-label` «Изменить смену OCT26-005»), активной — «Изменить план»; у закрытой правки нет. Колонка действий появляется у тех, кому можно планировать (обе роли). Тест списка из задачи 3 сравнивает теперь первые семь ячеек строки: действия идут последней колонкой.

Правка запланированной — то же окно `ShiftDialog` с `shift`: товар не меняется и назван словами вместо выбора; поля начинаются со значений смены (`shiftFields`); «Сохранить» выключена, пока ничего не изменилось; тело — `shiftUpdate(shift, toShiftChange(values))`, только отличное, `null` очищает план и контрагента. Её линия и контрагент остаются выбором, если их убрали в архив или их нет в списке («Линия 1 (в архиве)», «Контрагент 0b7e7dcb…»), шаблон — с пометкой «— не подходит» или «— нет в списке» (`templateOptions` с сохранённым id): хост держит неизменённые ссылки, даже выключенные, а открытие смены их проверит. Окно правки не ждёт профиль организации: «сегодня» ему не нужно.

План активной — отдельное окно `ShiftPlanDialog` с одним полем: смена уже идёт, и хост меняет у неё только план (другое поле — `shift_status`); пусто — без плана (`null`).

Отказы правки разбирает `shiftWriteFailure`: смена, которую тем временем открыли на станции, закрыли (`conflict` `shift_status`, слова по `details.status`) или удалили (`not_found`), — предупреждение своими словами, окно остаётся, а страница перечитывает список за ним (`onOutdated`); `stale_revision` — «Загрузить заново», которое закрывает окно и перечитывает список (`onReload`); прочее — как в задаче 4. После сохранения — «Изменения сохранены.» и перечитывание списков.

Пример гонки из «Заметок для исполнения»: тест отказа плана ждёт, пока кнопка «Сохранить» перестанет быть занятой, прежде чем щёлкнуть её снова.

**Files:**

- Create: `apps/standalone/src/office/shifts/ShiftPlanDialog.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftDialog.tsx`, `apps/standalone/src/office/shifts/shift-form.ts`, `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shift-edit.test.tsx`, `apps/standalone/test/shift-form.test.ts` (Create); `apps/standalone/test/shifts-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `shiftUpdate`, `ShiftChange`, `updateShift` (задача 1); `recordLabel` (задача 3); `ShiftDialog`, `shiftFieldsSchema`, `toShiftInput` (задача 4); `FieldMessage`, `WriteFailure`, `writeFailure` (`src/office/form-errors.ts`).
- Produces:
  - `src/office/shifts/shift-form.ts`: `shiftFields(shift: OfficeShift): ShiftFields`, `toShiftChange(values): ShiftChange`, `shiftWriteFailure<F>(error, fields, conflicts?): { failure: WriteFailure<F>; outdated: boolean }` (задача 6 берёт его для удаления и закрытия);
  - `src/office/shifts/ShiftDialog.tsx`: `ShiftDialog({ shift: OfficeShift | null, onClose, onSaved, onReload, onOutdated })`;
  - `src/office/shifts/ShiftPlanDialog.tsx`: `ShiftPlanDialog({ shift, onClose, onSaved, onReload, onOutdated })`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/shift-edit.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  BOX_58,
  CLOSED,
  freezeToday,
  LINE_2,
  OLD_BOX,
  OLD_LINE,
  openShifts,
  pickDate,
  PLANNED,
  shiftRow,
  shiftsSession,
  SOUTH_ARCHIVED,
} from "./support/shifts.js";

const TOKEN = "office-session-token";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function dialog(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

function field(name: string, label: string): HTMLElement {
  return within(dialog(name)).getByLabelText(label);
}

function options(name: string, label: string): string[] {
  return within(field(name, label))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

function valueOf(name: string, label: string): string {
  const control = field(name, label);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`${label} holds no value`);
  }
  return control.value;
}

function save(name: string): HTMLButtonElement {
  const button = within(dialog(name)).getByRole("button", { name: "Сохранить" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

async function openEdit(session: FakeOfficeSession, shift: OfficeShift): Promise<string> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: `Изменить смену ${shift.number}` }));
  const name = `Смена ${shift.number}`;
  await screen.findByRole("dialog", { name });
  // The template choice waits for the product's record.
  await waitFor(() =>
    expect((field(name, "Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(false),
  );
  return name;
}

async function openPlan(session: FakeOfficeSession, shift: OfficeShift): Promise<string> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: `Изменить план смены ${shift.number}` }));
  const name = `План смены ${shift.number}`;
  await screen.findByRole("dialog", { name });
  return name;
}

describe("office shifts: changing a shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers a planned shift's change, an active one's plan and nothing for a closed one, to both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(
        within(shiftRow("OCT26-005"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Изменить смену OCT26-005"]);
      expect(
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Изменить план смены OCT26-004"]);
      expect(within(shiftRow(CLOSED.number)).queryAllByRole("button")).toEqual([]);
      view.unmount();
    }
  });

  it("opens a planned shift with its own values and its product named, and saves only after a change", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    expect(
      within(dialog(name)).getByText("Товар: Вода 0,5 л. Товар смены не меняется."),
    ).toBeTruthy();
    expect(within(dialog(name)).queryByLabelText("Товар")).toBeNull();
    expect(valueOf(name, "Линия")).toBe(PLANNED.lineId);
    expect(valueOf(name, "План, шт")).toBe("");
    expect(valueOf(name, "Вместимость короба, шт")).toBe("24");
    expect(valueOf(name, "Шаблон этикетки короба")).toBe(BOX_58.id);
    expect(valueOf(name, "Контрагент")).toBe("");
    expect(
      within(dialog(name)).getByRole("button", { name: "Дата производства" }).textContent,
    ).toBe("9 октября 2026");
    expect(save(name).disabled).toBe(true);
  });

  it("sends only what changed with the loaded revision, then says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, lineId: LINE_2.id, rev: 90 });
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "Линия"), { target: { value: LINE_2.id } });
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    pickDate("Дата производства", "10 октября 2026");
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, PLANNED.id, {
      lineId: LINE_2.id,
      productionDate: "2026-10-10",
      plannedQty: 900,
      expectedRev: 72,
    });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("keeps an archived line and counterparty and an unfit template as marked choices, and does not send them back", async () => {
    const shift: OfficeShift = {
      ...PLANNED,
      lineId: OLD_LINE.id,
      counterpartyId: SOUTH_ARCHIVED.id,
      boxTemplateId: OLD_BOX.id,
    };
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, boxCapacity: 30, rev: 91 });
    const name = await openEdit(session, shift);
    expect(options(name, "Линия")).toEqual([
      "Выберите линию",
      "Линия 2",
      "Линия 10",
      "Линия 1 (в архиве)",
    ]);
    expect(options(name, "Контрагент")).toEqual([
      "Не выбран",
      "ООО «Северный берег»",
      "ООО «Юг» (в архиве)",
    ]);
    expect(options(name, "Шаблон этикетки короба")).toEqual([
      "Выберите шаблон",
      "Коробка 58×40",
      "Старая коробка — не подходит",
    ]);
    fireEvent.change(field(name, "Вместимость короба, шт"), { target: { value: "30" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      boxCapacity: 30,
      expectedRev: 72,
    });
  });

  it("clears the plan and the counterparty with null", async () => {
    const session = shiftsSession();
    const shift: OfficeShift = {
      ...PLANNED,
      plannedQty: 800,
      counterpartyId: ACTIVE.counterpartyId,
    };
    session.api.listShifts.mockResolvedValue([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, plannedQty: null, counterpartyId: null });
    const name = await openEdit(session, shift);
    fireEvent.change(field(name, "План, шт"), { target: { value: " " } });
    fireEvent.change(field(name, "Контрагент"), { target: { value: "" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      plannedQty: null,
      counterpartyId: null,
      expectedRev: 72,
    });
  });

  it("offers to load the list again after a stale save, which closes the dialog and drops the edits", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("stale_revision", { currentRev: 95 }));
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    fireEvent.click(await within(dialog(name)).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "opened on a station meanwhile",
      api("conflict", { constraint: "shift_status", status: "active" }),
      "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
    ],
    [
      "deleted meanwhile",
      api("not_found"),
      "Этой смены больше нет: её удалили. Список смен обновлён.",
    ],
  ])(
    "says a shift was %s, keeps the dialog and reads the list again",
    async (_what, refusal, text) => {
      const session = shiftsSession();
      session.api.updateShift.mockRejectedValue(refusal);
      const name = await openEdit(session, PLANNED);
      fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
      fireEvent.click(save(name));
      expect(await within(dialog(name)).findByText(text)).toBeTruthy();
      await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    },
  );

  it("changes an active shift's plan alone, and clears it with null", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...ACTIVE, plannedQty: 1500, rev: 92 });
    const name = await openPlan(session, ACTIVE);
    expect(
      within(dialog(name)).getByText(
        "Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.",
      ),
    ).toBeTruthy();
    expect(valueOf(name, "План, шт")).toBe("1200");
    expect(save(name).disabled).toBe(true);
    fireEvent.change(field(name, "План, шт"), { target: { value: "1500" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id, {
      plannedQty: 1500,
      expectedRev: 71,
    });
    fireEvent.click(screen.getByRole("button", { name: "Изменить план смены OCT26-004" }));
    fireEvent.change(field(name, "План, шт"), { target: { value: "" } });
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id, {
        plannedQty: null,
        expectedRev: 71,
      }),
    );
  });

  it("refuses a plan that is no whole number from 1 to 10 000 000, and says a shift closed meanwhile", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "closed" }),
    );
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "1,5" } });
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText(
        "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
      ),
    ).toBeTruthy();
    expect(session.api.updateShift).not.toHaveBeenCalled();
    // The button is busy until the refused submit has settled.
    await waitFor(() => expect(save(name).disabled).toBe(false));
    fireEvent.change(field(name, "План, шт"), { target: { value: "1300" } });
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText("Смена уже закрыта. Список смен обновлён."),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });
});
```

2. Создать `apps/standalone/test/shift-form.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { shiftUpdate } from "../src/host/requests.js";
import {
  SHIFT_CONFLICTS,
  SHIFT_FIELDS,
  shiftFields,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import { ACTIVE, PLANNED } from "./support/shifts.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

const sort = (error: unknown) => shiftWriteFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);

describe("a shift's form", () => {
  it("loads a planned shift's own values, and sends nothing back for them", () => {
    expect(shiftFields(ACTIVE)).toEqual({
      productId: ACTIVE.productId,
      lineId: ACTIVE.lineId,
      productionDate: "2026-10-08",
      plannedQty: "1200",
      boxCapacity: "12",
      boxTemplateId: ACTIVE.boxTemplateId,
      counterpartyId: ACTIVE.counterpartyId,
    });
    for (const shift of [ACTIVE, PLANNED]) {
      expect(shiftUpdate(shift, toShiftChange(shiftFields(shift)))).toStrictEqual({
        expectedRev: shift.rev,
      });
    }
  });

  it("turns the form's text into the host's numbers and nulls, trimmed", () => {
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        plannedQty: " 900 ",
        boxCapacity: " 20 ",
      }),
    ).toEqual({
      productId: PLANNED.productId,
      lineId: PLANNED.lineId,
      productionDate: "2026-10-09",
      boxTemplateId: PLANNED.boxTemplateId,
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: null,
    });
    // The change of a planned shift never names its product.
    expect(Object.keys(toShiftChange(shiftFields(PLANNED)))).not.toContain("productId");
  });

  it("calls a shift deleted meanwhile, or opened or closed meanwhile, outdated in words of its own", () => {
    expect(sort(api("not_found"))).toEqual({
      failure: { kind: "alert", message: "office.shifts.errors.gone" },
      outdated: true,
    });
    for (const [status, message] of [
      ["active", "office.shifts.errors.nowActive"],
      ["closed", "office.shifts.errors.nowClosed"],
      ["planned", "office.shifts.errors.notOpen"],
    ] as const) {
      expect(sort(api("conflict", { constraint: "shift_status", status }))).toEqual({
        failure: { kind: "alert", message },
        outdated: true,
      });
    }
  });

  it("sorts the rest as any office write: a record under its select, a stale write, an alert", () => {
    expect(sort(api("conflict", { constraint: "product_inactive" }))).toEqual({
      failure: {
        kind: "field",
        field: "productId",
        message: "office.shifts.errors.productInactive",
      },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "lineId" }))).toEqual({
      failure: { kind: "field", field: "lineId", message: "office.shifts.errors.lineRejected" },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "boxCapacity" }))).toEqual({
      failure: { kind: "field", field: "boxCapacity", message: "rules.rejected" },
      outdated: false,
    });
    expect(sort(api("stale_revision"))).toEqual({ failure: { kind: "stale" }, outdated: false });
    expect(sort(api("conflict", { constraint: "shift_busy" }))).toEqual({
      failure: { kind: "alert", message: "errors.api.conflict" },
      outdated: false,
    });
    expect(sort(new HostError({ kind: "transport", code: "unreachable", message: "x" }))).toEqual({
      failure: { kind: "alert", message: "errors.transport.unreachable" },
      outdated: false,
    });
  });
});
```

3. В `apps/standalone/test/shifts-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(cells("OCT26-005")).toEqual([
```

заменить на

<!-- prettier-ignore -->
```tsx
    // The actions, for those who may plan, follow in the last column.
    expect(cells("OCT26-005").slice(0, 7)).toEqual([
```

4. В `apps/standalone/test/shifts-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(cells("OCT26-004")).toEqual([
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(cells("OCT26-004").slice(0, 7)).toEqual([
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx test/shift-form.test.ts`
Expected: FAIL — все 10 тестов `test/shift-edit.test.tsx` (`Unable to find an accessible element with the role "button" and name "Изменить смену OCT26-005"` и «…план смены OCT26-004»); все 4 теста `test/shift-form.test.ts` (`shiftFields is not a function`, `shiftWriteFailure is not a function`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "status": "Статус"
```

заменить на

<!-- prettier-ignore -->
```json
        "status": "Статус",
        "actions": "Действия"
```

2. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
```

заменить на

<!-- prettier-ignore -->
```json
      "edit": "Изменить",
      "editNamed": "Изменить смену {{number}}",
      "plan": "Изменить план",
      "planNamed": "Изменить план смены {{number}}",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
      "editTitle": "Смена {{number}}",
      "planTitle": "План смены {{number}}",
      "planIntro": "Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.",
```

3. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "productsUnavailable": "Список товаров не загрузился. Закройте окно и откройте его снова.",
        "line": "Линия",
```

заменить на

<!-- prettier-ignore -->
```json
        "productsUnavailable": "Список товаров не загрузился. Закройте окно и откройте его снова.",
        "productFixed": "Товар: {{name}}. Товар смены не меняется.",
        "line": "Линия",
```

4. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "optional": "Необязательно",
        "boxCapacity": "Вместимость короба, шт",
```

заменить на

<!-- prettier-ignore -->
```json
        "optional": "Необязательно",
        "planHint": "Пусто — без плана",
        "boxCapacity": "Вместимость короба, шт",
```

5. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "counterpartyRejected": "Контрагент в архиве. Выберите другого."
```

заменить на

<!-- prettier-ignore -->
```json
        "counterpartyRejected": "Контрагент в архиве. Выберите другого.",
        "gone": "Этой смены больше нет: её удалили. Список смен обновлён.",
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
        "nowClosed": "Смена уже закрыта. Список смен обновлён.",
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
```

6. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { shiftCreate } from "../../host/requests.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { shiftCreate, shiftUpdate } from "../../host/requests.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
```

7. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  shiftFieldsSchema,
  toShiftInput,
  type ShiftFields,
} from "./shift-form.js";
import { datePickerTexts } from "./shift-text.js";

export interface ShiftDialogProps {
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
}

/**
 * Plans a shift (stage 2a spec §5.6). The production date starts as today in
 * the organization's time zone, so the dialog waits for the organization's
 * profile; when the profile does not load, it starts as this PC's date and
 * says so.
 */
export function ShiftDialog(props: ShiftDialogProps) {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
```

заменить на

<!-- prettier-ignore -->
```tsx
  shiftFields,
  shiftFieldsSchema,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
  type ShiftFields,
} from "./shift-form.js";
import { recordLabel } from "./shift-list.js";
import { datePickerTexts } from "./shift-text.js";

export interface ShiftDialogProps {
  /** `null` plans a new shift; a planned shift is changed. */
  shift: OfficeShift | null;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was opened, closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Plans a shift, or changes a planned one (stage 2a spec §5.6). A new shift's
 * production date starts as today in the organization's time zone, so the
 * dialog waits for the organization's profile; when the profile does not
 * load, it starts as this PC's date and says so.
 */
export function ShiftDialog(props: ShiftDialogProps) {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token), {
    enabled: props.shift === null,
  });
  if (props.shift !== null) {
    return <ShiftForm {...props} today={props.shift.productionDate} zoneKnown />;
  }
```

8. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
function ShiftForm({ onClose, onSaved, today, zoneKnown }: ShiftFormProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx
function ShiftForm({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
  today,
  zoneKnown,
}: ShiftFormProps) {
```

9. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    api.createShift(token, shiftCreate(toShiftInput(values))),
```

заменить на

<!-- prettier-ignore -->
```tsx
    shift === null
      ? api.createShift(token, shiftCreate(toShiftInput(values)))
      : api.updateShift(token, shift.id, shiftUpdate(shift, toShiftChange(values))),
```

10. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    formState: { errors },
  } = useForm<ShiftFields>({
    resolver: zodResolver(shiftFieldsSchema),
    defaultValues: newShiftFields(today),
```

заменить на

<!-- prettier-ignore -->
```tsx
    formState: { errors, isDirty },
  } = useForm<ShiftFields>({
    resolver: zodResolver(shiftFieldsSchema),
    defaultValues: shift === null ? newShiftFields(today) : shiftFields(shift),
```

11. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      .map((each) => ({ value: each.id, label: each.name })),
  ];

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
```

заменить на

<!-- prettier-ignore -->
```tsx
      .map((each) => ({ value: each.id, label: each.name })),
  ];
  // A changed shift keeps its own line and counterparty as choices, marked
  // when archived or missing: the host keeps one that does not change.
  if (shift !== null) {
    if (!lineOptions.some((option) => option.value === shift.lineId)) {
      lineOptions.push({
        value: shift.lineId,
        label: recordLabel("line", lines.data, shift.lineId, t),
      });
    }
    const own = shift.counterpartyId;
    if (own !== null && !counterpartyOptions.some((option) => option.value === own)) {
      counterpartyOptions.push({
        value: own,
        label: recordLabel("counterparty", counterparties.data, own, t),
      });
    }
  }

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
```

12. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      const outcome = writeFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);
```

заменить на

<!-- prettier-ignore -->
```tsx
      const { failure: outcome, outdated } = shiftWriteFailure(
        error,
        SHIFT_FIELDS,
        SHIFT_CONFLICTS,
      );
```

13. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      }
      return;
```

заменить на

<!-- prettier-ignore -->
```tsx
      }
      if (outdated) onOutdated();
      return;
```

14. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      title={t("office.shifts.createTitle")}
      submitLabel={t("office.shifts.create")}
      width={560}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Controller
        control={control}
        name="productId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.product")}
            placeholder={t("office.shifts.fields.productPlaceholder")}
            options={productOptions}
            value={field.value}
            onValueChange={(id) => chooseProduct(id, field.onChange)}
            // The template follows the product, so the product waits for the templates and the defaults.
            disabled={!products.isSuccess || templates.isPending || defaults.isPending}
            {...(products.isError ? { hint: t("office.shifts.fields.productsUnavailable") } : {})}
            {...fieldError(errors.productId?.message)}
          />
        )}
      />
```

заменить на

<!-- prettier-ignore -->
```tsx
      title={
        shift === null
          ? t("office.shifts.createTitle")
          : t("office.shifts.editTitle", { number: shift.number })
      }
      submitLabel={shift === null ? t("office.shifts.create") : t("office.common.save")}
      submitDisabled={shift !== null && !isDirty}
      width={560}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      {shift !== null ? (
        // The product never changes: a changed shift names it.
        <p>
          {t("office.shifts.fields.productFixed", {
            name: recordLabel("product", products.data, shift.productId, t),
          })}
        </p>
      ) : (
        <Controller
          control={control}
          name="productId"
          render={({ field }) => (
            <Select
              native
              label={t("office.shifts.fields.product")}
              placeholder={t("office.shifts.fields.productPlaceholder")}
              options={productOptions}
              value={field.value}
              onValueChange={(id) => chooseProduct(id, field.onChange)}
              // The template follows the product, so the product waits for the templates and the defaults.
              disabled={!products.isSuccess || templates.isPending || defaults.isPending}
              {...(products.isError ? { hint: t("office.shifts.fields.productsUnavailable") } : {})}
              {...fieldError(errors.productId?.message)}
            />
          )}
        />
      )}
```

15. В `apps/standalone/src/office/shifts/ShiftDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
                    [field.value],
```

заменить на

<!-- prettier-ignore -->
```tsx
                    [shift?.boxTemplateId ?? "", field.value],
```

16. Создать `apps/standalone/src/office/shifts/ShiftPlanDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftUpdate } from "../../host/requests.js";
import { plannedQtyRule, toCount } from "../../lib/rules.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";

const planSchema = z.object({ plannedQty: plannedQtyRule });
type PlanValues = z.input<typeof planSchema>;

export interface ShiftPlanDialogProps {
  /** An active shift: only its plan changes, which neither its label nor its snapshot shows. */
  shift: OfficeShift;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/** Changes the plan of an active shift (`PUT` with `plannedQty` alone; blank clears it). */
export function ShiftPlanDialog({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
}: ShiftPlanDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, plannedQty: number | null) =>
    api.updateShift(token, shift.id, shiftUpdate(shift, { plannedQty })),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<PlanValues>({
    resolver: zodResolver(planSchema),
    defaultValues: { plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty) },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(toCount(values.plannedQty));
    } catch (error) {
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        plannedQty: "plannedQty",
      });
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      if (outdated) onOutdated();
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.shifts.planTitle", { number: shift.number })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.shifts.planIntro")}</p>
      <Input
        label={t("office.shifts.fields.plannedQty")}
        hint={t("office.shifts.fields.planHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.plannedQty?.message)}
        {...register("plannedQty")}
      />
    </FormDialog>
  );
}
```

17. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  PageHeader,
  Select,
```

заменить на

<!-- prettier-ignore -->
```tsx
  PageHeader,
  RowActions,
  Select,
```

18. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { ShiftDialog } from "./ShiftDialog.js";
import { datePickerTexts } from "./shift-text.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { ShiftDialog } from "./ShiftDialog.js";
import { ShiftPlanDialog } from "./ShiftPlanDialog.js";
import { datePickerTexts } from "./shift-text.js";
```

19. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
type ShiftsDialog = { kind: "create" };
```

заменить на

<!-- prettier-ignore -->
```tsx
type ShiftsDialog =
  { kind: "create" } | { kind: "edit"; shift: OfficeShift } | { kind: "plan"; shift: OfficeShift };
```

20. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  /** After a write: every list of shifts is read again, whatever its period. */
  const readAgain = () => void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });

  const productName = (shift: OfficeShift) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
  /** After a write: every list of shifts is read again, whatever its period. */
  const readAgain = () => void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });
  const saved = (message: string) => {
    setDialog(null);
    setNotice(message);
    readAgain();
  };
  const reload = () => {
    setDialog(null);
    readAgain();
  };

  const productName = (shift: OfficeShift) =>
```

21. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    },
  ];

  const content = () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
    },
  ];

  if (canPlan) {
    columns.push({
      key: "actions",
      title: t("office.shifts.table.actions"),
      render: (shift) => (
        <RowActions>
          {shift.status === "planned" && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.editNamed", { number: shift.number })}
              onClick={() => open({ kind: "edit", shift })}
            >
              {t("office.shifts.edit")}
            </Button>
          )}
          {shift.status === "active" && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.planNamed", { number: shift.number })}
              onClick={() => open({ kind: "plan", shift })}
            >
              {t("office.shifts.plan")}
            </Button>
          )}
        </RowActions>
      ),
    });
  }

  const content = () => {
```

22. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      {canPlan && dialog?.kind === "create" && (
        <ShiftDialog
          onClose={() => setDialog(null)}
          onSaved={(shift) => {
            setDialog(null);
            setNotice(t("office.shifts.created", { number: shift.number }));
            readAgain();
          }}
```

заменить на

<!-- prettier-ignore -->
```tsx
      {canPlan && (dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ShiftDialog
          shift={dialog.kind === "edit" ? dialog.shift : null}
          onClose={() => setDialog(null)}
          onSaved={(shift) =>
            saved(
              dialog.kind === "create"
                ? t("office.shifts.created", { number: shift.number })
                : t("office.common.saved"),
            )
          }
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "plan" && (
        <ShiftPlanDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onSaved={() => saved(t("office.common.saved"))}
          onReload={reload}
          onOutdated={readAgain}
```

23. В `apps/standalone/src/office/shifts/shift-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { ShiftInput } from "../../host/requests.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import type { ShiftChange, ShiftInput } from "../../host/requests.js";
```

24. В `apps/standalone/src/office/shifts/shift-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  toCount,
} from "../../lib/rules.js";

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  toCount,
} from "../../lib/rules.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";

/**
```

25. В `apps/standalone/src/office/shifts/shift-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    counterpartyId: "",
  };
```

заменить на

<!-- prettier-ignore -->
```ts
    counterpartyId: "",
  };
}

/** The form's values for a planned shift being changed: its own, the counts as text. */
export function shiftFields(shift: OfficeShift): ShiftFields {
  return {
    productId: shift.productId,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
    boxCapacity: String(shift.boxCapacity),
    boxTemplateId: shift.boxTemplateId,
    counterpartyId: shift.counterpartyId ?? "",
  };
```

26. В `apps/standalone/src/office/shifts/shift-form.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
} as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  product_inactive: { field: "productId", message: "office.shifts.errors.productInactive" },
} as const;

/**
 * What a planned shift is to become, for `shiftUpdate`: every field the form
 * holds but the product, which never changes.
 */
export function toShiftChange(values: ShiftFields): ShiftChange {
  const input = toShiftInput(values);
  return {
    lineId: input.lineId,
    productionDate: input.productionDate,
    boxTemplateId: input.boxTemplateId,
    boxCapacity: input.boxCapacity,
    plannedQty: input.plannedQty,
    counterpartyId: input.counterpartyId,
  };
}

/**
 * Sorts a refused change of a shift: one a station opened or someone closed
 * meanwhile (`conflict` on `shift_status`, which names the status now) and one
 * deleted meanwhile (`not_found`) are alerts in words of their own, which the
 * page follows by reading the list again (`outdated`); the rest goes as
 * `writeFailure` sorts it with `fields` and `conflicts`.
 */
export function shiftWriteFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F | FieldMessage<F>>>,
  conflicts: Readonly<Record<string, FieldMessage<F>>> = {},
): { failure: WriteFailure<F>; outdated: boolean } {
  if (error instanceof HostError) {
    if (error.code === "not_found") {
      return { failure: { kind: "alert", message: "office.shifts.errors.gone" }, outdated: true };
    }
    if (error.code === "conflict" && error.details.constraint === "shift_status") {
      const status = error.details.status;
      const message =
        status === "active"
          ? "office.shifts.errors.nowActive"
          : status === "closed"
            ? "office.shifts.errors.nowClosed"
            : "office.shifts.errors.notOpen";
      return { failure: { kind: "alert", message }, outdated: true };
    }
  }
  return { failure: writeFailure(error, fields, conflicts), outdated: false };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx test/shift-form.test.ts test/shift-dialog.test.tsx test/shifts-page.test.tsx --reporter=verbose`
Expected: PASS — 4 файла, 44 теста; stderr пуст. Затем те же файлы — под стендом с задержкой `setImmediate`: PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — архивная линия смены пропадает из выбора. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    if (!lineOptions.some((option) => option.value === shift.lineId)) {
```

заменить на

<!-- prettier-ignore -->
```tsx
    if (lineOptions.length < 0) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx -t "marked choices"`
Expected: FAIL — «office shifts: changing a shift > keeps an archived line and counterparty and an unfit template as marked choices, and does not send them back» — `AssertionError: expected [ 'Выберите линию', 'Линия 2', …(1) ] to deeply equal [ 'Выберите линию', 'Линия 2', …(2) ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — удалённая тем временем смена не перечитывает список. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
      return { failure: { kind: "alert", message: "office.shifts.errors.gone" }, outdated: true };
```

заменить на

<!-- prettier-ignore -->
```ts
      return { failure: { kind: "alert", message: "office.shifts.errors.gone" }, outdated: false };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx -t "deleted meanwhile"`
Expected: FAIL — «office shifts: changing a shift > says a shift was deleted meanwhile, keeps the dialog and reads the list again» — `AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — слова `shift_status` перепутаны по статусу. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
        status === "active"
          ? "office.shifts.errors.nowActive"
```

заменить на

<!-- prettier-ignore -->
```ts
        status === "closed"
          ? "office.shifts.errors.nowActive"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-form.test.ts -t "outdated in words"`
Expected: FAIL — «a shift's form > calls a shift deleted meanwhile, or opened or closed meanwhile, outdated in words of its own» — `AssertionError: expected { …(2) } to deeply equal { …(2) }`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — пустой план активной смены уходит нулём, а не `null`. В `apps/standalone/src/office/shifts/ShiftPlanDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      saved = await save.mutateAsync(toCount(values.plannedQty));
```

заменить на

<!-- prettier-ignore -->
```tsx
      saved = await save.mutateAsync(Number(values.plannedQty));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx -t "clears it with null"`
Expected: FAIL — «office shifts: changing a shift > changes an active shift's plan alone, and clears it with null» — `AssertionError: expected last "vi.fn()" call to have been called with [ 'office-session-token', …(2) ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — «Сохранить» правки включена без изменений. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      submitDisabled={shift !== null && !isDirty}
```

заменить на

<!-- prettier-ignore -->
```tsx
      submitDisabled={false}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx -t "saves only after a change"`
Expected: FAIL — «office shifts: changing a shift > opens a planned shift with its own values and its product named, and saves only after a change» — `AssertionError: expected false to be true // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/shifts apps/standalone/src/i18n/ru.json apps/standalone/test/shift-edit.test.tsx apps/standalone/test/shift-form.test.ts apps/standalone/test/shifts-page.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 74 файла, 1853 теста (1839 + 14).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/shifts/ShiftPlanDialog.tsx apps/standalone/src/office/shifts/ShiftDialog.tsx apps/standalone/src/office/shifts/shift-form.ts apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/shift-edit.test.tsx apps/standalone/test/shift-form.test.ts apps/standalone/test/shifts-page.test.tsx
git commit -m "feat(standalone): the office changes a planned shift and an active shift's plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Удаление запланированной смены и закрытие активной с причиной

Строка запланированной смены получает «Удалить», активной — «Закрыть». Оба окна — `FormDialog` с вариантом `destructive`: действие выводит смену из оборота.

`DeleteShiftDialog` спрашивает, называя номер и товар, и говорит, что номер больше не выдаётся (хост его не переиспользует). `not_found` — смена уже удалена (на другом рабочем месте или повтор после потерянного ответа: надгробий у смен нет), и окно ведёт себя как после удаления. `shift_status` — смену тем временем открыли: предупреждение, список перечитывается.

`CloseShiftDialog` объясняет, когда закрывать смену из офиса (станция её уже не закончит), и просит причину — `Textarea` с правилом `closeReasonRule` (3–500 символов, посчитанных как на хосте; задача 2). У `Textarea` из `@markiro/ui` нет `error`, поэтому подсказка и отказ — строка под полем (`shift-note`, в тоне ошибки — `shift-note--error`, как пишет их `Input`), связанная `aria-describedby`, а у поля при отказе — `aria-invalid`. Причина уходит обрезанной, с загруженной ревизией (`shiftClose`). Отказы: `validation_failed` на `reason` — под полем; `stale_revision` — «Загрузить заново»; `shift_status` (уже закрыта или ещё не открыта) и `not_found` — предупреждение своими словами и перечитывание списка.

Тест строк из задачи 5 получает новые кнопки.

**Files:**

- Create: `apps/standalone/src/office/shifts/DeleteShiftDialog.tsx`, `apps/standalone/src/office/shifts/CloseShiftDialog.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shift-delete-close.test.tsx` (Create); `apps/standalone/test/shift-edit.test.tsx` (Modify)

**Interfaces:**

- Consumes: `deleteShift`, `closeShift`, `shiftClose` (задача 1); `closeReasonRule` (задача 2); `shiftWriteFailure` (задача 5); `HostError`.
- Produces: `DeleteShiftDialog({ shift, productName, onClose, onDeleted, onOutdated })`, `CloseShiftDialog({ shift, onClose, onClosed, onReload, onOutdated })`; классы `shift-note`, `shift-note--error`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/shift-delete-close.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { FakeOfficeSession } from "./support/office.js";
import { ACTIVE, freezeToday, openShifts, PLANNED, shiftsSession } from "./support/shifts.js";

const TOKEN = "office-session-token";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function dialog(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

async function openDelete(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-005" }));
  return screen.findByRole("dialog", { name: "Удалить смену OCT26-005?" });
}

async function openClose(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
  return screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
}

function reason(): HTMLTextAreaElement {
  const field = within(dialog("Закрыть смену OCT26-004")).getByLabelText("Причина закрытия");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no reason field");
  return field;
}

/** The note under the reason, by its `aria-describedby`. */
function reasonNote(): string | null | undefined {
  const id = reason().getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

function closeShift(): void {
  fireEvent.click(
    within(dialog("Закрыть смену OCT26-004")).getByRole("button", { name: "Закрыть смену" }),
  );
}

describe("office shifts: deleting a planned shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks first, naming the shift and its product, then deletes it, says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockResolvedValue(undefined);
    const confirm = await openDelete(session);
    expect(
      within(confirm).getByText(
        "Смена OCT26-005 («Вода 0,5 л») будет удалена без возможности восстановления. Её номер больше не выдаётся.",
      ),
    ).toBeTruthy();
    const submit = within(confirm).getByRole("button", { name: "Удалить" });
    expect(submit.className).toContain("mk-btn--destructive");
    fireEvent.click(submit);
    await screen.findByText("Смена OCT26-005 удалена.");
    expect(session.api.deleteShift).toHaveBeenCalledWith(TOKEN, PLANNED.id);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("takes a shift already gone as deleted", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(api("not_found"));
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await screen.findByText("Смена OCT26-005 удалена.");
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("says a shift a station opened meanwhile cannot be deleted, keeps the dialog and reads the list again", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "active" }),
    );
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect(
      await within(confirm).findByText(
        "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("explains a failed request and reads nothing again", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect(await within(confirm).findByRole("alert")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });
});

describe("office shifts: closing an active shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the reason in words and sends it trimmed with the loaded revision, then says so", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue({
      ...ACTIVE,
      status: "closed",
      closedAt: "2026-10-09T10:00:00Z",
      closeReasonText: "Станция линии 2 вышла из строя",
      rev: 99,
    });
    const confirm = await openClose(session);
    expect(within(confirm).getByText(/только если станция её уже не закончит/)).toBeTruthy();
    expect(reasonNote()).toBe(
      "От 3 до 500 символов. Её увидят в списке смен и в журнале действий.",
    );
    const submit = within(confirm).getByRole("button", { name: "Закрыть смену" });
    expect(submit.className).toContain("mk-btn--destructive");
    fireEvent.change(reason(), { target: { value: "  Станция линии 2 вышла из строя  " } });
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
      reason: "Станция линии 2 вышла из строя",
      expectedRev: 71,
    });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("counts the reason in characters as the host does: two emoji are too short, three are enough", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue({ ...ACTIVE, status: "closed" });
    await openClose(session);
    for (const text of ["", "аб", "😀😀"]) {
      fireEvent.change(reason(), { target: { value: text } });
      closeShift();
      await waitFor(() => expect(reasonNote()).toBe("Опишите причину: от 3 до 500 символов"));
      expect(reason().getAttribute("aria-invalid")).toBe("true");
      await waitFor(() =>
        expect(
          within(dialog("Закрыть смену OCT26-004"))
            .getByRole("button", { name: "Закрыть смену" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    }
    expect(session.api.closeShift).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: "😀😀😀" } });
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
      reason: "😀😀😀",
      expectedRev: 71,
    });
  });

  it("puts the host's refusal of the reason under it", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(api("validation_failed", { field: "reason" }));
    await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    await waitFor(() => expect(reasonNote()).toBe("Опишите причину: от 3 до 500 символов"));
  });

  it("offers to load the list again after a stale close, which closes the dialog", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(api("stale_revision", { currentRev: 80 }));
    const confirm = await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    fireEvent.click(await within(confirm).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it.each([
    [
      "closed meanwhile",
      api("conflict", { constraint: "shift_status", status: "closed" }),
      "Смена уже закрыта. Список смен обновлён.",
    ],
    [
      "not open yet",
      api("conflict", { constraint: "shift_status", status: "planned" }),
      "Смена ещё не открыта на станции. Список смен обновлён.",
    ],
    ["gone", api("not_found"), "Этой смены больше нет: её удалили. Список смен обновлён."],
  ])("says a shift %s, keeps the dialog and reads the list again", async (_what, refusal, text) => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(refusal);
    const confirm = await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    expect(await within(confirm).findByText(text)).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });
});
```

2. В `apps/standalone/test/shift-edit.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  it("offers a planned shift's change, an active one's plan and nothing for a closed one, to both roles", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  it("offers a planned shift's change and delete, an active one's plan and close, and nothing for a closed one, to both roles", async () => {
```

3. В `apps/standalone/test/shift-edit.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      ).toEqual(["Изменить смену OCT26-005"]);
      expect(
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Изменить план смены OCT26-004"]);
```

заменить на

<!-- prettier-ignore -->
```tsx
      ).toEqual(["Изменить смену OCT26-005", "Удалить смену OCT26-005"]);
      expect(
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Изменить план смены OCT26-004", "Закрыть смену OCT26-004"]);
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx test/shift-edit.test.tsx`
Expected: FAIL — все 11 тестов `test/shift-delete-close.test.tsx` (`Unable to find an accessible element with the role "button" and name "Удалить смену OCT26-005"` и «Закрыть смену OCT26-004») и в `test/shift-edit.test.tsx` «offers a planned shift's change and delete…» (`expected [ 'Изменить смену OCT26-005' ] to deeply equal [ 'Изменить смену OCT26-005', …(1) ]`); остальные 9 проходят.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
}

.office-pager {
  display: flex;
```

заменить на

<!-- prettier-ignore -->
```css
}

/* The note under the close reason: the hint, or the refusal in the error tone, as `Input` writes them. */
.shift-note {
  font: var(--text-body-sm);
  color: var(--fg-3);
}

.shift-note--error {
  color: var(--err-fg);
}

.office-pager {
  display: flex;
```

2. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "planNamed": "Изменить план смены {{number}}",
      "createTitle": "Новая смена",
```

заменить на

<!-- prettier-ignore -->
```json
      "planNamed": "Изменить план смены {{number}}",
      "delete": "Удалить",
      "deleteNamed": "Удалить смену {{number}}",
      "close": "Закрыть",
      "closeNamed": "Закрыть смену {{number}}",
      "createTitle": "Новая смена",
```

3. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "planIntro": "Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.",
      "productOption": "{{name}} — {{gtin}}",
```

заменить на

<!-- prettier-ignore -->
```json
      "planIntro": "Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.",
      "deleteTitle": "Удалить смену {{number}}?",
      "deleteBody": "Смена {{number}} («{{product}}») будет удалена без возможности восстановления. Её номер больше не выдаётся.",
      "deleteSubmit": "Удалить",
      "deleted": "Смена {{number}} удалена.",
      "closeTitle": "Закрыть смену {{number}}",
      "closeIntro": "Закрывайте смену в офисе, только если станция её уже не закончит: например, станция сломалась. Станция не сможет продолжить эту смену; данные, которые она пришлёт позже, будут приняты и отмечены.",
      "closeSubmit": "Закрыть смену",
      "closed": "Смена {{number}} закрыта.",
      "productOption": "{{name}} — {{gtin}}",
```

4. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "counterpartiesUnavailable": "Список контрагентов не загрузился: смена будет без контрагента."
```

заменить на

<!-- prettier-ignore -->
```json
        "counterpartiesUnavailable": "Список контрагентов не загрузился: смена будет без контрагента.",
        "reason": "Причина закрытия",
        "reasonHint": "От 3 до 500 символов. Её увидят в списке смен и в журнале действий."
```

5. Создать `apps/standalone/src/office/shifts/CloseShiftDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Textarea } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftClose } from "../../host/requests.js";
import { closeReasonRule } from "../../lib/rules.js";
import type { AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";

const closeSchema = z.object({ reason: closeReasonRule });
type CloseValues = z.input<typeof closeSchema>;

export interface CloseShiftDialogProps {
  /** An active shift. */
  shift: OfficeShift;
  onClose: () => void;
  onClosed: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Closes an active shift from the office, with the reason in words (3 to 500
 * characters, counted as the host counts them), over the loaded revision: for
 * a station that died or a shift nobody will finish.
 */
export function CloseShiftDialog({
  shift,
  onClose,
  onClosed,
  onReload,
  onOutdated,
}: CloseShiftDialogProps) {
  const { t } = useTranslation();
  const noteId = useId();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const close = useOfficeMutation((api, token, reason: string) =>
    api.closeShift(token, shift.id, shiftClose(reason, shift.rev)),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CloseValues>({
    resolver: zodResolver(closeSchema),
    defaultValues: { reason: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let closed: OfficeShift;
    try {
      // The rule trimmed the reason: what is sent is what the host keeps.
      closed = await close.mutateAsync(values.reason);
    } catch (error) {
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        reason: { field: "reason", message: "rules.closeReason" },
      });
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      if (outdated) onOutdated();
      return;
    }
    onClosed(closed);
  });

  const message = errors.reason?.message;
  return (
    <FormDialog
      title={t("office.shifts.closeTitle", { number: shift.number })}
      submitLabel={t("office.shifts.closeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.shifts.closeIntro")}</p>
      <Textarea
        label={t("office.shifts.fields.reason")}
        rows={4}
        aria-invalid={message === undefined ? undefined : true}
        aria-describedby={noteId}
        {...register("reason")}
      />
      <span
        id={noteId}
        className={message === undefined ? "shift-note" : "shift-note shift-note--error"}
      >
        {message === undefined ? t("office.shifts.fields.reasonHint") : t(message)}
      </span>
    </FormDialog>
  );
}
```

6. Создать `apps/standalone/src/office/shifts/DeleteShiftDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import type { AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";

export interface DeleteShiftDialogProps {
  /** A planned shift no station has entered. */
  shift: OfficeShift;
  /** How the list names the shift's product. */
  productName: string;
  onClose: () => void;
  onDeleted: () => void;
  /** The shift was opened or closed meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Deletes a planned shift after asking (`DELETE`, 204). Its number is not
 * drawn again. A shift already gone (`not_found`: deleted on another
 * workstation, or a repeat after a lost answer) is deleted all the same.
 */
export function DeleteShiftDialog({
  shift,
  productName,
  onClose,
  onDeleted,
  onOutdated,
}: DeleteShiftDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const remove = useOfficeMutation((api, token, id: string) => api.deleteShift(token, id));

  const submit = async () => {
    setFailure(null);
    try {
      await remove.mutateAsync(shift.id);
    } catch (error) {
      if (!(error instanceof HostError && error.code === "not_found")) {
        // No field to go under: with none named, every refusal is an alert.
        const { failure: outcome, outdated } = shiftWriteFailure<never>(error, {});
        if (outcome.kind !== "field") setFailure(outcome);
        if (outdated) onOutdated();
        return;
      }
    }
    onDeleted();
  };

  return (
    <FormDialog
      title={t("office.shifts.deleteTitle", { number: shift.number })}
      submitLabel={t("office.shifts.deleteSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.shifts.deleteBody", { number: shift.number, product: productName })}</p>
    </FormDialog>
  );
}
```

7. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
} from "./shift-list.js";
import { ShiftDialog } from "./ShiftDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
} from "./shift-list.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import { DeleteShiftDialog } from "./DeleteShiftDialog.js";
import { ShiftDialog } from "./ShiftDialog.js";
```

8. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  { kind: "create" } | { kind: "edit"; shift: OfficeShift } | { kind: "plan"; shift: OfficeShift };
```

заменить на

<!-- prettier-ignore -->
```tsx
  | { kind: "create" }
  | { kind: "edit"; shift: OfficeShift }
  | { kind: "plan"; shift: OfficeShift }
  | { kind: "delete"; shift: OfficeShift }
  | { kind: "close"; shift: OfficeShift };
```

9. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.editNamed", { number: shift.number })}
              onClick={() => open({ kind: "edit", shift })}
            >
              {t("office.shifts.edit")}
            </Button>
          )}
          {shift.status === "active" && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.planNamed", { number: shift.number })}
              onClick={() => open({ kind: "plan", shift })}
            >
              {t("office.shifts.plan")}
            </Button>
```

заменить на

<!-- prettier-ignore -->
```tsx
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.editNamed", { number: shift.number })}
                onClick={() => open({ kind: "edit", shift })}
              >
                {t("office.shifts.edit")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
                onClick={() => open({ kind: "delete", shift })}
              >
                {t("office.shifts.delete")}
              </Button>
            </>
          )}
          {shift.status === "active" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.planNamed", { number: shift.number })}
                onClick={() => open({ kind: "plan", shift })}
              >
                {t("office.shifts.plan")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.closeNamed", { number: shift.number })}
                onClick={() => open({ kind: "close", shift })}
              >
                {t("office.shifts.close")}
              </Button>
            </>
```

10. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      )}
      {canPlan && dialog?.kind === "plan" && (
```

заменить на

<!-- prettier-ignore -->
```tsx
      )}
      {canPlan && dialog?.kind === "delete" && (
        <DeleteShiftDialog
          shift={dialog.shift}
          productName={productName(dialog.shift)}
          onClose={() => setDialog(null)}
          onDeleted={() => saved(t("office.shifts.deleted", { number: dialog.shift.number }))}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "close" && (
        <CloseShiftDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onClosed={(shift) => saved(t("office.shifts.closed", { number: shift.number }))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "plan" && (
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx test/shift-edit.test.tsx test/shifts-page.test.tsx --reporter=verbose`
Expected: PASS — 3 файла, 34 теста; stderr пуст. Затем те же файлы и `test/shift-dialog.test.tsx` — под стендом с задержкой `setImmediate`: PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — `not_found` на удалении — ошибка, а не удалённая смена. В `apps/standalone/src/office/shifts/DeleteShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      if (!(error instanceof HostError && error.code === "not_found")) {
```

заменить на

<!-- prettier-ignore -->
```tsx
      if (error !== undefined) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx -t "already gone"`
Expected: FAIL — «office shifts: deleting a planned shift > takes a shift already gone as deleted» — `TestingLibraryElementError: Unable to find an element with the text: Смена OCT26-005 удалена.`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — причина закрытия считается zod-овскими `min`/`max` (единицы UTF-16). В `apps/standalone/src/office/shifts/CloseShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
const closeSchema = z.object({ reason: closeReasonRule });
```

заменить на

<!-- prettier-ignore -->
```tsx
const closeSchema = z.object({
  reason: z.string().trim().min(3, "rules.closeReason").max(500, "rules.closeReason"),
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx -t "two emoji are too short"`
Expected: FAIL — «office shifts: closing an active shift > counts the reason in characters as the host does: two emoji are too short, three are enough» — `TestingLibraryElementError: Unable to find an accessible element with the role "dialog" and name "Закрыть смену OCT26-004"`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — отказ хоста на `reason` не идёт под поле. В `apps/standalone/src/office/shifts/CloseShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        reason: { field: "reason", message: "rules.closeReason" },
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx -t "refusal of the reason"`
Expected: FAIL — «office shifts: closing an active shift > puts the host's refusal of the reason under it» — `AssertionError: expected 'От 3 до 500 символов. Её увидят в спи…' to be 'Опишите причину: от 3 до 500 символов' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — закрытие — без варианта `destructive`. В `apps/standalone/src/office/shifts/CloseShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      submitVariant="destructive"
```

заменить на

<!-- prettier-ignore -->
```tsx
      submitVariant="primary"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx -t "sends it trimmed"`
Expected: FAIL — «office shifts: closing an active shift > asks for the reason in words and sends it trimmed with the loaded revision, then says so» — `AssertionError: expected 'mk-btn mk-btn--primary mk-btn--md' to contain 'mk-btn--destructive'`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/shifts apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/shift-delete-close.test.tsx apps/standalone/test/shift-edit.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 75 файлов, 1864 теста (1853 + 11).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/shifts/DeleteShiftDialog.tsx apps/standalone/src/office/shifts/CloseShiftDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/shift-delete-close.test.tsx apps/standalone/test/shift-edit.test.tsx
git commit -m "feat(standalone): the office deletes a planned shift and closes an active one with its reason" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Мелочи офиса из очереди ревью — счётчик SSCC без номеров, похожий табельный номер, смена станции при переводе

Три независимые правки, каждая со своим тестом.

- Пункт 22 очереди 2a1. Хост сдвигает счётчик за последний номер, выдавая последний блок (`nextSerial` = `maxSerial` + 1), а затем отвечает `sscc_exhausted`. Страница «SSCC» показывала 10 000 000 «следующим номером» и предлагала окно, в котором ни одно число не проходит (`min` больше `max`). Теперь такой счётчик (`isExhausted`, рядом с `counterKindKey`) показывает в колонке «Следующий номер» тег «Номера закончились» (фаза `attention`), а кнопки «Изменить» у него нет. Счётчик ровно на последнем номере (9 999 999) ещё может его выдать и показывается как прежде — тест держит обе стороны.
- Пункт 23 очереди 2a1. Хост отвергает табельный номер, который отличается от существующего только ведущими нулями, ответом `conflict` на `login` с `details.similarLogin`. Форма нового оператора говорила «уже занят»; теперь она называет номер, который мешает: «Похож на занятый табельный номер 0042: …» (`similarLogin` в `operator-forms.ts` и подстановка в сообщение под полем). Хост отвечает тем же кодом и для того же самого номера (тогда `similarLogin` равен набранному) — это по-прежнему «уже занят».
- Вопрос В9, вариант А с предупреждением. Диалог «Устройства» станции читает список смен хоста при открытии (`officeKeys.shiftList(null)`, только для станции) и, когда для станции, у которой есть активная смена (`stationShift`: активная смена, которую она открыла), выбрана другая линия, говорит, что станет со сменой. Перевод не запрещается; список не загрузился — предупреждения нет.

**Files:**

- Create: `apps/standalone/src/office/devices/station-shift.ts`
- Modify: `apps/standalone/src/office/sscc/SsccPage.tsx`, `apps/standalone/src/office/sscc/counter-kind.ts`, `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`, `apps/standalone/src/office/operators/operator-forms.ts`, `apps/standalone/src/office/devices/DeviceDialog.tsx`, `apps/standalone/src/i18n/ru.json`
- Test (Modify): `apps/standalone/test/sscc-page.test.tsx`, `apps/standalone/test/operators-page.test.tsx`, `apps/standalone/test/devices-page.test.tsx`

**Interfaces:**

- Consumes: `officeKeys.shiftList`, `listShifts`, `OfficeShift` (задачи 1, 3); фикстуры `ACTIVE`, `CLOSED`, `PLANNED` (`test/support/shifts.ts`).
- Produces: `isExhausted(counter: Pick<SsccCounter, "nextSerial" | "maxSerial">): boolean` (`src/office/sscc/counter-kind.ts`); `similarLogin(error: unknown, login: string): string | null` (`src/office/operators/operator-forms.ts`); `stationShift(shifts, deviceId): OfficeShift | undefined` (`src/office/devices/station-shift.ts`); ключи `office.sscc.exhausted`, `office.operators.errors.loginSimilar`, `office.devices.shiftOnStation`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { DeviceRecord, OfficeLine, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { stationShift } from "../src/office/devices/station-shift.js";
import type { DeviceRecord, OfficeLine, PairingCode } from "../src/host/protocol.js";
import { LINE_ID } from "./support/fixtures.js";
import { ACTIVE, CLOSED, PLANNED } from "./support/shifts.js";
```

2. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(names()).toEqual(["Станция 1", "Станция упаковки", "Офис бухгалтерии", "Старый ТСД"]);
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(names()).toEqual(["Станция 1", "Станция упаковки", "Офис бухгалтерии", "Старый ТСД"]);
  });

  it("says what happens to a station's active shift once another line is chosen, and still moves it", async () => {
    const session = adminSession();
    const other = LINES[2];
    if (!other) throw new Error("no second line");
    session.api.listShifts.mockResolvedValue([{ ...ACTIVE, ownerDeviceId: HOST_PC.id }]);
    session.api.updateDevice.mockResolvedValue({ ...HOST_PC, lineId: other.id });
    await openDevices(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить устройство «Рабочее место хоста»" }),
    );
    const warning =
      "На станции идёт смена OCT26-004. После перевода станция доделает начатую работу, выведет оператора и покажет смены новой линии; смена останется открытой, закрыть её можно на странице «Смены».";
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenCalledWith("office-session-token"),
    );
    expect(within(dialog()).queryByText(warning)).toBeNull();
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: other.id } });
    expect(await within(dialog()).findByText(warning)).toBeTruthy();
    // Back on its own line: nothing happens to the shift.
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: LINE_ID } });
    expect(within(dialog()).queryByText(warning)).toBeNull();
    fireEvent.change(screen.getByLabelText("Линия"), { target: { value: other.id } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
  });
```

3. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a station's shift", () => {
  it("is the active shift it opened, never a planned one, a closed one or another station's", () => {
    const station = HOST_PC.id;
    const elsewhere = "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e";
    const running = { ...ACTIVE, ownerDeviceId: station };
    expect(stationShift([running], station)).toBe(running);
    expect(
      stationShift(
        [
          { ...ACTIVE, ownerDeviceId: elsewhere },
          { ...CLOSED, ownerDeviceId: station },
          { ...PLANNED, ownerDeviceId: null },
        ],
        station,
      ),
    ).toBeUndefined();
    expect(stationShift(undefined, station)).toBeUndefined();
  });
});
```

4. В `apps/standalone/test/operators-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  });

  it("says under the PIN when the host refuses its hash in a new operator", async () => {
    const session = adminSession();
```

заменить на

<!-- prettier-ignore -->
```tsx
  });

  it("names the number in the way when the host refuses one that differs from it only by leading zeros", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(
      refusal("conflict", { constraint: "login", similarLogin: "0042" }),
    );
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Табельный номер", " 042 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText(
      "Похож на занятый табельный номер 0042: номера, которые отличаются только нулями в начале, легко перепутать",
    );
    expect(screen.getByLabelText("Табельный номер").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says a number is taken when the number the host names is the one typed", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(
      refusal("conflict", { constraint: "login", similarLogin: "0043" }),
    );
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Этот табельный номер уже занят")).toBeTruthy();
  });

  it("says under the PIN when the host refuses its hash in a new operator", async () => {
    const session = adminSession();
```

5. В `apps/standalone/test/sscc-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("says a counter past its last serial has run out and offers no change of it, while one at its last serial still has it", async () => {
    const session = fakeOfficeSession();
    // The host moved the current box counter past 9 999 999 with its last block;
    // the pallet counter is at its last serial, which it can still give.
    session.api.getSscc.mockResolvedValue({
      ...SSCC_STATE,
      counters: SSCC_STATE.counters.map((counter) =>
        counter.issuerPrefix !== "460709100"
          ? counter
          : { ...counter, nextSerial: counter.extension === 0 ? 10_000_000 : 9_999_999 },
      ),
    });
    await openSscc(session);
    const [boxes, pallets] = await counterRows();
    if (boxes === undefined || pallets === undefined) throw new Error("no rows");
    expect(within(boxes).getAllByRole("cell")[2]?.textContent).toBe("!Номера закончились");
    expect(within(boxes).queryByRole("button")).toBeNull();
    expect(screen.queryByText("10000000")).toBeNull();
    expect(within(pallets).getAllByRole("cell")[2]?.textContent).toBe("9999999");
    expect(
      within(pallets).getByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460709100" }),
    ).toBeTruthy();
  });
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx test/operators-page.test.tsx test/devices-page.test.tsx`
Expected: FAIL — `test/devices-page.test.tsx` не загружается (`Failed to resolve import "../src/office/devices/station-shift.js"`); в `test/sscc-page.test.tsx` — «says a counter past its last serial has run out…» (`expected '10000000' to be '!Номера закончились'`); в `test/operators-page.test.tsx` — «names the number in the way…» (`Unable to find an element with the text: Похож на занятый табельный номер 0042: …`). «says a number is taken when the number the host names is the one typed» проходит и до правки: он сторожит, чтобы новая подпись не заменила «уже занят» для того же номера.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "noCounters": "Счётчиков пока нет.",
      "table": {
```

заменить на

<!-- prettier-ignore -->
```json
      "noCounters": "Счётчиков пока нет.",
      "exhausted": "Номера закончились",
      "table": {
```

2. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "loginTaken": "Этот табельный номер уже занят"
```

заменить на

<!-- prettier-ignore -->
```json
        "loginTaken": "Этот табельный номер уже занят",
        "loginSimilar": "Похож на занятый табельный номер {{similar}}: номера, которые отличаются только нулями в начале, легко перепутать"
```

3. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "noLine": "Не выбрана",
      "revokeTitle": "Отозвать устройство?",
```

заменить на

<!-- prettier-ignore -->
```json
      "noLine": "Не выбрана",
      "shiftOnStation": "На станции идёт смена {{number}}. После перевода станция доделает начатую работу, выведет оператора и покажет смены новой линии; смена останется открытой, закрыть её можно на странице «Смены».",
      "revokeTitle": "Отозвать устройство?",
```

4. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { lineLabel } from "./line-label.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { lineLabel } from "./line-label.js";
import { stationShift } from "./station-shift.js";
```

5. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * been archived since, and keeping it sends nothing for the line.
```

заменить на

<!-- prettier-ignore -->
```tsx
 * been archived since, and keeping it sends nothing for the line. A station
 * with an active shift may move (owner question В9, option А): the dialog
 * says what happens to the shift once another line is chosen, by the host's
 * list of shifts, read when the dialog opens.
```

6. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: DeviceFields) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token), {
    enabled: device.kind === "station",
  });
  const running = stationShift(shifts.data, device.id);
  const save = useOfficeMutation((api, token, values: DeviceFields) =>
```

7. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    setError,
    formState: { errors, isDirty },
```

заменить на

<!-- prettier-ignore -->
```tsx
    setError,
    watch,
    formState: { errors, isDirty },
```

8. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    defaultValues: { name: device.name, lineId: device.lineId ?? "" },
  });

  const options: { value: string; label: string }[] = [
```

заменить на

<!-- prettier-ignore -->
```tsx
    defaultValues: { name: device.name, lineId: device.lineId ?? "" },
  });
  const moving = watch("lineId") !== (device.lineId ?? "");

  const options: { value: string; label: string }[] = [
```

9. В `apps/standalone/src/office/devices/DeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      )}
    </FormDialog>
```

заменить на

<!-- prettier-ignore -->
```tsx
      )}
      <div aria-live="polite">
        {running !== undefined && moving && (
          <p className="office-note">
            {t("office.devices.shiftOnStation", { number: running.number })}
          </p>
        )}
      </div>
    </FormDialog>
```

10. Создать `apps/standalone/src/office/devices/station-shift.ts`:

<!-- prettier-ignore -->
```ts
import type { OfficeShift } from "../../host/protocol.js";

/**
 * The shift a station works on: the active one it opened (`ownerDeviceId`;
 * stage 2a puts one device on a shift). A planned shift is nobody's yet and a
 * closed one is over; `undefined` while the list is not loaded.
 */
export function stationShift(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): OfficeShift | undefined {
  return shifts?.find((shift) => shift.status === "active" && shift.ownerDeviceId === deviceId);
}
```

11. В `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { newOperatorSchema, type NewOperatorValues } from "./operator-forms.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { newOperatorSchema, similarLogin, type NewOperatorValues } from "./operator-forms.js";
```

12. В `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const create = useOfficeMutation((api, token, body: OperatorCreate) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The number in the way when the host refused one that differs only by leading zeros.
  const [similar, setSimilar] = useState<string | null>(null);
  const create = useOfficeMutation((api, token, body: OperatorCreate) =>
```

13. В `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
```

заменить на

<!-- prettier-ignore -->
```tsx
    } catch (error) {
      const near = similarLogin(error, values.login);
      if (near !== null) {
        setSimilar(near);
        setError("login", { type: "server", message: "office.operators.errors.loginSimilar" });
        return;
      }
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
```

14. В `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        {...fieldError(errors.login?.message)}
```

заменить на

<!-- prettier-ignore -->
```tsx
        {...fieldError(errors.login?.message, similar === null ? undefined : { similar })}
```

15. В `apps/standalone/src/office/operators/operator-forms.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { operatorLoginRule, operatorRoleRule, personNameRule, pinRule } from "../../lib/rules.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { HostError } from "../../host/client.js";

import { operatorLoginRule, operatorRoleRule, personNameRule, pinRule } from "../../lib/rules.js";
```

16. В `apps/standalone/src/office/operators/operator-forms.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export type PinFormValues = z.input<typeof pinFormSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
export type PinFormValues = z.input<typeof pinFormSchema>;

/**
 * The personnel number the host named as similar when it refused `login`
 * (`conflict` on `login` with `details.similarLogin`, plan 2a1): one that
 * differs from it only by leading zeros, which a keypad mixes up. `null` when
 * the refusal is something else, or names the same number, which is simply
 * taken.
 */
export function similarLogin(error: unknown, login: string): string | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "login") return null;
  const similar = error.details.similarLogin;
  return typeof similar === "string" && similar !== login.trim() ? similar : null;
}
```

17. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  PageHeader,
  Table,
```

заменить на

<!-- prettier-ignore -->
```tsx
  PageHeader,
  StatusChip,
  Table,
```

18. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { counterKindKey } from "./counter-kind.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { counterKindKey, isExhausted } from "./counter-kind.js";
```

19. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      render: (counter) => String(counter.nextSerial),
```

заменить на

<!-- prettier-ignore -->
```tsx
      // A counter past its last serial (`sscc_exhausted` once a block is asked for)
      // has no next number to show or to set.
      render: (counter) =>
        isExhausted(counter) ? (
          <StatusChip phase="attention" label={t("office.sscc.exhausted")} />
        ) : (
          String(counter.nextSerial)
        ),
```

20. В `apps/standalone/src/office/sscc/SsccPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      render: (counter) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.sscc.editNamed", {
            kind: kindOf(counter),
            prefix: counter.issuerPrefix,
          })}
          onClick={() => {
            setSaved(null);
            setEditing(counter);
          }}
        >
          {t("office.sscc.edit")}
        </Button>
      ),
```

заменить на

<!-- prettier-ignore -->
```tsx
      render: (counter) =>
        isExhausted(counter) ? null : (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.sscc.editNamed", {
              kind: kindOf(counter),
              prefix: counter.issuerPrefix,
            })}
            onClick={() => {
              setSaved(null);
              setEditing(counter);
            }}
          >
            {t("office.sscc.edit")}
          </Button>
        ),
```

21. В `apps/standalone/src/office/sscc/counter-kind.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { SsccCounter } from "../../host/protocol.js";

/** The i18n key naming what a counter numbers: extension 0 boxes, 1 pallets. */
```

заменить на

<!-- prettier-ignore -->
```ts
import type { SsccCounter } from "../../host/protocol.js";

/**
 * Whether a counter has no serial left: the host moves it past its last
 * serial when it issues the last block (`nextSerial` = `maxSerial` + 1), and
 * then answers `sscc_exhausted`. Nothing can move it on.
 */
export function isExhausted(counter: Pick<SsccCounter, "nextSerial" | "maxSerial">): boolean {
  return counter.nextSerial > counter.maxSerial;
}

/** The i18n key naming what a counter numbers: extension 0 boxes, 1 pallets. */
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx test/operators-page.test.tsx test/devices-page.test.tsx --reporter=verbose`
Expected: PASS — 3 файла, 63 теста (`sscc-page` 11, `operators-page` 21, `devices-page` 31); stderr пуст. Затем те же файлы — под стендом с задержкой `setImmediate`: PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — счётчик на последнем номере считается исчерпанным. В `apps/standalone/src/office/sscc/counter-kind.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return counter.nextSerial > counter.maxSerial;
```

заменить на

<!-- prettier-ignore -->
```ts
  return counter.nextSerial >= counter.maxSerial;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx -t "past its last serial"`
Expected: FAIL — «SSCC page > says a counter past its last serial has run out and offers no change of it, while one at its last serial still has it» — `AssertionError: expected '!Номера закончились' to be '9999999' // Object.is equality`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — исчерпанный счётчик предлагает «Изменить». В `apps/standalone/src/office/sscc/SsccPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        isExhausted(counter) ? null : (
          <Button
```

заменить на

<!-- prettier-ignore -->
```tsx
        false ? null : (
          <Button
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx -t "past its last serial"`
Expected: FAIL — «SSCC page > says a counter past its last serial has run out and offers no change of it, while one at its last serial still has it» — `AssertionError: expected <button type="button" …(3)></button> to be null`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — тот же номер называется «похожим», а не «занятым». В `apps/standalone/src/office/operators/operator-forms.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return typeof similar === "string" && similar !== login.trim() ? similar : null;
```

заменить на

<!-- prettier-ignore -->
```ts
  return typeof similar === "string" ? similar : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx -t "the one typed"`
Expected: FAIL — «office operators > says a number is taken when the number the host names is the one typed» — `TestingLibraryElementError: Unable to find an element with the text: Этот табельный номер уже занят`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — смена станции — и закрытая. В `apps/standalone/src/office/devices/station-shift.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return shifts?.find((shift) => shift.status === "active" && shift.ownerDeviceId === deviceId);
```

заменить на

<!-- prettier-ignore -->
```ts
  return shifts?.find((shift) => shift.ownerDeviceId === deviceId);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx -t "is the active shift it opened"`
Expected: FAIL — «a station's shift > is the active shift it opened, never a planned one, a closed one or another station's» — `AssertionError: expected { …(21) } to be undefined`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 5 — предупреждение показывается и без выбора другой линии. В `apps/standalone/src/office/devices/DeviceDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        {running !== undefined && moving && (
```

заменить на

<!-- prettier-ignore -->
```tsx
        {running !== undefined && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx -t "once another line is chosen"`
Expected: FAIL — «office devices > says what happens to a station's active shift once another line is chosen, and still moves it» — `AssertionError: expected <p class="office-note"></p> to be null`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/sscc apps/standalone/src/office/operators apps/standalone/src/office/devices apps/standalone/src/i18n/ru.json apps/standalone/test/sscc-page.test.tsx apps/standalone/test/operators-page.test.tsx apps/standalone/test/devices-page.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 75 файлов, 1869 тестов (1864 + 5).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/devices/station-shift.ts apps/standalone/src/office/sscc/SsccPage.tsx apps/standalone/src/office/sscc/counter-kind.ts apps/standalone/src/office/operators/CreateOperatorDialog.tsx apps/standalone/src/office/operators/operator-forms.ts apps/standalone/src/office/devices/DeviceDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/sscc-page.test.tsx apps/standalone/test/operators-page.test.tsx apps/standalone/test/devices-page.test.tsx
git commit -m "feat(standalone): an exhausted SSCC counter, a similar personnel number and a station's shift in the office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Документы — «Смены» в `AGENTS.md` и §16 спецификации

Решения плана записываются туда, где их прочтёт следующий агент: в `AGENTS.md` — пункт «Смены» в «Office pages» (что показывает страница, как называет записи, пометки, отбор, период и его предел, окна и отказы), предложение о построителях смен в «Protocol», похожий номер в «Operators and badges», предупреждение о смене в пункте «Устройства», ссылка на страницу и предел периода в «Shifts», счётчик без номеров в абзаце о блоках SSCC, ручная проверка в «Verification»; в спецификации этапа 2a — §16 «Уточнения плана 2a3». Кода нет.

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`

- [ ] **Step 1: Правки документов**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
with `similarLogin`, the number in the way, which the office's form shows as
a taken number. The PIN rule, 4–6 ASCII digits, mirrors the
```

заменить на

<!-- prettier-ignore -->
```text
with `similarLogin`, the number in the way, which the office's form names
under the number («Похож на занятый табельный номер 0042…», `similarLogin` in
`src/office/operators/operator-forms.ts`); a `similarLogin` equal to the
number typed, or none, says the number is taken. The PIN rule, 4–6 ASCII digits, mirrors the
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
the whole document.
The older forms (users, the organization, SSCC, sign-in and the own-password
```

заменить на

<!-- prettier-ignore -->
```text
the whole document.
The shifts' builders (plan 2a3): `shiftCreate` sends every field, `null` for
no plan or no counterparty, and `mode: "aggregation"` and
`palletsEnabled: false`, so the host's defaults never decide what was
planned; `shiftUpdate` sends what differs from the loaded shift with its
revision, `null` clearing only the plan and the counterparty (the host reads
`null` elsewhere as «keep», and `shiftUpdateSchema` refuses it there);
`shiftClose` sends the trimmed reason with the loaded revision.
The older forms (users, the organization, SSCC, sign-in and the own-password
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  current line stays on the list even when archived. A revoked device is a
```

заменить на

<!-- prettier-ignore -->
```text
  current line stays on the list even when archived. A station that works on
  an active shift (`stationShift`: the active shift it opened, by
  `GET /v1/office/shifts` read when the dialog opens) may move all the same
  (owner question В9, option А), and once another line is chosen the dialog
  says that the station finishes its work, signs the operator out and shows
  the new line's shifts, and that the shift stays open, to be closed on
  «Смены». A revoked device is a
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  its own, since a change of the organization's profile moves the document's
  revision too, and the reload drops the edits.

## Shifts
```

заменить на

<!-- prettier-ignore -->
```text
  its own, since a change of the organization's profile moves the document's
  revision too, and the reload drops the edits.
- «Смены» (plan 2a3; section «Производство», right after «Линии») lists what
  `GET /v1/office/shifts` sends, in the host's order, and every role reads it:
  the number, the production date (`08.10.2026`), the line, the product with
  «для: …» and the counterparty under it, the mode as a word on its category
  tag (the cloud's tones: aggregation teal, validation violet), the plan («—»
  for none; thousands apart by a no-break space) and the status as a phase
  (a closed shift as done). A shift carries ids: the page names them
  from `listProducts`, `listLines` and `listCounterparties`, an archived record
  marked «(в архиве)», and one a list lacks or that did not load by the first
  eight characters of its id («Товар 5e6f7081…»); a lookup that fails leaves
  the list in place with one warning and «Повторить», which reads again only
  what failed. A planned shift a station will refuse to open is marked by the
  page's own lists (`openBlocker`): its product archived or a draft
  (`product_inactive`), or its template switched off, narrowed or of another
  group (`template_not_fit`, `templateFitsSlot` for the product's group); while
  a list it needs is not loaded nothing is claimed. A closed shift says why:
  the office's words («Закрыта в офисе: …») or a station's code in words
  («Причина расхождения: …»; a code a newer host adds is shown as it is); late
  data is an attention tag. The search (number or product name, without case),
  the status and the line filters and the pages of 25 work in the page; a new
  search or filter goes back to the first page. Without a period the page
  shows the host's own list and says what it holds; two date fields ask for a
  period of production dates, both ends included, only once both are set, the
  period does not end before it starts and is at most 366 days
  (`MAX_PERIOD_DAYS`, which bounds what one request reads); meanwhile the
  list shown stays and a note says why. Both roles plan and change shifts
  (`useCan("planShifts")`). «Запланировать смену» opens a dialog that waits
  for the organization's profile and starts the production date as today in
  its time zone (`civilToday`; this PC's date, said in words, when the profile
  does not load). The product offers what is in use (active, not archived) by
  name with its GTIN, and choosing one sets the box capacity and the template
  from it (`suggestBoxTemplate`: the product's preference, the category's box
  default, the organization's, the first that fits; none — the person
  chooses); the template offers what fits the product's group and has no «Не
  выбран»; the line offers active lines; the counterparty is optional. A row's
  actions follow its status: a planned shift «Изменить» (the same dialog
  without the product, which never changes; its own line, counterparty and
  template stay marked choices when archived, switched off or narrowed, and
  only what differs goes, `shiftUpdate`) and «Удалить» (asks first,
  `destructive`; a `not_found` is taken as deleted); an active shift «Изменить
  план» (the plan alone, blank clears it) and «Закрыть» (`destructive`, a
  reason of 3–500 characters counted as the host counts them, `closeReasonRule`,
  sent trimmed with the loaded revision); a closed shift nothing. Every write
  sends the opened row's revision; a saved write says so and reads every list
  of shifts again (`officeKeys.shifts`, whatever the period). `stale_revision`
  offers «Загрузить заново», which closes the dialog and reads the list again;
  a shift opened, closed or deleted meanwhile (`shift_status` with its
  `details.status`, `not_found`) is an alert in words of its own
  (`shiftWriteFailure`) and the list is read again behind the dialog; a record
  refused on a select (`product_inactive`, `validation_failed` on `lineId`,
  `boxTemplateId`, `counterpartyId`) goes under it, and a refused template
  reads the templates again, so it shows marked. The date fields are
  `@markiro/ui`'s `DatePicker`, run only under jsdom (see «Verification»).

## Shifts
```

5. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
from its own lists.
```

заменить на

<!-- prettier-ignore -->
```text
from its own lists. The office's page is «Смены» (plan 2a3, «Office pages»);
it bounds a period to 366 days, since the host's list has no paging.
```

6. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
blocks and showing them per device with plan 2b.
```

заменить на

<!-- prettier-ignore -->
```text
blocks and showing them per device with plan 2b. A counter the last block
moved past its last serial (`nextSerial` above `maxSerial`) shows on the
office's «SSCC» page as «Номера закончились», with no change offered: no
number could be valid there (`isExhausted`, `src/office/sscc/counter-kind.ts`).
```

7. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
    keyboard for typing a name).
```

заменить на

<!-- prettier-ignore -->
```text
    keyboard for typing a name).
- The office's «Смены» (plan 2a3) has run only under jsdom, against a fake
  `HostApi`; never run: the `DatePicker` calendar inside a dialog in WebView2
  and in the locked window, the organization's time zone of a real profile
  for «today», a shift planned in the office and opened by a real station, and
  the list against a host with months of shifts.
```

8. Дописать в конец `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — после последней строки файла, через одну пустую строку — раздел ниже. Его номер — следующий свободный: 16, если до плана 2a3 спецификацию не дописали другие планы этапа; план 2a4 дописывает свой раздел «Уточнения плана 2a4», и если он исполнен раньше, этот раздел — 17-й (и «§16» в этом плане читается с новым номером, который записывается в «Отклонения при исполнении»):

<!-- prettier-ignore -->
```text
## 16. Уточнения плана 2a3

План `docs/superpowers/plans/2026-10-09-standalone-2a3-office-shifts.md` (офис) уточняет §5.6, §6
и строку 2a3 раздела 8 так; вопросы раздела 11 по-прежнему решены рекомендованными вариантами.

- Список хоста не несёт итогов, поэтому строка списка показывает план, а не «принято единиц и
  коробов»: итоги — окно «Итоги» строки активной и закрытой смены (`GET /v1/office/shifts/{id}`),
  задача 9 плана 2a3, после плана 2a2.
- Период — два поля дат производства; запрос уходит, только когда заданы обе, конец не раньше
  начала и период не длиннее 366 дней с обоими концами (`MAX_PERIOD_DAYS`): список хоста не
  постраничный, а предел ограничивает то, что читает один запрос. Без периода — список хоста по
  умолчанию, и страница говорит, что в нём. Поиск, отбор по статусу и линии и страницы по 25
  работают в странице.
- Запланированная смена, которую станция не откроет, помечается по спискам офиса: товар в архиве
  или черновик, шаблон выключен, сужен или не той группы. Пока нужный список не загружен,
  пометки нет. Архивная линия открытию не мешает и не помечается.
- «Сегодня» новой смены — по часовому поясу организации (`civilToday`); профиль не загрузился —
  дата этого ПК, и окно это говорит. Выбор товара ставит вместимость и шаблон из товара
  (`suggestBoxTemplate`, общий с новой сменой на станции в плане 2a5).
- Правка запланированной смены шлёт только изменённое; её линия, контрагент и шаблон остаются
  выбором с пометкой, если их убрали в архив, выключили или сузили. У активной смены — отдельное
  окно «Изменить план». Удаление, получившее `not_found`, считается состоявшимся.
- `shift_status` и `not_found` на записи — предупреждение своими словами и перечитывание списка
  за окном; `stale_revision` — «Загрузить заново». Причина закрытия считается в кодовых точках,
  как на хосте (`closeReasonRule`).
- Попутно: счётчик SSCC за последним номером (`nextSerial` больше `maxSerial`) на странице «SSCC» —
  «Номера закончились» без окна изменения; форма оператора называет похожий табельный номер из
  `details.similarLogin`; диалог «Устройства» при выборе другой линии для станции с активной
  сменой говорит, что станет со сменой (вопрос В9, вариант А с предупреждением), и перевод не
  запрещает.
```

- [ ] **Step 2: Сверка**

Перечитать в `AGENTS.md` пункты «Смены» и «Устройства» раздела «Office pages», абзацы «Protocol» о построителях, «Operators and badges» о похожем номере, «Shifts» об офисе и блоках SSCC и последний пункт «Verification»; в спецификации — §16 целиком. Каждое утверждение — о коде задач 1–7: имена (`openBlocker`, `periodState`, `MAX_PERIOD_DAYS`, `suggestBoxTemplate`, `civilToday`, `shiftWriteFailure`, `closeReasonRule`, `isExhausted`, `similarLogin`, `stationShift`) — те, что в коде; окно «Итоги» упомянуто только как работа задачи 9.

- [ ] **Step 3: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "docs(standalone): the office's shifts in AGENTS.md and the stage 2a spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Итоги смены (после плана 2a2)

**Исполняется после плана 2a2.** План 2a2 (хост: факты) добавляет итоги в `GET /v1/office/shifts/{id}`; на момент написания этого плана план 2a2 ещё не написан и не исполнен, поэтому задача написана по описанию спецификации (§4.5: «принято единиц — позиции без `removed_at` и `displaced_at`; коробов закрыто — закрытые без `disassembled_at`; открыто коробов; время последнего факта; устройства смены»). Предполагаемая форма — поле `totals` с `acceptedUnits`, `closedBoxes`, `openBoxes`, `lastFactAt` (UTC RFC 3339 или `null`) и `deviceIds`, и фикстура ответа `proto/fixtures/office-shift-detail.json`.

Окно «Итоги» строки активной и закрытой смены видят обе роли (читать смены могут все): колонка действий теперь есть всегда, а кнопки записи по-прежнему закрыты `planShifts`. Окно читает смену при каждом открытии (`officeKeys.shift(id)`, `staleTime` 0) и показывает план, принято единиц, закрыто и открыто коробов, время последних данных (по часовому поясу организации, как «сегодня» в задаче 4; профиль не загрузился — по часам этого ПК) и число устройств (их имена читает только администратор). Не загрузилось — ошибка с «Повторить». Полная карточка смены — этап 4.

- [ ] **Step 0: Сверка с контрактом плана 2a2**

Открыть `docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md`, раздел «Контракт для 2a3 и 2a6», и `proto/src/lib.rs` после его исполнения. Сверить:

1. имя поля итогов в ответе `GET /v1/office/shifts/{id}` (здесь — `totals`) и имена и типы его полей (здесь — `acceptedUnits`, `closedBoxes`, `openBoxes`: целые неотрицательные; `lastFactAt`: время или `null`; `deviceIds`: UUID);
2. имя фикстуры этого ответа (здесь — `proto/fixtures/office-shift-detail.json`; её содержимое по этому плану — ниже).

Если план 2a2 назвал иначе — заменить имена во всех блоках этой задачи (схема, тесты, окно, тексты не меняются) и записать замену в «Отклонения при исполнении». Если контракт дал полям другой смысл (например, итоги только у закрытой смены) или фикстуры ответа нет — остановиться и спросить контролёра: создавать фикстуру `proto` этот план не вправе. Ожидаемое содержимое фикстуры (то, на котором задача проверена на копии):

<!-- prettier-ignore -->
```json
{
  "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "number": "OCT26-004",
  "status": "active",
  "mode": "aggregation",
  "palletsEnabled": false,
  "createdFrom": "office",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "counterpartyId": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  "productionDate": "2026-10-08",
  "plannedQty": 1200,
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
  "closedAt": null,
  "closeReasonCode": null,
  "closeReasonText": null,
  "lateDataAt": null,
  "createdAt": "2026-10-07T15:30:00Z",
  "rev": 71,
  "totals": {
    "acceptedUnits": 1150,
    "closedBoxes": 95,
    "openBoxes": 1,
    "lastFactAt": "2026-10-08T14:30:00Z",
    "deviceIds": ["7c9e6679-7425-40de-944b-e07fc1f90ae7"]
  }
}
```

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  [
    "createShift",
```

заменить на

<!-- prettier-ignore -->
```ts
  [
    "getShift",
    fixture("office-shift-detail.json"),
    (api) => api.getShift(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "createShift",
```

2. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  officeSessionSchema,
  officeShiftSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  officeSessionSchema,
  officeShiftDetailSchema,
  officeShiftSchema,
```

3. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["error-sscc-exhausted.json", errorBodySchema],
  ["office-shift-detail.json", officeShiftDetailSchema],
] as const;
```

4. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });

  it("read the refusals of a busy shift and of a prefix with no serials left", () => {
    expect(errorBodySchema.parse(fixture("error-shift-busy.json")).error).toMatchObject({
```

заменить на

<!-- prettier-ignore -->
```ts
  });

  it("read a shift's figures, with no fact yet, and refuse a count that is no whole number or a device that is no UUID", () => {
    const detail = officeShiftDetailSchema.parse(fixture("office-shift-detail.json"));
    const none = {
      ...detail,
      totals: { acceptedUnits: 0, closedBoxes: 0, openBoxes: 0, lastFactAt: null, deviceIds: [] },
    };
    expect(officeShiftDetailSchema.parse(none)).toEqual(none);
    for (const totals of [
      { acceptedUnits: -1 },
      { closedBoxes: 1.5 },
      { openBoxes: "1" },
      { lastFactAt: "yesterday" },
      { deviceIds: ["42"] },
    ]) {
      const result = officeShiftDetailSchema.safeParse({
        ...detail,
        totals: { ...detail.totals, ...totals },
      });
      expect(result.success, JSON.stringify(totals)).toBe(false);
    }
    // A shift without its figures is the list's, not the one shift's answer.
    const listed = Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "totals"));
    expect(officeShiftDetailSchema.safeParse(listed).success).toBe(false);
  });

  it("read the refusals of a busy shift and of a prefix with no serials left", () => {
    expect(errorBodySchema.parse(fixture("error-shift-busy.json")).error).toMatchObject({
```

5. В `apps/standalone/test/shift-edit.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  it("offers a planned shift's change and delete, an active one's plan and close, and nothing for a closed one, to both roles", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
  it("offers a planned shift's change and delete, an active one's figures, plan and close, and a closed one's figures alone, to both roles", async () => {
```

6. В `apps/standalone/test/shift-edit.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      ).toEqual(["Изменить план смены OCT26-004", "Закрыть смену OCT26-004"]);
      expect(within(shiftRow(CLOSED.number)).queryAllByRole("button")).toEqual([]);
```

заменить на

<!-- prettier-ignore -->
```tsx
      ).toEqual([
        "Итоги смены OCT26-004",
        "Изменить план смены OCT26-004",
        "Закрыть смену OCT26-004",
      ]);
      expect(
        within(shiftRow(CLOSED.number))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Итоги смены OCT26-001/S"]);
```

7. Создать `apps/standalone/test/shift-totals.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShiftDetail } from "../src/host/protocol.js";
import { ORG_PROFILE, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  CLOSED,
  freezeToday,
  openShifts,
  shiftRow,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";

/** The active shift's figures, as `office-shift-detail.json`. */
const DETAIL: OfficeShiftDetail = {
  ...ACTIVE,
  totals: {
    acceptedUnits: 1150,
    closedBoxes: 95,
    openBoxes: 1,
    lastFactAt: "2026-10-08T14:30:00Z",
    deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
  },
};

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Итоги смены OCT26-004" });
}

/** The figures as term → description. */
function figures(): Record<string, string | null> {
  const terms = within(dialog()).getAllByRole("term");
  return Object.fromEntries(
    terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? null]),
  );
}

async function openTotals(session: FakeOfficeSession): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
  await screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
}

describe("office shifts: a shift's figures", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the figures of an active and a closed shift to both roles, and none of a planned one", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(screen.getByRole("button", { name: "Итоги смены OCT26-004" })).toBeTruthy();
      expect(
        within(shiftRow(CLOSED.number)).getByRole("button", { name: "Итоги смены OCT26-001/S" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Итоги смены OCT26-005" })).toBeNull();
      view.unmount();
    }
  });

  it("reads the shift when the dialog opens and shows its figures, the last fact in the organization's time", async () => {
    const session = shiftsSession();
    // Kamchatka (UTC+12), so the organization's time is no PC's own by chance.
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    session.api.getShift.mockResolvedValue(DETAIL);
    await openTotals(session);
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(6));
    expect(session.api.getShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id);
    expect(figures()).toEqual({
      // Thousands apart by a no-break space.
      "План, шт": "1\u00a0200",
      "Принято единиц": "1\u00a0150",
      "Закрыто коробов": "95",
      "Открыто коробов": "1",
      // 14:30 UTC on 8 October is 02:30 on 9 October in Kamchatka.
      "Последние данные со станции": "09.10.2026, 02:30",
      "Устройств на смене": "1",
    });
  });

  it("says when no fact has arrived yet and when there is no plan", async () => {
    const session = shiftsSession();
    session.api.getShift.mockResolvedValue({
      ...DETAIL,
      plannedQty: null,
      totals: { acceptedUnits: 0, closedBoxes: 0, openBoxes: 0, lastFactAt: null, deviceIds: [] },
    });
    await openTotals(session);
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(6));
    expect(figures()["План, шт"]).toBe("—");
    expect(figures()["Последние данные со станции"]).toBe("Данных ещё нет");
  });

  it("offers to read the figures again when they do not load, and reads them anew at every opening", async () => {
    const session = shiftsSession();
    session.api.getShift
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValue(DETAIL);
    await openTotals(session);
    fireEvent.click(await within(dialog()).findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(within(dialog()).getAllByRole("term")).toHaveLength(6));
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Закрыть" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
    await waitFor(() => expect(session.api.getShift).toHaveBeenCalledTimes(3));
  });
});
```

8. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    listShifts: vi.fn<HostApi["listShifts"]>(() => unexpected("listShifts")),
    createShift: vi.fn<HostApi["createShift"]>(() => unexpected("createShift")),
```

заменить на

<!-- prettier-ignore -->
```tsx
    listShifts: vi.fn<HostApi["listShifts"]>(() => unexpected("listShifts")),
    getShift: vi.fn<HostApi["getShift"]>(() => unexpected("getShift")),
    createShift: vi.fn<HostApi["createShift"]>(() => unexpected("createShift")),
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals.test.tsx test/shift-edit.test.tsx test/protocol.test.ts test/api.test.ts`
Expected: FAIL — все 4 теста `test/shift-totals.test.tsx` (`Unable to find an accessible element with the role "button" and name "Итоги смены OCT26-004"`); в `test/shift-edit.test.tsx` — «offers a planned shift's change and delete, an active one's figures…»; в `test/protocol.test.ts` — три новых теста итогов (`Cannot read properties of undefined (reading 'parse')` и `'safeParse'`); в `test/api.test.ts` — «getShift sends the office token…» (`api.getShift is not a function`); остальные 261 проходят.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  officeShiftSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  officeShiftDetailSchema,
  officeShiftSchema,
```

2. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type OfficeShift,
  type OfficeUser,
```

заменить на

<!-- prettier-ignore -->
```ts
  type OfficeShift,
  type OfficeShiftDetail,
  type OfficeUser,
```

3. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  listShifts: (token: string, period?: ShiftPeriod) => Promise<OfficeShift[]>;
  createShift: (token: string, create: ShiftCreate) => Promise<OfficeShift>;
```

заменить на

<!-- prettier-ignore -->
```ts
  listShifts: (token: string, period?: ShiftPeriod) => Promise<OfficeShift[]>;
  /** One shift with its figures. */
  getShift: (token: string, id: string) => Promise<OfficeShiftDetail>;
  createShift: (token: string, create: ShiftCreate) => Promise<OfficeShift>;
```

4. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      ),
    createShift: (token, create) =>
```

заменить на

<!-- prettier-ignore -->
```ts
      ),
    getShift: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}`, {
        officeToken: token,
        schema: officeShiftDetailSchema,
      }),
    createShift: (token, create) =>
```

5. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

/**
 * A shift's figures (plan 2a2): the units taken in its boxes, neither removed
 * nor displaced; the boxes closed, not disassembled, and the boxes open; when
 * the last fact arrived; the devices that worked on it.
 */
export const shiftTotalsSchema = z.object({
  acceptedUnits: z.number().int().nonnegative(),
  closedBoxes: z.number().int().nonnegative(),
  openBoxes: z.number().int().nonnegative(),
  lastFactAt: z.iso.datetime().nullable(),
  deviceIds: z.array(z.uuid()),
});
export type ShiftTotals = z.infer<typeof shiftTotalsSchema>;

/** `GET /v1/office/shifts/{id}`: the shift with its figures. */
export const officeShiftDetailSchema = officeShiftSchema.extend({ totals: shiftTotalsSchema });
export type OfficeShiftDetail = z.infer<typeof officeShiftDetailSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

6. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "closeNamed": "Закрыть смену {{number}}",
      "createTitle": "Новая смена",
```

заменить на

<!-- prettier-ignore -->
```json
      "closeNamed": "Закрыть смену {{number}}",
      "totalsAction": "Итоги",
      "totalsNamed": "Итоги смены {{number}}",
      "createTitle": "Новая смена",
```

7. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "closed": "Смена {{number}} закрыта.",
      "productOption": "{{name}} — {{gtin}}",
```

заменить на

<!-- prettier-ignore -->
```json
      "closed": "Смена {{number}} закрыта.",
      "totals": {
        "title": "Итоги смены {{number}}",
        "plan": "План, шт",
        "accepted": "Принято единиц",
        "closedBoxes": "Закрыто коробов",
        "openBoxes": "Открыто коробов",
        "lastFact": "Последние данные со станции",
        "noFacts": "Данных ещё нет",
        "devices": "Устройств на смене"
      },
      "productOption": "{{name}} — {{gtin}}",
```

8. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  ],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
```

заменить на

<!-- prettier-ignore -->
```ts
  ],
  /** One shift with its figures (`GET /v1/office/shifts/{id}`). */
  shift: (id: string) => ["office", "shift", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
```

9. Создать `apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Button, DefinitionGrid, Modal } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";

/** Units with the thousands apart by a no-break space. */
const UNITS = new Intl.NumberFormat("ru");

export interface ShiftTotalsDialogProps {
  /** An active or a closed shift. */
  shift: OfficeShift;
  onClose: () => void;
}

/**
 * A shift's figures in numbers (stage 2a spec §5.6): read whenever the dialog
 * opens (`GET /v1/office/shifts/{id}`, never cached for a later opening as
 * fresh). The last fact's time is written in the organization's time zone, or
 * this PC's while the profile does not load. The full card of a shift (its
 * boxes, exceptions, conflicts, late and refused records) is stage 4.
 */
export function ShiftTotalsDialog({ shift, onClose }: ShiftTotalsDialogProps) {
  const { t } = useTranslation();
  const detail = useOfficeQuery(officeKeys.shift(shift.id), (api, token) =>
    api.getShift(token, shift.id),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    ...(org.isSuccess ? { timeZone: org.data.timeZone } : {}),
  });

  const body = () => {
    if (detail.isPending) return <PageLoading />;
    if (detail.isError) {
      return <LoadError error={detail.error} onRetry={() => void detail.refetch()} />;
    }
    const { plannedQty, totals } = detail.data;
    return (
      <DefinitionGrid
        items={[
          {
            id: "plan",
            term: t("office.shifts.totals.plan"),
            description: plannedQty === null ? t("office.common.none") : UNITS.format(plannedQty),
            mono: true,
          },
          {
            id: "accepted",
            term: t("office.shifts.totals.accepted"),
            description: UNITS.format(totals.acceptedUnits),
            mono: true,
          },
          {
            id: "closedBoxes",
            term: t("office.shifts.totals.closedBoxes"),
            description: UNITS.format(totals.closedBoxes),
            mono: true,
          },
          {
            id: "openBoxes",
            term: t("office.shifts.totals.openBoxes"),
            description: UNITS.format(totals.openBoxes),
            mono: true,
          },
          {
            id: "lastFact",
            term: t("office.shifts.totals.lastFact"),
            description:
              totals.lastFactAt === null
                ? t("office.shifts.totals.noFacts")
                : time.format(new Date(totals.lastFactAt)),
          },
          {
            id: "devices",
            term: t("office.shifts.totals.devices"),
            description: UNITS.format(totals.deviceIds.length),
            mono: true,
          },
        ]}
      />
    );
  };

  return (
    <Modal
      open
      title={t("office.shifts.totals.title", { number: shift.number })}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("office.common.close")}
        </Button>
      }
    >
      {body()}
    </Modal>
  );
}
```

10. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { ShiftPlanDialog } from "./ShiftPlanDialog.js";
import { datePickerTexts } from "./shift-text.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { ShiftPlanDialog } from "./ShiftPlanDialog.js";
import { ShiftTotalsDialog } from "./ShiftTotalsDialog.js";
import { datePickerTexts } from "./shift-text.js";
```

11. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  | { kind: "close"; shift: OfficeShift };
```

заменить на

<!-- prettier-ignore -->
```tsx
  | { kind: "close"; shift: OfficeShift }
  | { kind: "totals"; shift: OfficeShift };
```

12. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  if (canPlan) {
    columns.push({
      key: "actions",
      title: t("office.shifts.table.actions"),
      render: (shift) => (
        <RowActions>
          {shift.status === "planned" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.editNamed", { number: shift.number })}
                onClick={() => open({ kind: "edit", shift })}
              >
                {t("office.shifts.edit")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
                onClick={() => open({ kind: "delete", shift })}
              >
                {t("office.shifts.delete")}
              </Button>
            </>
          )}
          {shift.status === "active" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.planNamed", { number: shift.number })}
                onClick={() => open({ kind: "plan", shift })}
              >
                {t("office.shifts.plan")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.closeNamed", { number: shift.number })}
                onClick={() => open({ kind: "close", shift })}
              >
                {t("office.shifts.close")}
              </Button>
            </>
          )}
        </RowActions>
      ),
    });
  }
```

заменить на

<!-- prettier-ignore -->
```tsx
  // Every role reads a shift's figures; writing is `planShifts`.
  columns.push({
    key: "actions",
    title: t("office.shifts.table.actions"),
    render: (shift) => (
      <RowActions>
        {shift.status !== "planned" && (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.shifts.totalsNamed", { number: shift.number })}
            onClick={() => open({ kind: "totals", shift })}
          >
            {t("office.shifts.totalsAction")}
          </Button>
        )}
        {canPlan && shift.status === "planned" && (
          <>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.editNamed", { number: shift.number })}
              onClick={() => open({ kind: "edit", shift })}
            >
              {t("office.shifts.edit")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
              onClick={() => open({ kind: "delete", shift })}
            >
              {t("office.shifts.delete")}
            </Button>
          </>
        )}
        {canPlan && shift.status === "active" && (
          <>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.planNamed", { number: shift.number })}
              onClick={() => open({ kind: "plan", shift })}
            >
              {t("office.shifts.plan")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.closeNamed", { number: shift.number })}
              onClick={() => open({ kind: "close", shift })}
            >
              {t("office.shifts.close")}
            </Button>
          </>
        )}
      </RowActions>
    ),
  });
```

13. В `apps/standalone/src/office/shifts/ShiftsPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      )}
      {canPlan && dialog?.kind === "plan" && (
```

заменить на

<!-- prettier-ignore -->
```tsx
      )}
      {dialog?.kind === "totals" && (
        <ShiftTotalsDialog shift={dialog.shift} onClose={() => setDialog(null)} />
      )}
      {canPlan && dialog?.kind === "plan" && (
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals.test.tsx test/shift-edit.test.tsx test/protocol.test.ts test/api.test.ts --reporter=verbose`
Expected: PASS — 4 файла, 270 тестов; stderr пуст. Затем `test/shift-totals.test.tsx`, `test/shift-edit.test.tsx`, `test/shifts-page.test.tsx`, `test/shift-dialog.test.tsx`, `test/shift-delete-close.test.tsx` — под стендом с задержкой `setImmediate`: PASS.

- [ ] **Step 5: Мутации**

Мутация 1 — `getShift` читает не тот путь. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
      client.request("GET", `/v1/office/shifts/${id}`, {
```

заменить на

<!-- prettier-ignore -->
```ts
      client.request("GET", `/v1/office/shifts?id=${id}`, {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts -t "getShift"`
Expected: FAIL — «HostApi office endpoints > getShift sends the office token to the right route» — `AssertionError: expected [ { method: 'GET', …(3) } ] to deeply equal [ { method: 'GET', …(3) } ]`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 2 — время последних данных — без часового пояса организации. В `apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    ...(org.isSuccess ? { timeZone: org.data.timeZone } : {}),
```

заменить на

<!-- prettier-ignore -->
```tsx
    ...({}),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals.test.tsx -t "organization's time"`
Expected: FAIL — «office shifts: a shift's figures > reads the shift when the dialog opens and shows its figures, the last fact in the organization's time» — `AssertionError: expected { 'План, шт': '1 200', …(5) } to deeply equal { 'План, шт': '1 200', …(5) }`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 3 — итоги не перечитываются при новом открытии окна. В `apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const detail = useOfficeQuery(officeKeys.shift(shift.id), (api, token) =>
    api.getShift(token, shift.id),
  );
```

заменить на

<!-- prettier-ignore -->
```tsx
  const detail = useOfficeQuery(
    officeKeys.shift(shift.id),
    (api, token) => api.getShift(token, shift.id),
    { staleTime: Infinity },
  );
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals.test.tsx -t "anew at every opening"`
Expected: FAIL — «office shifts: a shift's figures > offers to read the figures again when they do not load, and reads them anew at every opening» — `AssertionError: expected "vi.fn()" to be called 3 times, but got 2 times`. Восстановить файл: `cmp` молчит, хеш прежний.

Мутация 4 — итоги только у активной смены. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        {shift.status !== "planned" && (
```

заменить на

<!-- prettier-ignore -->
```tsx
        {shift.status === "active" && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals.test.tsx -t "offers the figures"`
Expected: FAIL — «office shifts: a shift's figures > offers the figures of an active and a closed shift to both roles, and none of a planned one» — `TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Итоги смены OCT26-001/S"`. Восстановить файл: `cmp` молчит, хеш прежний.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  sent trimmed with the loaded revision); a closed shift nothing. Every write
```

заменить на

<!-- prettier-ignore -->
```text
  sent trimmed with the loaded revision); a closed shift nothing to change.
  «Итоги» on an active or a closed row, for every role, reads `GET …/{id}`
  whenever it opens (`officeKeys.shift`, `ShiftTotalsDialog`): the plan, the
  units taken, the boxes closed and open, the last fact's time in the
  organization's zone and how many devices worked on the shift; the full card
  of a shift is stage 4. Every write
```

- [ ] **Step 7: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/shifts apps/standalone/src/i18n/ru.json apps/standalone/test/shift-totals.test.tsx apps/standalone/test/shift-edit.test.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx apps/standalone/AGENTS.md`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 76 файлов, 1877 тестов (1869 + 8), если до задачи 9 не исполнены другие планы с тестами вебвью (план 2a2 их не добавляет; иначе — база перед задачей плюс 1 файл и 8 тестов).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/shift-totals.test.tsx apps/standalone/test/shift-edit.test.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx apps/standalone/AGENTS.md
git commit -m "feat(standalone): a shift's figures in the office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 76 файлов, 1877 тестов (было 67 и 1744: +9 файлов, +133 теста); если до 2a3 исполнен план 2a4, база — его итог, а прирост тот же. После задачи 8 (до задачи 9) — 75 файлов, 1869 тестов.
- [ ] `typecheck`, `lint` и `build` того же пакета — без ошибок. Сборка: главный чанк около 943 кБ (на HEAD `366e87f06` — 902 кБ; прибавка — страница «Смены», её окна и `DatePicker`); ленивые чанки прежние.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым TS, TSX, JSON, CSS и MD — чисто; `git diff --check <начало плана>..HEAD` — чисто; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`.
- [ ] Каждая новая CSS-переменная объявлена в `packages/ui/src/tokens.css`: `for v in --fg-2 --fg-3 --err-fg --text-body-sm; do grep -c -- "$v:" packages/ui/src/tokens.css; done` — у каждой не меньше 1 (светлая и тёмная темы); других переменных новые правила `shell.css` (`.shift-cell`, `.shift-cell__quiet`, `.shift-note`, `.shift-note--error`) не берут.
- [ ] Все новые и изменённые тестовые файлы плана один раз — под стендом с задержкой `setImmediate` на 3 мс (`test/{protocol,api,probe,rules,civil-date,box-template-choice,shifts-page,shift-list,operators-page,products-page,shift-dialog,shift-edit,shift-form,shift-delete-close,sscc-page,devices-page,shift-totals}.test.ts*`): PASS; стенд удалён, `git status --short` пуст.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы раздела «Файлы»; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto` и `apps/standalone/src-tauri` этим планом не менялись (фикстура итогов — плана 2a2); Rust не менялся, cargo не запускается.
- [ ] Каждый коммит плана несёт ровно одну строку `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` и никаких других трейлеров.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - страница и окна работали только под jsdom с поддельным `HostApi`: ни разу — в WebView2 (Windows) и WKWebView, в том числе календарь `DatePicker` внутри окна `Modal` и в окне киоск-режима, раскладка таблицы из восьми колонок на мониторе офиса;
  - против настоящего хоста не проверялись: смена, запланированная в офисе и открытая станцией (станция придёт в плане 2a5), ответы `shift_status`, `template_not_fit` и `not_found` на живых гонках двух рабочих мест, список с месяцами смен;
  - «сегодня» по часовому поясу настоящего профиля организации и `Intl` WebView2 (формат «08.10.2026, 17:30» и неразрывный пробел в «1 200» взяты из ICU Node);
  - задача 9 проверена на копии против фикстуры, написанной по описанию спецификации, а не против ответа хоста плана 2a2; поля сверяются шагом 0 задачи 9;
  - CI (общее задание JS с Vitest вебвью, `standalone-rust`, `standalone-windows-build`) — для него нужен push; `standalone-windows-build` по-прежнему ждёт шага владельца плана 1f2.

---

## Перенесено

- **Хост (пункт 4 очереди 2a1).** Список смен хоста не постраничный, а запрос без периода (`status <> 'closed' OR production_date >= ?`) и запрос периода не пользуются индексами `(line_id, status)` и `(status, production_date)` в полную силу. Офис ограничивает период 366 днями, но хост принимает любой; предел или страницы на стороне хоста и индекс под запрос без периода — план хоста (2b или 4) или итоговая волна 2a2.
- **Фикстура `proto/fixtures/error-with-details.json`** (пункт 9 очереди 2a1) всё ещё говорит «protocol 7 is outside 1..=1»: она общая с Rust (`proto/tests/fixtures.rs`), её правит итоговая волна плана 2a1 или следующий план хоста вместе с утверждением `test/protocol.test.ts` о её `details`.
- **Итоги смены — числа без имён устройств:** список устройств читает только администратор; имена, короба, исключения, конфликты, поздние и отклонённые записи — полная карточка смены этапа 4.
- **Возможности облачной формы смены вне 2a:** эмитент SSCC (вопрос В2, вариант Б), паллеты и их шаблон (2b), режим валидации (3), предупреждение облака о «критическом изменении активной смены» (в 2a у активной смены меняется только план, который не влияет на этикетку).
- **«Не откроется» не учитывает линию:** хост не проверяет линию при открытии (станция её линии открывает смену и в архивной линии); если владелец решит иначе — правило в `openBlocker` и хосте вместе.
- **Предупреждение «Устройства»** опирается на список хоста по умолчанию (в нём всегда все активные смены); станция, у которой хост не помнит владельца (офис закрыл смену), не предупреждается — и не должна.
- **Размер главного чанка** вырос примерно на 41 кБ; ленивая загрузка страниц офиса (как у растеризатора и редактора) — отдельное решение, если чанк станет помехой.
- **Вопросы владельцу**, допущения по которым приняты в начале плана: В1, В2, В3, В4, В6, В9, В13; при другом ответе — правки, названные там.

---

## Отклонения при исполнении
