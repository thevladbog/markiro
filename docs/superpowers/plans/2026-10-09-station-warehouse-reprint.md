# Station Warehouse Label Reprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the execution method chosen by the user; this document does not authorize delegation, commits, push or release.

**Goal:** Реализовать в складских операциях станции автоматическую перепечатку существующего Data Matrix или SSCC после сканирования, с отдельным выбором двух шаблонов и исправлением старых этикеток короба с `!1`.

**Architecture:** Самостоятельный складской сеанс, tenant-scoped поиск и локальный журнал печати без создания производственного факта. Новый запрос замораживает выбранный шаблон, исходные сведения, язык/DPI и байты; повторная попытка воспроизводит этот снимок. Сеть нужна только для отсутствующих локально источников; транспортная неопределённость восстанавливается явно.

**Tech Stack:** Node 24+, Corepack/pnpm, TypeScript/Zod/Vitest, NestJS/Drizzle/Postgres, React/i18next/@markiro/ui, SQLite и существующий Tauri print transport, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-station-warehouse-reprint-design.md` — одобрена для планирования, дополнена пользователем поддержкой `!1` и названием языка `TSPL`. Макеты в открытом `docs/design-briefs/check_with_reprint.pen`, фреймы «Склад / 00–17». Реализация ожидает обзора этого плана.

## Global Constraints

- Поиск включает другие станции и закрытые смены своей организации; открытая смена не требуется.
- Один скан создаёт одно задание; повтор в незавершённом сеансе требует явного действия.
- Перепечатка не создаёт единицу/короб, не меняет состав и не расходует SSCC; паллеты не поддерживаются.
- Полный KM сохраняет GS и криптохвост. Нет восстановления по GTIN+serial или пересчёта исторических дат по текущему каталогу/часам.
- Отдельные шаблоны `product_duplicate` и `box`; «Применить» доступно только при двух допустимых назначениях. Отмена сохраняет предыдущую пару.
- Каждое новое складское задание использует выбранный шаблон; существующие производственные задания и их байты неизменны.
- `sending` сохраняется до транспорта; рестарт/исключение после начала передачи означает `delivery_unknown`, без автоматического replay.
- Кнопки ≥64 px, IBM Plex Sans/Mono, токены `@markiro/ui`, RU/EN; 1280×800 и 1024×768; нет CDN.
- Нормализация `!1` разрешена только при входе в складскую перепечатку. Проверка новой этикетки остаётся строгой.
- TSPL для SSCC: `EAN128`, `00` + 18 цифр, без буквального `!1`; internal setting остаётся `tspl`. Модель `TSC 210` сохраняет название.
- Не менять `.env`, общую БД, чужой dirty checkout, производственные очереди и старые миграции. Новые таблицы/DDL имеют добавочные миграции.
- Только Pencil MCP для `.pen`; не читать/редактировать файл из shell, не открывать в панели Codex.

## Review Focus

1. Одна коробная этикетка приходит как `!100…`, `]C0!100…`, затем как исправная `00…`: ищется одна запись, лишней автоматической печати нет — задачи 1, 7, 8.
2. SSCC начинается с `00`, а повреждённый KM содержит `!1`: не терять цифры SSCC и не изменять KM — задача 1.
3. Шаблон/принтер или credentials изменяются, пока сервер отвечает либо рендерер работает: поздний результат не коммитится и не печатается — задачи 6–8.
4. Принтер мог получить байты, но подтверждение и sync потерялись: рестарт сохраняет неизвестный результат, повтор использует прежние байты — задачи 3, 5, 7.
5. Локальные исходные поля, template cache или квитанция устарели/повреждены: нет ложного «не найден» и незаметной замены дат/шаблона, несинхронизированные факты сохраняются — задачи 4–6.

## Исходная база и структура

Рабочая ветка: `codex/warehouse-label-reprint`, checkout `.worktrees/warehouse-label-reprint`, исходный `origin/main` — `3c2ee7a6f`. В нём TSPL ещё содержит ошибочную команду `128`/`!100`; исправление вынесено в PR #692 (`75b0f410a77c523766543b1033ff491c211b5dc1`). Перед реализацией проверить актуальную базу и присутствие исправленного рендерера. Не сливать старую ветку целиком и не дублировать уже включённую правку.

Проверенные точки расширения:

| Путь                                                                                 | Ответственность                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/domain/src/scan/classify.ts`, `gs1/sscc.ts`, `product-labels/km.ts`        | Строгая классификация, контрольная цифра и точный полный KM; не расширять общий parser ради `!1` |
| `packages/domain/src/labels/model.ts`, `eligibility.ts`, `duplicate.ts`, `tspl.ts`   | Модель/назначения шаблонов, проверка Data Matrix и исправленный TSPL                             |
| Новый `packages/domain/src/warehouse-reprint/`                                       | scan adapter, контракты и детерминированные переходы складской перепечатки                       |
| `packages/db/src/schema.ts`, `schema/`, `sqlite/schema.ts`, `sqlite/migrations.ts`   | Экспорт новой истории, authoritative runtime DDL и атомарные команды                             |
| Новый `apps/api/src/modules/station-warehouse-reprint/`                              | Поиск, каталог шаблонов и идемпотентный приём событий через station credentials                  |
| `apps/api/src/modules/code-search/`, `label-templates/`, `station-scans/`            | Источники и аналогичные проверки; не открывать cabinet endpoints устройству                      |
| Новый `apps/station/src/lib/warehouse-reprint/`                                      | Локальные источники, session/store, подготовка, отправка, recovery и sync                        |
| `apps/station/src/lib/printer-routing.ts`, `print-label.ts`, `print-destinations.ts` | Назначения `duplicate`/`box`, общий renderer, сохранённый endpoint и serialisation               |
| `apps/station/src/lib/credential-recovery.ts`, `device-recovery.ts`                  | Владение credentials, commit leases, барьеры выхода и retention                                  |
| `apps/station/src/pages/TaskSelection.tsx`, `App.tsx`, новый `WarehouseReprint.tsx`  | Независимый вход из склада и жизненный цикл экрана                                               |
| Новый `apps/station/src/ui/warehouse-reprint/`                                       | Два назначения шаблонов, preview и состояния сканирования/recovery                               |

Предлагаемые новые имена ниже являются контрактом задач, а не утверждением, что такие функции уже есть. Не расширять `ActiveFloorTask` фиктивным inventory ID или shift ID: складской сеанс имеет отдельный persisted pointer и использует общий floor-work registry.

### Task 1: Узкое разрешение сканов старых коробных этикеток

**Files:** Create `packages/domain/src/warehouse-reprint/scan.ts`; modify `packages/domain/src/index.ts`; create `packages/domain/test/warehouse-reprint-scan.test.ts`. Read `packages/domain/test/sscc.test.ts`, `classify.test.ts`, `product-labels/km.ts`.

**Interfaces:** `resolveWarehouseReprintScan(raw: string): WarehouseReprintScan` возвращает `{kind:'box', sscc, repair:'legacy_tspl_fnc1_literal'|null}` либо `{kind:'unit', codeHash}` либо `{kind:'invalid'}`. Полный payload не попадает в display DTO. `compareWarehouseReprintLabel(expected: {kind:'box',sscc:string}|{kind:'unit',canonicalRaw:string}, raw:string): 'match'|'mismatch'|'invalid'` используется исключительно в recovery.

- [ ] Перед тестовым циклом проверить task checkout/base, Node ≥24, `corepack pnpm --version` и packageManager репозитория. В изолированном checkout установить `corepack pnpm install --frozen-lockfile`, собрать domain/DB/UI по dependency graph и выполнить существующие scan suites как baseline. Не подменять installation чужим node_modules и не считать missing dependency доказательством failing behavioral test.
- [ ] Написать failing tests с реальной формой старого producer:

```ts
const sscc = "346006820000000014";
it.each([`!100${sscc}`, `]C0!100${sscc}`, `]C1!100${sscc}`, `  !100${sscc}  `])(
  "repairs %s",
  (raw) => {
    expect(resolveWarehouseReprintScan(raw)).toEqual({
      kind: "box",
      sscc,
      repair: "legacy_tspl_fnc1_literal",
    });
  },
);
it.each([
  `!1!100${sscc}`,
  `!101${sscc}`,
  `!100${sscc}0`,
  "!100346006820000000015",
  "!1010460068200001321abc",
])("rejects %s", (raw) => {
  expect(resolveWarehouseReprintScan(raw)).toEqual({ kind: "invalid" });
});
it("rejects an old label as proof of a corrected print", () => {
  expect(compareWarehouseReprintLabel({ kind: "box", sscc }, `!100${sscc}`)).toBe("invalid");
  expect(compareWarehouseReprintLabel({ kind: "box", sscc }, `]C100${sscc}`)).toBe("match");
});
```

- [ ] Запустить `corepack pnpm --filter @markiro/domain exec vitest run test/warehouse-reprint-scan.test.ts`; ожидать FAIL из-за отсутствующего adapter.
- [ ] Реализовать точную форму `^(?:\]C[01])?!100(\d{18})$` после внешнего trim; проверить `isValidSscc`. Если строка начинается с `!1`/AIM+`!1`, но не соответствует форме, вернуть invalid, не пробовать её как KM. Остальные сканы пропустить через существующий classifier; принимать только sscc/km. Для unit lookup нужен `kmHash`, полный KM берётся из источника позднее. Проверка recovery использует строгий `parseScannedSscc`/`compareDuplicateKm`, никогда repair adapter.
- [ ] Добавить cases: валидный SSCC, начинающийся с `00`; внутренний `!1` в валидном serial/crypto сохраняется; одинаковый lookup key legacy/normal; обычный GTIN не подходит. Общий `classifyScan('!100…')` по-прежнему не классифицирует sscc.
- [ ] Повторить новую suite и существующие `test/sscc.test.ts test/classify.test.ts`; ожидать PASS. Это новый adapter только для Station/API, Kotlin classifier не изменяется.

### Task 2: Контракты источников, каталога, заданий и событий

**Files:** Create `packages/domain/src/warehouse-reprint/contracts.ts`, `state.ts`, `fixtures.ts`; export through `src/index.ts`; create `packages/domain/test/warehouse-reprint-contracts.test.ts`, `warehouse-reprint-state.test.ts`.

**Interfaces:** Определить/export Zod strict schemas и типы `WarehouseReprintSource`, `WarehouseTemplate`, `WarehouseLookupResult`, `WarehouseReprintEvent`, `WarehouseReprintReceipt`, `WarehouseReprintProjection`; reducer `applyWarehouseReprintEvent(current,event)`. Общий protocol `warehouse-label-reprint-v1`, event batch максимум 100; hashes — 64 lowercase hex. Базовые DTO:

```ts
type WarehouseTemplate = {
  id: string;
  revision: string;
  digest: string;
  name: string;
  purpose: "product_duplicate" | "box";
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  spec: LabelTemplateSpec;
};
type WarehouseReprintSource = {
  kind: "unit" | "box";
  sourceId: string;
  identity: string;
  revision: string;
  productName: string;
  chzProductGroupCode: number | null;
  fields: Record<LabelField, string>;
  unavailableFields: LabelField[];
  payloadDigest: string;
  sourceShiftId: string | null;
};
type WarehouseLookupResult =
  | { status: "found"; source: WarehouseReprintSource; repair: "legacy_tspl_fnc1_literal" | null }
  | { status: "not_found" }
  | {
      status: "unavailable";
      code:
        | "incomplete_km"
        | "source_fields_missing"
        | "source_not_printable"
        | "unsupported_pallet"
        | "ownership_conflict";
    };
```

`identity` unit = codeHash, box = bare SSCC. `fields['km.code']` содержит полный исходный KM только для unit; `fields.sscc` — bare SSCC только для box. `unavailableFields` отличает исторически неизвестное значение от известного пустого поля. Клиент передаёт `{raw,operatorId,protocol}` в POST lookup, без tenantId/deviceId. Каталог GET возвращает `{protocol,revision,templates}`. Event batch POST — `{protocol,events}`.

Событие имеет общий base: UUID `eventId/jobId/sessionId/attemptId/operatorId`, `sequence` ≥1, `occurredAt` ISO instant. `prepared` дополнительно фиксирует source kind/ID/identity/revision, `sourceShiftId`, template ID/revision/digest, payload/bytes digest, language, dpi, reason, repair marker и scan digest; последующие события не несут raw KM/bytes. Варианты: `sending`, `sent`, `delivery_unknown`, `failed_before_send`, `verified`, `reprint_prepared`. Ошибка имеет bounded code, не transport exception string. Projection содержит последний sequence, attempt ID/No, state и digests. Receipt = accepted IDs + quarantined `{eventId,code}`, без удаления нераспознанных событий.

- [ ] В fixtures создать `warehouseBoxSource()` и `warehousePreparedEvent()` с SSCC задачи 1, фиксированными UUID/датами/полными полями. Unit fixture содержит полный GS+AI93 код. Эти builders используются дальше; локальные/API harness добавляют инфраструктуру отдельно.
- [ ] Написать tests:

```ts
it("rejects tenant injection", () => {
  expect(
    warehouseLookupRequestSchema.safeParse({
      raw: "00346006820000000014",
      operatorId: "00000000-0000-4000-8000-000000000001",
      protocol: "warehouse-label-reprint-v1",
      tenantId: "other",
    }).success,
  ).toBe(false);
});
it("requires an unknown result before a recovery attempt", () => {
  const first = warehousePreparedEvent();
  const prepared = applyWarehouseReprintEvent(null, first);
  expect(() =>
    applyWarehouseReprintEvent(prepared, { ...first, kind: "verified", sequence: 2 }),
  ).toThrow();
});
```

- [ ] Запустить обе новые suites; ожидать FAIL. Реализовать strict boundaries и переходы: prepare→sending→sent/unknown; failed-before-send не увеличивает sent counter; unknown→verified или explicit new attempt; sequence gaps, reused attempt IDs, changed digests и verify-before-send запрещены. New attempt наследует frozen job digests, меняет actor/reason/attempt ID.
- [ ] Проверить replay одной последовательности, изменённый duplicate event, отсутствие raw/bytes в event DTO, верхние пределы batch/sequence, `unavailableFields` и purpose mismatch. Запустить suites, package build для потребителей.

### Task 3: Долговечное хранение и атомарные локальные команды

**Files:** Create `packages/db/src/schema/warehouse-reprint.ts`; modify `packages/db/src/schema.ts`, `drizzle.config.ts`, `src/sqlite/schema.ts`, `src/sqlite/migrations.ts`; generate additive Postgres migration/metadata через package command; create `packages/db/test/warehouse-reprint-schema.test.ts`, `warehouse-reprint-sqlite.test.ts`, `warehouse-reprint-migration.test.ts`. Create `apps/station/src/lib/warehouse-reprint/types.ts`, `store.ts`; create `apps/station/test/warehouse-reprint-store.test.ts`, `test/support/warehouse-reprint.ts`.

**Interfaces:** `WarehouseSession` имеет session ID, credential owner, device/operator, reason, два template snapshots, status active/paused, счётчик sent. `WarehouseJob` имеет source snapshot, template snapshot, fields, bytesBase64/digests, bound PrinterProfile, projection. Store: `prepareWarehouseJob(exec,input): Promise<'prepared'|'duplicate'|'busy'>`, `readWarehouseJob(exec,owner,jobId)`, `appendWarehouseEvent(exec,owner,event): Promise<'applied'|'replay'>`, `resumeWarehouseSession(exec,owner)`.

В local types явно определить `WarehousePreparedJobInput`: owner/sessionId/jobId/deviceId/operatorId/reason, `source:WarehouseReprintSource`, `template:WarehouseTemplate`, `printer:PrinterProfile`, `fields:Record<LabelField,string>`, bytesBase64/bytesDigest и `preparedEvent:Extract<WarehouseReprintEvent,{kind:'prepared'}>`. `WarehouseJob` расширяет этот input projection/attempts/updatedAt; `readWarehouseJob` возвращает `Promise<WarehouseJob>` или бросает precise missing/corrupt error. `resumeWarehouseSession` возвращает `Promise<WarehouseSession|null>`. App test builder `warehousePreparedJobInput()` создаётся в support/warehouse-reprint.ts из domain fixtures с frozen printer и bytes, не экспортируется из domain.

- [ ] В on-disk SQLite tests использовать `openFileDatabase`, `makeRotatingExec` из существующего support; написать тест до DDL/store:

```ts
expect(await prepareWarehouseJob(exec, input)).toBe("prepared");
expect(await prepareWarehouseJob(exec, { ...input, jobId: secondId })).toBe("duplicate");
expect(await readWarehouseJob(exec, input.owner, input.jobId)).toMatchObject({
  bytesBase64: input.bytesBase64,
});
```

Здесь `input = warehousePreparedJobInput()` из app support; `secondId` — другой UUID. Нормальный и legacy скан дают тот же session identity key. Второй preparedEvent также получает соответствующий новый job/attempt/event ID: иначе тест проверял бы неконсистентный input вместо защиты по identity.

- [ ] Запустить DB и Station новые suites; ожидать FAIL. Добавить Postgres jobs/events/receipts с composite tenant/device/job keys, tenant operator/source FKs где parent имеет соответствующий уникальный ключ, safe sequences, digest checks и replay receipt. Серверные таблицы не содержат сырые KM/печать.
- [ ] Добавить SQLite sessions/jobs/attempts/events/receipts/cache и single-statement command triggers. Атомарно сохранить job+attempt+prepared event+outbox и duplicate identity pointer; ошибки откатывают всё. Claim `sending` — compare-and-set по owner/job/attempt/state. Не использовать многошаговый BEGIN/COMMIT с pooled executor.
- [ ] Проверить fault внутри trigger, чтение с другой connection, close/reopen, чужой owner, duplicate invocation, сохранность sending/unknown и неподтверждённого outbox. Сбой между hardware send и append sent не теряет sending.
- [ ] Сгенерировать миграцию `corepack pnpm --filter @markiro/db db:generate`, проверить SQL без rewriting existing migrations; собрать DB и повторить новые schema/migration/SQLite suites. Реальную миграцию применить только к отдельной тестовой БД.

### Task 4: Station API — tenant-scoped поиск и каталог шаблонов

**Files:** Create `apps/api/src/modules/station-warehouse-reprint/{station-warehouse-reprint.module,controller,dto,lookup.service,templates.service}.ts`; modify `apps/api/src/app.module.ts`; create `apps/api/test/station-warehouse-reprint-lookup.e2e.test.ts`, `station-warehouse-reprint-openapi.test.ts`; update `test/subscription-route-inventory.test.ts`.

**Interfaces:** `POST /station/warehouse-reprint/lookup` — request/result задачи 2. `GET /station/warehouse-reprint/templates` — каталог задачи 2. Services `lookup(tenantId,deviceId,input): Promise<WarehouseLookupResult>` и `templates(tenantId,deviceId): Promise<WarehouseTemplateCatalog>`, где `WarehouseTemplateCatalog` = `{protocol:'warehouse-label-reprint-v1',revision:string,templates:WarehouseTemplate[]}`. Tenant/device выводятся из authenticated request; service проверяет операторский roster и device kind station.

- [ ] Расширить существующий isolated API auth/DB harness из `station-inventory-access.e2e.test.ts` новым fixture: две организации, две станции, закрытая смена, принятая единица с canonicalRaw, closed box, retired/disassembled box, pallet, enabled/disabled templates обоих purposes. `setupWarehouseApi()` в новом `test/support/warehouse-reprint.ts` возвращает HTTP helpers с device credentials, DB и UUID. Не использовать production DATABASE_URL.
- [ ] Написать failing requests/assertions:

```ts
expect((await stationA.lookup({ raw: `!100${sscc}`, operatorId, protocol })).body).toMatchObject({
  status: "found",
  repair: "legacy_tspl_fnc1_literal",
  source: { kind: "box", identity: sscc },
});
expect(
  (await stationOtherTenant.lookup({ raw: `00${sscc}`, operatorId: otherOperatorId, protocol }))
    .body,
).toEqual({ status: "not_found" });
expect((await cabinet.lookup({ raw: `00${sscc}`, operatorId, protocol })).status).toBe(403);
```

Дополнительно unit другой станции/закрытой смены возвращает полный KM; retired box/pallet не printable; invalid scan не выполняет substring search.

- [ ] Запустить новую suite; ожидать FAIL. Использовать `TenantGuard`, `StationOnlyGuard`, `SubscriptionAccessGuard`, `ApiStationAuth`, `ZodValidationPipe`, явный `AllowSubscriptionRecovery('station')`. Cabinet code-search/controller не менять. Обе операции — чтение/восстановление существующих идентификаторов, не выдача production grant.
- [ ] Разрешать исходную запись через registry+полные codes, сохранённые локальные идентификаторы box только через server UUID mapping. Выбирать source version однозначно; при конфликте вернуть unavailable. Даты/expiry брать из имеющихся source snapshots; неизвестные исторические fields помечать unavailable. Не выводить историческую expiry из текущего shelfLifeDays. Транзакционное чтение связывает source и revision, не два разновременных случайных запроса.
- [ ] Выдавать только enabled same-tenant `product_duplicate`/`box` templates с полным spec/digest/revision. Проверять `assertDuplicateTemplate`, SSCC-bound Code128 для box и product-group eligibility при найденной продукции; picker не может обойти последнюю проверку.
- [ ] Добавить denial чужого operatorId/device-kind, revoked credentials, restricted-subscription recovery, malformed DTO, redacted diagnostics. Проверить OpenAPI/runtime equality и inventory of access policies; повторить suites после domain/DB builds.

### Task 5: Серверный приём истории, идемпотентность и аудит

**Files:** Create `apps/api/src/modules/station-warehouse-reprint/events.service.ts`; extend controller/dto; create `apps/api/test/station-warehouse-reprint-events.e2e.test.ts`. Read `modules/station-scans/product-label-events.ts` без расширения production event protocol.

**Interfaces:** `POST /station/warehouse-reprint/event-batches` с `{protocol,events}` → `WarehouseReprintReceipt`; `receive(tenantId,deviceId,events)` транзакционно проверяет source/operator/device и reducer задачи 2.

- [ ] До service написать test: два identical batches дают одинаковые accepted IDs, один job и одну последовательность audit events; изменённый payload с тем же eventId получает conflict, gap получает quarantine. После print failure/restart sending→unknown принимается в той же истории.

```ts
const first = await stationA.sendEvents([prepared, sending, sent]);
expect(await stationA.sendEvents([prepared, sending, sent])).toEqual(first);
expect(await readAuditForJob(jobId)).toMatchObject([
  {
    tenantId,
    deviceId,
    operatorId,
    action: "warehouse_label.prepared",
    targetId: jobId,
    result: "accepted",
  },
  {
    tenantId,
    deviceId,
    operatorId,
    action: "warehouse_label.sending",
    targetId: jobId,
    result: "accepted",
  },
  {
    tenantId,
    deviceId,
    operatorId,
    action: "warehouse_label.sent",
    targetId: jobId,
    result: "accepted",
  },
]);
```

Определить `readAuditForJob` в harness задачи 4 через реальное audit storage, с stable sort по sequence; assertions дополнительно проверяют source, reason, template digest, repair, attempt и scan digest, а не только count.

- [ ] Запустить suite, ожидать FAIL; реализовать sorted job locks, receipt-before-repeat validation, сохранённый event digest и reducer. Проверять tenant/source identity, исходный payload и историческую принадлежность actor/template, не требовать текущего eligibility или ownership production code у текущей станции. Все запросы приёма выполнять на одном tx executor. Для accepted parent сохранить source proof; последующие recovery events не отвергать из-за изменения текущего catalog template или закрытой смены.
- [ ] Зафиксировать quarantine/rejection (source not eligible, foreign actor, wrong transition, sequence gap) отдельно от transient DB exception; infrastructure error пробрасывается для retry. Не записывать raw KM/bytes в audit или exceptions. Не менять counts/codeRegistry/boxes/SSCC cursor/shift status.
- [ ] Повторить tests cross-tenant/source spoofing, replay after server restart, same-event-different-body, exact audit и untouched business rows. Receipt сохраняется даже при rejected claimed parent; ошибки инфраструктуры не выдаются за permanent rejection.

### Task 6: Локальный каталог, поиск и подготовка новых байтов

**Files:** Create `apps/station/src/lib/warehouse-reprint/{sources,templates,prepare}.ts`; extend `apps/station/src/lib/api-client.ts`; create `apps/station/test/warehouse-reprint-sources.test.ts`, `warehouse-reprint-prepare.test.ts`. Read `product-labels/fields.ts`, `box-label.ts`, `inventory-box-label.ts`, `print-label.ts`.

**Interfaces:** `findWarehouseSource(exec,owner,scan): Promise<WarehouseReprintSource|null>`; `resolveWarehouseSource(client,exec,owner,raw,operatorId): Promise<WarehouseLookupResult|{status:'network_required'}>`; `loadWarehouseTemplates(client,exec,owner): Promise<WarehouseTemplateCatalog>`; `renderWarehouseLabel(source,template,printer,rasterizeText): Promise<{fields:Record<LabelField,string>;bytesBase64:string;bytesDigest:string}>`. Caller проверяет lease перед любым cache/store write. `PrinterProfile` существующий; `RasterizeTextFn` из domain.

- [ ] Написать tests на local found без network call при известном отсутствии сети, refresh локального источника при доступной сети, network-required без локальной записи, отрицательный server lookup, повреждённый local snapshot (явная corruption error), legacy raw/canonical resolution, tenant/owner separation. Локальные источники: сохранённые product-label jobs с исходным raw/fields, закрытые local boxes с frozen context и валидный lookup cache. Полнота определяется selected template; источники без исторического поля не получают default из текущих часов.

```ts
const old = warehouseBoxSource();
const rendered = await renderWarehouseLabel(old, boxTemplate, tspl203, rasterizeText);
expect(atob(rendered.bytesBase64)).toContain('"EAN128"');
expect(atob(rendered.bytesBase64)).toContain(`"00${old.identity}"`);
expect(atob(rendered.bytesBase64)).not.toContain("!100");
expect(rendered.fields.date).toBe(old.fields.date);
expect(rendered.fields.expiry).toBe(old.fields.expiry);
```

`boxTemplate`, `tspl203`, `rasterizeText` добавляются в app support/warehouse-reprint.ts: box template строится штатной моделью, profile указывает language tspl/DPI203 и fake TCP endpoint, rasterizer возвращает детерминированный bitmap. Source — task 2 builder. `date`/`expiry` уже имеют печатный формат `дд.мм.гггг` из LABEL_FIELDS; test сравнивает сохранённые строки точно.

- [ ] Запустить новые suites, ожидать FAIL; реализовать строгий parse server DTO, source cache и immutable template cache по owner+ID+revision. Catalog refresh не перезаписывает prepared jobs. Templates двух назначений хранятся раздельно, cancellation не пишет selection.
- [ ] Для source/selected template проверить purpose, product group, required barcode binding, unavailable fields, language/DPI; использовать `createLabelRenderPlan` и `emitLabelRenderPlan` с тем же rasterizer/DPI, что preview. Для KM использовать полный server/local raw с `parseDuplicateKm`, не serial из скана. Legacy flags не изменяют raw unit fields.
- [ ] До rendering проверить effective source dates, после rendering заморозить exact fields/bytes. Existing saved production bytes не копируются в новый складской job. Рендерер не подставляет sample data; только preview использует clearly marked sample.
- [ ] Проверить ZPL/TSPL × 203/300, GS/crypto preservation, template switch only future jobs, missing facts rejection, stale response after owner replacement. Сборка domain/DB прежде Station suite.

### Task 7: Отправка, restart recovery, sync и retention

**Files:** Create `apps/station/src/lib/warehouse-reprint/{printing,recovery,sync,retention}.ts`; integrate `apps/station/src/lib/device-recovery.ts`, `credential-recovery.ts` и существующую sync orchestration; create `apps/station/test/warehouse-reprint-printing.test.ts`, `warehouse-reprint-recovery.test.ts`, `warehouse-reprint-sync.test.ts`.

**Interfaces:** `sendWarehouseJob(deps,jobId): Promise<WarehouseJobView>`; `recoverWarehouseJobs(exec,owner): Promise<WarehouseJobView[]>`; `verifyWarehouseJob(deps,jobId,raw)`; `prepareWarehouseReprintAttempt(deps,jobId,reason)`; `syncWarehouseEvents(client,exec,owner): Promise<WarehouseReprintReceipt>`; `WarehouseJobView` = job/attempt IDs, kind/display suffix, state, reason, selected template/printer names, repair marker — без raw/bytes. `deps` = exec, owner, actor `{operatorId,now,newId}`, PrinterProfile, print transport и current generation/commit lease.

- [ ] Написать failing test до транспорта:

```ts
const observedStates: string[] = [];
const print = vi.fn(async () => {
  const persisted = await readWarehouseJob(exec, owner, jobId);
  observedStates.push(persisted.projection.state);
  throw new Error("connection lost");
});
await sendWarehouseJob({ ...deps, print }, jobId);
expect(observedStates).toEqual(["sending"]);
expect((await readWarehouseJob(exec, owner, jobId)).projection.state).toBe("delivery_unknown");
await recoverWarehouseJobs(exec, owner);
expect(print).toHaveBeenCalledTimes(1);
```

- [ ] Запустить suite, ожидать FAIL. Сохранить endpoint/язык/DPI до sending claim, использовать `serializePrinterOutput` и сохранённые bytes. Один физический endpoint имеет общую очередь для box/duplicate/warehouse. Повтор concurrent click получает ту же операцию, а competing job блокируется persisted claim. Не держать SQLite connection transaction во время hardware send.
- [ ] Recovery переводит durable sending в unknown после restart, никогда не посылает сам. Явная новая attempt требует reason и compatible printer, повторяет frozen bytes. Verification uses strict task 1 comparison; legacy scan не подтверждает исправленный barcode. Если profile изменил language/DPI, требовать compatible endpoint, не перерендерить прошлый job.
- [ ] Sync идемпотентно читает immutable batch, подтверждает только accepted IDs matching batch digest; сохраняет rejected/quarantined facts и видимую причину. Новый event, созданный пока batch отправляется, не стирается. Network retry не вызывает hardware replay.
- [ ] Device sealing/credential reset учитывают unresolved jobs, unsynced events/cache ownership. Потерявший lease worker не пишет under new owner и не печатает. Recovery существующих print facts не выдаёт новую production grant и не увеличивает production/offline event budgets; denied/revoked device не открывает новый сеанс. Проверить read/recovery gates по текущему device recovery state.
- [ ] Retention сохраняет unknown/prepared/sending, неacknowledged channel и quarantine; освобождает только completed+acknowledged records по существующему горизонту retention. Тесты: shutdown between claim/transport/result, sync restart, receipt mismatch, credential switch, exact frozen bytes after template/catalog change.

### Task 8: UI, два шаблона, сканирование и label language

**Files:** Create `apps/station/src/pages/WarehouseReprint.tsx`, `apps/station/src/ui/warehouse-reprint/{TemplatePicker,ReprintStatus}.tsx`, `apps/station/src/lib/use-warehouse-reprint.ts`; modify `pages/TaskSelection.tsx`, `App.tsx`, RU/EN i18n, существующие floor styles; tests `warehouse-reprint-screen.test.tsx`, `warehouse-reprint-templates.test.tsx`, `App.test.tsx`, `inventory-task-selection.test.tsx`, `workstation-setup.test.tsx`.

**Interfaces:** `WarehouseReprint` получает exec/client/source/operator/credential generation/hardware config/print/onExit/onSetup/onFloorWorkRegister. Hook предоставляет `status`, `view`, `templates`, `selectedPair`, `reason`, `scan(raw)`, `changeTemplates(pair)`, `pause()`, `resume()`, `reprint(reason)`, `verify(raw)`; `TemplatePicker` получает `catalog`, `selectedPair`, `onApply(pair)`, `onCancel`. Pair имеет `unitTemplateId` и `boxTemplateId` с revision обоих snapshots.

- [ ] Написать failing tests:

```tsx
await user.click(screen.getByRole("button", { name: "Выбрать шаблоны" }));
await user.click(screen.getByRole("button", { name: "Коды единиц · Data Matrix" }));
await user.click(screen.getByRole("radio", { name: /Код \+ название/ }));
await user.click(screen.getByRole("button", { name: "Короба · SSCC" }));
await user.click(screen.getByRole("radio", { name: /Короб 58/ }));
await user.click(screen.getByRole("button", { name: "Применить шаблоны" }));
expect(screen.getByText("Коды: Код + название")).toBeVisible();
expect(screen.getByText("Короба: Короб 58 × 40")).toBeVisible();
```

Render helper `renderWarehouseScreen` в новой screen suite создаёт реальный store/fixtures задач 2–3 и fake ScanSource/transport по support/product-label-work.ts; user events используют существующий test setup. Убедиться, что второе назначение не обнуляет первое, cancel сохраняет прежнее, оба valid required.

- [ ] Запустить новые suites, ожидать FAIL; добавить независимую кнопку из категории «Складские операции», которая доступна без inventory assignment и production shift. Persist/resume отдельного session pointer. Зарегистрировать hook в floor barrier и operator idle lock; выход закрывает intake и ждёт work retirement.
- [ ] Реализовать фреймы 01–17: причина/setup, picker с локальным preview, ready/search/sending/sent, not found, network required, incomplete KM, missing printer, duplicate confirmation, unknown recovery, legacy repair notice. Scanner intake сериализован; scan during busy/recovery не создаёт новый job. UI не обещает «напечатано» после transport success.
- [ ] На позднем lookup/render перед prepare проверять token, credential generation, operator, session status и commit lease; changing reason/templates only when idle. Pause/exit сохраняют duplicate set и pending job. При resume unresolved job показывается первым; новая login не получает доступ к фактам чужого owner.
- [ ] Добавить tests ordinary+legacy scans одного SSCC => one automatic transport; not found vs network required; disabled/apply, archive template refresh, purpose/group mismatch, two printer routes, delayed API/render after pause/operator/credentials change и unknown verification rejecting `!1`.
- [ ] Проверить название языка. В исходном коде `setup.languageTspl` уже `TSPL` в RU/EN, `PrinterSetupPanel` использует этот key; не делать бессмысленную замену производителя. Если другой label языка в целевой базе ещё `TSC`, заменить только его. Добавить DOM assertions RU/EN label `TSPL` и загрузку существующего hardware config `printerLanguage:'tspl'` без миграции; fixture model names `TSC 210` сохраняются.

### Task 9: Browser, CI, документация и итоговые gates

**Files:** Extend `apps/station/src/dev/StationScreenGallery.tsx` реальным warehouse component; create `tools/production-browser/station-inventory-tests/warehouse-reprint.spec.ts`; inspect/update `tools/ci/affected.mjs` и `.github/workflows/ci.yml`; update `docs/architecture.md`, create `docs/acceptance/station-warehouse-reprint.md`.

**Interfaces:** Browser fixture предоставляет fake StationClient/ScanSource/PrintTransport через props production components; не создаёт параллельную реализацию интерфейса. Acceptance документ отделяет automated/browser evidence от Windows, физического сканера и TSC 210.

- [ ] Написать browser test до gallery integration:

```ts
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
]) {
  test(`warehouse reprint ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?gallery=1&state=warehouse-reprint-ready&locale=ru");
    await expect(page.getByRole("button", { name: "Шаблоны" })).toBeVisible();
    await page.getByRole("button", { name: "Шаблоны" }).click();
    await expect(page.getByRole("dialog", { name: "Шаблоны этикеток" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Применить шаблоны" })).toBeVisible();
  });
}
```

В gallery добавляется состояние `warehouse-reprint-ready`, использующее существующие `gallery=1&state=…&locale=…`; также состояния lookup/unknown/legacy-sent с production components. Keyboard focus/escape/cancel, 64px targets, no overflow и offline assets проверяются дополнительно. Screenshot comparison — с утверждёнными Pencil states, а не с HTML handoff.

- [ ] Запустить browser suite и убедиться в FAIL до интеграции; добавить реальные states и fake transport counters; после реализации проверить scan legacy→canonical lookup→corrected bytes→one send, picker сохранение и recovery restart. Synthetic DM/SSCC preview отмечен как sample; это не физическая приёмка.
- [ ] Обновить OpenAPI/runtime contracts и documentation нового station protocol. Сверить CI affected ownership: domain/DB/API/Station/UI-consumer/browser jobs не должны silently skip. При изменении общего classifier или Kotlin contract остановиться для выполнения handheld parity gates; предложенный adapter этого не требует.
- [ ] Собрать зависимости и выполнить пропорциональные gates:

```bash
corepack pnpm turbo run build --filter='@markiro/station^...' --filter='@markiro/api^...'
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/station test
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
corepack pnpm format:check
git diff --check
```

API/DB tests получают отдельную test environment с применёнными миграциями; intentional skips отражаются в evidence. Browser: `corepack pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config station-inventory.playwright.config.ts warehouse-reprint.spec.ts`, затем существующий `corepack pnpm test:station-inventory:browser`. Browser workspace имеет собственную frozen installation и Playwright Chromium. Host Cargo tests требуются, если изменяется Rust transport; текущий план не меняет Rust.

- [ ] Физическая приёмка: реальная старая этикетка `!100…` с TSC 210, original/corrected scan values, TSPL и обратный скан без `!1`, та же identity/dates/content; обе выбранные этикетки и текущие DPI/носители; power/network interruption и explicit recovery. Нельзя заменить эти checks mock transport assertions. Выпуск станции выполняется отдельным защищённым release workflow по точному SHA, только в авторизованном scope.
- [ ] Выполнить `graphify update .`, если в реализации есть local graph; просмотреть final diff и полного commit range перед авторизованным PR. Коммиты/пуш не выполнять только на основании этого плана; разрешение на прежний PR #692 не распространяется автоматически на новый режим.

## Обзор плана перед исполнением

Порядок: 1 → 2 → 3 → 4/5 → 6 → 7 → 8 → 9. API lookup и events используют общий source/event contract; локальное UI не готово к физической печати до завершения atomic store и recovery. Подпись TSPL проверяется в task 8 вместе с UI и совместимостью существующего config.

Предлагаемый метод: реализация в текущей сессии через `superpowers:executing-plans`, последовательно с failing tests и итоговым обзором ветки. Для этого потока важнее согласованность interfaces и recovery states между шагами; параллельное редактирование общей SQLite/credential boundary здесь не требуется. Пользователь может выбрать вариант с отдельными implementer/reviewer agents. Нужны обзор плана и выбор метода до изменения product code.

## Дополнение пользователя во время реализации: ручной ввод

После задач 1–9 добавить окно ручного ввода SSCC/полного KM на экране перепечатки по фреймам «Склад / 18–19». Ввести focused failing UI test: invalid checksum не вызывает lookup/transport; valid 18-digit SSCC проходит тот же work.scan и одну отправку; дубликат не печатается автоматически; cancel/Enter/paused scanner и запрет ручной verification. Реализовать форму на shared Input/FullScreenDialog, RU/EN, проверить реальные компоненты в Chromium 1280×800/1024×768, повторить Station test/typecheck/lint/build и format:check. Domain/API protocol и данные источника не меняются.

Уточнение после скриншотов: действие ручного ввода закрепить в верхней панели по обновлённым макетам. Исправить ранее отложенное замечание preview: alignment, переносы, maxWidth/maxLines, общий растеризатор кириллицы и DPI назначения, GS1-128 для SSCC. Проверить RED→GREEN и полный Domain/Station/browser набор. Пользователь явно разрешил после правок коммит, пуш и PR; прежнее ограничение на эти действия снято. Merge, выпуск и deployment остаются отдельными этапами.

## Исправления по ревью 2026-10-10

Все десять замечаний включены в реализацию: исторический приём без текущего eligibility; один tx executor без вложенного пула и каталога из 1000 шаблонов; online refresh источника; числовая группа ЧЗ в bundle/SQLite; очистка accepted sent/verified; выбор одной строки UI без проверки байтов; ожидание живой отправки при remount; failed_before_send при смене владельца до транспорта; общая модель preview/print. Фокусные регрессии используют Postgres с пулом max=1, два подключения реальной SQLite, принятый производственный код и отложенный fake transport. Две дополнительные правки свежего ревью: bars-only EAN-13 в новой модели без изменения legacy ZPL и MATERIALIZED выбор кандидата перед JSON projection. Итоговые результаты и ограничения зафиксированы в acceptance evidence.
