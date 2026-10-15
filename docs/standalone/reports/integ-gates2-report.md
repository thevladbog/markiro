# Интеграционные гейты apps/standalone (claude/integration), раунд 2

Дерево: /tmp/claude/wt/integ, исходная вершина a6eaaaca6, итоговая 3be2ab5b5.

## Результаты по гейтам

1. Сборка dist: ui, domain (platform-contracts и db не менялись с beta 2 — не пересобирались) — OK.
2. `tsc --noEmit` standalone OK; eslint standalone OK; domain typecheck+lint OK; api typecheck OK (api затронут только переносом акта дезагрегации); prettier --check (apps/standalone, packages/domain, packages/ui, api disaggregation/pickup) OK; `git diff --check` OK.
3. Vitest @markiro/standalone по 4 шардам, по одному: 62/62 файлов 1862; 62/62 1889; 61/61 1383; 61/61 1549 — всего 6683 теста, 0 падений, без Errors/Unhandled. Перезапусков template-editor / print-form-dialog не потребовалось.
4. `cargo test --workspace --no-fail-fast --offline --locked` (вне песочницы): 127 тестовых бинарей, 0 упавших, `cargo fmt --check` OK. Clippy не гонял.
5. `test:standalone-release:contract` 82/82; `test:standalone-export` 121 ok + 1 skipped (прежний skip); packages/domain 95 файлов / 1446 тестов OK (акт дезагрегации после переноса).
6. Безопасность миграций — см. ниже. OK.
7. PROTOCOL_VERSION = 5 везде: proto/src/lib.rs, src/host/protocol.ts, proto/fixtures hello.json и hello-restored.json (5), hello-future.json = 6 (должен опережать — тест это держит), тесты proto/tests/shifts.rs и validation_print.rs утверждают 5, tools/standalone-release читает диапазон из proto/src/lib.rs и сверяет с hello.json. Остальные `protocol: 3` в TS-фикстурах — это записи устройств прошлых версий, а не версия сборки.

## Проверка миграций

- Хост 0001→0031 на свежей БД: применяется (все существующие host-тесты).
- Beta 2 (0aac2b1af) отправляла хост-миграции 0001–0012, 0015–0019, 0023, 0031 (0013/0014 в хосте нет; шелл: 0001–0010, 0012, 0013). С beta 2 по HEAD файлы миграций только добавлены, ни один применённый не менялся (git diff --name-status: только A), checksum-конфликта нет.
- Новый постоянный тест `apps/standalone/host/tests/migration_beta2_upgrade.rs`: строит БД beta-2 с данными (линия, станция, смена, короб, 4 скана, 2 конфликта), проверяет что `upgrade::pending` видит пробелы 20,21,22,24,25,30 и не отвергает их, запускает `MIGRATOR.run`: все версии применены, вторая прогонка — no-op, конфликты сохранены, kind = displaced/late, reviewed_by NULL (0020 раньше 0022), строки 0023/0031 целы, и множество таблиц/колонок/индексов/триггеров совпадает с БД, созданной с нуля (включая scans_ok_box/gtin/scanned, box_items_live и триггеры режимов), seed-строки 0024/0030 те же, foreign_key_check и integrity_check чистые.
- Шелл: новый тест `a_beta2_station_database_reaches_the_schema_a_new_one_has` в src-tauri/tests/local_db.rs: БД из 0001–0010,0012,0013 открывается `LocalDb::open`, схема/колонки/журнал равны свежей, outbox_unsent и wh_outbox_unsent на месте. Пошаговые тесты 0014/0015/0016 и «lower migration arrives late» уже были.

## Сбои и исправления

Сбоев, вызванных слияниями, не найдено; исходники не менялись. Единственный коммит: 3be2ab5b5 (два новых теста). В первом прогоне моего же нового теста был неверный список версий beta 2 (13/14 я посчитал) — исправлено до коммита.

## Не проверено

- Windows: сервис хоста, LAN-сопряжение, киоск-режим, установщик, WebView2 (`<a download>`, печать); cargo-тесты только на хосте macOS.
- Железо: принтеры/сканеры/Windows-драйвер А4.
- Браузерная/визуальная проверка не делалась; production-browser, Playwright, CI-матрица (tools/ci/affected.mjs) не гонялись.
- API e2e с БД (api-тесты акта дезагрегации) не запускались — только typecheck; перенос в domain проверен тестами domain и снапшотами.
- Реальный файл БД beta 2 с устройства не использовался — состояние воспроизведено по списку миграций коммита 0aac2b1af.
