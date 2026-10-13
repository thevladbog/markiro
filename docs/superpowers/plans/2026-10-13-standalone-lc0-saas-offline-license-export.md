# План ЛЦ-0: SaaS-админка — экспорт офлайн-лицензии автонома (площадки, выпуск подписанного файла из снимка прав, свой ключ лицензий, платформенный аудит, панель «Автоном: площадки и офлайн-лицензии») — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор SaaS-админки регистрирует площадку «Markiro Автоном» по файлу запроса активации (с предупреждениями о расхождении ИНН), видит предпросмотр «было → станет» и выпускает подписанный файл лицензии `.mklic` — компактный JWS ES256 с нагрузкой `standaloneLicensePayloadV1` (спецификация §4.2), посчитанной из снимка прав клиента (`EntitlementsService`): квоты и возможности тарифа, `demo` при подписке `trial`, `validUntil` = конец подписки или ближайшее уменьшение прав. Номер файла `sequence` монотонен по площадке даже под гонкой двух подтверждений; каждый выпуск — строка журнала выдачи и строка платформенного аудита; любой выданный файл можно скачать повторно. Ключ лицензий — свой, в окружении API, как у офлайн-грантов; гранты работают без изменений.

**Architecture:**

- Задача 1 — контракты `@markiro/platform-contracts`: возможность `standaloneLicenses.manage` (только `platform_admin`), файл `standalone-licenses.ts` (набор ключей лицензий, права файла, площадка, запрос регистрации, предпросмотр, подтверждение, файл, предупреждения, `platformStandaloneLicenseContracts`), переэкспорт из `index.ts`; проверка предусловий ЛЦ-1.
- Задача 2 — `@markiro/db`: таблицы `standalone_sites` и `standalone_license_issuances` (составной внешний ключ по клиенту, `UNIQUE (site_id, sequence)`, идемпотентность по `request_id`), миграция Drizzle `0186_standalone_licenses.sql` (сгенерированная и просмотренная), тесты схемы и миграции на одноразовой базе.
- Задача 3 — API: обобщённый подписант `apps/api/src/signing/compact-jws.ts` (`loadCompactJwsSigningKey`, `signCompactJws(config, typ, payload)`), вынесенный из `grant-keyset.ts`; гранты подписываются тем же байт-в-байт заголовком.
- Задача 4 — API: окружение `STANDALONE_LICENSE_ISSUER/KID/PRIVATE_KEY_PEM/KEYSET_JSON`, `configureStandaloneLicenseSigning`, проверка при старте (`env.ts`), запрет переиспользовать ключ грантов, `.env.example`, `.env.production.example`, необязательная группа в `deploy/yandex/runtime-env.mjs` и её тесты.
- Задача 5 — API, чистая логика прав: `exportStandaloneRights` (`null`-возможность → `false` + список несопоставленных), `rightsReduce`, `licenseValidity` (обход границ снимка до первого уменьшения; предел — конец подписки или год).
- Задача 6 — API, чистая сверка ИНН: предупреждения регистрации, выбор ИНН клиента для файла, предупреждения выпуска (ИНН, квота меньше использования площадки, несопоставленная возможность).
- Задача 7 — API, сервис площадок: `inspect`, `register` (`create` / `rebind` — новый `hostId` той же площадки), `list`, повторная проверка платформенного пользователя в транзакции, аудит `standalone_site.registered` / `standalone_site.host_rebound`; e2e на базе: изоляция клиентов, отказ ролям, подтверждение предупреждений, повтор запроса.
- Задача 8 — API, сервис выпуска: `preview`, `confirm` (сравнение с ожидаемым, CAS `last_issued_sequence`, подпись, журнал, аудит `standalone_license.issued`), `listIssuances`, `download`; e2e: файл из снимка проверяется `verifyStandaloneLicense` домена, демо из `trial`, граница уменьшения, гонка двух подтверждений, повтор, устаревший предпросмотр, отказы.
- Задача 9 — API: контроллер `platform/tenants/:tenantId/standalone-sites…`, модуль `PlatformStandaloneLicensesModule.forRoot(env)`, подключение в `AppModule`, реестр маршрутов платформы, OpenAPI-контракт, политика маршрутов, исключения инвентаря подписки.
- Задача 10 — SaaS-админка: клиент `standalone-api.ts`, сохранение `.mklic`, панель `StandaloneSitesPanel` (список, фаза лицензии, напоминание о продлении, история и повторная загрузка) во вкладке «Оборудование», i18n.
- Задача 11 — SaaS-админка: «Добавить площадку из запроса активации» и «Выпустить офлайн-лицензию» (предпросмотр «было → станет», подтверждение, скачивание).
- Задача 12 — `tools/production-browser` (фикстура и сценарий вкладки «Оборудование»), памятка `docs/operations/standalone-licenses.md`, §24 спецификации, итоговые гейты.

**Tech Stack:** TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4, NestJS + Drizzle ORM (Postgres), `node:crypto` (ES256, IEEE P1363), Vitest 4 (API — node, SaaS-админка — jsdom 29), React 19 + TanStack Query, `@markiro/ui`, Playwright (`tools/production-browser`), `node --test` (контракты деплоя).

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — §4 (таблица переиспользования), §4.2 (нагрузка), §4.8 (замена файла, `sequence`), §4.9 (ИНН: предупреждения при регистрации и выпуске), §5.1 (ключ лицензий в окружении API, свой), §6.2–§6.3 (выпуск и запрос активации), §15 (влияние на SaaS-админку), §13 строка 0, §14.1 (ЛО22, ЛО25, ЛО26). Этот план дописывает §24.
- `/tmp/claude/fb/license-plans-brief.md` — распределение и межплановый контракт («ЛЦ-1 produces», «ЛЦ-0 produces»).
- `AGENTS.md`, `apps/api/AGENTS.md` (маршруты, возможности, аудит, изоляция).
- Образцы в коде: `apps/api/src/modules/device-grants/grant-keyset.ts` (ключи и подпись грантов), `apps/api/src/subscriptions/entitlements.service.ts` (`loadSnapshotTimeline`, `resolveSnapshotInTransaction`), `apps/api/src/subscriptions/entitlement-projection.ts` (`nextChangeAt`, кандидат с `null`-возможностями), `apps/api/src/subscriptions/entitlement-sources.service.ts` (предпросмотр/подтверждение, повтор транзакции на `40001`), `apps/api/src/modules/device-licensing/device-licensing-authority.ts` (повторная проверка платформенного пользователя), `apps/api/test/entitlement-sources.e2e.test.ts` (точные строки аудита), `apps/saas-admin/src/pages/tenants/{EntitlementPreviewComparison,DeviceLicensingPanel,TenantEquipmentPanel}.tsx`.

## Допущения

Владелец принял решения ЛО1–ЛО27 «как рекомендовано»; ниже — решения этого плана там, где спецификация молчит или расходится с кодом. Каждое отклонение от имён брифа отмечено.

- **Д1 — имя возможности `standaloneLicenses.manage` (отклонение от `standalone_licenses_manage` брифа и §6.2).** Все 18 возможностей `platformCapabilitySchema` (`packages/platform-contracts/src/platform-auth.ts:19`) названы `область.глагол` в camelCase (`offlineGrants.activate`, `reports.create`); имя со знаками подчёркивания стало бы единственным исключением. Смысл тот же: одна возможность на все маршруты ЛЦ-0, только у `platform_admin` (как `offlineGrants.activate`). Маршруты требуют `["tenants.read", "standaloneLicenses.manage"]`, как маршруты активации грантов требуют `tenants.read` вместе со своей.
- **Д2 — выпуск требует управляемой подписки (`current.access === "managed"`), иначе `409 standalone_license_subscription_required`.** Без подписки `EntitlementsService.resolve` даёт `unmanaged` — без лимитов и без срока (`entitlements.service.ts:142–150`), выгружать такое в офлайн-файл нельзя (не из чего взять `validUntil`, `planVersionId`). **Конфликт с кодом:** клиенту без кабинета (`organization.cabinet_access = 'none'`) подписку на тариф сейчас не оформить — `assertKindAllowedForTenant` отвечает `catalog_kind_not_allowed_for_offline_tenant` (`apps/api/src/subscriptions/tenant-cabinet-access.ts:19–33`), а `SubscriptionPanel` такому клиенту не показывается (`TenantPage.tsx:264`). Площадку у такого клиента зарегистрировать можно, выпустить файл — нет, пока владелец не разрешит тарифы клиентам без кабинета (вопрос владельцу, «Перенесено»). План этот запрет не трогает.
- **Д3 — ИНН клиента для файла: `org_profiles.inn`, а если его нет или он не проходит контрольную сумму — ИНН текущего платёжного профиля (`tenant_billing_profiles.inn`, `is_current`), с предупреждением `customer_inn_from_billing`.** Спецификация (§4.9) берёт ИНН из `org_profiles.inn`, но платформа его не пишет: создание клиента вставляет `org_profiles` без ИНН (`tenant-provisioning.service.ts:223–227`), правит его только кабинет клиента; у клиента без кабинета ИНН есть только в платёжном профиле, который ведёт оператор. Ни одного верного ИНН — `409 standalone_license_inn_required`. Оба верных и разные — предупреждение `billing_inn_differs`, в файл идёт ИНН профиля организации.
- **Д4 — имя организации в файле:** полное наименование текущего платёжного профиля (`full_name`), иначе `organization.name`; управляющие символы заменяются пробелом, строка обрезается до 300 символов — так требует `plainText(300)` нагрузки ЛЦ-1. Хост сверяет только ИНН (§4.9), имя — для людей.
- **Д5 — `validUntil` = минимум из: конца подписки, первой границы уменьшения прав и момента выпуска + 365 дней.** Спецификация (§6.2) называет конец подписки и уменьшение; у подписки без даты окончания (`ends_at IS NULL`) срока нет вовсе — предел в год следует ЛО8 («год с выпуском следующего файла за 30 дней»). Причина пишется в журнал и показывается оператору: `subscription_end` / `entitlement_reduction` / `one_year_cap`. Граница уменьшения ищется обходом `nextChangeAt` снимка (`loadSnapshotTimeline` — одна согласованная транзакция): на каждой границе до предела пересчитывается снимок и сравнивается с предыдущим (`rightsReduce`); увеличения пропускаются. Не больше 64 шагов; на 65-м файл обрезается этой границей (осторожно, а не щедро).
- **Д6 — льготный срок:** по умолчанию 14 для `subscription` и 0 для `demo`; оператор задаёт 0–60; для `demo` ненулевой — `400 standalone_license_grace_invalid`.
- **Д7 — предпросмотр выпуска не хранится.** `preview` ничего не пишет и отдаёт `expected = { entitlementRevision, previousSequence, boundaryAt }`; `confirm` пересчитывает черновик и отказывает `409 standalone_license_preview_stale`, если хоть одно из трёх изменилось. Время выпуска берётся в `confirm` (`validFrom` = `issuedAt` = момент подтверждения); граница с причиной `one_year_cap` от времени не зависит в `expected` (`boundaryAt: null`).
- **Д8 — порядок номеров:** `standalone_sites.last_issued_sequence` и сравнение-с-заменой в той же транзакции (`UPDATE … WHERE last_issued_sequence = ожидаемому`), транзакции `REPEATABLE READ` с повтором на `40001`; второе подтверждение после повтора видит новый номер и получает `standalone_license_preview_stale`. `UNIQUE (site_id, sequence)` — страховка: её нарушение тоже превращается в `standalone_license_preview_stale`. Повтор того же `requestId` (тем же оператором) возвращает тот же файл, второй строки нет.
- **Д9 — запрос активации регистрирует или перепривязывает площадку одним маршрутом** `POST …/standalone-sites` с `intent: "create" | "rebind"`; предпросмотр расхождений — `POST …/standalone-sites/inspect` без записи. Предупреждения ИНН нужно подтвердить точным набором кодов (`acknowledgedWarnings`), иначе `409 standalone_site_warnings_unacknowledged` (ошибки платформы несут только код — `platform-exception.filter.ts` — поэтому сами предупреждения отдаёт `inspect`). История `hostId` — `jsonb`-массив площадки (бриф разрешает «table or jsonb»), до 100 записей. Хост, уже привязанный к площадке этого клиента, — `409 standalone_site_host_registered`, другого клиента — `409 standalone_site_host_taken` (без имени и идентификатора чужого клиента).
- **Д10 — использование площадки для предупреждения `quota_below_usage`** берётся из последнего запроса активации площадки (`usage` хоста: `stations`, `cabinetUsers`, `lines`), а не из облачного использования снимка (`candidate.quotas.*.used` считает облачные линии и устройства и к автоному не относится). Обновить `usage` можно только перепривязкой; «обновить запрос без смены хоста» — «Перенесено».
- **Д11 — набор ключей лицензий** — та же форма, что `grantKeysetSchema` (`origin`, `revision`, `keys[{kid,jwk}]`, `retiredKids`, строгие проверки), но `protocol: "standalone-license-v1"`: литерал `offline-grants-v1` в наборе ключей лицензий вводил бы в заблуждение (отклонение от «same keyset shape» — форма та же, литерал свой). `STANDALONE_LICENSE_ISSUER` — origin API, совпадает с `origin` набора; его же владелец кладёт в `apps/standalone/proto/fixtures/trust-keys.json` (ЛЦ-1). Ключ лицензий не может совпадать ни с одним ключом набора грантов — проверка при старте. Имя `StandaloneLicenseKeyset` уже занято доменом ЛЦ-1 (набор доверенных ключей сборки), поэтому серверный набор назван `standaloneLicenseSigningKeysetSchema` / `StandaloneLicenseSigningKeyset`; ЛЦ-1 кладёт свои переэкспорты в `packages/platform-contracts/src/standalone-license.ts`, контракты этого плана — в соседний `standalone-licenses.ts`.
- **Д12 — `STANDALONE_LICENSE_PRIVATE_KEY_PEM` принимает экранирование `\n`.** `renderRuntimeEnvironment` отвергает значения с переводом строки (`deploy/yandex/runtime-env.mjs:106`), а PKCS#8 PEM многострочный; для ключа лицензий строка `\\n` заменяется на перевод строки до разбора. Ключ грантов не трогается (бриф: гранты без изменений) — то же ограничение у него остаётся и названо в отчёте.
- **Д13 — заголовок JWS `{"alg":"ES256","typ":…,"kid":…}`** — в порядке ключей грантов (`grant-keyset.ts:66–68`), чтобы гранты остались байт-в-байт прежними. Спецификация (§4.1) перечисляет те же три поля в другом порядке; проверка домена (`verifyCompactJws`, ЛЦ-1) и хоста (`markiro_proto::trust`, ЛЦ-1) разбирают заголовок как объект со строгим набором полей, порядок им безразличен. Тест задачи 8 проверяет файл API проверкой домена; совместимость с Rust-проверкой хоста — «Не проверено» (её доказывает ЛЦ-2 на фикстурах ЛЦ-1).
- **Д14 — выпуск только для клиента с каноническим UUID.** Нагрузка ЛЦ-1 требует `tenantId` — UUID в нижнем регистре (TS `uuid`, Rust `is_uuid(&self.tenant_id)` в `is_valid`), а `organization.id` — `text`: клиенты, созданные платформой, получают `randomUUID()`, а клиенты из кабинетной регистрации Better Auth — его собственные идентификаторы (`generateId` не настроен). План не меняет формат ЛЦ-1 (TS, Rust и общие фикстуры): для клиента с иным идентификатором выпуск отвечает `409 standalone_license_tenant_id_unsupported` (регистрация площадки работает). Расширить формат — вопрос владельцу (§24, «Перенесено»).
- **Д15 — предпросмотр «было → станет» — свой компонент тем же видом**, что `EntitlementPreviewComparison` (та же таблица, классы и подписи `entitlements.quotas.*` / `entitlements.features.*`): сам `EntitlementPreviewComparison` принимает `EntitlementSourcePreview` (два снимка облака) и к файлу лицензии не подходит.
- **Д16 — повторная загрузка файла — `GET …/issuances/:licenseId/file` с JSON `{ issuance, fileName, compact, sha256 }`**; файл собирает SaaS-админка (`Blob`), потому что OpenAPI-контракт платформы проверяет JSON-ответы (`platform-contract-openapi.test.ts`). Загрузка не пишет аудит (чтение), напоминание о продлении — признак `renewalDue` в списке (за 30 дней до `validUntil`), без писем.
- **Д17 — панель — во вкладке «Оборудование» (`TenantEquipmentPanel`)**, видна только с `standaloneLicenses.manage`; вкладка доступна и клиентам без кабинета.

## Решения владельца 2026-10-13 после принятия плана (обязательны; меняют Д2, Д5, Д14)

Получены во время исполнения; код ветки `claude/exec-lc0` следует им, фрагменты задач ниже — нет
(где фрагмент расходится, правило этого раздела главнее).

- **Р1 — офлайн-лицензия для клиента без кабинета (заменяет запрет Д2 для таких клиентов).** Клиент
  с `organization.cabinet_access = 'none'` получает файл по **офлайн-условиям**, которые оператор
  задаёт при выпуске в разделе «Офлайн» диалога: опубликованная версия тарифа каталога (квоты и
  возможности — из `plan_entitlements`, `null` — `false` с подсветкой, как ЛО26) и срок `termDays`
  1–365 дней от выпуска; бессрочно нельзя. Контракт: `offline: { planVersionId, termDays } | null` в
  теле предпросмотра и подтверждения; `source: "subscription" | "offline"` в сводке выпуска и
  предпросмотре; `issuanceSource` в списке площадок; причина срока `offline_term`. В файле `plan:
"subscription"`, `planVersionId` — выбранная версия, `entitlementRevision: "0"`, льготный срок по
  умолчанию 14. Облако не меняется: выпуск не пишет подписки, кабинет, пользователей, устройства и
  права — только `standalone_license_issuances` (колонка `source`) и платформенный аудит
  `standalone_license.issued` с `after.source` и `after.offlineTerms` (точные строки проверяет e2e).
  Возможность та же — `standaloneLicenses.manage`. Отказы: офлайн-условия у клиента с кабинетом — `409
standalone_license_offline_not_allowed`; клиент без кабинета без условий — `409
standalone_license_offline_terms_required`; неизвестная, неопубликованная или не тарифная версия —
  `409 standalone_license_offline_plan_unavailable`. Клиент с кабинетом без подписки — по-прежнему `409
standalone_license_subscription_required`. Путь выбирается по `cabinet_access`, который запись
  читает `FOR SHARE`.
- **Р2 — `tenantId` не обязан быть UUID (заменяет Д14).** Идентификатор выбирает контрагент; в файле
  `tenantId` и `siteId` — непрозрачные строки `^[A-Za-z0-9._:-]{1,64}$` (ЛЦ-1:
  `STANDALONE_OPAQUE_ID_PATTERN`, `standaloneOpaqueIdSchema`). Почему этот набор: в него входят UUID
  платформы (36 знаков) и идентификаторы Better Auth (32 буквенно-цифровых), он целиком ASCII — нет
  пробелов, управляющих знаков и юникодных двойников, `.`/`_`/`:`/`-` покрывают составные коды; 64 —
  с запасом к обоим и короче строки журнала. Маршруты ЛЦ-0 проверяют `tenantId` этим правилом и
  отвечают `400` до запроса к базе; отказа `standalone_license_tenant_id_unsupported` нет.
- **Р3 — подписка без даты окончания (уточняет Д5, ЛО8):** срок файла — год от выпуска; когда он
  выйдет, клиент бесплатно запрашивает у нас новый файл (фраза в подсказке выпуска, памятке и
  примечании к текстам §9.7 спецификации).
- Приняты как рекомендовано: ЛО22–ЛО27.

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` (ЛЦ-2), `0031_device_versions.sql` (ОБН-1), `0032`–`0033` — резерв; ветки `fb-codesearch`, `fb-people`, `fb-templates`, `fb-mode` занимают `0017`–`0018` — не трогать. Оболочка (`src-tauri/migrations`) — без новых миграций (`0030`–`0031` зарезервированы и не используются).
- Облако (`packages/db/migrations`, этот план): следующий свободный номер Drizzle на момент исполнения (`0186` при написании); генерировать `drizzle-kit generate` и просматривать; применённые миграции не править.
- Разделы спецификации «Уточнения плана …»: §18 ЛЦ-1, §19 ЛЦ-2, §20 ОБН-1, §21 ЛЦ-3, §22 ОБН-2, §23 ОБН-3, **§24 ЛЦ-0** (этот план).
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (ЛЦ-3 ∥ ОБН-2) → ОБН-3. ЛЦ-0 опирается только на код ЛЦ-1.

**Межплановый контракт (бриф, BINDING), который этот план потребляет и производит:**

- Потребляет (ЛЦ-1, `@markiro/domain`): `normalizeInn`, `isValidInn`, `STANDALONE_LICENSE_TYP = "markiro-standalone-license+jws"`, `STANDALONE_QUOTA_KEYS`, `STANDALONE_FEATURE_KEYS`, `standaloneLicensePayloadV1Schema`, `standaloneActivationRequestSchema`, `verifyStandaloneLicense(compact, { origin, keys, retiredKids })`, фикстура `packages/domain/fixtures/standalone-license/activation-request.json`.
- Производит: таблицы `standalone_sites`, `standalone_license_issuances`; окружение `STANDALONE_LICENSE_ISSUER`, `STANDALONE_LICENSE_KID`, `STANDALONE_LICENSE_PRIVATE_KEY_PEM`, `STANDALONE_LICENSE_KEYSET_JSON`; обобщённый `signCompactJws(config, typ, payload)` (API); маршруты `platform/tenants/:tenantId/standalone-sites…`; возможность `standaloneLicenses.manage` (Д1); платформенный аудит; панель SaaS-админки в `apps/saas-admin/src/pages/tenants`.

**Правила исполненного состояния**

- Изоляция клиентов: каждая выборка и запись по площадкам и выпускам ограничена `tenant_id`; выпуск ссылается на площадку составным ключом `(tenant_id, site_id)`; маршрут с чужим `siteId` отвечает `404` и ничего не пишет; тесты проверяют отказ другому клиенту, а не только удачный путь.
- Платформенный пользователь, его подтверждённый второй фактор и клиент перечитываются в транзакции каждой операции (`requireStandaloneLicenseActor`); запись берёт их `FOR SHARE`.
- Строки аудита проверяются точно: субъект, роль, клиент, действие, итог, тип и идентификатор цели, `requestId`, `before`, `after`.
- Офлайн-гранты подписываются байт-в-байт как раньше; их тесты (`device-grants-*.test.ts`, `platform-grant-*.test.ts`) не меняются и остаются зелёными.
- Ни закрытый ключ, ни текст файла лицензии не попадают в лог и в ответ об ошибке; ошибки конфигурации — одной фразой без материала ключа.
- Ответы платформы проходят `parsePlatformResponse`; схемы ответов — строгие (`.strict()`), поля без `secret|session|token|password|totp|recovery` (OpenAPI-тест).

**Код и процесс**

- TypeScript strict: без `any`, без приведений `as` к широким типам и без `!` в исходниках; `import type` для типов.
- Пользовательский текст SaaS-админки — только через `apps/saas-admin/src/i18n/{ru,en}.json` (оба файла); компоненты — `@markiro/ui`; клавиатура, видимый фокус, подписи, ошибки в `role="alert"`, фаза лицензии — словом, не только цветом.
- `package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock` не меняются; новых зависимостей нет.
- Коммиты — явные пути, сообщение из файла (`git commit -F`), ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR, деплой — не задачи плана.

## Заметки для исполнения

**Основа и предусловия.** Ветка плана — от `claude/integration` с влитым ЛЦ-1. Перед задачей 1 убедиться, что есть `packages/domain/src/inn.ts`, `packages/domain/src/signed-documents/compact-jws.ts`, каталог `packages/domain/src/standalone-license/` и `packages/domain/fixtures/standalone-license/activation-request.json`, что `@markiro/domain` экспортирует имена из «Потребляет» (`node -e` по `packages/domain/dist/index.js` после сборки) и что `apps/api/src/modules/national-catalog/national-catalog.client.ts` импортирует `isValidInn` из `@markiro/domain`; иначе остановиться и назвать это в отчёте. Проверить и номер миграции: последний тег `packages/db/migrations/meta/_journal.json` должен быть `0185_*`; если там уже `0186` и дальше, взять следующий свободный и записать номер в «Отклонения».

**Форма данных ЛЦ-1.** Код плана читает у разобранного запроса активации поля спецификации §6.3: `hostId`, `hostVersion`, `organization.{name, inn}`, `trial` (`{ startedAt, inn }` или `null`), `usage.{stations, cabinetUsers, lines}`, `createdAt`; у результата `verifyStandaloneLicense` — `{ ok: true, kid, license } | { ok: false, reason }` (план ЛЦ-1, Д8). Если ЛЦ-1 назвал или сделал необязательным что-то иначе, исполнитель правит обращения по месту (в коде и тестах этого плана) и записывает это в «Отклонения»; поведение не меняется. Фикстурный ИНН ЛЦ-1 — `7707083893`; другие верные ИНН этого плана — `7728168971`, `7736207543`, `7707654321`; неверный — `7701234567` (контрольные суммы проверены при написании; задача 6 проверяет их тестом через `isValidInn`).

**Фрагменты.** Фрагменты взяты из дерева `/tmp/claude/wt/fb-license` (`f38f4a3e9`, основа `a4eef5cd6`) без ЛЦ-1; на копии не прогонялись. «Фрагмент … заменить на …» дан так, как стоит в файле; не находится — применить по смыслу и записать в «Отклонения при исполнении».

**Мутации.** `cp <файл> /tmp/claude/before && shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL названного теста; `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` молчит, `shasum` тот же. Мутации не коммитить; исход каждой записать в «Отклонения при исполнении».

**База данных.** Тесты `@markiro/db` и e2e API требуют `DATABASE_URL`; без него они пропускаются явно (`describe.skipIf`) — пропуск называть в отчёте, а не считать зелёным. Окружение: `set -a; source .env; set +a` (песочница не читает `.env` — такие команды запускать без песочницы) или одноразовый Postgres: `docker run -d --rm --name markiro-lc0-pg -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:17` и `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres`, затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:migrate`. Общая база разработки может отставать журналом от ветки — при «relation does not exist» сначала смотреть журнал миграций, а не код. Общие данные не удалять.

**Сборка зависимостей.** `@markiro/domain`, `@markiro/db`, `@markiro/platform-contracts`, `@markiro/ui` экспортируют `dist`: после правки пакета — `pnpm --config.verifyDepsBeforeRun=false --filter <пакет> build` до тестов потребителей. В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/api^...' --filter='@markiro/saas-admin^...'`.

**Перед каждым коммитом.** `node_modules/.bin/prettier --ignore-path .prettierignore --write <изменённые TS, TSX, JSON, MD, MJS>`, затем `--check` на них же (вывод `rtk` у prettier урезан — проверять через `rtk proxy`); `typecheck` и `lint` затронутых пакетов (`pnpm --config.verifyDepsBeforeRun=false --filter <пакет> run typecheck` / `run lint`); `git diff --check`.

**pnpm, git.** pnpm — только с `--config.verifyDepsBeforeRun=false`, без `pnpm install`/`add`; команды из корня, без `cd`; без `git stash`. Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный вывод `rtk` — `rtk proxy <команда>`. `tools/production-browser` (задача 12) запускается без песочницы (Chromium и `vite preview`), после `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin build`; рабочий каталог не менять (`pnpm --dir …`).

## Файлы

- Create (контракты): `packages/platform-contracts/src/standalone-licenses.ts`, `packages/platform-contracts/test/standalone-licenses.test.ts`
- Modify (контракты): `packages/platform-contracts/src/platform-auth.ts`, `packages/platform-contracts/src/index.ts`, `packages/platform-contracts/test/platform-auth.test.ts`
- Create (база): `packages/db/src/schema/standalone-licenses.ts`, `packages/db/migrations/0186_standalone_licenses.sql` (+ `meta/0186_snapshot.json`, запись в `meta/_journal.json` — генерирует drizzle-kit), `packages/db/test/standalone-licenses-schema.test.ts`, `packages/db/test/standalone-licenses-migration.test.ts`
- Modify (база): `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`
- Create (API): `apps/api/src/signing/compact-jws.ts`, `apps/api/src/modules/standalone-licenses/{standalone-license-keyset,standalone-license-rights,standalone-inn-check,standalone-license-authority,standalone-license-transaction,standalone-license-views,standalone-sites.service,standalone-license-issuance.service,platform-standalone-licenses.controller,platform-standalone-licenses.module}.ts`
- Create (тесты API): `apps/api/test/compact-jws-signing.test.ts`, `apps/api/test/standalone-license-keyset.test.ts`, `apps/api/test/standalone-license-rights.test.ts`, `apps/api/test/standalone-inn-check.test.ts`, `apps/api/test/support/standalone-license-fixture.ts`, `apps/api/test/standalone-sites.e2e.test.ts`, `apps/api/test/standalone-license-issuance.e2e.test.ts`, `apps/api/test/platform-standalone-licenses.routes.test.ts`
- Modify (API): `apps/api/src/modules/device-grants/grant-keyset.ts`, `apps/api/src/env.ts`, `apps/api/src/app.module.ts`, `apps/api/test/env.test.ts`, `apps/api/test/platform-route-contracts.ts`, `apps/api/test/platform-contract-openapi.test.ts`, `apps/api/test/subscription-route-inventory.test.ts`
- Modify (окружение и деплой): `.env.example`, `.env.production.example`, `deploy/yandex/runtime-env.mjs`, `deploy/yandex/test/runtime-env.test.mjs`
- Create (SaaS-админка): `apps/saas-admin/src/pages/tenants/{standalone-api,standalone-download}.ts`, `apps/saas-admin/src/pages/tenants/{StandaloneSitesPanel,StandaloneIssuanceHistory,StandaloneSiteRegistration,StandaloneLicenseIssue,StandaloneLicenseComparison}.tsx`, `apps/saas-admin/test/standalone-api.test.ts`, `apps/saas-admin/test/standalone-sites-panel.test.tsx`, `apps/saas-admin/test/standalone-license-flows.test.tsx`
- Modify (SaaS-админка): `apps/saas-admin/src/pages/tenants/TenantEquipmentPanel.tsx`, `apps/saas-admin/src/pages/tenants/TenantPage.tsx`, `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json`, `apps/saas-admin/test/render.tsx`, `apps/saas-admin/test/tenant-detail.test.tsx`
- Modify (браузерные проверки): `tools/production-browser/tenant-equipment-tests/fixture.ts`, `tools/production-browser/tenant-equipment-tests/workspace.spec.ts`
- Create/Modify (документы): `docs/operations/standalone-licenses.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (§24)

---

### Task 1: Контракты — возможность `standaloneLicenses.manage` и схемы площадок, выпуска и файла

**Files:**

- Create: `packages/platform-contracts/src/standalone-licenses.ts`
- Modify: `packages/platform-contracts/src/platform-auth.ts`, `packages/platform-contracts/src/index.ts`
- Test: `packages/platform-contracts/test/standalone-licenses.test.ts`, `packages/platform-contracts/test/platform-auth.test.ts`

**Interfaces:**

- Consumes: `STANDALONE_QUOTA_KEYS`, `STANDALONE_FEATURE_KEYS`, `standaloneActivationRequestSchema`, `standaloneLicensePayloadV1Schema` (`@markiro/domain`); `grantPublicKeySchema` (`offline-grants.ts`), `entitlementRevisionSchema` (`entitlements.ts`), примитивы.
- Produces: `"standaloneLicenses.manage"` в `platformCapabilitySchema` и `platformCapabilitiesForRole.platform_admin`; `standaloneLicenseSigningKeysetSchema`/`StandaloneLicenseSigningKeyset`; `standaloneLicenseRightsSchema`/`StandaloneLicenseRights`; `STANDALONE_SITE_WARNINGS`, `standaloneSiteWarningSchema`; `standaloneSiteHostHistorySchema`; `standaloneIssuanceWarningSchema`; `standaloneIssuanceSummarySchema`; `standaloneSiteSchema`, `standaloneSiteListSchema`; `standaloneSiteInspectRequestSchema`, `standaloneSiteInspectionSchema`; `standaloneSiteRegisterSchema`; `standaloneIssuancePreviewRequestSchema`, `standaloneIssuanceExpectationSchema`, `standaloneIssuancePreviewSchema`; `standaloneIssuanceConfirmSchema`; `standaloneLicenseFileSchema`; `standaloneIssuanceListSchema`; `platformStandaloneLicenseContracts`; типы `StandaloneSite`, `StandaloneSiteList`, `StandaloneSiteInspection`, `StandaloneSiteInspectRequest`, `StandaloneSiteRegister`, `StandaloneIssuanceSummary`, `StandaloneIssuancePreview`, `StandaloneIssuancePreviewRequest`, `StandaloneIssuanceConfirm`, `StandaloneLicenseFile`, `StandaloneIssuanceList`, `StandaloneIssuanceWarning`, `StandaloneSiteWarning`.

- [ ] **Step 1: Проверить предусловия ЛЦ-1**

<!-- prettier-ignore -->
```bash
ls packages/domain/src/inn.ts packages/domain/src/signed-documents/compact-jws.ts packages/domain/src/standalone-license packages/domain/fixtures/standalone-license/activation-request.json
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build
node -e 'import("./packages/domain/dist/index.js").then((d) => { for (const n of ["normalizeInn","isValidInn","STANDALONE_LICENSE_TYP","STANDALONE_QUOTA_KEYS","STANDALONE_FEATURE_KEYS","standaloneLicensePayloadV1Schema","standaloneActivationRequestSchema","verifyStandaloneLicense"]) if (!(n in d)) { console.error("missing", n); process.exitCode = 1; } })'
git grep -n "isValidInn" -- apps/api/src/modules/national-catalog/national-catalog.client.ts
tail -8 packages/db/migrations/meta/_journal.json
```

Ожидается: все пути есть, `node -e` молчит с кодом 0, импорт `isValidInn` из `@markiro/domain` найден, последний тег журнала — `0185_standard_label_branding`. Иначе — остановиться (см. «Заметки для исполнения»).

- [ ] **Step 2: Написать падающие тесты**

Правка `packages/platform-contracts/test/platform-auth.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
const ADMIN_CAPABILITIES = [
  "tenants.read",
  "tenants.write",
  "catalog.read",
  "catalog.write",
  "offlineGrants.activate",
  "services.read",
```

заменить на:

<!-- prettier-ignore -->
```ts
const ADMIN_CAPABILITIES = [
  "tenants.read",
  "tenants.write",
  "catalog.read",
  "catalog.write",
  "offlineGrants.activate",
  "standaloneLicenses.manage",
  "services.read",
```

Фрагмент 2 (конец файла):

<!-- prettier-ignore -->
```ts
describe("offline grant activation capabilities", () => {
  it("allows only platform administrators to activate strict cohorts", () => {
    expect(platformCapabilitiesForRole.platform_admin).toContain("offlineGrants.activate");
    expect(platformCapabilitiesForRole.support).not.toContain("offlineGrants.activate");
    expect(platformCapabilitiesForRole.accountant).not.toContain("offlineGrants.activate");
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
describe("offline grant activation capabilities", () => {
  it("allows only platform administrators to activate strict cohorts", () => {
    expect(platformCapabilitiesForRole.platform_admin).toContain("offlineGrants.activate");
    expect(platformCapabilitiesForRole.support).not.toContain("offlineGrants.activate");
    expect(platformCapabilitiesForRole.accountant).not.toContain("offlineGrants.activate");
  });
});

describe("standalone license capabilities (plan ЛЦ-0)", () => {
  it("lets only platform administrators register standalone sites and issue offline licenses", () => {
    expect(platformCapabilitiesForRole.platform_admin).toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole.support).not.toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole.accountant).not.toContain("standaloneLicenses.manage");
  });
});
```

Создать `packages/platform-contracts/test/standalone-licenses.test.ts`:

<!-- prettier-ignore -->
```ts
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_QUOTA_KEYS,
  standaloneActivationRequestSchema,
  standaloneLicensePayloadV1Schema,
} from "@markiro/domain";
import {
  platformStandaloneLicenseContracts,
  standaloneIssuanceConfirmSchema,
  standaloneIssuanceWarningSchema,
  standaloneLicenseFileSchema,
  standaloneLicenseSigningKeysetSchema,
  standaloneLicenseRightsSchema,
  standaloneSiteRegisterSchema,
} from "../src/index.js";

const ORIGIN = "https://api.example.invalid";
const request = standaloneActivationRequestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../domain/fixtures/standalone-license/activation-request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

function publicJwk() {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "jwk",
  });
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function keyset(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "standalone-license-v1",
    origin: ORIGIN,
    revision: "lic-v1",
    keys: [{ kid: "lic-1", jwk: publicJwk() }],
    retiredKids: [],
    ...overrides,
  };
}

describe("standalone license keyset (plan ЛЦ-0, Д11)", () => {
  it("accepts the grant keyset shape under its own protocol literal", () => {
    expect(standaloneLicenseSigningKeysetSchema.parse(keyset()).keys[0]?.kid).toBe("lic-1");
  });

  it("refuses the grant protocol literal, a path origin, duplicate kids and duplicate retired kids", () => {
    const key = { kid: "lic-1", jwk: publicJwk() };
    for (const invalid of [
      keyset({ protocol: "offline-grants-v1" }),
      keyset({ origin: `${ORIGIN}/` }),
      keyset({ origin: `${ORIGIN}/licenses` }),
      keyset({ keys: [key, key] }),
      keyset({ retiredKids: ["old", "old"] }),
      keyset({ keys: [{ kid: "lic-1", jwk: { ...publicJwk(), d: "private" } }] }),
      { ...keyset(), extra: true },
    ]) {
      expect(standaloneLicenseSigningKeysetSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("standalone license rights", () => {
  it("names exactly the cloud quota and feature keys the payload carries", () => {
    expect(Object.keys(standaloneLicenseRightsSchema.shape.quotas.shape)).toEqual([
      ...STANDALONE_QUOTA_KEYS,
    ]);
    expect(Object.keys(standaloneLicenseRightsSchema.shape.features.shape)).toEqual([
      ...STANDALONE_FEATURE_KEYS,
    ]);
  });

  it("keeps null as unlimited for quotas and refuses null features", () => {
    const rights = {
      quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
      features: {
        labelEditor: true,
        publicApi: false,
        pallets: true,
        chzIntegration: false,
        inventory: false,
        commerceMl: false,
        handheld: true,
      },
    };
    expect(standaloneLicenseRightsSchema.parse(rights)).toEqual(rights);
    expect(
      standaloneLicenseRightsSchema.safeParse({
        ...rights,
        features: { ...rights.features, handheld: null },
      }).success,
    ).toBe(false);
  });
});

describe("standalone license payload tenant id (Д14)", () => {
  it("is a canonical lower-case UUID in the ЛЦ-1 payload, so a cabinet-era id cannot be issued", () => {
    const payload = {
      version: 1,
      licenseId: randomUUID(),
      sequence: 1,
      issuer: ORIGIN,
      tenantId: randomUUID(),
      siteId: randomUUID(),
      hostId: request.hostId,
      customer: { name: "ООО «Завод»", inn: "7707083893" },
      plan: "subscription",
      planVersionId: randomUUID(),
      entitlementRevision: "7",
      issuedAt: 1_792_000_000_000,
      validFrom: 1_792_000_000_000,
      validUntil: 1_799_000_000_000,
      graceDays: 14,
      quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
      features: {
        labelEditor: true,
        publicApi: false,
        pallets: true,
        chzIntegration: false,
        inventory: false,
        commerceMl: false,
        handheld: true,
      },
      replaces: null,
    };
    expect(standaloneLicensePayloadV1Schema.safeParse(payload).success).toBe(true);
    expect(
      standaloneLicensePayloadV1Schema.safeParse({ ...payload, tenantId: "Zq4bL0x9cabinetTenant01" })
        .success,
    ).toBe(false);
  });
});

describe("standalone site registration body", () => {
  const base = { requestId: randomUUID(), request, acknowledgedWarnings: [] };

  it("accepts a new site and a new host id for an existing site", () => {
    expect(
      standaloneSiteRegisterSchema.parse({ ...base, intent: "create", name: "  Цех  " }),
    ).toMatchObject({ intent: "create", name: "Цех" });
    const siteId = randomUUID();
    expect(standaloneSiteRegisterSchema.parse({ ...base, intent: "rebind", siteId })).toMatchObject(
      { intent: "rebind", siteId },
    );
  });

  it("refuses a blank name, an unknown warning, an unknown field and a malformed request", () => {
    for (const invalid of [
      { ...base, intent: "create", name: "   " },
      { ...base, intent: "create", name: "Цех", acknowledgedWarnings: ["inn_whatever"] },
      { ...base, intent: "create", name: "Цех", tenantId: "other" },
      { ...base, intent: "create", name: "Цех", request: { ...request, extra: 1 } },
      { ...base, intent: "rebind", name: "Цех" },
    ]) {
      expect(standaloneSiteRegisterSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("standalone issuance confirmation and file", () => {
  it("requires the preview expectation and bounds grace days", () => {
    const expected = { entitlementRevision: "7", previousSequence: 0, boundaryAt: null };
    expect(
      standaloneIssuanceConfirmSchema.parse({ requestId: randomUUID(), graceDays: null, expected }),
    ).toMatchObject({ graceDays: null, expected });
    for (const invalid of [
      { requestId: randomUUID(), graceDays: null },
      { requestId: randomUUID(), graceDays: 61, expected },
      { requestId: randomUUID(), graceDays: -1, expected },
      { requestId: "not-a-uuid", graceDays: 0, expected },
    ]) {
      expect(standaloneIssuanceConfirmSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("bounds the file to 16 KiB and the canonical file name", () => {
    const shape = standaloneLicenseFileSchema.shape;
    expect(shape.compact.safeParse("a".repeat(16_384)).success).toBe(true);
    expect(shape.compact.safeParse("a".repeat(16_385)).success).toBe(false);
    expect(shape.fileName.safeParse("markiro-3f1c2d4e-001.mklic").success).toBe(true);
    expect(shape.fileName.safeParse("../markiro-3f1c2d4e-001.mklic").success).toBe(false);
  });

  it("describes each issuance warning by code with its own facts", () => {
    expect(
      standaloneIssuanceWarningSchema.parse({
        code: "quota_below_usage",
        quota: "stations",
        limit: 2,
        used: 4,
      }),
    ).toEqual({ code: "quota_below_usage", quota: "stations", limit: 2, used: 4 });
    expect(
      standaloneIssuanceWarningSchema.safeParse({ code: "feature_unmapped", feature: "lines" })
        .success,
    ).toBe(false);
  });

  it("publishes every route under the tenant's standalone sites", () => {
    expect(
      Object.values(platformStandaloneLicenseContracts).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "GET /platform/tenants/:tenantId/standalone-sites",
      "POST /platform/tenants/:tenantId/standalone-sites/inspect",
      "POST /platform/tenants/:tenantId/standalone-sites",
      "POST /platform/tenants/:tenantId/standalone-sites/:siteId/issuances/preview",
      "POST /platform/tenants/:tenantId/standalone-sites/:siteId/issuances",
      "GET /platform/tenants/:tenantId/standalone-sites/:siteId/issuances",
      "GET /platform/tenants/:tenantId/standalone-sites/:siteId/issuances/:licenseId/file",
    ]);
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-licenses.test.ts test/platform-auth.test.ts
```

Ожидается: FAIL — импорт `../src/index.js` не находит `standaloneLicenseSigningKeysetSchema` и остальные; в `platform-auth.test.ts` — «accepts every platform role…» и «lets only platform administrators…». Тест «… tenant id (Д14)» проходит уже сейчас — он закрепляет ограничение ЛЦ-1, на которое опирается задача 8.

- [ ] **Step 4: Реализация**

Правка `packages/platform-contracts/src/platform-auth.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  "catalog.write",
  "offlineGrants.activate",
  "services.read",
  "services.write",
  "billing.read",
  "billing.write",
  "agreements.read",
  "agreements.write",
  "platformTeam.write",
  "audit.read",
  "diagnostics.read",
  "reports.read",
  "reports.create",
  "reports.download",
  "reports.identified",
]);
```

заменить на:

<!-- prettier-ignore -->
```ts
  "catalog.write",
  "offlineGrants.activate",
  "standaloneLicenses.manage",
  "services.read",
  "services.write",
  "billing.read",
  "billing.write",
  "agreements.read",
  "agreements.write",
  "platformTeam.write",
  "audit.read",
  "diagnostics.read",
  "reports.read",
  "reports.create",
  "reports.download",
  "reports.identified",
]);
```

Фрагмент 2 (список `platform_admin`):

<!-- prettier-ignore -->
```ts
  platform_admin: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "catalog.write",
    "offlineGrants.activate",
    "services.read",
```

заменить на:

<!-- prettier-ignore -->
```ts
  platform_admin: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "catalog.write",
    "offlineGrants.activate",
    "standaloneLicenses.manage",
    "services.read",
```

Создать `packages/platform-contracts/src/standalone-licenses.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_QUOTA_KEYS,
  standaloneActivationRequestSchema,
} from "@markiro/domain";

import { entitlementRevisionSchema } from "./entitlements.js";
import { grantPublicKeySchema } from "./offline-grants.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

/** Plan ЛЦ-0: the SaaS admin issues signed offline licenses for «Markiro Автоном» sites. */
const innSchema = z.string().regex(/^\d{10}(\d{2})?$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quotaLimitSchema = countSchema.nullable();
const graceDaysSchema = z.number().int().min(0).max(60);
const sequenceSchema = z.number().int().positive().max(2_147_483_647);
const platformUserIdSchema = z.string().min(1).max(128);

/**
 * The license keyset has the grant keyset's shape and checks (`grantKeysetSchema`)
 * under its own protocol literal: the license key is never the grant key.
 */
export const standaloneLicenseSigningKeysetSchema = z
  .object({
    protocol: z.literal("standalone-license-v1"),
    origin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      }),
    revision: z.string().min(1).max(256),
    keys: z.array(grantPublicKeySchema).min(1).max(64),
    retiredKids: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict()
  .refine((value) => new Set(value.keys.map((key) => key.kid)).size === value.keys.length)
  .refine((value) => new Set(value.retiredKids).size === value.retiredKids.length);
export type StandaloneLicenseSigningKeyset = z.infer<typeof standaloneLicenseSigningKeysetSchema>;

/** Quotas and features as the file carries them: `null` quota is unlimited, features are booleans. */
export const standaloneLicenseRightsSchema = z
  .object({
    quotas: z
      .object({
        lines: quotaLimitSchema,
        stations: quotaLimitSchema,
        kiosks: quotaLimitSchema,
        cabinetUsers: quotaLimitSchema,
      })
      .strict(),
    features: z
      .object({
        labelEditor: z.boolean(),
        publicApi: z.boolean(),
        pallets: z.boolean(),
        chzIntegration: z.boolean(),
        inventory: z.boolean(),
        commerceMl: z.boolean(),
        handheld: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type StandaloneLicenseRights = z.infer<typeof standaloneLicenseRightsSchema>;

export const STANDALONE_SITE_WARNINGS = [
  "request_inn_missing",
  "request_inn_invalid",
  "org_inn_missing",
  "request_inn_differs_org",
  "request_inn_differs_billing",
  "trial_inn_differs",
] as const;
export const standaloneSiteWarningSchema = z.enum(STANDALONE_SITE_WARNINGS);
export type StandaloneSiteWarning = z.infer<typeof standaloneSiteWarningSchema>;

export const standaloneSiteHostHistorySchema = z
  .array(
    z
      .object({
        hostId: platformUuidSchema,
        requestInn: innSchema.nullable(),
        requestId: platformUuidSchema,
        boundAt: platformTimestampSchema,
        boundByPlatformUserId: platformUserIdSchema,
      })
      .strict(),
  )
  .min(1)
  .max(100);

export const standaloneIssuanceWarningSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("customer_inn_from_billing") }).strict(),
  z.object({ code: z.literal("billing_inn_differs"), billingInn: innSchema }).strict(),
  z.object({ code: z.literal("site_inn_differs"), siteInn: innSchema.nullable() }).strict(),
  z
    .object({
      code: z.literal("quota_below_usage"),
      quota: z.enum(STANDALONE_QUOTA_KEYS),
      limit: countSchema,
      used: countSchema,
    })
    .strict(),
  z
    .object({ code: z.literal("feature_unmapped"), feature: z.enum(STANDALONE_FEATURE_KEYS) })
    .strict(),
]);
export type StandaloneIssuanceWarning = z.infer<typeof standaloneIssuanceWarningSchema>;

const validUntilReasonSchema = z.enum(["subscription_end", "entitlement_reduction", "one_year_cap"]);
const customerSchema = z.object({ name: z.string().min(1).max(300), inn: innSchema }).strict();
const planSchema = z.enum(["demo", "subscription"]);

export const standaloneIssuanceSummarySchema = z
  .object({
    licenseId: platformUuidSchema,
    siteId: platformUuidSchema,
    sequence: sequenceSchema,
    hostId: platformUuidSchema,
    plan: planSchema,
    planVersionId: platformUuidSchema,
    entitlementRevision: entitlementRevisionSchema,
    validFrom: platformTimestampSchema,
    validUntil: platformTimestampSchema,
    validUntilReason: validUntilReasonSchema,
    graceDays: graceDaysSchema,
    kid: z.string().min(1).max(128),
    sha256: sha256Schema,
    issuedAt: platformTimestampSchema,
    issuedByPlatformUserId: platformUserIdSchema,
    replaces: platformUuidSchema.nullable(),
    customer: customerSchema,
    rights: standaloneLicenseRightsSchema,
  })
  .strict();
export type StandaloneIssuanceSummary = z.infer<typeof standaloneIssuanceSummarySchema>;

const siteUsageSchema = z
  .object({ stations: countSchema, cabinetUsers: countSchema, lines: countSchema })
  .strict();

export const standaloneSiteSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    hostId: platformUuidSchema,
    name: z.string().min(1).max(200),
    requestInn: innSchema.nullable(),
    hostVersion: z.string().min(1).max(64).nullable(),
    usage: siteUsageSchema.nullable(),
    requestCreatedAt: platformTimestampSchema.nullable(),
    hostHistory: standaloneSiteHostHistorySchema,
    lastIssuedSequence: z.number().int().nonnegative(),
    latestIssuance: standaloneIssuanceSummarySchema.nullable(),
    renewalDue: z.boolean(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type StandaloneSite = z.infer<typeof standaloneSiteSchema>;

export const standaloneSiteListSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    signingConfigured: z.boolean(),
    sites: z.array(standaloneSiteSchema).max(500),
  })
  .strict();
export type StandaloneSiteList = z.infer<typeof standaloneSiteListSchema>;

export const standaloneSiteInspectRequestSchema = z
  .object({ request: standaloneActivationRequestSchema })
  .strict();
export type StandaloneSiteInspectRequest = z.infer<typeof standaloneSiteInspectRequestSchema>;

export const standaloneSiteInspectionSchema = z
  .object({
    hostId: platformUuidSchema,
    hostVersion: z.string().min(1).max(64).nullable(),
    organizationName: z.string().max(500).nullable(),
    usage: siteUsageSchema,
    innFacts: z
      .object({
        requestInn: innSchema.nullable(),
        orgInn: innSchema.nullable(),
        billingInn: innSchema.nullable(),
        trialInn: innSchema.nullable(),
      })
      .strict(),
    warnings: z.array(standaloneSiteWarningSchema).max(STANDALONE_SITE_WARNINGS.length),
    blocking: z.enum(["host_registered", "host_taken"]).nullable(),
    registeredSite: z
      .object({ id: platformUuidSchema, name: z.string().min(1).max(200) })
      .strict()
      .nullable(),
  })
  .strict();
export type StandaloneSiteInspection = z.infer<typeof standaloneSiteInspectionSchema>;

const acknowledgedWarningsSchema = z
  .array(standaloneSiteWarningSchema)
  .max(STANDALONE_SITE_WARNINGS.length);
export const standaloneSiteRegisterSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("create"),
      requestId: platformUuidSchema,
      name: z.string().trim().min(1).max(200),
      request: standaloneActivationRequestSchema,
      acknowledgedWarnings: acknowledgedWarningsSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal("rebind"),
      requestId: platformUuidSchema,
      siteId: platformUuidSchema,
      request: standaloneActivationRequestSchema,
      acknowledgedWarnings: acknowledgedWarningsSchema,
    })
    .strict(),
]);
export type StandaloneSiteRegister = z.infer<typeof standaloneSiteRegisterSchema>;

export const standaloneIssuancePreviewRequestSchema = z
  .object({ graceDays: graceDaysSchema.nullable() })
  .strict();
export type StandaloneIssuancePreviewRequest = z.infer<
  typeof standaloneIssuancePreviewRequestSchema
>;

/** What the operator saw; confirmation recomputes and refuses when any of it moved. */
export const standaloneIssuanceExpectationSchema = z
  .object({
    entitlementRevision: entitlementRevisionSchema,
    previousSequence: z.number().int().nonnegative().max(2_147_483_647),
    boundaryAt: platformTimestampSchema.nullable(),
  })
  .strict();

export const standaloneIssuancePreviewSchema = z
  .object({
    siteId: platformUuidSchema,
    hostId: platformUuidSchema,
    previous: standaloneIssuanceSummarySchema.nullable(),
    next: z
      .object({
        sequence: sequenceSchema,
        plan: planSchema,
        planVersionId: platformUuidSchema,
        entitlementRevision: entitlementRevisionSchema,
        validFrom: platformTimestampSchema,
        validUntil: platformTimestampSchema,
        validUntilReason: validUntilReasonSchema,
        graceDays: graceDaysSchema,
        customer: customerSchema,
        rights: standaloneLicenseRightsSchema,
      })
      .strict(),
    warnings: z.array(standaloneIssuanceWarningSchema).max(32),
    expected: standaloneIssuanceExpectationSchema,
  })
  .strict();
export type StandaloneIssuancePreview = z.infer<typeof standaloneIssuancePreviewSchema>;

export const standaloneIssuanceConfirmSchema = z
  .object({
    requestId: platformUuidSchema,
    graceDays: graceDaysSchema.nullable(),
    expected: standaloneIssuanceExpectationSchema,
  })
  .strict();
export type StandaloneIssuanceConfirm = z.infer<typeof standaloneIssuanceConfirmSchema>;

export const standaloneLicenseFileSchema = z
  .object({
    issuance: standaloneIssuanceSummarySchema,
    fileName: z.string().regex(/^markiro-[0-9a-f]{8}-\d{3,}\.mklic$/),
    compact: z.string().min(1).max(16_384),
    sha256: sha256Schema,
  })
  .strict();
export type StandaloneLicenseFile = z.infer<typeof standaloneLicenseFileSchema>;

export const standaloneIssuanceListSchema = z
  .object({ siteId: platformUuidSchema, items: z.array(standaloneIssuanceSummarySchema).max(1_000) })
  .strict();
export type StandaloneIssuanceList = z.infer<typeof standaloneIssuanceListSchema>;

const sites = "/platform/tenants/:tenantId/standalone-sites";
export const platformStandaloneLicenseContracts = {
  list: { method: "GET", path: sites, response: standaloneSiteListSchema },
  inspect: {
    method: "POST",
    path: `${sites}/inspect`,
    body: standaloneSiteInspectRequestSchema,
    response: standaloneSiteInspectionSchema,
  },
  register: {
    method: "POST",
    path: sites,
    body: standaloneSiteRegisterSchema,
    response: standaloneSiteSchema,
  },
  previewIssuance: {
    method: "POST",
    path: `${sites}/:siteId/issuances/preview`,
    body: standaloneIssuancePreviewRequestSchema,
    response: standaloneIssuancePreviewSchema,
  },
  confirmIssuance: {
    method: "POST",
    path: `${sites}/:siteId/issuances`,
    body: standaloneIssuanceConfirmSchema,
    response: standaloneLicenseFileSchema,
  },
  listIssuances: {
    method: "GET",
    path: `${sites}/:siteId/issuances`,
    response: standaloneIssuanceListSchema,
  },
  download: {
    method: "GET",
    path: `${sites}/:siteId/issuances/:licenseId/file`,
    response: standaloneLicenseFileSchema,
  },
} as const;
```

Правка `packages/platform-contracts/src/index.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
export type { PublicApiScope } from "./public-api.js";
export * from "./offline-grants.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
export type { PublicApiScope } from "./public-api.js";
export * from "./offline-grants.js";
export * from "./standalone-licenses.js";
```

- [ ] **Step 5: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-licenses.test.ts test/platform-auth.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts test
```

Ожидается: PASS; весь пакет зелёный (включая тест ЛЦ-1 «`STANDALONE_*_KEYS` равны `ENTITLEMENT_*_KEYS`»).

- [ ] **Step 6: Гейты и сборка**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/auth.test.tsx test/tenant-detail.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/platform-contracts/src/standalone-licenses.ts packages/platform-contracts/src/platform-auth.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-licenses.test.ts packages/platform-contracts/test/platform-auth.test.ts
git diff --check
```

Ожидается: всё зелёное; SaaS-админка выводит возможности из `platformCapabilitiesForRole` (корневой `AGENTS.md`), её наборы не падают от новой возможности.

- [ ] **Step 7: Коммит**

<!-- prettier-ignore -->
```bash
git add packages/platform-contracts/src/standalone-licenses.ts packages/platform-contracts/src/platform-auth.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-licenses.test.ts packages/platform-contracts/test/platform-auth.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(platform-contracts): standalone offline license contracts and capability (plan ЛЦ-0)

standaloneLicenses.manage for platform administrators only; the license keyset
(grant keyset shape, own protocol literal), the file's rights, standalone
sites, activation-request registration with INN warnings, issuance preview,
confirmation and file, and the seven platform routes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 2: База — таблицы `standalone_sites` и `standalone_license_issuances`, миграция `0186`

**Files:**

- Create: `packages/db/src/schema/standalone-licenses.ts`, `packages/db/migrations/0186_standalone_licenses.sql`, `packages/db/migrations/meta/0186_snapshot.json` (генерирует drizzle-kit; запись в `meta/_journal.json` — тоже он)
- Modify: `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`
- Test: `packages/db/test/standalone-licenses-schema.test.ts`, `packages/db/test/standalone-licenses-migration.test.ts`

**Interfaces:**

- Consumes: `organization` (`schema/auth.ts`), `platformUsers` (`schema/platform-auth.ts`).
- Produces: `standaloneSites` (`id`, `tenantId`, `hostId` UNIQUE, `name`, `requestInn`, `lastActivationRequest`, `hostHistory`, `lastIssuedSequence`, `requestId`, `createdByPlatformUserId`, `createdAt`, `updatedAt`); `standaloneLicenseIssuances` (`id` = `licenseId`, `tenantId`, `siteId`, `sequence`, `requestId`, `hostId`, `plan`, `planVersionId`, `entitlementRevision`, `payload`, `compact`, `sha256`, `kid`, `graceDays`, `issuedAt`, `validFrom`, `validUntil`, `validUntilReason`, `replacesId`, `issuedByPlatformUserId`); ограничения `standalone_sites_host_id_uq`, `standalone_sites_tenant_request_uq`, `standalone_license_issuances_site_sequence_uq`, `standalone_license_issuances_tenant_site_request_uq`, `standalone_license_issuances_tenant_site_fk`.

- [ ] **Step 1: Написать падающие тесты**

Создать `packages/db/test/standalone-licenses-schema.test.ts`:

<!-- prettier-ignore -->
```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("standalone license schema (plan ЛЦ-0)", () => {
  it("exports the site registry and the issuance journal", () => {
    expect(schema).toHaveProperty("standaloneSites");
    expect(schema).toHaveProperty("standaloneLicenseIssuances");
  });

  it("binds an issuance to its tenant's site by a composite key and orders it per site", () => {
    const issuances = getTableConfig(schema.standaloneLicenseIssuances);
    expect(
      issuances.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_license_issuances_tenant_site_fk" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,site_id",
      ),
    ).toBe(true);
    expect(
      issuances.uniqueConstraints.map((constraint) => [
        constraint.getName(),
        constraint.columns.map((column) => column.name).join(","),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["standalone_license_issuances_site_sequence_uq", "site_id,sequence"],
        ["standalone_license_issuances_tenant_site_request_uq", "tenant_id,site_id,request_id"],
      ]),
    );
    const sites = getTableConfig(schema.standaloneSites);
    expect(
      sites.uniqueConstraints.map((constraint) => [
        constraint.getName(),
        constraint.columns.map((column) => column.name).join(","),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["standalone_sites_host_id_uq", "host_id"],
        ["standalone_sites_tenant_id_uq", "tenant_id,id"],
        ["standalone_sites_tenant_request_uq", "tenant_id,request_id"],
      ]),
    );
  });
});
```

Создать `packages/db/test/standalone-licenses-migration.test.ts`:

<!-- prettier-ignore -->
```ts
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixturePool } from "./support/close-pool.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("standalone license tables on a fresh database (plan ЛЦ-0)", () => {
  const name = `markiro_lc0_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  const siteA = randomUUID();
  const hostA = randomUUID();

  async function site(tenant: string, id = randomUUID(), host = randomUUID(), inn: string | null = "7707083893") {
    await pool.query(
      `INSERT INTO standalone_sites (id, tenant_id, host_id, name, request_inn, last_activation_request, host_history, request_id, created_by_platform_user_id)
       VALUES ($1, $2, $3, 'Цех', $4, '{"format":"markiro-activation-request-v1"}', '[{"hostId":"x"}]', $5, 'lc0-admin')`,
      [id, tenant, host, inn, randomUUID()],
    );
    return id;
  }

  async function issuance(
    overrides: { tenant?: string; site?: string; sequence?: number; plan?: string; grace?: number; sha?: string } = {},
  ) {
    return pool.query(
      `INSERT INTO standalone_license_issuances (id, tenant_id, site_id, sequence, request_id, host_id, plan, plan_version_id, entitlement_revision, payload, compact, sha256, kid, grace_days, issued_at, valid_from, valid_until, valid_until_reason, issued_by_platform_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 7, '{"version":1}', 'h.p.s', $9, 'lic-1', $10, now(), now(), now() + interval '30 days', 'subscription_end', 'lc0-admin')`,
      [
        randomUUID(),
        overrides.tenant ?? "lc0-a",
        overrides.site ?? siteA,
        overrides.sequence ?? 1,
        randomUUID(),
        hostA,
        overrides.plan ?? "subscription",
        randomUUID(),
        overrides.sha ?? "a".repeat(64),
        overrides.grace ?? 14,
      ],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('lc0-a', 'A', 'lc0-a', now()), ('lc0-b', 'B', 'lc0-b', now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id, email, name, role, status, two_factor_enabled) VALUES ('lc0-admin', 'lc0@example.invalid', 'LC0', 'platform_admin', 'active', true)",
    );
    await site("lc0-a", siteA, hostA);
  }, 180_000);

  afterAll(async () => {
    await closeFixturePool(pool);
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
  });

  it("keeps one site per host across tenants and a valid request INN", async () => {
    await expect(site("lc0-b", randomUUID(), hostA)).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_sites_host_id_uq",
    });
    await expect(site("lc0-a", randomUUID(), randomUUID(), "7707")).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_sites_request_inn_check",
    });
  });

  it("orders issuances per site, refuses another tenant's site and a demo with grace days", async () => {
    await issuance();
    await expect(issuance()).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_license_issuances_site_sequence_uq",
    });
    await expect(issuance({ tenant: "lc0-b", sequence: 2 })).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_license_issuances_tenant_site_fk",
    });
    await expect(issuance({ sequence: 3, plan: "demo", grace: 3 })).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_shape_check",
    });
    await expect(issuance({ sequence: 4, sha: "XYZ" })).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_shape_check",
    });
    await expect(issuance({ sequence: 0 })).rejects.toMatchObject({ code: "23514" });
    await issuance({ sequence: 2, plan: "demo", grace: 0 });
    const { rows } = await pool.query(
      "SELECT sequence FROM standalone_license_issuances WHERE site_id = $1 ORDER BY sequence",
      [siteA],
    );
    expect(rows).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });
});
```

Колонки `platform_users` в сыром SQL — по `packages/db/src/schema/platform-auth.ts`; если там есть другие обязательные колонки без умолчания, исполнитель добавляет их и записывает.

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/standalone-licenses-schema.test.ts test/standalone-licenses-migration.test.ts
```

Ожидается: FAIL — `standaloneSites` нет в схеме; миграционный тест (при `DATABASE_URL`) — `relation "standalone_sites" does not exist`; без `DATABASE_URL` миграционный — SKIP (назвать в отчёте).

- [ ] **Step 3: Реализация схемы**

Создать `packages/db/src/schema/standalone-licenses.ts`:

<!-- prettier-ignore -->
```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

/**
 * A «Markiro Автоном» site: one host identity (`host.json` hostId) bound to a
 * tenant (spec 2026-10-13 §6.2). A new host id of the same site is a rebind:
 * the history keeps every host id and the sequence of license files goes on.
 */
export const standaloneSites = pgTable(
  "standalone_sites",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    hostId: uuid("host_id").notNull(),
    name: text("name").notNull(),
    requestInn: text("request_inn"),
    lastActivationRequest: jsonb("last_activation_request")
      .$type<Record<string, unknown>>()
      .notNull(),
    hostHistory: jsonb("host_history").$type<unknown[]>().notNull(),
    lastIssuedSequence: integer("last_issued_sequence").notNull().default(0),
    requestId: uuid("request_id").notNull(),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("standalone_sites_tenant_id_uq").on(t.tenantId, t.id),
    unique("standalone_sites_host_id_uq").on(t.hostId),
    unique("standalone_sites_tenant_request_uq").on(t.tenantId, t.requestId),
    check("standalone_sites_name_check", sql`length(btrim(${t.name})) between 1 and 200`),
    check(
      "standalone_sites_request_inn_check",
      sql`${t.requestInn} is null or ${t.requestInn} ~ '^[0-9]{10}([0-9]{2})?$'`,
    ),
    check("standalone_sites_sequence_check", sql`${t.lastIssuedSequence} >= 0`),
    check(
      "standalone_sites_payload_check",
      sql`jsonb_typeof(${t.lastActivationRequest}) = 'object' and octet_length(${t.lastActivationRequest}::text) <= 65536 and case when jsonb_typeof(${t.hostHistory}) = 'array' then jsonb_array_length(${t.hostHistory}) between 1 and 100 else false end`,
    ),
  ],
);

/** The issuance journal: every signed `.mklic` file, append-only, ordered per site. */
export const standaloneLicenseIssuances = pgTable(
  "standalone_license_issuances",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    siteId: uuid("site_id").notNull(),
    sequence: integer("sequence").notNull(),
    requestId: uuid("request_id").notNull(),
    hostId: uuid("host_id").notNull(),
    plan: text("plan").$type<"demo" | "subscription">().notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
    entitlementRevision: bigint("entitlement_revision", { mode: "bigint" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    compact: text("compact").notNull(),
    sha256: text("sha256").notNull(),
    kid: text("kid").notNull(),
    graceDays: integer("grace_days").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    validUntilReason: text("valid_until_reason")
      .$type<"subscription_end" | "entitlement_reduction" | "one_year_cap">()
      .notNull(),
    replacesId: uuid("replaces_id"),
    issuedByPlatformUserId: text("issued_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
  },
  (t) => [
    unique("standalone_license_issuances_site_sequence_uq").on(t.siteId, t.sequence),
    unique("standalone_license_issuances_site_id_uq").on(t.siteId, t.id),
    unique("standalone_license_issuances_tenant_site_request_uq").on(
      t.tenantId,
      t.siteId,
      t.requestId,
    ),
    index("standalone_license_issuances_tenant_site_idx").on(t.tenantId, t.siteId, t.sequence),
    foreignKey({
      name: "standalone_license_issuances_tenant_site_fk",
      columns: [t.tenantId, t.siteId],
      foreignColumns: [standaloneSites.tenantId, standaloneSites.id],
    }),
    foreignKey({
      name: "standalone_license_issuances_site_replaces_fk",
      columns: [t.siteId, t.replacesId],
      foreignColumns: [t.siteId, t.id],
    }),
    check(
      "standalone_license_issuances_shape_check",
      sql`${t.sequence} > 0 and ${t.graceDays} between 0 and 60 and ${t.plan} in ('demo','subscription') and (${t.plan} <> 'demo' or ${t.graceDays} = 0) and ${t.sha256} ~ '^[0-9a-f]{64}$' and length(btrim(${t.kid})) between 1 and 128 and octet_length(${t.compact}) between 1 and 16384 and ${t.entitlementRevision} >= 0 and ${t.validUntilReason} in ('subscription_end','entitlement_reduction','one_year_cap')`,
    ),
    check(
      "standalone_license_issuances_interval_check",
      sql`isfinite(${t.issuedAt}) and isfinite(${t.validFrom}) and isfinite(${t.validUntil}) and ${t.validUntil} > ${t.validFrom}`,
    ),
    check(
      "standalone_license_issuances_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 16384`,
    ),
  ],
);
```

Правка `packages/db/src/schema.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
export * from "./schema/device-grant-activations.js";
export * from "./schema/service-periods.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
export * from "./schema/device-grant-activations.js";
export * from "./schema/service-periods.js";
export * from "./schema/standalone-licenses.js";
```

Правка `packages/db/drizzle.config.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
    "./src/schema/national-catalog-import.ts",
  ],
```

заменить на:

<!-- prettier-ignore -->
```ts
    "./src/schema/national-catalog-import.ts",
    "./src/schema/standalone-licenses.ts",
  ],
```

- [ ] **Step 4: Сгенерировать и просмотреть миграцию**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec drizzle-kit generate --name standalone_licenses
git status --short packages/db/migrations
```

Ожидается: новые `packages/db/migrations/0186_standalone_licenses.sql`, `meta/0186_snapshot.json`, правка `meta/_journal.json` (запись `idx: 186`). Прочитать SQL целиком: в нём **только** `CREATE TABLE "standalone_sites"`, `CREATE TABLE "standalone_license_issuances"`, их ограничения `UNIQUE`/`CHECK`, внешние ключи (`organization`, `platform_users`, составные `…_tenant_site_fk`, `…_site_replaces_fk`) и индекс `standalone_license_issuances_tenant_site_idx`. Любая иная строка (правка существующей таблицы из-за дрейфа снимка) — остановиться, не коммитить, выяснить причину и записать в отчёт. Применённые миграции `0000`–`0185` не меняются (`git diff --stat packages/db/migrations` показывает только новые файлы и журнал).

- [ ] **Step 5: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/standalone-licenses-schema.test.ts test/standalone-licenses-migration.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db test
```

Ожидается: PASS (миграционный — при `DATABASE_URL`; иначе SKIP, назвать в отчёте); весь пакет зелёный.

- [ ] **Step 6: Гейты, сборка, применение к тестовой базе**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:migrate
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/db/src/schema/standalone-licenses.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/test/standalone-licenses-schema.test.ts packages/db/test/standalone-licenses-migration.test.ts
git diff --check
```

Ожидается: зелёное; `db:migrate` применил `0186` к базе `DATABASE_URL` (нужно для e2e задач 7–9).

- [ ] **Step 7: Коммит**

<!-- prettier-ignore -->
```bash
git add packages/db/src/schema/standalone-licenses.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/migrations/0186_standalone_licenses.sql packages/db/migrations/meta/0186_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/standalone-licenses-schema.test.ts packages/db/test/standalone-licenses-migration.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(db): standalone sites and offline license issuance journal (plan ЛЦ-0)

standalone_sites (one host id per site across tenants, host id history,
last issued sequence) and standalone_license_issuances (append-only, unique
per site and sequence, composite tenant/site key, idempotent request id).
Migration 0186 generated by drizzle-kit and reviewed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 3: API — обобщённый подписант компактного JWS, вынесенный из ключей грантов

**Files:**

- Create: `apps/api/src/signing/compact-jws.ts`
- Modify: `apps/api/src/modules/device-grants/grant-keyset.ts`
- Test: `apps/api/test/compact-jws-signing.test.ts`; без изменений и зелёными — `apps/api/test/device-grants-keyset.test.ts`, `apps/api/test/device-grants-issuer.test.ts`, `apps/api/test/device-grant-client-readiness.test.ts`

**Interfaces:**

- Consumes: `node:crypto` (`createPrivateKey`, `createPublicKey`, `sign`).
- Produces: `CompactJwsPublicKey`, `CompactJwsKeyset`, `CompactJwsSigningKey { kid, privateKey }`, `loadCompactJwsSigningKey({ origin, kid, pem, keyset })` (бросает голый `Error` без материала ключа), `signCompactJws(config, typ, payload): string`; `configureGrantSigning` и `signOfflineGrant` — прежние сигнатуры и прежние байты.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/compact-jws-signing.test.ts`:

<!-- prettier-ignore -->
```ts
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGrant, type DeviceGrant } from "@markiro/domain";
import { loadCompactJwsSigningKey, signCompactJws } from "../src/signing/compact-jws";
import { configureGrantSigning, signOfflineGrant } from "../src/modules/device-grants/grant-keyset";

const origin = "https://api.example.invalid";

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    entry: { kid, jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" } },
  };
}

function decodeSegment(segment: string | undefined): unknown {
  return JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8"));
}

describe("generalized compact JWS signer (plan ЛЦ-0)", () => {
  it("signs exact header.payload bytes with ES256 and a 64-byte P1363 signature for any typ", () => {
    const pair = keyPair("lic-1");
    const key = loadCompactJwsSigningKey({
      origin,
      kid: "lic-1",
      pem: pair.pem,
      keyset: { origin, keys: [pair.entry], retiredKids: [] },
    });
    const compact = signCompactJws(key, "markiro-standalone-license+jws", { a: 1, b: "в" });
    const [header, payload, signature] = compact.split(".");
    expect(decodeSegment(header)).toEqual({
      alg: "ES256",
      typ: "markiro-standalone-license+jws",
      kid: "lic-1",
    });
    expect(decodeSegment(payload)).toEqual({ a: 1, b: "в" });
    const bytes = Buffer.from(signature ?? "", "base64url");
    expect(bytes).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: createPublicKey({ key: { ...pair.entry.jwk }, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        bytes,
      ),
    ).toBe(true);
  });

  it("refuses a retired active kid, a foreign origin, a mismatched private key and an unknown kid", () => {
    const a = keyPair("a");
    const b = keyPair("b");
    const keyset = { origin, keys: [a.entry, b.entry], retiredKids: ["b"] };
    expect(() => loadCompactJwsSigningKey({ origin, kid: "b", pem: b.pem, keyset })).toThrow();
    expect(() =>
      loadCompactJwsSigningKey({ origin: "https://other.invalid", kid: "a", pem: a.pem, keyset }),
    ).toThrow();
    expect(() => loadCompactJwsSigningKey({ origin, kid: "a", pem: b.pem, keyset })).toThrow();
    expect(() =>
      loadCompactJwsSigningKey({ origin, kid: "c", pem: a.pem, keyset: { ...keyset, retiredKids: [] } }),
    ).toThrow();
  });

  it("keeps offline grants byte-compatible: same header order and a grant the domain verifies", async () => {
    const pair = keyPair("test-active");
    const signer = configureGrantSigning({
      OFFLINE_GRANT_ORIGIN: origin,
      OFFLINE_GRANT_KID: "test-active",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: pair.pem,
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin,
        revision: "test-v1",
        keys: [pair.entry],
        retiredKids: [],
      }),
    });
    if (!signer) throw new Error("fixture");
    const grant: DeviceGrant = {
      version: 1,
      issuer: origin,
      grantId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "tenant-a",
      deviceId: "550e8400-e29b-41d4-a716-446655440001",
      kind: "station",
      credentialEpoch: 1,
      entitlementRevision: "1",
      policyRevision: "policy",
      issuedAt: 1000,
      notBefore: 1000,
      kindOfGrant: "device",
      startNotAfter: 2000,
      capabilities: ["shift.start.v1"],
    };
    const compact = signOfflineGrant(signer, grant);
    expect(Buffer.from(compact.split(".")[0] ?? "", "base64url").toString("utf8")).toBe(
      '{"alg":"ES256","typ":"markiro-offline-grant+jws","kid":"test-active"}',
    );
    await expect(
      verifyGrant(compact, [{ kid: "test-active", origin, jwk: { ...pair.entry.jwk } }], origin),
    ).resolves.toEqual({ ok: true, grant, compact });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/compact-jws-signing.test.ts
```

Ожидается: FAIL — модуль `../src/signing/compact-jws` не найден.

- [ ] **Step 3: Реализация**

Создать `apps/api/src/signing/compact-jws.ts`:

<!-- prettier-ignore -->
```ts
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

export interface CompactJwsPublicKey {
  kid: string;
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}
export interface CompactJwsKeyset {
  origin: string;
  keys: readonly CompactJwsPublicKey[];
  retiredKids: readonly string[];
}
export interface CompactJwsSigningKey {
  kid: string;
  privateKey: KeyObject;
}

/**
 * Checks one active P-256 key against its distributed public keyset (offline
 * grants, standalone licenses). Throws a bare Error without key material; every
 * caller replaces it with its own one-line message.
 */
export function loadCompactJwsSigningKey(input: {
  origin: string;
  kid: string;
  pem: string;
  keyset: CompactJwsKeyset;
}): CompactJwsSigningKey {
  const { origin, kid, pem, keyset } = input;
  if (keyset.origin !== origin || keyset.retiredKids.includes(kid)) throw new Error();
  for (const entry of keyset.keys) {
    const key = createPublicKey({
      key: { kty: entry.jwk.kty, crv: entry.jwk.crv, x: entry.jwk.x, y: entry.jwk.y },
      format: "jwk",
    });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error();
    const actual = key.export({ format: "jwk" });
    if (actual.x !== entry.jwk.x || actual.y !== entry.jwk.y) throw new Error();
  }
  const privateKey = createPrivateKey(pem);
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error();
  const actual = createPublicKey(privateKey).export({ format: "jwk" });
  const entry = keyset.keys.find((key) => key.kid === kid);
  if (!entry || entry.jwk.x !== actual.x || entry.jwk.y !== actual.y) throw new Error();
  return { kid, privateKey };
}

/**
 * ES256 over the exact `header.payload` bytes (no JSON canonicalization), header
 * `{alg, typ, kid}` in this order — the offline grants' bytes — and a 64-byte
 * IEEE P1363 signature.
 */
export function signCompactJws(config: CompactJwsSigningKey, typ: string, payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ, kid: config.kid })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const bytes = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(bytes), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.length !== 64) throw new Error("Invalid compact JWS signature length");
  return `${bytes}.${signature.toString("base64url")}`;
}
```

Правка `apps/api/src/modules/device-grants/grant-keyset.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { grantKeysetSchema, type GrantKeyset } from "@markiro/platform-contracts";
import { offlineGrantSchema, type OfflineGrant } from "@markiro/domain";
```

заменить на:

<!-- prettier-ignore -->
```ts
import type { KeyObject } from "node:crypto";
import { grantKeysetSchema, type GrantKeyset } from "@markiro/platform-contracts";
import { offlineGrantSchema, type OfflineGrant } from "@markiro/domain";
import { loadCompactJwsSigningKey, signCompactJws } from "../../signing/compact-jws";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    if (!origin || !kid || !pem || !json) throw new Error();
    const keyset = grantKeysetSchema.parse(JSON.parse(json));
    if (keyset.origin !== origin || keyset.retiredKids.includes(kid)) throw new Error();
    for (const entry of keyset.keys) {
      const key = createPublicKey({
        key: { kty: entry.jwk.kty, crv: entry.jwk.crv, x: entry.jwk.x, y: entry.jwk.y },
        format: "jwk",
      });
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
        throw new Error();
      const actual = key.export({ format: "jwk" });
      if (actual.x !== entry.jwk.x || actual.y !== entry.jwk.y) throw new Error();
    }
    const privateKey = createPrivateKey(pem);
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error();
    const actual = createPublicKey(privateKey).export({ format: "jwk" });
    const entry = keyset.keys.find((key) => key.kid === kid);
    if (!entry || entry.jwk.x !== actual.x || entry.jwk.y !== actual.y) throw new Error();
    return { origin, kid, privateKey, keyset };
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (!origin || !kid || !pem || !json) throw new Error();
    const keyset = grantKeysetSchema.parse(JSON.parse(json));
    const { privateKey } = loadCompactJwsSigningKey({ origin, kid, pem, keyset });
    return { origin, kid, privateKey, keyset };
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  if (validated.issuer !== config.origin) throw new Error("Offline grant origin mismatch");
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "markiro-offline-grant+jws", kid: config.kid }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(validated)).toString("base64url");
  const bytes = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(bytes), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.length !== 64) throw new Error("Invalid offline grant signature length");
  return `${bytes}.${signature.toString("base64url")}`;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (validated.issuer !== config.origin) throw new Error("Offline grant origin mismatch");
  return signCompactJws(config, "markiro-offline-grant+jws", validated);
}
```

- [ ] **Step 4: Убедиться, что тесты проходят (и гранты не изменились)**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/compact-jws-signing.test.ts test/device-grants-keyset.test.ts test/device-grant-client-readiness.test.ts test/device-grants-issuer.test.ts
```

Ожидается: PASS. `device-grants-issuer.test.ts` — DB-тест: без `DATABASE_URL` он SKIP (назвать); его шпионы `vi.spyOn(grantSigning, "signOfflineGrant")` работают, потому что `signOfflineGrant` по-прежнему экспортируется из `grant-keyset.ts`. Ни один файл тестов грантов не правился (`git diff --stat apps/api/test` показывает только новый файл).

- [ ] **Step 5: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/signing/compact-jws.ts apps/api/src/modules/device-grants/grant-keyset.ts apps/api/test/compact-jws-signing.test.ts
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/signing/compact-jws.ts apps/api/src/modules/device-grants/grant-keyset.ts apps/api/test/compact-jws-signing.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
refactor(api): extract the compact JWS signer from offline grant keys (plan ЛЦ-0)

loadCompactJwsSigningKey and signCompactJws(config, typ, payload) serve any
ES256 document; offline grants sign the same header bytes as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 4: API — ключ лицензий в окружении, проверка при старте, необязательная группа деплоя

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/standalone-license-keyset.ts`
- Modify: `apps/api/src/env.ts`, `.env.example`, `.env.production.example`, `deploy/yandex/runtime-env.mjs`
- Test: `apps/api/test/standalone-license-keyset.test.ts`, `apps/api/test/env.test.ts`, `deploy/yandex/test/runtime-env.test.mjs`; `apps/api/test/env-example.test.ts` и `deploy/production/test/offline-grant-readiness-contract.test.mjs` — без правок, зелёные

**Interfaces:**

- Consumes: `standaloneLicenseSigningKeysetSchema` (задача 1), `loadCompactJwsSigningKey` (задача 3), `configureGrantSigning`.
- Produces: `StandaloneLicenseSigningEnvironment`, `StandaloneLicenseSigningConfiguration { issuer, kid, privateKey, keyset }`, `STANDALONE_LICENSE_SIGNING` (символ DI), `STANDALONE_LICENSE_SIGNING_ERROR`, `configureStandaloneLicenseSigning(env)` (`null` при всех четырёх пустых), `standaloneLicenseReusesGrantKey(env)`; поля `Env.STANDALONE_LICENSE_*`; группа `STANDALONE_LICENSE_*` в `OPTIONAL_ENVIRONMENT_KEY_GROUPS`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/api/test/standalone-license-keyset.test.ts`:

<!-- prettier-ignore -->
```ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configureStandaloneLicenseSigning,
  standaloneLicenseReusesGrantKey,
  STANDALONE_LICENSE_SIGNING_ERROR,
} from "../src/modules/standalone-licenses/standalone-license-keyset";

const issuer = "https://api.example.invalid";

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
}

function licenseEnv(key = pair(), kid = "lic-1") {
  return {
    STANDALONE_LICENSE_ISSUER: issuer,
    STANDALONE_LICENSE_KID: kid,
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: key.pem,
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin: issuer,
      revision: "lic-v1",
      keys: [{ kid, jwk: key.jwk }],
      retiredKids: [],
    }),
  };
}

describe("standalone license signing configuration (plan ЛЦ-0)", () => {
  it("keeps the API up with issuance off when all four values are absent or blank", () => {
    expect(configureStandaloneLicenseSigning({})).toBeNull();
    expect(
      configureStandaloneLicenseSigning({
        STANDALONE_LICENSE_ISSUER: "",
        STANDALONE_LICENSE_KID: "",
        STANDALONE_LICENSE_PRIVATE_KEY_PEM: "",
        STANDALONE_LICENSE_KEYSET_JSON: "",
      }),
    ).toBeNull();
  });

  it("refuses a partial or mismatched set with one line and no key material", () => {
    const env = licenseEnv();
    for (const broken of [
      { STANDALONE_LICENSE_KID: "lic-1" },
      { ...env, STANDALONE_LICENSE_ISSUER: "https://other.invalid" },
      { ...env, STANDALONE_LICENSE_PRIVATE_KEY_PEM: pair().pem },
      { ...env, STANDALONE_LICENSE_KID: "lic-2" },
      {
        ...env,
        STANDALONE_LICENSE_KEYSET_JSON: env.STANDALONE_LICENSE_KEYSET_JSON.replace(
          "standalone-license-v1",
          "offline-grants-v1",
        ),
      },
    ]) {
      let message = "";
      try {
        configureStandaloneLicenseSigning(broken);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toBe(STANDALONE_LICENSE_SIGNING_ERROR);
      expect(message).not.toMatch(/PRIVATE KEY|BEGIN/u);
    }
  });

  it("accepts a one-line PEM with escaped newlines from the runtime environment file", () => {
    const env = licenseEnv();
    const oneLine = env.STANDALONE_LICENSE_PRIVATE_KEY_PEM.trimEnd().replaceAll("\n", "\\n");
    expect(oneLine).not.toContain("\n");
    expect(
      configureStandaloneLicenseSigning({ ...env, STANDALONE_LICENSE_PRIVATE_KEY_PEM: oneLine })?.kid,
    ).toBe("lic-1");
  });

  it("detects a license keyset that reuses an offline grant key", () => {
    const shared = pair();
    const grantEnv = {
      OFFLINE_GRANT_ORIGIN: issuer,
      OFFLINE_GRANT_KID: "grant-1",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: shared.pem,
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin: issuer,
        revision: "g-v1",
        keys: [{ kid: "grant-1", jwk: shared.jwk }],
        retiredKids: [],
      }),
    };
    expect(standaloneLicenseReusesGrantKey({ ...grantEnv, ...licenseEnv(shared) })).toBe(true);
    expect(standaloneLicenseReusesGrantKey({ ...grantEnv, ...licenseEnv() })).toBe(false);
    expect(standaloneLicenseReusesGrantKey(licenseEnv())).toBe(false);
  });
});
```

Правка `apps/api/test/env.test.ts` — дописать в конец файла:

<!-- prettier-ignore -->
```ts
describe("standalone license signing environment (plan ЛЦ-0)", () => {
  function key() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    return {
      pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    };
  }
  const origin = "https://api.example.invalid";
  const licenseVars = (k: ReturnType<typeof key>) => ({
    STANDALONE_LICENSE_ISSUER: origin,
    STANDALONE_LICENSE_KID: "lic-1",
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: k.pem,
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin,
      revision: "lic-v1",
      keys: [{ kid: "lic-1", jwk: k.jwk }],
      retiredKids: [],
    }),
  });

  it("boots without the license key and with a complete one", () => {
    expect(loadEnv(requiredEnv).STANDALONE_LICENSE_KID).toBeUndefined();
    expect(loadEnv({ ...requiredEnv, ...licenseVars(key()) }).STANDALONE_LICENSE_KID).toBe("lic-1");
  });

  it("refuses a partial license key and a license key shared with offline grants", () => {
    expect(() => loadEnv({ ...requiredEnv, STANDALONE_LICENSE_KID: "lic-1" })).toThrow(
      /Invalid standalone license signing configuration/u,
    );
    const shared = key();
    expect(() =>
      loadEnv({
        ...requiredEnv,
        ...licenseVars(shared),
        OFFLINE_GRANT_ORIGIN: origin,
        OFFLINE_GRANT_KID: "grant-1",
        OFFLINE_GRANT_PRIVATE_KEY_PEM: shared.pem,
        OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
          protocol: "offline-grants-v1",
          origin,
          revision: "g-v1",
          keys: [{ kid: "grant-1", jwk: shared.jwk }],
          retiredKids: [],
        }),
      }),
    ).toThrow(/must not reuse an offline grant key/u);
  });
});
```

и в начале файла:

Фрагмент:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";
```

Правка `deploy/yandex/test/runtime-env.test.mjs`:

Фрагмент 1:

<!-- prettier-ignore -->
```js
const OPTIONAL_OFFLINE_GRANT_INVENTORY = `${INVENTORY}OFFLINE_GRANT_ORIGIN=\nOFFLINE_GRANT_KID=\nOFFLINE_GRANT_PRIVATE_KEY_PEM=\nOFFLINE_GRANT_KEYSET_JSON=\n`;
```

заменить на:

<!-- prettier-ignore -->
```js
const OPTIONAL_OFFLINE_GRANT_INVENTORY = `${INVENTORY}OFFLINE_GRANT_ORIGIN=\nOFFLINE_GRANT_KID=\nOFFLINE_GRANT_PRIVATE_KEY_PEM=\nOFFLINE_GRANT_KEYSET_JSON=\n`;
const OPTIONAL_STANDALONE_LICENSE_INVENTORY = `${INVENTORY}STANDALONE_LICENSE_ISSUER=\nSTANDALONE_LICENSE_KID=\nSTANDALONE_LICENSE_PRIVATE_KEY_PEM=\nSTANDALONE_LICENSE_KEYSET_JSON=\n`;
```

Фрагмент 2 (перед тестом «runtime inventory rejects missing, extra…»):

<!-- prettier-ignore -->
```js
test("runtime inventory rejects missing, extra, duplicate, malformed, and valueless entries uniformly", () => {
```

заменить на:

<!-- prettier-ignore -->
```js
test("allows the disabled standalone license group to be entirely absent (plan ЛЦ-0)", () => {
  const keys = environmentKeysFromExample(OPTIONAL_STANDALONE_LICENSE_INVENTORY);
  const entries = Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));

  assert.deepEqual(runtimeInventoryKeyNames(keys, entries), [
    "DATABASE_URL",
    "S3_ENDPOINT",
    "SMTP_PASSWORD",
  ]);
  assert.doesNotMatch(renderRuntimeEnvironment(keys, entries), /STANDALONE_LICENSE_/u);
});

test("rejects a partially configured standalone license group (plan ЛЦ-0)", () => {
  const keys = environmentKeysFromExample(OPTIONAL_STANDALONE_LICENSE_INVENTORY);
  const entries = [
    ...Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    { key: "STANDALONE_LICENSE_KID", textValue: "lic-1" },
  ];

  assert.throws(
    () => runtimeInventoryKeyNames(keys, entries),
    (error) => error.message === INVENTORY_FAILURE,
  );
});

test("runtime inventory rejects missing, extra, duplicate, malformed, and valueless entries uniformly", () => {
```

Фрагмент 3 (тест «uses every and only the production environment example keys»):

<!-- prettier-ignore -->
```js
    "OFFLINE_GRANT_ORIGIN",
    "OFFLINE_GRANT_KID",
    "OFFLINE_GRANT_PRIVATE_KEY_PEM",
    "OFFLINE_GRANT_KEYSET_JSON",
  ]);
  assert.equal(inventory.length, 52);
```

заменить на:

<!-- prettier-ignore -->
```js
    "OFFLINE_GRANT_ORIGIN",
    "OFFLINE_GRANT_KID",
    "OFFLINE_GRANT_PRIVATE_KEY_PEM",
    "OFFLINE_GRANT_KEYSET_JSON",
    "STANDALONE_LICENSE_ISSUER",
    "STANDALONE_LICENSE_KID",
    "STANDALONE_LICENSE_PRIVATE_KEY_PEM",
    "STANDALONE_LICENSE_KEYSET_JSON",
  ]);
  assert.equal(inventory.length, 56);
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-keyset.test.ts test/env.test.ts
node --test deploy/yandex/test/runtime-env.test.mjs
```

Ожидается: Vitest — FAIL: `standalone-license-keyset.test.ts` — модуль не найден; `env.test.ts` — «refuses a partial license key…» (схема не знает полей и не проверяет их). `node --test` — FAIL «allows the disabled standalone license group to be entirely absent» (без объявленной группы все четыре ключа обязательны, `missing` не пуст) и «uses every and only…» (52, не 56). «rejects a partially configured standalone license group» проходит и до правки (недостающие ключи и так отказ) — он закрепляет поведение после объявления группы.

- [ ] **Step 3: Реализация**

Создать `apps/api/src/modules/standalone-licenses/standalone-license-keyset.ts`:

<!-- prettier-ignore -->
```ts
import type { KeyObject } from "node:crypto";
import {
  standaloneLicenseSigningKeysetSchema,
  type StandaloneLicenseSigningKeyset,
} from "@markiro/platform-contracts";
import { loadCompactJwsSigningKey } from "../../signing/compact-jws";
import { configureGrantSigning, type GrantSigningEnvironment } from "../device-grants/grant-keyset";

export interface StandaloneLicenseSigningEnvironment {
  STANDALONE_LICENSE_ISSUER?: string | undefined;
  STANDALONE_LICENSE_KID?: string | undefined;
  STANDALONE_LICENSE_PRIVATE_KEY_PEM?: string | undefined;
  STANDALONE_LICENSE_KEYSET_JSON?: string | undefined;
}
export interface StandaloneLicenseSigningConfiguration {
  issuer: string;
  kid: string;
  privateKey: KeyObject;
  keyset: StandaloneLicenseSigningKeyset;
}
export const STANDALONE_LICENSE_SIGNING = Symbol("STANDALONE_LICENSE_SIGNING");
export const STANDALONE_LICENSE_SIGNING_ERROR = "Invalid standalone license signing configuration";

/**
 * The license key is its own (spec 2026-10-13 §5.1): all four values absent keeps
 * the API up with issuance refused; a partial or mismatched set fails startup.
 * One-line stores (the Yandex runtime env file) may carry the PEM with `\n`
 * escapes. Errors never include key material.
 */
export function configureStandaloneLicenseSigning(
  env: StandaloneLicenseSigningEnvironment,
): StandaloneLicenseSigningConfiguration | null {
  const values = [
    env.STANDALONE_LICENSE_ISSUER,
    env.STANDALONE_LICENSE_KID,
    env.STANDALONE_LICENSE_PRIVATE_KEY_PEM,
    env.STANDALONE_LICENSE_KEYSET_JSON,
  ];
  if (values.every((value) => value === undefined || value === "")) return null;
  try {
    const {
      STANDALONE_LICENSE_ISSUER: issuer,
      STANDALONE_LICENSE_KID: kid,
      STANDALONE_LICENSE_PRIVATE_KEY_PEM: rawPem,
      STANDALONE_LICENSE_KEYSET_JSON: json,
    } = env;
    if (!issuer || !kid || !rawPem || !json) throw new Error();
    const pem = rawPem.includes("\\n") ? rawPem.replaceAll("\\n", "\n") : rawPem;
    const keyset = standaloneLicenseSigningKeysetSchema.parse(JSON.parse(json));
    const { privateKey } = loadCompactJwsSigningKey({ origin: issuer, kid, pem, keyset });
    return { issuer, kid, privateKey, keyset };
  } catch {
    throw new Error(STANDALONE_LICENSE_SIGNING_ERROR);
  }
}

/** True only when both are configured and a license public key is also a grant public key. */
export function standaloneLicenseReusesGrantKey(
  env: StandaloneLicenseSigningEnvironment & GrantSigningEnvironment,
): boolean {
  let grant: ReturnType<typeof configureGrantSigning> = null;
  let license: StandaloneLicenseSigningConfiguration | null = null;
  try {
    grant = configureGrantSigning(env);
    license = configureStandaloneLicenseSigning(env);
  } catch {
    return false;
  }
  if (!grant || !license) return false;
  const grantKeys = grant.keyset.keys;
  return license.keyset.keys.some((key) =>
    grantKeys.some((other) => other.jwk.x === key.jwk.x && other.jwk.y === key.jwk.y),
  );
}
```

Правка `apps/api/src/env.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { configureGrantSigning } from "./modules/device-grants/grant-keyset";
import { z } from "zod";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { configureGrantSigning } from "./modules/device-grants/grant-keyset";
import {
  configureStandaloneLicenseSigning,
  standaloneLicenseReusesGrantKey,
  STANDALONE_LICENSE_SIGNING_ERROR,
} from "./modules/standalone-licenses/standalone-license-keyset";
import { z } from "zod";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    OFFLINE_GRANT_KEYSET_JSON: z.string().optional(),
    PLATFORM_AUTH_SECRET: z.string().min(32),
```

заменить на:

<!-- prettier-ignore -->
```ts
    OFFLINE_GRANT_KEYSET_JSON: z.string().optional(),
    STANDALONE_LICENSE_ISSUER: z.string().optional(),
    STANDALONE_LICENSE_KID: z.string().optional(),
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: z.string().optional(),
    STANDALONE_LICENSE_KEYSET_JSON: z.string().optional(),
    PLATFORM_AUTH_SECRET: z.string().min(32),
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    try {
      configureGrantSigning(env);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["OFFLINE_GRANT_KEYSET_JSON"],
        message: "Invalid offline grant signing configuration",
      });
    }
```

заменить на:

<!-- prettier-ignore -->
```ts
    try {
      configureGrantSigning(env);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["OFFLINE_GRANT_KEYSET_JSON"],
        message: "Invalid offline grant signing configuration",
      });
    }
    try {
      configureStandaloneLicenseSigning(env);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["STANDALONE_LICENSE_KEYSET_JSON"],
        message: STANDALONE_LICENSE_SIGNING_ERROR,
      });
    }
    if (standaloneLicenseReusesGrantKey(env)) {
      ctx.addIssue({
        code: "custom",
        path: ["STANDALONE_LICENSE_KEYSET_JSON"],
        message: "must not reuse an offline grant key",
      });
    }
```

Правка `.env.example` и `.env.production.example` (одинаково). Фрагмент (конец файла):

<!-- prettier-ignore -->
```
# JSON {protocol,origin,revision,keys:[{kid,jwk}],retiredKids:[]} with public keys only.
OFFLINE_GRANT_KEYSET_JSON=
```

заменить на:

<!-- prettier-ignore -->
```
# JSON {protocol,origin,revision,keys:[{kid,jwk}],retiredKids:[]} with public keys only.
OFFLINE_GRANT_KEYSET_JSON=

# Optional standalone («Markiro Автоном») offline license signing — its OWN P-256 key,
# never an offline grant key. Leave ALL unset until the owner's rollout: issuance then
# answers 409 and the API keeps running. Configure all four together.
# ISSUER is this API's canonical HTTP(S) origin; the standalone build trusts it with the
# public keys (apps/standalone/proto/fixtures/trust-keys.json). Ship a build with a new
# public key before switching KID. PRIVATE_KEY_PEM is server-only PKCS8; one-line `\n`
# escapes are accepted.
STANDALONE_LICENSE_ISSUER=
STANDALONE_LICENSE_KID=
STANDALONE_LICENSE_PRIVATE_KEY_PEM=
# JSON {protocol:"standalone-license-v1",origin,revision,keys:[{kid,jwk}],retiredKids:[]}, public keys only.
STANDALONE_LICENSE_KEYSET_JSON=
```

Правка `deploy/yandex/runtime-env.mjs`:

Фрагмент:

<!-- prettier-ignore -->
```js
const OPTIONAL_ENVIRONMENT_KEY_GROUPS = [
  [
    "OFFLINE_GRANT_ORIGIN",
    "OFFLINE_GRANT_KID",
    "OFFLINE_GRANT_PRIVATE_KEY_PEM",
    "OFFLINE_GRANT_KEYSET_JSON",
  ],
];
```

заменить на:

<!-- prettier-ignore -->
```js
const OPTIONAL_ENVIRONMENT_KEY_GROUPS = [
  [
    "OFFLINE_GRANT_ORIGIN",
    "OFFLINE_GRANT_KID",
    "OFFLINE_GRANT_PRIVATE_KEY_PEM",
    "OFFLINE_GRANT_KEYSET_JSON",
  ],
  [
    "STANDALONE_LICENSE_ISSUER",
    "STANDALONE_LICENSE_KID",
    "STANDALONE_LICENSE_PRIVATE_KEY_PEM",
    "STANDALONE_LICENSE_KEYSET_JSON",
  ],
];
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-keyset.test.ts test/env.test.ts test/env-example.test.ts test/device-grants-keyset.test.ts
node --test deploy/yandex/test/runtime-env.test.mjs
pnpm test:production-bundle:contract
```

Ожидается: PASS; `env-example.test.ts` — `.env.example` с пустыми ключами лицензий загружается; контракт `offline-grant-readiness-contract.test.mjs` («API startup validates offline grant signing as one configuration») по-прежнему находит `configureGrantSigning(env)` внутри `superRefine`.

- [ ] **Step 5: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/standalone-license-keyset.ts apps/api/src/env.ts apps/api/test/standalone-license-keyset.test.ts apps/api/test/env.test.ts deploy/yandex/runtime-env.mjs deploy/yandex/test/runtime-env.test.mjs
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/standalone-license-keyset.ts apps/api/src/env.ts apps/api/test/standalone-license-keyset.test.ts apps/api/test/env.test.ts .env.example .env.production.example deploy/yandex/runtime-env.mjs deploy/yandex/test/runtime-env.test.mjs
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): standalone license signing key in the API environment (plan ЛЦ-0)

STANDALONE_LICENSE_ISSUER/KID/PRIVATE_KEY_PEM/KEYSET_JSON are validated at
startup like offline grants, must not reuse a grant key, accept a one-line
PEM, and form one optional Lockbox group in the Yandex runtime inventory.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 5: API — права файла из снимка и срок действия (чистые функции)

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/standalone-license-rights.ts`
- Test: `apps/api/test/standalone-license-rights.test.ts`

**Interfaces:**

- Consumes: `EntitlementSnapshotV1`, `StandaloneLicenseRights` (`@markiro/platform-contracts`); `STANDALONE_FEATURE_KEYS`, `STANDALONE_QUOTA_KEYS` (`@markiro/domain`).
- Produces: `exportStandaloneRights(snapshot): { rights: StandaloneLicenseRights; unmapped: StandaloneFeatureKey[] }`; `rightsReduce(before, after): boolean`; `MAX_LICENSE_TERM_MS`, `MAX_VALIDITY_STEPS = 64`; `type LicenseValidity = { validUntil: Date; reason: "subscription_end" | "entitlement_reduction" | "one_year_cap"; boundaryAt: Date | null }`; `licenseValidity({ at, first, snapshotAt, maxSteps? }): Promise<LicenseValidity>`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/standalone-license-rights.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";
import type {
  EntitlementCandidateFeatures,
  EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import {
  exportStandaloneRights,
  licenseValidity,
  MAX_LICENSE_TERM_MS,
  rightsReduce,
} from "../src/modules/standalone-licenses/standalone-license-rights";

const DAY = 86_400_000;
const AT = new Date("2026-10-20T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
type Limits = { lines: number | null; stations: number | null; kiosks: number | null; cabinetUsers: number | null };

function snapshot(input: {
  asOf?: Date;
  nextChangeAt?: Date | null;
  endsAt?: Date | null;
  limits?: Partial<Limits>;
  features?: Partial<EntitlementCandidateFeatures>;
}): EntitlementSnapshotV1 {
  const asOf = (input.asOf ?? AT).toISOString();
  const limits: Limits = { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5, ...input.limits };
  const quota = (limit: number | null) => ({ limit, used: 0, remaining: limit });
  const quotas = {
    lines: quota(limits.lines),
    stations: quota(limits.stations),
    kiosks: quota(limits.kiosks),
    cabinetUsers: quota(limits.cabinetUsers),
  };
  return {
    version: 1,
    tenantId: "tenant-a",
    asOf,
    countedAt: asOf,
    revision: "7",
    usageRevision: "1",
    nextChangeAt: input.nextChangeAt ? input.nextChangeAt.toISOString() : null,
    current: {
      access: "managed",
      writeAllowed: true,
      subscription: {
        id: "11111111-1111-4111-8111-111111111111",
        planVersionId: "22222222-2222-4222-8222-222222222222",
        status: "active",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: input.endsAt === undefined ? iso(AT.getTime() + 90 * DAY) : input.endsAt?.toISOString() ?? null,
      },
      quotas,
      features: { labelEditor: true, publicApi: false, pallets: true },
    },
    candidate: {
      quotas,
      features: {
        labelEditor: true,
        publicApi: false,
        pallets: true,
        chzIntegration: null,
        inventory: true,
        commerceMl: false,
        handheld: true,
        ...input.features,
      },
    },
    sources: [],
    readiness: { mode: "shadow", reasons: [] },
    historical: { available: false },
    connectivity: { observedAt: asOf, chz: "unknown", nationalCatalog: "unknown" },
  };
}

describe("exportStandaloneRights", () => {
  it("copies candidate limits with null as unlimited and exports a null feature as false, naming it", () => {
    expect(exportStandaloneRights(snapshot({ limits: { lines: null } }))).toEqual({
      rights: {
        quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
        features: {
          labelEditor: true,
          publicApi: false,
          pallets: true,
          chzIntegration: false,
          inventory: true,
          commerceMl: false,
          handheld: true,
        },
      },
      unmapped: ["chzIntegration"],
    });
  });
});

describe("rightsReduce", () => {
  const base = exportStandaloneRights(snapshot({})).rights;

  it("counts a lower limit, a newly limited quota and a switched-off feature as reductions", () => {
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, stations: 2 } })).toBe(true);
    expect(rightsReduce({ ...base, quotas: { ...base.quotas, lines: null } }, base)).toBe(true);
    expect(rightsReduce(base, { ...base, features: { ...base.features, pallets: false } })).toBe(
      true,
    );
  });

  it("does not count a higher limit, a limit becoming unlimited, a feature switched on or no change", () => {
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, stations: 4 } })).toBe(false);
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, lines: null } })).toBe(false);
    expect(rightsReduce(base, { ...base, features: { ...base.features, publicApi: true } })).toBe(
      false,
    );
    expect(rightsReduce(base, base)).toBe(false);
  });
});

describe("licenseValidity (spec §6.2, plan Д5)", () => {
  it("ends at the subscription end when nothing shrinks before it", async () => {
    const endsAt = new Date(AT.getTime() + 90 * DAY);
    const snapshotAt = vi.fn();
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt }), snapshotAt }),
    ).resolves.toEqual({ validUntil: endsAt, reason: "subscription_end", boundaryAt: endsAt });
    expect(snapshotAt).not.toHaveBeenCalled();
  });

  it("caps an open-ended or multi-year subscription at one year without a time-bound boundary", async () => {
    for (const endsAt of [null, new Date(AT.getTime() + 800 * DAY)]) {
      await expect(
        licenseValidity({ at: AT, first: snapshot({ endsAt }), snapshotAt: vi.fn() }),
      ).resolves.toEqual({
        validUntil: new Date(AT.getTime() + MAX_LICENSE_TERM_MS),
        reason: "one_year_cap",
        boundaryAt: null,
      });
    }
  });

  it("skips increases and cuts at the first reduction", async () => {
    const growth = new Date(AT.getTime() + 10 * DAY);
    const shrink = new Date(AT.getTime() + 30 * DAY);
    const endsAt = new Date(AT.getTime() + 120 * DAY);
    const at = new Map([
      [growth.getTime(), snapshot({ asOf: growth, endsAt, nextChangeAt: shrink, limits: { stations: 5 } })],
      [shrink.getTime(), snapshot({ asOf: shrink, endsAt, nextChangeAt: endsAt, limits: { stations: 4 } })],
    ]);
    const snapshotAt = vi.fn(async (when: Date) => {
      const found = at.get(when.getTime());
      if (!found) throw new Error(`unexpected ${when.toISOString()}`);
      return found;
    });
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt, nextChangeAt: growth }), snapshotAt }),
    ).resolves.toEqual({ validUntil: shrink, reason: "entitlement_reduction", boundaryAt: shrink });
    expect(snapshotAt.mock.calls.map(([when]) => when.toISOString())).toEqual([
      growth.toISOString(),
      shrink.toISOString(),
    ]);
  });

  it("never evaluates a boundary at or after the subscription end", async () => {
    const endsAt = new Date(AT.getTime() + 20 * DAY);
    const snapshotAt = vi.fn();
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt, nextChangeAt: endsAt }), snapshotAt }),
    ).resolves.toEqual({ validUntil: endsAt, reason: "subscription_end", boundaryAt: endsAt });
    expect(snapshotAt).not.toHaveBeenCalled();
  });

  it("cuts conservatively at the boundary where it runs out of steps", async () => {
    const step = (n: number) => new Date(AT.getTime() + n * DAY);
    const snapshotAt = vi.fn(async (when: Date) =>
      snapshot({ asOf: when, nextChangeAt: new Date(when.getTime() + DAY) }),
    );
    await expect(
      licenseValidity({
        at: AT,
        first: snapshot({ nextChangeAt: step(1), endsAt: step(80) }),
        snapshotAt,
        maxSteps: 3,
      }),
    ).resolves.toEqual({ validUntil: step(4), reason: "entitlement_reduction", boundaryAt: step(4) });
    expect(snapshotAt).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-rights.test.ts
```

Ожидается: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

Создать `apps/api/src/modules/standalone-licenses/standalone-license-rights.ts`:

<!-- prettier-ignore -->
```ts
import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import type { EntitlementSnapshotV1, StandaloneLicenseRights } from "@markiro/platform-contracts";

export type StandaloneFeatureKey = (typeof STANDALONE_FEATURE_KEYS)[number];
export const MAX_LICENSE_TERM_MS = 365 * 86_400_000;
export const MAX_VALIDITY_STEPS = 64;

export interface LicenseValidity {
  validUntil: Date;
  reason: "subscription_end" | "entitlement_reduction" | "one_year_cap";
  /** The time-bound instant the preview promised; `null` for the one-year cap. */
  boundaryAt: Date | null;
}

/**
 * The file carries the snapshot's candidate rights (spec §6.2): quotas as they
 * are (`null` = unlimited) and every feature as a boolean — a feature the
 * catalog never mapped (`null`) is exported as `false` and named (ЛО26).
 */
export function exportStandaloneRights(snapshot: EntitlementSnapshotV1): {
  rights: StandaloneLicenseRights;
  unmapped: StandaloneFeatureKey[];
} {
  const quotas = snapshot.candidate.quotas;
  const features = snapshot.candidate.features;
  return {
    rights: {
      quotas: {
        lines: quotas.lines.limit,
        stations: quotas.stations.limit,
        kiosks: quotas.kiosks.limit,
        cabinetUsers: quotas.cabinetUsers.limit,
      },
      features: {
        labelEditor: features.labelEditor === true,
        publicApi: features.publicApi === true,
        pallets: features.pallets === true,
        chzIntegration: features.chzIntegration === true,
        inventory: features.inventory === true,
        commerceMl: features.commerceMl === true,
        handheld: features.handheld === true,
      },
    },
    unmapped: STANDALONE_FEATURE_KEYS.filter((key) => features[key] === null),
  };
}

/** A reduction: any quota lower (or newly limited), or any feature switched off. */
export function rightsReduce(
  before: StandaloneLicenseRights,
  after: StandaloneLicenseRights,
): boolean {
  for (const key of STANDALONE_QUOTA_KEYS) {
    const was = before.quotas[key];
    const will = after.quotas[key];
    if (will !== null && (was === null || will < was)) return true;
  }
  return STANDALONE_FEATURE_KEYS.some((key) => before.features[key] && !after.features[key]);
}

/**
 * `validUntil` = the subscription end, or the first boundary where the rights
 * shrink, never later than one year from issuance (plan Д5). Increases do not cut
 * the file — the next issuance brings them. Out of steps, it cuts at that
 * boundary rather than trust what it did not evaluate.
 */
export async function licenseValidity(input: {
  at: Date;
  first: EntitlementSnapshotV1;
  snapshotAt: (at: Date) => Promise<EntitlementSnapshotV1>;
  maxSteps?: number;
}): Promise<LicenseValidity> {
  const cap = new Date(input.at.getTime() + MAX_LICENSE_TERM_MS);
  const endsAt = input.first.current.subscription?.endsAt;
  const end = endsAt ? new Date(endsAt) : null;
  const limit: LicenseValidity =
    end !== null && end < cap
      ? { validUntil: end, reason: "subscription_end", boundaryAt: end }
      : { validUntil: cap, reason: "one_year_cap", boundaryAt: null };
  const maxSteps = input.maxSteps ?? MAX_VALIDITY_STEPS;
  let previous = exportStandaloneRights(input.first).rights;
  let next = input.first.nextChangeAt === null ? null : new Date(input.first.nextChangeAt);
  for (let step = 0; next !== null && next < limit.validUntil; step++) {
    if (step >= maxSteps) return { validUntil: next, reason: "entitlement_reduction", boundaryAt: next };
    const snapshot = await input.snapshotAt(next);
    const rights = exportStandaloneRights(snapshot).rights;
    if (rightsReduce(previous, rights))
      return { validUntil: next, reason: "entitlement_reduction", boundaryAt: next };
    previous = rights;
    next = snapshot.nextChangeAt === null ? null : new Date(snapshot.nextChangeAt);
  }
  return limit;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-rights.test.ts
```

Ожидается: PASS.

- [ ] **Step 5: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/standalone-license-rights.ts apps/api/test/standalone-license-rights.test.ts
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/standalone-license-rights.ts apps/api/test/standalone-license-rights.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): offline license rights and validity from the entitlement snapshot (plan ЛЦ-0)

Candidate quotas as they are, unmapped features exported as false and named;
validUntil is the subscription end or the first reduction boundary, capped
at one year; increases never cut the file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 6: API — сверка ИНН и предупреждения регистрации и выпуска (чистые функции)

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/standalone-inn-check.ts`
- Test: `apps/api/test/standalone-inn-check.test.ts`

**Interfaces:**

- Consumes: `normalizeInn`, `isValidInn` (`@markiro/domain`); `StandaloneSiteWarning`, `StandaloneIssuanceWarning`, `StandaloneLicenseRights` (`@markiro/platform-contracts`).
- Produces: `rawInn(value: string | null | undefined): string | null`; `normalizedInn(value: string | null | undefined): string | null`; `siteRegistrationWarnings({ requestInn, trialInn, orgInn, billingInn }): StandaloneSiteWarning[]` (отсортированы, без повторов); `resolveCustomerInn({ orgInn, billingInn, siteInn }): { inn: string | null; warnings: StandaloneIssuanceWarning[] }`; `usageWarnings(rights, usage): StandaloneIssuanceWarning[]`; `sameWarnings(a, b): boolean`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/standalone-inn-check.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";
import { isValidInn } from "@markiro/domain";
import {
  resolveCustomerInn,
  sameWarnings,
  siteRegistrationWarnings,
  usageWarnings,
} from "../src/modules/standalone-licenses/standalone-inn-check";

const MAIN = "7707083893";
const BILLING = "7728168971";
const OTHER = "7736207543";
const INVALID = "7701234567";

describe("test INNs", () => {
  it("are what the plan says they are", () => {
    for (const inn of [MAIN, BILLING, OTHER, "7707654321", "500100732259"]) expect(isValidInn(inn)).toBe(true);
    expect(isValidInn(INVALID)).toBe(false);
  });
});

describe("siteRegistrationWarnings (spec §4.9)", () => {
  it("is quiet when the request, the organization profile and billing agree", () => {
    expect(
      siteRegistrationWarnings({ requestInn: ` ${MAIN} `, trialInn: MAIN, orgInn: MAIN, billingInn: MAIN }),
    ).toEqual([]);
  });

  it("names every disagreement once, sorted", () => {
    expect(
      siteRegistrationWarnings({ requestInn: OTHER, trialInn: MAIN, orgInn: MAIN, billingInn: BILLING }),
    ).toEqual(["request_inn_differs_billing", "request_inn_differs_org", "trial_inn_differs"]);
  });

  it("tells a missing request INN from an invalid one and a missing organization INN", () => {
    expect(siteRegistrationWarnings({ requestInn: "", trialInn: null, orgInn: null, billingInn: null })).toEqual([
      "org_inn_missing",
      "request_inn_missing",
    ]);
    expect(
      siteRegistrationWarnings({ requestInn: INVALID, trialInn: null, orgInn: INVALID, billingInn: MAIN }),
    ).toEqual(["org_inn_missing", "request_inn_invalid"]);
  });
});

describe("resolveCustomerInn (plan Д3)", () => {
  it("takes the organization profile INN and warns when billing differs", () => {
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: BILLING, siteInn: MAIN })).toEqual({
      inn: MAIN,
      warnings: [{ code: "billing_inn_differs", billingInn: BILLING }],
    });
  });

  it("falls back to billing when the profile INN is missing or invalid, and says so", () => {
    for (const orgInn of [null, INVALID]) {
      expect(resolveCustomerInn({ orgInn, billingInn: MAIN, siteInn: MAIN })).toEqual({
        inn: MAIN,
        warnings: [{ code: "customer_inn_from_billing" }],
      });
    }
  });

  it("warns that the host will refuse a file whose INN differs from the site's request", () => {
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: null, siteInn: OTHER })).toEqual({
      inn: MAIN,
      warnings: [{ code: "site_inn_differs", siteInn: OTHER }],
    });
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: null, siteInn: null })).toEqual({
      inn: MAIN,
      warnings: [{ code: "site_inn_differs", siteInn: null }],
    });
  });

  it("has no INN when neither source holds a valid one", () => {
    expect(resolveCustomerInn({ orgInn: INVALID, billingInn: "", siteInn: MAIN })).toEqual({
      inn: null,
      warnings: [],
    });
  });
});

describe("usageWarnings (plan Д10)", () => {
  const rights = {
    quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: null },
    features: {
      labelEditor: true,
      publicApi: false,
      pallets: true,
      chzIntegration: false,
      inventory: false,
      commerceMl: false,
      handheld: false,
    },
  };

  it("warns for each quota below what the site already uses, and never for unlimited", () => {
    expect(usageWarnings(rights, { stations: 4, cabinetUsers: 9, lines: 1 })).toEqual([
      { code: "quota_below_usage", quota: "stations", limit: 2, used: 4 },
    ]);
    expect(usageWarnings(rights, null)).toEqual([]);
  });
});

describe("sameWarnings", () => {
  it("compares warning sets regardless of order and refuses extra or missing codes", () => {
    expect(sameWarnings(["org_inn_missing", "request_inn_missing"], ["request_inn_missing", "org_inn_missing"])).toBe(true);
    expect(sameWarnings(["org_inn_missing"], [])).toBe(false);
    expect(sameWarnings([], ["org_inn_missing"])).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-inn-check.test.ts
```

Ожидается: FAIL — модуль не найден (тест «test INNs» проходит отдельно, если запустить его один).

- [ ] **Step 3: Реализация**

Создать `apps/api/src/modules/standalone-licenses/standalone-inn-check.ts`:

<!-- prettier-ignore -->
```ts
import { normalizeInn } from "@markiro/domain";
import type {
  StandaloneIssuanceWarning,
  StandaloneLicenseRights,
  StandaloneSiteWarning,
} from "@markiro/platform-contracts";

/** Blank and absent are the same: no INN given. */
export function rawInn(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === "" ? null : value;
}

/** The 10 or 12 checksum-valid digits, or `null` (an invalid INN equals nothing, spec §4.9). */
export function normalizedInn(value: string | null | undefined): string | null {
  const raw = rawInn(value);
  return raw === null ? null : normalizeInn(raw);
}

/** Warnings shown before a site is bound (spec §6.2 step 1); the operator acknowledges each. */
export function siteRegistrationWarnings(input: {
  requestInn: string | null | undefined;
  trialInn: string | null | undefined;
  orgInn: string | null | undefined;
  billingInn: string | null | undefined;
}): StandaloneSiteWarning[] {
  const warnings = new Set<StandaloneSiteWarning>();
  const request = normalizedInn(input.requestInn);
  if (rawInn(input.requestInn) === null) warnings.add("request_inn_missing");
  else if (request === null) warnings.add("request_inn_invalid");
  const org = normalizedInn(input.orgInn);
  const billing = normalizedInn(input.billingInn);
  if (org === null) warnings.add("org_inn_missing");
  if (request !== null && org !== null && request !== org) warnings.add("request_inn_differs_org");
  if (request !== null && billing !== null && request !== billing)
    warnings.add("request_inn_differs_billing");
  if (rawInn(input.trialInn) !== null && normalizedInn(input.trialInn) !== request)
    warnings.add("trial_inn_differs");
  return [...warnings].sort();
}

/** The signed `customer.inn` (plan Д3): the organization profile, else billing; never an invalid one. */
export function resolveCustomerInn(input: {
  orgInn: string | null | undefined;
  billingInn: string | null | undefined;
  siteInn: string | null;
}): { inn: string | null; warnings: StandaloneIssuanceWarning[] } {
  const org = normalizedInn(input.orgInn);
  const billing = normalizedInn(input.billingInn);
  const inn = org ?? billing;
  if (inn === null) return { inn: null, warnings: [] };
  const warnings: StandaloneIssuanceWarning[] = [];
  if (org === null) warnings.push({ code: "customer_inn_from_billing" });
  else if (billing !== null && billing !== org)
    warnings.push({ code: "billing_inn_differs", billingInn: billing });
  if (input.siteInn !== inn) warnings.push({ code: "site_inn_differs", siteInn: input.siteInn });
  return { inn, warnings };
}

/** Quotas below what the site's last activation request reported (plan Д10). */
export function usageWarnings(
  rights: StandaloneLicenseRights,
  usage: { stations: number; cabinetUsers: number; lines: number } | null,
): StandaloneIssuanceWarning[] {
  if (usage === null) return [];
  const warnings: StandaloneIssuanceWarning[] = [];
  for (const quota of ["lines", "stations", "cabinetUsers"] as const) {
    const limit = rights.quotas[quota];
    if (limit !== null && limit < usage[quota])
      warnings.push({ code: "quota_below_usage", quota, limit, used: usage[quota] });
  }
  return warnings;
}

export function sameWarnings(
  expected: readonly StandaloneSiteWarning[],
  acknowledged: readonly StandaloneSiteWarning[],
): boolean {
  const ack = new Set(acknowledged);
  return ack.size === new Set(expected).size && expected.every((code) => ack.has(code));
}
```

Порядок предупреждений квот в `usageWarnings` — `lines`, `stations`, `cabinetUsers`: тест проверяет единственное предупреждение, порядок важен для e2e задачи 8 — он такой же.

- [ ] **Step 4: Убедиться, что тест проходит**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-inn-check.test.ts
```

Ожидается: PASS.

- [ ] **Step 5: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/standalone-inn-check.ts apps/api/test/standalone-inn-check.test.ts
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/standalone-inn-check.ts apps/api/test/standalone-inn-check.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): INN reconciliation for standalone sites and license issuance (plan ЛЦ-0)

Checksum-normalized INNs from the activation request, the organization
profile and billing; registration warnings to acknowledge, the signed
customer INN with its billing fallback, and quota-below-usage warnings.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 7: API — сервис площадок: проверка запроса, регистрация, перепривязка хоста, список, аудит

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/standalone-license-authority.ts`, `apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts`, `apps/api/src/modules/standalone-licenses/standalone-license-views.ts`, `apps/api/src/modules/standalone-licenses/standalone-sites.service.ts`, `apps/api/test/support/standalone-license-fixture.ts`
- Test: `apps/api/test/standalone-sites.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.standaloneSites`, `schema.standaloneLicenseIssuances`, `schema.orgProfiles`, `schema.tenantBillingProfiles`, `schema.organization`, `schema.platformUsers`, `schema.platformTwoFactors` (`@markiro/db`); `PlatformAuditService`; `standaloneActivationRequestSchema`, `standaloneLicensePayloadV1Schema` (`@markiro/domain`); контракты задачи 1; `siteRegistrationWarnings`, `normalizedInn`, `rawInn`, `sameWarnings` (задача 6); `StandaloneLicenseSigningConfiguration`, `STANDALONE_LICENSE_SIGNING` (задача 4).
- Produces: `STANDALONE_LICENSE_CAPABILITIES`, `STANDALONE_LICENSE_CLOCK`, `requireStandaloneLicenseActor(tx, principal, tenantId, write)`, `readTenantInns(tx, tenantId)`, `findSite(tx, tenantId, siteId, lock?)`; `standaloneTransaction(db, action, accessMode?)`, `postgresFailure(error)`; `StandaloneSiteRow`, `StandaloneIssuanceRow`, `siteUsage`, `issuanceSummary`, `licenseFileName`, `licenseFile`, `siteView`, `RENEWAL_NOTICE_MS`; `StandaloneSitesService.{list, inspect, register}`; аудит `standalone_site.registered` и `standalone_site.host_rebound` (цель `standalone_site`).

- [ ] **Step 1: Помощник тестов**

Создать `apps/api/test/support/standalone-license-fixture.ts`:

<!-- prettier-ignore -->
```ts
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { standaloneActivationRequestSchema } from "@markiro/domain";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import type { z } from "zod";

export const STANDALONE_TEST_ISSUER = "https://api.example.invalid";
export type ActivationRequest = z.output<typeof standaloneActivationRequestSchema>;

const ACTIVATION_FIXTURE = join(
  __dirname,
  "../../../../packages/domain/fixtures/standalone-license/activation-request.json",
);

/** The ЛЦ-1 activation request fixture with a fresh host id and the INN and usage a test needs. */
export function activationRequest(
  overrides: {
    hostId?: string;
    inn?: string;
    trialInn?: string | null;
    usage?: { stations: number; cabinetUsers: number; lines: number };
  } = {},
): ActivationRequest {
  const base = standaloneActivationRequestSchema.parse(
    JSON.parse(readFileSync(ACTIVATION_FIXTURE, "utf8")),
  );
  return standaloneActivationRequestSchema.parse({
    ...base,
    hostId: overrides.hostId ?? randomUUID(),
    organization: { ...base.organization, inn: overrides.inn ?? base.organization.inn },
    // The trial INN follows the request INN unless a test sets it: no trial_inn_differs by accident.
    trial:
      overrides.trialInn === null || base.trial === null
        ? null
        : { ...base.trial, inn: overrides.trialInn ?? overrides.inn ?? base.organization.inn },
    usage: overrides.usage ?? { stations: 1, cabinetUsers: 1, lines: 1 },
  });
}

/** A complete, valid license signing environment with a fresh P-256 key. */
export function signingEnv(kid = "test-lic-api") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    STANDALONE_LICENSE_ISSUER: STANDALONE_TEST_ISSUER,
    STANDALONE_LICENSE_KID: kid,
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin: STANDALONE_TEST_ISSUER,
      revision: "test-v1",
      keys: [{ kid, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }],
      retiredKids: [],
    }),
  };
}

export async function platformActor(
  db: Db,
  role: "platform_admin" | "support" | "accountant" = "platform_admin",
  options: { verified?: boolean } = {},
): Promise<PlatformPrincipal> {
  const userId = randomUUID();
  await db.insert(schema.platformUsers).values({
    id: userId,
    email: `${userId}@example.invalid`,
    name: "Standalone license tester",
    role,
    status: "active",
    twoFactorEnabled: true,
  });
  await db.insert(schema.platformTwoFactors).values({
    id: randomUUID(),
    userId,
    secret: "test-only",
    backupCodes: "test-only",
    verified: options.verified ?? true,
  });
  return { userId, role, capabilities: platformCapabilitiesForRole[role], twoFactorReady: true };
}

/** INNs of the tenant's organization profile and current billing profile; `undefined` leaves one out. */
export async function setTenantInns(
  db: Db,
  tenantId: string,
  inns: { org?: string | null; billing?: string },
): Promise<void> {
  if (inns.org !== undefined)
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: inns.org })
      .onConflictDoUpdate({ target: schema.orgProfiles.tenantId, set: { inn: inns.org } });
  if (inns.billing !== undefined)
    await db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      isCurrent: true,
      kind: "legal_entity",
      fullName: "ООО «Завод Тест»",
      displayName: "Завод Тест",
      inn: inns.billing,
      addressRaw: "Москва",
      legalAddressRaw: "Москва",
    });
}

export async function auditRows(db: Db, tenantId: string) {
  return db
    .select({
      actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
      actorRole: schema.platformAuditEvents.actorRole,
      tenantId: schema.platformAuditEvents.tenantId,
      action: schema.platformAuditEvents.action,
      outcome: schema.platformAuditEvents.outcome,
      targetType: schema.platformAuditEvents.targetType,
      targetId: schema.platformAuditEvents.targetId,
      reason: schema.platformAuditEvents.reason,
      requestId: schema.platformAuditEvents.requestId,
      before: schema.platformAuditEvents.before,
      after: schema.platformAuditEvents.after,
    })
    .from(schema.platformAuditEvents)
    .where(eq(schema.platformAuditEvents.tenantId, tenantId))
    .orderBy(asc(schema.platformAuditEvents.createdAt), asc(schema.platformAuditEvents.id));
}
```

- [ ] **Step 2: Написать падающий e2e-тест**

Создать `apps/api/test/standalone-sites.e2e.test.ts`:

<!-- prettier-ignore -->
```ts
import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { configureStandaloneLicenseSigning } from "../src/modules/standalone-licenses/standalone-license-keyset";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import { createOrganization } from "./support/subscription-fixtures";
import {
  activationRequest,
  auditRows,
  platformActor,
  setTenantInns,
  signingEnv,
} from "./support/standalone-license-fixture";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const NOW = new Date("2026-10-20T09:00:00.000Z");
const sites = new StandaloneSitesService(
  db,
  new PlatformAuditService(),
  configureStandaloneLicenseSigning(signingEnv()),
  () => NOW,
);
afterAll(() => connection.pool.end());

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return error instanceof ConflictException ? error.getResponse() : null;
}

async function siteRows(tenantId: string) {
  return db.select().from(schema.standaloneSites).where(eq(schema.standaloneSites.tenantId, tenantId));
}

describe.skipIf(!process.env.DATABASE_URL)("standalone sites (plan ЛЦ-0)", () => {
  it("registers a site from an activation request with an exact audit row and replays the same request", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893", billing: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const body = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех розлива",
      request,
      acknowledgedWarnings: [],
    };

    const site = await sites.register(admin, tenantId, body);

    expect(site).toMatchObject({
      tenantId,
      hostId: request.hostId,
      name: "Цех розлива",
      requestInn: "7707083893",
      usage: { stations: 1, cabinetUsers: 1, lines: 1 },
      lastIssuedSequence: 0,
      latestIssuance: null,
      renewalDue: false,
      createdAt: NOW.toISOString(),
    });
    expect(site.hostHistory).toEqual([
      {
        hostId: request.hostId,
        requestInn: "7707083893",
        requestId: body.requestId,
        boundAt: NOW.toISOString(),
        boundByPlatformUserId: admin.userId,
      },
    ]);
    expect(await sites.register(admin, tenantId, body)).toEqual(site);
    expect(await siteRows(tenantId)).toHaveLength(1);
    expect(await auditRows(db, tenantId)).toEqual([
      {
        actorPlatformUserId: admin.userId,
        actorRole: "platform_admin",
        tenantId,
        action: "standalone_site.registered",
        outcome: "success",
        targetType: "standalone_site",
        targetId: site.id,
        reason: null,
        requestId: body.requestId,
        before: null,
        after: {
          siteId: site.id,
          hostId: request.hostId,
          name: "Цех розлива",
          requestInn: "7707083893",
          warnings: [],
        },
      },
    ]);
    expect(await sites.list(admin, tenantId)).toEqual({
      tenantId,
      signingConfigured: true,
      sites: [site],
    });
  });

  it("refuses unacknowledged INN warnings without writing, then registers with exactly those acknowledged", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893", billing: "7728168971" });
    const request = activationRequest({ inn: "7736207543" });

    const inspection = await sites.inspect(admin, tenantId, { request });
    expect(inspection).toMatchObject({
      hostId: request.hostId,
      innFacts: {
        requestInn: "7736207543",
        orgInn: "7707083893",
        billingInn: "7728168971",
        trialInn: "7736207543",
      },
      warnings: ["request_inn_differs_billing", "request_inn_differs_org"],
      blocking: null,
      registeredSite: null,
    });
    expect(
      await refusal(
        sites.register(admin, tenantId, {
          intent: "create",
          requestId: randomUUID(),
          name: "Склад",
          request,
          acknowledgedWarnings: ["request_inn_differs_org"],
        }),
      ),
    ).toEqual({ code: "standalone_site_warnings_unacknowledged" });
    expect(await siteRows(tenantId)).toEqual([]);
    expect(await auditRows(db, tenantId)).toEqual([]);

    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Склад",
      request,
      acknowledgedWarnings: ["request_inn_differs_org", "request_inn_differs_billing"],
    });
    expect((await auditRows(db, tenantId)).map((row) => row.after)).toEqual([
      {
        siteId: site.id,
        hostId: request.hostId,
        name: "Склад",
        requestInn: "7736207543",
        warnings: ["request_inn_differs_billing", "request_inn_differs_org"],
      },
    ]);
  });

  it("keeps tenants apart: another tenant neither sees, takes nor rebinds the site", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    await setTenantInns(db, tenantA, { org: "7707083893" });
    await setTenantInns(db, tenantB, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const site = await sites.register(admin, tenantA, {
      intent: "create",
      requestId: randomUUID(),
      name: "A",
      request,
      acknowledgedWarnings: [],
    });

    expect((await sites.list(admin, tenantB)).sites).toEqual([]);
    expect(await sites.inspect(admin, tenantB, { request })).toMatchObject({
      blocking: "host_taken",
      registeredSite: null,
    });
    expect(await sites.inspect(admin, tenantA, { request })).toMatchObject({
      blocking: "host_registered",
      registeredSite: { id: site.id, name: "A" },
    });
    expect(
      await refusal(
        sites.register(admin, tenantB, {
          intent: "create",
          requestId: randomUUID(),
          name: "B",
          request,
          acknowledgedWarnings: [],
        }),
      ),
    ).toEqual({ code: "standalone_site_host_taken" });
    await expect(
      sites.register(admin, tenantB, {
        intent: "rebind",
        requestId: randomUUID(),
        siteId: site.id,
        request: activationRequest({ inn: "7707083893" }),
        acknowledgedWarnings: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await refusal(
        sites.register(admin, tenantA, {
          intent: "create",
          requestId: randomUUID(),
          name: "A2",
          request,
          acknowledgedWarnings: [],
        }),
      ),
    ).toEqual({ code: "standalone_site_host_registered" });
    expect(await siteRows(tenantB)).toEqual([]);
    expect(await auditRows(db, tenantB)).toEqual([]);
    expect((await auditRows(db, tenantA)).map((row) => row.action)).toEqual([
      "standalone_site.registered",
    ]);
    await expect(sites.list(admin, `missing-${randomUUID()}`)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("binds a new host id to the same site, keeps the history and audits the change once", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const first = activationRequest({ inn: "7707083893" });
    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Цех",
      request: first,
      acknowledgedWarnings: [],
    });
    const second = activationRequest({ inn: "7707083893", usage: { stations: 3, cabinetUsers: 2, lines: 2 } });
    const rebind = {
      intent: "rebind" as const,
      requestId: randomUUID(),
      siteId: site.id,
      request: second,
      acknowledgedWarnings: [],
    };

    const rebound = await sites.register(admin, tenantId, rebind);

    expect(rebound).toMatchObject({
      id: site.id,
      hostId: second.hostId,
      usage: { stations: 3, cabinetUsers: 2, lines: 2 },
      lastIssuedSequence: 0,
    });
    expect(rebound.hostHistory.map((entry) => entry.hostId)).toEqual([first.hostId, second.hostId]);
    expect(await sites.register(admin, tenantId, rebind)).toEqual(rebound);
    expect(
      await refusal(sites.register(admin, tenantId, { ...rebind, requestId: randomUUID() })),
    ).toEqual({ code: "standalone_site_host_unchanged" });
    const rows = await auditRows(db, tenantId);
    expect(rows.map((row) => row.action)).toEqual([
      "standalone_site.registered",
      "standalone_site.host_rebound",
    ]);
    expect(rows[1]).toEqual({
      actorPlatformUserId: admin.userId,
      actorRole: "platform_admin",
      tenantId,
      action: "standalone_site.host_rebound",
      outcome: "success",
      targetType: "standalone_site",
      targetId: site.id,
      reason: null,
      requestId: rebind.requestId,
      before: { hostId: first.hostId, requestInn: "7707083893" },
      after: { siteId: site.id, hostId: second.hostId, requestInn: "7707083893", warnings: [] },
    });
  });

  it("denies support, accountant and an administrator without a verified factor, writing nothing", async () => {
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const body = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех",
      request,
      acknowledgedWarnings: [],
    };
    for (const actor of [
      await platformActor(db, "support"),
      await platformActor(db, "accountant"),
      await platformActor(db, "platform_admin", { verified: false }),
      undefined,
    ]) {
      await expect(sites.list(actor, tenantId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sites.inspect(actor, tenantId, { request })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(sites.register(actor, tenantId, body)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(await siteRows(tenantId)).toEqual([]);
    expect(await auditRows(db, tenantId)).toEqual([]);
  });
});
```

Порядок строк аудита в `auditRows` — `created_at`, затем `id`: две операции идут разными транзакциями (`now()` транзакции различается).

- [ ] **Step 3: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-sites.e2e.test.ts
```

Ожидается: FAIL — модуль `standalone-sites.service` не найден. Без `DATABASE_URL` — SKIP (назвать; задача не считается проверенной без базы).

- [ ] **Step 4: Реализация**

Создать `apps/api/src/modules/standalone-licenses/standalone-license-authority.ts`:

<!-- prettier-ignore -->
```ts
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type { PlatformCapability, PlatformPrincipal } from "@markiro/platform-contracts";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const STANDALONE_LICENSE_CAPABILITIES = [
  "tenants.read",
  "standaloneLicenses.manage",
] as const satisfies readonly PlatformCapability[];
export const STANDALONE_LICENSE_CLOCK = Symbol("STANDALONE_LICENSE_CLOCK");
export type StandaloneLicenseClock = () => Date;

/**
 * Reloads the platform user, its verified factor and the tenant inside the
 * caller's transaction (apps/api/AGENTS.md); a write takes them FOR SHARE in the
 * platform recovery order (factor first, as device licensing does).
 */
export async function requireStandaloneLicenseActor(
  tx: SubscriptionTransaction,
  principal: PlatformPrincipal | undefined,
  tenantId: string,
  write: boolean,
) {
  if (!principal?.twoFactorReady) throw new ForbiddenException();
  const factorQuery = tx
    .select({ id: schema.platformTwoFactors.id })
    .from(schema.platformTwoFactors)
    .where(
      and(
        eq(schema.platformTwoFactors.userId, principal.userId),
        eq(schema.platformTwoFactors.verified, true),
      ),
    );
  if (!(await (write ? factorQuery.for("share") : factorQuery))[0]) throw new ForbiddenException();
  const userQuery = tx
    .select()
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.id, principal.userId));
  const [user] = await (write ? userQuery.for("share") : userQuery);
  if (
    !user ||
    user.status !== "active" ||
    !user.twoFactorEnabled ||
    !STANDALONE_LICENSE_CAPABILITIES.every((capability) =>
      platformCapabilitiesForRole(user.role).includes(capability),
    )
  )
    throw new ForbiddenException();
  const [tenant] = await tx
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId));
  if (!tenant) throw new NotFoundException();
  return { user, tenant };
}

export async function readTenantInns(tx: SubscriptionTransaction, tenantId: string) {
  const [profile] = await tx
    .select({ inn: schema.orgProfiles.inn })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  const [billing] = await tx
    .select({ inn: schema.tenantBillingProfiles.inn, fullName: schema.tenantBillingProfiles.fullName })
    .from(schema.tenantBillingProfiles)
    .where(
      and(
        eq(schema.tenantBillingProfiles.tenantId, tenantId),
        eq(schema.tenantBillingProfiles.isCurrent, true),
      ),
    );
  return {
    orgInn: profile?.inn ?? null,
    billingInn: billing?.inn ?? null,
    billingName: billing?.fullName ?? null,
  };
}

/** A site of this tenant or 404; never another tenant's (composite tenant scope). */
export async function findSite(
  tx: SubscriptionTransaction,
  tenantId: string,
  siteId: string,
  lock = false,
) {
  const query = tx
    .select()
    .from(schema.standaloneSites)
    .where(and(eq(schema.standaloneSites.tenantId, tenantId), eq(schema.standaloneSites.id, siteId)));
  const [site] = await (lock ? query.for("update") : query);
  if (!site) throw new NotFoundException();
  return site;
}
```

Создать `apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts`:

<!-- prettier-ignore -->
```ts
import type { Db } from "@markiro/db";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

const RETRYABLE_CONSTRAINTS = new Set([
  "standalone_sites_host_id_uq",
  "standalone_sites_tenant_request_uq",
  "standalone_license_issuances_tenant_site_request_uq",
]);

/** The PostgreSQL SQLSTATE and constraint behind a driver or ORM error, if any. */
export function postgresFailure(error: unknown): { code: string | null; constraint: string | null } {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && typeof cursor === "object"; depth++) {
    const code = "code" in cursor && typeof cursor.code === "string" ? cursor.code : null;
    if (code !== null && /^[0-9A-Z]{5}$/u.test(code)) {
      const constraint =
        "constraint" in cursor && typeof cursor.constraint === "string" ? cursor.constraint : null;
      return { code, constraint };
    }
    cursor = "cause" in cursor ? cursor.cause : null;
  }
  return { code: null, constraint: null };
}

/**
 * REPEATABLE READ; a serialization failure or a lost idempotency race restarts the
 * whole operation (at most three attempts), and the restart replays the winner.
 */
export async function standaloneTransaction<T>(
  db: Db,
  action: (tx: SubscriptionTransaction) => Promise<T>,
  accessMode: "read write" | "read only" = "read write",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(action, { isolationLevel: "repeatable read", accessMode });
    } catch (error) {
      const failure = postgresFailure(error);
      const retryable =
        failure.code === "40001" ||
        (failure.code === "23505" &&
          failure.constraint !== null &&
          RETRYABLE_CONSTRAINTS.has(failure.constraint));
      if (!retryable || attempt >= 2) throw error;
    }
  }
}
```

Создать `apps/api/src/modules/standalone-licenses/standalone-license-views.ts`:

<!-- prettier-ignore -->
```ts
import type { schema } from "@markiro/db";
import {
  standaloneActivationRequestSchema,
  standaloneLicensePayloadV1Schema,
} from "@markiro/domain";
import {
  standaloneIssuanceSummarySchema,
  standaloneLicenseFileSchema,
  standaloneSiteSchema,
  type StandaloneIssuanceSummary,
  type StandaloneLicenseFile,
  type StandaloneSite,
} from "@markiro/platform-contracts";

export type StandaloneSiteRow = typeof schema.standaloneSites.$inferSelect;
export type StandaloneIssuanceRow = typeof schema.standaloneLicenseIssuances.$inferSelect;
/** Spec §6.2 step 4: remind 30 days before `validUntil`. */
export const RENEWAL_NOTICE_MS = 30 * 86_400_000;

/** What the host reported in its last activation request (plan Д10), or `null` if unreadable. */
export function siteUsage(
  site: StandaloneSiteRow,
): { stations: number; cabinetUsers: number; lines: number } | null {
  const request = standaloneActivationRequestSchema.safeParse(site.lastActivationRequest);
  if (!request.success) return null;
  const { stations, cabinetUsers, lines } = request.data.usage;
  return { stations, cabinetUsers, lines };
}

export function issuanceSummary(row: StandaloneIssuanceRow): StandaloneIssuanceSummary {
  const payload = standaloneLicensePayloadV1Schema.parse(row.payload);
  return standaloneIssuanceSummarySchema.parse({
    licenseId: row.id,
    siteId: row.siteId,
    sequence: row.sequence,
    hostId: row.hostId,
    plan: row.plan,
    planVersionId: row.planVersionId,
    entitlementRevision: row.entitlementRevision.toString(),
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil.toISOString(),
    validUntilReason: row.validUntilReason,
    graceDays: row.graceDays,
    kid: row.kid,
    sha256: row.sha256,
    issuedAt: row.issuedAt.toISOString(),
    issuedByPlatformUserId: row.issuedByPlatformUserId,
    replaces: row.replacesId,
    customer: { name: payload.customer.name, inn: payload.customer.inn },
    rights: { quotas: payload.quotas, features: payload.features },
  });
}

export function licenseFileName(hostId: string, sequence: number): string {
  return `markiro-${hostId.slice(0, 8)}-${String(sequence).padStart(3, "0")}.mklic`;
}

export function licenseFile(row: StandaloneIssuanceRow): StandaloneLicenseFile {
  return standaloneLicenseFileSchema.parse({
    issuance: issuanceSummary(row),
    fileName: licenseFileName(row.hostId, row.sequence),
    compact: row.compact,
    sha256: row.sha256,
  });
}

export function siteView(
  site: StandaloneSiteRow,
  latest: StandaloneIssuanceRow | null,
  now: Date,
): StandaloneSite {
  const request = standaloneActivationRequestSchema.safeParse(site.lastActivationRequest);
  return standaloneSiteSchema.parse({
    id: site.id,
    tenantId: site.tenantId,
    hostId: site.hostId,
    name: site.name,
    requestInn: site.requestInn,
    hostVersion: request.success ? request.data.hostVersion : null,
    usage: siteUsage(site),
    requestCreatedAt: request.success ? request.data.createdAt : null,
    hostHistory: site.hostHistory,
    lastIssuedSequence: site.lastIssuedSequence,
    latestIssuance: latest ? issuanceSummary(latest) : null,
    renewalDue: latest !== null && latest.validUntil.getTime() - now.getTime() <= RENEWAL_NOTICE_MS,
    createdAt: site.createdAt.toISOString(),
  });
}
```

Создать `apps/api/src/modules/standalone-licenses/standalone-sites.service.ts`:

<!-- prettier-ignore -->
```ts
import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  standaloneSiteHostHistorySchema,
  standaloneSiteInspectionSchema,
  standaloneSiteListSchema,
  type PlatformPrincipal,
  type StandaloneSite,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteInspection,
  type StandaloneSiteList,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  findSite,
  readTenantInns,
  requireStandaloneLicenseActor,
  STANDALONE_LICENSE_CLOCK,
  type StandaloneLicenseClock,
} from "./standalone-license-authority";
import {
  STANDALONE_LICENSE_SIGNING,
  type StandaloneLicenseSigningConfiguration,
} from "./standalone-license-keyset";
import { standaloneTransaction } from "./standalone-license-transaction";
import { siteView, type StandaloneSiteRow } from "./standalone-license-views";
import { normalizedInn, sameWarnings, siteRegistrationWarnings } from "./standalone-inn-check";

const MAX_HOST_HISTORY = 100;
const conflict = (code: string) => new ConflictException({ code });

@Injectable()
export class StandaloneSitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_LICENSE_SIGNING)
    private readonly signing: StandaloneLicenseSigningConfiguration | null,
    @Inject(STANDALONE_LICENSE_CLOCK) private readonly now: StandaloneLicenseClock,
  ) {}

  async list(principal: PlatformPrincipal | undefined, tenantId: string): Promise<StandaloneSiteList> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const sites = await tx
          .select()
          .from(schema.standaloneSites)
          .where(eq(schema.standaloneSites.tenantId, tenantId))
          .orderBy(asc(schema.standaloneSites.createdAt), asc(schema.standaloneSites.id));
        const issuances = sites.length
          ? await tx
              .select()
              .from(schema.standaloneLicenseIssuances)
              .where(
                and(
                  eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
                  inArray(
                    schema.standaloneLicenseIssuances.siteId,
                    sites.map((site) => site.id),
                  ),
                ),
              )
              .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
          : [];
        const now = this.now();
        return standaloneSiteListSchema.parse({
          tenantId,
          signingConfigured: this.signing !== null,
          sites: sites.map((site) =>
            siteView(site, issuances.find((row) => row.siteId === site.id) ?? null, now),
          ),
        });
      },
      "read only",
    );
  }

  async inspect(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneSiteInspectRequest,
  ): Promise<StandaloneSiteInspection> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const { request } = body;
        const inns = await readTenantInns(tx, tenantId);
        const [holder] = await tx
          .select({
            id: schema.standaloneSites.id,
            name: schema.standaloneSites.name,
            tenantId: schema.standaloneSites.tenantId,
          })
          .from(schema.standaloneSites)
          .where(eq(schema.standaloneSites.hostId, request.hostId));
        const trialInn = request.trial === null ? null : request.trial.inn;
        return standaloneSiteInspectionSchema.parse({
          hostId: request.hostId,
          hostVersion: request.hostVersion,
          organizationName: request.organization.name.slice(0, 500) || null,
          usage: {
            stations: request.usage.stations,
            cabinetUsers: request.usage.cabinetUsers,
            lines: request.usage.lines,
          },
          innFacts: {
            requestInn: normalizedInn(request.organization.inn),
            orgInn: normalizedInn(inns.orgInn),
            billingInn: normalizedInn(inns.billingInn),
            trialInn: normalizedInn(trialInn),
          },
          warnings: siteRegistrationWarnings({
            requestInn: request.organization.inn,
            trialInn,
            orgInn: inns.orgInn,
            billingInn: inns.billingInn,
          }),
          blocking: !holder ? null : holder.tenantId === tenantId ? "host_registered" : "host_taken",
          registeredSite:
            holder && holder.tenantId === tenantId ? { id: holder.id, name: holder.name } : null,
        });
      },
      "read only",
    );
  }

  /** `create` binds a new site; `rebind` moves an existing site to a new host id (spec §6.3). */
  async register(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneSiteRegister,
  ): Promise<StandaloneSite> {
    return standaloneTransaction(this.db, async (tx) => {
      const { user } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
      const now = this.now();
      const { request } = body;
      let site: StandaloneSiteRow | null = null;
      if (body.intent === "create") {
        const [replay] = await tx
          .select()
          .from(schema.standaloneSites)
          .where(
            and(
              eq(schema.standaloneSites.tenantId, tenantId),
              eq(schema.standaloneSites.requestId, body.requestId),
            ),
          );
        if (replay) {
          if (replay.hostId !== request.hostId || replay.createdByPlatformUserId !== user.id)
            throw conflict("standalone_site_request_conflict");
          return this.view(tx, replay, now);
        }
      } else {
        site = await findSite(tx, tenantId, body.siteId, true);
        const history = standaloneSiteHostHistorySchema.parse(site.hostHistory);
        const replay = history.find((entry) => entry.requestId === body.requestId);
        if (replay) {
          if (replay.hostId !== request.hostId || replay.boundByPlatformUserId !== user.id)
            throw conflict("standalone_site_request_conflict");
          return this.view(tx, site, now);
        }
        if (site.hostId === request.hostId) throw conflict("standalone_site_host_unchanged");
        if (history.length >= MAX_HOST_HISTORY) throw conflict("standalone_site_history_full");
      }
      const [holder] = await tx
        .select({ tenantId: schema.standaloneSites.tenantId })
        .from(schema.standaloneSites)
        .where(eq(schema.standaloneSites.hostId, request.hostId));
      if (holder)
        throw conflict(
          holder.tenantId === tenantId
            ? "standalone_site_host_registered"
            : "standalone_site_host_taken",
        );
      const inns = await readTenantInns(tx, tenantId);
      const warnings = siteRegistrationWarnings({
        requestInn: request.organization.inn,
        trialInn: request.trial === null ? null : request.trial.inn,
        orgInn: inns.orgInn,
        billingInn: inns.billingInn,
      });
      if (!sameWarnings(warnings, body.acknowledgedWarnings))
        throw conflict("standalone_site_warnings_unacknowledged");
      const requestInn = normalizedInn(request.organization.inn);
      const entry = {
        hostId: request.hostId,
        requestInn,
        requestId: body.requestId,
        boundAt: now.toISOString(),
        boundByPlatformUserId: user.id,
      };
      if (body.intent === "create") {
        const id = randomUUID();
        const [row] = await tx
          .insert(schema.standaloneSites)
          .values({
            id,
            tenantId,
            hostId: request.hostId,
            name: body.name,
            requestInn,
            lastActivationRequest: request,
            hostHistory: [entry],
            requestId: body.requestId,
            createdByPlatformUserId: user.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("standalone site insert returned no row");
        await this.audit.record(tx, {
          actorPlatformUserId: user.id,
          actorRole: user.role,
          action: "standalone_site.registered",
          outcome: "success",
          tenantId,
          targetType: "standalone_site",
          targetId: id,
          reason: null,
          requestId: body.requestId,
          before: null,
          after: { siteId: id, hostId: request.hostId, name: body.name, requestInn, warnings },
        });
        return this.view(tx, row, now);
      }
      if (!site) throw new Error("rebind without a site");
      const history = standaloneSiteHostHistorySchema.parse(site.hostHistory);
      const [row] = await tx
        .update(schema.standaloneSites)
        .set({
          hostId: request.hostId,
          requestInn,
          lastActivationRequest: request,
          hostHistory: [...history, entry],
          updatedAt: now,
        })
        .where(
          and(eq(schema.standaloneSites.tenantId, tenantId), eq(schema.standaloneSites.id, site.id)),
        )
        .returning();
      if (!row) throw new Error("standalone site update returned no row");
      await this.audit.record(tx, {
        actorPlatformUserId: user.id,
        actorRole: user.role,
        action: "standalone_site.host_rebound",
        outcome: "success",
        tenantId,
        targetType: "standalone_site",
        targetId: site.id,
        reason: null,
        requestId: body.requestId,
        before: { hostId: site.hostId, requestInn: site.requestInn },
        after: { siteId: site.id, hostId: request.hostId, requestInn, warnings },
      });
      return this.view(tx, row, now);
    });
  }

  private async view(tx: SubscriptionTransaction, site: StandaloneSiteRow, now: Date) {
    const [latest] = await tx
      .select()
      .from(schema.standaloneLicenseIssuances)
      .where(
        and(
          eq(schema.standaloneLicenseIssuances.tenantId, site.tenantId),
          eq(schema.standaloneLicenseIssuances.siteId, site.id),
        ),
      )
      .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
      .limit(1);
    return siteView(site, latest ?? null, now);
  }
}
```

`request.trial === null ? null : request.trial.inn` и `request.organization.inn` — по форме ЛЦ-1 (см. «Заметки для исполнения»): если `trial` у ЛЦ-1 необязателен (`undefined`), заменить на `request.trial?.inn ?? null` и записать.

- [ ] **Step 5: Убедиться, что тест проходит**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-sites.e2e.test.ts
```

Ожидается: PASS (5 тестов) при `DATABASE_URL` с применённой `0186`.

- [ ] **Step 6: Мутация (убедиться, что изоляция проверяется)**

<!-- prettier-ignore -->
```bash
cp apps/api/src/modules/standalone-licenses/standalone-license-authority.ts /tmp/claude/before && shasum -a 256 apps/api/src/modules/standalone-licenses/standalone-license-authority.ts
```

В `findSite` заменить `.where(and(eq(schema.standaloneSites.tenantId, tenantId), eq(schema.standaloneSites.id, siteId)))` на `.where(eq(schema.standaloneSites.id, siteId))`; прогнать `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-sites.e2e.test.ts` — ожидается FAIL «keeps tenants apart…» (перепривязка чужой площадки не отвечает `404`). Вернуть: `cp /tmp/claude/before apps/api/src/modules/standalone-licenses/standalone-license-authority.ts`, `shasum` тот же. Мутацию не коммитить.

- [ ] **Step 7: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/standalone-license-authority.ts apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts apps/api/src/modules/standalone-licenses/standalone-license-views.ts apps/api/src/modules/standalone-licenses/standalone-sites.service.ts apps/api/test/support/standalone-license-fixture.ts apps/api/test/standalone-sites.e2e.test.ts
git diff --check
```

- [ ] **Step 8: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/standalone-license-authority.ts apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts apps/api/src/modules/standalone-licenses/standalone-license-views.ts apps/api/src/modules/standalone-licenses/standalone-sites.service.ts apps/api/test/support/standalone-license-fixture.ts apps/api/test/standalone-sites.e2e.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): standalone sites from activation requests (plan ЛЦ-0)

Inspect an activation request (INN facts, warnings, host already bound),
register a site or bind a new host id to it with the warnings acknowledged,
list sites with their latest license; tenant-scoped, platform actor reloaded
in the transaction, exact platform audit, idempotent by request id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 8: API — выпуск файла: предпросмотр, подтверждение, журнал, повторная загрузка

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts`
- Test: `apps/api/test/standalone-license-issuance.e2e.test.ts`

**Interfaces:**

- Consumes: `EntitlementsService.loadSnapshotTimeline(tenantId, tx)` (возвращает `(at) => Promise<{ snapshot, … }>`); `exportStandaloneRights`, `licenseValidity` (задача 5); `resolveCustomerInn`, `usageWarnings` (задача 6); `requireStandaloneLicenseActor`, `findSite`, `readTenantInns`, `standaloneTransaction`, `postgresFailure`, `issuanceSummary`, `licenseFile`, `siteUsage` (задача 7); `signCompactJws` (задача 3); `STANDALONE_LICENSE_TYP`, `standaloneLicensePayloadV1Schema` (`@markiro/domain`).
- Produces: `StandaloneLicenseIssuanceService.{preview, confirm, listIssuances, download}`; `DEFAULT_SUBSCRIPTION_GRACE_DAYS = 14`; коды отказов `standalone_license_tenant_id_unsupported` (Д14), `standalone_license_subscription_required`, `standalone_license_inn_required`, `standalone_license_signing_unavailable`, `standalone_license_preview_stale`, `standalone_license_request_conflict` (409), `standalone_license_grace_invalid` (400); аудит `standalone_license.issued` (цель `standalone_license`).

- [ ] **Step 1: Написать падающий e2e-тест**

Создать `apps/api/test/standalone-license-issuance.e2e.test.ts`:

<!-- prettier-ignore -->
```ts
import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { verifyStandaloneLicense } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { configureStandaloneLicenseSigning } from "../src/modules/standalone-licenses/standalone-license-keyset";
import { StandaloneLicenseIssuanceService } from "../src/modules/standalone-licenses/standalone-license-issuance.service";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedAddon,
} from "./support/subscription-fixtures";
import {
  activationRequest,
  auditRows,
  platformActor,
  setTenantInns,
  signingEnv,
  STANDALONE_TEST_ISSUER,
} from "./support/standalone-license-fixture";

const DAY = 86_400_000;
const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const entitlements = new EntitlementsService(db, "managed_only");
const audit = new PlatformAuditService();
const signing = configureStandaloneLicenseSigning(signingEnv());
let clock = new Date();
const now = () => clock;
const sites = new StandaloneSitesService(db, audit, signing, now);
const issuance = new StandaloneLicenseIssuanceService(db, entitlements, audit, signing, now);
afterAll(() => connection.pool.end());

const NO_FEATURES = {
  labelEditor: false,
  publicApi: false,
  pallets: false,
  chzIntegration: false,
  inventory: false,
  commerceMl: false,
  handheld: false,
};
const UNMAPPED = (["chzIntegration", "inventory", "commerceMl", "handheld"] as const).map(
  (feature) => ({ code: "feature_unmapped" as const, feature }),
);

async function httpRefusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error instanceof HttpException
    ? { status: error.getStatus(), body: error.getResponse() }
    : { status: 0, body: null };
}

async function issuedRows(tenantId: string) {
  return db
    .select()
    .from(schema.standaloneLicenseIssuances)
    .where(eq(schema.standaloneLicenseIssuances.tenantId, tenantId));
}

/** A managed tenant with an organization INN and one registered site. */
async function siteFor(
  input: {
    status?: "trial" | "active";
    endsAt?: Date | null;
    org?: string | null;
    billing?: string;
    usage?: { stations: number; cabinetUsers: number; lines: number };
    managed?: boolean;
    tenantId?: string;
  } = {},
) {
  clock = new Date();
  const admin = await platformActor(db);
  const endsAt = input.endsAt === undefined ? new Date(clock.getTime() + 90 * DAY) : input.endsAt;
  const tenantId = await createOrganization(db, input.tenantId);
  const managed =
    input.managed === false
      ? { tenantId, planVersionId: "", subscriptionId: "" }
      : await createManagedSubscription(db, {
          tenantId,
          status: input.status ?? "active",
          startsAt: new Date(clock.getTime() - 60_000),
          endsAt,
          maxLines: 2,
          maxStations: 3,
          maxKiosks: 0,
          maxCabinetUsers: 5,
        });
  await setTenantInns(db, managed.tenantId, {
    org: input.org === undefined ? "7707083893" : input.org,
    ...(input.billing === undefined ? {} : { billing: input.billing }),
  });
  const request = activationRequest({
    inn: "7707083893",
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  });
  const inspection = await sites.inspect(admin, managed.tenantId, { request });
  const site = await sites.register(admin, managed.tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Цех",
    request,
    acknowledgedWarnings: inspection.warnings,
  });
  return { admin, ...managed, endsAt, site };
}

function trustedKeyset() {
  if (!signing) throw new Error("fixture signing");
  return {
    origin: STANDALONE_TEST_ISSUER,
    keys: signing.keyset.keys.map((key) => ({
      kid: key.kid,
      jwk: { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y },
    })),
    retiredKids: [],
  };
}

describe.skipIf(!process.env.DATABASE_URL)("standalone license issuance (plan ЛЦ-0)", () => {
  it("issues a subscription file from the snapshot that the domain verifies, with an exact audit row", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });

    expect(preview.previous).toBeNull();
    expect(preview.next).toEqual({
      sequence: 1,
      plan: "subscription",
      planVersionId: f.planVersionId,
      entitlementRevision: preview.expected.entitlementRevision,
      validFrom: clock.toISOString(),
      validUntil: f.endsAt?.toISOString(),
      validUntilReason: "subscription_end",
      graceDays: 14,
      customer: { name: `Subscription fixture ${f.tenantId}`, inn: "7707083893" },
      rights: { quotas: { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5 }, features: NO_FEATURES },
    });
    expect(preview.warnings).toEqual(UNMAPPED);
    expect(preview.expected).toEqual({
      entitlementRevision: preview.next.entitlementRevision,
      previousSequence: 0,
      boundaryAt: f.endsAt?.toISOString(),
    });
    expect(await issuedRows(f.tenantId)).toEqual([]);

    const requestId = randomUUID();
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId,
      graceDays: null,
      expected: preview.expected,
    });

    expect(file.fileName).toBe(`markiro-${f.site.hostId.slice(0, 8)}-001.mklic`);
    expect(file.sha256).toBe(createHash("sha256").update(file.compact, "utf8").digest("hex"));
    expect(
      JSON.parse(Buffer.from(file.compact.split(".")[0] ?? "", "base64url").toString("utf8")),
    ).toEqual({ alg: "ES256", typ: "markiro-standalone-license+jws", kid: "test-lic-api" });
    expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
      ok: true,
      kid: "test-lic-api",
      license: {
        version: 1,
        licenseId: file.issuance.licenseId,
        sequence: 1,
        issuer: STANDALONE_TEST_ISSUER,
        tenantId: f.tenantId,
        siteId: f.site.id,
        hostId: f.site.hostId,
        customer: { inn: "7707083893" },
        plan: "subscription",
        planVersionId: f.planVersionId,
        issuedAt: clock.getTime(),
        validFrom: clock.getTime(),
        validUntil: f.endsAt?.getTime(),
        graceDays: 14,
        quotas: preview.next.rights.quotas,
        features: preview.next.rights.features,
        replaces: null,
      },
    });
    expect(file.issuance).toMatchObject({
      sequence: 1,
      siteId: f.site.id,
      hostId: f.site.hostId,
      plan: "subscription",
      validUntilReason: "subscription_end",
      graceDays: 14,
      kid: "test-lic-api",
      sha256: file.sha256,
      issuedByPlatformUserId: f.admin.userId,
      replaces: null,
      rights: preview.next.rights,
    });

    // A transport retry replays the same file; the journal and the audit stay single.
    expect(
      await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        expected: preview.expected,
      }),
    ).toEqual(file);
    expect(await issuance.download(f.admin, f.tenantId, f.site.id, file.issuance.licenseId)).toEqual(
      file,
    );
    expect((await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items).toEqual([
      file.issuance,
    ]);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    const [siteRow] = await db
      .select({ last: schema.standaloneSites.lastIssuedSequence })
      .from(schema.standaloneSites)
      .where(eq(schema.standaloneSites.id, f.site.id));
    expect(siteRow?.last).toBe(1);
    const rows = await auditRows(db, f.tenantId);
    expect(rows.map((row) => row.action)).toEqual([
      "standalone_site.registered",
      "standalone_license.issued",
    ]);
    expect(rows[1]).toEqual({
      actorPlatformUserId: f.admin.userId,
      actorRole: "platform_admin",
      tenantId: f.tenantId,
      action: "standalone_license.issued",
      outcome: "success",
      targetType: "standalone_license",
      targetId: file.issuance.licenseId,
      reason: null,
      requestId,
      before: null,
      after: {
        siteId: f.site.id,
        hostId: f.site.hostId,
        licenseId: file.issuance.licenseId,
        sequence: 1,
        previousSequence: 0,
        replaces: null,
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: preview.next.entitlementRevision,
        validFrom: clock.toISOString(),
        validUntil: f.endsAt?.toISOString(),
        validUntilReason: "subscription_end",
        graceDays: 14,
        kid: "test-lic-api",
        sha256: file.sha256,
        customer: preview.next.customer,
        quotas: preview.next.rights.quotas,
        features: preview.next.rights.features,
        warnings: UNMAPPED,
      },
    });
  });

  it("issues a demo file from a trial subscription with no grace and refuses a grace for it", async () => {
    const endsAt = new Date(Date.now() + 14 * DAY);
    const f = await siteFor({ status: "trial", endsAt });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    expect({
      plan: preview.next.plan,
      graceDays: preview.next.graceDays,
      validUntil: preview.next.validUntil,
      reason: preview.next.validUntilReason,
    }).toEqual({
      plan: "demo",
      graceDays: 0,
      validUntil: endsAt.toISOString(),
      reason: "subscription_end",
    });
    expect(
      await httpRefusal(issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: 3 })),
    ).toEqual({ status: 400, body: { code: "standalone_license_grace_invalid" } });
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: 0,
      expected: preview.expected,
    });
    expect(file.issuance).toMatchObject({ plan: "demo", graceDays: 0 });
  });

  it("cuts validUntil at the first reduction of rights and ignores an increase before it", async () => {
    const f = await siteFor({ endsAt: new Date(Date.now() + 120 * DAY) });
    const temporary = await createPublishedAddon(db, [{ entitlementKey: "stations", increment: 2 }]);
    const growth = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
    const shrinkAt = new Date(clock.getTime() + 30 * DAY);
    await db.insert(schema.subscriptionAddons).values([
      {
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: growth,
        quantity: 1,
        startsAt: new Date(clock.getTime() + 10 * DAY),
        endsAt: null,
        status: "scheduled",
        source: "manual",
      },
      {
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: temporary,
        quantity: 1,
        startsAt: new Date(clock.getTime() - 60_000),
        endsAt: shrinkAt,
        status: "active",
        source: "manual",
      },
    ]);
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    expect(preview.next.rights.quotas).toMatchObject({ stations: 5, lines: 2 });
    expect({
      validUntil: preview.next.validUntil,
      reason: preview.next.validUntilReason,
      boundaryAt: preview.expected.boundaryAt,
    }).toEqual({
      validUntil: shrinkAt.toISOString(),
      reason: "entitlement_reduction",
      boundaryAt: shrinkAt.toISOString(),
    });
  });

  it("orders two concurrent confirmations: one file 1, the other stale; the next issuance replaces it", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    const results = await Promise.allSettled([
      issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        expected: preview.expected,
      }),
      issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        expected: preview.expected,
      }),
    ]);
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictException);
    expect(rejected[0] instanceof ConflictException ? rejected[0].getResponse() : null).toEqual({
      code: "standalone_license_preview_stale",
    });
    const first = fulfilled[0];
    if (!first) throw new Error("no winner");
    expect(first.issuance.sequence).toBe(1);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    expect(
      (await auditRows(db, f.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toHaveLength(1);

    const next = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: 7 });
    expect(next.previous).toEqual(first.issuance);
    expect(next.next).toMatchObject({ sequence: 2, graceDays: 7 });
    expect(next.expected.previousSequence).toBe(1);
    const secondRequest = randomUUID();
    const second = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: secondRequest,
      graceDays: 7,
      expected: next.expected,
    });
    expect(second.issuance).toMatchObject({
      sequence: 2,
      graceDays: 7,
      replaces: first.issuance.licenseId,
    });
    expect(second.fileName).toBe(`markiro-${f.site.hostId.slice(0, 8)}-002.mklic`);
    const issued = (await auditRows(db, f.tenantId)).filter(
      (row) => row.action === "standalone_license.issued",
    );
    expect(issued[1]).toMatchObject({
      targetId: second.issuance.licenseId,
      requestId: secondRequest,
      before: {
        licenseId: first.issuance.licenseId,
        sequence: 1,
        plan: "subscription",
        validUntil: first.issuance.validUntil,
      },
      after: { sequence: 2, previousSequence: 1, replaces: first.issuance.licenseId, graceDays: 7 },
    });
    expect(
      (await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items.map(
        (item) => item.sequence,
      ),
    ).toEqual([2, 1]);
  });

  it("replays one request id confirmed twice at once as one file", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    const body = { requestId: randomUUID(), graceDays: null, expected: preview.expected };
    const [a, b] = await Promise.all([
      issuance.confirm(f.admin, f.tenantId, f.site.id, body),
      issuance.confirm(f.admin, f.tenantId, f.site.id, body),
    ]);
    expect(b).toEqual(a);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    expect(
      await httpRefusal(
        issuance.confirm(f.admin, f.tenantId, f.site.id, { ...body, graceDays: 30 }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
  });

  it("refuses a stale expectation without writing anything", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    for (const expected of [
      { ...preview.expected, entitlementRevision: String(BigInt(preview.expected.entitlementRevision) + 1n) },
      { ...preview.expected, previousSequence: 1 },
      { ...preview.expected, boundaryAt: new Date(clock.getTime() + DAY).toISOString() },
    ]) {
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
    }
    expect(await issuedRows(f.tenantId)).toEqual([]);
    expect(
      (await auditRows(db, f.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toEqual([]);
  });

  it("refuses a non-UUID tenant, no managed subscription, no valid INN and no signing key", async () => {
    const unmanaged = await siteFor({ managed: false });
    expect(
      await httpRefusal(
        issuance.preview(unmanaged.admin, unmanaged.tenantId, unmanaged.site.id, { graceDays: null }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_subscription_required" } });

    const legacy = await siteFor({ tenantId: `legacy-${randomUUID()}` });
    expect(
      await httpRefusal(
        issuance.preview(legacy.admin, legacy.tenantId, legacy.site.id, { graceDays: null }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_tenant_id_unsupported" } });

    const noInn = await siteFor({ org: null });
    expect(
      await httpRefusal(
        issuance.preview(noInn.admin, noInn.tenantId, noInn.site.id, { graceDays: null }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_inn_required" } });

    const billingOnly = await siteFor({ org: null, billing: "7707083893" });
    const fromBilling = await issuance.preview(
      billingOnly.admin,
      billingOnly.tenantId,
      billingOnly.site.id,
      { graceDays: null },
    );
    expect(fromBilling.next.customer).toEqual({ name: "ООО «Завод Тест»", inn: "7707083893" });
    expect(fromBilling.warnings).toEqual([{ code: "customer_inn_from_billing" }, ...UNMAPPED]);

    const crowded = await siteFor({ usage: { stations: 4, cabinetUsers: 1, lines: 1 } });
    expect(
      (await issuance.preview(crowded.admin, crowded.tenantId, crowded.site.id, { graceDays: null }))
        .warnings,
    ).toEqual([{ code: "quota_below_usage", quota: "stations", limit: 3, used: 4 }, ...UNMAPPED]);

    const unsigned = new StandaloneLicenseIssuanceService(db, entitlements, audit, null, now);
    const f = await siteFor();
    const preview = await unsigned.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    expect(
      await httpRefusal(
        unsigned.confirm(f.admin, f.tenantId, f.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          expected: preview.expected,
        }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_signing_unavailable" } });
    expect(await issuedRows(f.tenantId)).toEqual([]);
  });

  it("keeps tenants apart and denies roles without the capability", async () => {
    const a = await siteFor();
    const b = await siteFor();
    const preview = await issuance.preview(a.admin, a.tenantId, a.site.id, { graceDays: null });
    const file = await issuance.confirm(a.admin, a.tenantId, a.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      expected: preview.expected,
    });
    await expect(
      issuance.preview(b.admin, b.tenantId, a.site.id, { graceDays: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      issuance.confirm(b.admin, b.tenantId, a.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        expected: preview.expected,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(issuance.listIssuances(b.admin, b.tenantId, a.site.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      issuance.download(b.admin, b.tenantId, a.site.id, file.issuance.licenseId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      issuance.download(b.admin, b.tenantId, b.site.id, file.issuance.licenseId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await issuedRows(b.tenantId)).toEqual([]);
    expect(
      (await auditRows(db, b.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toEqual([]);

    for (const actor of [await platformActor(db, "support"), await platformActor(db, "accountant")]) {
      await expect(
        issuance.preview(actor, a.tenantId, a.site.id, { graceDays: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        issuance.confirm(actor, a.tenantId, a.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          expected: preview.expected,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(issuance.listIssuances(actor, a.tenantId, a.site.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        issuance.download(actor, a.tenantId, a.site.id, file.issuance.licenseId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(await issuedRows(a.tenantId)).toHaveLength(1);
  });

  it("marks the site for renewal 30 days before validUntil", async () => {
    const f = await siteFor({ endsAt: new Date(Date.now() + 20 * DAY) });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null });
    await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      expected: preview.expected,
    });
    const [site] = (await sites.list(f.admin, f.tenantId)).sites;
    expect(site).toMatchObject({ renewalDue: true, lastIssuedSequence: 1, latestIssuance: { sequence: 1 } });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-issuance.e2e.test.ts
```

Ожидается: FAIL — модуль `standalone-license-issuance.service` не найден.

- [ ] **Step 3: Реализация**

Создать `apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts`:

<!-- prettier-ignore -->
```ts
import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import { STANDALONE_LICENSE_TYP, standaloneLicensePayloadV1Schema } from "@markiro/domain";
import {
  standaloneIssuanceListSchema,
  standaloneIssuancePreviewSchema,
  type PlatformPrincipal,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuanceList,
  type StandaloneIssuancePreview,
  type StandaloneIssuancePreviewRequest,
  type StandaloneIssuanceWarning,
  type StandaloneLicenseFile,
  type StandaloneLicenseRights,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { signCompactJws } from "../../signing/compact-jws";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  findSite,
  readTenantInns,
  requireStandaloneLicenseActor,
  STANDALONE_LICENSE_CLOCK,
  type StandaloneLicenseClock,
} from "./standalone-license-authority";
import {
  STANDALONE_LICENSE_SIGNING,
  type StandaloneLicenseSigningConfiguration,
} from "./standalone-license-keyset";
import {
  exportStandaloneRights,
  licenseValidity,
  type LicenseValidity,
} from "./standalone-license-rights";
import { postgresFailure, standaloneTransaction } from "./standalone-license-transaction";
import {
  issuanceSummary,
  licenseFile,
  siteUsage,
  type StandaloneIssuanceRow,
  type StandaloneSiteRow,
} from "./standalone-license-views";
import { resolveCustomerInn, usageWarnings } from "./standalone-inn-check";

/** Spec §6.2: 14 grace days by default for a subscription, 0 for a demo (plan Д6). */
export const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 14;
/** The payload's tenant id is a lower-case canonical UUID (plan ЛЦ-1); plan Д14. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const stale = () => new ConflictException({ code: "standalone_license_preview_stale" });

/** The payload's `plainText(300)`: no control characters, at most 300 characters (plan Д4). */
function plainName(value: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  return [...printable].slice(0, 300).join("").trim() || "—";
}

interface IssuanceDraft {
  previous: StandaloneIssuanceRow | null;
  plan: "demo" | "subscription";
  planVersionId: string;
  entitlementRevision: string;
  validity: LicenseValidity;
  graceDays: number;
  customer: { name: string; inn: string };
  rights: StandaloneLicenseRights;
  warnings: StandaloneIssuanceWarning[];
}

@Injectable()
export class StandaloneLicenseIssuanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_LICENSE_SIGNING)
    private readonly signing: StandaloneLicenseSigningConfiguration | null,
    @Inject(STANDALONE_LICENSE_CLOCK) private readonly now: StandaloneLicenseClock,
  ) {}

  /** «было → станет» without writing (plan Д7). */
  async preview(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    body: StandaloneIssuancePreviewRequest,
  ): Promise<StandaloneIssuancePreview> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        const { tenant } = await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const now = this.now();
        const draft = await this.draft(tx, site, tenant.name, body.graceDays, now);
        return standaloneIssuancePreviewSchema.parse({
          siteId: site.id,
          hostId: site.hostId,
          previous: draft.previous ? issuanceSummary(draft.previous) : null,
          next: {
            sequence: site.lastIssuedSequence + 1,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: draft.entitlementRevision,
            validFrom: now.toISOString(),
            validUntil: draft.validity.validUntil.toISOString(),
            validUntilReason: draft.validity.reason,
            graceDays: draft.graceDays,
            customer: draft.customer,
            rights: draft.rights,
          },
          warnings: draft.warnings,
          expected: {
            entitlementRevision: draft.entitlementRevision,
            previousSequence: site.lastIssuedSequence,
            boundaryAt: draft.validity.boundaryAt?.toISOString() ?? null,
          },
        });
      },
      "read only",
    );
  }

  /** Spec §6.2 step 3: sequence = last + 1 in the transaction, signature, journal row, audit. */
  async confirm(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    body: StandaloneIssuanceConfirm,
  ): Promise<StandaloneLicenseFile> {
    try {
      return await standaloneTransaction(this.db, async (tx) => {
        const { user, tenant } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
        const site = await findSite(tx, tenantId, siteId);
        const [replay] = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
              eq(schema.standaloneLicenseIssuances.requestId, body.requestId),
            ),
          );
        if (replay) {
          if (
            replay.issuedByPlatformUserId !== user.id ||
            (body.graceDays !== null && body.graceDays !== replay.graceDays)
          )
            throw new ConflictException({ code: "standalone_license_request_conflict" });
          return licenseFile(replay);
        }
        const signing = this.signing;
        if (!signing)
          throw new ConflictException({ code: "standalone_license_signing_unavailable" });
        const now = this.now();
        const draft = await this.draft(tx, site, tenant.name, body.graceDays, now);
        const boundaryAt = draft.validity.boundaryAt?.toISOString() ?? null;
        if (
          body.expected.entitlementRevision !== draft.entitlementRevision ||
          body.expected.previousSequence !== site.lastIssuedSequence ||
          body.expected.boundaryAt !== boundaryAt
        )
          throw stale();
        const sequence = site.lastIssuedSequence + 1;
        const advanced = await tx
          .update(schema.standaloneSites)
          .set({ lastIssuedSequence: sequence, updatedAt: now })
          .where(
            and(
              eq(schema.standaloneSites.tenantId, tenantId),
              eq(schema.standaloneSites.id, site.id),
              eq(schema.standaloneSites.lastIssuedSequence, site.lastIssuedSequence),
            ),
          )
          .returning({ id: schema.standaloneSites.id });
        if (advanced.length !== 1) throw stale();
        const licenseId = randomUUID();
        const payload = standaloneLicensePayloadV1Schema.parse({
          version: 1,
          licenseId,
          sequence,
          issuer: signing.issuer,
          tenantId,
          siteId: site.id,
          hostId: site.hostId,
          customer: draft.customer,
          plan: draft.plan,
          planVersionId: draft.planVersionId,
          entitlementRevision: draft.entitlementRevision,
          issuedAt: now.getTime(),
          validFrom: now.getTime(),
          validUntil: draft.validity.validUntil.getTime(),
          graceDays: draft.graceDays,
          quotas: draft.rights.quotas,
          features: draft.rights.features,
          replaces: draft.previous?.id ?? null,
        });
        const compact = signCompactJws(signing, STANDALONE_LICENSE_TYP, payload);
        const sha256 = createHash("sha256").update(compact, "utf8").digest("hex");
        const [row] = await tx
          .insert(schema.standaloneLicenseIssuances)
          .values({
            id: licenseId,
            tenantId,
            siteId: site.id,
            sequence,
            requestId: body.requestId,
            hostId: site.hostId,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: BigInt(draft.entitlementRevision),
            payload,
            compact,
            sha256,
            kid: signing.kid,
            graceDays: draft.graceDays,
            issuedAt: now,
            validFrom: now,
            validUntil: draft.validity.validUntil,
            validUntilReason: draft.validity.reason,
            replacesId: draft.previous?.id ?? null,
            issuedByPlatformUserId: user.id,
          })
          .returning();
        if (!row) throw new Error("standalone license insert returned no row");
        await this.audit.record(tx, {
          actorPlatformUserId: user.id,
          actorRole: user.role,
          action: "standalone_license.issued",
          outcome: "success",
          tenantId,
          targetType: "standalone_license",
          targetId: licenseId,
          reason: null,
          requestId: body.requestId,
          before: draft.previous
            ? {
                licenseId: draft.previous.id,
                sequence: draft.previous.sequence,
                plan: draft.previous.plan,
                validUntil: draft.previous.validUntil.toISOString(),
              }
            : null,
          after: {
            siteId: site.id,
            hostId: site.hostId,
            licenseId,
            sequence,
            previousSequence: site.lastIssuedSequence,
            replaces: draft.previous?.id ?? null,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: draft.entitlementRevision,
            validFrom: now.toISOString(),
            validUntil: draft.validity.validUntil.toISOString(),
            validUntilReason: draft.validity.reason,
            graceDays: draft.graceDays,
            kid: signing.kid,
            sha256,
            customer: draft.customer,
            quotas: draft.rights.quotas,
            features: draft.rights.features,
            warnings: draft.warnings,
          },
        });
        return licenseFile(row);
      });
    } catch (error) {
      const failure = postgresFailure(error);
      if (
        failure.code === "23505" &&
        failure.constraint === "standalone_license_issuances_site_sequence_uq"
      )
        throw stale();
      throw error;
    }
  }

  async listIssuances(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
  ): Promise<StandaloneIssuanceList> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const rows = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
            ),
          )
          .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
          .limit(1_000);
        return standaloneIssuanceListSchema.parse({
          siteId: site.id,
          items: rows.map((row) => issuanceSummary(row)),
        });
      },
      "read only",
    );
  }

  /** Any issued file again (spec §6.2 step 4); a read, no audit row (plan Д16). */
  async download(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    licenseId: string,
  ): Promise<StandaloneLicenseFile> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const [row] = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
              eq(schema.standaloneLicenseIssuances.id, licenseId),
            ),
          );
        if (!row) throw new NotFoundException();
        return licenseFile(row);
      },
      "read only",
    );
  }

  private async draft(
    tx: SubscriptionTransaction,
    site: StandaloneSiteRow,
    tenantName: string,
    graceDays: number | null,
    now: Date,
  ): Promise<IssuanceDraft> {
    if (!CANONICAL_UUID.test(site.tenantId))
      throw new ConflictException({ code: "standalone_license_tenant_id_unsupported" });
    const snapshotAt = await this.entitlements.loadSnapshotTimeline(site.tenantId, tx);
    const first = (await snapshotAt(now)).snapshot;
    const subscription = first.current.subscription;
    if (first.current.access !== "managed" || !subscription)
      throw new ConflictException({ code: "standalone_license_subscription_required" });
    const plan = subscription.status === "trial" ? "demo" : "subscription";
    const grace = graceDays ?? (plan === "demo" ? 0 : DEFAULT_SUBSCRIPTION_GRACE_DAYS);
    if (plan === "demo" && grace !== 0)
      throw new BadRequestException({ code: "standalone_license_grace_invalid" });
    const exported = exportStandaloneRights(first);
    const validity = await licenseValidity({
      at: now,
      first,
      snapshotAt: async (at) => (await snapshotAt(at)).snapshot,
    });
    const inns = await readTenantInns(tx, site.tenantId);
    const customerInn = resolveCustomerInn({
      orgInn: inns.orgInn,
      billingInn: inns.billingInn,
      siteInn: site.requestInn,
    });
    if (customerInn.inn === null)
      throw new ConflictException({ code: "standalone_license_inn_required" });
    const [previous] = await tx
      .select()
      .from(schema.standaloneLicenseIssuances)
      .where(
        and(
          eq(schema.standaloneLicenseIssuances.tenantId, site.tenantId),
          eq(schema.standaloneLicenseIssuances.siteId, site.id),
        ),
      )
      .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
      .limit(1);
    return {
      previous: previous ?? null,
      plan,
      planVersionId: subscription.planVersionId,
      entitlementRevision: first.revision,
      validity,
      graceDays: grace,
      customer: { name: plainName(inns.billingName ?? tenantName), inn: customerInn.inn },
      rights: exported.rights,
      warnings: [
        ...customerInn.warnings,
        ...usageWarnings(exported.rights, siteUsage(site)),
        ...exported.unmapped.map(
          (feature): StandaloneIssuanceWarning => ({ code: "feature_unmapped", feature }),
        ),
      ],
    };
  }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-license-issuance.e2e.test.ts test/standalone-sites.e2e.test.ts
```

Ожидается: PASS (9 + 5 тестов) при `DATABASE_URL`. Если «cuts validUntil…» падает на вставке `subscription_addons` из-за ограничения, которого нет в схеме при написании (например, обязательный `commercial_period`), — дополнить вставку по ограничению и записать; ожидание (обрезка по границе уменьшения) не менять.

- [ ] **Step 5: Мутации**

Каждую — по схеме «копия → правка → FAIL названного теста → возврат, `cmp` молчит, `shasum` прежний» (`/tmp/claude/before`):

1. В `confirm` убрать строку `body.expected.previousSequence !== site.lastIssuedSequence ||` — FAIL «refuses a stale expectation…» (ожидание `previousSequence: 1` при номере 0 выпустило бы файл). Гонку двух подтверждений держат два независимых барьера (сравнение-с-заменой под `REPEATABLE READ` с повтором и `UNIQUE (site_id, sequence)`), поэтому удаление одного из них тест гонки не роняет — так задумано; это не мутация для убийства.
2. В `draft` заменить `features[key] === true` в `exportStandaloneRights` (файл задачи 5) на `features[key] !== false` — FAIL «issues a subscription file…» (`null`-возможности ушли бы как `true`).
3. В `draft` заменить `subscription.status === "trial" ? "demo" : "subscription"` на `"subscription"` — FAIL «issues a demo file…».

Мутации не коммитить.

- [ ] **Step 6: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts apps/api/test/standalone-license-issuance.e2e.test.ts
git diff --check
```

- [ ] **Step 7: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts apps/api/test/standalone-license-issuance.e2e.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): issue signed standalone offline licenses from entitlements (plan ЛЦ-0)

Preview «before → after» without writing; confirm recomputes, compares the
expectation, advances the site's sequence by compare-and-set, signs the
payload with the license key, journals and audits it; demo from a trial,
validUntil at the subscription end or the first reduction, unmapped
features as false with warnings, any issued file downloadable again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 9: API — маршруты платформы, модуль, подключение, реестр маршрутов и OpenAPI

**Files:**

- Create: `apps/api/src/modules/standalone-licenses/platform-standalone-licenses.controller.ts`, `apps/api/src/modules/standalone-licenses/platform-standalone-licenses.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/platform-route-contracts.ts`, `apps/api/test/platform-contract-openapi.test.ts`, `apps/api/test/subscription-route-inventory.test.ts`
- Test: `apps/api/test/platform-standalone-licenses.routes.test.ts`, `apps/api/test/platform-contract-openapi.test.ts`, `apps/api/test/subscription-route-inventory.test.ts`, `apps/api/test/openapi-coverage.test.ts` (без правок)

**Interfaces:**

- Consumes: `platformStandaloneLicenseContracts` (задача 1); `StandaloneSitesService`, `StandaloneLicenseIssuanceService` (задачи 7–8); `configureStandaloneLicenseSigning`, `STANDALONE_LICENSE_SIGNING` (задача 4); `STANDALONE_LICENSE_CAPABILITIES`, `STANDALONE_LICENSE_CLOCK` (задача 7); `RequirePlatformCapabilities`, `PlatformApiProtectedOk`, `parsePlatformResponse`, `ZodValidationPipe`.
- Produces: `PlatformStandaloneLicensesController` (`list`, `inspect`, `register`, `previewIssuance`, `confirmIssuance`, `listIssuances`, `download`) на `platform/tenants/:tenantId/standalone-sites`; `PlatformStandaloneLicensesModule.forRoot(env)` в платформенной ветке `AppModule`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/api/test/platform-standalone-licenses.routes.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";
import { PlatformStandaloneLicensesController } from "../src/modules/standalone-licenses/platform-standalone-licenses.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";

describe("standalone license platform route policy (plan ЛЦ-0)", () => {
  it("guards every read and mutation with the dedicated capability", () => {
    for (const method of [
      "list",
      "inspect",
      "register",
      "previewIssuance",
      "confirmIssuance",
      "listIssuances",
      "download",
    ] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformStandaloneLicensesController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read", "standaloneLicenses.manage"],
      });
    }
  });
});
```

Правка `apps/api/test/platform-route-contracts.ts`:

Фрагмент 1 (импорт):

<!-- prettier-ignore -->
```ts
  platformDeviceRetentionContracts,
  platformOfflineGrantPolicyContracts,
```

заменить на:

<!-- prettier-ignore -->
```ts
  platformDeviceRetentionContracts,
  platformStandaloneLicenseContracts,
  platformOfflineGrantPolicyContracts,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  route(
    "post",
    "/platform/tenants/{tenantId}/device-licensing/{deviceId}/cancel-reservation",
    "200",
    platformDeviceLicensingContracts.cancelReservation.response,
    { body: platformDeviceLicensingContracts.cancelReservation.body },
  ),
  route("post", "/platform/reports", "201", platformReportContracts.create.response, {
```

заменить на:

<!-- prettier-ignore -->
```ts
  route(
    "post",
    "/platform/tenants/{tenantId}/device-licensing/{deviceId}/cancel-reservation",
    "200",
    platformDeviceLicensingContracts.cancelReservation.response,
    { body: platformDeviceLicensingContracts.cancelReservation.body },
  ),
  route(
    "get",
    "/platform/tenants/{tenantId}/standalone-sites",
    "200",
    platformStandaloneLicenseContracts.list.response,
  ),
  route(
    "post",
    "/platform/tenants/{tenantId}/standalone-sites/inspect",
    "200",
    platformStandaloneLicenseContracts.inspect.response,
    { body: platformStandaloneLicenseContracts.inspect.body },
  ),
  route(
    "post",
    "/platform/tenants/{tenantId}/standalone-sites",
    "200",
    platformStandaloneLicenseContracts.register.response,
    { body: platformStandaloneLicenseContracts.register.body },
  ),
  route(
    "post",
    "/platform/tenants/{tenantId}/standalone-sites/{siteId}/issuances/preview",
    "200",
    platformStandaloneLicenseContracts.previewIssuance.response,
    { body: platformStandaloneLicenseContracts.previewIssuance.body },
  ),
  route(
    "post",
    "/platform/tenants/{tenantId}/standalone-sites/{siteId}/issuances",
    "200",
    platformStandaloneLicenseContracts.confirmIssuance.response,
    { body: platformStandaloneLicenseContracts.confirmIssuance.body },
  ),
  route(
    "get",
    "/platform/tenants/{tenantId}/standalone-sites/{siteId}/issuances",
    "200",
    platformStandaloneLicenseContracts.listIssuances.response,
  ),
  route(
    "get",
    "/platform/tenants/{tenantId}/standalone-sites/{siteId}/issuances/{licenseId}/file",
    "200",
    platformStandaloneLicenseContracts.download.response,
  ),
  route("post", "/platform/reports", "201", platformReportContracts.create.response, {
```

Правка `apps/api/test/platform-contract-openapi.test.ts`:

Фрагмент 1 (импорты, после `PlatformGrantRollbackService`):

<!-- prettier-ignore -->
```ts
import { PlatformGrantRollbackController } from "../src/modules/device-grants/platform-grant-rollback.controller";
import { PlatformGrantRollbackService } from "../src/modules/device-grants/platform-grant-rollback.service";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { PlatformGrantRollbackController } from "../src/modules/device-grants/platform-grant-rollback.controller";
import { PlatformGrantRollbackService } from "../src/modules/device-grants/platform-grant-rollback.service";
import { PlatformStandaloneLicensesController } from "../src/modules/standalone-licenses/platform-standalone-licenses.controller";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import { StandaloneLicenseIssuanceService } from "../src/modules/standalone-licenses/standalone-license-issuance.service";
```

Фрагмент 2 (провайдеры):

<!-- prettier-ignore -->
```ts
    PlatformGrantRollbackService,
    ServicePeriodsService,
    DB,
  ].map((provide) => ({ provide, useValue: {} }));
```

заменить на:

<!-- prettier-ignore -->
```ts
    PlatformGrantRollbackService,
    ServicePeriodsService,
    StandaloneSitesService,
    StandaloneLicenseIssuanceService,
    DB,
  ].map((provide) => ({ provide, useValue: {} }));
```

Фрагмент 3 (контроллеры):

<!-- prettier-ignore -->
```ts
      PlatformGrantActivationController,
      PlatformGrantRollbackController,
    ],
    providers,
```

заменить на:

<!-- prettier-ignore -->
```ts
      PlatformGrantActivationController,
      PlatformGrantRollbackController,
      PlatformStandaloneLicensesController,
    ],
    providers,
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
    expect(CURRENT_SHARED_SCHEMAS).toHaveLength(247);
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(CURRENT_SHARED_SCHEMAS).toHaveLength(258);
```

(+11: семь ответов и четыре тела.)

Правка `apps/api/test/subscription-route-inventory.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  "PlatformGrantActivationController.cancel": platform(
    "offline grant cancellation requires the dedicated platform activation capability",
  ),
```

заменить на:

<!-- prettier-ignore -->
```ts
  "PlatformGrantActivationController.cancel": platform(
    "offline grant cancellation requires the dedicated platform activation capability",
  ),
  "PlatformStandaloneLicensesController.inspect": platform(
    "activation request inspection requires the dedicated standalone license capability",
  ),
  "PlatformStandaloneLicensesController.register": platform(
    "standalone site registration requires the dedicated standalone license capability",
  ),
  "PlatformStandaloneLicensesController.previewIssuance": platform(
    "offline license preview requires the dedicated standalone license capability",
  ),
  "PlatformStandaloneLicensesController.confirmIssuance": platform(
    "offline license issuance requires the dedicated standalone license capability",
  ),
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/platform-standalone-licenses.routes.test.ts test/platform-contract-openapi.test.ts test/subscription-route-inventory.test.ts
```

Ожидается: FAIL — контроллер не найден; OpenAPI — нет маршрутов `standalone-sites`; инвентарь — исключения ссылаются на несуществующие маршруты и `CURRENT_SAAS_ROUTE_KEYS` не совпадает с `AppModule` (инвентарь требует полного окружения API — см. «Заметки для исполнения»; без него он падает до проверок — назвать).

- [ ] **Step 3: Реализация**

Создать `apps/api/src/modules/standalone-licenses/platform-standalone-licenses.controller.ts`:

<!-- prettier-ignore -->
```ts
import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  platformStandaloneLicenseContracts as contracts,
  platformTenantIdSchema,
  platformUuidSchema,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuancePreviewRequest,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { STANDALONE_LICENSE_CAPABILITIES } from "./standalone-license-authority";
import { StandaloneLicenseIssuanceService } from "./standalone-license-issuance.service";
import { StandaloneSitesService } from "./standalone-sites.service";

const tenantParam = new ZodValidationPipe(platformTenantIdSchema);
const uuidParam = new ZodValidationPipe(platformUuidSchema);

/** «Markiro Автоном» sites and their signed offline licenses (spec 2026-10-13 §6.2). */
@ApiTags("platform-standalone-licenses")
@Controller("platform/tenants/:tenantId/standalone-sites")
export class PlatformStandaloneLicensesController {
  constructor(
    private readonly sites: StandaloneSitesService,
    private readonly issuances: StandaloneLicenseIssuanceService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a tenant's standalone sites with their latest offline license" })
  @PlatformApiProtectedOk({ response: contracts.list.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
  ) {
    return parsePlatformResponse(
      contracts.list.response,
      await this.sites.list(request.platformPrincipal, tenantId),
    );
  }

  @Post("inspect")
  @HttpCode(200)
  @ApiOperation({ summary: "Inspect an activation request: INN facts, warnings, host binding" })
  @PlatformApiProtectedOk({ body: contracts.inspect.body, response: contracts.inspect.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async inspect(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.inspect.body)) body: StandaloneSiteInspectRequest,
  ) {
    return parsePlatformResponse(
      contracts.inspect.response,
      await this.sites.inspect(request.platformPrincipal, tenantId, body),
    );
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Register a standalone site or bind a new host id to an existing one" })
  @PlatformApiProtectedOk({ body: contracts.register.body, response: contracts.register.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async register(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.register.body)) body: StandaloneSiteRegister,
  ) {
    return parsePlatformResponse(
      contracts.register.response,
      await this.sites.register(request.platformPrincipal, tenantId, body),
    );
  }

  @Post(":siteId/issuances/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview the next offline license of a site without issuing it" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({
    body: contracts.previewIssuance.body,
    response: contracts.previewIssuance.response,
  })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async previewIssuance(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Body(new ZodValidationPipe(contracts.previewIssuance.body))
    body: StandaloneIssuancePreviewRequest,
  ) {
    return parsePlatformResponse(
      contracts.previewIssuance.response,
      await this.issuances.preview(request.platformPrincipal, tenantId, siteId, body),
    );
  }

  @Post(":siteId/issuances")
  @HttpCode(200)
  @ApiOperation({ summary: "Issue the previewed offline license and return the signed file" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({
    body: contracts.confirmIssuance.body,
    response: contracts.confirmIssuance.response,
  })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async confirmIssuance(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Body(new ZodValidationPipe(contracts.confirmIssuance.body)) body: StandaloneIssuanceConfirm,
  ) {
    return parsePlatformResponse(
      contracts.confirmIssuance.response,
      await this.issuances.confirm(request.platformPrincipal, tenantId, siteId, body),
    );
  }

  @Get(":siteId/issuances")
  @ApiOperation({ summary: "List every offline license issued for a site" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.listIssuances.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async listIssuances(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
  ) {
    return parsePlatformResponse(
      contracts.listIssuances.response,
      await this.issuances.listIssuances(request.platformPrincipal, tenantId, siteId),
    );
  }

  @Get(":siteId/issuances/:licenseId/file")
  @ApiOperation({ summary: "Download an issued offline license file again" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @ApiParam({ name: "licenseId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.download.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async download(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Param("licenseId", uuidParam) licenseId: string,
  ) {
    return parsePlatformResponse(
      contracts.download.response,
      await this.issuances.download(request.platformPrincipal, tenantId, siteId, licenseId),
    );
  }
}
```

Создать `apps/api/src/modules/standalone-licenses/platform-standalone-licenses.module.ts`:

<!-- prettier-ignore -->
```ts
import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { STANDALONE_LICENSE_CLOCK } from "./standalone-license-authority";
import { StandaloneLicenseIssuanceService } from "./standalone-license-issuance.service";
import {
  configureStandaloneLicenseSigning,
  STANDALONE_LICENSE_SIGNING,
} from "./standalone-license-keyset";
import { PlatformStandaloneLicensesController } from "./platform-standalone-licenses.controller";
import { StandaloneSitesService } from "./standalone-sites.service";

/** Registered only alongside the platform auth module; EntitlementsService comes from SubscriptionsModule. */
@Module({})
export class PlatformStandaloneLicensesModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: PlatformStandaloneLicensesModule,
      imports: [PlatformAuditModule],
      controllers: [PlatformStandaloneLicensesController],
      providers: [
        { provide: STANDALONE_LICENSE_SIGNING, useValue: configureStandaloneLicenseSigning(env) },
        { provide: STANDALONE_LICENSE_CLOCK, useValue: () => new Date() },
        StandaloneSitesService,
        StandaloneLicenseIssuanceService,
      ],
    };
  }
}
```

Правка `apps/api/src/app.module.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { PlatformGrantReadinessModule } from "./modules/device-grants/platform-grant-readiness.module";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { PlatformGrantReadinessModule } from "./modules/device-grants/platform-grant-readiness.module";
import { PlatformStandaloneLicensesModule } from "./modules/standalone-licenses/platform-standalone-licenses.module";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
              PlatformGrantReadinessModule.forRoot(env),
              PlatformCatalogModule,
```

заменить на:

<!-- prettier-ignore -->
```ts
              PlatformGrantReadinessModule.forRoot(env),
              PlatformStandaloneLicensesModule.forRoot(env),
              PlatformCatalogModule,
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/platform-standalone-licenses.routes.test.ts test/platform-contract-openapi.test.ts test/subscription-route-inventory.test.ts test/openapi-coverage.test.ts
```

Ожидается: PASS. В OpenAPI ответы маршрутов `standalone-sites` не содержат `secret|session|token|password|totp|recovery`; каждый маршрут защищён cookie платформы; `openapi-coverage` находит у всех семи `@ApiOperation` и описанный ответ.

- [ ] **Step 5: Весь пакет API**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api test
```

Ожидается: зелёный (DB-тесты — при `DATABASE_URL`; пропуски назвать). Падение чужого теста в широком прогоне — записать и разобрать (время, общее состояние базы), а не повторять до зелёного.

- [ ] **Step 6: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api build
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/standalone-licenses/platform-standalone-licenses.controller.ts apps/api/src/modules/standalone-licenses/platform-standalone-licenses.module.ts apps/api/src/app.module.ts apps/api/test/platform-route-contracts.ts apps/api/test/platform-contract-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts apps/api/test/platform-standalone-licenses.routes.test.ts
git diff --check
```

- [ ] **Step 7: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/api/src/modules/standalone-licenses/platform-standalone-licenses.controller.ts apps/api/src/modules/standalone-licenses/platform-standalone-licenses.module.ts apps/api/src/app.module.ts apps/api/test/platform-route-contracts.ts apps/api/test/platform-contract-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts apps/api/test/platform-standalone-licenses.routes.test.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(api): platform routes for standalone sites and offline licenses (plan ЛЦ-0)

platform/tenants/:tenantId/standalone-sites — list, inspect, register,
preview, issue, history, download — behind tenants.read and
standaloneLicenses.manage, in the platform route inventory and OpenAPI.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 10: SaaS-админка — клиент, сохранение `.mklic`, панель площадок с историей во вкладке «Оборудование»

**Files:**

- Create: `apps/saas-admin/src/pages/tenants/standalone-api.ts`, `apps/saas-admin/src/pages/tenants/standalone-download.ts`, `apps/saas-admin/src/pages/tenants/standalone-format.ts`, `apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx`, `apps/saas-admin/src/pages/tenants/StandaloneIssuanceHistory.tsx`, `apps/saas-admin/test/standalone-fixtures.ts`
- Modify: `apps/saas-admin/src/pages/tenants/TenantEquipmentPanel.tsx`, `apps/saas-admin/src/pages/tenants/TenantPage.tsx`, `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json`, `apps/saas-admin/test/render.tsx`, `apps/saas-admin/test/tenant-detail.test.tsx`
- Test: `apps/saas-admin/test/standalone-api.test.ts`, `apps/saas-admin/test/standalone-sites-panel.test.tsx`, `apps/saas-admin/test/tenant-detail.test.tsx`

**Interfaces:**

- Consumes: `platformStandaloneLicenseContracts`, `standaloneSiteInspectRequestSchema`, типы задачи 1, `ENTITLEMENT_QUOTA_KEYS`/`ENTITLEMENT_FEATURE_KEYS` (`@markiro/platform-contracts`); `platformApiFetch`, `ApiRequestError` (`../../api/client.js`); `Alert`, `Button`, `Card`, `Modal`, `StatusChip`, `Table` (`@markiro/ui`).
- Produces: `getStandaloneSites`, `inspectActivationRequest`, `registerStandaloneSite`, `previewStandaloneLicense`, `confirmStandaloneLicense`, `getStandaloneIssuances`, `downloadStandaloneLicense`, `readActivationRequestFile`, `ActivationFileError`, `MAX_ACTIVATION_REQUEST_BYTES`, тип `ActivationRequest` (`standalone-api.ts`); `saveLicenseFile(fileName, compact)` (`standalone-download.ts`); `standaloneSitesKey`, `licensePhase`, `useStandaloneDate`, `standaloneErrorKey`, `standaloneWarningText` (`standalone-format.ts`); `StandaloneSitesPanel({ tenantId })`, `StandaloneIssuanceHistory({ tenantId, site, onClose })`; проп `canManageStandalone` у `TenantEquipmentPanel`; ключи `tenants.detail.standalone.*` (оба языка, в том числе для задачи 11).

- [ ] **Step 1: Фикстуры и падающие тесты**

Создать `apps/saas-admin/test/standalone-fixtures.ts` (чистые данные, без файловой системы — их импортирует и `tools/production-browser`):

<!-- prettier-ignore -->
```ts
import {
  standaloneIssuancePreviewSchema,
  standaloneIssuanceSummarySchema,
  standaloneLicenseFileSchema,
  standaloneSiteInspectionSchema,
  standaloneSiteListSchema,
  standaloneSiteSchema,
} from "@markiro/platform-contracts";

export const STANDALONE_TENANT_ID = "81111111-1111-4111-8111-111111111111";
export const STANDALONE_SITE_ID = "a1111111-1111-4111-8111-111111111111";
export const STANDALONE_HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const STANDALONE_LICENSE_ID = "b1111111-1111-4111-8111-111111111111";
const PLAN_VERSION_ID = "c1111111-1111-4111-8111-111111111111";
const CUSTOMER = { name: "ООО «Первый завод»", inn: "7707083893" };
const RIGHTS = {
  quotas: { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5 },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: false,
    inventory: false,
    commerceMl: false,
    handheld: false,
  },
};

// Far-future dates keep the license phase deterministic whenever the suite runs.
export const STANDALONE_ISSUANCE = standaloneIssuanceSummarySchema.parse({
  licenseId: STANDALONE_LICENSE_ID,
  siteId: STANDALONE_SITE_ID,
  sequence: 1,
  hostId: STANDALONE_HOST_ID,
  plan: "subscription",
  planVersionId: PLAN_VERSION_ID,
  entitlementRevision: "7",
  validFrom: "2099-10-01T09:00:00.000Z",
  validUntil: "2099-11-01T09:00:00.000Z",
  validUntilReason: "subscription_end",
  graceDays: 14,
  kid: "lic-2026-1",
  sha256: "a".repeat(64),
  issuedAt: "2099-10-01T09:00:00.000Z",
  issuedByPlatformUserId: "fixture-admin",
  replaces: null,
  customer: CUSTOMER,
  rights: RIGHTS,
});

export const STANDALONE_SITE = standaloneSiteSchema.parse({
  id: STANDALONE_SITE_ID,
  tenantId: STANDALONE_TENANT_ID,
  hostId: STANDALONE_HOST_ID,
  name: "Цех розлива",
  requestInn: "7707083893",
  hostVersion: "0.3.0",
  usage: { stations: 2, cabinetUsers: 1, lines: 3 },
  requestCreatedAt: "2099-09-30T09:00:00.000Z",
  hostHistory: [
    {
      hostId: STANDALONE_HOST_ID,
      requestInn: "7707083893",
      requestId: "d1111111-1111-4111-8111-111111111111",
      boundAt: "2099-09-30T10:00:00.000Z",
      boundByPlatformUserId: "fixture-admin",
    },
  ],
  lastIssuedSequence: 1,
  latestIssuance: STANDALONE_ISSUANCE,
  renewalDue: true,
  createdAt: "2099-09-30T10:00:00.000Z",
});

export const STANDALONE_SITE_LIST = standaloneSiteListSchema.parse({
  tenantId: STANDALONE_TENANT_ID,
  signingConfigured: true,
  sites: [STANDALONE_SITE],
});

export const STANDALONE_FILE = standaloneLicenseFileSchema.parse({
  issuance: STANDALONE_ISSUANCE,
  fileName: "markiro-3f1c2d4e-001.mklic",
  compact: "eyJhbGciOiJFUzI1NiJ9.eyJ2ZXJzaW9uIjoxfQ.c2lnbmF0dXJl",
  sha256: "a".repeat(64),
});

export const STANDALONE_PREVIEW = standaloneIssuancePreviewSchema.parse({
  siteId: STANDALONE_SITE_ID,
  hostId: STANDALONE_HOST_ID,
  previous: STANDALONE_ISSUANCE,
  next: {
    sequence: 2,
    plan: "subscription",
    planVersionId: PLAN_VERSION_ID,
    entitlementRevision: "8",
    validFrom: "2099-10-20T09:00:00.000Z",
    validUntil: "2100-10-01T09:00:00.000Z",
    validUntilReason: "entitlement_reduction",
    graceDays: 14,
    customer: CUSTOMER,
    rights: {
      quotas: { ...RIGHTS.quotas, stations: 5 },
      features: { ...RIGHTS.features, handheld: true },
    },
  },
  warnings: [
    { code: "quota_below_usage", quota: "lines", limit: 2, used: 3 },
    { code: "feature_unmapped", feature: "chzIntegration" },
  ],
  expected: { entitlementRevision: "8", previousSequence: 1, boundaryAt: "2100-10-01T09:00:00.000Z" },
});

export const STANDALONE_INSPECTION = standaloneSiteInspectionSchema.parse({
  hostId: "e1111111-1111-4111-8111-111111111111",
  hostVersion: "0.3.0",
  organizationName: "ООО «Первый завод»",
  usage: { stations: 2, cabinetUsers: 1, lines: 1 },
  innFacts: { requestInn: "7736207543", orgInn: "7707083893", billingInn: null, trialInn: null },
  warnings: ["request_inn_differs_org"],
  blocking: null,
  registeredSite: null,
});
```

Создать `apps/saas-admin/test/standalone-api.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivationFileError,
  confirmStandaloneLicense,
  downloadStandaloneLicense,
  getStandaloneSites,
  readActivationRequestFile,
} from "../src/pages/tenants/standalone-api.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_LICENSE_ID,
  STANDALONE_PREVIEW,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

const activationText = readFileSync(
  new URL("../../../packages/domain/fixtures/standalone-license/activation-request.json", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("standalone license API client (plan ЛЦ-0)", () => {
  it("calls the tenant's standalone-site routes with validated bodies", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        calls.push({ method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
        if (url.endsWith("/standalone-sites")) return jsonResponse(200, STANDALONE_SITE_LIST);
        return jsonResponse(200, STANDALONE_FILE);
      }),
    );
    await expect(getStandaloneSites(STANDALONE_TENANT_ID)).resolves.toEqual(STANDALONE_SITE_LIST);
    const body = {
      requestId: "f1111111-1111-4111-8111-111111111111",
      graceDays: null,
      expected: STANDALONE_PREVIEW.expected,
    };
    await expect(
      confirmStandaloneLicense(STANDALONE_TENANT_ID, STANDALONE_SITE_ID, body),
    ).resolves.toEqual(STANDALONE_FILE);
    await expect(
      downloadStandaloneLicense(STANDALONE_TENANT_ID, STANDALONE_SITE_ID, STANDALONE_LICENSE_ID),
    ).resolves.toEqual(STANDALONE_FILE);
    const base = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;
    expect(calls).toEqual([
      { method: "GET", url: base, body: null },
      { method: "POST", url: `${base}/${STANDALONE_SITE_ID}/issuances`, body },
      {
        method: "GET",
        url: `${base}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`,
        body: null,
      },
    ]);
  });

  it("reads an activation request file and refuses big, non-JSON and foreign files", async () => {
    await expect(
      readActivationRequestFile(new Blob([activationText], { type: "application/json" })),
    ).resolves.toMatchObject({ format: "markiro-activation-request-v1" });
    for (const [content, reason] of [
      ["x".repeat(64 * 1024 + 1), "too_large"],
      ["{not json", "not_json"],
      [JSON.stringify({ format: "something-else" }), "invalid"],
    ] as const) {
      const error = await readActivationRequestFile(new Blob([content])).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ActivationFileError);
      expect(error instanceof ActivationFileError ? error.reason : null).toBe(reason);
    }
  });

  it("saves the signed line as a .mklic download and releases the object URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_object: Blob | MediaSource) => "blob:license");
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        expect(this.download).toBe(STANDALONE_FILE.fileName);
        expect(this.href).toBe("blob:license");
      });
      saveLicenseFile(STANDALONE_FILE.fileName, STANDALONE_FILE.compact);
      expect(click).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(blob instanceof Blob ? await blob.text() : null).toBe(STANDALONE_FILE.compact);
      expect(document.querySelector("a[download]")).toBeNull();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:license");
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
  });
});
```

Создать `apps/saas-admin/test/standalone-sites-panel.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { StandaloneSitesPanel } from "../src/pages/tenants/StandaloneSitesPanel.js";
import { licensePhase } from "../src/pages/tenants/standalone-format.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_ISSUANCE,
  STANDALONE_LICENSE_ID,
  STANDALONE_SITE,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

vi.mock("../src/pages/tenants/standalone-download.js", () => ({ saveLicenseFile: vi.fn() }));

const BASE = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;

function stubApi(routes: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      const queue = routes[key];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (!next) throw new Error(`Unexpected request: ${key}`);
      return next();
    }),
  );
  return calls;
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
        }
      >
        <ThemeProvider defaultTheme="light">
          <StandaloneSitesPanel tenantId={STANDALONE_TENANT_ID} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(saveLicenseFile).mockReset();
  await i18n.changeLanguage("ru");
});

describe("standalone sites panel (plan ЛЦ-0)", () => {
  it("lists sites with the license phase in words, warns about renewal and downloads from the history", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`GET ${BASE}/${STANDALONE_SITE_ID}/issuances`]: [
        () => jsonResponse(200, { siteId: STANDALONE_SITE_ID, items: [STANDALONE_ISSUANCE] }),
      ],
      [`GET ${BASE}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`]: [
        () => jsonResponse(200, STANDALONE_FILE),
      ],
    });
    renderPanel();

    expect(
      await screen.findByRole("heading", { level: 3, name: "Автоном: площадки и офлайн-лицензии" }),
    ).toBeDefined();
    const row = screen.getByText("Цех розлива").closest("tr");
    if (!row) throw new Error("site row");
    expect(within(row).getByText("3f1c2d4e")).toBeDefined();
    expect(within(row).getByText("Пора продлить")).toBeDefined();
    expect(within(row).getByText(/№ 1 · до/u)).toBeDefined();
    expect(screen.getByText(/Лицензия площадки «Цех розлива» заканчивается/u)).toBeDefined();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "История выпусков" }));
    const dialog = await screen.findByRole("dialog", { name: "История выпусков: Цех розлива" });
    await user.click(await within(dialog).findByRole("button", { name: "Скачать файл № 1" }));
    await vi.waitFor(() =>
      expect(vi.mocked(saveLicenseFile)).toHaveBeenCalledWith(
        "markiro-3f1c2d4e-001.mklic",
        STANDALONE_FILE.compact,
      ),
    );
    expect(calls).toEqual([
      `GET ${BASE}`,
      `GET ${BASE}/${STANDALONE_SITE_ID}/issuances`,
      `GET ${BASE}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`,
    ]);
  });

  it("says when the tenant has no site and license signing is not configured", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(200, { tenantId: STANDALONE_TENANT_ID, signingConfigured: false, sites: [] }),
      ],
    });
    renderPanel();
    expect(
      await screen.findByText("Подпись офлайн-лицензий на сервере не настроена: выпуск недоступен."),
    ).toBeDefined();
    expect(screen.getByText("У клиента нет площадок автонома.")).toBeDefined();
  });

  it("offers a retry when the sites cannot be loaded", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(500, { code: "platform_internal_error" }),
        () => jsonResponse(200, STANDALONE_SITE_LIST),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Не удалось загрузить площадки автонома.")).toBeDefined();
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Цех розлива")).toBeDefined();
  });
});

describe("licensePhase", () => {
  const now = new Date("2099-10-20T00:00:00.000Z");
  it("names a site without a file, a valid one, one due for renewal and an expired one", () => {
    expect(licensePhase({ latestIssuance: null, renewalDue: false }, now)).toBe("none");
    expect(licensePhase({ latestIssuance: STANDALONE_ISSUANCE, renewalDue: false }, now)).toBe("active");
    expect(licensePhase(STANDALONE_SITE, now)).toBe("attention");
    expect(
      licensePhase(STANDALONE_SITE, new Date("2099-11-01T09:00:00.000Z")),
    ).toBe("retired");
  });
});
```

Правка `apps/saas-admin/test/tenant-detail.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Линия розлива")).toBeDefined();
    expect(screen.getByText("ТСД склада")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Текущий тариф" })).toBeNull();
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Линия розлива")).toBeDefined();
    expect(screen.getByText("ТСД склада")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Текущий тариф" })).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Автоном: площадки и офлайн-лицензии" }),
    ).toBeDefined();
    expect(await screen.findByText("У клиента нет площадок автонома.")).toBeDefined();
  });

  it("hides standalone sites from a role without the standalone license capability", async () => {
    installTenantApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=equipment` });

    expect(await screen.findByRole("heading", { name: "Контур оборудования" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Автоном: площадки и офлайн-лицензии" })).toBeNull();
  });
```

Если `SUPPORT_ME` ещё не импортирован в `tenant-detail.test.tsx` — добавить его в импорт из `./render.js`.

Правка `apps/saas-admin/test/render.tsx` (`installTenantApi`):

Фрагмент:

<!-- prettier-ignore -->
```tsx
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
```

заменить на:

<!-- prettier-ignore -->
```tsx
      if (url.endsWith(`/api/platform/tenants/${TENANT_ID}/standalone-sites`) && method === "GET")
        return jsonResponse(200, { tenantId: TENANT_ID, signingConfigured: true, sites: [] });
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/standalone-api.test.ts test/standalone-sites-panel.test.tsx test/tenant-detail.test.tsx
```

Ожидается: FAIL — модули `standalone-api`, `standalone-download`, `StandaloneSitesPanel` не найдены; `tenant-detail` — нет заголовка панели.

- [ ] **Step 3: Реализация**

Создать `apps/saas-admin/src/pages/tenants/standalone-api.ts`:

<!-- prettier-ignore -->
```ts
import {
  platformStandaloneLicenseContracts as contracts,
  platformTenantIdSchema,
  platformUuidSchema,
  standaloneSiteInspectRequestSchema,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuanceList,
  type StandaloneIssuancePreview,
  type StandaloneIssuancePreviewRequest,
  type StandaloneLicenseFile,
  type StandaloneSite,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteInspection,
  type StandaloneSiteList,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type ActivationRequest = StandaloneSiteInspectRequest["request"];
/** An activation request is a few hundred bytes; anything above 64 KiB is not one. */
export const MAX_ACTIVATION_REQUEST_BYTES = 64 * 1024;

export class ActivationFileError extends Error {
  readonly reason: "too_large" | "not_json" | "invalid";
  constructor(reason: "too_large" | "not_json" | "invalid") {
    super(`activation_request_${reason}`);
    this.name = "ActivationFileError";
    this.reason = reason;
  }
}

function platformPath(template: string, params: Record<string, string>): string {
  let path = template.replace(/^\/platform/u, "");
  for (const [name, value] of Object.entries(params))
    path = path.replace(`:${name}`, encodeURIComponent(value));
  return path;
}

function tenant(tenantId: string) {
  return { tenantId: platformTenantIdSchema.parse(tenantId) };
}

function site(tenantId: string, siteId: string) {
  return { ...tenant(tenantId), siteId: platformUuidSchema.parse(siteId) };
}

export function getStandaloneSites(tenantId: string): Promise<StandaloneSiteList> {
  return platformApiFetch(platformPath(contracts.list.path, tenant(tenantId)), {
    responseSchema: contracts.list.response,
  });
}

export function inspectActivationRequest(
  tenantId: string,
  input: StandaloneSiteInspectRequest,
): Promise<StandaloneSiteInspection> {
  return platformApiFetch(platformPath(contracts.inspect.path, tenant(tenantId)), {
    method: contracts.inspect.method,
    responseSchema: contracts.inspect.response,
    body: JSON.stringify(contracts.inspect.body.parse(input)),
  });
}

export function registerStandaloneSite(
  tenantId: string,
  input: StandaloneSiteRegister,
): Promise<StandaloneSite> {
  return platformApiFetch(platformPath(contracts.register.path, tenant(tenantId)), {
    method: contracts.register.method,
    responseSchema: contracts.register.response,
    body: JSON.stringify(contracts.register.body.parse(input)),
  });
}

export function previewStandaloneLicense(
  tenantId: string,
  siteId: string,
  input: StandaloneIssuancePreviewRequest,
): Promise<StandaloneIssuancePreview> {
  return platformApiFetch(platformPath(contracts.previewIssuance.path, site(tenantId, siteId)), {
    method: contracts.previewIssuance.method,
    responseSchema: contracts.previewIssuance.response,
    body: JSON.stringify(contracts.previewIssuance.body.parse(input)),
  });
}

export function confirmStandaloneLicense(
  tenantId: string,
  siteId: string,
  input: StandaloneIssuanceConfirm,
): Promise<StandaloneLicenseFile> {
  return platformApiFetch(platformPath(contracts.confirmIssuance.path, site(tenantId, siteId)), {
    method: contracts.confirmIssuance.method,
    responseSchema: contracts.confirmIssuance.response,
    body: JSON.stringify(contracts.confirmIssuance.body.parse(input)),
  });
}

export function getStandaloneIssuances(
  tenantId: string,
  siteId: string,
): Promise<StandaloneIssuanceList> {
  return platformApiFetch(platformPath(contracts.listIssuances.path, site(tenantId, siteId)), {
    responseSchema: contracts.listIssuances.response,
  });
}

export function downloadStandaloneLicense(
  tenantId: string,
  siteId: string,
  licenseId: string,
): Promise<StandaloneLicenseFile> {
  return platformApiFetch(
    platformPath(contracts.download.path, {
      ...site(tenantId, siteId),
      licenseId: platformUuidSchema.parse(licenseId),
    }),
    { responseSchema: contracts.download.response },
  );
}

/** Reads the host's «Запрос на активацию» file in the browser and validates it before sending. */
export async function readActivationRequestFile(file: Blob): Promise<ActivationRequest> {
  if (file.size > MAX_ACTIVATION_REQUEST_BYTES) throw new ActivationFileError("too_large");
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new ActivationFileError("not_json");
  }
  const parsed = standaloneSiteInspectRequestSchema.shape.request.safeParse(value);
  if (!parsed.success) throw new ActivationFileError("invalid");
  return parsed.data;
}
```

Создать `apps/saas-admin/src/pages/tenants/standalone-download.ts`:

<!-- prettier-ignore -->
```ts
/** Saves the signed license line as a `.mklic` file without leaving the page (plan Д16). */
export function saveLicenseFile(fileName: string, compact: string): void {
  const url = URL.createObjectURL(new Blob([compact], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
```

Создать `apps/saas-admin/src/pages/tenants/standalone-format.ts`:

<!-- prettier-ignore -->
```ts
import { useTranslation } from "react-i18next";
import type { TagPhase } from "@markiro/ui";
import type { StandaloneIssuanceWarning, StandaloneSite } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";

export const standaloneSitesKey = (tenantId: string) =>
  ["platform", "tenants", tenantId, "standalone-sites"] as const;

/** The latest file's phase; the tone follows the phase only (tag vocabulary). */
export function licensePhase(
  site: Pick<StandaloneSite, "latestIssuance" | "renewalDue">,
  now: Date,
): TagPhase {
  if (!site.latestIssuance) return "none";
  if (Date.parse(site.latestIssuance.validUntil) <= now.getTime()) return "retired";
  return site.renewalDue ? "attention" : "active";
}

export function useStandaloneDate(): (value: string) => string {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("en") ? "en-GB" : "ru-RU";
  return (value) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(
      new Date(value),
    );
}

const KNOWN_ERRORS = new Set([
  "standalone_site_warnings_unacknowledged",
  "standalone_site_host_taken",
  "standalone_site_host_registered",
  "standalone_site_host_unchanged",
  "standalone_site_request_conflict",
  "standalone_site_history_full",
  "standalone_license_preview_stale",
  "standalone_license_subscription_required",
  "standalone_license_inn_required",
  "standalone_license_signing_unavailable",
  "standalone_license_request_conflict",
  "standalone_license_grace_invalid",
  "standalone_license_tenant_id_unsupported",
]);

export function standaloneErrorKey(error: unknown): string {
  return error instanceof ApiRequestError && error.code !== null && KNOWN_ERRORS.has(error.code)
    ? `tenants.detail.standalone.errors.${error.code}`
    : "tenants.detail.standalone.errors.generic";
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function standaloneWarningText(t: Translate, warning: StandaloneIssuanceWarning): string {
  const prefix = "tenants.detail.standalone.warnings";
  switch (warning.code) {
    case "customer_inn_from_billing":
      return t(`${prefix}.customer_inn_from_billing`);
    case "billing_inn_differs":
      return t(`${prefix}.billing_inn_differs`, { billingInn: warning.billingInn });
    case "site_inn_differs":
      return t(`${prefix}.site_inn_differs`, {
        siteInn: warning.siteInn ?? t("tenants.detail.standalone.noValue"),
      });
    case "quota_below_usage":
      return t(`${prefix}.quota_below_usage`, {
        quota: t(`entitlements.quotas.${warning.quota}`),
        limit: warning.limit,
        used: warning.used,
      });
    case "feature_unmapped":
      return t(`${prefix}.feature_unmapped`, {
        feature: t(`entitlements.features.${warning.feature}`),
      });
  }
}
```

Создать `apps/saas-admin/src/pages/tenants/StandaloneIssuanceHistory.tsx`:

<!-- prettier-ignore -->
```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Button, Modal, Table, type TableColumn } from "@markiro/ui";
import type { StandaloneIssuanceSummary, StandaloneSite } from "@markiro/platform-contracts";

import { downloadStandaloneLicense, getStandaloneIssuances } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import { standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";

export function StandaloneIssuanceHistory({
  tenantId,
  site,
  onClose,
}: {
  tenantId: string;
  site: StandaloneSite;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const query = useQuery({
    queryKey: [...standaloneSitesKey(tenantId), site.id, "issuances"],
    queryFn: () => getStandaloneIssuances(tenantId, site.id),
  });
  const download = useMutation({
    mutationFn: (licenseId: string) => downloadStandaloneLicense(tenantId, site.id, licenseId),
    onSuccess: (file) => saveLicenseFile(file.fileName, file.compact),
  });
  const columns: TableColumn<StandaloneIssuanceSummary>[] = [
    {
      key: "sequence",
      title: t("tenants.detail.standalone.history.sequence"),
      mono: true,
      render: (row) => row.sequence,
    },
    {
      key: "plan",
      title: t("tenants.detail.standalone.history.plan"),
      render: (row) => t(`tenants.detail.standalone.plan.${row.plan}`),
    },
    {
      key: "validUntil",
      title: t("tenants.detail.standalone.history.validUntil"),
      render: (row) => formatDate(row.validUntil),
    },
    {
      key: "graceDays",
      title: t("tenants.detail.standalone.history.graceDays"),
      mono: true,
      render: (row) => row.graceDays,
    },
    { key: "kid", title: t("tenants.detail.standalone.history.kid"), mono: true, render: (row) => row.kid },
    {
      key: "sha256",
      title: t("tenants.detail.standalone.history.sha256"),
      mono: true,
      render: (row) => row.sha256.slice(0, 12),
    },
    {
      key: "download",
      title: t("tenants.detail.standalone.history.download"),
      render: (row) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("tenants.detail.standalone.history.downloadLabel", { sequence: row.sequence })}
          disabled={download.isPending}
          onClick={() => download.mutate(row.licenseId)}
        >
          {t("tenants.detail.standalone.history.download")}
        </Button>
      ),
    },
  ];
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.history.title", { name: site.name })}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.history.close")}
    >
      {download.isError ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.history.downloadError")}
        </Alert>
      ) : null}
      {query.isPending ? (
        <p role="status">{t("tenants.detail.standalone.loading")}</p>
      ) : !query.data ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.loadError")}
        </Alert>
      ) : (
        <Table
          columns={columns}
          rows={query.data.items}
          getRowKey={(row) => row.licenseId}
          empty={t("tenants.detail.standalone.history.empty")}
          scrollLabel={t("tenants.detail.standalone.history.scrollLabel")}
        />
      )}
    </Modal>
  );
}
```

Создать `apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type { StandaloneSite } from "@markiro/platform-contracts";

import { getStandaloneSites } from "./standalone-api.js";
import { licensePhase, standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";
import { StandaloneIssuanceHistory } from "./StandaloneIssuanceHistory.js";

/** «Автоном: площадки и офлайн-лицензии» (spec 2026-10-13 §6.2). */
export function StandaloneSitesPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const query = useQuery({
    queryKey: standaloneSitesKey(tenantId),
    queryFn: () => getStandaloneSites(tenantId),
  });
  const [historyFor, setHistoryFor] = useState<StandaloneSite | null>(null);
  const now = new Date();
  const columns: TableColumn<StandaloneSite>[] = [
    { key: "name", title: t("tenants.detail.standalone.columns.name"), render: (site) => site.name },
    {
      key: "host",
      title: t("tenants.detail.standalone.columns.host"),
      mono: true,
      render: (site) => site.hostId.slice(0, 8),
    },
    {
      key: "inn",
      title: t("tenants.detail.standalone.columns.inn"),
      mono: true,
      render: (site) => site.requestInn ?? t("tenants.detail.standalone.noValue"),
    },
    {
      key: "license",
      title: t("tenants.detail.standalone.columns.license"),
      wrap: true,
      render: (site) => {
        const phase = licensePhase(site, now);
        return (
          <span className="standalone-license-cell">
            <StatusChip phase={phase} label={t(`tenants.detail.standalone.phase.${phase}`)} />{" "}
            {site.latestIssuance ? (
              <span>
                {t("tenants.detail.standalone.licenseLine", {
                  sequence: site.latestIssuance.sequence,
                  validUntil: formatDate(site.latestIssuance.validUntil),
                })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "actions",
      title: t("tenants.detail.standalone.columns.actions"),
      render: (site) => (
        <span className="standalone-site-actions">
          <Button variant="secondary" size="compact" onClick={() => setHistoryFor(site)}>
            {t("tenants.detail.standalone.history.open")}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <Card title={t("tenants.detail.standalone.title")} titleAs="h3" className="standalone-sites-panel">
      <p>{t("tenants.detail.standalone.description")}</p>
      {query.isPending ? (
        <p role="status">{t("tenants.detail.standalone.loading")}</p>
      ) : !query.data ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t("tenants.detail.standalone.retry")}
            </Button>
          }
        >
          {t("tenants.detail.standalone.loadError")}
        </Alert>
      ) : (
        <>
          {!query.data.signingConfigured ? (
            <Alert tone="info">{t("tenants.detail.standalone.signingUnavailable")}</Alert>
          ) : null}
          {query.data.sites
            .filter((site) => licensePhase(site, now) === "attention")
            .map((site) => (
              <Alert key={`renewal-${site.id}`} tone="warn">
                {t("tenants.detail.standalone.renewalDue", {
                  name: site.name,
                  validUntil: site.latestIssuance ? formatDate(site.latestIssuance.validUntil) : "",
                })}
              </Alert>
            ))}
          <Table
            columns={columns}
            rows={query.data.sites}
            getRowKey={(site) => site.id}
            empty={t("tenants.detail.standalone.empty")}
            scrollLabel={t("tenants.detail.standalone.scrollLabel")}
          />
        </>
      )}
      {historyFor ? (
        <StandaloneIssuanceHistory
          tenantId={tenantId}
          site={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
    </Card>
  );
}
```

Правка `apps/saas-admin/src/pages/tenants/TenantEquipmentPanel.tsx` — заменить файл целиком:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { DeviceLicensingPanel } from "./DeviceLicensingPanel.js";
import { StandaloneSitesPanel } from "./StandaloneSitesPanel.js";

export function TenantEquipmentPanel({
  tenantId,
  canWrite,
  canManageStandalone,
}: {
  tenantId: string;
  canWrite: boolean;
  canManageStandalone: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="tenant-equipment-workspace" aria-labelledby="tenant-equipment-title">
      <header className="tenant-equipment-workspace__header">
        <p>{t("tenants.detail.equipment.eyebrow")}</p>
        <h2 id="tenant-equipment-title">{t("tenants.detail.equipment.title")}</h2>
        <span>{t("tenants.detail.equipment.description")}</span>
      </header>
      <DeviceLicensingPanel tenantId={tenantId} canWrite={canWrite} />
      {canManageStandalone ? <StandaloneSitesPanel tenantId={tenantId} /> : null}
    </section>
  );
}
```

Правка `apps/saas-admin/src/pages/tenants/TenantPage.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
          <TenantEquipmentPanel
            tenantId={detail.tenant.id}
            canWrite={
              principal.capabilities.includes("tenants.write") &&
              principal.capabilities.includes("billing.write")
            }
          />
```

заменить на:

<!-- prettier-ignore -->
```tsx
          <TenantEquipmentPanel
            tenantId={detail.tenant.id}
            canWrite={
              principal.capabilities.includes("tenants.write") &&
              principal.capabilities.includes("billing.write")
            }
            canManageStandalone={principal.capabilities.includes("standaloneLicenses.manage")}
          />
```

Правка `apps/saas-admin/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "equipment": {
        "eyebrow": "ОПЕРАЦИИ / ОБОРУДОВАНИЕ",
        "title": "Контур оборудования",
        "description": "Рабочие устройства, лицензионные места и подготовленные изменения в одном операционном представлении."
      },
```

заменить на:

<!-- prettier-ignore -->
```json
      "equipment": {
        "eyebrow": "ОПЕРАЦИИ / ОБОРУДОВАНИЕ",
        "title": "Контур оборудования",
        "description": "Рабочие устройства, лицензионные места и подготовленные изменения в одном операционном представлении."
      },
      "standalone": {
        "title": "Автоном: площадки и офлайн-лицензии",
        "description": "Площадки «Markiro Автоном» клиента и подписанные файлы лицензий, выгруженные из его прав.",
        "loading": "Загружаем площадки автонома…",
        "loadError": "Не удалось загрузить площадки автонома.",
        "retry": "Повторить",
        "empty": "У клиента нет площадок автонома.",
        "signingUnavailable": "Подпись офлайн-лицензий на сервере не настроена: выпуск недоступен.",
        "scrollLabel": "Площадки автонома",
        "noValue": "—",
        "columns": {
          "name": "Площадка",
          "host": "Хост",
          "inn": "ИНН запроса",
          "license": "Лицензия",
          "actions": "Действия"
        },
        "licenseLine": "№ {{sequence}} · до {{validUntil}}",
        "phase": {
          "none": "Не выпускалась",
          "active": "Действует",
          "attention": "Пора продлить",
          "retired": "Истекла"
        },
        "plan": { "demo": "Демо", "subscription": "Подписка" },
        "renewalDue": "Лицензия площадки «{{name}}» заканчивается {{validUntil}} — выпустите продление.",
        "history": {
          "open": "История выпусков",
          "title": "История выпусков: {{name}}",
          "close": "Закрыть",
          "scrollLabel": "Выданные файлы лицензии",
          "sequence": "№",
          "plan": "Вид",
          "validUntil": "Действует до",
          "graceDays": "Льгота, дн.",
          "kid": "Ключ",
          "sha256": "SHA-256",
          "download": "Скачать",
          "downloadLabel": "Скачать файл № {{sequence}}",
          "empty": "Файлы ещё не выпускались.",
          "downloadError": "Не удалось скачать файл лицензии."
        },
        "register": {
          "open": "Добавить площадку из запроса активации",
          "title": "Площадка из запроса активации",
          "drop": "Перетащите файл запроса или нажмите",
          "dropHint": "Файл «Запрос на активацию» из раздела «Лицензия» автонома, JSON до 64 КиБ",
          "fileErrors": {
            "too_large": "Файл больше 64 КиБ — это не запрос активации.",
            "not_json": "Файл не читается как JSON.",
            "invalid": "Файл не похож на запрос активации автонома."
          },
          "facts": {
            "host": "Хост",
            "version": "Версия",
            "organization": "Организация",
            "requestInn": "ИНН запроса",
            "orgInn": "ИНН в профиле организации",
            "billingInn": "ИНН платёжного профиля",
            "usage": "Используется: станций и ТСД {{stations}}, пользователей офиса {{cabinetUsers}}, линий {{lines}}"
          },
          "warningsTitle": "Расхождения ИНН",
          "mode": {
            "label": "Что сделать с запросом",
            "create": "Новая площадка",
            "rebind": "Новый хост площадки «{{name}}»"
          },
          "name": "Название площадки",
          "acknowledge": "Расхождения проверены, площадку можно привязать",
          "submit": "Добавить площадку",
          "submitRebind": "Привязать новый хост",
          "cancel": "Отмена",
          "blocking": {
            "host_registered": "Этот хост уже привязан к площадке «{{name}}» этого клиента.",
            "host_taken": "Этот хост уже привязан к площадке другого клиента."
          }
        },
        "issue": {
          "open": "Выпустить офлайн-лицензию",
          "title": "Выпуск офлайн-лицензии: {{name}}",
          "graceDays": "Льготный срок, дней",
          "graceHint": "Пусто — по умолчанию: 14 для подписки, 0 для демо. Допустимо 0–60.",
          "graceInvalid": "Целое число от 0 до 60.",
          "preview": "Предпросмотр",
          "confirm": "Подтвердить и скачать",
          "cancel": "Закрыть",
          "comparison": "Было → станет",
          "before": "Было",
          "after": "Станет",
          "none": "—",
          "unlimited": "без ограничения",
          "enabled": "включено",
          "disabled": "выключено",
          "unmapped": "нет сопоставления",
          "belowUsage": "меньше использования",
          "row": {
            "sequence": "Номер файла",
            "plan": "Вид",
            "validUntil": "Действует до (не включительно)",
            "graceDays": "Льготный срок, дней"
          },
          "reason": {
            "subscription_end": "конец подписки",
            "entitlement_reduction": "ближайшее уменьшение прав",
            "one_year_cap": "предел в один год"
          },
          "issued": "Файл № {{sequence}} выпущен и скачан."
        },
        "warnings": {
          "request_inn_missing": "В запросе нет ИНН организации.",
          "request_inn_invalid": "ИНН в запросе не проходит проверку контрольной суммы.",
          "org_inn_missing": "В профиле организации клиента нет верного ИНН.",
          "request_inn_differs_org": "ИНН запроса не совпадает с ИНН в профиле организации клиента.",
          "request_inn_differs_billing": "ИНН запроса не совпадает с ИНН платёжного профиля.",
          "trial_inn_differs": "Пробный период автонома начат на другой ИНН.",
          "customer_inn_from_billing": "В профиле организации нет ИНН — в лицензию пойдёт ИНН платёжного профиля.",
          "billing_inn_differs": "ИНН платёжного профиля ({{billingInn}}) отличается от ИНН в профиле организации.",
          "site_inn_differs": "ИНН запроса площадки ({{siteInn}}) отличается от ИНН лицензии — хост такой файл отвергнет.",
          "quota_below_usage": "{{quota}}: в лицензии {{limit}}, а на площадке уже {{used}} — новые не подключатся.",
          "feature_unmapped": "«{{feature}}» в тарифе не сопоставлена — в файл пойдёт «выключено»."
        },
        "errors": {
          "standalone_site_warnings_unacknowledged": "Расхождения изменились — проверьте их заново.",
          "standalone_site_host_taken": "Этот хост уже привязан к площадке другого клиента.",
          "standalone_site_host_registered": "Этот хост уже привязан к площадке этого клиента.",
          "standalone_site_host_unchanged": "У площадки уже этот хост.",
          "standalone_site_request_conflict": "Запрос уже выполнен с другими данными — откройте окно заново.",
          "standalone_site_history_full": "У площадки слишком длинная история хостов.",
          "standalone_license_preview_stale": "Права или выпуски площадки изменились — посмотрите предпросмотр заново.",
          "standalone_license_subscription_required": "У клиента нет действующей подписки на тариф — выпуск невозможен.",
          "standalone_license_inn_required": "Нет верного ИНН клиента: укажите его в профиле организации или в платёжном профиле.",
          "standalone_license_signing_unavailable": "Подпись офлайн-лицензий на сервере не настроена.",
          "standalone_license_request_conflict": "Этот выпуск уже подтверждён с другими данными — посмотрите предпросмотр заново.",
          "standalone_license_grace_invalid": "Для демо льготный срок — 0 дней.",
          "standalone_license_tenant_id_unsupported": "Идентификатор клиента не в формате UUID — офлайн-лицензию для него выпустить нельзя.",
          "generic": "Операция не выполнена. Повторите."
        }
      },
```

Правка `apps/saas-admin/src/i18n/en.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "equipment": {
        "eyebrow": "OPERATIONS / EQUIPMENT",
        "title": "Equipment operations",
        "description": "Working devices, licensed slots, and prepared changes in one operational view."
      },
```

заменить на:

<!-- prettier-ignore -->
```json
      "equipment": {
        "eyebrow": "OPERATIONS / EQUIPMENT",
        "title": "Equipment operations",
        "description": "Working devices, licensed slots, and prepared changes in one operational view."
      },
      "standalone": {
        "title": "Standalone: sites and offline licenses",
        "description": "The tenant's «Markiro Standalone» sites and the signed license files exported from its entitlements.",
        "loading": "Loading standalone sites…",
        "loadError": "Could not load standalone sites.",
        "retry": "Retry",
        "empty": "The tenant has no standalone sites.",
        "signingUnavailable": "Offline license signing is not configured on the server: issuing is unavailable.",
        "scrollLabel": "Standalone sites",
        "noValue": "—",
        "columns": {
          "name": "Site",
          "host": "Host",
          "inn": "Request INN",
          "license": "License",
          "actions": "Actions"
        },
        "licenseLine": "No. {{sequence}} · until {{validUntil}}",
        "phase": {
          "none": "Never issued",
          "active": "Valid",
          "attention": "Renew soon",
          "retired": "Expired"
        },
        "plan": { "demo": "Demo", "subscription": "Subscription" },
        "renewalDue": "The license of site «{{name}}» ends {{validUntil}} — issue a renewal.",
        "history": {
          "open": "Issuance history",
          "title": "Issuance history: {{name}}",
          "close": "Close",
          "scrollLabel": "Issued license files",
          "sequence": "No.",
          "plan": "Kind",
          "validUntil": "Valid until",
          "graceDays": "Grace, days",
          "kid": "Key",
          "sha256": "SHA-256",
          "download": "Download",
          "downloadLabel": "Download file No. {{sequence}}",
          "empty": "No files issued yet.",
          "downloadError": "Could not download the license file."
        },
        "register": {
          "open": "Add a site from an activation request",
          "title": "Site from an activation request",
          "drop": "Drop the request file or click",
          "dropHint": "The «Activation request» file from the standalone «License» section, JSON up to 64 KiB",
          "fileErrors": {
            "too_large": "The file is larger than 64 KiB — not an activation request.",
            "not_json": "The file is not readable JSON.",
            "invalid": "The file does not look like a standalone activation request."
          },
          "facts": {
            "host": "Host",
            "version": "Version",
            "organization": "Organization",
            "requestInn": "Request INN",
            "orgInn": "Organization profile INN",
            "billingInn": "Billing profile INN",
            "usage": "In use: stations and handhelds {{stations}}, office users {{cabinetUsers}}, lines {{lines}}"
          },
          "warningsTitle": "INN mismatches",
          "mode": {
            "label": "What to do with the request",
            "create": "New site",
            "rebind": "New host for site «{{name}}»"
          },
          "name": "Site name",
          "acknowledge": "Mismatches checked, the site may be bound",
          "submit": "Add site",
          "submitRebind": "Bind the new host",
          "cancel": "Cancel",
          "blocking": {
            "host_registered": "This host is already bound to site «{{name}}» of this tenant.",
            "host_taken": "This host is already bound to another tenant's site."
          }
        },
        "issue": {
          "open": "Issue offline license",
          "title": "Issue an offline license: {{name}}",
          "graceDays": "Grace period, days",
          "graceHint": "Empty — the default: 14 for a subscription, 0 for a demo. Allowed 0–60.",
          "graceInvalid": "A whole number from 0 to 60.",
          "preview": "Preview",
          "confirm": "Confirm and download",
          "cancel": "Close",
          "comparison": "Before → after",
          "before": "Before",
          "after": "After",
          "none": "—",
          "unlimited": "unlimited",
          "enabled": "on",
          "disabled": "off",
          "unmapped": "not mapped",
          "belowUsage": "below usage",
          "row": {
            "sequence": "File number",
            "plan": "Kind",
            "validUntil": "Valid until (exclusive)",
            "graceDays": "Grace period, days"
          },
          "reason": {
            "subscription_end": "subscription end",
            "entitlement_reduction": "next reduction of rights",
            "one_year_cap": "one-year cap"
          },
          "issued": "File No. {{sequence}} issued and downloaded."
        },
        "warnings": {
          "request_inn_missing": "The request has no organization INN.",
          "request_inn_invalid": "The request INN fails the checksum.",
          "org_inn_missing": "The tenant's organization profile has no valid INN.",
          "request_inn_differs_org": "The request INN differs from the organization profile INN.",
          "request_inn_differs_billing": "The request INN differs from the billing profile INN.",
          "trial_inn_differs": "The standalone trial started under another INN.",
          "customer_inn_from_billing": "The organization profile has no INN — the license takes the billing profile INN.",
          "billing_inn_differs": "The billing profile INN ({{billingInn}}) differs from the organization profile INN.",
          "site_inn_differs": "The site's request INN ({{siteInn}}) differs from the license INN — the host will refuse the file.",
          "quota_below_usage": "{{quota}}: the license allows {{limit}}, the site already uses {{used}} — new ones will not connect.",
          "feature_unmapped": "«{{feature}}» is not mapped in the plan — the file carries «off»."
        },
        "errors": {
          "standalone_site_warnings_unacknowledged": "The mismatches changed — check them again.",
          "standalone_site_host_taken": "This host is already bound to another tenant's site.",
          "standalone_site_host_registered": "This host is already bound to a site of this tenant.",
          "standalone_site_host_unchanged": "The site already has this host.",
          "standalone_site_request_conflict": "This request was already done with other data — reopen the dialog.",
          "standalone_site_history_full": "The site's host history is too long.",
          "standalone_license_preview_stale": "The site's rights or issuances changed — preview again.",
          "standalone_license_subscription_required": "The tenant has no current plan subscription — nothing to issue.",
          "standalone_license_inn_required": "No valid tenant INN: set it in the organization or billing profile.",
          "standalone_license_signing_unavailable": "Offline license signing is not configured on the server.",
          "standalone_license_request_conflict": "This issuance was already confirmed with other data — preview again.",
          "standalone_license_grace_invalid": "A demo has a grace period of 0 days.",
          "standalone_license_tenant_id_unsupported": "The tenant id is not a UUID — no offline license can be issued for it.",
          "generic": "The operation failed. Retry."
        }
      },
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/standalone-api.test.ts test/standalone-sites-panel.test.tsx test/tenant-detail.test.tsx test/device-licensing.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/standalone-sites-panel.test.tsx --reporter=verbose
```

Ожидается: PASS; в выводе `--reporter=verbose` нет `stderr |` (предупреждений `act` и утечек после разборки).

- [ ] **Step 5: Гейты**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run lint
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/saas-admin/src/pages/tenants/standalone-api.ts apps/saas-admin/src/pages/tenants/standalone-download.ts apps/saas-admin/src/pages/tenants/standalone-format.ts apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx apps/saas-admin/src/pages/tenants/StandaloneIssuanceHistory.tsx apps/saas-admin/src/pages/tenants/TenantEquipmentPanel.tsx apps/saas-admin/src/pages/tenants/TenantPage.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/standalone-fixtures.ts apps/saas-admin/test/standalone-api.test.ts apps/saas-admin/test/standalone-sites-panel.test.tsx apps/saas-admin/test/render.tsx apps/saas-admin/test/tenant-detail.test.tsx
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/saas-admin/src/pages/tenants/standalone-api.ts apps/saas-admin/src/pages/tenants/standalone-download.ts apps/saas-admin/src/pages/tenants/standalone-format.ts apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx apps/saas-admin/src/pages/tenants/StandaloneIssuanceHistory.tsx apps/saas-admin/src/pages/tenants/TenantEquipmentPanel.tsx apps/saas-admin/src/pages/tenants/TenantPage.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/standalone-fixtures.ts apps/saas-admin/test/standalone-api.test.ts apps/saas-admin/test/standalone-sites-panel.test.tsx apps/saas-admin/test/render.tsx apps/saas-admin/test/tenant-detail.test.tsx
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(saas-admin): standalone sites panel with issuance history (plan ЛЦ-0)

The tenant's equipment tab lists «Markiro Автоном» sites with the latest
license phase in words, a renewal reminder 30 days ahead, the issuance
history and a .mklic download of any issued file; visible with
standaloneLicenses.manage only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 11: SaaS-админка — «Добавить площадку из запроса активации» и «Выпустить офлайн-лицензию»

**Files:**

- Create: `apps/saas-admin/src/pages/tenants/StandaloneSiteRegistration.tsx`, `apps/saas-admin/src/pages/tenants/StandaloneLicenseIssue.tsx`, `apps/saas-admin/src/pages/tenants/StandaloneLicenseComparison.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx`
- Test: `apps/saas-admin/test/standalone-license-flows.test.tsx`

**Interfaces:**

- Consumes: клиент и помощники задачи 10 (`inspectActivationRequest`, `registerStandaloneSite`, `readActivationRequestFile`, `ActivationFileError`, `previewStandaloneLicense`, `confirmStandaloneLicense`, `saveLicenseFile`, `standaloneSitesKey`, `standaloneErrorKey`, `standaloneWarningText`, `useStandaloneDate`); `ApiRequestError`; `ENTITLEMENT_QUOTA_KEYS`, `ENTITLEMENT_FEATURE_KEYS` (`@markiro/platform-contracts`, равны ключам файла по тесту ЛЦ-1); `Alert`, `Badge`, `Button`, `Checkbox`, `FileDropZone`, `Input`, `Modal`, `RadioGroup` (`@markiro/ui`).
- Produces: `StandaloneSiteRegistration({ tenantId, sites, onClose })`, `StandaloneLicenseIssue({ tenantId, site, onClose })`, `StandaloneLicenseComparison({ preview })`; кнопки «Добавить площадку из запроса активации» (заголовок панели) и «Выпустить офлайн-лицензию» (строка площадки, недоступна без подписи на сервере).

- [ ] **Step 1: Написать падающий тест**

Создать `apps/saas-admin/test/standalone-license-flows.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { standaloneSiteInspectRequestSchema } from "@markiro/platform-contracts";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { StandaloneSitesPanel } from "../src/pages/tenants/StandaloneSitesPanel.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_INSPECTION,
  STANDALONE_PREVIEW,
  STANDALONE_SITE,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

vi.mock("../src/pages/tenants/standalone-download.js", () => ({ saveLicenseFile: vi.fn() }));

const BASE = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;
const REQUEST_ID = "f1111111-1111-4111-8111-111111111111";
const activationText = readFileSync(
  new URL("../../../packages/domain/fixtures/standalone-license/activation-request.json", import.meta.url),
  "utf8",
);
const activationRequest = standaloneSiteInspectRequestSchema.shape.request.parse(
  JSON.parse(activationText),
);

type Call = { key: string; body: unknown };

function stubApi(routes: Record<string, Array<() => Response>>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push({ key, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      const queue = routes[key];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (!next) throw new Error(`Unexpected request: ${key}`);
      return next();
    }),
  );
  return calls;
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
        }
      >
        <ThemeProvider defaultTheme="light">
          <StandaloneSitesPanel tenantId={STANDALONE_TENANT_ID} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function activationFile(content = activationText): File {
  return new File([content], "activation-request.json", { type: "application/json" });
}

async function siteRow(): Promise<HTMLElement> {
  const row = (await screen.findByText("Цех розлива")).closest("tr");
  if (!row) throw new Error("site row");
  return row;
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(saveLicenseFile).mockReset();
  await i18n.changeLanguage("ru");
});

describe("standalone site registration (plan ЛЦ-0)", () => {
  it("registers a site after the operator acknowledges the INN mismatch", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [() => jsonResponse(200, STANDALONE_INSPECTION)],
      [`POST ${BASE}`]: [
        () =>
          jsonResponse(200, {
            ...STANDALONE_SITE,
            id: "a2222222-2222-4222-8222-222222222222",
            hostId: STANDALONE_INSPECTION.hostId,
            name: "Склад",
            latestIssuance: null,
            renewalDue: false,
            lastIssuedSequence: 0,
          }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    await user.upload(within(dialog).getByTestId("file-drop-input"), activationFile());

    expect(
      await within(dialog).findByText("ИНН запроса не совпадает с ИНН в профиле организации клиента."),
    ).toBeDefined();
    const submit = within(dialog).getByRole("button", { name: "Добавить площадку" });
    await user.type(within(dialog).getByLabelText("Название площадки"), "Склад");
    expect(submit).toHaveProperty("disabled", true);
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Расхождения проверены, площадку можно привязать",
      }),
    );
    expect(submit).toHaveProperty("disabled", false);
    await user.click(submit);

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: `POST ${BASE}/inspect`, body: { request: activationRequest } },
      {
        key: `POST ${BASE}`,
        body: {
          intent: "create",
          requestId: REQUEST_ID,
          name: "Склад",
          request: activationRequest,
          acknowledgedWarnings: ["request_inn_differs_org"],
        },
      },
    ]);
    expect(calls.filter((call) => call.key === `GET ${BASE}`)).toHaveLength(2);
  });

  it("refuses an unreadable file locally and a host bound elsewhere without a way to submit", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [
        () => jsonResponse(200, { ...STANDALONE_INSPECTION, warnings: [], blocking: "host_taken" }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    const input = within(dialog).getByTestId("file-drop-input");

    await user.upload(input, activationFile("{not json"));
    expect(await within(dialog).findByText("Файл не читается как JSON.")).toBeDefined();
    expect(calls.some((call) => call.key === `POST ${BASE}/inspect`)).toBe(false);

    await user.upload(input, activationFile());
    expect(
      await within(dialog).findByText("Этот хост уже привязан к площадке другого клиента."),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Добавить площадку" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).queryByLabelText("Название площадки")).toBeNull();
  });

  it("binds a new host id to an existing site", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [() => jsonResponse(200, { ...STANDALONE_INSPECTION, warnings: [] })],
      [`POST ${BASE}`]: [
        () => jsonResponse(200, { ...STANDALONE_SITE, hostId: STANDALONE_INSPECTION.hostId }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    await user.upload(within(dialog).getByTestId("file-drop-input"), activationFile());
    await user.click(
      await within(dialog).findByRole("radio", { name: "Новый хост площадки «Цех розлива»" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Привязать новый хост" }));

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((call) => call.key === `POST ${BASE}`)?.body).toEqual({
      intent: "rebind",
      requestId: REQUEST_ID,
      siteId: STANDALONE_SITE_ID,
      request: activationRequest,
      acknowledgedWarnings: [],
    });
  });
});

describe("offline license issuance (plan ЛЦ-0)", () => {
  const PREVIEW = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances/preview`;
  const CONFIRM = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances`;

  it("previews «before → after» with highlights, confirms with the preview's expectation and downloads", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const issued = {
      ...STANDALONE_FILE,
      issuance: { ...STANDALONE_FILE.issuance, sequence: 2 },
      fileName: "markiro-3f1c2d4e-002.mklic",
    };
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [() => jsonResponse(200, STANDALONE_PREVIEW)],
      [CONFIRM]: [() => jsonResponse(200, issued)],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await siteRow()).getByRole("button", { name: "Выпустить офлайн-лицензию" }));
    const dialog = await screen.findByRole("dialog", { name: "Выпуск офлайн-лицензии: Цех розлива" });
    expect(within(dialog).getByRole("button", { name: "Подтвердить и скачать" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));

    const table = await within(dialog).findByRole("table", { name: "Было → станет" });
    const stations = within(table).getByRole("row", { name: /Станции и ТСД/u });
    expect(within(stations).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["3", "5"]);
    expect(within(within(table).getByRole("row", { name: /Линии/u })).getByText("меньше использования")).toBeDefined();
    expect(
      within(within(table).getByRole("row", { name: /Честный знак/u })).getByText("нет сопоставления"),
    ).toBeDefined();
    expect(
      within(dialog).getByText("Линии: в лицензии 2, а на площадке уже 3 — новые не подключатся."),
    ).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));
    expect(await within(dialog).findByText("Файл № 2 выпущен и скачан.")).toBeDefined();
    expect(vi.mocked(saveLicenseFile)).toHaveBeenCalledWith(
      "markiro-3f1c2d4e-002.mklic",
      STANDALONE_FILE.compact,
    );
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: null } },
      {
        key: CONFIRM,
        body: { requestId: REQUEST_ID, graceDays: null, expected: STANDALONE_PREVIEW.expected },
      },
    ]);
  });

  it("sends the typed grace period, refuses an invalid one locally and asks for a new preview when stale", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [() => jsonResponse(200, STANDALONE_PREVIEW)],
      [CONFIRM]: [() => jsonResponse(409, { code: "standalone_license_preview_stale" })],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await siteRow()).getByRole("button", { name: "Выпустить офлайн-лицензию" }));
    const dialog = await screen.findByRole("dialog", { name: "Выпуск офлайн-лицензии: Цех розлива" });
    const grace = within(dialog).getByLabelText("Льготный срок, дней");

    await user.type(grace, "61");
    expect(within(dialog).getByText("Целое число от 0 до 60.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Предпросмотр" })).toHaveProperty("disabled", true);
    await user.clear(grace);
    await user.type(grace, "7");
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    await within(dialog).findByRole("table", { name: "Было → станет" });
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));

    expect(
      await within(dialog).findByText(
        "Права или выпуски площадки изменились — посмотрите предпросмотр заново.",
      ),
    ).toBeDefined();
    expect(within(dialog).queryByRole("table", { name: "Было → станет" })).toBeNull();
    expect(vi.mocked(saveLicenseFile)).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: 7 } },
      { key: CONFIRM, body: { requestId: REQUEST_ID, graceDays: 7, expected: STANDALONE_PREVIEW.expected } },
    ]);
  });

  it("does not offer issuing while license signing is not configured", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, { ...STANDALONE_SITE_LIST, signingConfigured: false })],
    });
    renderPanel();
    expect(
      within(await siteRow()).getByRole("button", { name: "Выпустить офлайн-лицензию" }),
    ).toHaveProperty("disabled", true);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/standalone-license-flows.test.tsx
```

Ожидается: FAIL — нет кнопок «Добавить площадку из запроса активации» и «Выпустить офлайн-лицензию».

- [ ] **Step 3: Реализация**

Создать `apps/saas-admin/src/pages/tenants/StandaloneLicenseComparison.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
import { Badge } from "@markiro/ui";
import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_QUOTA_KEYS,
  type StandaloneIssuancePreview,
} from "@markiro/platform-contracts";

import { useStandaloneDate } from "./standalone-format.js";

/** «Было → станет» in the look of EntitlementPreviewComparison (plan Д15). */
export function StandaloneLicenseComparison({ preview }: { preview: StandaloneIssuancePreview }) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const before = preview.previous;
  const after = preview.next;
  const prefix = "tenants.detail.standalone";
  const none = t(`${prefix}.issue.none`);
  const quota = (value: number | null) =>
    value === null ? t(`${prefix}.issue.unlimited`) : String(value);
  const flag = (value: boolean) => t(`${prefix}.issue.${value ? "enabled" : "disabled"}`);
  const unmapped = new Set(
    preview.warnings.flatMap((warning) =>
      warning.code === "feature_unmapped" ? [warning.feature] : [],
    ),
  );
  const belowUsage = new Set(
    preview.warnings.flatMap((warning) =>
      warning.code === "quota_below_usage" ? [warning.quota] : [],
    ),
  );
  return (
    <table className="entitlement-preview-comparison">
      <caption>{t(`${prefix}.issue.comparison`)}</caption>
      <thead>
        <tr>
          <th scope="col">{t("entitlements.effects")}</th>
          <th scope="col">{t(`${prefix}.issue.before`)}</th>
          <th scope="col">{t(`${prefix}.issue.after`)}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.sequence`)}</th>
          <td>{before ? before.sequence : none}</td>
          <td>{after.sequence}</td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.plan`)}</th>
          <td>{before ? t(`${prefix}.plan.${before.plan}`) : none}</td>
          <td>{t(`${prefix}.plan.${after.plan}`)}</td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.validUntil`)}</th>
          <td>{before ? formatDate(before.validUntil) : none}</td>
          <td>
            {formatDate(after.validUntil)} ({t(`${prefix}.issue.reason.${after.validUntilReason}`)})
          </td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.graceDays`)}</th>
          <td>{before ? before.graceDays : none}</td>
          <td>{after.graceDays}</td>
        </tr>
        {ENTITLEMENT_QUOTA_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.quotas.${key}`)}</th>
            <td>{before ? quota(before.rights.quotas[key]) : none}</td>
            <td>
              {quota(after.rights.quotas[key])}
              {belowUsage.has(key) ? (
                <>
                  {" "}
                  <Badge tone="warn">{t(`${prefix}.issue.belowUsage`)}</Badge>
                </>
              ) : null}
            </td>
          </tr>
        ))}
        {ENTITLEMENT_FEATURE_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.features.${key}`)}</th>
            <td>{before ? flag(before.rights.features[key]) : none}</td>
            <td>
              {flag(after.rights.features[key])}
              {unmapped.has(key) ? (
                <>
                  {" "}
                  <Badge tone="warn">{t(`${prefix}.issue.unmapped`)}</Badge>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Создать `apps/saas-admin/src/pages/tenants/StandaloneLicenseIssue.tsx`:

<!-- prettier-ignore -->
```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, Modal } from "@markiro/ui";
import type { StandaloneSite } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { confirmStandaloneLicense, previewStandaloneLicense } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import {
  standaloneErrorKey,
  standaloneSitesKey,
  standaloneWarningText,
} from "./standalone-format.js";
import { StandaloneLicenseComparison } from "./StandaloneLicenseComparison.js";

/** Spec §6.2 steps 2–3: preview «before → after», then confirm and download the `.mklic`. */
export function StandaloneLicenseIssue({
  tenantId,
  site,
  onClose,
}: {
  tenantId: string;
  site: StandaloneSite;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const translate = (key: string, options: Record<string, unknown> = {}) => t(key, options);
  const queryClient = useQueryClient();
  const [grace, setGrace] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [issuedSequence, setIssuedSequence] = useState<number | null>(null);
  const graceDays = grace.trim() === "" ? null : Number(grace.trim());
  const graceValid =
    graceDays === null || (Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 60);
  const preview = useMutation({
    mutationFn: () => previewStandaloneLicense(tenantId, site.id, { graceDays }),
    onSuccess: () => {
      setRequestId(crypto.randomUUID());
      setIssuedSequence(null);
    },
  });
  const confirm = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error("preview required");
      return confirmStandaloneLicense(tenantId, site.id, {
        requestId,
        graceDays,
        expected: preview.data.expected,
      });
    },
    onSuccess: async (file) => {
      saveLicenseFile(file.fileName, file.compact);
      setIssuedSequence(file.issuance.sequence);
      preview.reset();
      await queryClient.invalidateQueries({ queryKey: standaloneSitesKey(tenantId) });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === "standalone_license_preview_stale")
        preview.reset();
    },
  });
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.issue.title", { name: site.name })}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.issue.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("tenants.detail.standalone.issue.cancel")}
          </Button>
          <Button
            variant="secondary"
            disabled={!graceValid || preview.isPending}
            onClick={() => {
              confirm.reset();
              preview.mutate();
            }}
          >
            {t("tenants.detail.standalone.issue.preview")}
          </Button>
          <Button disabled={!preview.data || confirm.isPending} onClick={() => confirm.mutate()}>
            {t("tenants.detail.standalone.issue.confirm")}
          </Button>
        </>
      }
    >
      <Input
        label={t("tenants.detail.standalone.issue.graceDays")}
        hint={t("tenants.detail.standalone.issue.graceHint")}
        inputMode="numeric"
        value={grace}
        onChange={(event) => {
          setGrace(event.target.value);
          preview.reset();
        }}
        {...(graceValid ? {} : { error: t("tenants.detail.standalone.issue.graceInvalid") })}
      />
      {issuedSequence !== null ? (
        <Alert tone="ok" role="status">
          {t("tenants.detail.standalone.issue.issued", { sequence: issuedSequence })}
        </Alert>
      ) : null}
      {preview.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(preview.error))}
        </Alert>
      ) : null}
      {confirm.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(confirm.error))}
        </Alert>
      ) : null}
      {preview.data ? (
        <>
          {preview.data.warnings.length ? (
            <Alert tone="warn">
              <ul>
                {preview.data.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>{standaloneWarningText(translate, warning)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <StandaloneLicenseComparison preview={preview.data} />
        </>
      ) : null}
    </Modal>
  );
}
```

Создать `apps/saas-admin/src/pages/tenants/StandaloneSiteRegistration.tsx`:

<!-- prettier-ignore -->
```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, FileDropZone, Input, Modal, RadioGroup } from "@markiro/ui";
import type { StandaloneSite, StandaloneSiteInspection } from "@markiro/platform-contracts";

import {
  ActivationFileError,
  inspectActivationRequest,
  readActivationRequestFile,
  registerStandaloneSite,
  type ActivationRequest,
} from "./standalone-api.js";
import { standaloneErrorKey, standaloneSitesKey } from "./standalone-format.js";

const CREATE = "create";

/** Spec §6.2 step 1 and §6.3: a site from an activation request, or a new host id for a site. */
export function StandaloneSiteRegistration({
  tenantId,
  sites,
  onClose,
}: {
  tenantId: string;
  sites: readonly StandaloneSite[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<ActivationRequest | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [fileError, setFileError] = useState<ActivationFileError["reason"] | null>(null);
  const [mode, setMode] = useState(CREATE);
  const [name, setName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const inspect = useMutation({
    mutationFn: (value: ActivationRequest) => inspectActivationRequest(tenantId, { request: value }),
  });
  const inspection: StandaloneSiteInspection | undefined = inspect.data;
  const register = useMutation({
    mutationFn: () => {
      if (!request || !inspection) throw new Error("activation request required");
      return mode === CREATE
        ? registerStandaloneSite(tenantId, {
            intent: "create",
            requestId,
            name: name.trim(),
            request,
            acknowledgedWarnings: inspection.warnings,
          })
        : registerStandaloneSite(tenantId, {
            intent: "rebind",
            requestId,
            siteId: mode,
            request,
            acknowledgedWarnings: inspection.warnings,
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: standaloneSitesKey(tenantId) });
      onClose();
    },
  });
  const readFile = async (file: File) => {
    setFileError(null);
    setRequest(null);
    setAcknowledged(false);
    inspect.reset();
    register.reset();
    try {
      const value = await readActivationRequestFile(file);
      setRequest(value);
      setRequestId(crypto.randomUUID());
      inspect.mutate(value);
    } catch (error) {
      setFileError(error instanceof ActivationFileError ? error.reason : "invalid");
    }
  };
  const noValue = t("tenants.detail.standalone.noValue");
  const canSubmit =
    inspection !== undefined &&
    inspection.blocking === null &&
    (inspection.warnings.length === 0 || acknowledged) &&
    (mode !== CREATE || name.trim() !== "") &&
    !register.isPending;
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.register.title")}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.register.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("tenants.detail.standalone.register.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => register.mutate()}>
            {mode === CREATE
              ? t("tenants.detail.standalone.register.submit")
              : t("tenants.detail.standalone.register.submitRebind")}
          </Button>
        </>
      }
    >
      <FileDropZone
        label={t("tenants.detail.standalone.register.drop")}
        hint={t("tenants.detail.standalone.register.dropHint")}
        ariaLabel={t("tenants.detail.standalone.register.drop")}
        accept=".json,application/json"
        busy={inspect.isPending}
        onFile={(file) => void readFile(file)}
      />
      {fileError ? (
        <Alert tone="error" role="alert">
          {t(`tenants.detail.standalone.register.fileErrors.${fileError}`)}
        </Alert>
      ) : null}
      {inspect.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(inspect.error))}
        </Alert>
      ) : null}
      {inspection ? (
        <>
          <dl className="tenant-facts">
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.host")}</dt>
              <dd className="mono">{inspection.hostId}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.version")}</dt>
              <dd>{inspection.hostVersion ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.organization")}</dt>
              <dd>{inspection.organizationName ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.requestInn")}</dt>
              <dd className="mono">{inspection.innFacts.requestInn ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.orgInn")}</dt>
              <dd className="mono">{inspection.innFacts.orgInn ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.billingInn")}</dt>
              <dd className="mono">{inspection.innFacts.billingInn ?? noValue}</dd>
            </div>
          </dl>
          <p>{t("tenants.detail.standalone.register.facts.usage", inspection.usage)}</p>
          {inspection.blocking ? (
            <Alert tone="error" role="alert">
              {t(`tenants.detail.standalone.register.blocking.${inspection.blocking}`, {
                name: inspection.registeredSite?.name ?? "",
              })}
            </Alert>
          ) : (
            <>
              {inspection.warnings.length ? (
                <Alert tone="warn" title={t("tenants.detail.standalone.register.warningsTitle")}>
                  <ul>
                    {inspection.warnings.map((code) => (
                      <li key={code}>{t(`tenants.detail.standalone.warnings.${code}`)}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <RadioGroup
                label={t("tenants.detail.standalone.register.mode.label")}
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: CREATE, label: t("tenants.detail.standalone.register.mode.create") },
                  ...sites.map((site) => ({
                    value: site.id,
                    label: t("tenants.detail.standalone.register.mode.rebind", { name: site.name }),
                  })),
                ]}
              />
              {mode === CREATE ? (
                <Input
                  label={t("tenants.detail.standalone.register.name")}
                  value={name}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                />
              ) : null}
              {inspection.warnings.length ? (
                <Checkbox
                  label={t("tenants.detail.standalone.register.acknowledge")}
                  checked={acknowledged}
                  onCheckedChange={setAcknowledged}
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
      {register.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(register.error))}
        </Alert>
      ) : null}
    </Modal>
  );
}
```

Правка `apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { getStandaloneSites } from "./standalone-api.js";
import { licensePhase, standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";
import { StandaloneIssuanceHistory } from "./StandaloneIssuanceHistory.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { getStandaloneSites } from "./standalone-api.js";
import { licensePhase, standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";
import { StandaloneIssuanceHistory } from "./StandaloneIssuanceHistory.js";
import { StandaloneLicenseIssue } from "./StandaloneLicenseIssue.js";
import { StandaloneSiteRegistration } from "./StandaloneSiteRegistration.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const [historyFor, setHistoryFor] = useState<StandaloneSite | null>(null);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [historyFor, setHistoryFor] = useState<StandaloneSite | null>(null);
  const [issuingFor, setIssuingFor] = useState<StandaloneSite | null>(null);
  const [registering, setRegistering] = useState(false);
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        <span className="standalone-site-actions">
          <Button variant="secondary" size="compact" onClick={() => setHistoryFor(site)}>
            {t("tenants.detail.standalone.history.open")}
          </Button>
        </span>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        <span className="standalone-site-actions">
          <Button
            size="compact"
            disabled={!query.data?.signingConfigured}
            onClick={() => setIssuingFor(site)}
          >
            {t("tenants.detail.standalone.issue.open")}
          </Button>{" "}
          <Button variant="secondary" size="compact" onClick={() => setHistoryFor(site)}>
            {t("tenants.detail.standalone.history.open")}
          </Button>
        </span>
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    <Card title={t("tenants.detail.standalone.title")} titleAs="h3" className="standalone-sites-panel">
```

заменить на:

<!-- prettier-ignore -->
```tsx
    <Card
      title={t("tenants.detail.standalone.title")}
      titleAs="h3"
      className="standalone-sites-panel"
      actions={
        <Button variant="secondary" disabled={!query.data} onClick={() => setRegistering(true)}>
          {t("tenants.detail.standalone.register.open")}
        </Button>
      }
    >
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
      {historyFor ? (
        <StandaloneIssuanceHistory
          tenantId={tenantId}
          site={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
    </Card>
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {historyFor ? (
        <StandaloneIssuanceHistory
          tenantId={tenantId}
          site={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
      {issuingFor ? (
        <StandaloneLicenseIssue
          tenantId={tenantId}
          site={issuingFor}
          onClose={() => setIssuingFor(null)}
        />
      ) : null}
      {registering && query.data ? (
        <StandaloneSiteRegistration
          tenantId={tenantId}
          sites={query.data.sites}
          onClose={() => setRegistering(false)}
        />
      ) : null}
    </Card>
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/standalone-license-flows.test.tsx test/standalone-sites-panel.test.tsx --reporter=verbose
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin test
```

Ожидается: PASS; в `--reporter=verbose` нет `stderr |`; весь пакет зелёный.

- [ ] **Step 5: Гейты и сборка**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin build
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/saas-admin/src/pages/tenants/StandaloneSiteRegistration.tsx apps/saas-admin/src/pages/tenants/StandaloneLicenseIssue.tsx apps/saas-admin/src/pages/tenants/StandaloneLicenseComparison.tsx apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx apps/saas-admin/test/standalone-license-flows.test.tsx
git diff --check
```

- [ ] **Step 6: Коммит**

<!-- prettier-ignore -->
```bash
git add apps/saas-admin/src/pages/tenants/StandaloneSiteRegistration.tsx apps/saas-admin/src/pages/tenants/StandaloneLicenseIssue.tsx apps/saas-admin/src/pages/tenants/StandaloneLicenseComparison.tsx apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx apps/saas-admin/test/standalone-license-flows.test.tsx
cat > /tmp/claude/lc0-commit.txt <<'EOF'
feat(saas-admin): register standalone sites and issue offline licenses (plan ЛЦ-0)

An activation request file shows host, version and INN facts with the
mismatches to acknowledge, then binds a new site or a new host id; issuing
previews «before → after» (below-usage quotas and unmapped features marked),
confirms with the preview's expectation and downloads the .mklic.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

### Task 12: Браузерная проверка вкладки «Оборудование», памятка ключа лицензий, §24 спецификации

**Files:**

- Create: `docs/operations/standalone-licenses.md`
- Modify: `tools/production-browser/tenant-equipment-tests/fixture.ts`, `tools/production-browser/tenant-equipment-tests/workspace.spec.ts`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Test: `tools/production-browser/tenant-equipment-tests/workspace.spec.ts`, `tools/production-browser/tenant-equipment-tests/replacement.spec.ts` (без правок)

**Interfaces:**

- Consumes: `STANDALONE_SITE_LIST` (`apps/saas-admin/test/standalone-fixtures.ts`, задача 10); собранный `apps/saas-admin/dist`.
- Produces: фикстура набора `tenant-equipment` отвечает на `GET /api/platform/tenants/:id/standalone-sites` (иначе её строгий перехват `unhandled` роняет оба сценария, потому что `platform_admin` теперь видит панель); сценарий проверяет панель на 1440 и 390 px в обоих языках; памятка оператора; §24.

- [ ] **Step 1: Убедиться, что набор падает без фикстуры**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin build
pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile
pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config tenant-equipment.playwright.config.ts
```

(без песочницы: Chromium и `vite preview` на порту 43187). Ожидается: FAIL обоих файлов — «Every API request must be explicitly intercepted» с `GET /api/platform/tenants/81111111-…/standalone-sites`. Это и есть доказательство, что правка SaaS-админки задела `production-bundle`.

- [ ] **Step 2: Фикстура и сценарий**

Правка `tools/production-browser/tenant-equipment-tests/fixture.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import {
  factualObservation,
  preview,
} from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import {
  factualObservation,
  preview,
} from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
import { STANDALONE_SITE_LIST } from "../../../apps/saas-admin/test/standalone-fixtures.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing/retention` &&
        method === "GET"
      ) {
```

заменить на:

<!-- prettier-ignore -->
```ts
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/standalone-sites` &&
        method === "GET"
      ) {
        json = STANDALONE_SITE_LIST;
      } else if (
        url.pathname === `/api/platform/tenants/${TENANT_ID}/device-licensing/retention` &&
        method === "GET"
      ) {
```

Правка `tools/production-browser/tenant-equipment-tests/workspace.spec.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
      await expect(page.getByText("Линия розлива 1")).toBeVisible();
      await expect(page.getByText(ru ? "3 устройства" : "3 devices")).toBeVisible();
```

заменить на:

<!-- prettier-ignore -->
```ts
      await expect(page.getByText("Линия розлива 1")).toBeVisible();
      await expect(page.getByText(ru ? "3 устройства" : "3 devices")).toBeVisible();
      await expect(
        page.getByRole("heading", {
          level: 3,
          name: ru ? "Автоном: площадки и офлайн-лицензии" : "Standalone: sites and offline licenses",
        }),
      ).toBeVisible();
      await expect(page.getByRole("cell", { name: "Цех розлива", exact: true })).toBeVisible();
      await expect(page.getByText(ru ? "Пора продлить" : "Renew soon", { exact: true })).toBeVisible();
```

- [ ] **Step 3: Убедиться, что набор проходит**

<!-- prettier-ignore -->
```bash
pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config tenant-equipment.playwright.config.ts
```

Ожидается: PASS всех сценариев `workspace.spec.ts` (4) и `replacement.spec.ts`; `noPageOverflow` на 390 px держится (таблица площадок прокручивается внутри своей области). Если на 390 px переполняет кнопка в заголовке карточки — это дефект вёрстки панели: исправить в `StandaloneSitesPanel.tsx` средствами `@markiro/ui` (перенос действий), а не ослаблять проверку; записать в «Отклонения». Скриншоты в `tools/production-browser/test-results/tenant-equipment` не коммитить.

- [ ] **Step 4: Памятка оператора**

Создать `docs/operations/standalone-licenses.md`:

<!-- prettier-ignore -->
````markdown
# Офлайн-лицензии «Markiro Автоном»: ключ и выпуск

Спецификация: `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (§4–§6, §24).
Выпуск — SaaS-админка, страница клиента → «Оборудование» → «Автоном: площадки и офлайн-лицензии»
(возможность `standaloneLicenses.manage`, только `platform_admin`).

## Ключ лицензий

Ключ свой, не ключ офлайн-грантов: API не стартует, если открытый ключ лицензий совпадает с ключом
набора грантов. Все четыре переменные задаются вместе или не задаются вовсе; без них API работает,
а подтверждение выпуска отвечает `409 standalone_license_signing_unavailable`.

| Переменная                           | Что                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `STANDALONE_LICENSE_ISSUER`          | канонический origin API; тот же `origin`, что в наборе ключей и в `trust-keys.json` автонома |
| `STANDALONE_LICENSE_KID`             | `kid` действующего ключа; есть в наборе и не в `retiredKids`                                 |
| `STANDALONE_LICENSE_PRIVATE_KEY_PEM` | закрытый ключ P-256 PKCS#8; переводы строк можно записать как `\n` (одна строка Lockbox)     |
| `STANDALONE_LICENSE_KEYSET_JSON`     | `{protocol:"standalone-license-v1",origin,revision,keys:[{kid,jwk}],retiredKids:[]}`, только открытые ключи |

В Yandex Lockbox четыре ключа — одна необязательная группа (`deploy/yandex/runtime-env.mjs`): все
четыре есть или ни одного; частичная группа останавливает обновление окружения.

Порядок включения: (1) владелец создаёт пару ключей на своей машине; (2) открытый JWK с `kid` и
`origin` попадает в `apps/standalone/proto/fixtures/trust-keys.json` и выходит в сборке автонома;
(3) только после этого четыре значения кладутся в Lockbox и разворачивается API. Файл, подписанный
ключом, которого нет в сборке площадки, хост отвергает (`license_unknown_key`).

## Ротация и компрометация

Новый открытый ключ — сначала в сборку автонома, затем в `STANDALONE_LICENSE_KEYSET_JSON` вместе со
старым, затем `STANDALONE_LICENSE_KID` переключается на новый. Старый `kid` уходит в `retiredKids`
только после перевыпуска всех действующих файлов: журнал выдачи (`standalone_license_issuances.kid`)
показывает, какие файлы каким ключом подписаны. Компрометация — сборка автонома без старого `kid` и
перевыпуск действующих файлов; пока площадка не обновилась, она доверяет старому ключу (офлайн иначе
нельзя).

## Что берётся в файл

- Квоты и возможности — кандидат снимка прав клиента; несопоставленная возможность (`null`) уходит
  как «выключено» и подсвечена в предпросмотре.
- `demo` — при подписке `trial` (льготный срок 0), иначе `subscription` (по умолчанию 14 дней, 0–60).
- `validUntil` — конец подписки, ближайшее уменьшение прав или год от выпуска, что раньше.
- ИНН — из профиля организации клиента, а если его нет — из текущего платёжного профиля
  (предупреждение). Без верного ИНН выпуск невозможен.
- Выпуск требует действующей подписки на тариф. Клиенту без кабинета подписку на тариф сейчас не
  оформить (`catalog_kind_not_allowed_for_offline_tenant`) — это ограничение облака, решение за
  владельцем.
- Идентификатор клиента должен быть UUID (так создаёт клиентов платформа): клиенту из старой
  кабинетной регистрации выпуск отвечает `standalone_license_tenant_id_unsupported`.

## Площадка с новым хостом

Переустановка без копии даёт новый `hostId`: оператор загружает новый запрос активации и выбирает
«Новый хост площадки …» — история площадки сохраняет все `hostId`, номера файлов продолжаются.
````

- [ ] **Step 5: §24 спецификации**

В конец `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` дописать (если §18–§23 других планов ещё нет — всё равно §24, номера закреплены распределением):

<!-- prettier-ignore -->
```markdown
## 24. Уточнения плана ЛЦ-0 (облако: экспорт офлайн-лицензии)

План: `docs/superpowers/plans/2026-10-13-standalone-lc0-saas-offline-license-export.md`.

- Возможность названа `standaloneLicenses.manage` (словарь возможностей платформы — `область.глагол`),
  только у `platform_admin`; маршруты требуют её вместе с `tenants.read`.
- Выпуск требует управляемой подписки; клиенту без кабинета подписку на тариф облако сейчас не даёт
  (`catalog_kind_not_allowed_for_offline_tenant`) — открытый вопрос владельцу.
- ИНН файла — `org_profiles.inn`, иначе ИНН текущего платёжного профиля с предупреждением: платформа не
  пишет `org_profiles.inn`, у клиента без кабинета он пуст.
- `validUntil` дополнительно ограничен годом от выпуска (подписка без даты окончания, ЛО8); причина
  срока хранится в журнале (`subscription_end` / `entitlement_reduction` / `one_year_cap`).
- Предпросмотр выпуска не хранится: подтверждение пересчитывает черновик и сравнивает ревизию прав,
  предыдущий номер и границу срока.
- Набор ключей лицензий — форма набора грантов с `protocol: "standalone-license-v1"`; ключ лицензий не
  может совпадать с ключом грантов; закрытый ключ принимает экранирование `\n`.
- Заголовок JWS — `{"alg","typ","kid"}` в порядке грантов; проверки домена и хоста разбирают его как
  объект.
- `tenantId` нагрузки — канонический UUID (формат ЛЦ-1); клиенту с иным идентификатором (кабинетная регистрация Better Auth) выпуск отвечает `standalone_license_tenant_id_unsupported` — открытый вопрос владельцу.
- Миграция облака — `0186_standalone_licenses` (или номер из «Отклонений при исполнении» плана).
- Отклонения при исполнении: перенести сюда из плана.
```

- [ ] **Step 6: Гейты**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write docs/operations/standalone-licenses.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md tools/production-browser/tenant-equipment-tests/fixture.ts tools/production-browser/tenant-equipment-tests/workspace.spec.ts
rtk proxy node_modules/.bin/prettier --ignore-path .prettierignore --check docs/operations/standalone-licenses.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md tools/production-browser/tenant-equipment-tests/fixture.ts tools/production-browser/tenant-equipment-tests/workspace.spec.ts
pnpm test:production-bundle:contract
git diff --check
```

Ожидается: зелёное (контракты production-bundle не ссылаются на новую памятку; если какой-то тест `runbook-contract.test.mjs` перечисляет файлы `docs/operations/` — дописать памятку туда и записать).

- [ ] **Step 7: Коммит**

<!-- prettier-ignore -->
```bash
git add docs/operations/standalone-licenses.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md tools/production-browser/tenant-equipment-tests/fixture.ts tools/production-browser/tenant-equipment-tests/workspace.spec.ts
cat > /tmp/claude/lc0-commit.txt <<'EOF'
docs(standalone): offline license key runbook, spec §24, equipment tab browser check (plan ЛЦ-0)

The tenant-equipment browser suite answers the standalone sites request and
checks the panel in both languages and widths; the operations runbook covers
the license key, its Lockbox group, rotation and what the file carries.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git commit -F /tmp/claude/lc0-commit.txt
```

---

## Итоговая проверка плана

Из корня, после всех задач (DB-проверки — с `DATABASE_URL` и применённой миграцией `0186`; пропуски называть в отчёте):

<!-- prettier-ignore -->
```bash
git status --short
git log --oneline -12
pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/api^...' --filter='@markiro/saas-admin^...'

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/compact-jws-signing.test.ts test/standalone-license-keyset.test.ts test/standalone-license-rights.test.ts test/standalone-inn-check.test.ts test/standalone-sites.e2e.test.ts test/standalone-license-issuance.e2e.test.ts test/platform-standalone-licenses.routes.test.ts test/platform-contract-openapi.test.ts test/subscription-route-inventory.test.ts test/openapi-coverage.test.ts test/env.test.ts test/env-example.test.ts test/device-grants-keyset.test.ts test/device-grants-issuer.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api build

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin build

node --test deploy/yandex/test/runtime-env.test.mjs
pnpm test:production-bundle:contract
pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config tenant-equipment.playwright.config.ts

pnpm format:check
git diff --check origin/main...HEAD
graphify update .
```

Широкий прогон (по корневому `AGENTS.md`, долго): `pnpm turbo lint typecheck test build --concurrency=1 --force` — запускать перед PR; падение чужого теста записать и разобрать, а не повторять до зелёного.

Ручная проверка, которую делает человек (не автоматическая): в SaaS-админке на стенде с настроенным ключом лицензий — добавить площадку по настоящему запросу активации из ЛЦ-3/ЛЦ-2, выпустить файл и загрузить его в офис автонома (хост ЛЦ-2 принимает: подпись, `hostId`, ИНН, `sequence`).

## Перенесено

- **Тарифы для клиентов без кабинета.** Выпуск требует управляемой подписки, а `assertKindAllowedForTenant` запрещает тариф клиенту с `cabinet_access = 'none'`; `SubscriptionPanel` такому клиенту не показывается. Разрешить тарифы автономным клиентам (или завести им подписку иначе) — решение владельца и отдельный план; до него автономный клиент должен быть клиентом с кабинетом (Д2).
- **Обновление запроса активации без смены хоста** (свежий `usage` для предупреждения `quota_below_usage`) — сейчас только через перепривязку (Д10).
- **Напоминание о продлении письмом или задачей** — сейчас только признак `renewalDue` и полоса в панели (Д16).
- **Аудит повторной загрузки файла** — чтение, строки аудита нет (Д16).
- **Инструмент генерации пары ключей и `STANDALONE_LICENSE_KEYSET_JSON`** — шаг владельца на его машине по памятке; скрипт не делается (§6.1: офлайн-инструмент владельца не нужен).
- **Реестр выпусков автонома в SaaS-админке** (§15, «позже, по желанию»).
- **Клиенты с идентификатором не-UUID** (Д14): расширить `tenantId` нагрузки в ЛЦ-1 (TS-схема, `is_valid` Rust, общие фикстуры `schema-cases.json`) или оставить отказ — решение владельца.
- **Многострочный PEM ключа грантов в Lockbox** — то же ограничение `renderRuntimeEnvironment`, что обошёл Д12 для ключа лицензий; гранты по брифу не меняются.

## Не проверено

- Что файл, подписанный API, принимает Rust-проверка хоста (`markiro_proto::trust`, ЛЦ-1/ЛЦ-2): здесь его проверяет только `verifyStandaloneLicense` домена (TS). Порядок полей заголовка `{alg,typ,kid}` безопасен, только если проверка Rust разбирает заголовок как объект, а не сравнивает байты (Д13) — подтвердить в ЛЦ-2 на файле, выпущенном API на стенде.
- Настоящий ключ лицензий в Yandex Lockbox, развёртывание с группой `STANDALONE_LICENSE_*`, однострочный PEM на продовом рантайме — внешняя проверка деплоя (`deploy-production.yml`), не контракт.
- Применение миграции `0186` к продовой базе и время её выполнения — только при деплое.
- Внешний вид панели и диалогов в настоящем браузере сверх набора `tenant-equipment` (два размера, два языка, скриншоты не сравниваются); работа с клавиатуры в модальных окнах проверена jsdom, не браузером.
- Загрузка `.mklic` в реальном браузере (`<a download>` и `Blob`) — jsdom проверяет только вызовы; Playwright-набор не скачивает файл.
- Сколько в проде клиентов с идентификатором не-UUID (кабинетная регистрация Better Auth): для них выпуск отказывает (Д14); запрос к продовой базе — вне плана.

## Отклонения при исполнении

Исполнитель: ветка `claude/exec-lc0`. Отчёт — `.superpowers/sdd/exec-exec-lc0-report.md` в рабочей
копии планов.

- **Основа.** ЛЦ-1 на старте не был влит в `claude/integration`; задачи 2–3 сделаны на чистой основе,
  затем в ветку влиты `claude/exec-lc1` (задачи 1–5 и правки ревью) и, после слияния ЛЦ-1 контроллером,
  `claude/integration`.
- **Миграция `0186`** — номер следующий в `claude/integration`; в `origin/main` уже `0186`–`0191`:
  при переносе на `main` перенумеровать (drizzle-kit) и пересоздать снимок. В схему добавлены колонка
  `source` и проверки: офлайн ⇔ `offline_term`, офлайн — только `subscription`; интервал
  `valid_until − valid_from ≤ 365 дней` и `issued_at = valid_from` (вместо одного `valid_until >
valid_from`). Миграция ещё нигде не применена, поэтому пересоздана, а не дополнена.
- **Ожидание предпросмотра** дополнено `termsDigest` (SHA-256 подписываемых условий без моментов
  времени): без него подтверждение подписывало другой льготный срок, другой хост после перепривязки,
  другое имя клиента и другие офлайн-условия, чем показал предпросмотр (ревью задачи 8).
- **Имя клиента** очищается по правилу ЛЦ-1 `isPlainText` (C0, C1, DEL, U+2028/2029, двунаправленные
  знаки) и режется до 300 единиц UTF-16 (как `.max(300)` Zod и `utf16_len` Rust), пустое — «—».
- **ИНН:** `org_inn_missing` не выдаётся, если верный ИНН есть в платёжном профиле (у клиента без
  кабинета профиля организации нет; Д3 и так берёт ИНН из платёжного); неверный ИНН пробного периода
  предупреждает и при пустом или неверном ИНН запроса. Тесты задачи 6 изменены соответственно.
- **Повторы запросов площадок:** повтор `create` после перепривязки отвечает тем же видом (сверка с
  первой записью истории, а не с текущим хостом); `rebind` с `requestId` создания — конфликт.
- **`licenseValidity`:** граница, не сдвигающаяся вперёд, обрезает файл (защита от зацикливания).
- **Список площадок** читает только последний выпуск каждой площадки (`DISTINCT ON`) и не больше 500
  площадок (предел контракта).
- **`postgresFailure`** не принимает errno Node (`EPIPE` и т. п.) за SQLSTATE; исчерпанный `40001` в
  подтверждении — `preview_stale`; аудит `before` называет `source` заменённого файла.
- **Тесты плана с ошибками:** тест панели искал строку площадки сразу после заголовка карточки, до
  загрузки списка (`findByText`); чтение фикстуры через `new URL(…, import.meta.url)` в jsdom не
  работает — путь от `apps/saas-admin`. В e2e площадок замыкания повторов вызываются по одному (иначе
  необработанный отказ).
- **Вёрстка:** на 390 px карточка площадок (элемент сетки без `min-width: 0`) расширяла всю вкладку —
  добавлено правило `.standalone-sites-panel { min-width: 0 }` в `global.css`.
- **Подписи коммитов** — `Co-Authored-By: Claude Opus 5.5` (исполнитель — Opus; правило брифа
  называло Sonnet).
- **Мутации** (все не закоммичены, файлы возвращены): убиты — изоляция `findSite`, сравнение
  `previousSequence`, `null`-возможность как `true`, демо из `trial`, путь офлайн, только
  опубликованный тариф, сверка условий повтора (оба поля), очистка двунаправленных знаков, запрет
  офлайн-условий клиенту с кабинетом, активный пользователь, флаг второго фактора, исполнитель и хост
  повтора площадки, повтор на гонку хоста, `rebind` с `requestId` создания, сравнение `termsDigest` и
  каждое его поле (хост, льгота, офлайн), предел UTF-16, «—», C0. Выжили эквивалентные: `labelEditor
!== false` (колонка `NOT NULL`), фильтр `kind = 'plan'` (внутреннее соединение с `plan_entitlements`
  уже отсекает дополнения), повтор на `standalone_sites_tenant_request_uq` (одновременное создание
  первым ловит `host_id_uq`). Не проверены тестом: `FOR SHARE` клиента под гонкой с выдачей кабинета и
  отображение исчерпанного `40001`.
