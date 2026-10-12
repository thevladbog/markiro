# Pallet Reprint Screen and Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in this session. Steps use checkbox (`- [ ]`) syntax for tracking. The user previously selected execution here, with checks after each stage; preserve that method. A final independent review follows implementation.

**Goal:** Привести перепечатку палеты к общему экрану, разрешить выбор совместимого шаблона по сохранённым фактам и устранить необъяснимую блокировку успешно закрытой палеты.

**Architecture:** Исторический источник V1 неизменен. Новое задание V2 хранит отдельный снимок выбранного макета и исторических данных; его события и аудит привязаны к этому снимку. Диагностика отделяет отставание синхронизации от неизвестной доставки, а разрешение исходной попытки имеет собственный durable журнал.

**Tech Stack:** TypeScript/Zod, React/@markiro/ui, SQLite/Tauri, NestJS/Drizzle/Postgres, Vitest и Playwright. Node 24+, Corepack и repository-declared pnpm; новых библиотек нет.

**Spec:** `docs/superpowers/specs/2026-10-12-pallet-reprint-screen-and-template-design.md` (документ согласован пользователем 2026-10-12).

## Global Constraints

- Только закрытые производственные палеты Station; handheld, сборные складские палеты и изменение состава вне задачи.
- Исторические SSCC, факты, даты и branding не пересчитываются из текущего каталога.
- `PalletLabelSourceV1` и V1 DTO не переписываются ради выбранного шаблона.
- Для источника А4 доступны три А4-макета; для термоисточника — термошаблоны. Переход между этими типами источников вне первого выпуска.
- Неизвестная доставка допускает только точный повтор сохранённых байтов; другой макет — новое задание после разрешения прежнего.
- Новые миграции, tenant/device/operator authorization, offline grants и credential commit leases обязательны.
- Не открывать закрытую смену и не фабриковать успешное производственное событие.
- Старые V1 задания/очереди переживают обновление. API V2 выпускается раньше потребляющей Station.
- Ранее согласованные 30 дней и условия ретенции не расширять.
- Браузер: 1024×768 и 1280×800, ru/en, light/dark. Windows и физическая печать — отдельная приёмка.

## Review Focus

1. Сервер хранит более позднюю неизвестную попытку, а локально есть старый `sent`: не разрешать печать по устаревшему доказательству (Task 1/5).
2. Оператор меняет шаблон в диалоге, одновременно приходит новый скан/смена владельца: не печатать другую палету и не применять поздний ответ (Task 6).
3. Шаблон архивирован или изменён после подготовки: повтор использует зафиксированный снимок, не текущий каталог (Task 3/4/6).
4. Архивная палета имеет неполные поля: не превращать неизвестную дату/branding в сегодняшнее значение и не скрывать причину несовместимости (Task 2/6).
5. Сбой между решением исходной попытки и записью outbox/restart: не терять доказательство, не разрешать следующую попытку, не удалять запись ретенцией (Task 5/7).

## Подготовка и карта модулей

Текущая ветка `codex/pallet-reprint-screen-design` создана от `origin/main`, содержит только согласованный дизайн и этот план. До реализации проверить свежий `origin/main`, ancestry и `git status --short`; сохранить чужие изменения. Если main продвинулся, перечитать связанные реализации и миграционный журнал.

Не разбивать `pallet.service.ts` целиком: V1 остаётся в нём; новую ответственность вынести в `pallet-renderings.service.ts` и `pallet-resolutions.service.ts`. На Station оставить `pallet-work.ts` оркестратором, вынести диагностику, каталог, снимки и исходные разрешения в соседние небольшие модули. Не переименовывать термины API/SQL вне новых контрактов.

Новые PostgreSQL миграции генерируются штатным Drizzle после изменения схемы; номер и имя берутся из результата генератора на актуальном main, не резервируются заранее. Не редактировать применённые migrations/meta. Прочитать `packages/db/drizzle.config.ts` перед генерацией. SQLite DDL добавляется в authoritative runtime list; проверяется на старой базе и вращающихся соединениях.

### Task 1: Воспроизведение блокировки и классификация причин

**Files:**

- Modify: `apps/station/src/lib/warehouse-reprint/pallet-sources.ts`, `apps/station/src/lib/warehouse-reprint/pallet-sync.ts`.
- Create: `apps/station/src/lib/warehouse-reprint/pallet-diagnostics.ts`.
- Modify/Test: `apps/station/test/warehouse-pallet-sources.test.ts`, `apps/station/test/warehouse-pallet-review.test.ts`, `apps/api/test/warehouse-pallet-reprint-lookup.e2e.test.ts`.
- Create: `apps/station/test/support/pallet-reprint.ts` (выделить существующие SQLite/source/client fixtures из перечисленных тестов без ослабления assertions).

**Interfaces:**

- Consumes: `PalletLabelSourceV1`, `SqlExecutor`, `StationClient`, действующие источники и производственные receipts.
- Produces: `PalletDeliveryDiagnostic` ниже; `readPalletDeliveryDiagnostic(exec, owner, sscc): Promise<PalletDeliveryDiagnostic>`; `syncWarehousePalletEvidence(client, exec, owner, sscc): Promise<void>` отправляет существующий сохранённый источник/receipt через V1 source-sync, не создаёт новый receipt.

```ts
type PalletDeliveryDiagnostic =
  | { kind: "ready"; sscc: string; sourceRevision: string }
  | { kind: "sync_pending"; sscc: string; attemptId: string; sourceRevision: string }
  | {
      kind: "delivery_unknown" | "prepared" | "sending" | "failed_before_send";
      sscc: string;
      attemptId: string;
      sourceRevision: string;
      originDeviceId: string;
    }
  | { kind: "snapshot_missing" | "composition_changed"; sscc: string };
```

- [ ] Выделить fixture `createPalletLookupFixture()` с методами `seedClosedPrintedPallet()`, `seedLocalSent()`, `seedServerMissingReceipt()`, `seedServerLaterUnknown()`, `seedCompositionChange()`, `lookup()`, `close()`; каждый seed записывает production-like реальные таблицы/DTO из текущих тестов. В fixture expose `exec`, `owner`, `sscc`, `client`, `operatorId`; не добавлять фиктивные raw КМ в source JSON.
- [ ] Добавить regression закрытой успешно напечатанной палеты: локальный receipt `sent`, сервер ещё не получил его; source-sync принимает тот же receipt, повторный lookup находит источник. Проверить, что source revision/occurredAt/sequence не меняются и не создаётся новый `sent`.

```ts
it("syncs the existing sent receipt before retrying lookup", async () => {
  const h = await createPalletLookupFixture();
  try {
    await h.seedClosedPrintedPallet();
    await h.seedLocalSent();
    await h.seedServerMissingReceipt();
    const result = await h.lookup();
    expect(result.source.sscc).toBe(h.sscc);
    expect(h.client.post).toHaveBeenCalledWith(
      "/station/warehouse-reprint/pallet-sources",
      expect.objectContaining({ productionDelivery: expect.objectContaining({ state: "sent" }) }),
    );
  } finally {
    h.close();
  }
});
```

- [ ] Run RED: `corepack pnpm --filter @markiro/station exec vitest run test/warehouse-pallet-sources.test.ts test/warehouse-pallet-review.test.ts`. Зафиксировать конкретный fail; если сценарий проходит, исследовать другие ветви диагностик, не менять eligibility без воспроизведения.
- [ ] Реализовать классификацию и повторную доставку доказательства. Автоматический lookup-retry ограничен одной попыткой; общий durable sync остаётся retry-safe. Серверный отрицательный composition/late-attempt результат не обходится локальным cache.

```ts
if (diagnostic.kind === "sync_pending") {
  await syncWarehousePalletEvidence(client, exec, owner, diagnostic.sscc);
  // Repeat lookup once with the same operator/raw identity; validate its authoritative response.
}
```

- [ ] Добавить отрицательные тесты: поздняя неизвестная попытка; тот же count с другим составом; конфликт source-sync; не тот владелец; два скана в полёте. Локальный `sent` не должен перекрывать эти причины.
- [ ] Run GREEN: focused Station tests и `corepack pnpm --filter @markiro/api exec vitest run test/warehouse-pallet-reprint-lookup.e2e.test.ts` с безопасным test env. Без env зафиксировать skip, не использовать production.
- [ ] Проверить diff и сохранить scoped commit `fix(station): diagnose closed pallet reprint eligibility`.

### Task 2: Доменные контракты V2 и неизменный rendering snapshot

**Files:**

- Create: `packages/domain/src/warehouse-reprint/pallet-reprint-v2.ts`, `packages/domain/test/pallet-reprint-v2.test.ts`.
- Modify: `packages/domain/src/index.ts`; V1 `pallet-contracts.ts` только для повторного использования экспортируемых базовых schemas без изменения wire shape.
- Create: `packages/domain/test/support/pallet-reprint.ts` (детерминированные A4/thermal sources, основанные на существующих builders).

**Interfaces:**

- Produces: `PALLET_REPRINT_V2_PROTOCOL = "warehouse-pallet-reprint-v2"`, `PALLET_PRODUCTION_RESOLUTION_PROTOCOL = "warehouse-pallet-production-resolution-v1"`; strict schemas `palletRenderingV2Schema`, `palletTemplateCatalogV2Schema`, `palletLookupV2RequestSchema`, `palletLookupV2ResultSchema`, `palletRenderingsV2BatchSchema`, `palletEventsV2BatchSchema`, `palletProductionResolutionsSchema` и receipt schemas для каждого batch.
- Produces: типы `PalletRenderingV2`, `PalletTemplateChoice`, `PalletProductionResolution`; функции `makePalletRenderingV2(source, choice)`, `assertPalletRenderingMatchesSource(source, rendering)`.

```ts
// Rendering body contains historical data and the chosen compatible template;
// renderingRevision is a digest of this entire body, not a mutable catalog revision.
const body = {
  version: 2 as const,
  sscc: source.sscc,
  sourceRevision: source.revision,
  rendering: { ...source.rendering, template: choice.snapshot },
  templateId: choice.id,
};
const rendering = palletRenderingV2Schema.parse({
  ...body,
  renderingRevision: productLabelValueDigest(body),
});
```

`PalletTemplateChoice` — discriminated A4/thermal choice с nullable `id`, `name`, snapshot и snapshot digest; null ID только у исходного макета. `makePalletRenderingV2` сначала проверяет одинаковый kind. V2 events добавляют `renderingRevision`; остальные attempt/job/source/state invariants V1 сохраняются. Lookup V2 unavailable включает безопасный diagnostic, source revision/attempt binding при наличии. Resolution содержит eventId, sscc, sourceRevision, attemptId, operatorId, reason, occurredAt и `confirmed`/`skipped`; для confirmed требуется normalized scanned SSCC, совпадающий с sscc. Никаких raw КМ в stored snapshot/event.

- [ ] Добавить RED tests всех трёх A4 и термоснимка, template ID null для original, digest corruption, смены SSCC/counts/facts/branding, kind mismatch, неизвестных полей и отсутствующих исторических данных.

```ts
it("changes the template without mutating the historical source", () => {
  const source = a4PalletSource();
  const before = JSON.stringify(source);
  const rendered = makePalletRenderingV2(source, landscapePalletChoice());
  assertPalletRenderingMatchesSource(source, rendered);
  expect(rendered.renderingRevision).not.toBe(source.revision);
  expect(rendered.rendering.kind).toBe("a4");
  expect(JSON.stringify(source)).toBe(before);
});
```

Fixture functions `a4PalletSource()` и `landscapePalletChoice()` определить в новом test/support через `buildPalletSheetPresets`, `createPalletSheetSnapshot`, `makePalletLabelSource`, валидный SSCC и branding из текущего `test/support/pallet-sheet.ts`.

- [ ] Run RED: `corepack pnpm --filter @markiro/domain exec vitest run test/pallet-reprint-v2.test.ts`.
- [ ] Реализовать schemas, digest и точное сравнение исторических данных; данные из source не дополняются сегодняшним каталогом.
- [ ] Добавить тесты state transitions: unknown + different digest/rendering запрещён; новый rendering требует нового job; original resolution не относится к другой попытке.
- [ ] Run domain `test`, `typecheck`, `lint`, `build`. Проверить существующие pallet V1 tests неизменными.
- [ ] Commit `feat(domain): define pallet reprint rendering v2`.

### Task 3: Durable storage и миграции без изменения V1

**Files:**

- Modify: `packages/db/src/sqlite/pallet-reprint-schema.ts`, `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `packages/db/src/schema/pallet-label-sources.ts`, `packages/db/src/schema/index.ts`.
- Create: `packages/db/src/sqlite/pallet-reprint-v2-migrations.ts`, `packages/db/src/schema/pallet-reprint-renderings.ts`, `packages/db/src/schema/pallet-production-resolutions.ts`, новый generated PostgreSQL migration/meta.
- Modify/Test: `packages/db/test/warehouse-reprint-sqlite.test.ts`, `packages/db/test/warehouse-pallets-migration.test.ts`.
- Create: `packages/db/test/pallet-reprint-v2-schema.test.ts`, `apps/station/src/lib/warehouse-reprint/pallet-rendering-store.ts`, `apps/station/src/lib/warehouse-reprint/pallet-resolution-store.ts`, `apps/station/test/warehouse-pallet-v2-store.test.ts`.

**Interfaces:**

- Produces: `savePalletRendering(exec, owner, jobId, rendering): Promise<void>`, `readPalletRendering(exec, owner, jobId): Promise<PalletRenderingV2 | null>`.
- Produces: `recordPalletProductionResolution(exec, owner, resolution): Promise<void>` — durable resolution и pending outbox в одной SQL-команде; `readPalletProductionResolution(exec, owner, sscc, attemptId)`.
- Server tables: `pallet_reprint_renderings` (tenantId, deviceId, jobId, sscc, sourceRevision, renderingRevision, value); `pallet_production_resolutions` (tenantId, sourceDeviceId, eventId, sscc, sourceRevision, attemptId, value). Composite keys/FKs не позволяют связать разные tenant/device/source.
- Local `warehouse_pallet_jobs`: nullable `rendering_json`, `rendering_revision`, `protocol`, `session_id`; null protocol означает V1. Resolution journal одновременно является durable outbox (`pending/accepted/conflict`, last_tried_at); отдельная потеряемая очередь не нужна.
- Persisted `warehouse_pallet_settings` дополняется сеансом (session ID, active/finished, sent count, selected template snapshot по kind). Старые строки читаются с безопасными defaults; счётчик увеличивается атомарно только для новой `sent` попытки сеанса, не для повторного ACK. Уникальная запись `(owner, session_id, attempt_id)` в локальном `warehouse_pallet_session_sends` и триггер увеличения счётчика дают одну SQL-команду и защиту от повторов. Внести эту таблицу и её retention guard в Task 3/5.

- [ ] Написать RED tests update старой SQLite базы с существующим V1 job, миграции на rotating connections, immutable rendering, atomic resolution insertion/outbox и tenant composite FKs.

```ts
const legacy = await exec.all("SELECT source_json,bytes_base64,state FROM warehouse_pallet_jobs");
await applyMigrations(exec);
expect(await exec.all("SELECT source_json,bytes_base64,state FROM warehouse_pallet_jobs")).toEqual(
  legacy,
);
await recordPalletProductionResolution(exec, owner, resolution);
await recordPalletProductionResolution(exec, owner, resolution);
expect(
  await exec.all("SELECT event_id,receive_status FROM warehouse_pallet_production_resolutions"),
).toEqual([{ event_id: resolution.eventId, receive_status: "pending" }]);
```

- [ ] Добавить schema/DDL. Новые SQLite поля добавляются через установленные runtime migration helpers, не последовательный BEGIN/COMMIT на pooled executor. Resolution вставляется одним `INSERT ... ON CONFLICT` с проверкой неизменного digest.
- [ ] Сгенерировать PostgreSQL SQL штатным `corepack pnpm --filter @markiro/db db:generate`, проверить SQL/metadata/ключи/checks; не применять к общей dev DB без определения test scope.
- [ ] Run DB focused tests, затем package `test/typecheck/lint/build`; запустить Station V2 store tests после DB build. Test Postgres применяет новые migrations в изолированном test DB; journal/schema сверены.
- [ ] Проверить restart/rejection atomicity: до фиксации resolution нет готового локального разрешения; после фиксации всегда есть pending запись для sync.
- [ ] Commit `feat(db): persist pallet renderings and production resolutions`.

### Task 4: Station-only API V2, каталог, аудит и совместимость

**Files:**

- Create: `apps/api/src/modules/station-warehouse-reprint/pallet-renderings.service.ts`, `pallet-resolutions.service.ts`.
- Modify: существующие `controller.ts`, `pallet.service.ts`, `templates.service.ts`, `station-warehouse-reprint.module.ts`, `apps/api/src/cors.ts`.
- Test: `apps/api/test/station-warehouse-reprint-openapi.test.ts`, `warehouse-pallet-reprint-lookup.e2e.test.ts`, `subscription-route-inventory.test.ts`, `apps/api/test/cors-station-surface.test.ts`, `cors.e2e.test.ts`, `device-grants-cors.test.ts`, `platform-route-contracts.ts`.
- Create: `apps/api/test/warehouse-pallet-v2.e2e.test.ts`, `warehouse-pallet-resolution.e2e.test.ts`.

**Interfaces:**

- `GET /station/warehouse-reprint/pallet-templates-v2` → tenant-scoped original-compatible pallet template catalog; V1 templates response unchanged.
- `POST .../pallet-lookup-v2` → V2 source/diagnostic; V1 lookup unchanged.
- `POST .../pallet-renderings-v2` → immutable renderings receipts.
- `POST .../pallet-events-v2` → attempt-bound events receipts.
- `POST .../pallet-production-resolutions` → original-attempt resolution receipts.
- capabilities добавляют две строки Task 2 только при готовности всех соответствующих handlers.

```ts
// Use the existing station context extractor and subscription recovery policy.
const { tenantId, deviceId } = scope(req);
await assertWarehouseDevice(db, tenantId, deviceId);
await assertWarehouseOperator(db, tenantId, entry.operatorId);
assertPalletRenderingMatchesSource(source, entry.rendering);
// Persist tenant/device/job + renderingRevision immutably before accepting its events.
```

`scope(req)` — существующий helper controller; `assertWarehouseDevice`/`assertWarehouseOperator` — существующие helpers `access.ts`. Живой lookup/создание resolution проверяют текущие права. Для replay ранее подготовленных событий сохранить established historical admission после проверки исходного принятия; не терять delayed audit только из-за деактивации оператора. Offline grants на Station проверяются перед preparation/send/resolve существующим admission. Никакой второй authorization boundary.

- [ ] RED: cross-tenant IDs, handheld, revoked operator grant, sourceRevision mismatch, mutated facts/branding, catalog template другого tenant, different rendering for same job. Проверять точный per-record conflict/403 policy, не только статус happy path.
- [ ] Реализовать новые services с existing membership/access validation. Выбранный template ID обязан принадлежать tenant; snapshot может быть историческим после архивирования/изменения, поэтому не подменять его latest spec.
- [ ] Добавить tests: rendering до source — retryable; event до rendering — retryable; повтор одинакового rendering/event идемпотентен; state transition/digest substitution — conflict. V1 очереди принимаются рядом с V2.
- [ ] Audit assertions: tenant, device/operator, target pallet, reason, sourceRevision, renderingRevision, template ID/kind, printFormat, state, outcome. RAW/A4 format определяется новым rendering, а не исходным source kind alone.
- [ ] В eligibility учитывать accepted исходное resolution только при точной sourceDevice/sourceRevision/attempt связи; поздний unknown не покрывается ранним resolution. Не менять closure/scan facts.
- [ ] Обновить OpenAPI/CORS/route inventories; run focused e2e и contract tests, затем API `test/typecheck/lint/build` в безопасном env. DB/domain dist заранее построены.
- [ ] Commit `feat(api): admit pallet reprint v2 and original resolutions`.

### Task 5: Очереди Station и безопасная диагностика/разрешение

**Files:**

- Create: `apps/station/src/lib/warehouse-reprint/pallet-v2-sync.ts`, `pallet-resolutions.ts`, `pallet-templates.ts`.
- Modify: `pallet-sync.ts`, `pallet-sources.ts`, `production-delivery.ts`, `history-retention.ts`, `apps/station/src/lib/sync.ts`.
- Create/Test: `apps/station/test/warehouse-pallet-v2-sync.test.ts`, `warehouse-pallet-resolution.test.ts`.
- Modify/Test: `apps/station/test/warehouse-reprint-retention.test.ts`, `warehouse-pallet-review.test.ts`.

**Interfaces:**

- `loadPalletTemplates(client, exec, owner): Promise<PalletTemplateCatalogV2>` с tenant/owner scoped cache; original snapshot не зависит от сетевого каталога.
- `syncWarehousePalletV2(client, exec, owner): Promise<void>` чередует renderings/events по last_tried_at.
- `resolveOriginalPalletDelivery({exec, owner, generation, operatorId, diagnostic, outcome, scannedSscc?, reason}): Promise<void>`: проверяет актуальность и права, пишет одну immutable resolution/outbox. `confirmed` требует exact normalized SSCC.
- `syncPalletProductionResolutions(client, exec, owner): Promise<void>` независим от других каналов.

- [ ] RED scenarios: crash/restart, offline lookup/resolution, server pending receipt, server conflict, old owner late ACK, поздняя unknown попытка, вращающиеся SQLite connections, повтор ACK счётчика.

```ts
await resolveOriginalPalletDelivery({
  exec,
  owner,
  generation,
  operatorId,
  diagnostic,
  outcome: "confirmed",
  scannedSscc: diagnostic.sscc,
  reason: "not_printed",
});
await syncPalletProductionResolutions(client, exec, owner);
expect(
  await readPalletProductionResolution(exec, owner, diagnostic.sscc, diagnostic.attemptId),
).toMatchObject({ receive_status: "accepted" });
```

Test fixture имитирует exact attempt binding и operator grant из текущего Station support; неправильный SSCC и другая attempt ID должны отвергаться до записи.

- [ ] Реализовать capability-gated каталоги и очереди; V2 не отправляется в V1 endpoint. Один застрявший канал не блокирует старый audit/source sync. Ошибки/rejections остаются durable и видимыми.
- [ ] Добавить regression retention: unresolved resolution, pending rendering/event, conflict и связанные unknown доставки защищены; независимое terminal задание не удерживает всю станцию.
- [ ] Run focused Station journal/sync/retention suites и DB migration tests. Проверить отсутствие raw КМ в новых cache/events и логах.
- [ ] Commit `feat(station): sync pallet rendering and resolution journals`.

### Task 6: Общий экран, template picker, preview и подтверждение

**Files:**

- Modify: `apps/station/src/pages/WarehouseReprint.tsx`, `apps/station/src/ui/warehouse-reprint/PalletConfirmation.tsx`, `apps/station/src/lib/warehouse-reprint/pallet-work.ts`, `pallet-printing.ts`, `apps/station/src/station.css`, `apps/station/src/i18n/ru.json`, `en.json`.
- Create: `apps/station/src/ui/warehouse-reprint/PalletTemplatePicker.tsx`, `PalletDeliveryRecovery.tsx`, `apps/station/src/lib/warehouse-reprint/pallet-rendering.ts`.
- Modify/Test: `apps/station/test/warehouse-pallet-screen.test.tsx`, `warehouse-pallet-work.test.ts`, `warehouse-pallet-reprint-printing.test.ts`, `warehouse-pallet-windows.test.ts`, `warehouse-reprint-screen.test.tsx`.
- Create: `apps/station/test/warehouse-pallet-template-picker.test.tsx`.

**Interfaces:**

- Work state добавляет persisted session, selected choice, catalog, diagnostic; исходный `selection.source` неизменен.
- Work methods: `refreshTemplates()`, `selectTemplate(choice)`, `resolveOriginal(outcome, scannedSscc?, reason)`. Dialog busy/epochs прекращают scan subscription.
- `renderPalletReprint(rendering, profile)` возвращает preview и printable artifact из одного rendering snapshot; job prepare сохраняет снимок до отправки.

```tsx
<main className="warehouse-reprint" data-testid="warehouse-pallet-screen">
  <header className="warehouse-heading">{headingAndManualActions}</header>
  <div className="warehouse-work-grid">
    <section className="warehouse-main">{scanOrSelectedPallet}</section>
    <aside className="warehouse-session-panel">{reasonTemplatePrinterAndCounter}</aside>
  </div>
  <footer className="warehouse-footer">{reasonAndFinishActions}</footer>
</main>
```

Это layout blueprint: переменные — именованные JSX blocks того же компонента, сформированные из текущего state/actions. Переиспользовать реальные классы footer/action из существующего `WarehouseReprintView`, не оставлять новый класс без CSS. Общий container включает tabs без double padding и nested overflow.

- [ ] Сначала RED UI tests пустой/найденной/неизвестной карточки, manual dialog, шаблона и reason dialog; сравнить структуру heading/work-grid/session-panel с codes screen. Ошибка original receipt содержит идентичность и CTA, не generic string alone.
- [ ] Для UI первого подэтапа подключить общую раскладку с текущим V1 source; если API V2 недоступен, picker объясняет ограничение и допускает original. Не показывать неработающую «Выбрать шаблон» без причины.
- [ ] RED domain-to-job tests выбора каждого A4 и thermal: snapshot в job/event именно выбранный, preview/bytes используют одинаковые facts, original source unchanged. Для unknown pending job picker disabled и replay exact bytes.

```ts
const before = JSON.stringify(source);
await work.selectTemplate(landscapeChoice);
await work.confirm(source.revision);
const job = work.getSnapshot().job;
expect(job?.rendering?.rendering.template).toEqual(landscapeChoice.snapshot);
expect(JSON.stringify(source)).toBe(before);
```

`job.rendering` — nullable `PalletRenderingV2`, добавленный reader Task 3; `landscapeChoice` — fixture Task 2. Перед confirm повторно проверяется source membership/revision, но не заменяется выбранный frozen template latest каталогом.

- [ ] Реализовать template dialog с originals, размерами, previews, совместимостью и явными missing-fields reasons. Хранить выбор по kind в сеансе; палета с несовместимыми historical fields не молча получает другой template.
- [ ] Реализовать подготовку V2 artifacts с текущими transports/journals. Driver preflight использует orientation выбранного template. После подготовки макет immutable; новый макет после terminal исхода — новый job.
- [ ] UI recovery при unknown: scan-confirm/skipped dialog с reason и предупреждением; другая станция видит location и недоступность действия. `failed_before_send` не требует подтверждать наличие отпечатка.
- [ ] Добавить тесты late catalog/source result после нового скана/owner change, выбора архивного template, restart, finish/switch с unresolved и счётчика sent vs verified. Confirm не отправляет дважды при двойном нажатии.
- [ ] Run focused UI/work/Windows journal tests, затем Station `test/typecheck/lint/build`; rebuild domain/DB перед consumer checks. RAW ZPL/TSPL и Windows-driver покрываются отдельно.
- [ ] Commit `feat(station): unify pallet reprint screen and choose saved-data templates`.

### Task 7: Браузер, полный review и выпускной порядок

**Files:**

- Modify: `apps/station/test/browser/pallet-reprint-harness.tsx`, `tools/production-browser/product-labels-tests/pallet-reprint.spec.ts`.
- Create: `tools/production-browser/product-labels-tests/pallet-reprint-layout.spec.ts`.
- Verify: `tools/ci/affected.mjs`, `.github/workflows/ci.yml`, `tools/production-browser/station-startup-tests/startup.spec.ts` (менять только при обнаруженной дыре покрытия).
- Modify: `docs/acceptance/station-warehouse-reprint.md`, `docs/acceptance/station-warehouse-reprint-evidence.md`, `docs/acceptance/validation-pallet-a4-printing.md`.

- [ ] Браузерный harness запускает реальный `WarehouseReprint` с обоими modes, seeded SQLite/scan source и mock transport; не ограничиться изолированным `PalletConfirmation`. Harness fixture описывает V1 server, V2 catalog, pending server receipt, late unknown и authorization conflict.
- [ ] RED visual behavior tests обеих resolutions/themes/locales. Снимки сохраняются только через `testInfo.outputPath`; проверяются реальные bounds, скролл и actions.

```ts
await page.setViewportSize({ width: 1024, height: 768 });
await page.getByRole("button", { name: "Палета", exact: true }).click();
const screen = page.getByTestId("warehouse-pallet-screen");
await expect(screen.getByRole("heading", { name: "Перепечатка палеты" })).toBeVisible();
await expect(screen.getByRole("button", { name: "Выбрать шаблон" })).toBeVisible();
const padding = await screen.evaluate((el) => getComputedStyle(el).paddingLeft);
expect(Number.parseFloat(padding)).toBeGreaterThan(0);
await expect(screen.getByRole("button", { name: "Завершить сеанс" })).toBeInViewport();
await page.screenshot({ path: testInfo.outputPath("pallet-empty.png") });
```

- [ ] Добавить tests selected landscape/portrait/two-A5, long product text, missing facts, no logo gap regression, recovery diagnostic/CTA, modal scanner suspension, no print before confirm, unknown bytes replay. Проверять actual snapshot/template digest и transport call count.
- [ ] Run `corepack pnpm --dir tools/production-browser exec playwright test --config product-labels.playwright.config.ts pallet-reprint` и harness TS. Затем production startup smoke через `station-startup.playwright.config.ts`; не повышать timeout/retries для получения зелёного результата.
- [ ] Full gates changed packages: domain/DB/API/Station `test/typecheck/lint/build`; production bundle contracts; route/OpenAPI/CORS; focused migration/retention; `corepack pnpm format:check`; `git diff --check`. Native Rust не менялся — проверяется штатным CI, Windows device acceptance остаётся отдельной.
- [ ] Самостоятельно проверить полный three-dot diff против свежего `origin/main`; один независимый reviewer смотрит весь новый контракт, journals, UI и negative cases. Исправить подтверждённые findings с focused RED/GREEN, не слепо применять текст ревью.
- [ ] Commit final validation/docs explicit paths. Push/PR выполняются в рамках явного разрешения пользователя; merge/deploy/release — отдельная авторизация. Не включать чужие файлы из primary checkout.
- [ ] В PR перечислить поведение, миграции, API-first requirement, автоматические результаты/skip и отсутствие физической Windows-приёмки. Deploy API migrations/handlers сначала, Station beta затем. Version выбирается при отдельном запросе на релиз, не фиксируется здесь.
- [ ] После beta — отдельная hardware checklist: штатная успешная печать/закрытие и перепечатка на той же станции; все три A4 и SSCC scanner; driver refusal; offline/restart; original unknown confirmation/skip. Stable только после подтверждённой физической приёмки.

## Execution handoff

Пользователь ранее выбрал выполнение здесь по этапам. После review этого плана использовать `superpowers:executing-plans`, самому реализовать задачи по порядку, сообщая проверки и ограничения после каждого этапа. В середине шага не запрашивать повторное разрешение на уже утверждённые действия. Если выяснится изменение семантики исторических данных или расширение cleanup/deploy scope, зафиксировать конкретную границу и согласовать её отдельно.
