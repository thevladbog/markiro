# integ-gates3: релизный гейт после слияния потоков beta-3-feedback

Ветка claude/integration, верхушка 8bfaa9af0 (worktree /tmp/claude/wt/integ). Не пушилось.

## Результат

Ошибок, вызванных слиянием, нет. Исправлено только форматирование двух файлов; добавлены постоянные тесты безопасности миграций.

## Гейты

- Сборка dist: ui, domain, platform-contracts, db — ok.
- tsc (standalone typecheck) — ok. eslint — ok.
- prettier --check по файлам diff с 917f92ab4: 2 файла не отформатированы (src/host/api.ts, test/shift-dialog.test.tsx) — исправлено prettier --write (в коммите). `git diff --check` — чисто.
- Vitest @markiro/standalone, 4 шарда по очереди: 64/63/63/63 файлов, 1915+1921+1423+1565 = 6824 теста, 0 падений, повторов не потребовалось.
- cargo test --workspace --no-fail-fast --offline --locked (вне песочницы): 131 набор ok, 0 FAILED. cargo fmt --check — ok (fmt поправил мои новые тесты).
- license_routes (gate.rs vs роутер): 4/4 ok, новые маршруты потоков сходятся с таблицами GATED/NEVER.
- test:standalone-release:contract 82/82; test:standalone-export 121 ok, 1 skipped (было так и раньше); test:standalone-support:contract 4/4.
- packages/ui: 262/262. packages/domain: 1448/1449 в полном прогоне — pallet-sheet-render «duplicates one content cell» упал по таймауту 5 с (машина под нагрузкой load avg ~98; в одиночку 8.8 с, с --testTimeout=60000 проходит 34/34). Файлы теста и тестируемого кода слиянием не затронуты (изменились только print-forms/pairing-card.ts и index.ts) — не вызвано слиянием, ассерты не трогал.

## Безопасность миграций

Хост beta 3 (917f92ab4): 0001–0012, 0015–0025, 0030, 0031. Оболочка: 0001–0010, 0012–0016.

- Постоянные тесты beta 2 (host/tests/migration_beta2_upgrade.rs, src-tauri/tests/local_db.rs) проходят без изменений.
- Новый host/tests/migration_beta3_upgrade.rs: база beta 3 с данными (линия, станция, два товара, фото одного, смена, строка аудита) обновляется через upgrade::pending + MIGRATOR.run; ждут именно 27, 28, 32; журнал полный, повторный запуск пуст; planned_date = production_date, триггер shifts_planned_date_default даёт дату новой смене без неё; photo_rev = rev у товара с фото и 0 у товара без; данные целы; таблицы, колонки, индексы и триггеры идентичны свежей базе (audit_log_target, shifts_planned_date, ...); foreign_key_check и integrity_check чисты.
- В нём же host_migration_versions_are_unique (скомпилированный список и файлы).
- В src-tauri/tests/local_db.rs: a_beta3_station_database_keeps_its_data_and_reaches_the_schema_a_new_one_has (оболочка 0001–0010, 0012–0016 -> 0017; данные ref_lines/ref_products целы, photo_checksum NULL, ref_product_photos пуста, схема и журнал как у свежей) и shell_migration_versions_are_unique.

## Версии

- PROTOCOL_VERSION = 5 везде: proto/src/lib.rs, test/protocol.test.ts (2 места), proto/tests (shifts, validation_print) — согласовано, MIN = 1.
- SYNC_SCHEMA_VERSION живёт только в станции (src/local/reference-sync.ts, 5; в beta 3 было 4), ENTITY_SET = "...;v5" закреплён в test/reference-sync.test.ts. У хоста и фикстур такой константы нет (хост лишь упоминает «v5» в комментарии миграции 0032 и AGENTS.md). Рассогласования нет.

## Не проверено

Браузер, Windows, железо, реальное обновление на устройстве — не гонялись.
