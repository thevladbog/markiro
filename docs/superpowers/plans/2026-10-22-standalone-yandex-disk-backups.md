# Автоном: Яндекс Диск — план интеграции и оставшейся приёмки

Редакция 4 от 2026-10-23, после живой проверки. Код реализован; Windows-приёмка
отложена пользователем отдельным этапом. Этот документ фиксирует фактический состав
изменения и оставшиеся проверки, а не объявляет готовность Windows-выпуска.

**Цель:** автоматические проверенные облачные копии со службы Хоста и восстановление
нового ПК через прежний ClientID клиента и вход в Яндекс, без отдельного пароля
расшифровки или переноса ключа с прежнего ПК. Серверы Markiro в OAuth/backup/restore
не участвуют. ClientSecret и токены защищает сама служба через DPAPI CurrentUser.

**Источники:** [спецификация](../specs/2026-10-22-standalone-yandex-disk-backups-design.md),
[инструкция клиента](../../runbooks/standalone-yandex-disk-registration.md),
[реализация](../../verification/standalone-yandex-disk-implementation.md),
[матрица A1–A10](../../verification/standalone-yandex-disk-acceptance.md),
[живой цикл и браузер](../../verification/standalone-yandex-disk-live-2026-10-23.md).

Исходная база: `c77195aad00e03ac619baad3cde93ec0ee9cb0be`, ветка
`codex/autonom-yandex-disk`. Перед PR target `origin/main` перечитан:
`a073092e7d26ae3307f8b5670b5593a436fdba4e`. Последующие изменения main не считаются
частью этой интеграции; полный three-dot diff проверяется перед публикацией.

## Обязательные границы

- Собственное OAuth-приложение клиента, без общего ClientID и OAuth broker Markiro.
- ClientSecret вводится в native prompt; code/verifier/tokens не переходят в JS.
  Публичный JSON-профиль содержит только ClientID и фиксированные параметры.
- API/token origins фиксированы; proxy и автоматические redirect запрещены.
  Download GET допускает максимум три ручных проверенных перехода на downloader/storage
  Яндекса, каждый с HTTPS/443, allowlist/public DNS и guard; OAuth туда не передаётся.
- Local backup worker остаётся единственным производителем снимков. Сеть Диска не
  блокирует производство и локальную копию. Active/latest источники закреплены до staging.
- Complete marker публикуется после полного fresh GET, age EOF/hashes и native verifier.
  При ротации сначала снимается marker; последняя подтверждённая копия и другой hostId сохраняются.
- Recovery работает только для установленной роли Host и пустой целевой БД; штатный
  restore lock/intent, identity, SSCC, лицензия и hold сохраняются. Удаления unsent facts нет.
- После восстановления cloud disconnected. Admin входит в Офис прежним паролем и отдельно
  подключает ClientSecret. Выбран допустимый §6.9 skip path вместо нового credential IPC.
- Не закрывать Windows/hardware/provider gates тестами на macOS или скриншотом.

## Выполненные задачи

`[x]` означает выполненный код/проверку указанного объёма. Windows execution этим
не подтверждается. Подробные RED → GREEN результаты находятся в тестах и отчётах.

### 0. Внешние условия и приложение клиента — частично

- [x] Зарегистрировано тестовое приложение клиента для авторизации с двумя scopes и
      loopback redirect; согласие владельца получено. ClientID
      `dacd86d869664a09847d6a54e6f26fac` публичен, ClientSecret в Git не хранится.
- [x] Живой PKCE S256 без секрета: PASS. Refresh без секрета: `400 invalid_client`;
      refresh с персональным ClientSecret: `200`, тот же аккаунт и app-folder доступны.
      Это подтверждено [отдельными пробами OAuth](../../verification/standalone-yandex-disk-capabilities.md).
- [x] Живые PUT, full GET, complete/readback, catalog и отдельное скачивание синтетического
      комплекта проверены production cloud-модулями; последующее temp restore PASS на macOS.
- [x] Закреплён `age = 0.12.1`, Cargo.lock; используются streaming age v1 и bounded buffers.
      Dependency/security acceptance выпуска и Windows build остаются открытыми.
- [ ] Два Windows-профиля с прежним ClientID; LocalService refresh при закрытом Office/logout;
      большая передача, тарифный лимит, pagination под объёмом, quota/revoke и live DELETE.

### 1. Формат комплекта — код готов

- [x] `backup-cloud/src/{model,envelope}.rs`: строгий профиль, Secret с redacted Debug,
      три исходных native файла, четыре облачных объекта и complete manifest, caps/UUID/состав.
- [x] `tests/envelope.rs`, `tests/publication.rs`: roundtrip, byte equality, missing/mixed
      objects, wrong key/client, corruption/authenticated EOF и marker-last publication.
- [x] Host adapter `host/src/yandex/delivery.rs` проверяет SQLite/migrations/TLS и epochs
      снимка; org/ИНН читаются из immutable snapshot. Исходный native manifest не переписывается.
- [ ] Windows ACL и реальный большой snapshot — отдельные gates.

### 2. OAuth/Disk/native callback — код и живой smoke готовы

- [x] `backup-cloud/src/{oauth,client,callback,retry,catalog}.rs`: PKCE/state/TTL/replay,
      bound ClientSecret refresh, public DNS, app namespace, pagination, no-overwrite, 202 polling,
      Retry-After и безопасные ошибки. Автоматического redirect/fallback на Markiro нет.
- [x] По живой проверке исправлен optional bounded `cid` в callback. Duplicate/unknown
      query keys и неверный state продолжают отклоняться.
- [x] По живому GET 302 добавлены до трёх проверенных download redirect на
      `downloader.disk.yandex.{ru,net}` / один DNS label под `storage.yandex.net`.
      Tests отказывают Markiro/private/HTTP/userinfo/uploader до следующего send и ограничивают цикл.
- [x] `src-tauri/src/yandex/{mod,prompt}.rs`: native ClientSecret prompt, системный browser,
      Rust callback, cancel; generic JS transport запрещает auth routes. Секрет не возвращается в JS.
- [ ] Реальные Windows prompt/callback busy/cancel и service restart — этап ниже.

### 3. Credentials, journal, admin boundary — код готов

- [x] `host/src/yandex/{secret_store,tokens,state,connection,runtime}.rs`: service-user DPAPI,
      ciphertext-only atomic replacement/rollback, single-flight/CAS/tombstone, поколения и source fence.
      Non-Windows service store отказывает без plaintext fallback.
- [x] `routes/yandex_backups.rs`, Rust/Zod DTO fixture и audit outbox: admin/session/device
      recheck после сети, безопасный status, eventId deduplication. Backup/recovery не зависят от лицензии.
- [x] `host/tests/yandex_{secrets,tokens,state,connection,routes,audit,runtime}.rs`,
      frontend `test/yandex-backups.test.ts`: синтетические concurrency/cancel/source/role регрессии.
- [ ] DPAPI decrypt/ACL/учётная запись службы и support bundle проверяются на Windows.

### 4. Доставка и ротация — код готов, доставка проверена живьём

- [x] `backup/{worker,folder}.rs`, `yandex/{queue,delivery,runtime}.rs`: offer до rotation,
      persisted active/latest pending, source pins, private staging, budget/reserve, restart и cleanup.
- [x] Upload → full fresh GET → native verify → complete → marker GET → durable confirm/audit.
      Локальная копия остаётся успешной при cloud failure, одинаковый snapshotId не перезаписывается.
- [x] `yandex/retention.rs`: UTC union 24/14/12, last-confirmed pin, marker-first durable purge,
      persisted Retry-After/status; другой hostId и последний архив при откате часов сохраняются.
- [x] `host/tests/yandex_{queue,staging,state,runtime,retention}.rs` и cloud publication tests
      покрывают restart, coalescing, generation/source races, corruption, disk budget и purge crash/audit.
- [ ] Live retention DELETE, большие объёмы и полная fault/quota/revoke матрица.

### 5. Office UI — код и браузерный стенд готовы

- [x] `YandexBackupCard.tsx` в существующей BackupsPage: admin/reader, ClientID/согласие,
      native connect/cancel, импорт/экспорт публичного профиля, retry/disconnect, даты данных и загрузки,
      stale >26h, quota/reauth и отсутствие ложного успеха до первой confirmed copy.
- [x] Существующие tokens/query/access и русская локаль продукта; отдельная EN-локаль не вводится.
- [x] DOM tests плюс Chromium harness `test/harness/yandex/`: настоящие компоненты,
      синтетический Host/native boundary, localhost-only CSP. Проверены роли, состояния,
      светлая/тёмная темы и размеры 1366/1024/480 без горизонтального overflow.
- [ ] Реальный UI ↔ Windows native ↔ служба на другом ПК не считается проверенным стендом.

### 6. Privileged credential adoption после restore — отложено

Новый named-pipe credential handoff не реализован и для текущего сценария не требуется.
Используется разрешённый спецификацией путь: данные восстановлены, cloud disconnected,
после входа в Офис администратор подключает ClientSecret штатным native flow. Не переносить
старый DPAPI blob и не расширять loopback pairing правом менять облачные credentials.
Возможный adoption — отдельная будущая задача с Windows ACL/impersonation/replay тестами.

### 7. Новый ПК и resume — код готов, ядро проверено на macOS

- [x] `src-tauri/src/yandex/recovery.rs`, `YandexRestoreWizard.tsx`, `BootstrapEntry.tsx`,
      `YandexResume.tsx`: прежний ClientID/профиль, PKCE, явный host/copy selection, budget,
      download/verify до UAC, подтверждение выключения прежнего Host, safe cancel и retry.
- [x] Полные реквизиты выбранного снимка показаны вне обрезаемого списка; дата использует
      существующий русский formatter. Вход Яндекса не сбрасывает пароль администратора Офиса.
- [x] `host/src/yandex/recovery.rs` и `restore.rs`: fixed installed target, повторная проверка
      в защищённом workspace, SCM stop/start, empty check после interrupted intent под lock,
      защищённый recovery job/точная receipt без второго restore, ожидание hello/identity/local pairing.
- [x] Read-only outbox preflight отказывает при unsent и сохраняет записи. Автоматического сброса нет.
- [x] `host/tests/yandex_restore.rs`, `yandex_staging.rs`, native unit tests и UI tests;
      живое скачивание, три native byte-equal файла и restore синтетической записи в другую temp-БД.
- [ ] Windows UAC/SCM/power-cut, новый ПК без исходного Host, станция/hold/SSCC drill.

## 8. Следующие этапы и gates

### Перед PR

- [x] Документы/runbook/AGENTS и safe evidence синхронизированы с живой проверкой;
      нет сырых токенов, ClientSecret, recovery keys, signed URL и customer DB в Git.
- [x] Независимое read-only ревью live delta: новых actionable Critical/Important/Minor нет.
- [x] Финальный Rust workspace: 2732 passed/12 ignored; frontend: 8647 passed/3 skipped.
      Typecheck/lint/build, cloud strict Clippy, Cargo fmt/root format, CI policy 76 и diff check прошли.
      Пропуски и границы — в матрице; Windows не закрыта этими результатами.

Публикация: весь staged diff и three-dot diff против свежего target проверяются до push/PR.
Пользователь явно разрешил scoped commit/push/PR 2026-10-23. Merge/release/deploy не разрешены;
актуальный статус публикации ведётся в самом PR.

### Отдельная Windows-приёмка — OPEN по указанию пользователя

1. Проверить Windows Cargo build/tests, installer и комплект бинарников. Native prompt,
   отсутствие секрета в JS/логах, import/export, занятый callback port, cancel и неверная роль.
2. Office на ПК-2 подключает Host на ПК-1. Закрыть Office/logout; проверить LocalService refresh,
   DPAPI CurrentUser/ACL, restart службы/Windows и смену её учётной записи с безопасным отказом.
3. Получить confirmed copy реального тестового набора с фото/BLOB. Проверить quota/revoke,
   неверный/новый ClientSecret, offline/reconnect, Retry-After и смену назначения во время передачи.
4. Выключить исходный Host. На чистом ПК восстановиться с прежним ClientID и входом в Яндекс,
   без старого DPAPI. Сравнить данные/identity/SSCC/лицензию/hold; прежний пароль Офиса сохранён.
5. Прервать helper до/после swap и перезапустить ПК. Resume по receipt не должен применять
   snapshot повторно; working target и unsent facts должны блокироваться без удаления данных.
6. Переподключить станцию по новому адресу, вернуть блоки и провести сверку/admin resume.
   Физическую печать проверять отдельно. Старый Host параллельно не запускать.
7. Отдельно подключить ClientSecret из Офиса и проверить следующую автоматическую копию.
8. Записать process-level outbound trace успеха/ошибок/retry/restore без секретов:
   OAuth/backup/restore не должны обращаться к Markiro. Кодовый allowlist и mock — не packet trace.

### Остальные provider/release gates — OPEN

- [ ] Live retention DELETE/crash, pagination с большим каталогом, большие файлы/лимиты тарифа,
      истечение signed URL, частичная сеть и полная fault matrix publication/ack.
- [ ] Dependency/security acceptance age и full workspace strict Clippy: существующие
      warnings proto/Host не скрывать и не объявлять весь strict gate зелёным по одному cloud crate.
- [ ] Все A1–A10 подписаны в матрице перед Windows-выпуском. PR и live smoke не означают выпуск.

## Известные minor ограничения

Journal status пока использует write transaction. Старые generation purge intents сохраняются
без запросов к прежнему назначению: 32 прерванных reconnect/purge могут безопасно заблокировать
новые purge; нужна отдельная политика архивирования. Не удалять неизвестные remote orphan folders.
