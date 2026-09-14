# P1D.1: готовность клиентов и preview пилотной группы offline grants

Статус: **поэтапный дизайн P1D согласован пользователем 2026-09-14; этот документ
фиксирует первый этап и ожидает итогового просмотра перед планом реализации**.

## 1. Цель

P1D.1 даёт оператору платформы проверяемый ответ на два вопроса:

1. какие Station, ТСД и киоски действительно готовы получить `strict` для
   `offline-grants-v1`;
2. что произойдёт с выбранной пилотной группой, если на следующем этапе создать
   новую policy revision с этим rollout.

Этап не активирует `strict`, не изменяет подписки и не создаёт новую lifecycle
policy. Он добавляет клиентское подтверждение установленной конфигурации,
read-only серверный отчёт и read-only preview группы.

## 2. Исходное состояние и границы доказательства

После P1C и первых частей P1D сервер уже:

- выдаёт подписанные device/task grants через аутентифицированные native routes;
- возвращает configuration и keyset даже в режиме восстановления;
- хранит неизменяемые переходы `observe`/`strict` в
  `device_grant_configurations`;
- выбирает rollout только из hash-verified approved lifecycle policy;
- сохраняет выдачи, evidence, consumption и credential epoch;
- позволяет создавать и утверждать observe-ready policy в SaaS Admin.

`device_grant_configurations` доказывает, что сервер сформировал состояние. Он не
доказывает, что клиент получил ответ, проверил ключи и сохранил его до перезапуска.
`lastSeenAt` доказывает только успешную native-аутентификацию. Номер приложения
сам по себе также не является доказательством работоспособности протокола.

P1D.1 вводит отдельный self-report клиента, связанный с реально выданным grant.
Отчёт явно показывает self-reported и server-observed факты. Ни один из них не
называется физической или производственной приёмкой.

## 3. Декомпозиция P1D

- **P1D.1, этот проект:** подтверждение клиента, отчёт готовности и preview
  пилотной группы.
- **P1D.2:** prepare/confirm активации с request identity, snapshot digest,
  повторным чтением фактов и созданием неизменяемой policy revision.
- **P1D.3:** согласованный пилот, observe soak, выборочный `strict`, проверка
  восстановления и перевод следующих групп.

Производственные значения длительностей, состав пилота и решение о включении
остаются операторскими решениями. P1D.1 не подставляет их автоматически.

## 4. Принципы

1. **Fail closed для статуса готовности.** Отсутствующий, устаревший или
   противоречивый факт делает устройство неготовым.
2. **Никакой активации из preview.** Readiness API не меняет policy, подписку,
   configuration mode или cohort.
3. **Native identity остаётся владельцем факта.** Station/ТСД используют
   `TenantGuard -> StationOnlyGuard -> SubscriptionAccessGuard`; киоск использует
   `KioskDeviceGuard -> SubscriptionAccessGuard`. Cabinet session и public API key
   не могут отправлять client report.
4. **Platform boundary остаётся отдельной.** Межклиентский отчёт доступен только
   platform principal с явными capabilities. Tenant session не видит другие
   организации.
5. **Версия информирует, протокол доказывает.** `clientBuild` отображается
   оператору, но eligibility зависит от совпавшей конфигурации и проверенной
   серверной выдачи.
6. **История сохраняется.** Credential recovery, новая policy или key rotation не
   переписывают старый client report.

## 5. Клиентское подтверждение готовности

### 5.1 Native routes

Добавляются negotiated routes:

- `POST /station/grants/v1/readiness` для Station и ТСД;
- `POST /kiosk/grants/v1/readiness` для киоска.

Они используют существующую native-аутентификацию и
`@AllowSubscriptionReadOnly("read")`, чтобы восстановление оставалось доступным
при ограниченной подписке. Тело строгое:

```ts
type GrantClientReadinessRequest = {
  protocol: "offline-grants-v1";
  capability: "offline-grants-readiness-v1";
  requestId: string; // UUID, idempotency identity
  clientBuild: string; // 1..100, display and audit only
  storageRevision: number; // positive integer owned by the native client
  installed: {
    mode: "observe" | "strict";
    policyRevision: string | null;
    keysetRevision: string | null;
    verifiedGrantId: string | null; // UUID from a locally verified device grant
  };
};
```

Клиент отправляет запрос только после того, как configuration и keyset прошли
проверку, записались в durable store и были перечитаны из него. Если подписанный
device grant доступен, клиент сначала проверяет JWS, owner, credential epoch,
policy revision, key ID и deadline, сохраняет его, перечитывает и передаёт его
`grantId`. `verifiedGrantId: null` сохраняет диагностический отчёт, но не даёт
готовность к `strict`.

Сервер под блокировкой текущего device owner:

1. повторно проверяет tenant, device kind, credential identity и epoch;
2. загружает последнюю выданную configuration для этого owner;
3. сравнивает mode и policy revision;
4. сравнивает keyset revision с текущим серверным keyset;
5. для `verifiedGrantId` загружает tenant/owner-scoped device issuance и проверяет
   credential epoch, policy revision, header kid и отсутствие retirement;
6. сохраняет исходный self-report и вычисленную сервером классификацию.

Ответ:

```ts
type GrantClientReadinessResponse = {
  protocol: "offline-grants-v1";
  requestId: string;
  receivedAt: string;
  accepted: true;
  matchesCurrentConfiguration: boolean;
  verifiedGrantMatched: boolean;
};
```

`accepted: true` означает сохранение отчёта, а не готовность к rollout.

### 5.2 Идемпотентность

Identity состоит из tenant, owner kind, device ID, credential epoch и requestId.
Повтор с тем же canonical payload возвращает исходный ответ. Другой payload с тем
же identity возвращает `409 GRANT_READINESS_REQUEST_CONFLICT`. Credential rotation
создаёт другой namespace, но старый report остаётся историческим и не считается
текущим.

### 5.3 Хранение

Новая append-only таблица `device_grant_client_readiness_reports` содержит:

- owner columns и credential epoch;
- `request_id`, `payload_digest`, `client_build`, `storage_revision`;
- заявленные mode, policy revision, keyset revision и grant ID;
- server-derived `configuration_id`, matched `verified_grant_id`,
  `matches_current_configuration`, `verified_grant_matched`;
- `received_at`.

Уникальный ключ: `(tenant_id, owner_kind, concrete_device_id,
credential_epoch, request_id)`. Constraint владельца повторяет существующий
station/handheld/kiosk pattern. Индексы latest-by-owner поддерживают отчёт без
tenant-wide повторных сканов.

Payload digest вычисляется сервером по принятой canonical JSON функции. Таблица не
хранит private keys, compact JWS, device token или API key.

## 6. Модель готовности

### 6.1 Server-observed facts

Для каждой активной station/handheld/kiosk записи отчёт читает:

- tenant и отображаемое имя;
- device ID, kind, name, credential epoch, revoked/status, assignment и
  `lastSeenAt`;
- текущую подписку, plan version и approved lifecycle policy;
- наличие серверного signing/keyset configuration;
- последнюю выданную device configuration;
- последний client readiness report текущего epoch;
- связанную device grant issuance;
- наличие принятых или duplicate evidence как отдельный диагностический факт.

Evidence не является обязательным: новый клиент может доказать установку и
проверку grant до первой реальной offline-операции. UI показывает observe evidence
отдельно, чтобы оператор видел глубину фактической проверки.

### 6.2 Eligibility

Устройство `eligible` для preview `strict`, если одновременно:

- native credential активен, устройство не отозвано и занимает текущее working
  device assignment;
- существует действующая подписка с выбранной approved policy;
- серверная подпись настроена и текущий keyset не пуст;
- клиентский отчёт получен не раньше чем за 24 часа до `asOf`;
- report относится к текущему credential epoch;
- установлен `observe` для target policy revision и текущей keyset revision;
- `verifiedGrantId` принадлежит этому owner и был выпущен под target policy;
- ключ выдачи не retired;
- последняя native-аутентификация не старше client report.

Переход к `strict` не требует, чтобы device grant оставался неистёкшим в момент
просмотра: deadline ограничивает сам grant, а успешная проверка подтверждает
реализацию протокола. Preview показывает возраст выдачи и отчёта.

### 6.3 Reason codes

Каждое неготовое устройство возвращает стабильный непустой набор из:

- `credential_inactive`
- `device_revoked`
- `working_assignment_missing`
- `subscription_missing`
- `target_policy_not_current`
- `target_policy_not_approved`
- `signing_not_configured`
- `configuration_missing`
- `client_report_missing`
- `client_report_stale`
- `credential_epoch_mismatch`
- `configuration_mismatch`
- `keyset_mismatch`
- `verified_grant_missing`
- `verified_grant_mismatch`
- `grant_key_retired`

Reason codes вычисляются сервером; клиент не присылает eligibility.

## 7. Platform API

### 7.1 Список готовности

`GET /platform/offline-grants/readiness`

- capability: `tenants.read` и `catalog.read`;
- фильтры: tenant ID, device kind, readiness (`eligible`/`blocked`), policy ID;
- cursor pagination, default 50, maximum 100;
- deterministic order: tenant ID, kind, device ID;
- ответ содержит `asOf`, строки устройств и агрегаты по reason code;
- не возвращает credentials, JWS, payload evidence или private configuration.

Это snapshot read. Страницы связываются opaque cursor с `asOf`; если cursor не
соответствует фильтрам, сервер возвращает `400`.

### 7.2 Preview группы

`POST /platform/offline-grants/readiness/preview`

- capabilities: `tenants.read`, `catalog.read`, `catalog.write`;
- тело: `{policyId, mode:"strict", deviceIds, requestId}`;
- от 1 до 200 уникальных device IDs;
- policy должна быть approved, hash-valid и текущей policy каждой выбранной
  подписки;
- один запрос может включать несколько tenants, но каждый ID разрешается через
  platform boundary и возвращается с tenant identity;
- транзакция read-only с одним `asOf` и согласованным snapshot;
- ответ содержит eligible/blocked rows, reason aggregates и `previewDigest`.

`previewDigest` связывает target policy ID/revision, mode, sorted device IDs,
каждый eligibility result, credential epoch, configuration identity, client
report identity, current keyset revision и `asOf`. Он предназначен для будущего
P1D.2 prepare/confirm и сам по себе ничего не разрешает.

## 8. SaaS Admin

В `Catalog -> Offline policies` добавляется вкладка **Rollout readiness**:

- выбор approved policy;
- фильтры tenant, device kind и status;
- таблица с tenant, устройством, assignment, `lastSeenAt`, client build,
  storage revision, policy/keyset match, grant verification и observe evidence;
- reason codes переводятся в понятные действия;
- чекбокс доступен только для `eligible`, но blocked строки остаются видимыми;
- выбранные устройства отправляются в preview;
- preview drawer показывает точный cohort, `asOf`, digest и причины блокировки.

Основная кнопка называется **Проверить пилотную группу**. В P1D.1 нет кнопок
«Включить», «Подтвердить» или «Strict». Закрытие drawer с изменённым selection
использует существующую dirty-state защиту. Повторный preview не заменяет
предыдущий результат молча: UI показывает новое `asOf` и digest.

## 9. Ошибки и конкурентность

- Native report с неизвестным grant/configuration сохраняется как accepted
  diagnostic с false match; malformed DTO возвращает `400` и не пишет строку.
- Потерянный HTTP-ответ восстанавливается повтором того же requestId.
- Revocation или credential rotation между чтением и записью native report
  сериализуется owner lock и делает старый report историческим.
- Preview блокирует только чтение согласованного snapshot и не берёт device rows
  `FOR UPDATE`.
- Изменившаяся subscription, policy, configuration, keyset, epoch или assignment
  меняет digest. P1D.2 обязана повторить все факты перед confirm.
- Отсутствие одного tenant/device не скрывает остальные строки: preview возвращает
  precise blocked result для каждого переданного ID. Не-UUID и дубликаты
  отклоняются целиком на contract boundary.

## 10. Аудит и наблюдаемость

Native readiness report создаёт tenant audit event с device actor domain,
requestId, client build, storage revision и match booleans. Он не записывает JWS
или key material.

Platform preview создаёт platform audit event с actor, policy, количеством
eligible/blocked, reason aggregates и preview digest. Список готовности остаётся
обычным read и не создаёт audit flood.

Метрики разделяют received reports, matched reports, blocked previews и reason
codes. Они не объявляются количеством физически проверенных устройств.

## 11. Миграция и совместимость

Миграция с таблицей client reports должна завершиться до кода, принимающего новые
native routes или читающего readiness. Старые клиенты продолжают работать в
`observe`; они получают `client_report_missing` и не могут попасть в strict
preview.

Существующие configuration, issuance, evidence и native DTO не расширяются.
Новые routes и schemas negotiated отдельно, поэтому strict parsers старых
Station/ТСД/киоск версий не ломаются. Новая client версия сначала выкатывается в
observe и начинает отправлять reports; только после этого P1D.2 может готовить
активацию.

Rollback серверного кода не удаляет reports. Старые writers их игнорируют.
Rollback native клиента сохраняет уже установленный grant store; readiness
становится stale через 24 часа и не даёт новое право на strict.

## 12. Проверка

### Contracts и schema

- strict Zod schemas, duplicate/limit checks и OpenAPI coverage;
- migration/schema constraints, composite tenant FKs и latest indexes;
- idempotent replay и changed-payload conflict;
- cross-tenant grant/configuration rejection.

### API

- Station, handheld и kiosk owner paths;
- revoked credential, epoch rotation и concurrent report;
- current/missing/mismatched configuration, policy и keyset;
- owned/foreign/retired-key device grant;
- exact eligibility reason sets;
- read-only paginated list and snapshot cursor;
- preview limits, deterministic digest, multi-tenant platform authorization and
  zero mutation of policies/configurations/subscriptions.

### Native clients

- durable install -> reopen -> report ordering;
- no report after failed persistence or failed JWS verification;
- same request replay after lost response;
- report refresh after policy/keyset/credential change;
- legacy clients continue observe behavior.

### SaaS Admin

- capability-gated read/write controls;
- eligible-only selection, reason rendering and filters;
- dirty close protection;
- stale preview replacement is explicit;
- API bodies parsed by shared contracts.

Automated tests do not prove Windows DPAPI/filesystem behavior, Android vendor
scanner storage behavior, kiosk service-worker replacement, real clock drift,
factory network loss or operator recovery. Эти проверки переходят в P1D.3 pilot
evidence.

## 13. Вне P1D.1

- создание rollout policy revision;
- prepare/confirm activation и отмена preparation;
- автоматическое расширение cohort;
- включение strict в production;
- удалённый мгновенный отзыв уже выданного offline authority;
- изменение коммерческих правил тарифов, дополнений, услуг, КП или счетов;
- утверждение производственных длительностей и состава пилота.

## 14. Критерии завершения

P1D.1 завершён, когда:

1. все три native клиента после durable install отправляют аутентифицированный
   report, связанный с реальной device issuance;
2. сервер хранит append-only историю и вычисляет eligibility только из текущих
   server facts;
3. platform operator видит bounded paginated report и получает immutable preview
   digest для выбранной группы;
4. SaaS Admin не имеет пути активации strict;
5. старые клиенты продолжают observe и явно отображаются как неготовые;
6. package gates, API DB tests, native persistence tests и production bundle
   contracts проходят;
7. hardware, deployment и pilot acceptance перечислены как `NOT RUN`, пока для
   них нет отдельного evidence.
