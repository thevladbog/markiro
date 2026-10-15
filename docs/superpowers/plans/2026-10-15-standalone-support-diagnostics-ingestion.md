# План ДИАГ: приём диагностики автонома в SaaS-админке (токен `MKS1`, история, статистика по месяцам, карточка тенанта) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор SaaS-админки вставляет в карточке тенанта текст «Сведения для поддержки» (с зашифрованным токеном `MKS1.<kid>.<тело>`); API расшифровывает токен закрытым ключом поддержки из Yandex Lockbox, строго проверяет нагрузку, привязывает хост к тенанту (с подтверждением оператора для неизвестного хоста), сохраняет **историю** диагностик и **статистику по месяцам** (идемпотентно по хешу токена и по точному `generated_at`), а новая вкладка «Диагностика» показывает версию, использование лицензии, статистику с таблицей и диаграммами, историю и сравнение с лицензией в облаке. Клиент автонома присылает нагрузку v2 (`hostId`, роль ПК, ОС/архитектура/WebView2, сводка лицензии) внутри того же токена.

**Architecture:**

- Задача 1 (К1) — `@markiro/platform-contracts`: `standalone-support.ts` (схема нагрузки v1/v2, самодостаточная — только `zod`, чтобы клиент автонома мог читать её в тестах относительным путём), `standalone-diagnostics.ts` (запросы, ответы, коды ошибок, `platformStandaloneDiagnosticsContracts`); имя `STANDALONE_SUPPORT_KEYS_JSON` в `deploy/yandex/runtime-env.mjs` (необязательная запись), `.env.production.example`, `.env.example`, `docs/runbooks/yandex-secrets.md` (так решил владелец: это часть К1).
- Задача 2 (Д1) — `@markiro/db`: две таблицы и миграция `0194_standalone_support_diagnostics.sql`, каскад по тенанту, тесты схемы и миграции (свежая БД и обновление с 0193).
- Задача 3 (А1) — API: `support-blob.ts` (чистый разбор токена на `node:crypto` и `node:zlib`, без внутренних импортов), `standalone-support-keys.ts` (ключи из окружения; SEC1 и PKCS8), `env.ts`; чистые тесты, в том числе «ключ владельца в формате SEC1 открывает токен».
- Задача 4 (А2) — API: `support-payload.ts`, `standalone-diagnostics-views.ts`, `standalone-diagnostics.service.ts` (приём, привязка, идемпотентность, upsert месяцев, аудит, чтение, чистка по сроку хранения); обобщение `requireStandaloneLicenseActor`; e2e на БД.
- Задача 5 (А3) — API: контроллер, модуль, подключение в `AppModule`, ночной очиститель 24 месяцев, инвентарь маршрутов, OpenAPI, тесты политик.
- Задача 6 (Т1) — `apps/standalone`: нагрузка v2, загрузка лицензии в контекст отчёта, `decrypt.mjs` печатает v2, тесты белого списка.
- Задача 7 (Ч1) — сквозная чётность: токен настоящего `support-crypto.ts` открывают `openSupportBlob`, `decrypt.mjs`, схема контракта.
- Задача 8 (У1) — `apps/saas-admin`: вкладка «Диагностика» (сводка, вставка, статистика, история), RU/EN, тесты.
- Задача 9 (Д2) — документы: инструкция оператору, ROADMAP, шаги владельца; итоговые гейты.

**Tech Stack:** TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, NestJS + Drizzle (Postgres), `node:crypto` (ECDH P-256, HKDF-SHA256, AES-256-GCM), `node:zlib`, Vitest 4, React 19 + TanStack Query, `@markiro/ui`, `node --test` для `deploy/yandex`.

**Спецификация и источники:**

- `docs/superpowers/specs/2026-10-15-standalone-support-diagnostics-ingestion-design.md` — единственная спецификация плана; решения владельца в её конце (В1–В10, Lockbox) окончательны.
- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (ключи, §5.1), `apps/standalone/src/office/info/support-crypto.ts`, `tools/standalone-support/decrypt.mjs` — формат токена.
- `AGENTS.md`, `apps/api/AGENTS.md` (политики маршрутов, платформенная изоляция, аудит), `docs/superpowers/plans/2026-10-13-standalone-lc0-saas-offline-license-export.md` (образец стиля и соседний модуль).

## Где исполнять и что проверено

Ветка спеки `claude/spec-diag` отстаёт от `claude/integration`: в ней ещё нет ни `apps/api/src/modules/standalone-licenses/`, ни миграций 0192–0193. **План исполняется в worktree, созданном от `claude/integration`** (`git worktree add … -b claude/exec-diag claude/integration`); все пути ниже проверены по `claude/integration` @ `1de1b2b9f` (чтение, без правок). Проверено, что существуют:

- API: `modules/standalone-licenses/{standalone-license-authority,standalone-license-transaction,standalone-license-keyset,standalone-sites.service,platform-standalone-licenses.controller,platform-standalone-licenses.module}.ts`; `requireStandaloneLicenseActor`, `STANDALONE_LICENSE_CAPABILITIES`, `STANDALONE_LICENSE_CLOCK`, `standaloneTransaction` (REPEATABLE READ, повтор на `40001` и на именованных unique-нарушениях `RETRYABLE_CONSTRAINTS`), `configureStandaloneLicenseSigning`, `STANDALONE_LICENSE_SIGNING_ERROR`; `platform-auth/platform-audit.service.ts` (`PlatformAuditService.record`, `sanitizeAuditMetadata`), `platform-auth/platform-access-policy.ts` (`RequirePlatformCapabilities`), `platform-http/{platform-openapi,platform-response,platform-exception.filter}.ts`, `jobs/jobs.module.ts`, `app.module.ts` (строка `PlatformStandaloneLicensesModule.forRoot(env)`), `env.ts` (строки `STANDALONE_LICENSE_*` и проверка в `superRefine`).
- Тесты API: `test/support/standalone-license-fixture.ts` (`platformActor`, `auditRows`), `test/support/subscription-fixtures.ts` (`createOrganization`), `platform-standalone-licenses.routes.test.ts`, `platform-route-contracts.ts`, `platform-contract-openapi.test.ts` (`toHaveLength(258)`), `subscription-route-inventory.test.ts`, `env.test.ts`.
- БД: `packages/db/src/schema/standalone-licenses.ts`, `schema.ts` (строка экспорта), `drizzle.config.ts` (список схем), миграции `0192_standalone_licenses.sql`, `0193_custom_logo_entitlement.sql` (журнал `idx` 192 и 193), тесты `standalone-licenses-{schema,migration}.test.ts`.
- Контракты: `packages/platform-contracts/src/{standalone-licenses,standalone-license,primitives,index}.ts`; `standaloneOpaqueIdSchema` из `@markiro/domain`.
- Клиент: `apps/standalone/src/office/info/{support-crypto,support-keys,support-usage,support-blocks,support-report,SupportSection}.ts(x)`, `src/host/{usage-stats,protocol,device}.ts` (`officeLicenseSchema`, `LICENSE_QUOTA_KEYS`, `LICENSE_FEATURE_KEYS`, `InstallRole`), `tools/standalone-support/{decrypt.mjs,decrypt.d.mts,test/decrypt.test.mjs}`, скрипт `test:standalone-support:contract`; тесты `test/{support-report,support-crypto}.test.ts`.
- SaaS-админка: `pages/tenants/{TenantPage,TenantEquipmentPanel,StandaloneSitesPanel,standalone-api,standalone-format}.ts(x)`, `api/client.ts` (`platformApiFetch`, `ApiRequestError`), `i18n/{ru,en}.json`, `global.css`, `test/{render.tsx,tenant-detail.test.tsx,standalone-fixtures.ts}`.
- Деплой/документы: `deploy/yandex/runtime-env.mjs` (`OPTIONAL_ENVIRONMENT_KEY_GROUPS`) и `deploy/yandex/test/runtime-env.test.mjs`, `.env.example`, `.env.production.example`, `docs/runbooks/yandex-secrets.md`, `docs/standalone/ROADMAP.md`, `docs/operations/standalone-licenses.md`.
- Проверено исполнением: `sup-` + первые 8 hex SHA-256 от `04‖x‖y` открытого ключа из `proto/fixtures/support-keys.json` даёт `sup-d11c3182` (так что функция `expectedSupportKid` ниже согласована с `publicEntry` из `decrypt.mjs`); `crypto.createPrivateKey` открывает PEM `-----BEGIN EC PRIVATE KEY-----` (SEC1) как `ec`/`prime256v1`; `inflateRawSync(…, { maxOutputLength })` на токене-бомбе бросает `ERR_BUFFER_TOO_LARGE`.

## Допущения и расхождения со спекой (читать до исполнения)

Спека верна в замысле; ниже — то, что в коде оказалось иначе, и принятое решение. Каждое отмечено в итоговом отчёте.

- **Р1 — не 503, а 409 `standalone_diagnostics_not_configured`.** `PlatformExceptionFilter.platformCode` для любого статуса ≥ 500 отдаёт `platform_internal_error`, код домена теряется, и интерфейс не отличит «приём не настроен» от сбоя. Так же устроены лицензии (`.env.example`: «issuance then answers 409»). Запись не создаётся, API не падает.
- **Р2 — `sanitizeAuditMetadata` не маскирует, а выбрасывает ключи** по `/(password|secret|token|session|cookie|authorization|credential|backup.?codes?)/i`. Вывод спеки тот же: поле называется `blobSha256`; тест проверяет, что оно **есть** в `after` со значением (а не «не замаскировано»).
- **Р3 — размер текста: 413 проверяется в сервисе, не в Zod.** Ошибка Zod-пайпа — `400 platform_validation_error` без домена; чтобы вернуть `413 standalone_diagnostics_text_too_large`, схема тела проверяет только `min(1)`, а предел 32 768 знаков проверяет сервис (с аудитом `rejected`). Тело больше лимита `express.json()` (100 КиБ) обрабатывает body-parser до Nest: ответ — статус 413 в его форме, а не в платформенной; тест проверяет статус и отсутствие записи, не форму.
- **Р4 — 413/503 не попадают в OpenAPI:** `platform-contract-openapi.test.ts` фиксирует точный список `PROTECTED_ERROR_STATUSES` (400…500 без 413). Расширять его ради одного маршрута не нужно.
- **Р5 — порядок «привязка → идемпотентность» оставлен по спеке** (разд. 3.5, пп. 3–4). Следствие: повторная вставка уже принятого токена от **неизвестного** хоста (или v1) снова требует `acknowledgeUnboundHost`, а `standalone_diagnostics_token_conflict` достижим только для токенов без привязки к тенанту (v1/неизвестный хост): токен хоста тенанта B в карточке A получит `host_other_tenant` раньше. Тесты фиксируют именно это.
- **Р6 — срок хранения (В6) требует исполнителя чистки,** которого в таблице задач спеки нет. Добавлено в А3: `purgeExpired` + суточный `setInterval`-очиститель (образец `invitations-reconciler.ts`), внешние ключи с `ON DELETE CASCADE` на `organization` и от месяцев к диагностике. Месяц, источником которого был удалённый старый отчёт, удаляется вместе с ним: он старше срока хранения.
- **Р7 — В5: источника «последняя опубликованная сборка автонома» в облаке сейчас нет.** Что есть и чего нет: `tools/station-release/*` публикует `latest.json` **облачной станции** (бакет `station/{beta,stable}/latest.json`, GitHub) — это другой продукт; `tools/standalone-release/{prepare,sign-update}.mjs` готовит неподписанный черновик манифеста в CI-артефакте, владелец подписывает его на своей машине и передаёт клиенту папку вручную (спека лицензий §10.3: «вне продукта»); таблицы, bucket-ключа, URL или переменной окружения с версией автонома нет. Поэтому по решению владельца («если можно получить из каталога релизов») сравнение **реализовано как точка расширения, выключенная по умолчанию:** интерфейс `StandaloneLatestBuildSource` с реализацией «ничего не опубликовано» → `latestPublishedVersion: null`, `outdated: null`, бейдж «устарела» не показывается. Когда появится источник (например `latest.json` автонома в объектном хранилище), нужна одна реализация интерфейса и одна строка в модуле. Это записано в ROADMAP (Д2) как вопрос владельцу.
- **Р8 — `receivedAt` берётся по часам БД** (`DEFAULT now()`), как в спеке; чистка по сроку использует часы сервиса (`STANDALONE_DIAGNOSTICS_CLOCK`).
- **Р9 — query-параметры чтения описаны строками** (`limit`, `cursor`, `hostKey`, `from`, `to`) с регулярными выражениями, без `z.coerce`: так OpenAPI-проверка `io: "input"` остаётся совместимой с OpenAPI 3.0.
- **Р10 — права:** новой возможности нет. Запись — `["tenants.read","standaloneLicenses.manage"]` (у ролей их сейчас только `platform_admin`), чтение — `["tenants.read"]`; для чтения `requireStandaloneLicenseActor` получает необязательный список возможностей (по умолчанию прежний).

## Global Constraints

- Изоляция тенантов: каждый запрос к новым таблицам несёт `tenant_id`; диагностика другого тенанта по пути → `404`; составные внешние ключи не дают привязать чужую площадку и чужой источник агрегата; тесты проверяют отказ, а не только счастливый путь.
- Платформенный пользователь, его второй фактор и тенант перечитываются в транзакции (`requireStandaloneLicenseActor`); запись — `FOR SHARE`.
- Аудит проверяется по точным полям (актор, роль, тенант, действие, исход, тип и id цели, причина, `before`, `after`), не по числу строк.
- Закрытый ключ поддержки, токен, текст и расшифрованная нагрузка не попадают в лог, ответ об ошибке, аудит и дамп; тесты ловят утечки.
- Нагрузка — недоверенный ввод: размеры, канонический base64url, ограничение распаковки, строгая схема **до** записи; в БД пишется только проверенная нагрузка.
- Миграция 0194 помечена **«перенумеровать перед любым PR в main»**: при PR номер, запись в `meta/_journal.json` и снимок берутся заново от тогдашнего `origin/main`; Д1 и Д2 фиксируют это в описании и ROADMAP.
- Формат токена `MKS1`, ключи сборки и их ротация не меняются; v1 (клиенты беты 3) принимается.
- TypeScript strict: без `any`, без `as` к широким типам, без `!`; `import type` для типов. Пользовательский текст SaaS-админки — только через `i18n/{ru,en}.json` (оба файла).
- `package.json`, `pnpm-lock.yaml`, `Cargo.*` не меняются; новых зависимостей нет. pnpm — только с `--config.verifyDepsBeforeRun=false`, без `pnpm install`/`add`, команды из корня, без `git stash`.
- Перед каждым коммитом: `node_modules/.bin/prettier --ignore-path .prettierignore --write <файлы>` (в свежем worktree без `node_modules` — бинарник основного checkout: `/Users/thevladbog/PRSOME/q/node_modules/.bin/prettier`), затем `--check`; `typecheck`, `lint` затронутого пакета; `git diff --check`. Коммиты — явные пути, одна строка `Co-Authored-By` по правилам сессии; push, PR и деплой — не задачи плана.
- После сборки `platform-contracts` и `db`: `pnpm --config.verifyDepsBeforeRun=false --filter <пакет> build` до тестов потребителей. Тесты БД и e2e API требуют `DATABASE_URL` (одноразовый контейнер: `docker run -d --rm --name markiro-diag-pg -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:17`, `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres`, затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:migrate`); без неё e2e пропускаются явно — пропуск называть в отчёте.

## Файлы

- Create (контракты): `packages/platform-contracts/src/standalone-support.ts`, `packages/platform-contracts/src/standalone-diagnostics.ts`, `packages/platform-contracts/test/standalone-support.test.ts`, `packages/platform-contracts/test/standalone-diagnostics.test.ts`
- Modify (контракты): `packages/platform-contracts/src/index.ts`
- Modify (окружение и деплой): `deploy/yandex/runtime-env.mjs`, `deploy/yandex/test/runtime-env.test.mjs`, `.env.example`, `.env.production.example`, `docs/runbooks/yandex-secrets.md`
- Create (БД): `packages/db/src/schema/standalone-support-diagnostics.ts`, `packages/db/migrations/0194_standalone_support_diagnostics.sql` (+ `meta/0194_snapshot.json`, запись журнала — генерирует drizzle-kit), `packages/db/test/standalone-support-diagnostics-schema.test.ts`, `packages/db/test/standalone-support-diagnostics-migration.test.ts`
- Modify (БД): `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`
- Create (API): `apps/api/src/modules/standalone-diagnostics/{support-blob,standalone-support-keys,support-payload,standalone-diagnostics-views,standalone-diagnostics.service,standalone-diagnostics-retention,platform-standalone-diagnostics.controller,platform-standalone-diagnostics.module}.ts`
- Create (тесты API): `apps/api/test/support/standalone-support-token.ts`, `apps/api/test/{standalone-support-blob,standalone-support-keys,standalone-support-payload,standalone-diagnostics-views,standalone-diagnostics.e2e,platform-standalone-diagnostics.routes}.test.ts`
- Modify (API): `apps/api/src/env.ts`, `apps/api/src/app.module.ts`, `apps/api/src/modules/standalone-licenses/standalone-license-authority.ts`, `apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts`, `apps/api/test/{env.test,platform-route-contracts,platform-contract-openapi.test,subscription-route-inventory.test}.ts`
- Modify (автоном): `apps/standalone/src/office/info/{support-usage,support-blocks,SupportSection}.ts(x)`, `apps/standalone/test/support-report.test.ts`, `tools/standalone-support/{decrypt.mjs,test/decrypt.test.mjs}`
- Create (автоном): `apps/standalone/test/support-parity.test.ts`
- Create (SaaS-админка): `apps/saas-admin/src/pages/tenants/{diagnostics-api,diagnostics-format}.ts`, `apps/saas-admin/src/pages/tenants/{TenantDiagnosticsPanel,DiagnosticsOverview,DiagnosticsIngestForm,DiagnosticsStatistics,DiagnosticsHistory}.tsx`, `apps/saas-admin/test/{diagnostics-fixtures.ts,diagnostics-panel.test.tsx}`
- Modify (SaaS-админка): `apps/saas-admin/src/pages/tenants/TenantPage.tsx`, `apps/saas-admin/src/i18n/{ru,en}.json`, `apps/saas-admin/src/global.css`, `apps/saas-admin/test/tenant-detail.test.tsx`
- Create/Modify (документы): `docs/operations/standalone-diagnostics.md`, `docs/standalone/ROADMAP.md`, `docs/runbooks/yandex-secrets.md`

---

### Task 1 (К1): Контракты нагрузки и приёма; имя ключа в инвентаре Lockbox

**Files:**

- Create: `packages/platform-contracts/src/standalone-support.ts`, `packages/platform-contracts/src/standalone-diagnostics.ts`
- Modify: `packages/platform-contracts/src/index.ts`, `deploy/yandex/runtime-env.mjs`, `.env.example`, `.env.production.example`, `docs/runbooks/yandex-secrets.md`
- Test: `packages/platform-contracts/test/standalone-support.test.ts`, `packages/platform-contracts/test/standalone-diagnostics.test.ts`, `deploy/yandex/test/runtime-env.test.mjs`

**Interfaces:**

- Consumes: `platformUuidSchema`, `platformTimestampSchema` (`primitives.ts`); `STANDALONE_FEATURE_KEYS`, `STANDALONE_QUOTA_KEYS` (`@markiro/domain`, только в тесте — схема их не импортирует).
- Produces: `standaloneSupportPayloadSchema` (`v: 1 | 2`, строгая), `standaloneSupportPayloadV1Schema`, `standaloneSupportPayloadV2Schema`, `standaloneUsageMonthSchema`, `standaloneSupportLicenseSchema`, `STANDALONE_SUPPORT_MAX_MONTHS`, `STANDALONE_SUPPORT_FEATURE_KEYS`, `STANDALONE_SUPPORT_QUOTA_KEYS`, типы `StandaloneSupportPayload`, `StandaloneUsageMonth`, `StandaloneSupportLicense`; `STANDALONE_DIAGNOSTICS_ERROR_CODES`, `standaloneDiagnosticsIngestRequestSchema`, `standaloneDiagnosticSummarySchema`, `standaloneDiagnosticsIngestResponseSchema`, `standaloneDiagnosticsHistoryQuerySchema`, `standaloneDiagnosticsHistorySchema`, `standaloneDiagnosticsOverviewSchema`, `standaloneDiagnosticsStatisticsQuerySchema`, `standaloneDiagnosticsStatisticsSchema`, `standaloneDiagnosticDetailSchema`, `platformStandaloneDiagnosticsContracts` и типы.

- [ ] **Step 1: Падающий тест схемы нагрузки**

Создать `packages/platform-contracts/test/standalone-support.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import {
  STANDALONE_SUPPORT_FEATURE_KEYS,
  STANDALONE_SUPPORT_QUOTA_KEYS,
  standaloneSupportPayloadSchema,
} from "../src/index.js";

const zeroMonth = (month: string) => ({
  month,
  shifts: {
    aggregation: 1,
    validation: 0,
    validationPrint: 0,
    fromOffice: 1,
    fromStation: 0,
    withPallets: 0,
  },
  scans: { accepted: 7020, duplicates: 64, rejected: 9 },
  boxes: { closed: 585, disassembled: 0, codes: 7020 },
  pallets: { closed: 13, disassembled: 0 },
  exceptions: {
    boxUndo: 4,
    boxClear: 0,
    boxReprint: 2,
    boxDisassemble: 0,
    palletReprint: 0,
    palletDisassemble: 0,
  },
  conflicts: { late: 1, displaced: 0, reviewed: 0 },
  reprints: { warehouse: 0, unitLabel: 0 },
  disaggregationApplied: 0,
  syncRejected: 0,
});
const quota = (limit: number | null, used: number) => ({ limit, used, over: false });
const license = () => ({
  state: "active",
  plan: "subscription",
  licenseId: "11111111-2222-4333-8444-555555555555",
  sequence: 3,
  kid: "lic-1",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2027-10-01T00:00:00Z",
  graceDays: 14,
  daysLeft: 350,
  quotas: {
    lines: quota(2, 1),
    stations: quota(3, 2),
    kiosks: quota(null, 0),
    cabinetUsers: quota(5, 1),
  },
  features: Object.fromEntries(STANDALONE_FEATURE_KEYS.map((key) => [key, true])),
  innMatches: true,
});
const v1 = () => ({
  v: 1,
  generatedAt: "2026-10-14T09:00:00.000Z",
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  months: [zeroMonth("2026-09"), zeroMonth("2026-10")],
  devices: { station: 3, office: 2, handheld: 1 },
});
const v2 = () => ({
  ...v1(),
  v: 2,
  hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  role: "host",
  os: "Windows 11",
  arch: "x64",
  webview: "WebView2 130.0.2849.80",
  license: license(),
});

describe("standalone support payload (plan ДИАГ К1)", () => {
  it("accepts v1 and v2 and keeps the field names of the client", () => {
    expect(standaloneSupportPayloadSchema.parse(v1())).toMatchObject({ v: 1 });
    expect(standaloneSupportPayloadSchema.parse(v2())).toMatchObject({ v: 2, role: "host" });
    expect(
      standaloneSupportPayloadSchema.safeParse({
        ...v2(),
        hostId: null,
        role: null,
        os: null,
        arch: null,
        webview: null,
        license: null,
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown field at every level, even a harmless-looking one", () => {
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), extra: 1 }).success).toBe(false);
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), hostId: "x" }).success).toBe(false);
    const month = { ...zeroMonth("2026-10"), productName: "Молоко" };
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), months: [month] }).success).toBe(
      false,
    );
    const customer = { ...license(), customer: { name: "ООО", inn: "7707083893" } };
    expect(standaloneSupportPayloadSchema.safeParse({ ...v2(), license: customer }).success).toBe(
      false,
    );
    const fingerprint = { ...license(), fingerprint: "ab".repeat(32) };
    expect(
      standaloneSupportPayloadSchema.safeParse({ ...v2(), license: fingerprint }).success,
    ).toBe(false);
  });

  it("requires months to be calendar months, strictly increasing, one to twelve", () => {
    const parse = (months: unknown[]) =>
      standaloneSupportPayloadSchema.safeParse({ ...v1(), months }).success;
    expect(parse([])).toBe(false);
    expect(parse([zeroMonth("2026-13")])).toBe(false);
    expect(parse([zeroMonth("2026-10"), zeroMonth("2026-09")])).toBe(false);
    expect(parse([zeroMonth("2026-10"), zeroMonth("2026-10")])).toBe(false);
    const year = Array.from({ length: 12 }, (_, i) =>
      zeroMonth(`2025-${String(i + 1).padStart(2, "0")}`),
    );
    expect(parse(year)).toBe(true);
    expect(parse([...year, zeroMonth("2026-01")])).toBe(false);
  });

  it("bounds every counter: integer, not negative, not above 2^53 - 1", () => {
    const withScans = (accepted: number) => ({
      ...v1(),
      months: [{ ...zeroMonth("2026-10"), scans: { accepted, duplicates: 0, rejected: 0 } }],
    });
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(standaloneSupportPayloadSchema.safeParse(withScans(bad)).success).toBe(false);
    }
    expect(
      standaloneSupportPayloadSchema.safeParse(withScans(Number.MAX_SAFE_INTEGER)).success,
    ).toBe(true);
  });

  it("bounds versions and system strings: length and no control characters", () => {
    const parse = (patch: Record<string, unknown>) =>
      standaloneSupportPayloadSchema.safeParse({ ...v2(), ...patch }).success;
    expect(parse({ appVersion: "x".repeat(65) })).toBe(false);
    expect(parse({ appVersion: "0.2.0\u0000" })).toBe(false);
    expect(parse({ hostVersion: "0.2.0\r\nX: y" })).toBe(false);
    expect(parse({ os: "Windows‮11" })).toBe(true);
    expect(parse({ webview: "w".repeat(121) })).toBe(false);
    expect(parse({ generatedAt: "yesterday" })).toBe(false);
    expect(parse({ hostId: "3F1C2D4E-5A6B-4C7D-8E9F-0A1B2C3D4E5F" })).toBe(false);
    expect(parse({ role: "kiosk" })).toBe(false);
  });

  it("keeps its quota and feature key lists equal to the domain's", () => {
    expect([...STANDALONE_SUPPORT_QUOTA_KEYS].sort()).toEqual([...STANDALONE_QUOTA_KEYS].sort());
    expect([...STANDALONE_SUPPORT_FEATURE_KEYS].sort()).toEqual(
      [...STANDALONE_FEATURE_KEYS].sort(),
    );
  });
});
```

Запуск (ожидается FAIL — экспортов нет):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-support.test.ts
```

Ожидается: `FAIL`, `STANDALONE_SUPPORT_QUOTA_KEYS is not exported` / undefined (в зависимости от сборки).

- [ ] **Step 2: Схема нагрузки**

Создать `packages/platform-contracts/src/standalone-support.ts` (только `zod`: файл читают относительным путём из `apps/standalone/test`):

```ts
import { z } from "zod";

/**
 * The plaintext inside a support token `MKS1.<kid>.<body>` (the client:
 * `apps/standalone/src/office/info/support-usage.ts`). Strict at every level:
 * a field the client does not send is a refusal, so a hand-made token cannot
 * smuggle a name, a code or a secret into the history. v1 is beta 3 (counts
 * only); v2 adds the host's id, the PC role, the system and a license summary.
 */
export const STANDALONE_SUPPORT_MAX_MONTHS = 12;
export const STANDALONE_SUPPORT_QUOTA_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
] as const;
export const STANDALONE_SUPPORT_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
  "customLogo",
] as const;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const noControl = (value: string) => !/\p{Cc}/u.test(value);
const text = (max: number) => z.string().min(1).max(max).refine(noControl);
const instant = z.iso.datetime();
const uuidLower = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const standaloneMonthKeySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);

export const standaloneUsageMonthSchema = z
  .object({
    month: standaloneMonthKeySchema,
    shifts: z
      .object({
        aggregation: count,
        validation: count,
        validationPrint: count,
        fromOffice: count,
        fromStation: count,
        withPallets: count,
      })
      .strict(),
    scans: z.object({ accepted: count, duplicates: count, rejected: count }).strict(),
    boxes: z.object({ closed: count, disassembled: count, codes: count }).strict(),
    pallets: z.object({ closed: count, disassembled: count }).strict(),
    exceptions: z
      .object({
        boxUndo: count,
        boxClear: count,
        boxReprint: count,
        boxDisassemble: count,
        palletReprint: count,
        palletDisassemble: count,
      })
      .strict(),
    conflicts: z.object({ late: count, displaced: count, reviewed: count }).strict(),
    reprints: z.object({ warehouse: count, unitLabel: count }).strict(),
    disaggregationApplied: count,
    syncRejected: count,
  })
  .strict();
export type StandaloneUsageMonth = z.infer<typeof standaloneUsageMonthSchema>;

const quotaUse = z.object({ limit: count.nullable(), used: count, over: z.boolean() }).strict();

export const standaloneSupportLicenseSchema = z
  .object({
    state: text(64),
    plan: text(64).nullable(),
    licenseId: uuidLower.nullable(),
    sequence: z.number().int().positive().max(2_147_483_647).nullable(),
    kid: text(128).nullable(),
    validFrom: instant.nullable(),
    validUntil: instant.nullable(),
    graceDays: count.max(366).nullable(),
    daysLeft: count.nullable(),
    quotas: z
      .object({
        lines: quotaUse,
        stations: quotaUse,
        kiosks: quotaUse,
        cabinetUsers: quotaUse,
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
        customLogo: z.boolean(),
      })
      .strict(),
    innMatches: z.boolean().nullable(),
  })
  .strict();
export type StandaloneSupportLicense = z.infer<typeof standaloneSupportLicenseSchema>;

const months = z
  .array(standaloneUsageMonthSchema)
  .min(1)
  .max(STANDALONE_SUPPORT_MAX_MONTHS)
  .refine((items) =>
    items.every((item, at) => at === 0 || (items[at - 1]?.month ?? "") < item.month),
  );
const common = {
  generatedAt: instant,
  appVersion: text(64).nullable(),
  hostVersion: text(64).nullable(),
  months,
  devices: z.object({ station: count, office: count, handheld: count }).strict(),
};

export const standaloneSupportPayloadV1Schema = z.object({ v: z.literal(1), ...common }).strict();
export const standaloneSupportPayloadV2Schema = z
  .object({
    v: z.literal(2),
    ...common,
    hostId: uuidLower.nullable(),
    role: z.enum(["host", "station", "office"]).nullable(),
    os: text(120).nullable(),
    arch: text(120).nullable(),
    webview: text(120).nullable(),
    license: standaloneSupportLicenseSchema.nullable(),
  })
  .strict();
export const standaloneSupportPayloadSchema = z.discriminatedUnion("v", [
  standaloneSupportPayloadV1Schema,
  standaloneSupportPayloadV2Schema,
]);
export type StandaloneSupportPayload = z.infer<typeof standaloneSupportPayloadSchema>;
```

Добавить в `packages/platform-contracts/src/index.ts` после `export * from "./standalone-licenses.js";`:

```ts
export * from "./standalone-support.js";
export * from "./standalone-diagnostics.js";
```

(Второй файл появится в шаге 4; до этого сборка не нужна.)

- [ ] **Step 3: Падающий тест контрактов приёма**

Создать `packages/platform-contracts/test/standalone-diagnostics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  STANDALONE_DIAGNOSTICS_ERROR_CODES,
  platformStandaloneDiagnosticsContracts as contracts,
  standaloneDiagnosticsHistoryQuerySchema,
  standaloneDiagnosticsIngestRequestSchema,
  standaloneDiagnosticsStatisticsQuerySchema,
} from "../src/index.js";

describe("standalone diagnostics contracts (plan ДИАГ К1)", () => {
  it("takes the pasted text and the unbound-host acknowledgement, nothing else", () => {
    expect(standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "x" }).success).toBe(true);
    expect(
      standaloneDiagnosticsIngestRequestSchema.safeParse({
        text: "x",
        acknowledgeUnboundHost: true,
      }).success,
    ).toBe(true);
    expect(standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "x", tenantId: "t" }).success,
    ).toBe(false);
  });

  it("describes query strings as strings the service parses (OpenAPI 3.0 safe)", () => {
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "50" }).success).toBe(true);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ cursor: "a b" }).success).toBe(
      false,
    );
    const q = standaloneDiagnosticsStatisticsQuerySchema;
    expect(q.safeParse({ hostKey: "unknown", from: "2026-01", to: "2026-10" }).success).toBe(true);
    expect(q.safeParse({ hostKey: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }).success).toBe(true);
    expect(q.safeParse({ hostKey: "host-1" }).success).toBe(false);
    expect(q.safeParse({ from: "2026-13" }).success).toBe(false);
  });

  it("publishes five routes under the tenant with the access split of the spec", () => {
    expect(Object.entries(contracts).map(([name, c]) => [name, c.method, c.path])).toEqual([
      ["ingest", "POST", "/platform/tenants/:tenantId/standalone-diagnostics"],
      ["history", "GET", "/platform/tenants/:tenantId/standalone-diagnostics"],
      ["overview", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/overview"],
      ["statistics", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/statistics"],
      ["detail", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/:diagnosticId"],
    ]);
  });

  it("lists every refusal code the API can answer with, all prefixed", () => {
    expect([...STANDALONE_DIAGNOSTICS_ERROR_CODES].sort()).toEqual(
      [
        "standalone_diagnostics_cursor_invalid",
        "standalone_diagnostics_generated_in_future",
        "standalone_diagnostics_host_other_tenant",
        "standalone_diagnostics_host_unbound",
        "standalone_diagnostics_no_token",
        "standalone_diagnostics_not_configured",
        "standalone_diagnostics_payload_invalid",
        "standalone_diagnostics_payload_too_large",
        "standalone_diagnostics_text_too_large",
        "standalone_diagnostics_token_conflict",
        "standalone_diagnostics_token_malformed",
        "standalone_diagnostics_token_too_large",
        "standalone_diagnostics_undecryptable",
        "standalone_diagnostics_unknown_key",
      ].sort(),
    );
  });
});
```

- [ ] **Step 4: Контракты приёма**

Создать `packages/platform-contracts/src/standalone-diagnostics.ts`:

```ts
import { z } from "zod";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";
import {
  standaloneMonthKeySchema,
  standaloneSupportLicenseSchema,
  standaloneUsageMonthSchema,
} from "./standalone-support.js";

/** Plan ДИАГ: the operator pastes a support text, the API opens its token and keeps history and statistics. */
export const STANDALONE_DIAGNOSTICS_ERROR_CODES = [
  "standalone_diagnostics_not_configured",
  "standalone_diagnostics_text_too_large",
  "standalone_diagnostics_no_token",
  "standalone_diagnostics_token_malformed",
  "standalone_diagnostics_token_too_large",
  "standalone_diagnostics_unknown_key",
  "standalone_diagnostics_undecryptable",
  "standalone_diagnostics_payload_too_large",
  "standalone_diagnostics_payload_invalid",
  "standalone_diagnostics_generated_in_future",
  "standalone_diagnostics_host_other_tenant",
  "standalone_diagnostics_host_unbound",
  "standalone_diagnostics_token_conflict",
  "standalone_diagnostics_cursor_invalid",
] as const;
export type StandaloneDiagnosticsErrorCode = (typeof STANDALONE_DIAGNOSTICS_ERROR_CODES)[number];

/** The longest pasted text (characters); a real support text is 2-4 KiB. */
export const STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS = 32_768;

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A host, or `unknown` for beta 3 texts that carry no host id. */
export const standaloneHostKeySchema = z.union([
  z.literal("unknown"),
  z.string().regex(UUID_LOWER),
]);
const versionText = z.string().min(1).max(64).nullable();
const systemText = z.string().min(1).max(120).nullable();
const devicesSchema = z
  .object({
    station: z.number().int().nonnegative(),
    office: z.number().int().nonnegative(),
    handheld: z.number().int().nonnegative(),
  })
  .strict();

export const standaloneDiagnosticsIngestRequestSchema = z
  .object({ text: z.string().min(1), acknowledgeUnboundHost: z.boolean().optional() })
  .strict();
export type StandaloneDiagnosticsIngestRequest = z.infer<
  typeof standaloneDiagnosticsIngestRequestSchema
>;

export const standaloneDiagnosticSummarySchema = z
  .object({
    id: platformUuidSchema,
    hostKey: standaloneHostKeySchema,
    siteId: platformUuidSchema.nullable(),
    generatedAt: platformTimestampSchema,
    receivedAt: platformTimestampSchema,
    kid: z.string().min(1).max(32),
    payloadVersion: z.union([z.literal(1), z.literal(2)]),
    appVersion: versionText,
    hostVersion: versionText,
    pcRole: z.enum(["host", "station", "office"]).nullable(),
    os: systemText,
    arch: systemText,
    webview: systemText,
    licenseState: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type StandaloneDiagnosticSummary = z.infer<typeof standaloneDiagnosticSummarySchema>;

export const standaloneDiagnosticsIngestResponseSchema = z
  .object({
    duplicate: z.boolean(),
    diagnostic: standaloneDiagnosticSummarySchema,
    monthsApplied: z.number().int().nonnegative().max(12),
    monthsSkipped: z.number().int().nonnegative().max(12),
  })
  .strict();
export type StandaloneDiagnosticsIngestResponse = z.infer<
  typeof standaloneDiagnosticsIngestResponseSchema
>;

export const standaloneDiagnosticsHistoryQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^([1-9]|[1-4][0-9]|50)$/)
      .optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
  })
  .strict();
export type StandaloneDiagnosticsHistoryQuery = z.infer<
  typeof standaloneDiagnosticsHistoryQuerySchema
>;

export const standaloneDiagnosticsHistorySchema = z
  .object({
    items: z.array(standaloneDiagnosticSummarySchema).max(50),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .nullable(),
  })
  .strict();
export type StandaloneDiagnosticsHistory = z.infer<typeof standaloneDiagnosticsHistorySchema>;

export const standaloneDiagnosticsHostSchema = z
  .object({
    hostKey: standaloneHostKeySchema,
    siteId: platformUuidSchema.nullable(),
    siteName: z.string().nullable(),
    last: standaloneDiagnosticSummarySchema,
    license: standaloneSupportLicenseSchema.nullable(),
    devices: devicesSchema,
    /** The newest file the cloud issued for the site, to compare with the PC's file. */
    cloudLicense: z
      .object({
        sequence: z.number().int().positive(),
        validUntil: platformTimestampSchema,
      })
      .strict()
      .nullable(),
    /** `null` while no published build is known (plan ДИАГ, Р7). */
    outdated: z.boolean().nullable(),
  })
  .strict();
export const standaloneDiagnosticsOverviewSchema = z
  .object({
    hosts: z.array(standaloneDiagnosticsHostSchema).max(200),
    latestPublishedVersion: versionText,
  })
  .strict();
export type StandaloneDiagnosticsOverview = z.infer<typeof standaloneDiagnosticsOverviewSchema>;

export const standaloneDiagnosticsStatisticsQuerySchema = z
  .object({
    hostKey: standaloneHostKeySchema.optional(),
    from: standaloneMonthKeySchema.optional(),
    to: standaloneMonthKeySchema.optional(),
  })
  .strict();
export type StandaloneDiagnosticsStatisticsQuery = z.infer<
  typeof standaloneDiagnosticsStatisticsQuerySchema
>;

export const standaloneDiagnosticsStatisticsSchema = z
  .object({
    hosts: z.array(standaloneHostKeySchema).max(200),
    /** The sum covers several hosts of one tenant (a rebind counts twice for a month both reported). */
    multipleHosts: z.boolean(),
    months: z
      .array(
        z
          .object({
            month: standaloneMonthKeySchema,
            hostCount: z.number().int().positive(),
            stats: standaloneUsageMonthSchema,
          })
          .strict(),
      )
      .max(2400),
  })
  .strict();
export type StandaloneDiagnosticsStatistics = z.infer<typeof standaloneDiagnosticsStatisticsSchema>;

export const standaloneDiagnosticDetailSchema = z
  .object({
    diagnostic: standaloneDiagnosticSummarySchema,
    devices: devicesSchema,
    months: z.array(standaloneUsageMonthSchema).max(12),
    license: standaloneSupportLicenseSchema.nullable(),
  })
  .strict();
export type StandaloneDiagnosticDetail = z.infer<typeof standaloneDiagnosticDetailSchema>;

const base = "/platform/tenants/:tenantId/standalone-diagnostics";
export const platformStandaloneDiagnosticsContracts = {
  ingest: {
    method: "POST",
    path: base,
    body: standaloneDiagnosticsIngestRequestSchema,
    response: standaloneDiagnosticsIngestResponseSchema,
  },
  history: {
    method: "GET",
    path: base,
    query: standaloneDiagnosticsHistoryQuerySchema,
    response: standaloneDiagnosticsHistorySchema,
  },
  overview: {
    method: "GET",
    path: `${base}/overview`,
    response: standaloneDiagnosticsOverviewSchema,
  },
  statistics: {
    method: "GET",
    path: `${base}/statistics`,
    query: standaloneDiagnosticsStatisticsQuerySchema,
    response: standaloneDiagnosticsStatisticsSchema,
  },
  detail: {
    method: "GET",
    path: `${base}/:diagnosticId`,
    response: standaloneDiagnosticDetailSchema,
  },
} as const;
```

- [ ] **Step 5: Тесты контрактов зелёные**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-support.test.ts test/standalone-diagnostics.test.ts
```

Ожидается: `Test Files 2 passed (2)`. Если упал тест «os: Windows‮11»: символ U+202E — категория `Cf`, не `Cc`, поэтому он проходит схему; это намеренно (человекочитаемый текст, поле не исполняется), тест это и фиксирует — менять ожидание не нужно.

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
```

Ожидается: без ошибок.

- [ ] **Step 6: Падающие тесты инвентаря Lockbox**

В `deploy/yandex/test/runtime-env.test.mjs` после константы `OPTIONAL_STANDALONE_LICENSE_INVENTORY` добавить:

```js
const OPTIONAL_STANDALONE_SUPPORT_INVENTORY = `${INVENTORY}STANDALONE_SUPPORT_KEYS_JSON=\n`;
```

После теста `rejects a partially configured standalone license group (plan ЛЦ-0)` добавить:

```js
test("allows the standalone support key to be entirely absent (plan ДИАГ)", () => {
  const keys = environmentKeysFromExample(OPTIONAL_STANDALONE_SUPPORT_INVENTORY);
  const entries = Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));

  assert.deepEqual(runtimeInventoryKeyNames(keys, entries), [
    "DATABASE_URL",
    "S3_ENDPOINT",
    "SMTP_PASSWORD",
  ]);
  assert.doesNotMatch(renderRuntimeEnvironment(keys, entries), /STANDALONE_SUPPORT_/u);
});

test("accepts the standalone support key as one JSON line and rejects a multi-line value", () => {
  const keys = environmentKeysFromExample(OPTIONAL_STANDALONE_SUPPORT_INVENTORY);
  const base = Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));
  const json = JSON.stringify([
    { kid: "sup-1", pem: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n" },
  ]);
  assert.equal(json.includes("\n"), false);
  const entries = [...base, { key: "STANDALONE_SUPPORT_KEYS_JSON", textValue: json }];

  assert.deepEqual(runtimeInventoryKeyNames(keys, entries), [
    "DATABASE_URL",
    "S3_ENDPOINT",
    "SMTP_PASSWORD",
    "STANDALONE_SUPPORT_KEYS_JSON",
  ]);
  assert.match(renderRuntimeEnvironment(keys, entries), /^STANDALONE_SUPPORT_KEYS_JSON=\[/mu);
  assert.throws(
    () =>
      renderRuntimeEnvironment(keys, [
        ...base,
        {
          key: "STANDALONE_SUPPORT_KEYS_JSON",
          textValue: JSON.stringify(JSON.parse(json), null, 2),
        },
      ]),
    (error) => error.message === "runtime environment payload is invalid",
  );
});

test("still rejects an unknown key next to the standalone support key (plan ДИАГ)", () => {
  const keys = environmentKeysFromExample(OPTIONAL_STANDALONE_SUPPORT_INVENTORY);
  const entries = [
    ...Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    { key: "STANDALONE_SUPPORT_KEYS", textValue: "[]" },
  ];

  assert.throws(
    () => runtimeInventoryKeyNames(keys, entries),
    (error) => error.message === INVENTORY_FAILURE,
  );
});
```

В тесте `uses every and only the production environment example keys` (около строки 403) добавить `"STANDALONE_SUPPORT_KEYS_JSON",` в конец ожидаемого списка после `"STANDALONE_LICENSE_KEYSET_JSON",` и заменить `assert.equal(inventory.length, 56);` на `assert.equal(inventory.length, 57);`.

Запуск (FAIL первых трёх: «runtime environment inventory is invalid» от неизвестного ключа, и несовпадение списка):

```bash
node --test deploy/yandex/test/runtime-env.test.mjs
```

- [ ] **Step 7: Имя ключа в `runtime-env.mjs`, примерах и runbook**

В `deploy/yandex/runtime-env.mjs` в `OPTIONAL_ENVIRONMENT_KEY_GROUPS` добавить группу из одной записи (логика «все или ни одной» для группы из одного ключа даёт «есть или нет»; Lockbox не хранит пустых значений, поэтому ключ полностью отсутствует, пока приём выключен):

```js
  ["STANDALONE_SUPPORT_KEYS_JSON"],
```

(после группы `STANDALONE_LICENSE_*`, до закрывающей `];`).

В `.env.production.example` и `.env.example` в конец, после `STANDALONE_LICENSE_KEYSET_JSON=`, добавить одинаковый блок:

```dotenv
# Optional standalone («Markiro Автоном») support diagnostics: the PRIVATE keys that open the
# tokens `MKS1.<kid>.<body>` of «Сведения для поддержки». Leave unset until the owner's rollout:
# the API keeps running and the diagnostics tab answers «not configured» on paste. One JSON line,
# an array [{"kid":"sup-…","pem":"-----BEGIN EC PRIVATE KEY-----\n…"}] (SEC1 or PKCS8 PEM; the
# newlines as JSON `\n`). A second entry is a rotation. Its own key: never a license or grant key.
STANDALONE_SUPPORT_KEYS_JSON=
```

В `docs/runbooks/yandex-secrets.md` перед разделом `## Офлайн-гранты устройств` добавить раздел:

```md
## Диагностика автонома («Сведения для поддержки»)

Закрытый ключ поддержки хранится только в Lockbox `markiro-production-runtime` под именем
`STANDALONE_SUPPORT_KEYS_JSON` — необязательной записью (Lockbox не сохраняет пустые значения, поэтому
пока приём выключен, запись отсутствует целиком; API при этом работает, а вкладка «Диагностика» в
SaaS-админке отвечает «приём не настроен»). Значение — одна строка JSON:
`[{"kid":"sup-d11c3182","pem":"-----BEGIN EC PRIVATE KEY-----\n…\n-----END EC PRIVATE KEY-----\n"}]`.
Формат PEM — тот, что выдаёт `openssl ecparam -name prime256v1 -genkey -noout` (SEC1,
`BEGIN EC PRIVATE KEY`); PKCS8 тоже принимается. Переводы строк внутри PEM записываются как
`\n` внутри JSON-строки — значение целиком остаётся одной строкой (инвентарь отвергает значения с
переводом строки). `kid` должен совпадать с `sup-` + 8 hex SHA-256 открытой точки (его печатает
`node tools/standalone-support/decrypt.mjs --public-jwk --key <pem>`); несовпадение API пишет
предупреждением при старте и не падает. Ротация: сначала новая запись добавляется в массив (старая
остаётся, пока живы клиенты со старым открытым ключом), потом открытый ключ уходит в сборку
(`apps/standalone/proto/fixtures/support-keys.json`), старая запись удаляется последней. Ключ
поддержки — отдельный от ключей лицензий и грантов. Значение не печатать и не хранить в Git.
После публикации версии секрета повторить остановленный на `runtime-inventory` deployment для того
же immutable release SHA; вручную materialization и перезапуск API не запускать.
```

- [ ] **Step 8: Всё зелёное, коммит**

```bash
node --test deploy/yandex/test/runtime-env.test.mjs
```

Ожидается: все тесты `pass`, включая `uses every and only the production environment example keys`.

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write packages/platform-contracts/src/standalone-support.ts packages/platform-contracts/src/standalone-diagnostics.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-support.test.ts packages/platform-contracts/test/standalone-diagnostics.test.ts deploy/yandex/runtime-env.mjs deploy/yandex/test/runtime-env.test.mjs docs/runbooks/yandex-secrets.md
git diff --check
git add packages/platform-contracts/src/standalone-support.ts packages/platform-contracts/src/standalone-diagnostics.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-support.test.ts packages/platform-contracts/test/standalone-diagnostics.test.ts deploy/yandex/runtime-env.mjs deploy/yandex/test/runtime-env.test.mjs .env.example .env.production.example docs/runbooks/yandex-secrets.md
git commit -m "feat(diagnostics): K1 — support payload v1/v2 and ingestion contracts, support key in the Lockbox inventory"
```

---

### Task 2 (Д1): Таблицы Postgres и миграция 0194

**Files:**

- Create: `packages/db/src/schema/standalone-support-diagnostics.ts`, `packages/db/migrations/0194_standalone_support_diagnostics.sql` (+ снимок и запись журнала от drizzle-kit)
- Modify: `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`
- Test: `packages/db/test/standalone-support-diagnostics-schema.test.ts`, `packages/db/test/standalone-support-diagnostics-migration.test.ts`

**Interfaces:**

- Consumes: `organization` (`schema/auth.ts`), `platformUsers` (`schema/platform-auth.ts`), `standaloneSites` (`schema/standalone-licenses.ts`).
- Produces: `standaloneSupportDiagnostics` и `standaloneSupportUsageMonths` (экспорт `@markiro/db`); имена ограничений, на которые опирается API: `standalone_support_diagnostics_blob_uq`, `standalone_support_diagnostics_host_generated_uq`, `standalone_support_diagnostics_tenant_id_uq`, `standalone_support_diagnostics_tenant_site_fk`, `standalone_support_usage_months_pkey`, `standalone_support_usage_months_source_fk`.

- [ ] **Step 1: Падающий тест схемы**

Создать `packages/db/test/standalone-support-diagnostics-schema.test.ts`:

```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

const uniques = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).uniqueConstraints.map((constraint) => [
    constraint.getName(),
    constraint.columns.map((column) => column.name).join(","),
  ]);

describe("standalone support diagnostics schema (plan ДИАГ Д1)", () => {
  it("exports the history and the monthly aggregates", () => {
    expect(schema).toHaveProperty("standaloneSupportDiagnostics");
    expect(schema).toHaveProperty("standaloneSupportUsageMonths");
  });

  it("is idempotent by the token hash (global) and by the exact generated instant per host", () => {
    expect(uniques(schema.standaloneSupportDiagnostics)).toEqual(
      expect.arrayContaining([
        ["standalone_support_diagnostics_blob_uq", "blob_sha256"],
        ["standalone_support_diagnostics_host_generated_uq", "tenant_id,host_key,generated_at"],
        ["standalone_support_diagnostics_tenant_id_uq", "tenant_id,id"],
      ]),
    );
  });

  it("binds a site and an aggregate's source by composite tenant keys", () => {
    const history = getTableConfig(schema.standaloneSupportDiagnostics);
    expect(
      history.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_support_diagnostics_tenant_site_fk" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,site_id",
      ),
    ).toBe(true);
    const months = getTableConfig(schema.standaloneSupportUsageMonths);
    expect(
      months.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_support_usage_months_source_fk" &&
          key.onDelete === "cascade" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,source_diagnostic_id",
      ),
    ).toBe(true);
    expect(months.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "host_key",
      "month",
    ]);
  });

  it("deletes with the tenant", () => {
    for (const table of [
      schema.standaloneSupportDiagnostics,
      schema.standaloneSupportUsageMonths,
    ]) {
      const tenantFk = getTableConfig(table).foreignKeys.find(
        (key) => key.reference().foreignTable === schema.organization,
      );
      expect(tenantFk?.onDelete).toBe("cascade");
    }
  });
});
```

Запуск (FAIL: экспортов нет):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/standalone-support-diagnostics-schema.test.ts
```

- [ ] **Step 2: Схема**

Создать `packages/db/src/schema/standalone-support-diagnostics.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";
import { standaloneSites } from "./standalone-licenses.js";

const HOST_KEY = sql`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/**
 * The history of support diagnostics of «Markiro Автоном» sites (plan ДИАГ):
 * one row per accepted token. The token and the pasted text are never stored —
 * `payload` is the validated plaintext, enough to recompute the aggregates.
 * Idempotent by the token's SHA-256 (globally) and by the exact generated
 * instant per host (a re-made report from the same moment is a repeat).
 */
export const standaloneSupportDiagnostics = pgTable(
  "standalone_support_diagnostics",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    siteId: uuid("site_id"),
    hostKey: text("host_key").notNull(),
    blobSha256: text("blob_sha256").notNull(),
    kid: text("kid").notNull(),
    payloadVersion: smallint("payload_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    receivedByPlatformUserId: text("received_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    appVersion: text("app_version"),
    hostVersion: text("host_version"),
    pcRole: text("pc_role"),
    devicesStation: integer("devices_station").notNull(),
    devicesOffice: integer("devices_office").notNull(),
    devicesHandheld: integer("devices_handheld").notNull(),
    license: jsonb("license").$type<Record<string, unknown>>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    unique("standalone_support_diagnostics_tenant_id_uq").on(t.tenantId, t.id),
    unique("standalone_support_diagnostics_blob_uq").on(t.blobSha256),
    unique("standalone_support_diagnostics_host_generated_uq").on(
      t.tenantId,
      t.hostKey,
      t.generatedAt,
    ),
    index("standalone_support_diagnostics_tenant_generated_idx").on(
      t.tenantId,
      t.generatedAt.desc(),
      t.id.desc(),
    ),
    index("standalone_support_diagnostics_tenant_host_generated_idx").on(
      t.tenantId,
      t.hostKey,
      t.generatedAt.desc(),
    ),
    index("standalone_support_diagnostics_received_idx").on(t.receivedAt),
    foreignKey({
      name: "standalone_support_diagnostics_tenant_site_fk",
      columns: [t.tenantId, t.siteId],
      foreignColumns: [standaloneSites.tenantId, standaloneSites.id],
    }),
    check(
      "standalone_support_diagnostics_host_key_check",
      sql`${t.hostKey} = 'unknown' or ${t.hostKey} ~ ${HOST_KEY}`,
    ),
    check("standalone_support_diagnostics_blob_check", sql`${t.blobSha256} ~ '^[0-9a-f]{64}$'`),
    check("standalone_support_diagnostics_kid_check", sql`length(${t.kid}) between 1 and 32`),
    check("standalone_support_diagnostics_version_check", sql`${t.payloadVersion} in (1, 2)`),
    check(
      "standalone_support_diagnostics_versions_check",
      sql`(${t.appVersion} is null or length(${t.appVersion}) <= 64) and (${t.hostVersion} is null or length(${t.hostVersion}) <= 64)`,
    ),
    check(
      "standalone_support_diagnostics_role_check",
      sql`${t.pcRole} is null or ${t.pcRole} in ('host', 'station', 'office')`,
    ),
    check(
      "standalone_support_diagnostics_devices_check",
      sql`${t.devicesStation} >= 0 and ${t.devicesOffice} >= 0 and ${t.devicesHandheld} >= 0`,
    ),
    check(
      "standalone_support_diagnostics_json_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 65536 and (${t.license} is null or (jsonb_typeof(${t.license}) = 'object' and octet_length(${t.license}::text) <= 8192))`,
    ),
  ],
);

/** The newest report's counts per tenant, host and calendar month. */
export const standaloneSupportUsageMonths = pgTable(
  "standalone_support_usage_months",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    hostKey: text("host_key").notNull(),
    month: text("month").notNull(),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull(),
    sourceDiagnosticId: uuid("source_diagnostic_id").notNull(),
    sourceGeneratedAt: timestamp("source_generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "standalone_support_usage_months_pkey",
      columns: [t.tenantId, t.hostKey, t.month],
    }),
    foreignKey({
      name: "standalone_support_usage_months_source_fk",
      columns: [t.tenantId, t.sourceDiagnosticId],
      foreignColumns: [standaloneSupportDiagnostics.tenantId, standaloneSupportDiagnostics.id],
    }).onDelete("cascade"),
    check(
      "standalone_support_usage_months_host_key_check",
      sql`${t.hostKey} = 'unknown' or ${t.hostKey} ~ ${HOST_KEY}`,
    ),
    check(
      "standalone_support_usage_months_month_check",
      sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "standalone_support_usage_months_stats_check",
      sql`jsonb_typeof(${t.stats}) = 'object' and octet_length(${t.stats}::text) <= 4096`,
    ),
  ],
);
```

В `packages/db/src/schema.ts` после строки экспорта `./schema/standalone-licenses.js` добавить `export * from "./schema/standalone-support-diagnostics.js";`; в `packages/db/drizzle.config.ts` после `"./src/schema/standalone-licenses.ts",` добавить `"./src/schema/standalone-support-diagnostics.ts",`.

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/standalone-support-diagnostics-schema.test.ts
```

Ожидается: `4 passed`. Если упал «deletes with the tenant» из-за `reference().foreignTable` — в этой версии drizzle у `reference()` поле называется `foreignTable`; иначе заменить проверку на `key.reference().foreignColumns[0]?.name === "id" && key.onDelete === "cascade"` в пределах двух внешних ключей на `organization` (не ослаблять `cascade`).

- [ ] **Step 3: Генерация и просмотр миграции**

```bash
set -a; source .env; set +a
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec drizzle-kit generate --name standalone_support_diagnostics
ls packages/db/migrations | tail -3
tail -8 packages/db/migrations/meta/_journal.json
```

Ожидается: файл `0194_standalone_support_diagnostics.sql`, `meta/0194_snapshot.json`, в журнале `"idx": 194`, `"tag": "0194_standalone_support_diagnostics"`. (Если drizzle-kit назовёт файл иначе или даст другой номер — остановиться: в журнале перед этим должна быть `0193_custom_logo_entitlement`.) Открыть SQL и сверить по списку: две `CREATE TABLE`; `tenant_id text NOT NULL`; все `CHECK` из схемы; `ON DELETE cascade` у трёх внешних ключей (`organization` ×2 и `source_fk`) и **без** `ON DELETE` у `tenant_site_fk` и `received_by_platform_user_id`; `UNIQUE` трёх имён; индексы с `DESC`; ни одной строки `ALTER`/`DROP` чужих таблиц. Применённые миграции не править.

- [ ] **Step 4: Падающий тест миграции на БД**

Создать `packages/db/test/standalone-support-diagnostics-migration.test.ts` (структура — как `standalone-licenses-migration.test.ts`):

```ts
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixturePool } from "./support/close-pool.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("standalone support diagnostics tables (plan ДИАГ Д1)", () => {
  const name = `markiro_diag_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  const scratch = mkdtempSync(join(tmpdir(), "diag-migrations-"));
  const siteA = randomUUID();
  const hostA = randomUUID();
  const HASH = (n: number) => n.toString(16).padStart(64, "0");

  async function diagnostic(
    overrides: {
      id?: string;
      tenant?: string;
      site?: string | null;
      hostKey?: string;
      hash?: string;
      generatedAt?: string;
      version?: number;
      role?: string | null;
    } = {},
  ) {
    const id = overrides.id ?? randomUUID();
    await pool.query(
      `INSERT INTO standalone_support_diagnostics
         (id, tenant_id, site_id, host_key, blob_sha256, kid, payload_version, generated_at,
          received_by_platform_user_id, pc_role, devices_station, devices_office, devices_handheld, payload)
       VALUES ($1, $2, $3, $4, $5, 'sup-1', $6, $7, 'diag-admin', $8, 1, 1, 0, '{"v":2}')`,
      [
        id,
        overrides.tenant ?? "diag-a",
        overrides.site === undefined ? siteA : overrides.site,
        overrides.hostKey ?? hostA,
        overrides.hash ?? HASH(1),
        overrides.version ?? 2,
        overrides.generatedAt ?? "2026-10-14T09:00:00Z",
        overrides.role === undefined ? "host" : overrides.role,
      ],
    );
    return id;
  }

  async function month(tenant: string, hostKey: string, key: string, source: string) {
    await pool.query(
      `INSERT INTO standalone_support_usage_months (tenant_id, host_key, month, stats, source_diagnostic_id, source_generated_at)
       VALUES ($1, $2, $3, '{"month":"2026-10"}', $4, '2026-10-14T09:00:00Z')`,
      [tenant, hostKey, key, source],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    // Update from 0193: apply every migration but the last, then the real folder.
    cpSync(migrationsFolder, scratch, { recursive: true });
    const journalPath = join(scratch, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.at(-1)?.tag).toBe("0194_standalone_support_diagnostics");
    journal.entries.pop();
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: scratch });
    const before = await pool.query("SELECT to_regclass('standalone_support_diagnostics') AS t");
    expect(before.rows[0]).toEqual({ t: null });
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('diag-a', 'A', 'diag-a', now()), ('diag-b', 'B', 'diag-b', now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id, email, name, role, status, two_factor_enabled) VALUES ('diag-admin', 'diag@example.invalid', 'DIAG', 'platform_admin', 'active', true)",
    );
    await pool.query(
      `INSERT INTO standalone_sites (id, tenant_id, host_id, name, last_activation_request, host_history, request_id, created_by_platform_user_id)
       VALUES ($1, 'diag-a', $2, 'Цех', '{}', '[{"hostId":"x"}]', $3, 'diag-admin')`,
      [siteA, hostA, randomUUID()],
    );
  }, 180_000);

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await closeFixturePool(pool);
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
  });

  it("keeps a token once, globally, and a host's exact generated instant once per tenant", async () => {
    await diagnostic({ hash: HASH(1) });
    await expect(diagnostic({ hash: HASH(1), tenant: "diag-b", site: null })).rejects.toMatchObject(
      { code: "23505", constraint: "standalone_support_diagnostics_blob_uq" },
    );
    await expect(diagnostic({ hash: HASH(2) })).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_support_diagnostics_host_generated_uq",
    });
    await diagnostic({ hash: HASH(3), generatedAt: "2026-10-14T09:00:01Z" });
    await diagnostic({ hash: HASH(4), tenant: "diag-b", site: null });
  });

  it("refuses another tenant's site and malformed keys, versions and roles", async () => {
    await expect(
      diagnostic({ hash: HASH(5), tenant: "diag-b", generatedAt: "2026-10-15T09:00:00Z" }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_support_diagnostics_tenant_site_fk",
    });
    const bad = [
      { hash: HASH(6), hostKey: "Host-1", c: "standalone_support_diagnostics_host_key_check" },
      { hash: "XYZ", c: "standalone_support_diagnostics_blob_check" },
      { hash: HASH(7), version: 3, c: "standalone_support_diagnostics_version_check" },
      { hash: HASH(8), role: "kiosk", c: "standalone_support_diagnostics_role_check" },
    ];
    for (const { c, ...overrides } of bad) {
      await expect(
        diagnostic({ ...overrides, generatedAt: "2026-10-16T09:00:00Z" }),
      ).rejects.toMatchObject({ code: "23514", constraint: c });
    }
    await diagnostic({
      hash: HASH(9),
      hostKey: "unknown",
      site: null,
      version: 1,
      role: null,
      generatedAt: "2026-10-17T09:00:00Z",
    });
  });

  it("keys the months by tenant, host and month, with a same-tenant source", async () => {
    const source = await diagnostic({ hash: HASH(10), generatedAt: "2026-10-18T09:00:00Z" });
    await month("diag-a", hostA, "2026-10", source);
    await expect(month("diag-a", hostA, "2026-10", source)).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_support_usage_months_pkey",
    });
    await expect(month("diag-b", hostA, "2026-10", source)).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_support_usage_months_source_fk",
    });
    await expect(month("diag-a", hostA, "2026-13", source)).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_support_usage_months_month_check",
    });
  });

  it("deletes the months with their source and everything with the tenant", async () => {
    const source = await diagnostic({ hash: HASH(11), generatedAt: "2026-10-19T09:00:00Z" });
    await month("diag-a", hostA, "2026-09", source);
    await pool.query("DELETE FROM standalone_support_diagnostics WHERE id = $1", [source]);
    const months = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_usage_months WHERE month = '2026-09' AND tenant_id = 'diag-a'",
    );
    expect(months.rows[0]).toEqual({ n: 0 });
    const kept = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'",
    );
    expect(kept.rows[0]).toEqual({ n: 1 });
    await pool.query("DELETE FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'");
    await diagnostic({
      hash: HASH(12),
      tenant: "diag-b",
      site: null,
      generatedAt: "2026-10-20T09:00:00Z",
    });
    await pool.query("DELETE FROM organization WHERE id = 'diag-b'");
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'",
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });
});
```

Если в журнале поле называется не `entries` (проверить `head -5 packages/db/migrations/meta/_journal.json`), использовать фактическое имя.

- [ ] **Step 5: Прогон, сборка, коммит**

```bash
set -a; source .env; set +a
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/standalone-support-diagnostics-schema.test.ts test/standalone-support-diagnostics-migration.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build
```

Ожидается: все тесты зелёные; миграционный тест **не пропущен** (при пропуске без `DATABASE_URL` назвать это в отчёте и не считать задачу проверенной по БД). Тест «порядка миграций» пакета (`pnpm … test` обходит существующие проверки журнала) должен остаться зелёным.

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write packages/db/src/schema/standalone-support-diagnostics.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/test/standalone-support-diagnostics-schema.test.ts packages/db/test/standalone-support-diagnostics-migration.test.ts
git diff --check
git add packages/db/src/schema/standalone-support-diagnostics.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/migrations/0194_standalone_support_diagnostics.sql packages/db/migrations/meta/0194_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/standalone-support-diagnostics-schema.test.ts packages/db/test/standalone-support-diagnostics-migration.test.ts
git commit -m "feat(diagnostics): D1 — support diagnostics history and monthly aggregates, migration 0194 (renumber before any PR into main)"
```

В описании будущего PR и в Д2 (ROADMAP, разд. 6) стоит строка «Облако (Drizzle): 0192, 0193, 0194 — перенумеровать от origin/main перед PR».

---

### Task 3 (А1): Разбор токена, ключи поддержки из окружения, проверка при старте

**Files:**

- Create: `apps/api/src/modules/standalone-diagnostics/support-blob.ts`, `apps/api/src/modules/standalone-diagnostics/standalone-support-keys.ts`, `apps/api/test/support/standalone-support-token.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/test/env.test.ts`
- Test: `apps/api/test/standalone-support-blob.test.ts`, `apps/api/test/standalone-support-keys.test.ts`

**Interfaces:**

- Consumes: формат `MKS1` (`support-crypto.ts`, `decrypt.mjs`); `zod`.
- Produces: `openSupportBlob(text, keys)` → `OpenedSupportBlob`; `SupportPrivateKey { kid, privateKey }`; `SupportBlobFailure`; `MAX_TOKEN_CHARS`, `MAX_INFLATED_BYTES`, `MAX_PAYLOAD_BYTES`; `configureStandaloneSupportKeys(env)` → `readonly SupportPrivateKey[] | null`; `STANDALONE_SUPPORT_KEYS` (токен DI); `STANDALONE_SUPPORT_KEYS_ERROR`; `expectedSupportKid(privateKey)`; `supportKeyKidMismatches(keys)`; тестовый писатель `sealSupportToken`.

`support-blob.ts` обязан импортировать **только** `node:`-модули: его относительным путём подключает тест автонома (Ч1), у которого другое разрешение модулей.

- [ ] **Step 1: Независимый писатель токена для тестов**

Создать `apps/api/test/support/standalone-support-token.ts` (формат по описанию в шапке `support-crypto.ts`, не по коду API):

```ts
import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { deflateRawSync } from "node:zlib";

/** `MKS1.<kid>.<base64url(flag ‖ epk ‖ iv ‖ ciphertext ‖ tag)>`, written again from the format's description. */
export function sealSupportToken(
  plain: string | Buffer,
  recipient: KeyObject,
  kid: string,
  compress = true,
): string {
  const data = Buffer.from(plain);
  const body = compress ? deflateRawSync(data) : data;
  const flag = Buffer.from([compress ? 1 : 0]);
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = ephemeral.publicKey.export({ format: "jwk" });
  const epk = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
  const label = Buffer.from(`MKS1.${kid}`, "utf8");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([label, flag]));
  const sealed = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return `MKS1.${kid}.${Buffer.concat([flag, epk, iv, sealed]).toString("base64url")}`;
}

export const TOKEN_OFFSETS = { flag: 0, epk: 1, iv: 66, sealed: 78 } as const;

/** The token with one byte of its body changed (xor 1). */
export function flipTokenByte(token: string, at: number): string {
  const [version, kid, body] = token.split(".");
  const bytes = Buffer.from(body ?? "", "base64url");
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return `${version}.${kid}.${bytes.toString("base64url")}`;
}

/** The token with the same bytes in a non-canonical base64url (unused trailing bits changed). */
export function nonCanonicalToken(token: string): string {
  const [version, kid, body = ""] = token.split(".");
  if (body.length % 4 === 0) throw new Error("this token has no unused bits");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(body.at(-1) ?? "");
  return `${version}.${kid}.${body.slice(0, -1)}${alphabet[last ^ 1]}`;
}

/** A month as the client sends it, for payload fixtures. */
export function usageMonth(month: string, accepted = 7020) {
  return {
    month,
    shifts: {
      aggregation: 6,
      validation: 1,
      validationPrint: 0,
      fromOffice: 5,
      fromStation: 2,
      withPallets: 2,
    },
    scans: { accepted, duplicates: 64, rejected: 9 },
    boxes: { closed: 585, disassembled: 0, codes: accepted },
    pallets: { closed: 13, disassembled: 0 },
    exceptions: {
      boxUndo: 4,
      boxClear: 0,
      boxReprint: 2,
      boxDisassemble: 0,
      palletReprint: 0,
      palletDisassemble: 0,
    },
    conflicts: { late: 1, displaced: 0, reviewed: 0 },
    reprints: { warehouse: 0, unitLabel: 0 },
    disaggregationApplied: 0,
    syncRejected: 0,
  };
}

export const SUPPORT_LICENSE = {
  state: "active",
  plan: "subscription",
  licenseId: "11111111-2222-4333-8444-555555555555",
  sequence: 3,
  kid: "lic-1",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2027-10-01T00:00:00Z",
  graceDays: 14,
  daysLeft: 350,
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 3, used: 2, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 5, used: 1, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: false,
    handheld: true,
    customLogo: false,
  },
  innMatches: true,
};

export function supportPayloadV2(
  overrides: { hostId?: string | null; generatedAt?: string; months?: string[] } = {},
) {
  return {
    v: 2,
    generatedAt: overrides.generatedAt ?? "2026-10-14T09:00:00.000Z",
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    months: (overrides.months ?? ["2026-09", "2026-10"]).map((month) => usageMonth(month)),
    devices: { station: 3, office: 2, handheld: 1 },
    hostId:
      overrides.hostId === undefined ? "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" : overrides.hostId,
    role: "host",
    os: "Windows 11",
    arch: "x64",
    webview: "WebView2 130.0.2849.80",
    license: SUPPORT_LICENSE,
  };
}

export function supportPayloadV1(generatedAt = "2026-10-14T09:00:00.000Z") {
  return {
    v: 1,
    generatedAt,
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    months: [usageMonth("2026-10")],
    devices: { station: 3, office: 2, handheld: 1 },
  };
}

/** A support text as the client builds it: an open part and the token on its own line. */
export function supportText(token: string): string {
  return [
    "Markiro Автоном — сведения для поддержки",
    "Сформировано (UTC): 2026-10-14T09:00:00.000Z",
    "",
    "Версия приложения: 0.2.0",
    "Хост: https://127.0.0.1:45710 (id 3f1c2d4e)",
    "",
    "Данные для анализа",
    "Зашифрованные данные",
    token,
    "",
  ].join("\r\n");
}
```

- [ ] **Step 2: Падающий тест разбора токена**

Создать `apps/api/test/standalone-support-blob.test.ts`:

```ts
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  openSupportBlob,
  type SupportPrivateKey,
} from "../src/modules/standalone-diagnostics/support-blob";
import {
  TOKEN_OFFSETS,
  flipTokenByte,
  nonCanonicalToken,
  sealSupportToken,
  supportPayloadV2,
  supportText,
} from "./support/standalone-support-token";

function pair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { key: { kid, privateKey } satisfies SupportPrivateKey, publicKey };
}
const reason = (result: ReturnType<typeof openSupportBlob>) => (result.ok ? null : result.reason);

describe("opening a support token (plan ДИАГ А1)", () => {
  const a = pair("sup-a");
  const payload = JSON.stringify(supportPayloadV2());

  it("opens a compressed and a plain token found inside the whole support text", () => {
    for (const compress of [true, false]) {
      const token = sealSupportToken(payload, a.publicKey, "sup-a", compress);
      const opened = openSupportBlob(supportText(token), [a.key]);
      expect(opened).toMatchObject({ ok: true, kid: "sup-a", compressed: compress });
      if (!opened.ok) throw new Error("not opened");
      expect(opened.json).toEqual(JSON.parse(payload));
      expect(opened.blobSha256).toBe(createHash("sha256").update(token).digest("hex"));
    }
  });

  it("takes the first token of the text and says no_token when there is none", () => {
    const first = sealSupportToken(JSON.stringify({ n: 1 }), a.publicKey, "sup-a");
    const second = sealSupportToken(JSON.stringify({ n: 2 }), a.publicKey, "sup-a");
    const opened = openSupportBlob(`${first}\n${second}`, [a.key]);
    expect(opened.ok && opened.json).toEqual({ n: 1 });
    expect(reason(openSupportBlob("Версия 1\r\nни одного токена", [a.key]))).toBe("no_token");
    expect(reason(openSupportBlob("", [a.key]))).toBe("no_token");
  });

  it("answers undecryptable for a change in any zone of the token, never an exception", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a", false);
    const total = Buffer.from(token.split(".")[2] ?? "", "base64url").length;
    const zones = {
      flag: TOKEN_OFFSETS.flag,
      epk: TOKEN_OFFSETS.epk + 20,
      iv: TOKEN_OFFSETS.iv + 3,
      ciphertext: TOKEN_OFFSETS.sealed + 2,
      tag: total - 1,
    };
    for (const [zone, at] of Object.entries(zones)) {
      expect(reason(openSupportBlob(flipTokenByte(token, at), [a.key])), zone).toBe(
        "undecryptable",
      );
    }
  });

  it("rejects an unknown flag, a short token, a non-canonical body and an off-curve key", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a", false);
    const bytes = Buffer.from(token.split(".")[2] ?? "", "base64url");
    const rebuilt = (changed: Buffer) => `MKS1.sup-a.${changed.toString("base64url")}`;
    const flagTwo = Buffer.from(bytes);
    flagTwo[0] = 2;
    expect(reason(openSupportBlob(rebuilt(flagTwo), [a.key]))).toBe("token_malformed");
    expect(reason(openSupportBlob(rebuilt(bytes.subarray(0, 60)), [a.key]))).toBe(
      "token_malformed",
    );
    // Pad the plaintext until the body has unused trailing bits, then alias its last character.
    let aliased: string | null = null;
    for (let pad = 0; pad < 4 && aliased === null; pad += 1) {
      const candidate = sealSupportToken(
        `${payload}${" ".repeat(pad)}`,
        a.publicKey,
        "sup-a",
        false,
      );
      if ((candidate.split(".")[2] ?? "").length % 4 !== 0) aliased = nonCanonicalToken(candidate);
    }
    expect(aliased).not.toBeNull();
    expect(reason(openSupportBlob(aliased ?? "", [a.key]))).toBe("token_malformed");
    const offCurve = Buffer.from(bytes);
    offCurve.fill(0x11, 2, 66);
    expect(reason(openSupportBlob(rebuilt(offCurve), [a.key]))).toBe("undecryptable");
  });

  it("binds the key id: swapping it in the prefix fails, an unknown one is unknown_key", () => {
    const b = pair("sup-b");
    const sameKeyOtherKid: SupportPrivateKey = { kid: "sup-b", privateKey: a.key.privateKey };
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    const swapped = token.replace("MKS1.sup-a.", "MKS1.sup-b.");
    expect(reason(openSupportBlob(swapped, [a.key, sameKeyOtherKid]))).toBe("undecryptable");
    expect(reason(openSupportBlob(token, [b.key]))).toBe("unknown_key");
    expect(reason(openSupportBlob(token, []))).toBe("unknown_key");
  });

  it("a token under another key with the same kid is undecryptable; a rotated second key opens", () => {
    const impostor = pair("sup-a");
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    expect(reason(openSupportBlob(token, [impostor.key]))).toBe("undecryptable");
    const b = pair("sup-b");
    const second = sealSupportToken(payload, b.publicKey, "sup-b");
    expect(openSupportBlob(second, [a.key, b.key]).ok).toBe(true);
    expect(openSupportBlob(token, [a.key, b.key]).ok).toBe(true);
  });

  it("refuses a compression bomb without inflating it, and an oversized plain payload", () => {
    const bomb = sealSupportToken(Buffer.alloc(2 * 1024 * 1024, 0x20), a.publicKey, "sup-a", true);
    expect(bomb.length).toBeLessThan(16 * 1024);
    expect(reason(openSupportBlob(bomb, [a.key]))).toBe("payload_too_large");
    const plain = sealSupportToken(
      Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20),
      a.publicKey,
      "sup-a",
      false,
    );
    expect(reason(openSupportBlob(plain, [a.key]))).toBe("token_too_large");
    const inflatedMedium = sealSupportToken(
      Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20),
      a.publicKey,
      "sup-a",
      true,
    );
    expect(reason(openSupportBlob(inflatedMedium, [a.key]))).toBe("payload_too_large");
  });

  it("refuses a token longer than 16 KiB before decoding it", () => {
    const token = sealSupportToken(
      Buffer.from(JSON.stringify({ pad: "x".repeat(13_000) })),
      a.publicKey,
      "sup-a",
      false,
    );
    expect(token.length).toBeGreaterThan(16 * 1024);
    expect(reason(openSupportBlob(token, [a.key]))).toBe("token_too_large");
  });

  it("separates a payload that is not UTF-8 or not JSON from an authentication failure", () => {
    const badUtf8 = sealSupportToken(Buffer.from([0xff, 0xfe, 0xfd]), a.publicKey, "sup-a", false);
    expect(reason(openSupportBlob(badUtf8, [a.key]))).toBe("payload_invalid");
    const notJson = sealSupportToken("{not json", a.publicKey, "sup-a", true);
    expect(reason(openSupportBlob(notJson, [a.key]))).toBe("payload_invalid");
  });

  it("never throws on mangled input of any shape", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    const body = Buffer.from(token.split(".")[2] ?? "", "base64url");
    for (let at = 0; at < body.length; at += 7) {
      const copy = Buffer.from(body);
      copy[at] = (copy[at] ?? 0) ^ 0xff;
      expect(() =>
        openSupportBlob(`MKS1.sup-a.${copy.toString("base64url")}`, [a.key]),
      ).not.toThrow();
    }
    for (const junk of ["MKS1.", "MKS1..", "MKS1.x.", "MKS1.sup-a.!!!", "MKS1.sup-a.AA"]) {
      expect(() => openSupportBlob(junk, [a.key])).not.toThrow();
    }
  });
});
```

Запуск (FAIL — модуля нет):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-support-blob.test.ts
```

- [ ] **Step 3: `support-blob.ts`**

Создать `apps/api/src/modules/standalone-diagnostics/support-blob.ts`:

```ts
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { inflateRawSync } from "node:zlib";

/**
 * Opens the token `MKS1.<kid>.<base64url(flag ‖ epk(65) ‖ iv(12) ‖ ciphertext ‖ tag(16))>` of a
 * «Сведения для поддержки» text (writer: `apps/standalone/src/office/info/support-crypto.ts`,
 * the maker's tool: `tools/standalone-support/decrypt.mjs`). ECDH P-256 + HKDF-SHA256 (empty
 * salt, info `MKS1.<kid>` ‖ epk) + AES-256-GCM, AAD `MKS1.<kid>` ‖ flag; flag 1 is raw deflate.
 *
 * The token is an operator's paste: every size is bounded before the next step, a changed key
 * id, flag, key, nonce or ciphertext all answer `undecryptable` (no oracle), and the inflate
 * stops at a ceiling so a 16 KiB bomb cannot grow into gigabytes. Imports `node:` modules only:
 * the standalone app's parity test reads this file by path.
 */
export type SupportBlobFailure =
  | "no_token"
  | "token_malformed"
  | "token_too_large"
  | "unknown_key"
  | "undecryptable"
  | "payload_too_large"
  | "payload_invalid";

export interface SupportPrivateKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export type OpenedSupportBlob =
  | {
      ok: true;
      kid: string;
      compressed: boolean;
      json: unknown;
      /** SHA-256 of the canonical token string (hex): the idempotency key. */
      blobSha256: string;
    }
  | { ok: false; reason: SupportBlobFailure; kid?: string };

export const MAX_TOKEN_CHARS = 16 * 1024;
export const MAX_INFLATED_BYTES = 256 * 1024;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const EPK_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN = /MKS1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+/u;
const KID = /^[A-Za-z0-9_-]{1,32}$/u;

function fail(reason: SupportBlobFailure, kid?: string): OpenedSupportBlob {
  return kid === undefined ? { ok: false, reason } : { ok: false, reason, kid };
}

export function openSupportBlob(
  text: string,
  keys: readonly SupportPrivateKey[],
): OpenedSupportBlob {
  const match = TOKEN.exec(text);
  if (match === null) return fail("no_token");
  const token = match[0];
  if (token.length > MAX_TOKEN_CHARS) return fail("token_too_large");
  const parts = token.split(".");
  const kid = parts[1];
  const body = parts[2];
  if (parts.length !== 3 || kid === undefined || body === undefined || !KID.test(kid))
    return fail("token_malformed");
  const bytes = Buffer.from(body, "base64url");
  // A lenient decoder ignores unused trailing bits; only the canonical text may reach the hash.
  if (bytes.toString("base64url") !== body) return fail("token_malformed", kid);
  if (bytes.length < 1 + EPK_BYTES + IV_BYTES + TAG_BYTES) return fail("token_malformed", kid);
  const flag = bytes[0];
  if (flag !== 0 && flag !== 1) return fail("token_malformed", kid);
  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) return fail("unknown_key", kid);

  const epk = bytes.subarray(1, 1 + EPK_BYTES);
  const iv = bytes.subarray(1 + EPK_BYTES, 1 + EPK_BYTES + IV_BYTES);
  const sealed = bytes.subarray(1 + EPK_BYTES + IV_BYTES);
  let plain: Buffer;
  try {
    if (epk[0] !== 4) throw new Error("not an uncompressed point");
    const ephemeral = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: epk.subarray(1, 33).toString("base64url"),
        y: epk.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    const shared = diffieHellman({ privateKey: key.privateKey, publicKey: ephemeral });
    const label = Buffer.from(`MKS1.${kid}`, "utf8");
    const aes = Buffer.from(
      hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
    );
    const decipher = createDecipheriv("aes-256-gcm", aes, iv);
    decipher.setAAD(Buffer.concat([label, Buffer.from([flag])]));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    plain = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return fail("undecryptable", kid);
  }

  if (flag === 1) {
    try {
      plain = inflateRawSync(plain, { maxOutputLength: MAX_INFLATED_BYTES });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      return fail(code === "ERR_BUFFER_TOO_LARGE" ? "payload_too_large" : "payload_invalid", kid);
    }
  }
  if (plain.length > MAX_PAYLOAD_BYTES) return fail("payload_too_large", kid);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    return fail("payload_invalid", kid);
  }
  return {
    ok: true,
    kid,
    compressed: flag === 1,
    json,
    blobSha256: createHash("sha256").update(token).digest("hex"),
  };
}
```

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-support-blob.test.ts
```

Ожидается: `9 passed`. Если «oversized plain payload» дал `payload_too_large`, а не `token_too_large`, то токен для 64 КиБ+1 несжатого — это ≈ 87 тыс. знаков, то есть длиннее 16 КиБ и поэтому `token_too_large`: тест так и написан (первая защита срабатывает раньше). Проверка `MAX_PAYLOAD_BYTES` в коде достижима только через сжатый путь — её закрывает случай `inflatedMedium` (66 КиБ пробелов сжимаются в ~100 байт).

- [ ] **Step 4: Падающий тест ключей, включая формат SEC1 владельца**

Создать `apps/api/test/standalone-support-keys.test.ts`:

```ts
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSupportBlob } from "../src/modules/standalone-diagnostics/support-blob";
import {
  STANDALONE_SUPPORT_KEYS_ERROR,
  configureStandaloneSupportKeys,
  expectedSupportKid,
  supportKeyKidMismatches,
} from "../src/modules/standalone-diagnostics/standalone-support-keys";
import { sealSupportToken, supportPayloadV2 } from "./support/standalone-support-token";

function generated(type: "sec1" | "pkcs8" = "sec1", namedCurve = "prime256v1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve });
  return { privateKey, publicKey, pem: privateKey.export({ type, format: "pem" }).toString() };
}
const env = (value: unknown) => ({ STANDALONE_SUPPORT_KEYS_JSON: JSON.stringify(value) });

describe("standalone support keys from the environment (plan ДИАГ А1)", () => {
  it("is disabled, not failing, when the variable is unset or empty", () => {
    expect(configureStandaloneSupportKeys({})).toBeNull();
    expect(configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: "" })).toBeNull();
    expect(configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: "  " })).toBeNull();
  });

  it("the owner's key in SEC1 'BEGIN EC PRIVATE KEY' format opens a token (Lockbox one-line JSON)", () => {
    const owner = generated("sec1");
    expect(owner.pem.startsWith("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
    const value = JSON.stringify([{ kid: "sup-owner", pem: owner.pem }]);
    expect(value.includes("\n")).toBe(false); // the inventory refuses a value with a line break
    const keys = configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: value });
    expect(keys).toHaveLength(1);
    const token = sealSupportToken(
      JSON.stringify(supportPayloadV2()),
      owner.publicKey,
      "sup-owner",
    );
    const opened = openSupportBlob(token, keys ?? []);
    expect(opened).toMatchObject({ ok: true, kid: "sup-owner" });
  });

  it("also accepts PKCS8, and a PEM whose newlines were escaped twice", () => {
    const pkcs8 = generated("pkcs8");
    const sec1 = generated("sec1");
    const doubled = sec1.pem.replaceAll("\n", "\\n");
    const keys = configureStandaloneSupportKeys(
      env([
        { kid: "sup-p8", pem: pkcs8.pem },
        { kid: "sup-esc", pem: doubled },
      ]),
    );
    expect(keys?.map((key) => key.kid)).toEqual(["sup-p8", "sup-esc"]);
    for (const [pair, kid] of [
      [pkcs8, "sup-p8"],
      [sec1, "sup-esc"],
    ] as const) {
      const token = sealSupportToken("{}", pair.publicKey, kid);
      expect(openSupportBlob(token, keys ?? []).ok).toBe(true);
    }
  });

  it("fails the start with one sentence and no key material for any bad configuration", () => {
    const good = generated();
    const p384 = generated("sec1", "secp384r1");
    const cases: unknown[] = [
      "not json",
      [],
      [
        {
          kid: "sup-1",
          pem: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
        },
      ],
      [
        { kid: "sup-1", pem: good.pem },
        { kid: "sup-1", pem: good.pem },
      ],
      [{ kid: "bad kid", pem: good.pem }],
      [{ kid: "sup-1", pem: good.pem, extra: true }],
      [{ kid: "sup-1", pem: p384.pem }],
      [{ kid: "sup-1", pem: good.publicKey.export({ type: "spki", format: "pem" }).toString() }],
      [
        {
          kid: "sup-1",
          pem: generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
      ],
    ];
    for (const value of cases) {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      let message = "";
      try {
        configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toBe(STANDALONE_SUPPORT_KEYS_ERROR);
      expect(message).not.toMatch(/BEGIN|PRIVATE|AAAA/u);
    }
  });

  it("derives the key id the maker's tool prints and reports a mismatch", () => {
    const { privateKey, publicKey } = generated();
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(String(jwk.x), "base64url"),
      Buffer.from(String(jwk.y), "base64url"),
    ]);
    const derived = `sup-${createHash("sha256").update(point).digest("hex").slice(0, 8)}`;
    expect(expectedSupportKid(privateKey)).toBe(derived);
    expect(supportKeyKidMismatches([{ kid: derived, privateKey }])).toEqual([]);
    expect(supportKeyKidMismatches([{ kid: "sup-custom", privateKey }])).toEqual(["sup-custom"]);
  });
});
```

- [ ] **Step 5: `standalone-support-keys.ts`**

Создать `apps/api/src/modules/standalone-diagnostics/standalone-support-keys.ts`:

```ts
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { SupportPrivateKey } from "./support-blob";

export interface StandaloneSupportKeysEnvironment {
  STANDALONE_SUPPORT_KEYS_JSON?: string | undefined;
}
export const STANDALONE_SUPPORT_KEYS = Symbol("STANDALONE_SUPPORT_KEYS");
export const STANDALONE_SUPPORT_KEYS_ERROR = "Invalid standalone support keys configuration";

const entrySchema = z
  .object({ kid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), pem: z.string().min(1).max(4096) })
  .strict();
const listSchema = z.array(entrySchema).min(1).max(8);

/**
 * The support keys are PRIVATE and live only in the API's environment (Lockbox record
 * `STANDALONE_SUPPORT_KEYS_JSON`, plan ДИАГ): `[{kid, pem}]`, one JSON line, the PEM's newlines as
 * `\n`; SEC1 (`BEGIN EC PRIVATE KEY`, what `openssl ecparam -genkey` prints) and PKCS8 both load. Empty means
 * ingestion is off (the API starts); a set but unusable value fails the start with one sentence
 * that carries no key material. A second entry is a rotation.
 */
export function configureStandaloneSupportKeys(
  env: StandaloneSupportKeysEnvironment,
): readonly SupportPrivateKey[] | null {
  const raw = env.STANDALONE_SUPPORT_KEYS_JSON;
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const entries = listSchema.parse(JSON.parse(raw));
    if (new Set(entries.map((entry) => entry.kid)).size !== entries.length) throw new Error();
    return entries.map(({ kid, pem }) => {
      const privateKey = createPrivateKey(pem.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem);
      if (
        privateKey.type !== "private" ||
        privateKey.asymmetricKeyType !== "ec" ||
        privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      )
        throw new Error();
      return { kid, privateKey };
    });
  } catch {
    throw new Error(STANDALONE_SUPPORT_KEYS_ERROR);
  }
}

/** `sup-` + 8 hex of SHA-256(04 ‖ x ‖ y): the id `decrypt.mjs --public-jwk` prints for the pair. */
export function expectedSupportKid(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
  return `sup-${createHash("sha256").update(point).digest("hex").slice(0, 8)}`;
}

/** Kids that differ from their key's derived id (a warning at start: the owner may use `--kid`). */
export function supportKeyKidMismatches(keys: readonly SupportPrivateKey[]): string[] {
  return keys.filter((key) => key.kid !== expectedSupportKid(key.privateKey)).map((key) => key.kid);
}
```

- [ ] **Step 6: Подключить в `env.ts` и протестировать**

В `apps/api/src/env.ts`: импорт `import { configureStandaloneSupportKeys, STANDALONE_SUPPORT_KEYS_ERROR } from "./modules/standalone-diagnostics/standalone-support-keys";`; в схему после `STANDALONE_LICENSE_KEYSET_JSON: z.string().optional(),` добавить `STANDALONE_SUPPORT_KEYS_JSON: z.string().optional(),`; в `superRefine` после блока `configureStandaloneLicenseSigning(env)` добавить:

```ts
try {
  configureStandaloneSupportKeys(env);
} catch {
  ctx.addIssue({
    code: "custom",
    path: ["STANDALONE_SUPPORT_KEYS_JSON"],
    message: STANDALONE_SUPPORT_KEYS_ERROR,
  });
}
```

В `apps/api/test/env.test.ts` добавить в конец блок:

```ts
describe("standalone support keys environment (plan ДИАГ А1)", () => {
  it("boots without the keys and with a SEC1 key, and refuses a broken value without echoing it", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    expect(loadEnv(requiredEnv).STANDALONE_SUPPORT_KEYS_JSON).toBeUndefined();
    const value = JSON.stringify([{ kid: "sup-1", pem }]);
    expect(loadEnv({ ...requiredEnv, STANDALONE_SUPPORT_KEYS_JSON: value })).toBeTruthy();
    let message = "";
    try {
      loadEnv({ ...requiredEnv, STANDALONE_SUPPORT_KEYS_JSON: '[{"kid":"sup-1","pem":"BROKEN"}]' });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("STANDALONE_SUPPORT_KEYS_JSON");
    expect(message).not.toContain("BROKEN");
  });
});
```

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-support-blob.test.ts test/standalone-support-keys.test.ts test/env.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
```

Ожидается: все зелёные.

- [ ] **Step 7: Мутационная проверка защиты от бомбы**

```bash
cp apps/api/src/modules/standalone-diagnostics/support-blob.ts /tmp/claude/before && shasum -a 256 apps/api/src/modules/standalone-diagnostics/support-blob.ts
```

Убрать `{ maxOutputLength: MAX_INFLATED_BYTES }` из `inflateRawSync`; запустить `pnpm … exec vitest run test/standalone-support-blob.test.ts` — ожидается FAIL в «refuses a compression bomb» (памяти уйдёт ≥ 2 МиБ, ответ не `payload_too_large`, а `payload_too_large` по размеру после — тест всё равно красный по времени/результату; если он зелёный, потому что итоговая проверка `MAX_PAYLOAD_BYTES` ловит 2 МиБ, поднять размер бомбы в тесте до 64 МиБ). Вернуть файл: `cp /tmp/claude/before apps/api/src/modules/standalone-diagnostics/support-blob.ts`, `cmp` молчит, `shasum` тот же. Мутацию не коммитить.

- [ ] **Step 8: Коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/api/src/modules/standalone-diagnostics apps/api/src/env.ts apps/api/test/support/standalone-support-token.ts apps/api/test/standalone-support-blob.test.ts apps/api/test/standalone-support-keys.test.ts apps/api/test/env.test.ts
git diff --check
git add apps/api/src/modules/standalone-diagnostics/support-blob.ts apps/api/src/modules/standalone-diagnostics/standalone-support-keys.ts apps/api/src/env.ts apps/api/test/support/standalone-support-token.ts apps/api/test/standalone-support-blob.test.ts apps/api/test/standalone-support-keys.test.ts apps/api/test/env.test.ts
git commit -m "feat(diagnostics): A1 — support token opening (bounded, no oracle) and private keys from STANDALONE_SUPPORT_KEYS_JSON"
```

---

### Task 4 (А2): Сервис приёма и чтения

**Files:**

- Create: `apps/api/src/modules/standalone-diagnostics/{support-payload,standalone-diagnostics-views,standalone-diagnostics.service}.ts`
- Modify: `apps/api/src/modules/standalone-licenses/standalone-license-authority.ts`, `apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts`
- Test: `apps/api/test/standalone-support-payload.test.ts`, `apps/api/test/standalone-diagnostics-views.test.ts`, `apps/api/test/standalone-diagnostics.e2e.test.ts`

**Interfaces:**

- Consumes: `openSupportBlob`, `SupportPrivateKey`, `STANDALONE_SUPPORT_KEYS` (А1); схемы К1; таблицы Д1; `PlatformAuditService`, `DB`, `standaloneTransaction`, `requireStandaloneLicenseActor`, `STANDALONE_LICENSE_CAPABILITIES`.
- Produces: `parseSupportPayload(json, now)`; `StandaloneDiagnosticsService.{ingest, history, overview, statistics, detail, purgeExpired}`; токены DI `STANDALONE_DIAGNOSTICS_CLOCK`, `STANDALONE_LATEST_BUILD`, интерфейс `StandaloneLatestBuildSource`, `noPublishedStandaloneBuild`; `sumUsageMonths`, `isOlderVersion`, `diagnosticSummary`, `encodeHistoryCursor`/`decodeHistoryCursor`, `retentionCutoff`.

- [ ] **Step 1: Падающие тесты нагрузки и представлений (чистые)**

Создать `apps/api/test/standalone-support-payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSupportPayload } from "../src/modules/standalone-diagnostics/support-payload";
import { supportPayloadV1, supportPayloadV2 } from "./support/standalone-support-token";

const NOW = new Date("2026-10-20T09:00:00.000Z");

describe("support payload validation (plan ДИАГ А2)", () => {
  it("accepts v1 and v2", () => {
    expect(parseSupportPayload(supportPayloadV1(), NOW)).toMatchObject({ ok: true });
    expect(parseSupportPayload(supportPayloadV2(), NOW)).toMatchObject({ ok: true });
  });

  it("answers payload_invalid for an unknown field, a bad month or an array", () => {
    expect(parseSupportPayload({ ...supportPayloadV2(), secret: 1 }, NOW)).toEqual({
      ok: false,
      reason: "payload_invalid",
    });
    expect(parseSupportPayload([], NOW)).toEqual({ ok: false, reason: "payload_invalid" });
    const unordered = supportPayloadV2({ months: ["2026-10", "2026-09"] });
    expect(parseSupportPayload(unordered, NOW)).toEqual({ ok: false, reason: "payload_invalid" });
  });

  it("cuts a generated instant more than a day ahead of the server clock, accepts the past", () => {
    const at = (iso: string) => parseSupportPayload(supportPayloadV2({ generatedAt: iso }), NOW);
    expect(at("2026-10-21T08:59:59.000Z")).toMatchObject({ ok: true });
    expect(at("2026-10-21T09:00:01.000Z")).toEqual({ ok: false, reason: "generated_in_future" });
    expect(at("2020-01-01T00:00:00.000Z")).toMatchObject({ ok: true });
  });
});
```

Создать `apps/api/test/standalone-diagnostics-views.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  isOlderVersion,
  retentionCutoff,
  sumUsageMonths,
} from "../src/modules/standalone-diagnostics/standalone-diagnostics-views";
import { usageMonth } from "./support/standalone-support-token";

describe("diagnostics views (plan ДИАГ А2)", () => {
  it("sums every counter of a month over hosts and keeps the month key", () => {
    const sum = sumUsageMonths([usageMonth("2026-10", 100), usageMonth("2026-10", 50)]);
    expect(sum.month).toBe("2026-10");
    expect(sum.scans).toEqual({ accepted: 150, duplicates: 128, rejected: 18 });
    expect(sum.boxes.closed).toBe(1170);
    expect(sum.shifts.aggregation).toBe(12);
    expect(sumUsageMonths([usageMonth("2026-10", 7)])).toEqual(usageMonth("2026-10", 7));
  });

  it("compares versions: numeric core, a pre-release is older than its release, unknown is null", () => {
    expect(isOlderVersion("0.2.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.10.0", "0.2.0")).toBe(false);
    expect(isOlderVersion("2.1.0-beta.1", "2.1.0")).toBe(true);
    expect(isOlderVersion("2.1.0", "2.1.0-beta.2")).toBe(false);
    expect(isOlderVersion("2.1.0-beta.2", "2.1.0-beta.10")).toBe(true);
    expect(isOlderVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isOlderVersion("dev", "1.0.0")).toBeNull();
    expect(isOlderVersion("1.0.0", "latest")).toBeNull();
  });

  it("round-trips a history cursor and refuses a mangled one", () => {
    const at = new Date("2026-10-14T09:00:00.000Z");
    const id = "11111111-2222-4333-8444-555555555555";
    expect(decodeHistoryCursor(encodeHistoryCursor(at, id))).toEqual({ generatedAt: at, id });
    expect(decodeHistoryCursor("AAAA")).toBeNull();
    expect(decodeHistoryCursor(Buffer.from("x|y").toString("base64url"))).toBeNull();
  });

  it("keeps 24 calendar months", () => {
    expect(retentionCutoff(new Date("2026-10-20T09:00:00.000Z")).toISOString()).toBe(
      "2024-10-20T09:00:00.000Z",
    );
    expect(retentionCutoff(new Date("2026-03-31T00:00:00.000Z")).toISOString()).toBe(
      "2024-03-31T00:00:00.000Z",
    );
  });
});
```

Запуск (FAIL — модулей нет):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-support-payload.test.ts test/standalone-diagnostics-views.test.ts
```

- [ ] **Step 2: `support-payload.ts` и `standalone-diagnostics-views.ts`**

`apps/api/src/modules/standalone-diagnostics/support-payload.ts`:

```ts
import {
  standaloneSupportPayloadSchema,
  type StandaloneSupportPayload,
} from "@markiro/platform-contracts";

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type ParsedSupportPayload =
  | { ok: true; payload: StandaloneSupportPayload }
  | { ok: false; reason: "payload_invalid" | "generated_in_future" };

/**
 * The strict schema (v1 or v2), then the clock rule: the client's clock is the only source of
 * `generatedAt`, so an instant more than a day ahead of the server is cut; the past is accepted.
 */
export function parseSupportPayload(json: unknown, now: Date): ParsedSupportPayload {
  const parsed = standaloneSupportPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "payload_invalid" };
  if (Date.parse(parsed.data.generatedAt) > now.getTime() + FUTURE_TOLERANCE_MS)
    return { ok: false, reason: "generated_in_future" };
  return { ok: true, payload: parsed.data };
}
```

`apps/api/src/modules/standalone-diagnostics/standalone-diagnostics-views.ts`:

```ts
import { schema } from "@markiro/db";
import {
  standaloneDiagnosticSummarySchema,
  standaloneSupportPayloadSchema,
  standaloneUsageMonthSchema,
  type StandaloneDiagnosticSummary,
  type StandaloneUsageMonth,
} from "@markiro/platform-contracts";

export type DiagnosticRow = typeof schema.standaloneSupportDiagnostics.$inferSelect;

/** What the pages need about a report; the system fields live in the payload (v2 only). */
export function diagnosticSummary(row: DiagnosticRow): StandaloneDiagnosticSummary {
  const parsed = standaloneSupportPayloadSchema.safeParse(row.payload);
  const v2 = parsed.success && parsed.data.v === 2 ? parsed.data : null;
  return standaloneDiagnosticSummarySchema.parse({
    id: row.id,
    hostKey: row.hostKey,
    siteId: row.siteId,
    generatedAt: row.generatedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    kid: row.kid,
    payloadVersion: row.payloadVersion,
    appVersion: row.appVersion,
    hostVersion: row.hostVersion,
    pcRole: row.pcRole,
    os: v2?.os ?? null,
    arch: v2?.arch ?? null,
    webview: v2?.webview ?? null,
    licenseState: v2?.license?.state ?? null,
  });
}

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function addTree(a: Json, b: Json): Json {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (isRecord(a) && isRecord(b))
    return Object.fromEntries(Object.keys(a).map((key) => [key, addTree(a[key], b[key])]));
  return a;
}

/** The month over hosts: every counter added; done here so the counters' shape stays out of SQL. */
export function sumUsageMonths(items: readonly StandaloneUsageMonth[]): StandaloneUsageMonth {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("no month to sum");
  const total = rest.reduce<Json>((sum, item) => addTree(sum, item), first);
  return standaloneUsageMonthSchema.parse(
    isRecord(total) ? { ...total, month: first.month } : total,
  );
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/u;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `current` is older than `latest`; `null` when either is not a semantic version. */
export function isOlderVersion(current: string, latest: string): boolean | null {
  const a = VERSION.exec(current);
  const b = VERSION.exec(latest);
  if (a === null || b === null) return null;
  for (const at of [1, 2, 3]) {
    const delta = Number(a[at]) - Number(b[at]);
    if (delta !== 0) return delta < 0;
  }
  const pa = a[4];
  const pb = b[4];
  if (pa === undefined && pb === undefined) return false;
  if (pa === undefined) return false; // a release is newer than its pre-release
  if (pb === undefined) return true;
  const left = pa.split(".");
  const right = pb.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    const delta = compareIdentifiers(x, y);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

export function encodeHistoryCursor(generatedAt: Date, id: string): string {
  return Buffer.from(`${generatedAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeHistoryCursor(cursor: string): { generatedAt: Date; id: string } | null {
  const [iso, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (iso === undefined || id === undefined || extra !== undefined) return null;
  const generatedAt = new Date(iso);
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== iso) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) return null;
  return { generatedAt, id };
}

/** The retention horizon (decision В6): 24 calendar months before `now`. */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  return cutoff;
}
```

(`setUTCMonth` на 31 марта − 24 месяца даёт 31 марта 2024: месяцы совпадают по числу дней; для 29 февраля сдвиг уйдёт на 1 марта — для срока хранения это допустимо.)

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-support-payload.test.ts test/standalone-diagnostics-views.test.ts
```

Ожидается: `7 passed`.

- [ ] **Step 3: Обобщить проверку актора и список повторяемых ограничений**

В `standalone-license-authority.ts`: изменить сигнатуру

```ts
export async function requireStandaloneLicenseActor(
  tx: SubscriptionTransaction,
  principal: PlatformPrincipal | undefined,
  tenantId: string,
  write: boolean,
  required: readonly PlatformCapability[] = STANDALONE_LICENSE_CAPABILITIES,
) {
```

и заменить `!STANDALONE_LICENSE_CAPABILITIES.every((capability) =>` на `!required.every((capability) =>` (остальное без изменений: по умолчанию поведение прежнее, существующие тесты ЛЦ-0 это подтвердят).

В `standalone-license-transaction.ts` в `RETRYABLE_CONSTRAINTS` добавить `"standalone_support_diagnostics_blob_uq"` и `"standalone_support_diagnostics_host_generated_uq"`.

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-sites.e2e.test.ts test/platform-standalone-licenses.routes.test.ts
```

Ожидается: без изменений в результате (e2e пропускается без `DATABASE_URL`, называть это).

- [ ] **Step 4: Падающий e2e-тест сервиса**

Создать `apps/api/test/standalone-diagnostics.e2e.test.ts`:

```ts
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  StandaloneDiagnosticsService,
  noPublishedStandaloneBuild,
} from "../src/modules/standalone-diagnostics/standalone-diagnostics.service";
import { createOrganization } from "./support/subscription-fixtures";
import { auditRows, platformActor } from "./support/standalone-license-fixture";
import {
  sealSupportToken,
  supportPayloadV1,
  supportPayloadV2,
  supportText,
} from "./support/standalone-support-token";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const NOW = new Date("2026-10-20T09:00:00.000Z");
const pairA = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEYS = [{ kid: "sup-e2e", privateKey: pairA.privateKey }];
const service = new StandaloneDiagnosticsService(
  db,
  new PlatformAuditService(),
  KEYS,
  () => NOW,
  noPublishedStandaloneBuild,
);
afterAll(() => connection.pool.end());

const token = (payload: unknown, compress = true) =>
  sealSupportToken(JSON.stringify(payload), pairA.publicKey, "sup-e2e", compress);
const text = (payload: unknown) => supportText(token(payload));

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error === null || typeof error !== "object" || !("getResponse" in error))
    throw new Error("expected an HTTP exception");
  const e = error as { getStatus(): number; getResponse(): unknown };
  return { status: e.getStatus(), body: e.getResponse() };
}

async function bindSite(tenantId: string, hostId: string, adminId: string, history: string[] = []) {
  const id = randomUUID();
  await db.insert(schema.standaloneSites).values({
    id,
    tenantId,
    hostId,
    name: "Цех розлива",
    requestInn: null,
    lastActivationRequest: {},
    hostHistory: [hostId, ...history].map((h) => ({
      hostId: h,
      requestInn: null,
      requestId: randomUUID(),
      boundAt: NOW.toISOString(),
      boundByPlatformUserId: adminId,
    })),
    requestId: randomUUID(),
    createdByPlatformUserId: adminId,
  });
  return id;
}

const rows = (tenantId: string) =>
  db
    .select()
    .from(schema.standaloneSupportDiagnostics)
    .where(eq(schema.standaloneSupportDiagnostics.tenantId, tenantId));

describe.skipIf(!process.env.DATABASE_URL)("standalone diagnostics (plan ДИАГ А2)", () => {
  it("accepts a v2 report: history row, month aggregates and the exact audit row", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    const siteId = await bindSite(tenantId, hostId, admin.userId);
    const payload = supportPayloadV2({ hostId });
    const blob = token(payload);

    const result = await service.ingest(admin, tenantId, { text: supportText(blob) });

    expect(result).toMatchObject({ duplicate: false, monthsApplied: 2, monthsSkipped: 0 });
    expect(result.diagnostic).toMatchObject({
      hostKey: hostId,
      siteId,
      payloadVersion: 2,
      appVersion: "0.2.0",
      hostVersion: "0.2.0",
      pcRole: "host",
      os: "Windows 11",
      arch: "x64",
      webview: "WebView2 130.0.2849.80",
      licenseState: "active",
      generatedAt: "2026-10-14T09:00:00.000Z",
    });
    const [row] = await rows(tenantId);
    expect(row).toMatchObject({
      blobSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      receivedByPlatformUserId: admin.userId,
      devicesStation: 3,
      devicesOffice: 2,
      devicesHandheld: 1,
    });
    expect(JSON.stringify(row)).not.toContain("MKS1.");
    const months = await db
      .select()
      .from(schema.standaloneSupportUsageMonths)
      .where(eq(schema.standaloneSupportUsageMonths.tenantId, tenantId));
    expect(months.map((m) => m.month).sort()).toEqual(["2026-09", "2026-10"]);
    expect(await auditRows(db, tenantId)).toEqual([
      {
        actorPlatformUserId: admin.userId,
        actorRole: "platform_admin",
        tenantId,
        action: "standalone.diagnostics.ingest",
        outcome: "success",
        targetType: "standalone_support_diagnostic",
        targetId: result.diagnostic.id,
        reason: null,
        requestId: null,
        before: null,
        after: {
          blobSha256: row?.blobSha256,
          kid: "sup-e2e",
          payloadVersion: 2,
          hostKey: hostId,
          siteId,
          generatedAt: "2026-10-14T09:00:00.000Z",
          appVersion: "0.2.0",
          hostVersion: "0.2.0",
          pcRole: "host",
          licenseState: "active",
          monthsApplied: 2,
          monthsSkipped: 0,
          unboundAcknowledged: false,
          textBytes: Buffer.byteLength(supportText(blob), "utf8"),
        },
      },
    ]);
  });

  it("a repeat of the same token, or of the same exact instant in another token, is a duplicate", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const payload = supportPayloadV2({ hostId });
    const text1 = text(payload);
    const first = await service.ingest(admin, tenantId, { text: text1 });
    const again = await service.ingest(admin, tenantId, { text: text1 });
    expect(again).toMatchObject({ duplicate: true, monthsApplied: 0, monthsSkipped: 0 });
    expect(again.diagnostic.id).toBe(first.diagnostic.id);
    const remade = await service.ingest(admin, tenantId, { text: text(payload) });
    expect(remade).toMatchObject({ duplicate: true });
    expect(remade.diagnostic.id).toBe(first.diagnostic.id);
    expect(await rows(tenantId)).toHaveLength(1);
    const audit = await auditRows(db, tenantId);
    expect(audit.map((a) => a.outcome)).toEqual(["success", "duplicate", "duplicate"]);
    expect(audit[1]).toMatchObject({ targetId: first.diagnostic.id, reason: null, before: null });
    // A different instant is a different report.
    const next = await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-14T09:00:01.000Z" })),
    });
    expect(next.duplicate).toBe(false);
  });

  it("two operators pasting the same token at once: one winner, the other a duplicate, no 500", async () => {
    const [one, two] = [await platformActor(db), await platformActor(db)];
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, one.userId);
    const body = { text: text(supportPayloadV2({ hostId })) };
    const results = await Promise.all([
      service.ingest(one, tenantId, body),
      service.ingest(two, tenantId, body),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await rows(tenantId)).toHaveLength(1);
  });

  it("an older report sent later does not overwrite fresher months but adds the missing ones", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const fresh = supportPayloadV2({
      hostId,
      generatedAt: "2026-10-14T09:00:00.000Z",
      months: ["2026-09", "2026-10"],
    });
    const older = supportPayloadV2({
      hostId,
      generatedAt: "2026-10-10T09:00:00.000Z",
      months: ["2026-08", "2026-09"],
    });
    await service.ingest(admin, tenantId, { text: text(fresh) });
    const result = await service.ingest(admin, tenantId, { text: text(older) });
    expect(result).toMatchObject({ duplicate: false, monthsApplied: 1, monthsSkipped: 1 });
    const stats = await service.statistics(admin, tenantId, {});
    expect(stats.months.map((m) => m.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    const [audit] = (await auditRows(db, tenantId)).slice(-1);
    expect(audit?.after).toMatchObject({ monthsApplied: 1, monthsSkipped: 1 });
  });

  it("binding: another tenant's host is refused, an unknown host needs the acknowledgement, a rebound host is found by history", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const hostB = randomUUID();
    await bindSite(tenantB, hostB, admin.userId);

    const other = await refusal(
      service.ingest(admin, tenantA, { text: text(supportPayloadV2({ hostId: hostB })) }),
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "standalone_diagnostics_host_other_tenant" });
    expect(JSON.stringify(other.body)).not.toContain(tenantB);
    expect(await rows(tenantA)).toHaveLength(0);
    const rejected = await auditRows(db, tenantA);
    expect(rejected).toEqual([
      expect.objectContaining({
        action: "standalone.diagnostics.ingest",
        outcome: "rejected",
        reason: "host_other_tenant",
        targetType: "standalone_support_diagnostic",
        targetId: null,
        actorPlatformUserId: admin.userId,
      }),
    ]);

    const lone = randomUUID();
    const unbound = text(supportPayloadV2({ hostId: lone }));
    expect((await refusal(service.ingest(admin, tenantA, { text: unbound }))).body).toMatchObject({
      code: "standalone_diagnostics_host_unbound",
    });
    const ok = await service.ingest(admin, tenantA, {
      text: unbound,
      acknowledgeUnboundHost: true,
    });
    expect(ok.diagnostic.siteId).toBeNull();
    const accepted = (await auditRows(db, tenantA)).at(-1);
    expect(accepted?.after).toMatchObject({ siteId: null, unboundAcknowledged: true });

    const oldHost = randomUUID();
    const siteId = await bindSite(tenantA, randomUUID(), admin.userId, [oldHost]);
    const viaHistory = await service.ingest(admin, tenantA, {
      text: text(supportPayloadV2({ hostId: oldHost })),
    });
    expect(viaHistory.diagnostic.siteId).toBe(siteId);
  });

  it("a v1 report always needs the acknowledgement; the same token in another tenant is a token_conflict", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const v1 = text(supportPayloadV1());
    expect((await refusal(service.ingest(admin, tenantA, { text: v1 }))).body).toMatchObject({
      code: "standalone_diagnostics_host_unbound",
    });
    const stored = await service.ingest(admin, tenantA, { text: v1, acknowledgeUnboundHost: true });
    expect(stored.diagnostic).toMatchObject({
      hostKey: "unknown",
      payloadVersion: 1,
      pcRole: null,
    });
    const conflict = await refusal(
      service.ingest(admin, tenantB, { text: v1, acknowledgeUnboundHost: true }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "standalone_diagnostics_token_conflict" });
    expect(await rows(tenantB)).toHaveLength(0);
  });

  it("refuses with the documented statuses and writes only a rejected audit row", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const cases: Array<[string, number, string, string]> = [
      ["без токена", 400, "standalone_diagnostics_no_token", "no_token"],
      [
        text(supportPayloadV2({ hostId, generatedAt: "2026-10-22T09:00:00.000Z" })),
        422,
        "standalone_diagnostics_generated_in_future",
        "generated_in_future",
      ],
      [
        text({ ...supportPayloadV2({ hostId }), extra: 1 }),
        422,
        "standalone_diagnostics_payload_invalid",
        "payload_invalid",
      ],
      [
        supportText(token(supportPayloadV2({ hostId })).replace("sup-e2e", "sup-zzz")),
        422,
        "standalone_diagnostics_unknown_key",
        "unknown_key",
      ],
      ["x".repeat(32_769), 413, "standalone_diagnostics_text_too_large", "text_too_large"],
    ];
    for (const [input, status, code] of cases) {
      const result = await refusal(service.ingest(admin, tenantId, { text: input }));
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ code });
    }
    expect(await rows(tenantId)).toHaveLength(0);
    const audit = await auditRows(db, tenantId);
    expect(audit.map((a) => [a.outcome, a.reason])).toEqual(
      cases.map(([, , , reason]) => ["rejected", reason]),
    );
    expect(audit.every((a) => a.targetId === null && a.before === null)).toBe(true);
    expect(audit[3]?.after).toEqual({ textBytes: expect.any(Number), kid: "sup-zzz" });
    expect(audit[0]?.after).toEqual({ textBytes: expect.any(Number) });
  });

  it("answers 409 not_configured without keys and 404 for a missing tenant, before touching the token", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const off = new StandaloneDiagnosticsService(
      db,
      new PlatformAuditService(),
      null,
      () => NOW,
      noPublishedStandaloneBuild,
    );
    const result = await refusal(off.ingest(admin, tenantId, { text: "anything" }));
    expect(result).toMatchObject({
      status: 409,
      body: { code: "standalone_diagnostics_not_configured" },
    });
    expect(await auditRows(db, tenantId)).toEqual([]);
    await expect(service.ingest(admin, randomUUID(), { text: "anything" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("access: write needs the licensing capability, read only tenants.read; sessions re-checked", async () => {
    const admin = await platformActor(db);
    const support = await platformActor(db, "support");
    const unverified = await platformActor(db, "platform_admin", { verified: false });
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const body = { text: text(supportPayloadV2({ hostId })) };
    await expect(service.ingest(support, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.ingest(unverified, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.ingest(undefined, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await service.ingest(admin, tenantId, body);
    expect((await service.history(support, tenantId, {})).items).toHaveLength(1);
    await expect(service.history(unverified, tenantId, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, support.userId));
    await expect(service.history(support, tenantId, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("reads are tenant-scoped: another tenant's history, overview, statistics and detail are empty or 404", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const hostA = randomUUID();
    await bindSite(tenantA, hostA, admin.userId);
    const stored = await service.ingest(admin, tenantA, {
      text: text(supportPayloadV2({ hostId: hostA })),
    });
    expect((await service.history(admin, tenantB, {})).items).toEqual([]);
    expect((await service.overview(admin, tenantB)).hosts).toEqual([]);
    expect((await service.statistics(admin, tenantB, {})).months).toEqual([]);
    await expect(service.detail(admin, tenantB, stored.diagnostic.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const detail = await service.detail(admin, tenantA, stored.diagnostic.id);
    expect(detail.months.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(detail.license?.quotas.stations).toEqual({ limit: 3, used: 2, over: false });
  });

  it("overview shows the last report per host, the cloud's newest file and no 'outdated' without a source", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    const siteId = await bindSite(tenantId, hostId, admin.userId);
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-10T09:00:00.000Z" })),
    });
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-14T09:00:00.000Z" })),
    });
    const overview = await service.overview(admin, tenantId);
    expect(overview.latestPublishedVersion).toBeNull();
    expect(overview.hosts).toHaveLength(1);
    expect(overview.hosts[0]).toMatchObject({
      hostKey: hostId,
      siteId,
      siteName: "Цех розлива",
      outdated: null,
      cloudLicense: null,
      devices: { station: 3, office: 2, handheld: 1 },
      license: { state: "active", sequence: 3 },
      last: { generatedAt: "2026-10-14T09:00:00.000Z" },
    });
    const withSource = new StandaloneDiagnosticsService(
      db,
      new PlatformAuditService(),
      KEYS,
      () => NOW,
      {
        latestPublishedVersion: async () => "0.3.0",
      },
    );
    const compared = await withSource.overview(admin, tenantId);
    expect(compared.latestPublishedVersion).toBe("0.3.0");
    expect(compared.hosts[0]?.outdated).toBe(true);
  });

  it("statistics sum over hosts with a 'several hosts' flag and filter by host and range; gaps stay gaps", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const [h1, h2] = [randomUUID(), randomUUID()];
    await bindSite(tenantId, h1, admin.userId);
    await bindSite(tenantId, h2, admin.userId);
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId: h1, months: ["2026-08", "2026-10"] })),
    });
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId: h2, months: ["2026-10"] })),
    });
    const all = await service.statistics(admin, tenantId, {});
    expect(all.multipleHosts).toBe(true);
    expect(all.hosts.sort()).toEqual([h1, h2].sort());
    expect(all.months.map((m) => [m.month, m.hostCount])).toEqual([
      ["2026-08", 1],
      ["2026-10", 2],
    ]);
    expect(all.months[1]?.stats.scans.accepted).toBe(14040);
    const one = await service.statistics(admin, tenantId, { hostKey: h1 });
    expect(one.multipleHosts).toBe(false);
    expect(one.months[1]?.stats.scans.accepted).toBe(7020);
    const ranged = await service.statistics(admin, tenantId, { from: "2026-09", to: "2026-10" });
    expect(ranged.months.map((m) => m.month)).toEqual(["2026-10"]);
  });

  it("history pages by generated instant, newest first, with a cursor", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    for (const second of ["01", "02", "03"]) {
      await service.ingest(admin, tenantId, {
        text: text(supportPayloadV2({ hostId, generatedAt: `2026-10-14T09:00:${second}.000Z` })),
      });
    }
    const first = await service.history(admin, tenantId, { limit: "2" });
    expect(first.items.map((i) => i.generatedAt)).toEqual([
      "2026-10-14T09:00:03.000Z",
      "2026-10-14T09:00:02.000Z",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.history(admin, tenantId, {
      limit: "2",
      cursor: first.nextCursor ?? "",
    });
    expect(second.items.map((i) => i.generatedAt)).toEqual(["2026-10-14T09:00:01.000Z"]);
    expect(second.nextCursor).toBeNull();
    await expect(service.history(admin, tenantId, { cursor: "AAAA" })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("leaks nothing: neither the token, the payload nor a key in a response, a refusal or the audit", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const blob = token(supportPayloadV2({ hostId }));
    const ok = await service.ingest(admin, tenantId, { text: supportText(blob) });
    const bad = await refusal(
      service.ingest(admin, tenantId, { text: supportText(blob.replace("sup-e2e", "sup-zzz")) }),
    );
    const everything = JSON.stringify([
      ok,
      bad,
      await auditRows(db, tenantId),
      await service.history(admin, tenantId, {}),
    ]);
    expect(everything).not.toContain(blob);
    expect(everything).not.toContain("MKS1.sup-e2e");
    expect(everything).not.toMatch(/PRIVATE KEY/u);
    expect(everything).not.toContain("WebView2 130");
  });

  it("purges reports older than 24 months with their months and keeps the rest", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const kept = await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId })),
    });
    const old = await service.ingest(admin, tenantId, {
      text: text(
        supportPayloadV2({ hostId, generatedAt: "2026-10-01T09:00:00.000Z", months: ["2023-01"] }),
      ),
    });
    await db
      .update(schema.standaloneSupportDiagnostics)
      .set({ receivedAt: new Date("2024-10-01T00:00:00.000Z") })
      .where(eq(schema.standaloneSupportDiagnostics.id, old.diagnostic.id));
    const removed = await service.purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await rows(tenantId)).map((r) => r.id)).toEqual([kept.diagnostic.id]);
    const stats = await service.statistics(admin, tenantId, {});
    expect(stats.months.map((m) => m.month)).not.toContain("2023-01");
    expect(stats.months.map((m) => m.month)).toContain("2026-10");
  });
});
```

Статус и тело отказов проверяются через `refusal` (классы исключений в тесте не нужны). В тесте «history … cursor AAAA» сервис отвечает `422 standalone_diagnostics_cursor_invalid`, поэтому проверяется тип `UnprocessableEntityException`.

Запуск (FAIL — сервиса нет):

```bash
set -a; source .env; set +a
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-diagnostics.e2e.test.ts
```

- [ ] **Step 5: `standalone-diagnostics.service.ts`**

Создать `apps/api/src/modules/standalone-diagnostics/standalone-diagnostics.service.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  UnprocessableEntityException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS,
  standaloneDiagnosticDetailSchema,
  standaloneDiagnosticsHistorySchema,
  standaloneDiagnosticsIngestResponseSchema,
  standaloneDiagnosticsOverviewSchema,
  standaloneDiagnosticsStatisticsSchema,
  standaloneSupportPayloadSchema,
  standaloneUsageMonthSchema,
  type PlatformPrincipal,
  type StandaloneDiagnosticDetail,
  type StandaloneDiagnosticsHistory,
  type StandaloneDiagnosticsHistoryQuery,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsIngestResponse,
  type StandaloneDiagnosticsOverview,
  type StandaloneDiagnosticsStatistics,
  type StandaloneDiagnosticsStatisticsQuery,
  type StandaloneSupportPayload,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { requireStandaloneLicenseActor } from "../standalone-licenses/standalone-license-authority";
import { standaloneTransaction } from "../standalone-licenses/standalone-license-transaction";
import { STANDALONE_SUPPORT_KEYS } from "./standalone-support-keys";
import { openSupportBlob, type SupportBlobFailure, type SupportPrivateKey } from "./support-blob";
import { parseSupportPayload } from "./support-payload";
import {
  decodeHistoryCursor,
  diagnosticSummary,
  encodeHistoryCursor,
  isOlderVersion,
  retentionCutoff,
  sumUsageMonths,
  type DiagnosticRow,
} from "./standalone-diagnostics-views";

export const STANDALONE_DIAGNOSTICS_CLOCK = Symbol("STANDALONE_DIAGNOSTICS_CLOCK");
export const STANDALONE_LATEST_BUILD = Symbol("STANDALONE_LATEST_BUILD");

/**
 * Where the newest PUBLISHED standalone build comes from (owner decision В5). Nothing in the cloud
 * publishes one yet — the owner signs update packages by hand — so the default knows none and
 * the overview carries `latestPublishedVersion: null` and no «outdated» verdict.
 */
export interface StandaloneLatestBuildSource {
  latestPublishedVersion(): Promise<string | null>;
}
export const noPublishedStandaloneBuild: StandaloneLatestBuildSource = {
  latestPublishedVersion: async () => null,
};

const READ_CAPABILITIES = ["tenants.read"] as const;
const REASON_CODE = {
  text_too_large: ["standalone_diagnostics_text_too_large", 413],
  no_token: ["standalone_diagnostics_no_token", 400],
  token_malformed: ["standalone_diagnostics_token_malformed", 400],
  token_too_large: ["standalone_diagnostics_token_too_large", 413],
  unknown_key: ["standalone_diagnostics_unknown_key", 422],
  undecryptable: ["standalone_diagnostics_undecryptable", 422],
  payload_too_large: ["standalone_diagnostics_payload_too_large", 413],
  payload_invalid: ["standalone_diagnostics_payload_invalid", 422],
  generated_in_future: ["standalone_diagnostics_generated_in_future", 422],
  host_other_tenant: ["standalone_diagnostics_host_other_tenant", 409],
  host_unbound: ["standalone_diagnostics_host_unbound", 409],
  token_conflict: ["standalone_diagnostics_token_conflict", 409],
} as const;
type Rejection = keyof typeof REASON_CODE;

interface Actor {
  id: string;
  role: "platform_admin" | "support" | "accountant";
}
type Outcome =
  | { kind: "done"; response: StandaloneDiagnosticsIngestResponse }
  | { kind: "rejected"; reason: Rejection; actor: Actor; after: Record<string, unknown> };

function refusalError(reason: Rejection): HttpException {
  const [code, status] = REASON_CODE[reason];
  const body = { code };
  if (status === 413) return new PayloadTooLargeException(body);
  if (status === 422) return new UnprocessableEntityException(body);
  if (status === 400) return new BadRequestException(body);
  return new ConflictException(body);
}

const blobReason = (reason: SupportBlobFailure): Rejection => reason;

@Injectable()
export class StandaloneDiagnosticsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_SUPPORT_KEYS) private readonly keys: readonly SupportPrivateKey[] | null,
    @Inject(STANDALONE_DIAGNOSTICS_CLOCK) private readonly now: () => Date,
    @Inject(STANDALONE_LATEST_BUILD) private readonly latest: StandaloneLatestBuildSource,
  ) {}

  /** Opens, validates, binds and stores one pasted support text (spec 3.5). */
  async ingest(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneDiagnosticsIngestRequest,
  ): Promise<StandaloneDiagnosticsIngestResponse> {
    const outcome = await standaloneTransaction(this.db, (tx) =>
      this.process(tx, principal, tenantId, body),
    );
    if (outcome.kind === "done") return outcome.response;
    // A refusal is audited in its own transaction: rolling the work back must not erase the trace.
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        actorPlatformUserId: outcome.actor.id,
        actorRole: outcome.actor.role,
        action: "standalone.diagnostics.ingest",
        outcome: "rejected",
        tenantId,
        targetType: "standalone_support_diagnostic",
        targetId: null,
        reason: outcome.reason,
        requestId: null,
        before: null,
        after: outcome.after,
      });
    });
    throw refusalError(outcome.reason);
  }

  private async process(
    tx: SubscriptionTransaction,
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneDiagnosticsIngestRequest,
  ): Promise<Outcome> {
    const { user } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
    const actor: Actor = { id: user.id, role: user.role };
    if (this.keys === null)
      throw new ConflictException({ code: "standalone_diagnostics_not_configured" });
    const textBytes = Buffer.byteLength(body.text, "utf8");
    const reject = (reason: Rejection, extra: Record<string, unknown> = {}): Outcome => ({
      kind: "rejected",
      reason,
      actor,
      after: { textBytes, ...extra },
    });
    if (body.text.length > STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS) return reject("text_too_large");

    const opened = openSupportBlob(body.text, this.keys);
    if (!opened.ok)
      return reject(blobReason(opened.reason), opened.kid === undefined ? {} : { kid: opened.kid });
    const parsed = parseSupportPayload(opened.json, this.now());
    if (!parsed.ok) return reject(parsed.reason, { kid: opened.kid });
    const payload = parsed.payload;
    const hostKey = payload.v === 2 && payload.hostId !== null ? payload.hostId : "unknown";

    // Binding: a pasted report must belong to this tenant's site.
    const sites =
      hostKey === "unknown"
        ? []
        : await tx
            .select({
              id: schema.standaloneSites.id,
              tenantId: schema.standaloneSites.tenantId,
              hostId: schema.standaloneSites.hostId,
            })
            .from(schema.standaloneSites)
            .where(
              or(
                eq(schema.standaloneSites.hostId, hostKey),
                sql`${schema.standaloneSites.hostHistory} @> ${JSON.stringify([{ hostId: hostKey }])}::jsonb`,
              ),
            );
    const own =
      sites.find((site) => site.tenantId === tenantId && site.hostId === hostKey) ??
      sites.find((site) => site.tenantId === tenantId);
    if (own === undefined && sites.length > 0)
      return reject("host_other_tenant", { kid: opened.kid });
    const unbound = own === undefined;
    if (unbound && body.acknowledgeUnboundHost !== true)
      return reject("host_unbound", { kid: opened.kid });

    // Idempotency: the token's hash (globally), then the exact instant per host.
    const [byHash] = await tx
      .select({
        id: schema.standaloneSupportDiagnostics.id,
        tenantId: schema.standaloneSupportDiagnostics.tenantId,
      })
      .from(schema.standaloneSupportDiagnostics)
      .where(eq(schema.standaloneSupportDiagnostics.blobSha256, opened.blobSha256));
    if (byHash !== undefined && byHash.tenantId !== tenantId)
      return reject("token_conflict", { kid: opened.kid });
    const generatedAt = new Date(payload.generatedAt);
    const [byPair] =
      byHash !== undefined
        ? [byHash]
        : await tx
            .select({ id: schema.standaloneSupportDiagnostics.id })
            .from(schema.standaloneSupportDiagnostics)
            .where(
              and(
                eq(schema.standaloneSupportDiagnostics.tenantId, tenantId),
                eq(schema.standaloneSupportDiagnostics.hostKey, hostKey),
                eq(schema.standaloneSupportDiagnostics.generatedAt, generatedAt),
              ),
            );
    if (byPair !== undefined) {
      const existing = await this.row(tx, tenantId, byPair.id);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.id,
        actorRole: actor.role,
        action: "standalone.diagnostics.ingest",
        outcome: "duplicate",
        tenantId,
        targetType: "standalone_support_diagnostic",
        targetId: existing.id,
        reason: null,
        requestId: null,
        before: null,
        after: this.auditAfter(existing, payload, hostKey, 0, 0, false, textBytes),
      });
      return {
        kind: "done",
        response: standaloneDiagnosticsIngestResponseSchema.parse({
          duplicate: true,
          diagnostic: diagnosticSummary(existing),
          monthsApplied: 0,
          monthsSkipped: 0,
        }),
      };
    }

    const id = randomUUID();
    const [inserted] = await tx
      .insert(schema.standaloneSupportDiagnostics)
      .values({
        id,
        tenantId,
        siteId: own?.id ?? null,
        hostKey,
        blobSha256: opened.blobSha256,
        kid: opened.kid,
        payloadVersion: payload.v,
        generatedAt,
        receivedByPlatformUserId: actor.id,
        appVersion: payload.appVersion,
        hostVersion: payload.hostVersion,
        pcRole: payload.v === 2 ? payload.role : null,
        devicesStation: payload.devices.station,
        devicesOffice: payload.devices.office,
        devicesHandheld: payload.devices.handheld,
        license: payload.v === 2 ? payload.license : null,
        payload,
      })
      .returning();
    if (!inserted) throw new Error("diagnostic insert returned no row");

    const applied = await tx
      .insert(schema.standaloneSupportUsageMonths)
      .values(
        payload.months.map((month) => ({
          tenantId,
          hostKey,
          month: month.month,
          stats: month,
          sourceDiagnosticId: id,
          sourceGeneratedAt: generatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.standaloneSupportUsageMonths.tenantId,
          schema.standaloneSupportUsageMonths.hostKey,
          schema.standaloneSupportUsageMonths.month,
        ],
        set: {
          stats: sql`excluded.stats`,
          sourceDiagnosticId: sql`excluded.source_diagnostic_id`,
          sourceGeneratedAt: sql`excluded.source_generated_at`,
        },
        // The newest report wins by its own instant, not by arrival order.
        setWhere: sql`excluded.source_generated_at > ${schema.standaloneSupportUsageMonths.sourceGeneratedAt}`,
      })
      .returning({ month: schema.standaloneSupportUsageMonths.month });
    const monthsApplied = applied.length;
    const monthsSkipped = payload.months.length - monthsApplied;

    await this.audit.record(tx, {
      actorPlatformUserId: actor.id,
      actorRole: actor.role,
      action: "standalone.diagnostics.ingest",
      outcome: "success",
      tenantId,
      targetType: "standalone_support_diagnostic",
      targetId: id,
      reason: null,
      requestId: null,
      before: null,
      after: this.auditAfter(
        inserted,
        payload,
        hostKey,
        monthsApplied,
        monthsSkipped,
        unbound,
        textBytes,
      ),
    });
    return {
      kind: "done",
      response: standaloneDiagnosticsIngestResponseSchema.parse({
        duplicate: false,
        diagnostic: diagnosticSummary(inserted),
        monthsApplied,
        monthsSkipped,
      }),
    };
  }

  private auditAfter(
    row: DiagnosticRow,
    payload: StandaloneSupportPayload,
    hostKey: string,
    monthsApplied: number,
    monthsSkipped: number,
    unboundAcknowledged: boolean,
    textBytes: number,
  ) {
    return {
      blobSha256: row.blobSha256,
      kid: row.kid,
      payloadVersion: row.payloadVersion,
      hostKey,
      siteId: row.siteId,
      generatedAt: row.generatedAt.toISOString(),
      appVersion: row.appVersion,
      hostVersion: row.hostVersion,
      pcRole: row.pcRole,
      licenseState: payload.v === 2 ? (payload.license?.state ?? null) : null,
      monthsApplied,
      monthsSkipped,
      unboundAcknowledged,
      textBytes,
    };
  }

  private async row(
    tx: SubscriptionTransaction,
    tenantId: string,
    id: string,
  ): Promise<DiagnosticRow> {
    const [row] = await tx
      .select()
      .from(schema.standaloneSupportDiagnostics)
      .where(
        and(
          eq(schema.standaloneSupportDiagnostics.tenantId, tenantId),
          eq(schema.standaloneSupportDiagnostics.id, id),
        ),
      );
    if (!row) throw new NotFoundException();
    return row;
  }

  async history(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    query: StandaloneDiagnosticsHistoryQuery,
  ): Promise<StandaloneDiagnosticsHistory> {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const cursor = query.cursor === undefined ? null : decodeHistoryCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null)
      throw new UnprocessableEntityException({ code: "standalone_diagnostics_cursor_invalid" });
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const t = schema.standaloneSupportDiagnostics;
        const found = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.tenantId, tenantId),
              cursor === null
                ? undefined
                : or(
                    lt(t.generatedAt, cursor.generatedAt),
                    and(eq(t.generatedAt, cursor.generatedAt), lt(t.id, cursor.id)),
                  ),
            ),
          )
          .orderBy(desc(t.generatedAt), desc(t.id))
          .limit(limit + 1);
        const page = found.slice(0, limit);
        const last = page.at(-1);
        return standaloneDiagnosticsHistorySchema.parse({
          items: page.map(diagnosticSummary),
          nextCursor:
            found.length > limit && last ? encodeHistoryCursor(last.generatedAt, last.id) : null,
        });
      },
      "read only",
    );
  }

  async detail(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    diagnosticId: string,
  ): Promise<StandaloneDiagnosticDetail> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const row = await this.row(tx, tenantId, diagnosticId);
        const parsed = standaloneSupportPayloadSchema.parse(row.payload);
        return standaloneDiagnosticDetailSchema.parse({
          diagnostic: diagnosticSummary(row),
          devices: parsed.devices,
          months: parsed.months,
          license: parsed.v === 2 ? parsed.license : null,
        });
      },
      "read only",
    );
  }

  async overview(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
  ): Promise<StandaloneDiagnosticsOverview> {
    const latestVersion = await this.latest.latestPublishedVersion();
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const t = schema.standaloneSupportDiagnostics;
        const lastPerHost = await tx
          .selectDistinctOn([t.hostKey])
          .from(t)
          .where(eq(t.tenantId, tenantId))
          .orderBy(asc(t.hostKey), desc(t.generatedAt), desc(t.id));
        const siteIds = lastPerHost.flatMap((row) => (row.siteId === null ? [] : [row.siteId]));
        const sites = siteIds.length
          ? await tx
              .select({ id: schema.standaloneSites.id, name: schema.standaloneSites.name })
              .from(schema.standaloneSites)
              .where(
                and(
                  eq(schema.standaloneSites.tenantId, tenantId),
                  inArray(schema.standaloneSites.id, siteIds),
                ),
              )
          : [];
        const issuances = siteIds.length
          ? await tx
              .selectDistinctOn([schema.standaloneLicenseIssuances.siteId])
              .from(schema.standaloneLicenseIssuances)
              .where(
                and(
                  eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
                  inArray(schema.standaloneLicenseIssuances.siteId, siteIds),
                ),
              )
              .orderBy(
                asc(schema.standaloneLicenseIssuances.siteId),
                desc(schema.standaloneLicenseIssuances.sequence),
              )
          : [];
        const hosts = lastPerHost
          .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())
          .map((row) => {
            const parsed = standaloneSupportPayloadSchema.safeParse(row.payload);
            const issued = issuances.find((issuance) => issuance.siteId === row.siteId);
            return {
              hostKey: row.hostKey,
              siteId: row.siteId,
              siteName: sites.find((site) => site.id === row.siteId)?.name ?? null,
              last: diagnosticSummary(row),
              license: parsed.success && parsed.data.v === 2 ? parsed.data.license : null,
              devices: {
                station: row.devicesStation,
                office: row.devicesOffice,
                handheld: row.devicesHandheld,
              },
              cloudLicense: issued
                ? { sequence: issued.sequence, validUntil: issued.validUntil.toISOString() }
                : null,
              outdated:
                latestVersion === null || row.appVersion === null
                  ? null
                  : isOlderVersion(row.appVersion, latestVersion),
            };
          });
        return standaloneDiagnosticsOverviewSchema.parse({
          hosts,
          latestPublishedVersion: latestVersion,
        });
      },
      "read only",
    );
  }

  async statistics(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    query: StandaloneDiagnosticsStatisticsQuery,
  ): Promise<StandaloneDiagnosticsStatistics> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const m = schema.standaloneSupportUsageMonths;
        const all = await tx.select().from(m).where(eq(m.tenantId, tenantId)).orderBy(asc(m.month));
        const hosts = [...new Set(all.map((row) => row.hostKey))].sort();
        const chosen = all.filter(
          (row) =>
            (query.hostKey === undefined || row.hostKey === query.hostKey) &&
            (query.from === undefined || row.month >= query.from) &&
            (query.to === undefined || row.month <= query.to),
        );
        const byMonth = new Map<string, typeof chosen>();
        for (const row of chosen) byMonth.set(row.month, [...(byMonth.get(row.month) ?? []), row]);
        return standaloneDiagnosticsStatisticsSchema.parse({
          hosts,
          multipleHosts: query.hostKey === undefined && hosts.length > 1,
          months: [...byMonth.entries()].map(([month, group]) => ({
            month,
            hostCount: group.length,
            stats: sumUsageMonths(group.map((row) => standaloneUsageMonthSchema.parse(row.stats))),
          })),
        });
      },
      "read only",
    );
  }

  /** Deletes reports older than 24 months (decision В6); their months go with them. Returns the count. */
  async purgeExpired(): Promise<number> {
    const deleted = await this.db
      .delete(schema.standaloneSupportDiagnostics)
      .where(lt(schema.standaloneSupportDiagnostics.receivedAt, retentionCutoff(this.now())))
      .returning({ id: schema.standaloneSupportDiagnostics.id });
    return deleted.length;
  }
}
```

Запись использует умолчание `requireStandaloneLicenseActor` (обе возможности), диапазон месяцев фильтруется в сервисе по ≤ 12×хостов строк, как велит спека.

- [ ] **Step 6: Зелёные тесты**

```bash
set -a; source .env; set +a
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-diagnostics.e2e.test.ts test/standalone-support-payload.test.ts test/standalone-diagnostics-views.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
```

Ожидается: e2e — 14 тестов passed (при отсутствии `DATABASE_URL` — `skipped`, назвать в отчёте). Если «two operators at once» падает с `500`/`23505`: проверить, что оба имени ограничения добавлены в `RETRYABLE_CONSTRAINTS` и что БД именованные ограничения создала (`\d standalone_support_diagnostics`). Если e2e «audit rows» падает на `requestId`: `PlatformAuditService.record` берёт `currentPlatformRequestId()` вне HTTP-контекста как `null` — это ожидаемо в тесте.

- [ ] **Step 7: Коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/api/src/modules/standalone-diagnostics apps/api/src/modules/standalone-licenses/standalone-license-authority.ts apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts apps/api/test/standalone-diagnostics.e2e.test.ts apps/api/test/standalone-support-payload.test.ts apps/api/test/standalone-diagnostics-views.test.ts packages/platform-contracts/src/standalone-diagnostics.ts packages/platform-contracts/test/standalone-diagnostics.test.ts
git diff --check
git add apps/api/src/modules/standalone-diagnostics apps/api/src/modules/standalone-licenses/standalone-license-authority.ts apps/api/src/modules/standalone-licenses/standalone-license-transaction.ts apps/api/test/standalone-diagnostics.e2e.test.ts apps/api/test/standalone-support-payload.test.ts apps/api/test/standalone-diagnostics-views.test.ts packages/platform-contracts/src/standalone-diagnostics.ts packages/platform-contracts/test/standalone-diagnostics.test.ts
git commit -m "feat(diagnostics): A2 — ingestion service: binding, idempotency, newest-month upsert, exact audit, reads, retention"
```

---

### Task 5 (А3): Контроллер, модуль, очиститель, инвентарь маршрутов, OpenAPI

**Files:**

- Create: `apps/api/src/modules/standalone-diagnostics/{standalone-diagnostics-retention,platform-standalone-diagnostics.controller,platform-standalone-diagnostics.module}.ts`, `apps/api/test/platform-standalone-diagnostics.routes.test.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/platform-route-contracts.ts`, `apps/api/test/platform-contract-openapi.test.ts`, `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**

- Consumes: сервис А2, `STANDALONE_SUPPORT_KEYS` и `configureStandaloneSupportKeys` (А1), `platformStandaloneDiagnosticsContracts` (К1), `RequirePlatformCapabilities`, `PlatformApiProtectedOk`, `parsePlatformResponse`, `ZodValidationPipe`.
- Produces: маршруты `POST|GET /platform/tenants/:tenantId/standalone-diagnostics[/overview|/statistics|/:diagnosticId]`; `PlatformStandaloneDiagnosticsModule.forRoot(env)`.

- [ ] **Step 1: Падающий тест политик маршрутов**

Создать `apps/api/test/platform-standalone-diagnostics.routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PlatformStandaloneDiagnosticsController } from "../src/modules/standalone-diagnostics/platform-standalone-diagnostics.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { platformCapabilitiesForRole } from "../src/platform-auth/platform-access-policy";

const policy = (method: keyof PlatformStandaloneDiagnosticsController) =>
  Reflect.getMetadata(
    PLATFORM_ACCESS_POLICY,
    PlatformStandaloneDiagnosticsController.prototype[method],
  );

describe("standalone diagnostics route policy (plan ДИАГ А3)", () => {
  it("writes need tenant read plus the licensing capability", () => {
    expect(policy("ingest")).toEqual({
      mode: "capabilities",
      capabilities: ["tenants.read", "standaloneLicenses.manage"],
    });
  });

  it("every read needs only tenant read", () => {
    for (const method of ["history", "overview", "statistics", "detail"] as const) {
      expect(policy(method), method).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read"],
      });
    }
  });

  it("no platform role gets the licensing capability except the administrator", () => {
    expect(platformCapabilitiesForRole("platform_admin")).toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole("support")).not.toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole("support")).toContain("tenants.read");
  });
});
```

Запуск (FAIL — контроллера нет).

- [ ] **Step 2: Контроллер, очиститель, модуль**

`platform-standalone-diagnostics.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  platformStandaloneDiagnosticsContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  type StandaloneDiagnosticsHistoryQuery,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsStatisticsQuery,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { STANDALONE_LICENSE_CAPABILITIES } from "../standalone-licenses/standalone-license-authority";
import { StandaloneDiagnosticsService } from "./standalone-diagnostics.service";

const tenantParam = new ZodValidationPipe(standaloneOpaqueIdSchema);
const uuidParam = new ZodValidationPipe(platformUuidSchema);

/** Support diagnostics of «Markiro Автоном» per tenant (spec 2026-10-15-standalone-support-diagnostics-ingestion). */
@ApiTags("platform-standalone-diagnostics")
@Controller("platform/tenants/:tenantId/standalone-diagnostics")
export class PlatformStandaloneDiagnosticsController {
  constructor(private readonly diagnostics: StandaloneDiagnosticsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Open a pasted support text, store its report and monthly statistics" })
  @PlatformApiProtectedOk({ body: contracts.ingest.body, response: contracts.ingest.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async ingest(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.ingest.body)) body: StandaloneDiagnosticsIngestRequest,
  ) {
    return parsePlatformResponse(
      contracts.ingest.response,
      await this.diagnostics.ingest(request.platformPrincipal, tenantId, body),
    );
  }

  @Get()
  @ApiOperation({ summary: "List a tenant's support reports, newest first" })
  @PlatformApiProtectedOk({ query: contracts.history.query, response: contracts.history.response })
  @RequirePlatformCapabilities("tenants.read")
  async history(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Query(new ZodValidationPipe(contracts.history.query)) query: StandaloneDiagnosticsHistoryQuery,
  ) {
    return parsePlatformResponse(
      contracts.history.response,
      await this.diagnostics.history(request.platformPrincipal, tenantId, query),
    );
  }

  @Get("overview")
  @ApiOperation({ summary: "Current versions and license use per host, from the last reports" })
  @PlatformApiProtectedOk({ response: contracts.overview.response })
  @RequirePlatformCapabilities("tenants.read")
  async overview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
  ) {
    return parsePlatformResponse(
      contracts.overview.response,
      await this.diagnostics.overview(request.platformPrincipal, tenantId),
    );
  }

  @Get("statistics")
  @ApiOperation({ summary: "Usage statistics by month, summed over hosts or for one host" })
  @PlatformApiProtectedOk({
    query: contracts.statistics.query,
    response: contracts.statistics.response,
  })
  @RequirePlatformCapabilities("tenants.read")
  async statistics(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Query(new ZodValidationPipe(contracts.statistics.query))
    query: StandaloneDiagnosticsStatisticsQuery,
  ) {
    return parsePlatformResponse(
      contracts.statistics.response,
      await this.diagnostics.statistics(request.platformPrincipal, tenantId, query),
    );
  }

  // Declared last: the static segments above must win over the id parameter.
  @Get(":diagnosticId")
  @ApiOperation({ summary: "One stored report: devices, months and license summary" })
  @ApiParam({ name: "diagnosticId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.detail.response })
  @RequirePlatformCapabilities("tenants.read")
  async detail(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("diagnosticId", uuidParam) diagnosticId: string,
  ) {
    return parsePlatformResponse(
      contracts.detail.response,
      await this.diagnostics.detail(request.platformPrincipal, tenantId, diagnosticId),
    );
  }
}
```

`standalone-diagnostics-retention.ts` (образец `invitations-reconciler.ts`):

```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { StandaloneDiagnosticsService } from "./standalone-diagnostics.service";

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Deletes support reports past the 24-month retention (decision В6); idempotent across replicas. */
@Injectable()
export class StandaloneDiagnosticsRetention implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(StandaloneDiagnosticsRetention.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly diagnostics: StandaloneDiagnosticsService) {}

  onModuleInit(): void {
    this.#timer = setInterval(() => {
      void this.diagnostics.purgeExpired().catch(() => {
        this.#logger.error("Could not purge expired support diagnostics");
      });
    }, PURGE_INTERVAL_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
```

`platform-standalone-diagnostics.module.ts`:

```ts
import { Logger, Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { PlatformStandaloneDiagnosticsController } from "./platform-standalone-diagnostics.controller";
import { StandaloneDiagnosticsRetention } from "./standalone-diagnostics-retention";
import {
  noPublishedStandaloneBuild,
  STANDALONE_DIAGNOSTICS_CLOCK,
  STANDALONE_LATEST_BUILD,
  StandaloneDiagnosticsService,
} from "./standalone-diagnostics.service";
import {
  configureStandaloneSupportKeys,
  STANDALONE_SUPPORT_KEYS,
  supportKeyKidMismatches,
} from "./standalone-support-keys";

/** Registered alongside the platform auth module (next to the licensing module). */
@Module({})
export class PlatformStandaloneDiagnosticsModule {
  static forRoot(env: Env): DynamicModule {
    const keys = configureStandaloneSupportKeys(env);
    for (const kid of supportKeyKidMismatches(keys ?? []))
      new Logger(PlatformStandaloneDiagnosticsModule.name).warn(
        `Support key ${kid} differs from the id derived from its public point`,
      );
    return {
      module: PlatformStandaloneDiagnosticsModule,
      imports: [PlatformAuditModule],
      controllers: [PlatformStandaloneDiagnosticsController],
      providers: [
        { provide: STANDALONE_SUPPORT_KEYS, useValue: keys },
        { provide: STANDALONE_DIAGNOSTICS_CLOCK, useValue: () => new Date() },
        { provide: STANDALONE_LATEST_BUILD, useValue: noPublishedStandaloneBuild },
        StandaloneDiagnosticsService,
        StandaloneDiagnosticsRetention,
      ],
    };
  }
}
```

В `app.module.ts`: импорт модуля и строка `PlatformStandaloneDiagnosticsModule.forRoot(env),` сразу после `PlatformStandaloneLicensesModule.forRoot(env),`.

- [ ] **Step 3: Инвентарь, контракты маршрутов, OpenAPI**

`test/subscription-route-inventory.test.ts`: рядом с записями `PlatformStandaloneLicensesController.*` добавить

```ts
  "PlatformStandaloneDiagnosticsController.ingest": platform(
    "support diagnostics ingestion requires tenant read plus the dedicated standalone license capability",
  ),
```

`test/platform-route-contracts.ts`: импортировать `platformStandaloneDiagnosticsContracts` и после записи `…/issuances/{licenseId}/file` добавить пять `route(...)` (порядок: ingest — `route("post", "/platform/tenants/{tenantId}/standalone-diagnostics", "200", c.ingest.response, { body: c.ingest.body })`; history — `route("get", …"/standalone-diagnostics", "200", c.history.response, { query: c.history.query })`; overview — `…/overview`; statistics — `…/statistics` с `query`; detail — `…/standalone-diagnostics/{diagnosticId}`).

`test/platform-contract-openapi.test.ts`: импортировать контроллер и `StandaloneDiagnosticsService`, добавить сервис в список заглушек `providers` (рядом со `StandaloneSitesService`), контроллер — в `controllers`; ожидаемое `toHaveLength(258)` увеличить на число новых схем в `CURRENT_SAAS_ROUTES` — **8** (ingest: ответ+тело; history: ответ+query; overview: ответ; statistics: ответ+query; detail: ответ) → `266`; если на момент исполнения базовое число иное, новое равно «старое + 8».

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/platform-standalone-diagnostics.routes.test.ts test/platform-contract-openapi.test.ts test/subscription-route-inventory.test.ts test/platform-standalone-licenses.routes.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api build
```

Ожидается: все зелёные; OpenAPI-тест подтверждает, что новые ответы и тела строго `.strict()` и без полей `secret|session|token|password|totp|recovery` (в схемах их нет: поле `kid` и `blobSha256` в ответ не входят).

- [ ] **Step 4: Сквозной HTTP-прогон политики (проверка вручную, если есть стенд)**

Если в `apps/api/test` есть HTTP-харнесс платформенных маршрутов (`platform-grant-activation.integration.test.ts` — образец), добавить в `standalone-diagnostics.e2e.test.ts` тест «без сессии → 401, сессия кабинета → 401/403, support POST → 403, support GET → 200». Если харнесса, поднимающего guard, для лицензий нет (`platform-standalone-licenses.routes.test.ts` ограничивается метаданными политики), этот шаг не выполняется и в отчёте пишется «HTTP-слой с guard не прогонялся автотестом; политики проверены метаданными, перечитывание актора — e2e сервиса».

- [ ] **Step 5: Коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/api/src/modules/standalone-diagnostics apps/api/src/app.module.ts apps/api/test/platform-standalone-diagnostics.routes.test.ts apps/api/test/platform-route-contracts.ts apps/api/test/platform-contract-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git diff --check
git add apps/api/src/modules/standalone-diagnostics apps/api/src/app.module.ts apps/api/test/platform-standalone-diagnostics.routes.test.ts apps/api/test/platform-route-contracts.ts apps/api/test/platform-contract-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(diagnostics): A3 — platform routes, module, retention purge, route inventory and OpenAPI"
```

---

### Task 6 (Т1): Клиент автонома — нагрузка v2

**Files:**

- Modify: `apps/standalone/src/office/info/support-usage.ts`, `apps/standalone/src/office/info/support-blocks.ts`, `apps/standalone/src/office/info/SupportSection.tsx`, `tools/standalone-support/decrypt.mjs`
- Test: `apps/standalone/test/support-report.test.ts`, `tools/standalone-support/test/decrypt.test.mjs`

**Interfaces:**

- Consumes: `OfficeLicense`, `LICENSE_QUOTA_KEYS`, `LICENSE_FEATURE_KEYS` (`src/host/protocol.ts`), `InstallRole` (`src/host/device.ts`), `safeValue` (`support-report.ts`), `standaloneSupportPayloadSchema` (читается относительным путём `../../../packages/platform-contracts/src/standalone-support` — файл самодостаточен и импортирует только `zod`).
- Produces: `USAGE_PAYLOAD_VERSION = 2`; `LicenseLoad`, `licenseLoadOf`; `UsagePayloadAbout`; `usagePayload(stats, about)` v2; поле `license?: LicenseLoad` в `SupportContext`.

- [ ] **Step 1: Падающие тесты**

В `apps/standalone/test/support-report.test.ts` (блок «Статистика использования …»):

1. Заменить вызовы `usagePayload(…, { generatedAt, appVersion, hostVersion })` (два места, ~строки 391–400) на вызовы с полным `about`; добавить константу рядом с `FACTS`:

```ts
const ABOUT = {
  generatedAt: FACTS.generatedAt,
  appVersion: FACTS.appVersion,
  hostVersion: FACTS.hostVersion,
  hostId: HOST_ID,
  role: "host" as const,
  os: FACTS.os,
  arch: FACTS.arch,
  webview: FACTS.webview,
  license: null,
};
```

2. В тесте «puts the counts into the text …» ожидание `toMatchObject({ v: 1, … })` заменить на `v: 2` и добавить `hostId: HOST_ID, role: "host", os: "Windows 11", arch: "x64", webview: "WebView2 130.0.2849.80", license: null`.
3. Добавить тесты:

```ts
import { standaloneSupportPayloadSchema } from "../../../packages/platform-contracts/src/standalone-support";
import { licenseLoadOf } from "../src/office/info/support-usage.js";

describe("Нагрузка v2 для приёма в SaaS-админке (план ДИАГ Т1)", () => {
  const stats = usageStatsSchema.parse(
    JSON.parse(readFileSync(new URL("../proto/fixtures/usage-stats.json", testModuleUrl), "utf8")),
  );

  it("builds v2 that the cloud's strict schema accepts, with the license summary only", () => {
    const license = {
      ...ACTIVE_LICENSE,
      // Fields the host knows and the summary must never copy.
      customer: { name: "Атолл", inn: "7707083893" },
      binding: { ...ACTIVE_LICENSE.binding, fingerprint: HOST_FINGERPRINT, orgInn: "7707083893" },
    } as typeof ACTIVE_LICENSE;
    const json = usagePayload(stats, { ...ABOUT, license });
    const parsed = standaloneSupportPayloadSchema.parse(JSON.parse(json));
    expect(parsed).toMatchObject({ v: 2, hostId: HOST_ID, role: "host" });
    expect(parsed.v === 2 && parsed.license?.quotas.stations).toEqual(license.quotas.stations);
    for (const secret of [
      "Атолл",
      "7707083893",
      HOST_FINGERPRINT,
      "customer",
      "fingerprint",
      "orgInn",
      "planVersionId",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("copies a license field by field: a field the host adds cannot reach the token", () => {
    const polluted = {
      ...ACTIVE_LICENSE,
      secretNote: "x",
      quotas: { ...ACTIVE_LICENSE.quotas, extra: 1 },
    } as typeof ACTIVE_LICENSE;
    const json = usagePayload(stats, { ...ABOUT, license: polluted });
    expect(json).not.toContain("secretNote");
    expect(standaloneSupportPayloadSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });

  it("says license null when the host did not answer or the user is no administrator, and a trial has no file fields", () => {
    expect(
      licenseLoadOf({
        status: "rejected",
        reason: new HostError({
          kind: "api",
          code: "forbidden",
          status: 403,
          message: "forbidden",
          details: {},
        }),
      }),
    ).toEqual({ kind: "forbidden" });
    expect(licenseLoadOf({ status: "rejected", reason: new Error("down") })).toEqual({
      kind: "failed",
    });
    const trial = JSON.parse(usagePayload(stats, { ...ABOUT, license: TRIAL })) as {
      license: { plan: unknown; sequence: unknown };
    };
    expect(trial.license.plan).toBeNull();
    expect(trial.license.sequence).toBeNull();
    expect(JSON.parse(usagePayload(stats, ABOUT))).toMatchObject({ license: null });
  });

  it("maps the role and a development build to null, and refuses a malformed host id", () => {
    const parse = (
      about: Partial<typeof ABOUT> & { role?: "host" | "station" | "office" | "unknown" | null },
    ) =>
      JSON.parse(usagePayload(stats, { ...ABOUT, ...about })) as { role: unknown; hostId: unknown };
    expect(parse({ role: "unknown" }).role).toBeNull();
    expect(parse({ role: null }).role).toBeNull();
    expect(parse({ role: "office" }).role).toBe("office");
    expect(parse({ hostId: "not-a-uuid" }).hostId).toBeNull();
    expect(parse({ hostId: HOST_ID.toUpperCase() }).hostId).toBe(HOST_ID);
  });
});
```

(Имена `ACTIVE_LICENSE`, `TRIAL`, `HOST_FINGERPRINT`, `HostError`, `HOST_ID` уже импортированы/объявлены в этом тестовом файле; `HostError` принимает объект `{ kind, code, status, message, details }`, как в соседнем тесте `usageLoadOf`.)

4. Тест вклада в контексте: в `context(...)` добавить параметр `license?: LicenseLoad` и проверить, что при `{kind:"ok", license: ACTIVE_LICENSE}` токен открывается с `license.state === ACTIVE_LICENSE.state`, а при `forbidden`/`failed` — с `license: null`.

В `tools/standalone-support/test/decrypt.test.mjs` добавить:

```js
test("table() prints the host, the system and the license summary of a v2 payload", () => {
  const output = table({
    v: 2,
    generatedAt: "2026-10-14T09:00:00.000Z",
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    months: [],
    devices: { station: 3, office: 2, handheld: 1 },
    hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    role: "host",
    os: "Windows 11",
    arch: "x64",
    webview: "WebView2 130",
    license: {
      state: "active",
      plan: "subscription",
      sequence: 3,
      validUntil: "2027-10-01T00:00:00Z",
      daysLeft: 350,
      quotas: { stations: { limit: 3, used: 2, over: false } },
    },
  });
  assert.match(
    output,
    /Хост: 3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f; роль host; Windows 11, x64, WebView2 130/u,
  );
  assert.match(output, /Лицензия: active, subscription, №3, до 2027-10-01T00:00:00Z/u);
  assert.match(output, /stations 2\/3/u);
  assert.doesNotMatch(
    table({
      v: 1,
      generatedAt: "x",
      appVersion: null,
      hostVersion: null,
      months: [],
      devices: { station: 0, office: 0, handheld: 0 },
    }),
    /Лицензия/u,
  );
});
```

Запуск (FAIL: v 1, нет `licenseLoadOf`, нет вывода v2):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/support-report.test.ts
node --test tools/standalone-support/test/decrypt.test.mjs
```

- [ ] **Step 2: `support-usage.ts`**

Правки:

```ts
import type { InstallRole } from "../../host/device.js";
import {
  LICENSE_FEATURE_KEYS,
  LICENSE_QUOTA_KEYS,
  type OfficeLicense,
} from "../../host/protocol.js";
import { safeValue } from "./support-report.js";
```

`export const USAGE_PAYLOAD_VERSION = 2;` Добавить:

```ts
/** How the page learned the license: the host's answer, or why there is none. */
export type LicenseLoad =
  { kind: "ok"; license: OfficeLicense } | { kind: "forbidden" } | { kind: "failed" };

export function licenseLoadOf(result: PromiseSettledResult<OfficeLicense>): LicenseLoad {
  if (result.status === "fulfilled") return { kind: "ok", license: result.value };
  const error: unknown = result.reason;
  return error instanceof HostError && error.code === "forbidden"
    ? { kind: "forbidden" }
    : { kind: "failed" };
}

/** The license summary, field by field: never the customer, the INN, the fingerprint or the file. */
function pickLicense(license: OfficeLicense) {
  const file = license.license;
  const quota = (key: (typeof LICENSE_QUOTA_KEYS)[number]) => ({
    limit: license.quotas[key].limit,
    used: license.quotas[key].used,
    over: license.quotas[key].over,
  });
  return {
    state: license.state,
    plan: file?.plan ?? null,
    licenseId: file?.licenseId.toLowerCase() ?? null,
    sequence: file?.sequence ?? null,
    kid: file?.kid ?? null,
    validFrom: file?.validFrom ?? null,
    validUntil: file?.validUntil ?? null,
    graceDays: file?.graceDays ?? null,
    daysLeft: license.daysLeft,
    quotas: Object.fromEntries(LICENSE_QUOTA_KEYS.map((key) => [key, quota(key)])),
    features: Object.fromEntries(LICENSE_FEATURE_KEYS.map((key) => [key, license.features[key]])),
    innMatches: license.binding.innMatches,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const system = (value: string | null): string | null => {
  if (value === null) return null;
  const text = safeValue(value);
  return text === "" ? null : text;
};

export interface UsagePayloadAbout {
  generatedAt: Date;
  appVersion: string | null;
  hostVersion: string | null;
  hostId: string | null;
  role: InstallRole | "unknown";
  os: string | null;
  arch: string | null;
  webview: string | null;
  license: OfficeLicense | null;
}
```

`usagePayload(stats, about: UsagePayloadAbout)` собирает:

```ts
return JSON.stringify({
  v: USAGE_PAYLOAD_VERSION,
  generatedAt: about.generatedAt.toISOString(),
  appVersion: about.appVersion,
  hostVersion: about.hostVersion,
  months: stats.months.map(pickMonth),
  devices: {
    station: stats.devices.station,
    office: stats.devices.office,
    handheld: stats.devices.handheld,
  },
  hostId: about.hostId !== null && UUID.test(about.hostId) ? about.hostId.toLowerCase() : null,
  role: about.role === "unknown" ? null : about.role,
  os: system(about.os),
  arch: system(about.arch),
  webview: system(about.webview),
  license: about.license === null ? null : pickLicense(about.license),
});
```

(порядок ключей не важен; docstring над функцией дополнить: «и hostId, роль ПК, ОС, архитектура, WebView2, сводка лицензии»). В `createUsageContributor` перед `usagePayload` вычислить `const license = context.license?.kind === "ok" ? context.license.license : null;` и передать новые поля из `facts`: `hostId: facts.hostId, role: facts.role, os: facts.os, arch: facts.arch, webview: facts.webview, license`.

`support-blocks.ts`: импортировать `LicenseLoad` и добавить в `SupportContext` поле `license?: LicenseLoad;` с комментарием «what the page learned of the host's license (for the encrypted summary)».

`SupportSection.tsx`: заменить

```ts
const [usageResult] = await Promise.allSettled([
  session.call((token) => session.api.getUsageStats(token)),
]);
```

на

```ts
const [usageResult, licenseResult] = await Promise.allSettled([
  session.call((token) => session.api.getUsageStats(token)),
  session.call((token) => session.api.getLicense(token)),
]);
```

и в вызов `collectSupportBlocks` добавить `...(licenseResult === undefined ? {} : { license: licenseLoadOf(licenseResult) })`; импортировать `licenseLoadOf`.

- [ ] **Step 3: `decrypt.mjs` печатает v2**

В `table(payload)` после строки «Устройства…» добавить для `payload.v === 2` две строки (перед пустой строкой таблицы):

```js
function licenseLine(license) {
  if (!license) return "Лицензия: нет данных";
  const quotas = Object.entries(license.quotas ?? {})
    .map(([name, q]) => `${name} ${q.used}/${q.limit ?? "∞"}${q.over ? " (сверх)" : ""}`)
    .join(", ");
  return `Лицензия: ${license.state}, ${license.plan ?? "без файла"}, ${
    license.sequence === null ? "без номера" : `№${license.sequence}`
  }, до ${license.validUntil ?? "—"}; ${quotas}`;
}
```

и в массив результата: `...(payload.v === 2 ? [`Хост: ${payload.hostId ?? "?"}; роль ${payload.role ?? "разработческая сборка"}; ${[payload.os, payload.arch, payload.webview].filter(Boolean).join(", ") || "система неизвестна"}`, licenseLine(payload.license)] : [])`. Таблица месяцев и v1 не меняются. Обновить комментарий-шапку файла (формат нагрузки v2).

- [ ] **Step 4: Зелёное**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/support-report.test.ts test/support-crypto.test.ts
node --test tools/standalone-support/test/decrypt.test.mjs
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
```

Ожидается: все зелёные (Vitest автоном — весь пакет; Windows-проверок нет, называть это).

- [ ] **Step 5: Коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/support-usage.ts apps/standalone/src/office/info/support-blocks.ts apps/standalone/src/office/info/SupportSection.tsx apps/standalone/test/support-report.test.ts tools/standalone-support/decrypt.mjs tools/standalone-support/test/decrypt.test.mjs
git diff --check
git add apps/standalone/src/office/info/support-usage.ts apps/standalone/src/office/info/support-blocks.ts apps/standalone/src/office/info/SupportSection.tsx apps/standalone/test/support-report.test.ts tools/standalone-support/decrypt.mjs tools/standalone-support/test/decrypt.test.mjs
git commit -m "feat(standalone): T1 — support payload v2 (host id, role, system, license summary) inside the encrypted token"
```

---

### Task 7 (Ч1): Сквозная чётность клиента, `decrypt.mjs` и API

**Files:**

- Create: `apps/standalone/test/support-parity.test.ts`

**Interfaces:**

- Consumes: `encryptSupportPayload` (настоящий писатель), `usagePayload` (Т1), `decryptBlob`/`findBlob` (`decrypt.mjs`), `openSupportBlob` (А1, читается относительным путём — файл только на `node:`), `standaloneSupportPayloadSchema` (К1, относительным путём).
- Produces: тест, который падает, если писатель, инструмент владельца и приёмник разойдутся.

- [ ] **Step 1: Тест (он же падающий, пока Т1/А1 не слиты)**

Создать `apps/standalone/test/support-parity.test.ts`:

```ts
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openSupportBlob } from "../../api/src/modules/standalone-diagnostics/support-blob";
import { standaloneSupportPayloadSchema } from "../../../packages/platform-contracts/src/standalone-support";
import { decryptBlob, findBlob } from "../../../tools/standalone-support/decrypt.mjs";
import { usageStatsSchema } from "../src/host/usage-stats.js";
import { encryptSupportPayload } from "../src/office/info/support-crypto.js";
import { usagePayload } from "../src/office/info/support-usage.js";
import { ACTIVE_LICENSE } from "./support/license.js";

const testModuleUrl = import.meta.url;
const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

describe("one token, three readers (plan ДИАГ Ч1)", () => {
  const stats = usageStatsSchema.parse(
    JSON.parse(readFileSync(new URL("../proto/fixtures/usage-stats.json", testModuleUrl), "utf8")),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = {
    kid: "sup-parity",
    jwk: { kty: "EC" as const, crv: "P-256" as const, x: String(jwk.x), y: String(jwk.y) },
  };
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const payload = usagePayload(stats, {
    generatedAt: new Date("2026-10-14T09:00:00Z"),
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    hostId: HOST_ID,
    role: "host",
    os: "Windows 11",
    arch: "x64",
    webview: "WebView2 130.0.2849.80",
    license: ACTIVE_LICENSE,
  });

  it.each([true, false])(
    "the app's writer (compress: %s) is opened identically by the cloud and by the maker's tool",
    async (compress) => {
      const token = await encryptSupportPayload(payload, key, {
        compress,
        subtle: webcrypto.subtle,
      });
      const text = `Сведения для поддержки\r\nДанные для анализа\r\nЗашифрованные данные\r\n${token}\r\n`;

      const cloud = openSupportBlob(text, [{ kid: "sup-parity", privateKey }]);
      const tool = decryptBlob(findBlob(text), pem);

      expect(cloud.ok).toBe(true);
      if (!cloud.ok) throw new Error("the cloud did not open the app's token");
      expect(cloud.json).toEqual(JSON.parse(payload));
      expect(tool.json).toEqual(cloud.json);
      expect(cloud.compressed).toBe(compress);
      // And the cloud's strict schema takes exactly what the app writes.
      const parsed = standaloneSupportPayloadSchema.parse(cloud.json);
      expect(parsed).toMatchObject({ v: 2, hostId: HOST_ID, role: "host", os: "Windows 11" });
    },
  );
});
```

Если `webcrypto.subtle` не принимается типом `SubtleCrypto` (в существующем `support-crypto.test.ts` опция передаётся так же), использовать ту же форму вызова, что в нём.

- [ ] **Step 2: Запуск и коммит**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/support-parity.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
```

Ожидается: `2 passed`. Если `typecheck` автонома ругается на импорт файла API (строгие опции), единственная допустимая правка — убрать из `support-blob.ts` конструкции, которые автономный `tsconfig` не принимает (файл по условию А1 зависит только от `node:`); тест и импорт по пути не обходить `// @ts-ignore`.

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/test/support-parity.test.ts
git diff --check
git add apps/standalone/test/support-parity.test.ts
git commit -m "test(diagnostics): Ch1 — the app's token is opened identically by the cloud, the maker's tool and the strict schema"
```

---

### Task 8 (У1): Вкладка «Диагностика» в SaaS-админке

**Files:**

- Create: `apps/saas-admin/src/pages/tenants/{diagnostics-api,diagnostics-format}.ts`, `apps/saas-admin/src/pages/tenants/{TenantDiagnosticsPanel,DiagnosticsOverview,DiagnosticsIngestForm,DiagnosticsStatistics,DiagnosticsHistory}.tsx`, `apps/saas-admin/test/{diagnostics-fixtures.ts,diagnostics-panel.test.tsx}`
- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`, `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json`, `apps/saas-admin/src/global.css`, `apps/saas-admin/test/tenant-detail.test.tsx`

**Interfaces:**

- Consumes: контракты К1; `platformApiFetch`, `ApiRequestError`; `@markiro/ui` (`Alert`, `Button`, `Card`, `StatusChip`, `Table`, `Textarea`, `Select`/нативный `select`); `principal.capabilities` (как `canManageStandalone` в `TenantPage`).
- Produces: вкладка `?tab=diagnostics` (видна при `tenants.read`); блок вставки только при `standaloneLicenses.manage`.

- [ ] **Step 1: Фикстуры и падающий тест панели**

Создать `apps/saas-admin/test/diagnostics-fixtures.ts`:

```ts
import type {
  StandaloneDiagnosticDetail,
  StandaloneDiagnosticsHistory,
  StandaloneDiagnosticsIngestResponse,
  StandaloneDiagnosticsOverview,
  StandaloneDiagnosticsStatistics,
} from "@markiro/platform-contracts";

export const DIAG_TENANT_ID = "11111111-2222-4333-8444-555555555555";
export const DIAG_HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const DIAG_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const month = (key: string, accepted: number) => ({
  month: key,
  shifts: {
    aggregation: 6,
    validation: 1,
    validationPrint: 0,
    fromOffice: 5,
    fromStation: 2,
    withPallets: 2,
  },
  scans: { accepted, duplicates: 64, rejected: 9 },
  boxes: { closed: 585, disassembled: 0, codes: accepted },
  pallets: { closed: 13, disassembled: 0 },
  exceptions: {
    boxUndo: 4,
    boxClear: 0,
    boxReprint: 2,
    boxDisassemble: 0,
    palletReprint: 0,
    palletDisassemble: 0,
  },
  conflicts: { late: 1, displaced: 0, reviewed: 0 },
  reprints: { warehouse: 0, unitLabel: 0 },
  disaggregationApplied: 0,
  syncRejected: 2,
});

export const DIAG_SUMMARY = {
  id: DIAG_ID,
  hostKey: DIAG_HOST_ID,
  siteId: "99999999-8888-4777-8666-555555555555",
  generatedAt: "2026-10-14T09:00:00.000Z",
  receivedAt: "2026-10-15T10:00:00.000Z",
  kid: "sup-d11c3182",
  payloadVersion: 2 as const,
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  pcRole: "host" as const,
  os: "Windows 11",
  arch: "x64",
  webview: "WebView2 130.0.2849.80",
  licenseState: "active",
};

const LICENSE = {
  state: "active",
  plan: "subscription",
  licenseId: "11111111-2222-4333-8444-555555555555",
  sequence: 3,
  kid: "lic-1",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2027-10-01T00:00:00Z",
  graceDays: 14,
  daysLeft: 350,
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 3, used: 4, over: true },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 5, used: 1, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: false,
    handheld: true,
    customLogo: false,
  },
  innMatches: true,
};

export const DIAG_OVERVIEW: StandaloneDiagnosticsOverview = {
  hosts: [
    {
      hostKey: DIAG_HOST_ID,
      siteId: DIAG_SUMMARY.siteId,
      siteName: "Цех розлива",
      last: DIAG_SUMMARY,
      license: LICENSE,
      devices: { station: 3, office: 2, handheld: 1 },
      cloudLicense: { sequence: 4, validUntil: "2027-11-01T00:00:00.000Z" },
      outdated: null,
    },
  ],
  latestPublishedVersion: null,
};
export const DIAG_EMPTY_OVERVIEW: StandaloneDiagnosticsOverview = {
  hosts: [],
  latestPublishedVersion: null,
};

export const DIAG_STATISTICS: StandaloneDiagnosticsStatistics = {
  hosts: [DIAG_HOST_ID, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e60"],
  multipleHosts: true,
  months: [
    { month: "2026-08", hostCount: 1, stats: month("2026-08", 5000) },
    { month: "2026-10", hostCount: 2, stats: month("2026-10", 14040) },
  ],
};

export const DIAG_HISTORY: StandaloneDiagnosticsHistory = {
  items: [DIAG_SUMMARY],
  nextCursor: null,
};
export const DIAG_DETAIL: StandaloneDiagnosticDetail = {
  diagnostic: DIAG_SUMMARY,
  devices: { station: 3, office: 2, handheld: 1 },
  months: [month("2026-10", 7020)],
  license: LICENSE,
};
export const DIAG_INGESTED: StandaloneDiagnosticsIngestResponse = {
  duplicate: false,
  diagnostic: DIAG_SUMMARY,
  monthsApplied: 2,
  monthsSkipped: 0,
};
```

Создать `apps/saas-admin/test/diagnostics-panel.test.tsx` (стиль — `standalone-sites-panel.test.tsx`, `stubApi` по ключу `METHOD url`):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { TenantDiagnosticsPanel } from "../src/pages/tenants/TenantDiagnosticsPanel.js";
import { jsonResponse } from "./render.js";
import {
  DIAG_DETAIL,
  DIAG_EMPTY_OVERVIEW,
  DIAG_HISTORY,
  DIAG_ID,
  DIAG_INGESTED,
  DIAG_OVERVIEW,
  DIAG_STATISTICS,
  DIAG_TENANT_ID,
} from "./diagnostics-fixtures.js";

const BASE = `/api/platform/tenants/${DIAG_TENANT_ID}/standalone-diagnostics`;
function stubApi(routes: Record<string, Array<() => Response>>) {
  const calls: Array<{ key: string; body: unknown }> = [];
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
const standard = () => ({
  [`GET ${BASE}/overview`]: [() => jsonResponse(DIAG_OVERVIEW)],
  [`GET ${BASE}/statistics`]: [() => jsonResponse(DIAG_STATISTICS)],
  [`GET ${BASE}`]: [() => jsonResponse(DIAG_HISTORY)],
  [`GET ${BASE}/${DIAG_ID}`]: [() => jsonResponse(DIAG_DETAIL)],
});
function renderPanel(canWrite: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider>
          <TenantDiagnosticsPanel tenantId={DIAG_TENANT_ID} canWrite={canWrite} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tenant diagnostics tab (plan ДИАГ У1)", () => {
  it("shows quotas as used of available, an over-limit badge with text, the cloud file comparison and no 'outdated' without a source", async () => {
    stubApi(standard());
    renderPanel(true);
    expect(await screen.findByText(/Цех розлива/u)).toBeInTheDocument();
    expect(screen.getByText(/4 из 3/u)).toBeInTheDocument();
    expect(screen.getByText(/сверх лимита/u)).toBeInTheDocument();
    expect(screen.getByText(/∞/u)).toBeInTheDocument();
    expect(screen.getByText(/№3/u)).toBeInTheDocument();
    expect(screen.getByText(/№4/u)).toBeInTheDocument();
    expect(screen.queryByText(/устарел/iu)).not.toBeInTheDocument();
  });

  it("shows the empty state with the hint when there are no reports", async () => {
    stubApi({
      ...standard(),
      [`GET ${BASE}/overview`]: [() => jsonResponse(DIAG_EMPTY_OVERVIEW)],
      [`GET ${BASE}/statistics`]: [
        () => jsonResponse({ hosts: [], multipleHosts: false, months: [] }),
      ],
      [`GET ${BASE}`]: [() => jsonResponse({ items: [], nextCursor: null })],
    });
    renderPanel(true);
    expect(await screen.findByText(/Вставьте текст «Сведения для поддержки»/u)).toBeInTheDocument();
  });

  it("hides the paste block without the licensing capability", async () => {
    stubApi(standard());
    renderPanel(false);
    await screen.findByText(/Цех розлива/u);
    expect(screen.queryByLabelText(/Текст «Сведения для поддержки»/u)).not.toBeInTheDocument();
  });

  it("sends the text, clears it, and reports the saved report", async () => {
    const calls = stubApi({ ...standard(), [`POST ${BASE}`]: [() => jsonResponse(DIAG_INGESTED)] });
    renderPanel(true);
    const input = await screen.findByLabelText(/Текст «Сведения для поддержки»/u);
    await userEvent.type(input, "MKS1.sup-d11c3182.AAAA");
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    expect(await screen.findByText(/Сохранено/u)).toBeInTheDocument();
    expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
      text: "MKS1.sup-d11c3182.AAAA",
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain("MKS1.sup-d11c3182");
    expect(location.search).not.toContain("MKS1");
  });

  it("asks to confirm an unbound host and repeats the request with the flag", async () => {
    const calls = stubApi({
      ...standard(),
      [`POST ${BASE}`]: [
        () =>
          jsonResponse(
            { code: "standalone_diagnostics_host_unbound", message: "x", requestId: "r" },
            409,
          ),
        () => jsonResponse(DIAG_INGESTED),
      ],
    });
    renderPanel(true);
    await userEvent.type(
      await screen.findByLabelText(/Текст «Сведения для поддержки»/u),
      "MKS1.x.AAAA",
    );
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    expect(
      await screen.findByText(/Площадка не найдена среди площадок клиента/u),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Сохранить без привязки/u }));
    await waitFor(() => expect(calls.filter((c) => c.key === `POST ${BASE}`)).toHaveLength(2));
    expect(calls.filter((c) => c.key === `POST ${BASE}`)[1]?.body).toEqual({
      text: "MKS1.x.AAAA",
      acknowledgeUnboundHost: true,
    });
  });

  it.each([
    ["standalone_diagnostics_unknown_key", /не подходит ключ/u],
    ["standalone_diagnostics_undecryptable", /не удалось расшифровать/u],
    ["standalone_diagnostics_host_other_tenant", /другого клиента/u],
    ["standalone_diagnostics_not_configured", /приём не настроен/u],
    ["standalone_diagnostics_text_too_large", /слишком большой/u],
  ])("explains %s in human words without the token", async (code, words) => {
    stubApi({
      ...standard(),
      [`POST ${BASE}`]: [() => jsonResponse({ code, message: "x", requestId: "r" }, 409)],
    });
    renderPanel(true);
    await userEvent.type(
      await screen.findByLabelText(/Текст «Сведения для поддержки»/u),
      "SECRET-TOKEN-TEXT",
    );
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert.textContent).not.toContain("SECRET-TOKEN-TEXT");
  });

  it("shows 'no data' for a missing month, never zero, and notes several hosts", async () => {
    stubApi(standard());
    renderPanel(false);
    const table = await screen.findByRole("table", { name: /Статистика по месяцам/u });
    expect(within(table).getByText("2026-09")).toBeInTheDocument();
    const gap = within(table).getByText("2026-09").closest("tr");
    expect(gap).toHaveTextContent(/нет данных/u);
    expect(screen.getByText(/несколько хостов/iu)).toBeInTheDocument();
  });

  it("opens one report from the history", async () => {
    stubApi(standard());
    renderPanel(false);
    await userEvent.click(await screen.findByRole("button", { name: /Открыть отчёт/u }));
    expect(await screen.findByText(/WebView2 130/u)).toBeInTheDocument();
  });
});
```

(Формат тела ошибки платформы — по `jsonResponse` и `ApiRequestError` в `api/client.ts`: сверить фактическую форму `{ code, message, requestId }` и статус; для хранения «code» используется то же поле, что читает `standaloneErrorKey`.)

Запуск (FAIL — компонентов нет):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/diagnostics-panel.test.tsx
```

- [ ] **Step 2: API-клиент и форматирование**

`apps/saas-admin/src/pages/tenants/diagnostics-api.ts`:

```ts
import {
  platformStandaloneDiagnosticsContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  type StandaloneDiagnosticDetail,
  type StandaloneDiagnosticsHistory,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsIngestResponse,
  type StandaloneDiagnosticsOverview,
  type StandaloneDiagnosticsStatistics,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

const base = (tenantId: string) =>
  `/tenants/${encodeURIComponent(standaloneOpaqueIdSchema.parse(tenantId))}/standalone-diagnostics`;

export const diagnosticsKey = (tenantId: string, ...part: string[]) =>
  ["platform", "tenants", tenantId, "standalone-diagnostics", ...part] as const;

export function ingestDiagnostics(
  tenantId: string,
  input: StandaloneDiagnosticsIngestRequest,
): Promise<StandaloneDiagnosticsIngestResponse> {
  return platformApiFetch(base(tenantId), {
    method: contracts.ingest.method,
    responseSchema: contracts.ingest.response,
    body: JSON.stringify(contracts.ingest.body.parse(input)),
  });
}

export function getDiagnosticsOverview(tenantId: string): Promise<StandaloneDiagnosticsOverview> {
  return platformApiFetch(`${base(tenantId)}/overview`, {
    responseSchema: contracts.overview.response,
  });
}

export function getDiagnosticsHistory(
  tenantId: string,
  cursor?: string,
): Promise<StandaloneDiagnosticsHistory> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return platformApiFetch(`${base(tenantId)}${query}`, {
    responseSchema: contracts.history.response,
  });
}

export function getDiagnosticsStatistics(
  tenantId: string,
  hostKey?: string,
): Promise<StandaloneDiagnosticsStatistics> {
  const query = hostKey === undefined ? "" : `?hostKey=${encodeURIComponent(hostKey)}`;
  return platformApiFetch(`${base(tenantId)}/statistics${query}`, {
    responseSchema: contracts.statistics.response,
  });
}

export function getDiagnostic(tenantId: string, id: string): Promise<StandaloneDiagnosticDetail> {
  return platformApiFetch(`${base(tenantId)}/${platformUuidSchema.parse(id)}`, {
    responseSchema: contracts.detail.response,
  });
}
```

`diagnostics-format.ts`: `diagnosticsErrorKey(error)` (по `ApiRequestError.code`, множество кодов `STANDALONE_DIAGNOSTICS_ERROR_CODES` → `tenants.detail.diagnostics.errors.<code>`, иначе `….errors.generic`), `useDiagnosticsDate()` (как `useStandaloneDate`, но `dateStyle: "medium", timeStyle: "short"`), `daysAgo(iso, now)` (целые сутки), `STALE_DAYS = 45`, `monthRange(months)` — непрерывный список ключей `YYYY-MM` от первого до последнего месяца данных (чтобы пропуск показывался строкой «нет данных»), `quotaText(t, quota)` → `«2 из 3»`/`«занято 4 из 3»`/`∞`.

- [ ] **Step 3: Компоненты**

`TenantDiagnosticsPanel.tsx`: композиция `<section aria-labelledby>`: `DiagnosticsOverview`, `DiagnosticsIngestForm` (только `canWrite`), `DiagnosticsStatistics`, `DiagnosticsHistory`. Общие ключи запросов — `diagnosticsKey`.

`DiagnosticsOverview.tsx`: `useQuery(overview)`; пустое состояние `t("…diagnostics.empty")` («Вставьте текст «Сведения для поддержки»…»); на хост — `Card` с `<dl>`: роль, версия приложения и хоста, «получено N дн. назад» + `StatusChip phase="attention"` с текстом при `daysAgo > STALE_DAYS`, ОС/архитектура/WebView2, лицензия (состояние, тариф, `validUntil`/`daysLeft`), квоты по `STANDALONE_SUPPORT_QUOTA_KEYS` как `quotaText` (при `over` — `StatusChip phase="attention"` с текстом «сверх лимита»), устройства по видам, возможности (включено/выключено словами), строка сравнения «в файле на ПК — №{{pc}}; в облаке выпущен №{{cloud}}» при `cloudLicense !== null && license?.sequence` (если номера равны — «совпадает»; иначе нейтрально «файл на площадке устарел»), `outdated === true` → бейдж «Версия устарела: опубликована {{latest}}»; `outdated === null` ничего не показывает.

`DiagnosticsIngestForm.tsx`: моноширинный `Textarea` с подписью «Текст «Сведения для поддержки»» и счётчиком знаков (`aria-live="polite"`), кнопка «Разобрать и сохранить» (disabled при пустом тексте/запросе); `useMutation(ingestDiagnostics)`; при успехе: `setText("")`, инвалидация `diagnosticsKey(tenantId)` целиком, сообщение «Сохранено: {{host}}, {{version}}, месяцев обновлено {{n}}» или «Уже загружено»; ошибка `host_unbound` → `Alert tone="warn"` с текстом «Площадка не найдена среди площадок клиента. Сохранить без привязки?» и кнопкой «Сохранить без привязки» (повтор с `acknowledgeUnboundHost: true`, текст в состоянии остаётся до успеха); остальные ошибки — `Alert tone="error" role="alert"` с `t(diagnosticsErrorKey(error))`; введённый текст в сообщение не попадает. Подтверждение ухода при несохранённом вводе — `useUnsavedChanges` (как в соседних формах: посмотреть сигнатуру в `useUnsavedChanges.ts`).

`DiagnosticsStatistics.tsx`: переключатель хоста (`<select>` «Все хосты» + `hosts`, подпись; смена → новый ключ запроса), примечание «Сумма по нескольким хостам» при `multipleHosts`, таблица `Table` с `aria-label` «Статистика по месяцам» и колонками как в `decrypt.mjs` (смены по режимам, принято/дублей/отклонено, короба, кодов на короб, паллеты, исключения, конфликты, перепечатки, расформирование, отказы синхронизации); строки — по `monthRange`, отсутствующие — одна ячейка «нет данных» на всю строку; под таблицей `DiagnosticsBars` (три блока: «Смены по режимам», «Принято и отклонено», «Ошибки и исключения») — SVG на токенах (`fill: var(--accent)`/`var(--fg-3)`, штрих `var(--line-strong)`), `role="img"` с `aria-label`, пропущенный месяц — пустое место без столбца; те же данные всегда доступны таблицей. Компонентов диаграмм в `@markiro/ui` нет (проверено: `packages/ui/src/components` содержит `MetricStrip`, но не графики), внешних библиотек не добавляем.

`DiagnosticsHistory.tsx`: таблица «Получено / Сформировано / Хост (8 знаков) / Роль / Версия приложения / Версия хоста / Состояние лицензии», кнопка «Открыть отчёт» (`aria-label` с датой) → `Drawer`/раскрывающийся блок с `getDiagnostic` (устройства, лицензия, месяцы), «Показать ещё» по `nextCursor` (накапливает страницы в состоянии).

В `global.css` добавить блок `.tenant-diagnostics` (сетка с `gap: 16px`, как `.tenant-equipment-workspace`; `.diagnostics-bars` с `overflow-x: auto`; цвета только токенами).

В `TenantPage.tsx`: расширить `activeTab` (`requestedTab === "diagnostics" ? "diagnostics"`), добавить в `DataTabs` элемент `{ id: "diagnostics", label: t("tenants.detail.tabs.diagnostics"), count: financialVisible ? "04" : "03", panelId: "tenant-diagnostics-panel" }` (виден всем с `tenants.read`, т. е. всегда) и ветку панели:

```tsx
) : activeTab === "diagnostics" ? (
  <div id="tenant-diagnostics-panel" role="tabpanel" className="tenant-tab-panel">
    <TenantDiagnosticsPanel
      tenantId={detail.tenant.id}
      canWrite={principal.capabilities.includes("standaloneLicenses.manage")}
    />
  </div>
) : (
```

(вставить перед веткой `legal`, сохранив порядок существующих условий).

- [ ] **Step 4: i18n RU/EN**

Добавить в оба файла: `tenants.detail.tabs.diagnostics` («Диагностика»/«Diagnostics») и узел `tenants.detail.diagnostics` с ключами: `title`, `description`, `empty`, `loading`, `loadError`, `retry`, `overview.{role,appVersion,hostVersion,received,receivedAgo,stale,system,license,state,plan,validUntil,daysLeft,quotas,devices,features,on,off,over,quotaOf,quotaOver,unlimited,pcFile,cloudFile,fileCurrent,fileStale,outdated,noData}`, `role.{host,station,office,development}`, `ingest.{title,label,counter,submit,saved,duplicate,savedDetail,confirmUnbound,confirmUnboundAction}`, `statistics.{title,tableLabel,allHosts,hostLabel,severalHosts,noData,chartsTitle,chartShifts,chartScans,chartErrors}` и колонки, `history.{title,received,generated,host,role,appVersion,hostVersion,license,open,openLabel,more}`, `errors.{generic, <все 13 кодов К1>, standalone_diagnostics_cursor_invalid}`. Тексты ошибок: `unknown_key` — «Токен зашифрован ключом, которого у API нет. Нужна свежая сборка клиента или ключ в настройках API»; `undecryptable` — «Не удалось расшифровать токен: текст изменён или повреждён»; `host_other_tenant` — «Этот хост принадлежит другому клиенту. Проверьте, что текст вставлен в нужную карточку»; `not_configured` — «Приём не настроен: на сервере нет ключа поддержки»; `text_too_large` — «Текст слишком большой для сведений для поддержки»; остальные — по смыслу (русский и английский, без вставки введённого текста). Проверить, что наборы ключей `ru.json` и `en.json` совпадают (в проекте это проверяет i18n-тест; запустить `pnpm … test`).

- [ ] **Step 5: Тест вкладки в карточке тенанта**

В `apps/saas-admin/test/tenant-detail.test.tsx` по образцу теста equipment добавить: вкладка «Диагностика» видна роли `support` (только `tenants.read`), открывается по `?tab=diagnostics`, блок вставки у `support` отсутствует, у `platform_admin` есть.

Проверка контракта production-browser:

```bash
grep -rn "tenant-detail-tabs\|tabs.label\|role=\"tab\"\|getByRole(\"tab\"" tools/production-browser --include="*.ts"
```

Если ни одна спецификация не перечисляет вкладки тенанта (вероятно: сценарии открывают `?tab=equipment` по URL), правок в `tools/production-browser` не нужно — записать это в отчёт; если перечисляет — поправить ожидаемое число/список и перепрогнать затронутый сценарий (`pnpm … --filter @markiro/saas-admin build` и затем сценарий без песочницы, по инструкции пакета).

- [ ] **Step 6: Зелёное, коммит**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/ui build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin exec vitest run test/diagnostics-panel.test.tsx test/tenant-detail.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin build
```

Ожидается: всё зелёное. Автотесты DOM — не визуальная проверка в браузере (отдельный ручной обход: вкладка при 1440 и 390 px, RU и EN, клавиатура, фокус, контраст бейджей; в отчёте — «не выполнялся»).

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/saas-admin/src/pages/tenants/diagnostics-api.ts apps/saas-admin/src/pages/tenants/diagnostics-format.ts apps/saas-admin/src/pages/tenants/TenantDiagnosticsPanel.tsx apps/saas-admin/src/pages/tenants/DiagnosticsOverview.tsx apps/saas-admin/src/pages/tenants/DiagnosticsIngestForm.tsx apps/saas-admin/src/pages/tenants/DiagnosticsStatistics.tsx apps/saas-admin/src/pages/tenants/DiagnosticsHistory.tsx apps/saas-admin/src/pages/tenants/TenantPage.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/src/global.css apps/saas-admin/test/diagnostics-fixtures.ts apps/saas-admin/test/diagnostics-panel.test.tsx apps/saas-admin/test/tenant-detail.test.tsx
git diff --check
git add apps/saas-admin/src/pages/tenants apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/src/global.css apps/saas-admin/test/diagnostics-fixtures.ts apps/saas-admin/test/diagnostics-panel.test.tsx apps/saas-admin/test/tenant-detail.test.tsx
git commit -m "feat(saas-admin): U1 — tenant «Диагностика» tab: overview, paste, monthly statistics with charts, history"
```

---

### Task 9 (Д2): Документы и итоговые гейты

**Files:**

- Create: `docs/operations/standalone-diagnostics.md`
- Modify: `docs/standalone/ROADMAP.md`

**Interfaces:**

- Consumes: всё выше.
- Produces: инструкция оператору; обновлённый ROADMAP; шаги владельца.

- [ ] **Step 1: Инструкция оператору**

Создать `docs/operations/standalone-diagnostics.md`:

```md
# Диагностика «Markiro Автоном» в SaaS-админке

Клиент нажимает на странице «О программе» кнопку «Сведения для поддержки» и присылает текст целиком (письмом, мессенджером, как удобно). В тексте есть блок «Данные для анализа» с токеном `MKS1.…`: в нём счётчики по месяцам, идентификатор хоста, роль ПК, система и сводка лицензии. Никаких кодов маркировки, SSCC, имён, ПИН и бейджей в нём нет.

## Как загрузить

1. SaaS-админка → «Клиенты» → карточка клиента → вкладка «Диагностика». Загружать может оператор с правом выпуска лицензий; остальные операторы платформы видят данные и не видят поле вставки.
2. Вставьте весь присланный текст в поле и нажмите «Разобрать и сохранить». Токен искать не нужно.
3. «Площадка не найдена среди площадок клиента»: хоста нет среди зарегистрированных площадок этого клиента (пробный период, установка не из лицензии, текст старой беты без идентификатора хоста). Проверьте, что вставили в нужную карточку, и подтвердите «Сохранить без привязки».
4. «Этот хост принадлежит другому клиенту»: текст вставлен не в ту карточку. Ничего не сохранено.
5. «Уже загружено»: этот токен или отчёт с тем же временем формирования уже есть. Повтор безопасен.

## Что показано

- Сводка по хостам: версии приложения и хоста по последнему отчёту, давность отчёта (после 45 дней — отметка), лицензия (состояние, тариф, срок, места «занято из доступного», возможности) и сравнение с файлом, выпущенным в облаке. Расхождение номеров — это «файл на площадке устарел», а не нарушение.
- Статистика по месяцам: таблица и диаграммы; месяц, которого нет в отчётах, показан как «нет данных», а не нулём. При нескольких хостах значения суммируются; на перепривязанной площадке старый и новый хост считаются разными, поэтому месяц, присланный обоими, считается дважды — выберите хост в переключателе.
- История отчётов: кто и когда прислал, версии, состояние лицензии.

Данные клиента не подписаны: любой, кто знает открытый ключ, может собрать токен. Диагностика не используется для лицензионных решений — лицензию проверяет хост по подписи облака.

## Хранение и аудит

Отчёты хранятся 24 месяца, затем удаляются вместе с месячной статистикой; при удалении клиента удаляются сразу. Токен и вставленный текст не сохраняются, только проверенное содержимое. Каждая загрузка и каждый отказ записываются в платформенный аудит (`standalone.diagnostics.ingest`); просмотр данных не аудируется.

## Для владельца: ключ

Закрытый ключ поддержки хранится только в Lockbox `markiro-production-runtime` под именем `STANDALONE_SUPPORT_KEYS_JSON` (формат и ротация — `docs/runbooks/yandex-secrets.md`, раздел «Диагностика автонома»). Пока записи нет, вкладка работает на чтение, а вставка отвечает «приём не настроен».
```

- [ ] **Step 2: ROADMAP**

В `docs/standalone/ROADMAP.md`:

1. Заголовок раздела 5 `## 5. SaaS: диагностика по тенанту (новая доработка, спецификации ещё нет)` заменить на `## 5. SaaS: диагностика по тенанту (спека и план готовы 2026-10-15, реализация — по плану)`; сразу под заголовком вставить абзац:

```md
Спека: `docs/superpowers/specs/2026-10-15-standalone-support-diagnostics-ingestion-design.md`; план: `docs/superpowers/plans/2026-10-15-standalone-support-diagnostics-ingestion.md` (9 задач). Решения владельца приняты (В1–В10). Открытое: источника «последней опубликованной сборки автонома» в облаке нет (владелец подписывает пакеты обновления вручную, см. спеку лицензий §10.3), поэтому сравнение «версия устарела» реализовано как выключенная точка расширения (`StandaloneLatestBuildSource`); вопрос владельцу — публиковать ли `latest.json` автонома (например, в объектное хранилище) для этого сравнения.
```

2. В разделе 6 строку про облако сделать точной: `Облако (Drizzle): 0192 лицензии, 0193 customLogo, 0194 диагностика — **перенумеровать перед любым PR в main** (номер, запись `meta/_journal.json`и снимок берутся заново от тогдашнего`origin/main`; перепрогнать тесты порядка миграций); сверить с main перед PR.`

3. В разделе 4 («Шаги ТОЛЬКО владельца») добавить пункт: положить закрытый ключ поддержки (парный открытому `sup-d11c3182` из `proto/fixtures/support-keys.json`; формат SEC1 `BEGIN EC PRIVATE KEY` принимается) в Lockbox `markiro-production-runtime` как `STANDALONE_SUPPORT_KEYS_JSON` одной строкой JSON `[{"kid":"sup-d11c3182","pem":"…\n…"}]`, опубликовать версию секрета и повторить остановленный на `runtime-inventory` deployment для того же release SHA; если закрытого ключа этой пары нет — создать новую пару (`decrypt.mjs --public-jwk`), положить публичную половину в `support-keys.json`, выпустить сборку (до неё приём работает только для старых текстов).

- [ ] **Step 3: Итоговые гейты**

```bash
set -a; source .env; set +a
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/saas-admin test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
node --test deploy/yandex/test/*.test.mjs
pnpm test:standalone-support:contract
pnpm test:production-bundle:contract
pnpm format:check
git diff --check
graphify update .
```

Ожидается: всё зелёное. Явно перечислить в отчёте **не** выполненное: реальный ключ поддержки в окружении API и расшифровка реального текста с Windows; HTTP-слой с guard (если нет харнесса); браузерный обход вкладки; `tools/production-browser` (если вкладка не попала в контракт); Windows-проверки автонома (в этой работе их нет); e2e/БД-тесты, пропущенные без `DATABASE_URL`.

- [ ] **Step 4: Коммит документов**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write docs/operations/standalone-diagnostics.md docs/standalone/ROADMAP.md docs/runbooks/yandex-secrets.md
git diff --check
git add docs/operations/standalone-diagnostics.md docs/standalone/ROADMAP.md docs/runbooks/yandex-secrets.md
git commit -m "docs(diagnostics): D2 — operator guide, ROADMAP status and owner steps for the support key"
```

---

## Самопроверка плана

- **Покрытие спеки:** разд. 3.1 → Т1; 3.2 → А1 + К1 (Lockbox) ; 3.3 → А1/К1 (схема) / А2 (`parseSupportPayload`); 3.4 → Д1 (+ чистка Р6); 3.5 → А2/А3; 3.6 → А2 (аудит, точные поля, отказы отдельной транзакцией); 3.7 → У1; разд. 4 порядок выпуска — Д2 (инструкция/ROADMAP); разд. 5 безопасность — А1/А2 (лимиты, утечки); разд. 6 тесты — распределены по задачам (чётность — Ч1, подмена/бомба/ключи — А1, идемпотентность/порядок/чужой тенант/привязка/доступ/утечки — А2, политики — А3, DOM — У1, белый список клиента — Т1); разд. 7 задачи К1, Д1, А1–А3, Т1, У1, Ч1, Д2 — все девять; разд. 8 шаги владельца — Д2 (ROADMAP) и runbook; решения владельца В1–В10 — реализованы или помечены (В5 — Р7).
- **Порядок исполнения:** К1 ∥ Д1 → А1 → А2 → А3 → У1; Т1 после К1; Ч1 после А1 и Т1; Д2 последней. Тесты Т1 и Ч1 читают схему К1 и `support-blob.ts` А1 относительными путями — собирать `platform-contracts` не требуется, но А1 должен быть в ветке.
- **Согласованность имён:** `STANDALONE_SUPPORT_KEYS_JSON` (окружение, runtime-env, .env*, runbook), `STANDALONE_SUPPORT_KEYS` (DI-токен), ограничения Д1 в `RETRYABLE_CONSTRAINTS` (А2), коды ошибок К1 = коды сервиса А2 = ключи i18n У1 (включая `cursor_invalid`).
