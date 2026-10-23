# Автоном: реализация Яндекс Диска — текущий статус

Дата: 2026-10-23. Ветка `codex/autonom-yandex-disk`, база `c77195aad00e03ac619baad3cde93ec0ee9cb0be`. Отчёт для PR; промышленный выпуск не выполнен.

## Реализовано

- Общий `backup-cloud`: строгий публичный ClientProfile без credentials; PKCE/state/TTL/replay; loopback callback; прямой refresh с ClientSecret; bounded streaming age X25519; проверки состава, хешей, ClientID и authenticated EOF.
- Прямой Disk API: app-folder namespace, pagination, no-overwrite, повторное получение transfer URL, явное ожидание 202, фиксированные origins/public DNS, запрет proxy/автоматических redirects. Download допускает до трёх ручных проверенных переходов на файловые узлы Яндекса. OAuth не передаётся signed transfer URL. Guard проверяет generation/source перед каждым запросом и переходом.
- Host DPAPI CurrentUser/UI_FORBIDDEN без impersonation и plaintext fallback вне Windows; закрытые файлы вне host.db; ciphertext-only atomic replacement/rollback.
- Отдельный durable journal: generation/tombstone, active + latest pending, постоянный snapshot ID, terminal rejection непригодной копии.
- Admin HTTP begin/complete/cancel/disconnect/retry, повторная проверка admin после сети, session/device/source binding; публичный status DTO/Zod fixture. Durable audit outbox с eventId deduplication.
- Host startup/shutdown и отдельные refresh/delivery loops без зависимости от сессий Офиса. Временные ошибки/backoff/Retry-After; invalid_client требует reconnect.
- Local producer предлагает копию очереди до ротации. Active/pending pins переживают restart, освобождаются после private staging. Cloud network не выполняется в local worker.
- Подготовка сверяет SQLite/migrations/TLS существующим restore verifier и epochs самого снимка. Организация/ИНН читаются из immutable snapshot; версия — Host. Native manifest bytes не меняются.
- Публикация: четыре immutable объекта → полный fresh GET → hashes/decrypt/native verify → complete.json последним → fresh GET complete → local confirm/audit.
- Staging завершается rename из partial; orphan workspaces чистятся между завершёнными delivery passes; active stage сохраняется. Перед записью проверяется бюджет недостающих больших файлов плюс 512 MiB для рабочего тома.

Cloud failure не превращает успешную локальную копию в ошибку. Старые restore callers сохраняют прежнее поведение; empty-only wrapper проверяет цель после завершения interrupted intent под тем же lock. Нового LAN endpoint восстановления нет. Код интеграции не использует broker, telemetry или fallback через Markiro. Это утверждение ограничено новой интеграцией; process-level Windows trace остаётся отдельным доказательством.

## Завершённые пользовательские сценарии

- Office UI: ClientID, согласие на ключ рядом с копией, native ввод/замена ClientSecret, системный OAuth/loopback callback, cancel, retry/disconnect, возраст данных и последняя подтверждённая загрузка. Reader видит состояние без прав подключения. Секрет/code/токены не передаются в React; generic JS transport запрещает auth routes. Публичный профиль импортируется нативно и экспортируется без секретов.
- Ротация: объединение 24 последних копий, последних за 14 дней и 12 месяцев UTC только текущего hostId; последняя подтверждённая копия закреплена. Сначала удаляется complete marker, затем четыре объекта. Durable purge переживает restart; Retry-After сохраняется в журнале с deadline и отражается в status.
- Новый ПК: только установленная роль Host, прежний ClientID и свежий PKCE без ClientSecret; явный выбор организации/ИНН/hostId/даты/версии. Download проверяет место, полный комплект, age EOF/hashes и штатный Host verifier до UAC. Helper повторно проверяет файлы в защищённом workspace до остановки службы; target фиксирован установкой, рабочая БД не заменяется.
- Elevated helper использует штатные SCM stop/start, restore lock/intent, перенос identity и hold/SSCC semantics. Защищённый recovery job и точная receipt позволяют продолжить после сбоя без повторного restore. Оболочка ждёт выхода helper и готовности hello, проверяет identity, затем выполняет существующее local pairing.
- Read-only preflight сохраняет все локальные записи и отказывает при unsent facts. Никакого автоматического сброса outbox нет. На экране недоступного хоста доступно продолжение прерванного восстановления.
- После восстановления сохраняются учётные записи/пароли Офиса и hold. Cloud отключён до обычного подключения администратором с ClientSecret. Optional post-restore credential adoption из задачи 6 не реализован: выбран разрешённый спецификацией skip path.

## Открытые задачи

Код перечисленных сценариев реализован. Выпуск и Windows end-to-end acceptance ещё не подтверждены; см. [матрицу](standalone-yandex-disk-acceptance.md). Native prompt, DPAPI, UAC, SCM и installer не исполнялись на Windows.

Живые PUT/full GET/commit/catalog/download и restore в пустую temp-базу прошли на macOS:
[отчёт](standalone-yandex-disk-live-2026-10-23.md). Callback `cid` и безопасные storage redirects
исправлены по результатам пробы. Большой объём/pagination/limits/quota/revoke/DELETE ещё не проверены.
Прежние PKCE/refresh пробы: [capabilities](standalone-yandex-disk-capabilities.md).
Windows DPAPI/ACL/service restart/SCM/UAC проверки отложены пользователем. Синтетический Protector не доказывает DPAPI.

Закреплён `age = 0.12.1` (MIT OR Apache-2.0, MSRV 1.74); upstream предупреждает о pre-1.0 статусе. Принятие зависимости для выпуска остаётся gate. Форматный cap 64 GiB не обещает лимит тарифа. Transfer allowlist проверен в живом PUT/GET, включая storage redirect; границы provider API/тарифа остаются отдельной проверкой.

## Проверки

Focused тесты покрывают envelope corruption/authenticated EOF/duplicate keys; OAuth grant/refresh/state/replay; callback denial; origin/DNS/guard; 202 polling; publication corruption; credential cancellation/rollback/late refresh; generation ABA; role/source races; audit deduplication; restart/coalescing/pins; native staging metadata/source epoch; disk budget и cleanup.

Read-only review выявил и привёл к исправлениям cancellation/generation/source гонок, 202/503 handling, блокировки очереди непригодным snapshot, partial/orphan staging, нехватки места и отсчёта Retry-After от старого времени. Дополнительные регрессии закрывают empty guard после interrupted intent, recovery resume/receipt, ожидание запуска службы, исключение параллельных helper, отмену зависшего GET, повторный login после ошибки catalog, durable retention Retry-After и сохранение unsent records.

Итоговые macOS проверки продолжения и причины пропусков — в
[матрице приёмки](standalone-yandex-disk-acceptance.md). Frontend 8647 passed/3 skipped,
cloud 26 и strict Clippy, Tauri lib 323, focused recovery/retention/staging 10;
typecheck/lint/build, Host CLI cargo check, Cargo fmt, root format и diff checks прошли.
CI policy 76 passed; GitHub CI и Windows не запускались.

Финальный pre-PR Rust workspace: 2732 passed/12 ignored, exit 0; Host 1771 passed/3 ignored,
cloud 28 passed, Tauri lib 323 passed. Frontend повторён: 8647 passed/3 skipped;
typecheck/lint/build, cloud strict Clippy, Cargo fmt/root format/diff checks и CI policy 76 прошли.
Причины пропусков перечислены в матрице. Windows execution остаётся отдельным этапом.

Host Clippy предыдущего foundation-прогона завершился с 6 прежними proto и 5 прежними
Host warnings вне новых модулей. Общий strict Clippy gate не заявляется зелёным.

Journal status пока использует write transaction — открытый minor performance пункт. Незавершённые purge intents старых generations сохраняются без дальнейших сетевых запросов: после 32 таких interrupted reconnect циклов новые purge блокируются безопасно; нужна отдельная политика архивирования. Turbo build сначала встретил несовпадающий Homebrew pnpm shim; прямой Corepack build прошёл без изменения политики package manager.
