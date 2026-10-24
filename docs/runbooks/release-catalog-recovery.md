# Каталог релизов: история, резервная копия и восстановление

Код и локальные тесты не означают, что каталог включён в production. Развёртывание
проходит отдельный protected workflow. Ни импорт, ни recovery-инструменты не
включают издателей и не устанавливают указатель канала.

## История до первого writer epoch

1. Сохранить полные текущие листинги обоих GitHub-репозиториев, теги, исходные
   evidence/signing records и сохранённые копии. Текущий листинг даже с полной
   пагинацией не доказывает отсутствие удалённых старых выпусков.
2. Построить строгий `ReleaseHistoryEvidence` и вызвать `buildHistoryPlan` из
   `tools/release-catalog/import-history.mjs`. Каждый источник привязан SHA256.
   `coverage=complete` или `upper-bound` принимается только с проверенным архивом
   или signing record, который действительно охватывает **все** выданные версии.
   Текущий head после rollback такой границей не является.
3. Недоступный старый файл: `publication=null`, пустой `objects`, но сохранить
   все известные `names`. План резервирует версию и пути навсегда: чтение 404,
   новая запись по занятому имени 409. Неизвестная верхняя граница закрывает
   весь namespace. Range включает все prerelease на той же semver-базе.
4. Для readable import нужны полный набор исходных байтов и точные S3 VersionId.
   Автоном 1.0.0 импортировать с его исходной ES256-подписью и установщиком;
   не пересоздавать manifest. Станцию проверять каноническим валидатором origin,
   исходным тегом и `releaseSha`; stable требует уже принятую исходную beta.
   Signer допускается только как исторический импорт пяти файлов через прежний
   валидатор manifest/evidence/SHA256SUMS. Нового publisher route для него нет.
5. Проверить конкретный план и его digest, остановить/отсечь API, старые executors
   и все publishers. Protected adapter проверяет точный workflow run/attempt,
   executor SHA, независимое approval, scope, disabled epoch, срок и digest.
   `applyHistoryPlan` вызывает тот же durable ledger и canonical product checks.
   Перед каждой мутацией повторяются authority/fence; transaction проверяет,
   что нет enabled epochs. Нет удалений, прямого обхода SQL-guards или S3 overwrite.

Операторские функции — доверенная локальная библиотека для protected orchestration,
а не HTTP API. `authorize` и `assertFenced` — обязательные реальные адаптеры;
передать JSON с `approved=true` или пустую функцию в production недопустимо.
Сначала собрать API и contracts на том же проверенном SHA. Журнал операции и
файлы плана сохраняются; после неоднозначного ответа читать состояние и повторять
только ту же идентичную операцию с её исходными IDs и VersionId.

## Что входит в резервную копию

`createDatabaseBackup` держит физическую writer fence. PostgreSQL worker экспортирует
одну repeatable-read snapshot для дампа, table inventory и строк девяти
`release_catalog_*` таблиц. В `inventory.json.catalogBackup` входят:

- исходный PostgreSQL row JSON text, включая epochs, reservations, bindings,
  receipt VersionId, channel events и revisions без потери точности bigint;
- полные байты приватного local journal: receipt, attempt и stored ack;
- размер и SHA256 каждого файла, соответствие DB receipts точным ack и байтам.

Это часть уже хешируемого inventory, а не отдельный забываемый sidecar. Независимые
зашифрованные копии на Mac и Timeweb должны содержать database.dump, inventory.json
и completed restore evidence; после полного расшифрования проверить каждый SHA256.
Ключ восстановления сохраняется отдельно и не загружается вместе с копией.
Проверка restore и host backup gate отвергает catalog rows без этого доказательства.
Raw business rows в inventory не включаются: только специальные release catalog
таблицы, остальные данные остаются внутри зашифрованного дампа.

Журнал читается без изменения прав и без очистки; mode0700/0600, точный uid,
обычные файлы с одним hardlink, canonical path, отсутствие symlink и неизменность
metadata обязательны. Host читает только `/opt/markiro-platform/release-catalog/journal`
при уже доказанном отсутствии API/других владельцев mount. Старые частичные операции
сохраняются даже без ack. Недостающий committed receipt блокирует backup.

Лимит inventory остаётся **2 MiB**, control files — 1 MiB. Состояние и журнал
проверяются до чтения больших наборов; превышение останавливает backup без
усечения. Увеличение объёма истории требует заранее проверенного изменения
формата/ёмкости; копия без журнала не является запасным вариантом.

## Recovery после старого dump или потери хоста

1. Сохранить все исходные файлы, partials и копии. Остановить/отсечь прежний
   executor, API и publishers; проверить отсутствие активных workflow и writers.
   Перед восстановлением запуск API разрешён только с writers disabled.
2. В изоляции восстановить dump; проверить owners/ACL/default privileges,
   triggers, data hashes и sequence state штатным backup harness. Права runtime
   не должны допускать UPDATE/DELETE/TRUNCATE append-only таблиц.
3. Собрать независимый полный набор receipt bytes из свежего сохранённого local
   journal и копий. Старый backup сам по себе может не содержать поздние операции.
   Проверить каждый SHA256 и каноническую receipt schema; сравнить с полным
   **all versions** перечислением `_publication-ledger/` (все страницы).
4. `validateRecoveryEvidence` в `tools/release-catalog/recover.mjs` использует
   канонический API scanner. Допуск привязан к exact evidence digest/run/attempt/
   executor/epoch и действителен не более часа. Физическая fence и approval
   проверяются до и после сканирования. Неизвестные ключи, delete markers,
   потерянные версии, несоответствие независимому набору или превышение bounds
   прекращают восстановление. Исключение только для явно перечисленных
   `_publication-ledger/_storage-readiness/<UUID>.txt` технических объектов.
5. Проверить полученный план и включить его `reviewedPlanSha256` в protected
   admission. `applyCatalogRecovery` сначала фиксирует DB fences, повторяет scan,
   сверяет digest и восстанавливает только occupancy. Ошибка оставляет fences.
   Prepared publication резервирует имена, но не доказывает COMMIT. Prepared
   channel без подтверждения не является разрешением вернуть старый pointer.
6. Pointer visibility и новый writer epoch требуют отдельного reviewed activation:
   проверить полную цепочку channel revisions и последнее применённое состояние,
   полные pinned bytes, историю namespace и отсутствие старых executors. Эти
   инструменты возвращают `writersMayEnable=false`; не менять это поле вручную.

Потеря S3 ledger или недоказанная полнота независимого журнала делает безопасное
автоматическое восстановление writes невозможным. Сохранить evidence и оставить
namespace закрытым. Не применять last-writer-wins, current-head GET, blind retry,
ручную правку журналов или откат edge к чтению mutable S3.
