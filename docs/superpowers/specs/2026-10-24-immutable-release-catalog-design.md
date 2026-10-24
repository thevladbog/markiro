# Неизменяемые выпуски поверх Timeweb S3

Дата: 24 октября 2026. Статус: проект и точные права каталога утверждены владельцем 24 октября 2026; live gate хранилища пройден (15 проверок), план реализации подготовлен; продуктовый код ещё не изменён.
Независимая проверка проекта выполнена; замечания внесены в разделы истории и восстановления.
Это проверка проекта, не подтверждение реализации или готовности production.
База исследования: main 4cf3c8be9963942288b2fef86bbec0100c14c395, CI40040299441 SUCCESS.
Цель владельца: продолжить релизы без поддержки Timeweb и без ослабления защиты от перезаписи.
В поддержку ничего не отправлять: владелец отказался.

## Доказанное ограничение

В markiro-releases повторный PutObject с IfNoneMatch=* возвращает200 и новый
VersionId. Диагностика с фиксированным Content-Length, Content-MD5, отключённым
автоматическим CRC32 и подписанным if-none-match подтверждает тот же результат.
Это не объясняется отсутствием заголовка или chunked upload.
На первоначальной диагностике anonymous GET ?versionId= вернул403. После создания
утверждённого catalog-ключа signed GET точных исторических версий доказан: полный
hash старых байтов совпадает даже после новой записи под тем же ключом. Анонимный
доступ к historical versions не требуется и не открывался.
Источники: conditional-format-result.json, conditional-put-diagnostic.json.

Текущие tools/station-release/object-storage.mjs и tools/handheld-release/object-storage.mjs
рассчитывают на атомарный412. Caddy releases_upstream читает текущую версию ключа.
Standalone presigned PUT выдаётся прямо на окончательный путь; после регистрации
ещё действующий URL способен создать новую текущую версию. Его тоже надо закрыть.

## Решение

Timeweb S3 остаётся хранилищем байтов. PostgreSQL платформы становится единственным
реестром опубликованных выпусков и каналов. Каждый публичный путь неизменяемого
файла один раз связывается с bucket/key/VersionId/SHA256/размером/MIME.
Caddy сохраняет внешний URL, но запрашивает внутренний read-only resolver API,
который читает ТОЛЬКО закреплённый VersionId. Чтения текущей версии S3 и fallback
при ошибке каталога не существует. Сторонний query versionId игнорируется/отклоняется.

Это меняет границу атомарности: вместо неподдерживаемого условного S3 PUT —
атомарная регистрация в PostgreSQL. Запрет замены публичного файла остаётся,
а прямые неприкреплённые S3-объекты не являются опубликованными выпусками.
Злонамеренный S3 PutObject в тот же key не меняет уже закреплённый VersionId.
Удаление версий, изменение bucket policy и DDL принадлежат административной
границе; runtime/publisher такими правами не обладают, как и до изменения.

## Инварианты

1. У зарегистрированного immutable public path нельзя изменить или удалить binding.
2. У одной product/channel/version не может появиться второй набор байтов.
3. Повтор того же запроса с теми же digest/size/MIME и составом файлов идемпотентен;
   другой набор даёт409, существующая запись не меняется. Новый физический VersionId
   с теми же байтами не перепривязывает существующий путь.
4. Полный набор файлов версии и audit фиксируются одной DB-транзакцией. Частичный
   набор никогда не виден снаружи. До COMMIT каждый путь отвечает404/no-store.
5. latest/download — отдельные изменяемые ссылки на зарегистрированную release row.
   Обновление CAS по revision под блокировкой product/channel, с теми же правилами
   forward/explicit rollback, подписи, минимальной совместимости и audit, что сейчас.
6. После commit ни upload URL, ни повторная загрузка, ни истечение lease не меняют
   опубликованный файл. При cache miss сбой хранилища отвечает503/no-store; проверенный
   cache exact binding доступен при подтверждении binding в БД. Без подтверждения
   binding —503/no-store. Чтения latest S3 не существует.
7. Не доверять metadata sha256: сервер считает hash полных байтов точной версии S3.
   Не использовать ETag как SHA256. Все существующие подписи/сборочные proof сохраняются.

## Хранение и транзакции

Добавить schema/migration: publication intents, releases, immutable objects,
channel pointers. Уникальность product/channel/version и canonical public path;
FK гарантируют ссылку pointer на целую опубликованную версию. Role runtime имеет
SELECT/INSERT на immutable rows без UPDATE/DELETE/TRUNCATE; immutable guard trigger
запрещает UPDATE/DELETE также при ошибке прикладного кода. Миграционный owner — отдельный.
Интенты не публикуют данные и могут переходить в failed/committed. Idempotency key
привязан к actor, product/channel и полному digest запроса. Точный повтор при неизвестном
результате commit читает durable receipt; не делает новую публикацию.

Перед hash сервер создаёт intent с уникальным UUID и конкретными ожидаемыми именами,
размерами/лимитами и product/channel/version. Загрузка идёт в новые staging keys внутри
своего разрешённого product/* (например product/_uploads/intentUUID/file).
Клиент не выбирает произвольный bucket/key/public path. У presigned PUT остаётся
ограниченный срок из текущего контракта; неподписанные расширения не добавляются.
После upload сервер захватывает точный VersionId из HEAD и затем делает полный GET
именно этой версии. Параллельный поздний PUT создаст другую версию, но не изменит
проверяемую. Финальный DB commit использует короткую advisory/row lock, не удерживает
транзакцию во время загрузки/хеширования; unique constraints остаются последней защитой.
Блокировки имеют ограниченное ожидание; deadlock/serialization failure не превращать
в успешную публикацию. При rollback остаются только непубличные через releases host
staging bytes; автоматическое удаление в первой версии не добавлять.

## Авторизация

SaaS публикация Автонома сохраняет существующую platform capability, повторное
чтение членства и role, audit. Tenant/device credentials не получают доступ.

CLI Station/ТСД/reseed используют отдельный machine-publisher boundary с GitHub OIDC,
без статического ключа платформы в GitHub и без publisher S3 secret в runtime.
Зафиксировать issuer https://token.actions.githubusercontent.com, отдельный audience,
repository_id/owner_id из live GitHub, exact allowed workflow_ref + main ref,
protected environment station-release или handheld-release через sub, actor/run_id/
run_attempt, exp/nbf/iat. Workflow digest допускается только для проверенной версии
инструментов из deploy configuration. Reusable workflow claims проверять, если такой
workflow применяется; отсутствие обязательного claim — отказ, не fallback.
Issuer/JWKS адрес фиксирован, никакого jku/URL из запроса. Проверять алгоритм/подпись
стандартной библиотекой, срок и replay-bound intent. Environment approval остаётся.
station-release разрешает только station; handheld-release
только handheld. Подписант не выпускается в этой задаче. Клиент не выбирает scope.
Machine principal не получает tenant/platform administrative capabilities.

Добавление OIDC означает отдельные route-policy/OpenAPI/guard tests; это часть
решения, не временная публичная ручка. Текущие S3 ключи можно оставить для staging
uploads своих префиксов. Их права НЕ расширять до DeleteObject/PutBucketPolicy.

## Чтение pinned versions — предварительный gate

Выбран дополнительный сервисный ключ `markiro-releases-catalog` только для API:

- s3:GetObjectVersion на station/_, signer/_, handheld/_, standalone/_;
- s3:PutObject и s3:GetObjectVersion на _publication-ledger/*;
- s3:ListBucketVersions только с s3:prefix=_publication-ledger/*.
  Ни DeleteObject/DeleteObjectVersion, ни bucket administration, ни backup bucket.
  Два существующих ключа не меняются. Ключ catalog не попадает в GitHub. Исторические
  версии не открывать анонимно: resolver читает их этим узким ключом, отдаёт только
  зарегистрированные пути после полной проверки. Добавление этого точного сервисного
  доступа требует согласования владельца перед созданием.

Live gate после согласования: GET старой конкретной версии200 и полный hash совпадает
после нового PUT; неизвестный/malformed versionId fail closed; listing вне ledger403;
Put вне ledger403; backup bucket недоступен. GET текущей версии не используется.
VersionId при регистрации обязателен, ограничен по длине/кодируется для URL, пустой
и literal null отвергаются. Существующий bucket lifecycle сейчас не настроен;
перед rollout повторно проверить отсутствие expiration current/noncurrent versions,
включая _uploads и _publication-ledger. Закреплённые upload objects остаются данными
выпуска навсегда, несмотря на staging-имя; включать уборку этих prefixes запрещено.
Если эти gates не проходят — остановка, без чтения текущих ключей.

## Раздача и совместимость

Внешние path layouts и channel latest.json/download не меняются. Caddy по-прежнему
разрешает только GET/HEAD точных release layouts, убирает credentials/query от
клиента, CSP/CORS/cache сохраняются. Внутренняя API read route недоступна через
обычные SaaS/tenant paths. Resolver строит upstream URL из фиксированного endpoint,
проверенного bucket/key и записанного VersionId; arbitrary URL/SSRF невозможны.

Не отдавать клиенту bytes до проверки полной pinned версии. Перед отдачей resolver
скачивает в bounded temporary cache, проверяет размер/hash, fsync, публикует cache
атомарным hardlink/O_EXCL; существующий cache не перезаписывается. Ключ cache = binding
identity+sha256, каталог private с запретом symlink/path traversal. Concurrency downloads
bounded; недостаток диска ->503, никаких partial200. Cache удаляемый, не источник истины.
HEAD и single-range обслуживаются только после той же проверки; ETag из SHA256;
content length/MIME/disposition берутся из каталога, не из свежего S3 metadata.
Pointer body/version binding читается одной консистентной DB snapshot. latest no-cache,
immutable годовой cache; errors no-store. Cache limits и disk reserve обязательны
и выбираются из существующих размеров installers/host capacity до rollout.

Старые Station2.x артефакты из GitHub mirror валидируются прежними origin validators
и регистрируются в каталоге пакетами; existing byte/signature/tag evidence не меняется.
Autonom1.0.0 — текущая выпущенная версия; 1.1.0 кандидат, minUpgradeFrom1.0.0.
Для первого импорта его historical release record нужна проверенная подпись/байты,
а не только слова о версии; отсутствие baseline evidence блокирует import, не
позволяет изобретать запись. ТСД1.7.0(16) продолжает правила ранее выданной1.6.1(15).

## Сбои и восстановление

Crash после upload/hash до commit: не опубликовано, orphan retained.
Crash после commit до ответа: receipt повторно возвращается, дубль не записывается.
Отказ pointer CAS: новая version остаётся зарегистрированной, канал не меняется.
S3 текущая версия заменена: pinned GET/hash прежней версии, URL возвращает прежние байты.
S3 pinned version недоступна при cache miss:503 и alert, не fallback/перепривязка.
Уже полностью проверенный cache exact binding продолжает отдавать прежние байты;
отказ S3 не инвалидирует его. Отказ БД при невозможности подтвердить binding ->503.
До публичной видимости каждой публикации сохранить полный non-secret catalog receipt
на двух носителях: fsync/exclusive локальный append-only journal и versioned S3
_publication-ledger/<operationUUID>.json. Receipt содержит все bindings и release
identity/digests, но не actor IDs, секреты или клиентские данные; штатный audit остаётся
в DB. S3 VersionId receipt обязателен, полный exact-version GET/hash подтверждается
до DB commit visibility. Ни один writer не имеет DeleteObjectVersion; lifecycle off.
Этот протокол применяется ко ВСЕМ изменениям защищаемого состояния: bindings,
historical tombstones/range reservations и событиям channel pointers. Для pointer
receipt содержит ожидаемую и новую revision, прежний/новый release binding и вид
перехода (forward/explicit rollback); это не разрешение сменить канал без его штатных
проверок. Prepare receipt и подтверждение применённого DB commit различаются.
Неоднозначное применение события канала блокирует его восстановление до отдельной
сверки последнего применённого состояния; нельзя считать любой prepared receipt
успешным CAS или молча откатить канал к старому backup snapshot.

Порядок: DB durable intent/reservation -> full version verification -> fsync local
receipt -> S3 receipt version and full GET verification -> DB transaction делает
complete release visible и сохраняет receipt VersionId, затем отдельно pointer CAS.
При ошибке между journal и visibility receipt консервативно резервирует namespace;
точный retry может завершить ту же операцию, иной набор bytes409. Все неоднозначные
результаты write/commit выясняются чтением, не слепым повтором publish.

При DB/host restore writers выключены. Protected recovery останавливает/отсекает
старый executor, проверяет отсутствие активных публикаций, полностью перечисляет
ВСЕ версии _publication-ledger/ с полной пагинацией, сверяет pinned bytes/hash/schema
и строит union занятых public paths и всех tombstone/range reservations, включая
операции без подтверждённого COMMIT. Channel revisions восстанавливаются отдельной
проверкой цепочки событий и последнего применённого состояния; до её завершения
выдача указателей и новые CAS заблокированы. Потерянное/неоднозначное событие —
остановка соответствующего канала, а не автоматический rollback.
Конфликт binding -> fail closed, не last-writer-wins. Возвращённые current head S3
или ночной snapshot не считаются полным журналом. Полнота enumeration и отсутствие
удалённых receipt versions — обязательные условия recovery; не доказаны -> writers
не активировать. Trusted local ledger/независимые backup receipts используются для
сверки; каталог не "восстанавливается" из произвольного latest.json.
Потеря S3 ledger делает безопасное автоматическое восстановление writes невозможным;
это ограничение указать в runbook, а не обходить. Ночные encrypted копии включают
ledger receipts/versionIds дополнительно к DB; восстановление тестируется до rollout.

## Переход старого пространства имён

До включения любого writer импортировать полный набор уже занятых release paths,
подтверждённый GitHub mirror, signing records и сохранёнными backup artifacts.
Исторический путь с недоступными bytes получает отдельную permanent reserved row
без readable binding: читать404, публиковать по нему409. Инвентаризация не может
ограничиться лишь двумя текущими heads канала: нужны все когда-либо выпущенные версии.
Если полноту исторического product/channel namespace доказать нельзя, записать
conservative version-floor/tombstone range только из доверенной ВЕРХНЕЙ границы
ВСЕХ когда-либо выпущенных версий и не принимать любые старые версии. Последняя
сохранившаяся версия или текущий head после rollback такой границей не являются.
Если верхнюю границу установить нельзя, закрыть соответствующий namespace для
новых публикаций до восстановления истории; latest baseline не выдумывать. Для Автонома
1.0.0 не перепубликовывать без исходных проверенных artifacts; новые1.1.0 не объявлять
обновлением до отдельной проверки клиента/подписи. Range reservation не разрешает
reuse пререлизных имен на той же semver базе; сравнением владеет текущая product policy.
При rollout сначала writers disabled и import/reservation, затем read-only resolver
и внешний readback, потом atomically activate writer epoch. Старый direct-S3 path
с резервным чтением не оставлять. Откат UI/edge не должен возвращать mutable S3 reads;
при проблеме fail closed или прежняя проверенная раздача, но не обход каталога.

## Проверки и порядок реализации после утверждения

1. Exact catalog-key rights/version-read gate на техническом объекте; не создавать настоящие releases.
2. Schema/migration и DB tests: insert-only, unique, 2 конкурентных registrations
   разных bytes -> один winner, loser409; identical повтор; crash/ambiguous commit.
3. Store exact VersionId и verified cache tests: fake store игнорирует IfNoneMatch,
   смена current bytes не меняет published GET; wrong version/hash/size, timeout,
   partialstream, query injection, disk exhaustion все fail closed.
4. Platform + machine auth denial matrix, OIDC invalid issuer/aud/ref/workflow/repo/env,
   expiry, token replay across intents, scope escalation; точный audit.
5. CLI адаптеры Station/ТСД и SaaS Автоном upload/register/latest: прежние acceptance
   подписи/hash/version/provenance не удалять; заменить storage atomic primitive
   transaction registry, добавить тест позднего повторного presigned upload.
6. Caddy contract/browser tests: immutable/current pointers, range/HEAD/CORS/cache,
   wrongmethod/root/listing/query/versionId denied; no production network в unit tests.
7. Backup/restore всего ledger: bindings, reservations, channel revisions; старый DB
   snapshot не разрешает занять прежний путь или молча откатить канал. Unknown history
   и ambiguous pointer commit блокируют соответствующий namespace/channel. Isolated
   actual PG race tests.
8. Scoped PR/CI/review, exact merged main CI, новый protected publisher/deployment,
   fresh backup/restore, DNS/TLS. После live adversarial byte-swap proof — reseed,
   подпись/регистрация Автонома, ТСД. Windows/physical update отдельно.

## Не выбираем

HEAD+PUT или только GitHub concurrency: нет общей атомарности для всех writers.
Только hashes/signatures: обнаруживают подмену, но не сохраняют доступные прежние байты.
Только versioning/object lock: не удерживают текущую версию URL.
Убрать IfNoneMatch и принять200: явное ослабление запрещённого инварианта.
Новый платный провайдер/VM/домен не нужен; текущий S3 и PG сохраняются.

## Ограничение этой подготовки

Это архитектурный проект, не готовый hotfix. Новые DB schema/public resolver/machine
authorization меняют границы системы; до утверждения проекта нет продуктового кода,
миграций, новых permissions, production изменений или запуска релизов.
