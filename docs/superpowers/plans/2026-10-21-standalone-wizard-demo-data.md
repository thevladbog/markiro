# Автоном: демо-данные в мастере — план реализации

> **Для исполнителей:** навык superpowers:executing-plans (или subagent-driven-development), задачи
> по порядку, шаги — чекбоксы. Сначала падающий тест, потом код.

**Цель:** флажок «Установить демо-данные» в мастере создаёт на хосте демо-товар, демо-смену и
демо-счётчики SSCC. Демо-смена проходит на одном ПК: кнопка «Демо-код» и предпросмотр вместо печати.
Демо-объекты не попадают в выгрузки для ГИС МТ и в статистику и удаляются одним действием в офисе.

**Спека:** `docs/superpowers/specs/2026-10-21-standalone-wizard-demo-data-design.md` (согласована
2026-10-21: О4 — демо-префикс, Д1–Д3 по рекомендациям).

**Архитектура:** признак-источник один — `products.demo`. Смена демо, если демо её товар. Хост
собирает набор сам в транзакции `bootstrap`; протокол растёт на `demoData` (запрос) и `demo` (запись
товара). Номер демо-смены берётся из счётчика `DEMO`, SSCC — под префиксом `290000000`.

**Стек:** Rust (axum, sqlx, SQLite) — `host`, `proto`, `src-tauri`; React + Zod + Vitest — `src`.

## Общие ограничения

- Константы: GTIN `02900000000018`; префикс SSCC `290000000`; ключ номера `DEMO`; товар «Демо: вода
  питьевая 0,5 л», группа 13, 5 шт./короб, 2 короба/паллета, срок 365 дней; смена — план 20 шт., с
  паллетами, режим `aggregation`.
- Миграции: хост `0053_demo_data.sql` (0052 занят веткой `claude/ms-host`), оболочка
  `0021_ref_products_demo.sql`. Применённые миграции не правятся.
- Коды ошибок: `demo_product` (409), `demo_shift` (409), `demo_shift_active` (409), отказ строки
  дезагрегации `demo_box`.
- Аудит: новое действие `demo_data.delete` в `audit::actions`; в `host.bootstrap` деталь
  `demoData: true` только при демо.
- Новый маршрут — в реестре `host/src/license/gate.rs` (`NEVER`) и в `device_kinds.rs` не нужен (офисный).
- Не трогать `apps/api`, `apps/landing`, `apps/saas-admin`, `packages/platform-contracts`.
- Проверки: строка `apps/standalone` таблицы корневого `AGENTS.md`; `cargo test --workspace`
  частями, если целиком не помещается.

---

### Задача 1. Протокол, Zod и фикстуры

**Файлы:** `proto/src/lib.rs` (`BootstrapRequest`, `ProductRecord`, `OfficeProduct`, новый
`DemoDataSummary`, коды ошибок), `src/host/protocol.ts`, `proto/fixtures/*.json`,
`proto/tests/fixtures.rs`, `test/protocol.test.ts`.

**Производит:**

- `BootstrapRequest.demo_data: Option<bool>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`),
  Zod `demoData: z.literal(true).optional()`.
- `ProductRecord.demo: bool` и `OfficeProduct.demo: bool` (`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`),
  Zod `demo: z.boolean().optional()`.
- `DemoDataSummary { present: bool, product_id: Option<String>, shifts: u32, boxes: u32, pallets: u32, codes: u32, active_shifts: Vec<String> }`
  (номера активных смен), Zod `demoDataSummarySchema`.

- [ ] Тест: фикстура `bootstrap-request-demo.json` и запись товара с `"demo": true` читаются Rust и Zod;
      запись без `demo` даёт `false`/`undefined`; `demoData: false` Zod отвергает (мастер шлёт только `true`).
- [ ] Реализация, `cargo test -p markiro-proto`, `vitest run test/protocol.test.ts`.
- [ ] Коммит.

### Задача 2. Хост: миграция и демо-набор в мастере

**Файлы:** `host/migrations/0053_demo_data.sql`, `host/src/demo.rs` (новый: константы,
`create(tx, …)`, `DEMO_PREFIX`, `DEMO_NUMBER_KEY`, `is_demo_product`), `host/assets/demo-product.png`,
`host/src/routes/bootstrap.rs`, `host/src/lib.rs`, тесты `host/tests/demo_data.rs`.

Миграция:

```sql
ALTER TABLE products ADD COLUMN demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1));
CREATE TABLE demo_removed_shifts (id TEXT PRIMARY KEY, removed_at TEXT NOT NULL);
```

`demo::create` в транзакции bootstrap после линий и шаблонов: товар (`demo = 1`, `rev`), фото
(`product_photos`, `photo_rev = 1`), два счётчика `sscc_counters` под `DEMO_PREFIX` (короб с 1,
паллета с 0), смена через `shifts::insert` (`NewShift` с `ShiftOrigin::Office`, `created_by` —
администратор, первая линия, шаблоны по умолчанию коробки и паллеты, дата — сегодня в часовом поясе
организации). Если префикс организации равен `DEMO_PREFIX`, ответ — `validation_failed` на `demoData`.

- [ ] Тесты: без флажка набора нет, пробный период идёт; с флажком — один товар `demo=1` с фото, одна
      плановая смена `DEMO-001` на первой линии, счётчики демо-префикса, всё с одной ревизией;
      `trial_started_at` установлен в обоих случаях; аудит `host.bootstrap` с `demoData: true`;
      `migration_beta3_upgrade::host_migration_versions_are_unique` зелёный.
- [ ] Реализация; `shifts::insert` берёт ключ `DEMO`, если товар демо.
- [ ] Коммит.

### Задача 3. Хост: правила демо-товара и демо-смен

**Файлы:** `host/src/routes/products.rs`, `host/src/routes/product_photos.rs`, `host/src/shifts.rs`
(ключ номера, префикс снимка), `host/src/routes/sscc.rs` (демо-счётчики не видны и не правятся),
`host/src/routes/org.rs` (GLN с демо-префиксом при демо — `validation_failed`),
`host/src/routes/changes.rs` (`demo` в записи товара), список товаров офиса (`demo`).

- [ ] Тесты: `PUT` товара и фото демо-товара — `conflict demo_product`; смена из офиса и со станции на
      демо-товар — номер `DEMO-NNN`/`DEMO-NNN/S`; вход в демо-смену даёт снимок с `issuerPrefix`
      `290000000`; станция получает блок под демо-префиксом; `GET /v1/office/sscc` не показывает
      демо-префикс; лента отдаёт `demo: true`.
- [ ] Реализация, коммит.

### Задача 4. Хост: изоляция

**Файлы:** `host/src/routes/office_exports.rs` и `office_export_files.rs` (ГИС-МТ-форматы демо-смены —
`conflict demo_shift` при записи и при начале загрузки файла), `host/src/disaggregation.rs` (строка с
демо-коробом — статус `demo_box`), складские паллеты (`host/src/facts/…` для паллет ТСД — отказ факта),
`host/src/routes/usage_stats.rs` (все запросы по сменам с `JOIN products p … AND p.demo = 0`).

- [ ] Тесты на каждый отказ и на статистику (демо-смена со сканами и коробами не меняет счётчики).
- [ ] Реализация, коммит.

### Задача 5. Хост: сводка и удаление

**Файлы:** `host/src/routes/demo_data.rs` (`GET` и `DELETE /v1/office/demo-data`), `server.rs`,
`license/gate.rs`, `audit.rs` (`DEMO_DATA_DELETE`), `facts/mod.rs` (поздний факт на удалённую
демо-смену — `accepted` без записи), `feed` (надгробие товара).

- [ ] Тесты: сводка; удаление без демо — 204 без ревизии и аудита; активная демо-смена — 409
      `demo_shift_active` с номерами; полное удаление (ни одной строки демо в фактах, сменах, выгрузках,
      счётчиках `DEMO` и демо-префикса, товара и фото), надгробие `products/<id>` в ленте, аудит с точными
      полями, технолог — 403; поздний факт после удаления квитируется `accepted`; восстановление копии с
      демо-данными возвращает их как были.
- [ ] Реализация, коммит.

### Задача 6. Копия станции

**Файлы:** `src-tauri/migrations/0021_ref_products_demo.sql`, `src-tauri/tests/fixtures/local-sql.json`
(если миграции перечислены), `src/local/reference-sync.ts` (колонка `demo`), локальная чистка смен
удалённого демо-товара (`src/floor/…`), `test/support/local-db.ts`.

- [ ] Тесты: upsert пишет `demo`; надгробие товара удаляет `ref_products` и локальные смены этого
      товара без неотправленных записей; смены с записями в очереди остаются.
- [ ] Реализация, коммит.

### Задача 7. Мастер

**Файлы:** `src/wizard/wizard-form.ts` (`installDemo: boolean`, по умолчанию `true`;
`toBootstrapRequest` шлёт `demoData: true` только при флажке), `src/wizard/BootstrapWizard.tsx`
(флажок на шаге «Проверка» с пояснением), `src/i18n/ru.json` (+ en, если есть).

- [ ] Тесты: тело запроса с флажком и без; флажок виден на шаге «Проверка».
- [ ] Реализация, коммит.

### Задача 8. Офис

**Файлы:** `src/host/api.ts` (`getDemoData`, `deleteDemoData`), тег «Демо» у товаров, смен, шторы
смены, карточек короба/паллеты; `src/office/overview/*` (карточка «Установлены демо-данные», KPI и
«Первые шаги» без демо); `src/office/info/sections.tsx` (раздел «Демо-данные»); диалог удаления;
`src/office/exports/*` (форматы для ЧЗ скрыты у демо-смены, префикс `DEMO_`); печатные формы с плашкой
«ДЕМО».

- [ ] Тесты на каждое поведение (Vitest + Testing Library).
- [ ] Реализация, коммит.

### Задача 9. Станция

**Файлы:** `src/floor/demo/demo-codes.ts` (+ фикстура `proto/fixtures/demo-codes.json` или
`test/fixtures`), кнопка «Демо-код» на экране работы, чип «Демо-данные» в `header-chips.ts` и
`FloorStatusBar.tsx`, тег «Демо» в списке смен, предпросмотр вместо печати в
`src/floor/print/print-jobs.ts` для демо-смены без принтера.

- [ ] Тесты: коды проходят `canonicalizeKm`, GS на местах, GTIN товара; кнопка подаёт следующий
      неиспользованный код; чип и тег; задание демо-смены без принтера → предпросмотр → «Готово» → смена
      без стопа «этикетка»; реальная смена без принтера — как раньше.
- [ ] Реализация, коммит.

### Задача 10. Документы и проверки

- [ ] `apps/standalone/AGENTS.md`: раздел «Demo data», дополнения в «Audit» и «Change feed» (товар
      впервые получает надгробие); `docs/standalone/ROADMAP.md` (номера миграций); `CHANGELOG.md`.
- [ ] Проверки: focused Vitest и cargo, `pnpm --filter @markiro/standalone test typecheck lint build`,
      `cargo test --manifest-path apps/standalone/Cargo.toml --workspace` (частями), `git diff --check`,
      prettier по затронутым файлам.
- [ ] Браузерная панель: мастер с флажком (vite dev), демо-смена на станции (стенд `test/harness/*`),
      скриншоты.
- [ ] Коммит; отчёт с непроверенным (Windows, служба, NSIS, железо).
