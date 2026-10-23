# Автоном / Яндекс Диск: матрица приёмки

Дата: 2026-10-23. Код в `codex/autonom-yandex-disk`, подготовлен для PR; промышленный выпуск не выполнен. Windows-проверки
отложены пользователем. Все строки ниже разделяют автоматические доказательства на macOS
и фактическое выполнение Windows/provider сценария. Mock не закрывает внешний gate.

Дополнение: [браузер и живая синтетическая копия 2026-10-23](standalone-yandex-disk-live-2026-10-23.md)
прошли на macOS. Production envelope/PUT/full GET/commit/catalog/отдельный download,
побайтное равенство и restore в пустую temp-базу проверены. Исправлены callback `cid`,
302 на storage, реквизиты и локаль даты в мастере. Provider-часть A4/A5/A7/A9 частично
закрыта; Windows, большой объём, fault/quota/revoke и live DELETE остаются OPEN.
Браузер проверял реальные компоненты с синтетическим native boundary.

| Gate | Автоматическое покрытие                                                                         | Внешняя приёмка                                                                |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A1   | admin/device/source boundary, native-only auth bridge, service runtime без Office session       | OPEN: Office ПК-2, LocalService ПК-1, закрытый Office/logout                   |
| A2   | durable queue/restart/coalescing/pins, независимые delivery/refresh loops                       | OPEN: реальный offline/reconnect и перезапуск Windows                          |
| A3   | revoked/permanent pause, retry/503/202, durable retention Retry-After                           | OPEN: revoke, quota и provider ошибки                                          |
| A4   | streaming envelope, corruption/authenticated EOF, полный readback до marker/ack                 | PARTIAL: live PUT/GET PASS на macOS; обрывы/лимиты OPEN                        |
| A5   | PKCE/envelope/new-PC empty restore tests и UI явного выбора                                     | OPEN: новый Windows ПК без старого DPAPI и исходного Host                      |
| A6   | существующие restore/hold/identity/SSCC regression suites                                       | OPEN: станция, новый адрес, сверка и admin resume; физическая печать отдельно  |
| A7   | strict catalog/profile/manifest, initialized target, source races, повтор callback, schema gate | OPEN: Windows preflight/UAC/installer, deny после подмены файлов               |
| A8   | redacted secrets, separate store, generic JS auth denial, public-only profile                   | OPEN: настоящий DPAPI CurrentUser/ACL/LocalService и support bundle inspection |
| A9   | generation/tombstone/cancel, marker-first rotation, чужой host и clock rollback, durable retry  | OPEN: live transfer cancellation, смена аккаунта и process outbound trace      |
| A10  | штатный restore/hold/license, interrupted intent + receipt без второго применения               | OPEN: power-cut/SCM и повтор helper в Windows                                  |

## Процедура Windows

1. Проверить installer: Host executable рядом с оболочкой, роль installation.json,
   защищённые installation/data directories. Проверить native ClientSecret prompt,
   отмену UAC, занятый callback port и отказ при неверной роли.
2. Подключить из Office на втором ПК; закрыть Office, выйти из interactive Windows.
   Дождаться автоматического refresh/копии службой LocalService. Проверить restart и DPAPI decrypt.
3. Проверить upload/download и allowlist реальных transfer hosts, сравнить полный комплект;
   прервать загрузку/ротацию и перезапустить службу. Проверить Retry-After/quota/revoke.
4. Отключить старый Host. На чистом ПК установить Host, указать прежний ClientID,
   войти в Яндекс, выбрать копию и восстановить. Проверить данные/фото/identity/SSCC/hold;
   сохранённый пароль Офиса и отсутствие cloud credentials до повторного подключения.
5. Прервать helper до/после swap, перезапустить ПК и нажать продолжение восстановления.
   Убедиться, что receipt исключает вторую смену epoch/подъём SSCC. Проверить запрет рабочей
   целевой БД и сохранение локальных unsent records без сброса.
6. Переподключить станцию и провести сверку. Затем администратор отдельно подключает
   ClientSecret и проверяет новую автоматическую копию.
7. Записать process-level outbound trace успеха/ошибок/retry/restore: OAuth и Disk обращаются
   напрямую к Яндексу, обращений к Markiro быть не должно. Секреты/ключи/signed URLs не сохранять.

## Локальные проверки

Продолжение 2026-10-23, завершённые проверки на macOS:

- Frontend: 8647 passed, 3 skipped (два browser-fit suite без `PLAYWRIGHT_CORE`,
  PostgreSQL seam без `STANDALONE_HISTORY_ACCEPTANCE_OUT`). Focused card/wizard/controls
  и существующая backup page: 75 passed.
- Cloud crate: 26 passed; Clippy all-targets с `-D warnings` прошёл.
- Tauri lib: 323 passed, включая read-only outbox preflight и ожидание службы.
- Focused Host recovery/retention: 6 passed; staging/schema gate: 4 passed.
- Standalone typecheck/lint/build, Host CLI cargo check, Cargo fmt --check,
  root `pnpm format:check`, `git diff --check` прошли. Build предупреждает о крупном JS chunk;
  это существующее ограничение размера bundle, не ошибка сборки.
- CI policy: 76 passed; новый crate выбирает `verify_static`, `standalone_rust`,
  `standalone_windows_build`, `standalone_app_tests`. GitHub CI не запускался.

Финальный pre-PR Rust workspace завершился с exit 0: **2732 passed, 12 ignored**.
Host: 1771 passed/3 ignored; cloud: 28 passed; Tauri lib: 323 passed. Frontend повторён:
8647 passed/3 skipped, typecheck/lint/build зелёные. Cloud strict Clippy, Cargo fmt, root
format, diff check и CI policy 76 также прошли. Независимое read-only review live delta
не нашло новых actionable замечаний.
Ignored: PostgreSQL acceptance, ручной million-scan benchmark, explicit live Yandex probe,
семь spawned-host/kill/restart loadtest drills и два длительных loadtest integration
scenario. Живой probe уже выполнен отдельно; обычный CI не меняет Диск. Это не Windows.

Реальный PKCE и refresh с ClientSecret ранее проверены отдельно:
[capabilities](standalone-yandex-disk-capabilities.md). Live PUT/GET и macOS temp restore
теперь выполнены; live DELETE не выполнялся. Общий workspace strict Clippy не считается зелёным из-за прежних warnings;
новый cloud crate проверяется отдельно с `-D warnings`.

## Принятые ограничения

- Post-restore adoption через новый privileged IPC отложен. Используется разрешённый skip:
  данные восстановлены, затем обычное подключение администратора Офиса с ClientSecret.
- Ключ находится рядом с копией: захват доступа к папке позволяет восстановить данные.
- Неизвестные remote orphan folders не удаляются. Purge старой generation не возобновляется
  после смены назначения; 32 накопленных abandoned intents требуют политики архивирования.
- macOS build не компилирует Windows-specific WinAPI branches. Проверка Windows installer,
  native prompt/DPAPI/SCM/UAC/ACL обязательна до выпуска.
