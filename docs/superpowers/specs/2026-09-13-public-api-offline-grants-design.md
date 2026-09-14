# P1B.3b + P1C: публичный API и офлайн-допуски

Дата: 2026-09-13. Статус: согласовано пользователем 2026-09-13; реализация выполнена по двум планам; итоговые проверки отражены в документе приёмки.
Проверенная база: origin/main `0f94a767263ea27f6c265fe6200c65a43283f6f3`, PR #556.

## Подтверждённый объём

Пользователь поручил взять оба этапа вместе и подтвердил первый публичный сценарий:
чтение каталога товаров и полный цикл подготовки и запуска инвентаризации.
Интеграция создаёт задание, загружает исходные данные, фиксирует состав, запускает
задание, читает прогресс и результаты. Работу выполняют устройства.

P1C охватывает Station, ТСД и киоск: ограниченный допуск к новой работе,
ограниченное завершение ранее разрешённой работы и независимое сохранение evidence.
Продажа тарифов, подписок, дополнений и услуг, создание КП и счетов продолжают
работать без обязательной дополнительной политики жизненного цикла.
ЧЗ, включая Национальный каталог, остаётся единым модулем chzIntegration.

Промышленное включение ограничений, реальный пилот и изменение коммерческих сроков
относятся к P1D. P2 регулярных услуг в эту программу не входит.

## Что подтвердил текущий код

- `ApiKeysService` выдаёт ключи configId=public, metadata.kind=public, но без scopes.
  `TenantGuard` принимает кабинетную сессию либо station key; отдельного public
  principal для исполнения нет.
- `EntitlementAdmissionService` работает в shadow и не является разрешением на
  выполнение. Нельзя использовать его fail-open обработку ошибок в новой защите API.
- Создание, импорт, snapshot и запуск инвентаризации используют actorUserId.
  В БД есть пользовательские ссылки и ограничения. Ключ нельзя выдать за пользователя.
- Запуск принимает готовый snapshot. Простые create/start endpoints не дают
  интеграции полного сценария без загрузки исходных данных и фиксации snapshot.
- Station имеет credential/task leases и восстановление печати; Android имеет
  собственные DeviceRecovery, generation и Room transactions. Локальные generations
  не являются серверным поколением ключа.
- Киоск уже имеет subscription recovery и reservation paths; новый допуск должен
  сохранять их идемпотентность и семантику очередей.

## Рассмотренные интерфейсы

### A. Один небольшой фасад

```ts
interface Admission {
  runOnline(
    principal: PublicPrincipal,
    operation: PublicOperation,
    owner: OnlineOwner,
  ): Promise<Result>;
  issueDeviceGrants(principal: DevicePrincipal, task: FrozenTask): Promise<GrantSet>;
  runDevice(intent: DeviceIntent, owner: DurableDeviceOwner): Promise<Result>;
}
```

Пример: `admission.runOnline(publicPrincipal, inventoryStart, inventoryOwner)`.
Фасад скрывает проверку ключа, расчёт прав, подпись и локальные leases. Методов мало,
но серверная транзакция и локальная запись выглядят слишком похожими, хотя имеют
разные гарантии. Без обязательного owner protocol callback не обеспечивает атомарность.

### B. Общий реестр исполнения

```ts
interface PublicOperations {
  execute<K extends PublicOperationId>(
    principal: PublicPrincipal,
    operation: K,
    input: InputOf<K>,
  ): Promise<ResultOf<K>>;
}
interface OperationSpec {
  id: VersionedOperationId;
  bindings: readonly TransportBinding[];
  offline: "forbidden" | "device" | "frozen_task";
}
```

Пример: `publicOperations.execute(principal, "inventory.start", input)`.
Реестр скрывает сопоставление scopes, модулей и адаптеров. Удобен для проверки
покрытия большого числа операций, но рискует стать вторым механизмом бизнес-логики
рядом с существующими сервисами. Наличие декларации не доказывает проверку у записи.

### C. Отдельные механизмы, общий расчёт прав — рекомендуется

```ts
interface PublicRequestAdmission {
  prepare(
    principal: PublicPrincipal,
    operation: PublicOperation,
    scope: ValidatedScope,
  ): Promise<PreparedRequest>;
  atOwnerBoundary(request: PreparedRequest, owner: OwnerTransaction): Promise<PublicDecision>;
}
interface DeviceGrantIssuer {
  issueDevice(principal: DevicePrincipal): Promise<GrantIssueResult>;
  issueTask(principal: DevicePrincipal, task: LockedFrozenTask): Promise<GrantIssueResult>;
}
interface DeviceGrantVerifier {
  install(grant: SignedGrant, owner: CurrentCredentialOwner): Promise<InstallResult>;
  assessNewWork(intent: NewWorkIntent, commit: DurableCommitContext): LocalDecision;
  assessCompletion(intent: FrozenTaskEvent, commit: DurableCommitContext): LocalDecision;
}
```

Пример: public controller аутентифицирует ключ, prepare собирает факты, владелец
инвентаризации вызывает atOwnerBoundary под своими блокировками. Устройство
устанавливает task grant и проверяет каждое производственное действие в существующей
границе записи; расход лимита и локальный факт сохраняются атомарно.

Специализированные интерфейсы скрывают разные механизмы времени, подписей и
транзакций. Методов больше, но ошибочно применить public key к устройству сложнее.
Используем существующий реестр для деклараций и покрытия, не переносим в него
исполнение бизнес-операций. Сигнатуры здесь описывают границы, а не готовые типы кода.

## Публичный API

Новая версионированная поверхность `/public/v1` получает собственный guard и
проверенный principal `{ tenantId, keyId, scopes }`. Tenant берётся из ключа.
Кабинетная сессия, station key, kiosk token, signer и CommerceML не дают доступ
к этой поверхности. publicApi не добавляется в native-пути.

Первый набор scopes и маршрутов:

| Scope                 | Поверхность                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| catalog.products.read | GET /products, GET /products/:id                                                        |
| inventory.read        | GET /inventories, /inventories/:id, /inventories/:id/progress, /inventories/:id/results |
| inventory.prepare     | POST /inventories, /inventories/:id/imports/:status, /inventories/:id/snapshots         |
| inventory.start       | POST /inventories/:id/start                                                             |

Пути в таблице относительно `/public/v1`. Результаты имеют отдельную публичную
проекцию и пагинацию: внутренние credential/operator fields не экспортируются.
Подготовка использует существующие tenant-owned productId, lineId и templateId.
Их создание через API не добавляется; вызывающая сторона получает нужные ID из
настройки интеграции в кабинете. Импорт принимает существующие поддерживаемые
форматы и ограничения; фиксация использует явно выбранные imports.

Запуск делает frozen-задание доступным устройствам. Он не имитирует сканирование,
не запускает устройство удалённо и не создаёт регуляторную отправку.

Каждый запрос проверяет действительность ключа, purpose, срок, scopes и tenant.
Дополнительно проверяются publicApi и модуль операции: inventory для работы
с инвентаризацией. Импорт сохранённых файлов ЧЗ сам по себе не выполняет вызов ЧЗ.
Отсутствие publicApi не закрывает сохранённые данные в авторизованном кабинете.

Для новой public-поверхности коммерческое разрешение обязательно; unknown не allow.
Это отдельный исполняющий путь, существующие shadow owners не переключаются целиком
в enforce. Перед запуском в production проверяется совместимость источников прав.

Scopes назначаются явно при выпуске или редактировании ключа уполномоченным
пользователем. Старые unscoped keys не становятся wildcard. Срок существующих ключей
не сокращается автоматически. Сохраняется действующий публичный rate limit.

Мутации требуют Idempotency-Key. Tenant, key identity, operation и canonical payload
входят в идентичность запроса; файл сравнивается по digest исходных байтов. Повтор
того же запроса возвращает сохранённый результат, другой payload даёт конфликт.
Аутентификация и tenant-проверка обязательны также для replay. Транспортный сбой
не создаёт второе задание, импорт или запуск. Аутентификация проверяется повторно
у владельца эффекта; порядок блокировок фиксируется и проверяется конкурентными тестами.

Аудит хранит domain=api_key и стабильный keyId, issuer хранится отдельно как
provenance назначения прав. Отзыв ключа не уничтожает историческую идентичность
действий. Для выбранных владельцев добавляется явный actor union с миграцией
пользовательских полей/constraints и историческим cabinet backfill. Старые записи
и документы не переатрибутируются другому автору.

## Офлайн-допуски

Сервер выдаёт два разных вида подписанных разрешений:

1. Device grant: новая работа до startNotAfter в разрешённых capabilities.
2. Task grant: завершение конкретного ранее разрешённого frozen-задания до
   completeNotAfter, с taskId, snapshot digest, типами событий и границами объёма.

Общие поля: version, issuer, grantId, tenantId, durable deviceId, device kind,
серверная credential epoch, entitlement revision, policy revision, issuedAt,
notBefore и точные границы времени. Серверная epoch меняется при замене credential;
допуск старой epoch не устанавливается в новом владельце. Поздний ответ сервера
не преодолевает локальный credential/task lease.

Новая работа требует и действительного device grant, и действующей авторизации
оператора/задачи. Task grant не создаёт следующую смену, не меняет товар или snapshot.
Для смены допустимый остаток ограничивается заранее выданными задачей и контейнерными
пределами; без заданных пределов completion grant не выдаётся. Для инвентаризации
используются её frozen scope и допустимые события. Для киоска завершение привязано
к разрешённому заказу/reservation и его строкам. Один бесконечно открытый task
не продлевает производственную работу.

Срок new-work = минимум из утверждённого максимума offline и применимой границы
paid/trial/grace. Completion имеет отдельный утверждённый предел. Неутверждённая
политика даёт policy_not_configured при выдаче, но не включает новые ограничения
существующим клиентам и не блокирует коммерческий каталог.

Формат: compact JWS, фиксированный ES256 (P-256/SHA-256), защищённые typ, kid, alg.
Верифицируются исходные подписанные байты; пересериализация payload перед проверкой
не допускается. JWS-подпись — 64 байта R||S. Алгоритм не выбирается произвольным
значением из токена. Kotlin adapter преобразует формат подписи для выбранного
стандартного провайдера; общие fixtures доказывают идентичное поведение.

Обоснование формата: [RFC 7518 §3.4](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.4),
[Web Crypto ECDSA](https://www.w3.org/TR/WebCryptoAPI/#ecdsa),
[Android Signature](https://developer.android.com/reference/java/security/Signature).
Это выбор протокола; совместимость конкретных клиентов ещё предстоит проверить.

Private signing key доступен только серверу. Проверочные ключи заранее поставляются
с клиентом; обновление keyset допускается только через доверенный канал текущего
сервера и привязывается к его origin. Сначала распространяется новый ключ, затем
переключается signer. Старые public keys сохраняются для проверки истории и выданных
допусков. Неизвестный kid не предоставляет новое право; компрометация — отдельный
security retirement. Мгновенный отзыв на отключённом устройстве не обещается.

Часы используют доверенную серверную точку, monotonic elapsed в текущей загрузке
и сохранённый high-water mark. Перезапуск процесса не обновляет срок. Обнаруженный
откат либо недостоверное время после перезагрузки переводят strict admission в
clock_untrusted до доверенной синхронизации. Работа с уже записанными evidence
сохраняется. Защита от полного изменения устройства/хранилища не заявляется.

Допуски, расход ограниченного объёма и локальные события сохраняются в существующей
БД клиента. Station использует held-connection transaction либо принятые в проекте
атомарные SQLite commands; отдельные pooled вызовы BEGIN/COMMIT недопустимы.
Android использует Room и существующий generation lease. Киоск сохраняет IndexedDB
очереди и idempotency reservations. Печать сохраняет состояния delivery unknown и
восстановление сохранённых байтов; отказ допуска не доказывает отсутствие печати.

Evidence sync отделён от productive admission. При действительной recovery auth
принимаются и сохраняются ранее записанные batches, включая поздние и спорные.
Результаты различают accepted, duplicate и quarantined; принятие evidence не
означает признание его корректным производственным результатом. Отозванный ключ
не получает обход security: используется независимо авторизованный recovery path.
Истечение подписки или допуска не удаляет журнал, очередь либо незавершённую печать.

## Поставки и зависимости

1. **Общие договорённости и контракты.** Principal/actor boundaries, публичные scopes,
   idempotency, серверная credential epoch, протокол grants и signed fixtures.
   Публичные API DTO и native grant negotiation версионируются раздельно.
2. **P1B.3b — исполняющий API.** Ключи/scopes, аудит, миграции, публичные проекции,
   полный подтверждённый сценарий инвентаризации, кабинетная настройка интеграции,
   OpenAPI, тесты изоляции и конкурентности.
3. **P1C server.** Issuer, политики и keyset, хранилище issuance/provenance,
   negotiated grant endpoints и evidence/recovery classification.
   Эта поставка может идти параллельно п. 2 после согласования общих контрактов.
4. **P1C clients.** Station, ТСД и kiosk adapters отдельными проверяемыми изменениями:
   persistence, admission у локальной записи, часы, restart, recovery, интерфейс
   предупреждений без раскрытия коммерческих условий оператору.
5. **Совместная приёмка.** Сценарий API → frozen task → устройство offline →
   истечение/понижение прав → bounded completion → reconnect → evidence reconciliation.

Каждая поставка имеет отдельный reviewable diff. API можно принять независимо от
готовности аппаратной приёмки офлайн-клиентов. Для P1C серверная часть без клиентов
не считается завершением этапа.

## Совместимость и включение

- Старые native payloads не получают новые поля без negotiation, поскольку есть
  strict schemas и отдельные Kotlin consumers. Протокол grants имеет новую capability.
- Существующие клиенты продолжают текущий режим; новая версия сначала наблюдает
  решения. Отсутствие grant не превращается автоматически в блокировку производства.
- Strict offline mode доступен только при утверждённой policy, поддержанном клиенте
  и явном rollout. Его включение в production не входит в текущую реализацию.
- Миграции добавляются вперёд. При откате кода сохраняются grants, evidence, audit
  и idempotency receipts; несовместимая версия не пишет данные нового формата.

## Проверка и критерии завершения разработки

- API: каждый scope, tenant denial, неверный purpose, отзыв и expiry, отсутствие
  publicApi/inventory, unknown facts; native-пути не зависят от publicApi.
- Полный public workflow без сессии кабинета: create → imports → selected snapshot →
  start → progress/results. Повторы и гонки с отзывом, изменением прав, импортом и
  запуском; точные actor/tenant/action/target/outcome в аудите.
- Grants: одинаковые signed fixtures в TS и Kotlin, неверные подпись/alg/kid,
  tenant/device/epoch/snapshot, границы срока, budget и типов событий.
- Клиенты: restart, reboot/clock rollback, поздний ответ после смены credential,
  отключение сети во время commit/печати, повторный batch, исчерпание completion,
  downgrade и renewal без удвоения работы или потери очереди.
- DB: реальные forward migrations и concurrency tests; Station SQLite и Android
  upgrades проверяются отдельно. Shared dependencies собираются до consumer tests.
- Пакетные test/typecheck/lint/build, Android testDebugUnitTest/lintDebug/assembleDebug,
  OpenAPI/route inventory, форматирование, production contracts по затронутым областям.
- Браузерные проверки устройств/кабинета и настоящая Windows/ТСД/scanner/printer
  приёмка учитываются отдельно. Host tests и APK не доказывают работу оборудования.

## Текущее состояние этого проекта

Реализованы оба согласованных этапа: публичные маршруты подготовки инвентаризаций
и ограниченные офлайн-допуски для Station, ТСД и киоска. Выполнены проверки
контрактов, криптографических фикстур, PostgreSQL, SQLite, Room и IndexedDB;
пройдены независимые ревью и локальные браузерные сценарии.

Точные результаты общего прогона и ограничения проверок записаны в
[документе приёмки](../../acceptance/offline-device-grants.md).
Настройка производственных сроков и состава устройств, включение strict и
аппаратный пилот остаются отдельным этапом P1D.
