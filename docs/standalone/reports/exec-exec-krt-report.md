# Исполнение плана КРТ (exec-krt): карточки короба и паллеты, реестр паллет, вкладки «Коды / Короба / Паллеты»

Ветка `claude/exec-krt` (от `claude/integration` 3235a7396), worktree `/tmp/claude/wt/exec-krt`.
Не запушено, в `claude/integration` не влито. Миграция хоста **0025**. Версия протокола устройства не менялась.
`claude/integration` на момент конца не ушла вперёд — повторное слияние не потребовалось.

## Что сделано (по задачам, sha)

- **1. Провод** — `a10091b78`: `proto/src/pack_cards.rs`, три фикстуры, `OfficeBox.operatorName`, Zod `src/host/pack-cards.ts`, `HostApi.getBoxCard/getPalletCard/listPallets`.
- **2. Карточка короба** — `77562fbcd`: `GET /v1/office/boxes/{id}` (`routes/office_cards.rs`), оператор в списке коробов смены.
- **3. Карточка паллеты** — `e483bba4f`: `GET /v1/office/pallets/{id}`.
- **4. Реестр паллет** — `4444994ea`: `GET /v1/office/pallets` (`routes/office_pallets.rs`), keyset-курсор `o~<id>` / `<мс>~<id>`, миграция `0025_pallet_list.sql` (индекс по выражению + предохранитель `scans_ok_box`). Три маршрута добавлены в таблицу `NEVER` (`license/gate.rs`).
- **5–6. Офис** — `37bd3ea61`: `CodesSection`/`RegistryTabs` (DataTabs, память вкладок, фокус вкладки), `BoxesTab`, `PalletsTab` (`useOfficeInfiniteQuery`, фильтры в адресе), `BoxCardPage`, `PalletCardPage`, `PackLinks`; печать «Состав короба/паллеты», «Ярлык», «XML паллеты» (`ExportDialog palletId`); ссылки из карточки смены, карточки кода и конфликта (`loserBoxLink` → `/codes/box/:id`, как просили).
- **Волна ревью хоста** — `bb5c31bfd` (пять пробелов тестов, `take_capped`, юнит-тесты курсоров).
- **8. Документы дезагрегации** — `9429cc02e`: `BOX_DOCUMENTS_SQL`/`PALLET_DOCUMENTS_SQL` (по индексам `disaggregation_lines_box/pallet`), раздел «Документы дезагрегации», подпись «по документу …» у позиций состава.
- **9. «Расформировать»** — `a4b934391`: создаёт черновик без причины, добавляет строку с SSCC, открывает `/disaggregation/:id`; закрытая смена обязательна (ПР-1), оба роли.
- Документация — `990e86cbe` (`AGENTS.md` «Box and pallet cards», спецификация паритета §5.3 и §8.1); правка вида списка — `eb39b999f`; итоговая волна ревью — `97fb5a06e`; отклонения в плане — `070a35267`.

## Тесты и проверки

- Cargo `-p markiro-proto -p markiro-host` (весь набор): **1417 пройдено, 0 упало**; `cargo fmt --check` чисто; предупреждений сборки нет. Новые: `host/tests/office_cards.rs` (12), `office_pallets.rs` (8) + юниты, `proto/tests/pack_cards.rs` (4), `license_routes` (маршруты в таблице).
- Vitest всего пакета `@markiro/standalone`: **6064 пройдено, 1 упал** — `template-editor.test.tsx › marks «Шаблоны» in the menu…` по таймауту 30 с под нагрузкой полного прогона (790 с); тот же файл отдельно — 97/97 зелёные (260 с). К КРТ не относится, но это та же ловушка нагрузки, что в памяти (тяжёлый файл).
- Новые/изменённые Vitest: `pack-cards-protocol`, `pallet-query`, `office-query`, `registry-tabs`, `boxes-tab`, `pallets-tab`, `box-card-page`, `pallet-card-page`, `pack-disassembly`, расширены `shift-card`, `code-search-page`; изменены (решение поменялось: ссылка конфликта ведёт в карточку короба) `conflict-list`, `conflicts-page`. Страничные тесты прогнаны и под стендом с задержкой `setImmediate` 3 мс (временные файлы удалены), и в verbose без `stderr |`.
- typecheck, lint, prettier --check всех тронутых файлов, `git diff --check` — чисто.
- Мутации: убит мутант «убрать `placeholderData`» (тест станций), мутанты порядка/курсора/ничьих покрыты тестами реестра.
- Ревью (sonnet): хост задач 1–4 — 5 пробелов тестов, закрыты; итоговое — 3 важных + мелкие, закрыты (подпись ссылки конфликта содержит видимый текст, устаревший кэш при периоде «назад», потеря станций при смене фильтра, сбой «Показать ещё», «Открытая» вместо «Без SSCC», неверный id в адресе, повторный черновик).
- Визуально: временный стенд (Vite + поддельный хост, удалён) и Playwright: вкладки, «Короба», «Паллеты», карточки короба/паллеты в тёмной и светлой темах просмотрены. По скриншоту «Состояние» в реестре паллет переставлено вторым столбцом.

## Отклонения при исполнении

Подробно — в конце плана (`docs/superpowers/plans/2026-10-13-standalone-krt-box-pallet-cards.md`, «Отклонения при исполнении»). Главное:

- Миграция поиска кодов в integration называется `0017_code_search.sql` (не `0019`); `0025` свободна, REZ в своей ветке уже пересоздаёт `scans_ok_box`, `IF NOT EXISTS` остаётся предохранителем.
- Фикстурные SSCC паллет из плана имели неверную контрольную цифру (`classifyScan` их отвергает): `…409`, `…2403`; число в курсоре фикстуры пересчитано.
- Стенд хоста: колонну открывать до сдвига часов (сессия иссякает); пакет фактов ≤ 100 записей.
- «Назад» — `useBackToRegistry()`; «Состояние» вторым столбцом реестра; список паллет держит прошлый ответ (`keepPreviousData`).
- Помощник «Расформировать» — свой `src/office/codes/pack-disassembly.ts` (`startPackDisassembly`, `PackDraftWithoutLine`); у `exec-dzgo` есть не закоммиченный `src/office/codes/disassemble.ts` с той же логикой — оставить один при слиянии.
- Двойное нажатие «Расформировать» создавало два черновика (флаг `isPending` приходит на такт позже) — защита через `ref`; после «черновик без строки» кнопка скрыта.

## Общие файлы (для контроллера, порядок слияния)

`apps/standalone/src/office/routes.tsx`, `src/office/office-query.ts` (ключи `boxCard/palletCard/palletList` + `useOfficeInfiniteQuery`), `src/i18n/ru.json`, `src/office/shifts/ShiftCardPage.tsx`, `src/office/exports/ExportDialog.tsx`, `src/office/conflicts/{ConflictsPage.tsx,conflict-list.ts}`, `test/support/office.tsx`, `src/host/{api.ts,protocol.ts}`, `host/src/{server.rs,routes/mod.rs,routes/office_codes.rs (period_end → pub(crate)),license/gate.rs}`, `proto/src/lib.rs`, `AGENTS.md`, спека паритета. `nav.ts` не тронут (один пункт «Поиск кодов»).

Пробное слияние (`git merge-tree`): с `claude/exec-dzgo` конфликт только `src/office/office-query.ts` (ключи); с `claude/exec-rez` — `AGENTS.md`, `ConflictsPage.tsx`, `conflict-list.ts`, `test/conflicts-page.test.tsx` (оба правят ссылку/подпись «Короб проигравшего»; КРТ: `boxId !== null` → `/codes/box/:id`, иначе карточка смены).

## Не проверено (проверки владельца на Windows)

Все из раздела плана «Проверки владельца», в частности: вкладки и стрелки в WebView2; печать «Состав короба/паллеты», «Ярлык» A4/A5 с карточек на офисном принтере; «XML паллеты» с карточки — файл в «Документы\Markiro\Выгрузки» и приёмка ЛК ЧЗ; сканер ярлыка паллеты в поле «SSCC паллеты»; время реестра и «Показать ещё» на базе за год (> 100 паллет); переход «Расформировать» → страница документа (маршрут `/disaggregation/:id` придёт с ДЗГ-О; до слияния ссылка на документ ведёт в пустоту — проверено только `href` и вызов `navigate`). Тесты запускались только в jsdom и на `TestApp`; крейт оболочки (`markiro-standalone`) не затронут и не прогонялся (нужен `dist`).

## Открытые вопросы

Нет (КРТ-1…4 — по умолчаниям плана).
