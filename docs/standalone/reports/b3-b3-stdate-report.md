# b3-stdate: «Дата смены» на станции

Ветка `claude/b3-stdate` (worktree /tmp/claude/wt/b3-stdate), от claude/integration (bcccf166c).

## Что сказал владелец

Дата смены (`plannedDate`, host 0028) должна сразу быть видна на станции. Станция копии не хранила, карточка показывала только дату производства.

## Причина

`floor_shifts` не имела колонки; `ShiftCopy` без поля. Хост уже отдаёт `plannedDate` в `GET /v1/device/shifts` и в ответе входа (проверено: `DeviceShift.plannedDate` и `EnteredShift.plannedDate` опциональны в Zod/proto, фикстуры `*-planned-date.json` есть). Станция уже слала `plannedDate` при создании смены (всегда «сегодня»), без выбора.

## Что изменено (apps/standalone)

- `src-tauri/migrations/0018_floor_shift_planned_date.sql`: `floor_shifts.planned_date TEXT` nullable, CHECK на формат даты, без default. NULL = копия до миграции или хост до beta 3; следующий список заполняет. Номер 0018 как назначено.
- `src/floor/shifts/shift-copies.ts`: `ShiftCopy.plannedDate: string | null`, поле в `HOST_FIELDS` (`->> 'plannedDate'`: нет поля -> NULL, upsert и KEPT_UPDATES подхватывают сами), чтение. `SYNC_SCHEMA_VERSION` не менялся: это не сущность справочников, а список смен (`z.object` не strict, старые очереди не затронуты, wire не менялся).
- `src/floor/shifts/ShiftCard.tsx` + `ru.json` (`floor.shifts.plannedDate`): «Дата смены: ДД.ММ.ГГГГ» рядом с датой производства; без значения ничего лишнего.
- `src/floor/shifts/NewShift.tsx` + `ru.json` (`floor.newShift.plannedDate`): второй DatePicker «Дата смены» в ряду дат/плана/короба (4 колонки), по умолчанию сегодня в поясе организации (`civilToday`), редактируется как дата производства (очистка оставляет показанную дату), блокируется после создания. Уходит `form.plannedDate` вместо прежнего «всегда сегодня». Валидация на хосте прежняя (`civil_date`).
- `src/floor/shifts/new-shift.ts`: `createdCopy` кладёт `plannedDate ?? null`; `isShiftOfRequest` сравнивает дату смены, только когда названа и в ответе, и в теле (хост до beta 3 не ломает).
- `src/floor/shifts/shift-hub.css`: колонки `.new-shift__counts` 4; на высоте <=700px зазор строк карточки меньше (две строки дат иначе наезжали на бейджи при 1024×600).
- `AGENTS.md` (раздел Shift date): станция теперь хранит дату.

## Рабочий экран и печать

- Шапка рабочего экрана не показывает дату производства (только номер) — добавлять нечего, не добавлял.
- Станция не печатает «Бланк смены» (форма задания живёт только в офисе: `office/forms`); этикетки/лист паллеты используют дату производства как факт продукта, не дату смены. Печать не менялась.

## Тесты

- Vitest: `shift-copies` (дата сохраняется, отдельно от даты производства; хост без даты -> null и очищает устаревшую; вход и созданная смена), `floor-shift-list` (карточка: обе даты; без даты — только производства), `floor-new-shift` (picker, значение по умолчанию, правка, тело создания, блокировка, `isShiftOfRequest`, `createdCopy`), новый `floor-shift-planned-date-migration` (0018 поверх 0017: строки целы, NULL, нет default, CHECK), `floor-schema` (колонка зафиксирована).
- Изменены существующие ожидания из-за нового поля: `shift-copies` (`plannedDate: null` в toEqual копии), `createdCopy`-тесты, фикстура `product-photos.test.tsx` (тип).
- Cargo: `tests/local_db.rs`: `without_0016` отодвигает 0018 для floor_shifts; beta-2 тест расширен строкой смены (после апгрейда planned_date NULL, схема = новой); новый `a_beta3_station_database_gets_the_shift_date_and_keeps_its_shifts` (0001-0017 -> старт -> строки целы, NULL, CHECK).
- Результаты: полный Vitest пакета по 3 шардам: 2706+2085+2035 passed; падения шарда 1 (`floor-schema`, мой пин колонок — исправлен) и шарда 3 (`shifts-page`, `template-defaults-page` — флейк под нагрузкой, оба файла отдельно 95/95); tsc чисто; eslint чисто на тронутом; prettier чисто; `cargo fmt --check` ок; `cargo test` src-tauri 490 passed (вне песочницы); `git diff --check` чисто. Host не менялся (миграции host: unique-тест не затронут).

## Скриншоты (/tmp/claude/fb/b3-stdate/)

Dev-харнес (SQLite-мост с реальными миграциями, Vite, настоящие `ShiftList`/`NewShift`): `1280-hub-cards.jpg`, `1280-new-shift-dates.jpg`, `1024x600-hub-cards.jpg`, `1024x600-new-shift-dates.jpg`. `1024x600-hub-nodate-preexisting-overlap.jpg`: правая карточка стресс-фикстуры (пятистрочное название + контрагент) налезает на соседние строки и без моей даты — дефект раньше, не из этой правки (вынесено, не чинил). Харнес из дерева удалён.

## Не проверено

Windows/WebView2, реальный сенсорный экран, живой хост beta 3 с реальным ответом `plannedDate` (только фикстуры и Vitest), апгрейд боевой базы станции. Merge claude/integration: ветка уже содержала его HEAD на момент работы (bcccf166c); при конфликтах с коммитами агента полного гейта повторить merge.

## Вопросы владельцу

1. Показывать дату смены на рабочем экране? Дата производства там не показывается, поэтому не добавлял.
2. Карточка с очень длинным названием + контрагентом при 600 px высоты тесна уже сейчас — нужен отдельный пункт?
