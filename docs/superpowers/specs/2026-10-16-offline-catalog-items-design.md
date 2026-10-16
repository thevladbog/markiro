# Офлайн-доступные позиции каталога: тарифы и дополнения для клиентов без кабинета

Дата: 2026-10-16. Статус: реализовано в ветке `claude/exec-offline-catalog` (девять задач плана
`2026-10-16-offline-catalog-items.md`, расхождения — в его разделе «Отклонения при исполнении»); пять
решений владельца записаны дословно (раздел 2), остальное — решения автора с обоснованием (раздел 3);
ответы владельца на вопросы раздела 16 получены в тот же день. Заменено: ручной путь «Офлайн-условия»
(`source = offline`) — источник `offline_assignments`; строки старого пути остаются в журнале.

Связанные документы:

- `docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md` и план
  `docs/superpowers/plans/2026-09-29-tenants-without-cabinet.md` — клиент без кабинета
  (`organization.cabinet_access = 'none'`), отказ `catalog_kind_not_allowed_for_offline_tenant`,
  «Прямое назначение», выдача кабинета позже.
- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (§6.2 и «Решения
  владельца 2026-10-13», лежит в ветке `claude/integration`, в `origin/main` его ещё нет) — два пути выпуска
  лицензии автонома: `subscription` и `offline`.
- `docs/operations/standalone-licenses.md` — ключ, выпуск, «Что берётся в файл».
- `docs/superpowers/plans/2026-10-13-standalone-lc0-saas-offline-license-export.md` (там же) — план
  экспорта лицензий.

## 1. Зачем

Сегодня у клиента без кабинета нельзя оформить ни тариф, ни дополнение: страж
`assertKindAllowedForTenant` (`apps/api/src/subscriptions/tenant-cabinet-access.ts`) отказывает любому
`plan` и `addon` по одному только виду позиции. Поэтому решение владельца от 2026-10-13 ввело для таких
клиентов отдельные «офлайн-условия» при выпуске: оператор в диалоге выпуска вручную выбирает версию
тарифа и срок в днях. Права клиента при этом нигде не хранятся: нет записи «что у клиента куплено»,
дополнения (`addon`) выдать нельзя вообще, а следующий оператор не видит, на каких условиях выпущен
предыдущий файл, иначе как в журнале выдачи.

Нужно, чтобы права офлайн-клиента были теми же назначениями, что и у клиента с кабинетом (тариф плюс
дополнения с количеством, сроки, основание), а выпуск файла брал квоты и возможности из этих назначений
и ничем не отличался от пути «из подписки». Чтобы не открыть случайно кабинетные лицензии клиенту без
кабинета, позиции каталога получают признак «Доступно офлайн-клиентам»: назначить такому клиенту можно
только помеченную позицию.

## 2. Решения владельца (2026-10-16, дословно)

1. Флаг «Доступно офлайн-клиентам» — на ПОЗИЦИИ каталога (тариф и дополнение); хранение на уровне позиции
   или версии автор выбирает и обосновывает (раздел 3, Р1); редактируется в редакторе каталога, виден
   бейджем в списках; помеченные позиции остаются доступными и облачным клиентам (никакого вида
   «только офлайн»).
2. Назначение клиенту с `cabinet_access = 'none'` через существующую форму «Прямое назначение» (версия,
   начало, конец, основание) разрешено, когда позиция помечена офлайн, иначе остаётся прежний отказ;
   услуги разрешены, как сегодня; страж переносится с «только вид» на «вид + флаг»; предложения и счета
   для таких клиентов подчиняются тому же правилу.
3. Выпуск для клиента без кабинета берёт квоты и возможности из его действующих назначений (тариф +
   дополнения с количеством) точно так же, как путь из подписки; ручной путь «Офлайн-условия» (версия
   тарифа + срок в днях) заменяется; срок — конец назначения либо год от выпуска при бессрочном
   (то же правило, что у подписки); журнал и аудит записывают источник и идентификаторы
   назначений/ревизию.
4. Автоматического биллинга нет: назначение офлайн-клиенту само по себе не создаёт ни счетов, ни актов.
5. Если клиенту с офлайн-назначениями потом выдан кабинет, назначения остаются действительными, а диалог
   выдачи кабинета и ответ показывают предупреждение, что офлайн-назначения есть.

## 3. Решения автора сверх решений владельца

Каждое из них проверено по коду; где решение противоречит чему-то в коде, это сказано в разделе 14
(риски).

**Р1. Флаг хранится на позиции (`catalog_items`), а не на версии.** Опубликованная версия неизменяема на
уровне базы: триггер `catalog_item_versions_immutable_published` и триггеры неизменяемости
`plan_entitlements`/`addon_entitlements` (`packages/db/migrations/0030_saas_catalog_subscriptions.sql`) —
`RAISE EXCEPTION 'published catalog versions are immutable'`. Флаг версии пришлось бы ставить до публикации,
а уже опубликованные тарифы получили бы его только новой версией: новая версия с теми же правами ради
флага — искажение истории каталога. Флаг — свойство допуска («кому можно назначать»), а не коммерческое
условие, поэтому ему место там же, где `status` позиции (`active` | `archived`), которая тоже меняется
отдельным аудируемым действием (`POST /platform/catalog/items/:id/archive`, аудит
`catalog.item.archived`, `before`/`after`). Следствие: флаг действует на все версии позиции, прошлые и
будущие; назначение берёт версию, а страж смотрит флаг её позиции. Уже опубликованная позиция получает
флаг тем же аудируемым действием, без новой версии (Р3).

**Р2. Только `plan` и `addon`.** Позиция вида `service` флаг иметь не может: колонка защищена проверкой
`offline_available = false OR kind IN ('plan','addon')`, а маршрут отвечает `409 catalog_item_offline_kind_invalid`.
Услуги клиенту без кабинета и так разрешены.

**Р3. Отдельное действие `PATCH /platform/catalog/items/:id/offline-availability`.** Тело
`{ offlineAvailable: boolean, reason: string }`, основание обязательно, 1–1000 символов (как у «Прямого
назначения»). Это не правка версии и не новая версия: маршрут не входит в обёртку «коммерческой версии»
(`COMMERCIAL_VERSION_HEADER`), ответ один для всех клиентов. Повторная установка того же значения — `200`
без записи и без аудита (`changed: false`). Идемпотентность выбрана потому, что повтор формы после
сетевого сбоя — обычный случай, а аудит «ничего не изменилось» вводил бы в заблуждение (`archive`
ведёт себя иначе, но архивирование необратимо и повторяется редко).

**Р4. Кто меняет флаг: `catalog.write` и роль `platform_admin`.** Бухгалтер (`accountant`) имеет
`catalog.write` (черновики коммерческих версий), но «Прямое назначение» доступно только
`platform_admin` (`assertPlatformAdmin`, `direct_subscription_assignment_forbidden`). Флаг определяет, какие
лицензии вообще можно назначать вне кабинета; менять его тому, кому нельзя назначать, нелогично. Поэтому
маршрут требует `catalog.write` и проверяет роль в сервисе (`409 catalog_offline_availability_forbidden`, как
`direct_subscription_assignment_forbidden`). Новая платформенная возможность не вводится — она бы тронула
`platformCapabilitiesForRole` и все фикстуры принципала (корневой `AGENTS.md`).

**Р5. Снятие флага допускается.** Существующие назначения не отзываются и не пересчитываются: страж
смотрит флаг только в момент нового назначения/предложения/счёта. Ответ маршрута и запись аудита содержат
`offlineTenantHolders` — число клиентов без кабинета, у которых сейчас действует или запланировано
назначение любой версии этой позиции; UI показывает это число в подтверждении снятия. Альтернатива
(запрет снятия, пока есть держатели) отвергнута: она не защищает ничего, что уже выдано (выпуск файла
читает назначения, а не флаг), и блокировала бы вывод позиции из офлайн-продажи; зато остаётся риск
открытых документов (раздел 14, риск 6).

**Р6. Новое значение источника выпуска `offline_assignments`; старое `offline` остаётся только для
чтения.** Журнал выдачи (`standalone_license_issuances.source`) сейчас допускает `subscription` и
`offline`, а проверка формы связывает `offline` с причиной срока `offline_term` и планом `subscription`.
Путь «из назначений» даёт причины срока `subscription_end`/`entitlement_reduction`/`one_year_cap` — новая
запись под `offline` проверку не пройдёт, а переиспользовать `subscription` значило бы потерять различие
в журнале («клиент без кабинета» неотличим от клиента с кабинетом). Поэтому: новое значение, строки с
`offline` остаются как есть (раздел 11).

**Р7. Совместимость старого API выпуска: поле `offline` принимается, но отвергается.** Схемы запроса
предпросмотра и подтверждения строгие и содержат `offline: nullable`. Поле остаётся в схемах (иначе старая
сборка saas-admin, открытая в браузере во время выкладки, получила бы `400` на каждый запрос, в том числе
для клиентов с кабинетом, у которых она шлёт `offline: null`). Любое непустое значение — `409
standalone_license_offline_terms_removed` с понятным сообщением в UI, кроме повтора уже выполненного
запроса (раздел 11.3). Удаление поля из контракта — отдельным выпуском после выхода новой сборки
saas-admin (в плане не делается).

**Р8. Новый код отказа выпуска `standalone_license_assignments_required`** (409) для клиента без кабинета,
у которого нет действующего назначения тарифа. Код `standalone_license_subscription_required` остаётся
для клиента с кабинетом: UI показывает для них разные подсказки (ссылка «Изменить права клиента» только
у клиента без кабинета).

**Р9. Выдача кабинета не создаёт демо, если у клиента уже есть «текущая» подписка.** Индекс
`tenant_subscriptions_one_current_uq` допускает не более одной строки со статусом `pending_activation`,
`trial` или `active` на клиента (`0030_saas_catalog_subscriptions.sql:390`), а выдача кабинета сейчас
вставляет ожидающее демо (`insertPendingDemo`, `tenant-provisioning.service.ts`). Клиент с активным
офлайн-назначением тарифа нарушил бы индекс. Поэтому под блокировкой линии подписок: есть текущая
подписка — демо не создаётся (и `default_demo_not_configured` не требуется), назначения продолжают
действовать (решение 5 владельца); нет — демо создаётся, как сегодня (при только запланированной
подписке или истекшей прежней). Раздел 8.

**Р10. Снимок прав не сохраняется.** `EntitlementSnapshotV1` вычисляется по запросу
(`EntitlementsService.resolveSnapshotInTransaction`), таблицы снимков нет. Ничего для клиента без кабинета
не пишется отдельно; ревизию дают триггеры `entitlement_revision_*` на `tenant_subscriptions` и
`subscription_addons` (`0132_entitlements_p1a.sql`), они срабатывают для любого клиента.

**Р11. Журнал получает колонку `source_assignments` (jsonb, nullable)** со списком назначений, из
которых собраны права: `[{kind, id, catalogVersionId}]`. Аудит `standalone_license.issued` получает те же
данные в `after.sourceAssignments`. Для путей `subscription`/`offline` колонка пуста: историю не
переписываем.

**Р12. Мёртвый код ручных офлайн-условий удаляется** (`offlineTerms`, `exportPlanRights`,
`offlineValidity`, `OFFLINE_ENTITLEMENT_REVISION` и их тесты) — после того как выпуск перейдёт на
назначения. Причина срока `offline_term` и источник `offline` остаются в схемах и проверках БД: по ним
читаются старые строки.

**Р13. Раздел «Прямое назначение» показывается и клиенту без кабинета.** Сейчас `TenantPage.tsx` для
`cabinetAccess = 'none'` вместо `SubscriptionPanel` показывает только `Alert` с `documentsNotice`. Панель
рисуется и для такого клиента с флагом `offlineTenant`: список версий в форме фильтруется по
`offlineAvailable`, кабинетные счётчики использования скрываются.

**Р14. Поле `offlineAvailable` — обязательное булево во всех ответах каталога** (общая основа
`assignableCatalogVersionSchema`, от неё строятся V1–V4). Ответ API всегда его содержит; обязательность
ловит расхождение строгих контрактов, ценой правки фикстур (раздел 6).

## 4. Что проверено в коде

- `assertKindAllowedForTenant(tx, tenantId, kind)` — единственный страж; вызывается из
  `subscription-lifecycle.service.ts` (`assignPlanInTransaction`, строка 345; `assignAddonInTransaction`,
  строка 589), `billing.service.ts` (строка 165, для строк счёта, кроме `custom`) и
  `platform-offer-draft.ts` (строка 48). Он знает только вид; версия каталога ему не передаётся.
  `tenant-provisioning.service.ts` упоминает его в комментарии (выдача кабинета вставляет демо напрямую).
  Тесты: `apps/api/test/tenant-cabinet-access-guard.e2e.test.ts`, `grant-cabinet-access.e2e.test.ts`,
  `apps/saas-admin/test/offer-editor.test.tsx`.
- Оплаченная лицензия идёт через тот же страж: `applyPaidLicense` → `assignPlanInTransaction` /
  `assignAddonInTransaction`. Значит, платёж по счёту/предложению с помеченным тарифом для клиента без
  кабинета создаст подписку (это и есть «предложения и счета подчиняются тому же правилу»); автоматического
  создания счёта само назначение не вызывает (решение 4).
- Комментарий стража про гонку: подписочные пути держат advisory-замок линии подписок клиента
  (`lockTenantSubscriptionTimeline`, `subscription-locks.ts`), и выдача кабинета берёт тот же замок до
  переключения `none` → `enabled`. Предложения и счета замок не берут и безопасны, потому что
  `cabinet_access` движется только `none` → `enabled`.
- `catalog_items`: `id, code, name_ru, name_en, kind, status ('active'|'archived'), created_at, updated_at`;
  версии — `catalog_item_versions` (`draft|published|retired`). Сервис каталога
  `apps/api/src/modules/platform-catalog/platform-catalog.service.ts`: `lockItem` (`FOR UPDATE` строки
  позиции), `archive` (аудит `catalog.item.archived`), `toDto` (общие поля версии и позиции).
  Порядок замков каталога: позиция → версия; ни один каталожный путь не берёт замок клиента после этого.
- Выпуск: `standalone-license-issuance.service.ts`: `draft()` выбирает путь по `issuanceSourceFor(cabinetAccess)`;
  `offlineTerms()` читает `plan_entitlements` версии из тела запроса; `subscriptionTerms()` читает
  `EntitlementsService.loadSnapshotTimeline` и `licenseValidity` (`standalone-license-rights.ts`).
  Журнал и аудит пишутся в `confirm()`. Ограничение базы:
  `standalone_license_issuances_shape_check` связывает `source = 'offline'` с `valid_until_reason =
'offline_term'` и `plan = 'subscription'`.
- Снимок прав для клиента без кабинета считается теми же функциями: `EntitlementsService.resolve` не
  читает `cabinet_access`, членов и устройства сверх подсчёта использования (у такого клиента ноль).
  `sources` снимка содержит id плана и каждого дополнения (`entitlement-snapshot-reader.ts`).
- SaaS-админка: `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx` (форма «Прямое назначение»
  `tenants.assignment.title`; список версий — `GET /catalog/items` с `CURRENT_COMMERCIAL_VERSION = "4"`),
  `TenantPage.tsx` (панель скрыта при `cabinetAccess = 'none'`), `GrantCabinetAccessPanel.tsx` (выдача
  кабинета — встроенная форма с e-mail, не модальное окно), `StandaloneLicenseIssue.tsx` (диалог),
  `StandaloneSitesPanel.tsx` (`issuanceSource === "offline"` → `Alert offlineTenant`),
  `pages/catalog/CatalogPage.tsx`, `CatalogVersionPanel.tsx`, `pages/documents/CatalogPositionPicker.tsx`.
- Фраза «Изменить права клиента» в i18n сейчас не встречается; раздел назван «Прямое назначение»
  (`tenants.assignment.title`). Раздел 10 вводит ссылку с этим текстом на этот раздел (вопрос В2).
- `tools/production-browser`: офлайн-диалог выпуска не проверяется (grep по `offline`/`standalone`
  находит только фикстуру вкладки «Оборудование» с `cabinetAccess: "enabled"` и заголовок в
  `tenant-equipment-tests/workspace.spec.ts`). Фикстура каталога
  `tools/production-browser/service-periods-tests/fixture.ts` строит версии каталога и должна получить
  `offlineAvailable`.

## 5. Данные и миграция (следующий свободный номер — 0195)

`main` заканчивается миграцией `0194_standalone_support_diagnostics`. Проверить номер при написании кода:
`ls packages/db/migrations | tail -3`; если `main` ушёл вперёд, взять следующий и пересоздать снимок.

Миграция `0195_offline_catalog_items.sql` (генерируется `pnpm --filter @markiro/db db:generate`, проверяется
глазами; ограничение `shape_check` пересоздаётся вручную в сгенерированном файле):

1. `catalog_items.offline_available boolean NOT NULL DEFAULT false` — по умолчанию ложь, **backfill не
   нужен и не делается**: все существующие позиции остаются недоступными офлайн, пока оператор их не
   пометит.
2. `CHECK (offline_available = false OR kind IN ('plan','addon'))`, имя `catalog_items_offline_kind_check`.
3. `standalone_license_issuances.source_assignments jsonb` (nullable).
4. Пересоздание `standalone_license_issuances_shape_check`: список источников
   `('subscription','offline','offline_assignments')`; условие `(source = 'offline') = (valid_until_reason =
'offline_term')` остаётся (для нового источника причина срока не `offline_term`);
   `source NOT IN ('offline','offline_assignments') OR plan = 'subscription'`; новое условие на колонку:
   `(source = 'offline_assignments') = (source_assignments IS NOT NULL)` и
   `source_assignments IS NULL OR (jsonb_typeof(source_assignments) = 'array' AND
jsonb_array_length(source_assignments) BETWEEN 1 AND 65)` (тариф + до 64 дополнений).
   Существующие строки (`subscription`, `offline`) условия выполняют (колонка пуста).

Откат/восстановление: колонки и расширенное условие обратно совместимы; откат миграции не требуется для
работы прежнего кода, кроме строк `offline_assignments` (старый код их не прочитает — выкладывать откат
только вместе с удалением таких строк, что делать нельзя: журнал выдачи — история). Поэтому при отказе от
функции колонку и источник оставляем, а выпуск возвращаем флагом выкатки кода, не миграцией.

Схема Drizzle: `packages/db/src/schema/saas.ts` (`catalogItems.offlineAvailable`, проверка),
`packages/db/src/schema/standalone-licenses.ts` (`sourceAssignments`, пересозданная проверка). Тесты:
`packages/db/test/saas-schema.test.ts` (или новый `offline-catalog-items-schema.test.ts`), миграционный
тест `offline-catalog-items-migration.test.ts`; `standalone-licenses-migration.test.ts`/`-schema.test.ts`
обновить под новое условие; `standalone-support-diagnostics-migration.test.ts` сейчас проверяет
`journal.entries.at(-1)?.tag === "0194_…"` и сломается — заменить на поиск записи по имени и усечение
журнала до неё. После изменений `pnpm --filter @markiro/db build` до потребителей.

## 6. Контракты (`@markiro/platform-contracts`, схемы строгие)

Схемы, получающие поле или значение:

| Схема / файл                                                                           | Изменение                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assignableCatalogVersionSchema` (`tenants.ts:236`) — основа V1–V4 каталога и тенантов | `offlineAvailable: z.boolean()` (обязательное). V2, V3, V4 строятся от неё (`catalog.ts`, `catalog-v3.ts`, `catalog-v4.ts`), правок там не нужно |
| `platformCatalogContracts` (`catalog.ts`)                                              | новый `setOfflineAvailability: { params, body, response }`; V2–V4 наследуют маршрут через `...`                                                  |
| `STANDALONE_ISSUANCE_SOURCES` (`standalone-licenses.ts:133`)                           | `["subscription", "offline", "offline_assignments"]`                                                                                             |
| `sourceMatchesReason` (там же)                                                         | `offline` → причина `offline_term` и план `subscription`; `offline_assignments` → причина не `offline_term` и план `subscription`                |
| `standaloneIssuanceSummarySchema`                                                      | `sourceAssignments: z.array(assignmentRef).min(1).max(65).nullable()`                                                                            |
| `standaloneIssuancePreviewSchema.next`                                                 | `sourceAssignments` (nullable) — чтобы диалог показал таблицу прав и назначения                                                                  |
| `standaloneSiteListSchema.issuanceSource`                                              | новое значение источника                                                                                                                         |
| `grantCabinetAccessResponseSchema` (`tenants.ts`, не `.strict()`)                      | `offlineAssignments: { plans: int ≥ 0, addons: int ≥ 0 }`, `demoCreated: boolean`                                                                |
| `standaloneIssuancePreviewRequestSchema`, `standaloneIssuanceConfirmSchema`            | **без изменений** (`offline` остаётся, Р7)                                                                                                       |

Новые схемы: `catalogOfflineAvailabilityBodySchema = { offlineAvailable: boolean, reason: string 1..1000
}` (`.strict()`), `catalogOfflineAvailabilityResponseSchema = { catalogItemId: uuid, catalogItemCode,
kind: 'plan'|'addon', offlineAvailable, changed: boolean, offlineTenantHolders: int ≥ 0 }` (`.strict()`),
`standaloneAssignmentRefSchema = { kind: 'plan'|'addon', id: uuid, catalogVersionId: uuid }` (`.strict()`).

Потребители, которые надо править в одном изменении с контрактами (все строят объекты версии каталога
или строки журнала; найдены `grep -rln catalogItemCode:` и `grep -rln source:` по тестам):

- `packages/platform-contracts/test/{tenants,catalog,catalog-v3,commercial-terms,standalone-licenses}.test.ts`;
- `apps/api/test/{platform-catalog.e2e,commercial-v4.integration,standalone-license-issuance.e2e,
standalone-license-rights}.test.ts`, `apps/api/test/support/subscription-fixtures.ts` (создание позиции с
  флагом);
- `apps/saas-admin/test/{catalog,commercial-v2-fixtures,document-composer,create-invoice-source,
document-draft,standalone-fixtures,standalone-license-flows,standalone-api,standalone-sites-panel,
tenants-cabinet-access,tenant-detail}.test.ts(x)` и `render.tsx`;
- `tools/production-browser/service-periods-tests/fixture.ts`;
- `apps/api/test/platform-contract-openapi.test.ts`: `CURRENT_SHARED_SCHEMAS toHaveLength(266)` — число
  именованных схем изменится; новое значение брать из падения теста, не угадывать; и
  `apps/api/test/platform-route-contracts.ts` (новая строка маршрута), `subscription-route-inventory.test.ts`
  (если маршрут каталога там инвентаризируется; платформенные каталожные маршруты — через
  `platform-route-contracts`).

## 7. Страж: `assertKindAllowedForTenant` → вид + флаг

Новая сигнатура (функция переименовывается; все четыре вызова меняются, старое имя не сохраняется):

```ts
export async function assertCatalogAllowedForTenant(
  tx: Pick<Db, "select" | "execute">,
  tenantId: string,
  target: { kind: "plan" | "addon" | "service"; catalogVersionId: string | null },
): Promise<void>;
```

Логика: `kind === "service"` → допуск. Иначе читается `cabinet_access` клиента; `enabled` → допуск. `none`
→ читается позиция версии `catalog_item_versions.id → catalog_items.offline_available` с блокировкой
`FOR SHARE` строки позиции; допуск только при `offline_available = true`, иначе прежний
`ConflictException({ code: "catalog_kind_not_allowed_for_offline_tenant" })`. Версия не найдена или
`catalogVersionId = null` для `plan`/`addon` при `none` — тот же отказ (сервер — источник истины; строки
`custom` в счетах стража и сейчас не проходят).

Прежний код отказа сохраняется (UI и документы уже его показывают); сообщение в i18n уточняется: «…можно
продать услуги и позиции, помеченные как доступные офлайн-клиентам».

Вызовы: `assignPlanInTransaction` — `{kind:"plan", catalogVersionId: input.catalogVersionId}`;
`assignAddonInTransaction` — `{kind:"addon", …}`; счета `billing.service.ts` и предложения
`platform-offer-draft.ts` — `catalogVersionId` строки (у строк без версии для `plan`/`addon` — отказ, как
`offer_catalog_version_invalid` сегодня в предложении).

Замки: подписочные пути берут замок линии клиента, затем стража (строка позиции `FOR SHARE`), затем
`requirePublishedVersion` (`FOR KEY SHARE` версии): порядок «позиция → версия» совпадает с каталожными
путями. Маршрут флага берёт `lockItem` (`FOR UPDATE`) и никогда не берёт замок клиента → цикла нет. Флаг,
снятый одновременно с назначением, сериализуется по строке позиции: назначение либо видит `true` и
завершается до снятия, либо `false` и получает отказ. Предложения/счета замок линии не берут: устаревшее
чтение может на мгновение допустить позицию, у которой только что сняли флаг; окончательная проверка — в
`assign*InTransaction` при применении оплаты (риск 6). Комментарий стража про гонку с выдачей кабинета
остаётся верным и расширяется абзацем про флаг.

## 8. Выдача кабинета клиенту с офлайн-назначениями (решение 5)

`TenantProvisioningService.grantCabinetAccessInTransaction` (`tenant-provisioning.service.ts`):

1. Под замком линии и `FOR NO KEY UPDATE` организации (порядок замков не меняется, раздел «Grant lock
   order» спецификации 2026-09-29) читаем подписки клиента: есть ли строка со статусом
   `pending_activation|trial|active`.
2. Есть — **демо не создаётся**, `lockDefaultDemo` не вызывается, `default_demo_not_configured` не
   возникает; `demoCreated = false`. Назначения (текущие, запланированные, дополнения) не трогаются.
3. Нет — как сегодня (`lockDefaultDemo` → `insertPendingDemo`), `demoCreated = true`.
4. Ответ: `offlineAssignments: { plans, addons }` — число подписок (`pending_activation|trial|active|
scheduled`) и дополнений (`active|scheduled`) клиента на момент выдачи.
5. Аудит `platform.tenant.cabinet_access.granted`: `after` дополняется `demoCreated`,
   `offlineAssignments`, `subscriptionId`/`subscriptionStatus`/`planVersionId` — `null`, когда демо не
   создано (сегодня они всегда заполнены); `before` как сейчас.

Последствие для активации владельца: `activatePendingDemo` ищет ожидающее демо и при отсутствии
возвращает `null` — активация кабинета для клиента без демо уже поддержана этой веткой.

Интерфейс: форма выдачи (`GrantCabinetAccessPanel.tsx`) до отправки показывает предупреждение, когда в
деталях клиента есть текущая или запланированная подписка (данные уже загружены на странице: `detail.
currentSubscription`, `detail.scheduledSubscription`, `detail.activeAddons`, `detail.scheduledAddons`), с
текстом «У клиента есть офлайн-назначения (тариф, N дополнений). Они остаются в силе; демо не создаётся.
Права кабинета будут определяться ими»; после выдачи тот же смысл читается из `offlineAssignments`
ответа.

Оговорка: «права кабинета определяются назначениями» — следствие обычной работы `EntitlementsService`:
после выдачи кабинета те же подписки становятся правами облачного кабинета этого клиента (квоты
`cabinetUsers`, `lines` и т. д. применяются к нему). Это ожидаемо и должно быть названо в предупреждении
(вопрос В3).

## 9. API-маршруты и политики доступа

| Маршрут                                                       | Доменное лицо | Политика                                                                                                                         | Аудит                                                                  |
| ------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `PATCH /platform/catalog/items/:id/offline-availability`      | платформа     | `@RequirePlatformCapabilities("catalog.write")` + роль `platform_admin` в сервисе (`409 catalog_offline_availability_forbidden`) | `catalog.item.offline_availability_changed` (Р3)                       |
| `POST /platform/tenants/:id/subscription/plan` (без смены)    | платформа     | `tenants.write`, `billing.write`, `platform_admin`; страж «вид + флаг»                                                           | без изменений                                                          |
| `POST /platform/tenants/:id/subscription/addons` (без смены)  | платформа     | то же                                                                                                                            | без изменений                                                          |
| `POST /platform/tenants/:id/cabinet-access`                   | платформа     | `tenants.write` (support допущен, accountant — нет), без изменений                                                               | `platform.tenant.cabinet_access.granted`, `after` расширено (раздел 8) |
| `POST …/standalone-sites/:siteId/issuances/{preview,confirm}` | платформа     | `tenants.read` + `standaloneLicenses.manage`, без изменений                                                                      | `standalone_license.issued`, `after` расширено (раздел 11)             |

Устройства и кабинетные пользователи доступа к этим маршрутам не получают; маршрут флага не использует
кабинетную сессию (`cabinet session` никогда не даёт доступа платформы). Каждый новый маршрут добавляется в
`apps/api/test/platform-route-contracts.ts` и OpenAPI-проверки (раздел 12); строка `PlatformApiProtectedOk`
с `body`/`response` — как у соседей.

Аудит флага, точные поля: `actorPlatformUserId`, `actorRole = 'platform_admin'`, `action =
'catalog.item.offline_availability_changed'`, `outcome = 'success'`, `tenantId = null` (операция над
каталогом, не над клиентом), `targetType = 'catalog_item'`, `targetId = <id позиции>`, `reason = <основание>`,
`requestId = null`, `before = { offlineAvailable: <было> }`, `after = { offlineAvailable: <стало>,
catalogItemCode, kind, offlineTenantHolders }`. Отказ (нет роли, вид `service`, архивная позиция) аудита не
пишет, как отказы соседей.

`offlineTenantHolders` — `count(distinct tenant_id)` по `tenant_subscriptions` (статусы
`pending_activation|trial|active|scheduled`) и `subscription_addons` (`active|scheduled`), чьи версии
принадлежат позиции, у клиентов с `cabinet_access = 'none'`; считается в той же транзакции под `lockItem`.

## 10. Интерфейс SaaS-админки

i18n: `apps/saas-admin/src/i18n/ru.json` и `en.json` (оба); все тексты через ключи; кнопки и состояния —
не только цветом.

**Редактор каталога.** В `CatalogVersionPanel.tsx` (заголовок панели версии) для позиций вида `plan` и
`addon` и при `catalog.write` у `platform_admin` — переключатель `Checkbox` «Доступно офлайн-клиентам» с
подсказкой («Позицию можно назначать клиентам без кабинета. Облачным клиентам она доступна как обычно.
Действует на все версии позиции»). Изменение открывает подтверждение с полем основания (обязательное,
1–1000). Число `offlineTenantHolders` известно серверу только в транзакции, поэтому при снятии оно
показывается после ответа как `Alert` «Снято. У N клиентов без кабинета назначения остаются в силе», а не
в подтверждении до него. Для остальных ролей — только
чтение: бейдж без переключателя. Переключатель доступен и для опубликованных версий (в отличие от
остальных полей, которые только у черновика): это свойство позиции. Состояния: отправка (`busy`), ошибка
(`catalog_offline_availability_forbidden`, `catalog_item_offline_kind_invalid`, `catalog_item_archived`).
Бейдж «Офлайн» (`StatusChip` нейтральной фазы с подписью, не цвет) — в таблице `CatalogPage.tsx` рядом с
именем позиции и в заголовке панели версии.

**Карточка клиента, «Прямое назначение».** `TenantPage.tsx`: для `cabinetAccess = 'none'` рисуется
`SubscriptionPanel` с `offlineTenant`, вместо `Alert` `documentsNotice` (Alert остаётся над панелью). В
форме: список версий — `item.offlineAvailable`; для клиента без кабинета над формой пояснение «Клиент без
кабинета: можно назначить только тарифы и дополнения с пометкой «Доступно офлайн-клиентам». По этим
назначениям выпускается офлайн-лицензия автонома»; пустой список — текст «Нет позиций, помеченных
офлайн. Пометить позицию можно в каталоге» (ссылка на `/catalog` при `catalog.read`). Блок кабинетного
использования (`tenants.usage.*`) для такого клиента скрыт. Клиентская фильтрация — удобство; сервер
остаётся источником истины (страж, раздел 7).

**Выбор позиций в предложении/счёте.** `documents/CatalogPositionPicker.tsx` получает признак
`offlineTenant`; для клиента без кабинета показывает `service` и позиции с `offlineAvailable`
(закрывает «отложенный» пункт спецификации 2026-09-29: «DocumentComposer catalog filter»). Источник
признака — `TenantListItem.cabinetAccess`, он уже есть у выбранного клиента (`CreateOfferPage`,
`CreateInvoicePage` передают `cabinetAccess`).

**Диалог выдачи лицензии.** `StandaloneLicenseIssue.tsx`: раздел «Офлайн» (выбор версии тарифа, срок
в днях) удаляется целиком. Для `source = "offline_assignments"` над кнопками показывается блок «Права из
назначений клиента»: тариф и дополнения (имя, версия, количество, срок) — из деталей клиента (`getTenant`,
ключ запроса `["platform","tenants",tenantId]`, уже на странице) и ссылка «Изменить права клиента» на
раздел «Прямое назначение» карточки клиента (`/tenants/:id#assignment`, якорь на карточке; фокус и
`aria-label`). Таблица прав — прежний `StandaloneLicenseComparison` (уже показывает квоты и возможности,
подсвечивает несопоставленные). Ошибки `standalone_license_assignments_required` (с той же ссылкой),
`standalone_license_offline_terms_removed` (на случай старого кэша сборки: «Обновите страницу»),
`standalone_license_preview_stale`. Подсказка `yearCapNote` («бессрочное назначение — файл на год»)
показывается и здесь. `StandaloneSitesPanel.tsx`: `issuanceSource === "offline_assignments"` → `Alert`
«Лицензия выпускается из назначений клиента» вместо текста про офлайн-условия; для старого значения
`offline` (чтение истории) подписи источника сохраняются: `tenants.detail.standalone.source.offline`.

**Выдача кабинета.** `GrantCabinetAccessPanel.tsx` — предупреждение (раздел 8) и после выдачи
уведомление с числами из ответа.

Доступность: переключатель — `Checkbox` из `@markiro/ui` с `label` и `hint`; подтверждение — существующий
`ConfirmDialog` (фокус-ловушка, `aria-describedby`); блок «Права из назначений» — `<section aria-label>` с
таблицей `caption`; ссылки — настоящие `<a>`/`Link`; состояния сообщаются текстом, а не цветом.

## 11. Выпуск лицензии из назначений

### 11.1. Путь

`StandaloneLicenseIssuanceService.draft()` по `issuanceSourceFor(cabinetAccess)`:
`enabled` → `subscription` (без изменений), `none` → `offline_assignments`. Оба пути читают права одной
функцией `subscriptionTerms(tx, tenantId, now, missingCode)`:

- `snapshotAt = entitlements.loadSnapshotTimeline(tenantId, tx)`; `first = (await snapshotAt(now)).snapshot`;
  требуется `first.current.access === 'managed'` и `first.current.subscription`, иначе `409` с
  `standalone_license_subscription_required` (клиент с кабинетом) либо
  `standalone_license_assignments_required` (клиент без кабинета, Р8).
- Квоты и возможности — `exportStandaloneRights(first)` (кандидат снимка: тариф + дополнения × количество
  - временные источники и источники совместимости; несопоставленное → «выключено» с предупреждением
    `feature_unmapped`, как сегодня).
- Срок — `licenseValidity(...)`: конец подписки, ближайшее уменьшение прав или год от выпуска; причины
  `subscription_end|entitlement_reduction|one_year_cap`. Это «конец назначения либо год при бессрочном».
- `plan`: `subscription.status === 'trial' ? 'demo' : 'subscription'`; для `offline_assignments` проверка
  БД требует `subscription` — клиент без кабинета не получает демо по построению (демо вставляется только
  выдачей кабинета); защитно `trial` у такого клиента → `409 standalone_license_assignments_required`.
- `entitlementRevision` — настоящая ревизия снимка (больше не `"0"`): она закрывает гонку «назначение
  изменилось между предпросмотром и подтверждением» (`expected.entitlementRevision`), а триггеры
  `entitlement_revision_*` увеличивают её при любой правке подписок и дополнений клиента.
- `sourceAssignments`: из `first.sources` — источники `plan` и `addon` (id, `versionId`); источники
  `temporary`/`compatibility` сюда не пишутся, но их эффект уже внутри квот (их у клиента без кабинета
  обычно нет). Записываются в колонку журнала и в `after.sourceAssignments` аудита.
- Снимок не хранится; чтение — в той же транзакции `standaloneTransaction` (`repeatable read`), экспортёр
  не зависит от кабинетного состояния: не читает членов, приглашения (их счётчик нулевой), устройства
  сверх `usage` (ноль у такого клиента), сессии.

### 11.2. Журнал и аудит

Строка `standalone_license_issuances`: `source = 'offline_assignments'`, `source_assignments = [...]`,
`valid_until_reason ∈ {subscription_end, entitlement_reduction, one_year_cap}`, `entitlement_revision` —
настоящая. Аудит `standalone_license.issued`, `after`: как сейчас плюс `sourceAssignments`; `offlineTerms =
null` у новых записей (поле остаётся в форме `after` для совместимости чтения). `before` — прежний
выпуск площадки (как сейчас).

### 11.3. Старый API и история

- `preview` и `confirm` принимают `offline: null`. Непустое `offline` в `preview` и в `confirm` (когда
  запрос не является повтором) — `409 standalone_license_offline_terms_removed`.
- Повтор `confirm` с тем же `requestId`: сначала проверка повтора по `(tenant, site, request_id)`.
  Если строка найдена — `sameTerms(row, body.offline)`: для строк `offline` повтор с теми же условиями
  возвращает тот же файл (идемпотентность прежних выдач сохраняется), для остальных источников
  `offline` обязан быть `null`. Только после этого — отказ `offline_terms_removed`. Это сохраняет
  повторную загрузку/повтор запроса, выпущенного до выкладки.
- Строки журнала `source = 'offline'`: читаются без изменений (`issuanceSummary`, `licenseFile`),
  `sourceAssignments = null`, `validUntilReason = 'offline_term'`, `entitlementRevision = "0"`. Выданные
  файлы не пересчитываются и не перевыпускаются; новый файл площадки заменяет их обычным `replaces`.
  Ни одна функция чтения не вызывает новую логику для старых строк.
- `termsDigest` сохраняет форму (`offline` в нём всегда `null`); выкладка во время открытого
  предпросмотра даёт `standalone_license_preview_stale` — оператор повторяет предпросмотр.

### 11.4. Удаление мёртвого кода (Р12)

`offlineTerms()`, `OFFLINE_ENTITLEMENT_REVISION`, `exportPlanRights`, `PlanEntitlementRow`,
`offlineValidity` и их юнит-тесты (`standalone-license-rights.test.ts`) удаляются; `StandaloneOfflineTerms`
остаётся типом запроса (Р7). Причина `offline_term` остаётся в `validUntilReasonSchema` (читаем историю).

## 12. Проверки (тесты)

- **DB:** схема (`offline_available` default false, проверка вида), миграция на базе с позициями и
  старыми выдачами (все позиции `false`, старые строки `subscription`/`offline` целы, новое условие
  принимает `offline_assignments` с причиной `one_year_cap` и отвергает с `offline_term`, отвергает
  `offline_assignments` без `source_assignments`), журнал миграций.
- **Контракты:** `offlineAvailable` обязателен во всех версиях V1–V4; тело/ответ флага строгие;
  `sourceMatchesReason` для трёх источников; ответ выдачи кабинета.
- **API e2e (БД):**
  - страж: клиент `none` — тариф и дополнение с флагом проходят `assignPlan`/`assignAddon`; без флага —
    `409 catalog_kind_not_allowed_for_offline_tenant`; услуга проходит; клиент с кабинетом — не зависит
    от флага; чужой клиент (tenant B) не затронут назначением tenant A; предложение и счёт: строка
    `plan` с флагом создаётся, без флага — отказ, `service` — проходит; оплата помеченного тарифа создаёт
    подписку;
  - гонка: назначение против снятия флага (замок позиции) — один из двух исходов, без смешанного;
  - флаг: роли (`platform_admin` — да; `accountant` с `catalog.write` — `409 …forbidden`; `support` — `403`
    политика); `service`-позиция — `409 catalog_item_offline_kind_invalid`; архивная — `catalog_item_archived`;
    несуществующая — `404 catalog_item_not_found`; идемпотентность (без аудита); аудит с точными полями
    (раздел 9); `offlineTenantHolders` считает только клиентов `none`;
  - выпуск: клиент `none` с тарифом и двумя количествами дополнения — права в файле равны сумме снимка,
    `source = 'offline_assignments'`, причина `one_year_cap` при бессрочном и `subscription_end` при
    сроке, `entitlementRevision` ≠ `"0"`, `sourceAssignments` в журнале и аудите (точные поля), облачный
    след клиента не изменился (ни подписок, ни кабинета, ни устройств); нет назначений —
    `standalone_license_assignments_required`; смена назначения между предпросмотром и подтверждением —
    `standalone_license_preview_stale`; `offline` непустое — `offline_terms_removed`; повтор старой выдачи
    `offline` возвращает тот же файл; чтение старых строк; чужой клиент и роли без
    `standaloneLicenses.manage` отвергаются;
  - выдача кабинета: у клиента с активным офлайн-тарифом демо не создаётся, `demoCreated=false`, аудит с
    `null`-полями демо, назначения не изменены, `default_demo_not_configured` не требуется; без текущей
    подписки поведение прежнее.
- **Маршруты/OpenAPI:** строка в `platform-route-contracts.ts`; `platform-contract-openapi.test.ts`
  (`CURRENT_SHARED_SCHEMAS` — новое число из теста); `openapi-coverage.test.ts`; при необходимости
  `subscription-route-inventory.test.ts`.
- **saas-admin (компонентные):** редактор каталога (переключатель, подтверждение, ошибки, чтение для
  не-`platform_admin`, бейдж в таблице); карточка клиента без кабинета (панель видна, список версий
  только офлайн, пустое состояние); выбор позиций документа; выдача кабинета (предупреждение до и после);
  диалог выпуска (таблица прав из назначений, ссылка, ошибки, отсутствие раздела «Офлайн»); панель
  площадок (подписи нового и старого источника); фикстуры и `render.tsx`.
- **production-browser:** `tenant-equipment-tests` — добавить клиента `none` с назначением и проверить
  диалог выпуска (ссылка «Изменить права клиента», отсутствие раздела «Офлайн»); обновить
  `service-periods-tests/fixture.ts` под `offlineAvailable`; запускаются локально вне песочницы, в
  отчёте — не выполненные в среде.
- **Не проверяется автотестами:** реальный WebView/Windows приёмник файла (хост принимает файл прежнего
  формата, `plan: "subscription"`), живой браузерный обход, развёртывание.

## 13. Затронутые задачи фоновой обработки

Единственное периодическое задание по подпискам — `SubscriptionStatusJob`
(`subscriptions/subscription-status.job.ts`, `* * * * *`): оно активирует запланированное и истекает
завершённое по всем клиентам, в том числе без кабинета. Раньше таких строк не было, теперь будут: задание
пишет только статусы и `subscription_events` (без писем, без членов) — безопасно, менять не нужно;
добавляется e2e на клиента `none` (истечение назначения переводит снимок в `read_only` и следующий выпуск
получает `standalone_license_assignments_required`). Остальные потребители таблиц подписок:
`authorization.service.ts` (кабинет, членов нет), `grant-admission.ts`/`grant-policy.ts` и
`device-licensing-*` (устройства клиента; у клиента без кабинета их нет), `tenant-billing-read.service.ts`
(кабинетное чтение), `report-unmanaged-tenants.ts` (исключает `cabinet_access = 'none'`; остаётся: клиент без
подписки не «неуправляемый»), `platform-tenants.service.ts` (детали клиента: подписки уже отдаются для
`none`). Сроки услуг (`service-periods`) и биллинг (`billing-acts`, `platform-billing-requests`) ключатся
по клиенту и подписок не читают; уведомления биллинга шлют только членам `owner|admin` — у клиента без
кабинета их нет, ничего не отправляется. Автоматического создания счетов и актов по назначению нет
(решение 4): назначение пишет только `tenant_subscriptions`/`subscription_addons`,
`subscription_events` и платформенный аудит.

## 14. Риски

1. **Гонка стража и выдачи кабинета.** Подписочные пути держат замок линии; выдача кабинета берёт его до
   переключения. Страж теперь ещё читает строку позиции `FOR SHARE` — после замка линии, до
   `requirePublishedVersion`; порядок «позиция → версия» совпадает с каталожными путями, замок клиента
   каталожные пути не берут. Предложения и счета замок линии не берут и читают флаг обычным чтением
   (без блокировки строки позиции, чтобы не удлинять транзакции документов): допустимо, потому что
   окончательная проверка — при применении оплаты (риск 6).
2. **Уникальный индекс одной текущей подписки** против вставки демо при выдаче кабинета — закрыт Р9;
   без этого выдача кабинета клиенту с офлайн-тарифом падала бы `23505`.
3. **Выпуск у клиента без кабинета с истёкшим назначением** — снимок `read_only`, отказ
   `standalone_license_assignments_required`; обновление файла возможно только после нового назначения —
   раньше оператор мог выпускать по ручным условиям. Это сознательное следствие решения 3; оператор видит
   ссылку «Изменить права клиента».
4. **`entitlementRevision` в файле стал настоящим.** Хост проверяет только форму десятичной строки
   (`is_decimal_revision`, `apps/standalone/proto/src/trust.rs:631`; схема
   `packages/domain/src/standalone-license/contracts.ts:120` — оба файла лежат в ветке
   `claude/integration`, в `origin/main` их нет): любое неотрицательное десятичное значение до 19 цифр
   допустимо, смысловых сравнений с `"0"` нет. В плане (T5) — шаг проверки `rg entitlement_revision
apps/standalone` перед выкладкой; правок хоста не ожидается.
5. **Старые строки журнала** `offline`/`offline_term` и старые файлы остаются валидными и читаемыми;
   перевыпуска и пересчёта нет (корневой `AGENTS.md`: не пересчитывать сохранённые факты).
6. **Открытые документы при снятии флага:** предложение/счёт на помеченный тариф, созданные до снятия,
   при оплате вызовут `assignPlanInTransaction` и получат отказ стража. Поведение отказа оплаты в
   `applyPaidLicense` при `ConflictException` проверяется тестом плана (T3); если оплата застревает
   неразрешимо, это блокер до выкладки, не допущение. Обходной путь оператора — вернуть флаг.

   **Результат проверки кода (2026-10-16, T3):** оплата не застревает. Счёт: `applyLine` идёт во вложенной
   транзакции (savepoint), `ConflictException` стража ловится как ожидаемая ошибка применения
   (`isExpectedApplicationError`), строка получает событие `failed` с кодом
   `catalog_kind_not_allowed_for_offline_tenant`, счёт — `partial_failure`, аудит
   `billing.invoice.line_applied` с исходом `failed`; повторное применение (`POST /platform/invoices/:id/apply`
   по этой строке) идёт с `attempt + 1` после возврата флага. Платёж при этом уже записан. Предложение: оплата
   и применение лицензии — одна транзакция `PlatformOffersService.pay`, отказ откатывает её целиком (ни платежа, ни
   смены статуса предложения), предложение остаётся принятым и оплачиваемым; после возврата флага
   платёж регистрируется заново. Блокера нет; обходной путь оператора — вернуть флаг, затем повторить.

7. **Совместимость кэшированной сборки saas-admin** — Р7 (поле `offline` принимается). Новые поля ответов
   (`offlineAvailable`, `sourceAssignments`, расширенный ответ выдачи кабинета) старая сборка отвергнет
   строгой схемой ответа: порядок выкладки — сначала API, затем saas-admin в том же релизе; окно
   несовместимости — перезагрузка страницы. Прецедент: поле `cabinetAccess` в ответах тенантов (план 2026-09-29) добавлялось по
   тому же правилу; проверки кэша сборки в репозитории нет (внешняя проверка, в отчёте — не выполнена).
8. **Фикстуры строгих схем** (раздел 6) — самый вероятный источник «красных» наборов; перечень в плане.
9. **`featureAddonEffectSchema` в `tenants.ts` допускает у дополнений лишь три возможности**
   (`labelEditor`, `publicApi`, `pallets`), а снимок прав знает восемь. Это существующее ограничение
   каталожного контракта, не меняется; офлайн-дополнения, дающие `handheld`/`customLogo`, станут
   возможны вместе с расширением каталожного контракта (вне объёма).

10. **Правка черновика версии склеивает ответ с телом** (`updateVersion`, `platform-catalog.service.ts`
    около строки 357: `merged = { ...representable, ...input }`, поля ответа отфильтровываются набором
    `responseFields`). `offlineAvailable` — поле ответа, не тела правки; если не добавить его в набор,
    строгая схема правки отвергнет любую правку черновика. Явный шаг и тест в плане (T3).

## 15. Что не входит

Автоматический биллинг по назначению (решение 4); вид позиции «только офлайн»; флаг на услугах; пересчёт
или перевыпуск прежних офлайн-файлов; удаление поля `offline` из запросов выпуска (отдельный выпуск после
выхода новой сборки saas-admin); изменение хоста автонома и формата файла лицензии; возврат клиента в
`none`; новые платформенные возможности.

## 16. Открытые вопросы владельцу

**В1. Кто может менять флаг?** Рекомендация: `catalog.write` и роль `platform_admin` (как «Прямое
назначение»), бухгалтеру — только чтение бейджа. Альтернатива: любой с `catalog.write` (включая бухгалтера).

**Решено владельцем 2026-10-16:** флаг меняет `catalog.write` + роль `platform_admin` (как рекомендовано).

**В2. Название раздела.** В карточке клиента раздел называется «Прямое назначение», а в ваших словах
ссылка из диалога выпуска — «Изменить права клиента». Рекомендация: оставить заголовок «Прямое назначение»
(он же в аудите и документации), а ссылку в диалоге назвать «Изменить права клиента» с якорем на этот раздел.
Альтернатива: переименовать раздел для клиентов без кабинета.

**Решено владельцем 2026-10-16:** заголовок «Прямое назначение» остаётся; ссылка в диалоге выпуска — «Изменить права клиента».

**В3. Выдача кабинета клиенту с офлайн-назначением: оставляем его тариф как права кабинета и не создаём
демо (рекомендация, это следствие индекса «одна текущая подписка») — или требуем сначала завершить
назначение?** Рекомендация первая: назначение остаётся (ваше решение 5), предупреждение прямо говорит, что
квоты кабинета теперь равны квотам этого тарифа.

**Решено владельцем 2026-10-16:** выдача кабинета клиенту с офлайн-тарифом оставляет этот тариф правами кабинета и не создаёт демо; предупреждение говорит, что квоты кабинета теперь равны квотам этого тарифа.

**В4. Снятие флага при действующих назначениях** допустим (рекомендация), с предупреждением о числе
клиентов; альтернатива — запретить снятие, пока такие назначения есть (защищает от «застрявшей оплаты»
открытых документов, риск 6, но мешает выводить позицию из офлайн-продажи).

**Решено владельцем 2026-10-16:** снятие при действующих назначениях допустимо, с предупреждением о числе держателей. Исследование `applyPaidLicense` для открытых документов — T3, результат в риске 6.
