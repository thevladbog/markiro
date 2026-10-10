# Editable A4 Pallet Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Delegation requires the user's chosen execution method or applicable explicit instructions.

**Goal:** Полноценные редактируемые шаблоны палет А4 в админке, с импортом/экспортом JSON, общим предпросмотром и безопасной офлайн-печатью на Station через Windows.

**Architecture:** Новый строгий V2 spec хранит редактируемый макет; три стандартных варианта являются обычными записями библиотеки. API хранит и валидирует JSON, фиксирует версию шаблона для смены и выдаёт V2 только совместимым клиентам. Общий domain renderer используется админкой и Station; журнал попытки сохраняет spec, факты, ресурсы, геометрию и байты независимо от последующих правок в кабинете.

**Tech Stack:** TypeScript, React, Zod, текущие bwip-js/монохромные примитивы, PostgreSQL/Drizzle, SQLite, NestJS, Tauri/Rust/GDI, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-station-pallet-a4-printing-design.md`.

Обновлено 2026-10-10 по подтверждению пользователя. Реализация по этапам разрешена 2026-10-11; выполнена в изолированной ветке `codex/pallet-a4-templates` от `aaed22588`. Пользователь отдельно разрешил commit/push/PR после проверок. Результаты и оставшиеся внешние проверки приведены в [документе приёмки](../../acceptance/validation-pallet-a4-printing.md). Исходное исследование использовало дерево `57d589e2a`; перед реализацией оно было сверено с актуальным main. Старый вариант со встроенными макетами Station заменён этим документом целиком.

## Global Constraints

- Node 24+, repository-declared pnpm через Corepack; сначала собрать изменённые shared packages.
- `purpose=pallet` сохраняется. Новый формат — `pallet_sheet_v2`, старый — `label_v1`; формат не смешивается с RAW/Windows transport.
- V1 JSON/термоэтикетки/ZPL/TSPL и существующие журналы остаются совместимыми. V2 не читается через lenient V1 parser.
- JSON V2: до 256 КиБ UTF-8, 200 узлов, глубина 8, строгие поля, finite numbers, уникальные ID. Без JS/HTML/CSS/внешних URL/tenant assets в переносимом файле.
- Исходник `mono-raster-v1`, 300 dpi, ≤2 МиБ; вывод Windows 300/600/1200 dpi целочисленным увеличением 1/2/4, без сглаживания.
- Один SSCC обычной ориентации внизу каждой этикетки. Две одинаковые А5 — один лист и один spool job, `dmCopies=1`, без второго SSCC allocation.
- Стартовые размеры: высота штрихов 45 мм; А4 11 точек/модуль; А5 9 или 8 до рендера по фактической геометрии. Quiet zones ≥10X; длина с quiet zones ≤165,1 мм; никаких fit-to-page/обрезки/дробного масштабирования.
- Логотип компании, иначе Маркиро; естественные пропорции, ограничение по высоте. Нет даты → нет строки даты/производной годности. ЕГАИС условный и без сокращения. Название до пяти строк в вертикальных макетах.
- Рендер клиентский; шрифты/Маркиро bundled. Подготовка и повтор офлайн. Late responses старого owner не коммитятся.
- `delivery_unknown` не повторяется автоматически. Spool receipt не доказывает физическую печать.
- Пользователь разрешил реализацию с проверками после каждого этапа и отдельно commit/push/PR после их завершения. Rollout и cleanup требуют отдельного разрешения; Windows и физическая приёмка остаются внешними этапами.

## Review Focus

1. V2 случайно попадает в старый parser/picker/default/bundle/ТСД либо доступен через прямой ID — fail closed до производственных побочных эффектов (Tasks 1, 3, 6).
2. Визуальный editor → JSON → import теряет условия/логотип/раскладку, или неизвестная версия частично принимается — strict round-trip и сохранение draft (Tasks 1, 4, 5).
3. Изменение/отключение/удаление шаблона либо логотипа меняет уже подготовленный лист — immutable snapshot и точное воспроизведение (Tasks 3, 6, 7, 9).
4. Пять строк + ЕГАИС + даты + широкий логотип не помещаются, особенно на А5 — measured layout, точная ошибка без обрезки (Tasks 2, 5).
5. Драйвер меняет поля/DPI после preview, или header capability подставляет неподдерживаемый handheld — независимая проверка реальной платформы и geometry before send (Tasks 6, 8, 9).

## Последовательность и границы

1. Domain V2/JSON → 2. Renderer/presets → 3. Storage/API/defaults → 4. Library/import/export → 5. Visual editor → 6. Shift selection/protocol → 7. Branding → 8. Windows geometry → 9. Durable Station integration → 10. Integration/release gates.

Каждый этап заканчивается своими focused tests и проверкой diff. Один рабочий план нужен потому, что это один сквозной контракт шаблона; проверяемые этапы не означают отдельные несогласованные релизы. До завершения совместимости V2 не выдаётся устройствам. Номера новых миграций назначаются по актуальному migration journal, уже применённые миграции не переписываются.

---

### Task 1: Версионированный spec и переносимый JSON

**Files:** create `packages/domain/src/labels/pallet-sheet-model.ts`, `packages/domain/src/labels/stored-template.ts`, `packages/domain/test/pallet-sheet-model.test.ts`, `packages/domain/test/pallet-sheet-json.test.ts`, `packages/domain/test/support/pallet-sheet.ts`; modify `packages/domain/src/labels/json-import.ts`, `packages/domain/src/index.ts`. Read legacy `model.ts` and `import.ts`; don't widen legacy rendering functions indiscriminately.

**Interfaces:** export `PalletSheetSpecV2`, `StoredLabelTemplateSpec = LabelTemplateSpec | PalletSheetSpecV2`, `parseStoredLabelTemplate(value: unknown): StoredLabelTemplateSpec`, `parseStoredLabelJson(source: string, options?: {nameForBareSpec: string; purposeForBareSpec: LabelTemplatePurpose}): StoredTemplateJson`, `serializeStoredLabelJson(payload: StoredTemplateJson): string`. `StoredTemplateJson={name:string,purpose:LabelTemplatePurpose,spec:StoredLabelTemplateSpec}`; V2 requires `purpose='pallet'`. Keep current `parseLabelTemplate`/`parseLabelJson` V1 signatures for old consumers. New V2 parser does not strip unknown keys.

- [ ] Add shared `makeSheetSpec(): PalletSheetSpecV2` fixture returning the following complete minimal spec. The real three presets are authored in Task 2, not magic renderer enum branches.

```json
{
  "schemaVersion": 2,
  "kind": "pallet_sheet",
  "dpi": 300,
  "page": {
    "size": "A4",
    "orientation": "portrait",
    "copies": 1,
    "cutLine": false,
    "marginsMm": { "top": 10, "right": 10, "bottom": 10, "left": 10 }
  },
  "body": [
    {
      "id": "brand",
      "kind": "organization_logo",
      "source": "organization",
      "fallback": "markiro",
      "maxHeightMm": 16
    },
    { "id": "org", "kind": "field", "field": "organization.name", "fontSizePt": 16, "maxLines": 2 },
    { "id": "title", "kind": "text", "text": "ПАЛЕТА", "fontSizePt": 12 },
    {
      "id": "product",
      "kind": "field",
      "field": "product.printName",
      "fontSizePt": 22,
      "maxLines": 5,
      "reservedLines": 5
    },
    {
      "id": "boxes",
      "kind": "field_row",
      "label": "КОРОБОВ",
      "field": "boxCount",
      "fontSizePt": 14
    },
    {
      "id": "units",
      "kind": "field_row",
      "label": "ЕДИНИЦ",
      "field": "itemCount",
      "fontSizePt": 14
    },
    {
      "id": "date",
      "kind": "field_row",
      "label": "ПРОИЗВЕДЕНО",
      "field": "productionDate",
      "fontSizePt": 14,
      "when": { "field": "productionDate", "op": "present" }
    },
    {
      "id": "egais",
      "kind": "field_row",
      "label": "КОД ЕГАИС",
      "field": "product.egais",
      "fontSizePt": 14,
      "when": { "field": "product.egais", "op": "present" }
    }
  ],
  "footer": {
    "id": "sscc",
    "kind": "sscc",
    "source": "sscc",
    "barHeightMm": 45,
    "moduleDots": 11,
    "align": "center"
  }
}
```

- [ ] Define `SheetNode` as the leaf/group union in the spec. Groups carry `children`, `gapMm` and optional padding; `canvas` children additionally carry finite `xMm/yMm` and measured bounds. `row` has explicit child widths/flex shares. Style uses bounded point sizes/alignment and bundled font choices. Reject duplicate IDs across footer and body, nested SSCC, unsupported bindings/conditions, incompatible two-copy orientation, invalid GS1 dimensions and unknown versions.
- [ ] Write failing assertions for strict dispatch, V1 legacy fidelity and lossless round-trip:

```ts
const payload = { name: "Палета А4", purpose: "pallet" as const, spec: makeSheetSpec() };
expect(parseStoredLabelJson(serializeStoredLabelJson(payload))).toEqual(payload);
expect(() => parseStoredLabelTemplate({ ...payload.spec, schemaVersion: 99 })).toThrow();
expect(() => parseStoredLabelTemplate({ ...payload.spec, language: "zpl" })).toThrow();
```

- [ ] Run `corepack pnpm --filter @markiro/domain exec vitest run test/pallet-sheet-model.test.ts test/pallet-sheet-json.test.ts`; verify failures before implementation.
- [ ] Implement discriminator-first parsing, byte/depth/node limits before expensive layout, strict schema and field-path errors. Bare spec import receives name and selected purpose from the explicit parser options supplied by the editor; missing options for a bare spec produce a specific validation error; wrapper import retains name/purpose. Reject wrapper/spec mismatch. Export canonical UTF-8 `{name,purpose,spec}` with no persistence metadata. Do not normalize user data into another tenant or strip unknown V2 nodes.
- [ ] Add invalid JSON, array root, duplicate IDs, 201 nodes, depth 9, over-limit UTF-8, nonfinite coordinates, `javascript:`/HTTP image sources, wrong purpose and all-node round-trip cases. Re-run focused tests plus domain typecheck/lint/build.

### Task 2: Общий renderer и три редактируемых пресета

**Files:** create `packages/domain/src/labels/pallet-sheet-render.ts`, `packages/domain/src/labels/pallet-sheet-defaults.ts`, `packages/domain/src/labels/mono-compose.ts`, `packages/domain/test/pallet-sheet-render.test.ts`, `packages/domain/test/pallet-sheet-defaults.test.ts`; modify `packages/domain/src/labels/mono-render.ts` only to expose/reuse primitives and export through `src/index.ts`.

**Interfaces:** `renderPalletSheet(spec: PalletSheetSpecV2, context: PalletSheetContext, geometry: SheetGeometry, rasterizeText: RasterizeTextFn): Promise<MonoRaster>`. `PalletSheetContext` contains bare SSCC, product/GTIN/nullable EGAIS, nullable production date and shelf-life source, integer box/item counts, shift number, organization name, mono logo pixels/digest/provenance. `SheetGeometry` contains source 300-dpi dimensions, printable bounds and effective margins. `buildPalletSheetPresets()` returns named V2 specs with stable keys `pallet-a4-portrait`, `pallet-a4-landscape`, `pallet-a4-two-a5`.

- [ ] Test all presets parse, have one footer per logical label, correct paper dimensions and raster ≤2 MiB. For two copies assert equal content regions, same SSCC and only one composed page. Decode one SSCC in each full A4 image and one in each A5 region; no rotated symbols.
- [ ] Test layout flow removing conditional field-row plus label, while canvas preserves unrelated positions. Test five-line names × EGAIS × dates × logos 1:1/4:1/10:1; measure full bounds before writing pixels. Assert overflow has element ID and does not return clipped successful output.
- [ ] Pin critical date and barcode rules:

```ts
const withoutDate = { ...context, productionDate: null, shelfLifeDays: 365 };
const page = await renderPalletSheet(spec, withoutDate, geometry, rasterizeText);
expect(page.dpi).toBe(300);
expect(page.requiredBounds.right).toBeLessThanOrEqual(page.widthDots);
// Collect text through an injected rasterizer: no production/expiry labels or closedAt-derived date.
```

Use local test fixtures defining `context`, `geometry`, `spec` from Task 1 and an injected rasterizer that records text. Include one-day and leap-year expiry; preserve leading zeroes in EGAIS/GTIN and reject unavailable counts instead of printing zero.

- [ ] Run `corepack pnpm --filter @markiro/domain exec vitest run test/pallet-sheet-render.test.ts test/pallet-sheet-defaults.test.ts` red, then implement measure → layout → raster assembly with existing GS1/text logic. Renderer traverses editable nodes; presets do not trigger special-case layouts. Footer is bottom-anchored; body cannot cover its quiet zones.
- [ ] Validate integer module presets and total length ≤165.1 mm. A5 9→8 fallback is selected before rendering and reflected in effective geometry; forbid arbitrary scaling. Preserve original V1 date fallback/global quantity formatting. Finish domain test/typecheck/lint/build.

### Task 3: PostgreSQL, API CRUD, версии и defaults

**Files:** modify `packages/db/src/schema/labels.ts`, `packages/db/src/schema/org-profile.ts`, `packages/db/src/schema/platform.ts`, new Postgres migration under `packages/db/migrations/`; add `packages/db/test/pallet-sheet-templates-migration.test.ts`. Modify `apps/api/src/modules/label-templates/{dto,label-templates.service,label-templates.controller,box-label-template-eligibility}.ts`, `apps/api/src/modules/org-profile/{dto,org-profile.service}.ts`, `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`. Add `apps/api/test/pallet-sheet-templates.e2e.test.ts`; extend `label-templates-openapi.test.ts`, `label-templates.service.test.ts`, `org-profile.e2e.test.ts`.

**Interfaces:** DB `format: 'label_v1'|'pallet_sheet_v2'`, `revision:number`, nullable stable seed key with tenant-scoped uniqueness. New sheet global/category defaults have their own references and do not replace V1 defaults. V2 PATCH carries `expectedRevision`; response returns new revision. V2 summary is a discriminated DTO with page metadata and no language; full spec is `StoredLabelTemplateSpec`.

- [ ] Write failing migration tests: old spec bytes preserved, format/revision backfill, same-tenant FKs, idempotent seed (3 per tenant), repeat seed after user edits, tenant created after rollout. New fields for shift snapshot are nullable and added without rewriting applied migrations. Keep user-selected defaults unchanged.
- [ ] Write failing API tests for unknown V2 version, format/spec mismatch, non-pallet V2, invalid JSON geometry and cross-tenant CRUD/default assignment. Preserve `OPERATIONS_WRITE`, `labelEditor` and subscription behavior. Assert exact template/revision/actor/tenant/result audit fields.
- [ ] Test concurrent updates: two PATCH calls with revision 1; one commits revision 2, the other gets 409 `LABEL_TEMPLATE_REVISION_CONFLICT`; failed update creates no successful audit fact. V2 PATCH without expected revision is rejected. Existing V1 writes retain old protocol.
- [ ] Implement typed storage dispatch and new DTO OpenAPI `oneOf`; remove unsafe V1 casts on V2 paths. New cabinet sends `x-label-template-formats: label-v1,pallet-sheet-v2` on reads; absent opt-in gets the old V1 list shape, direct V2 GET gets `LABEL_TEMPLATE_FORMAT_UNSUPPORTED`. Never grant station credentials cabinet CRUD access.
- [ ] Implement immutable format (conversion via copy), enabled/category/default constraints and tenant-scoped compare-and-swap revision update in a DB transaction with audit. Add global `defaultPalletSheetTemplateId` and category table `org_pallet_sheet_template_defaults`; reuse existing resolution precedence, but keep V1 and V2 separate.
- [ ] Run focused DB tests; `corepack pnpm --filter @markiro/db build`; API focused tests using an actual configured test DB. Verify create/list/get/PATCH/default/disable/delete and OpenAPI. Report environment skips explicitly.

### Task 4: Библиотека и JSON import/export в админке

**Files:** modify `apps/admin/src/pages/labels/api.ts`, `apps/admin/src/pages/labels/index.tsx`, `apps/admin/src/pages/labels/TemplateThumb.tsx`, `apps/admin/src/pages/labels/renderer.ts`, `apps/admin/src/pages/labels/preview-data.ts`, `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`, `apps/admin/src/pages/labels/editor/import-analysis.ts`, `apps/admin/src/pages/labels/editor/download.ts`, `apps/admin/src/i18n/{ru,en}.json`. Extend `apps/admin/test/labels-library.test.tsx`, `apps/admin/test/labels-import-analysis.test.ts`, `apps/admin/test/labels-editor.test.tsx`; create `apps/admin/test/pallet-sheet-json-ui.test.tsx`.

**Interfaces:** UI discriminated template DTO from Task 3; import consumes `parseStoredLabelJson`, export consumes `serializeStoredLabelJson`. Import preview is a draft until explicit apply/save. Copy/export carries content only; no source tenant ID, revision, current logo bytes or Windows queue.

- [ ] Write failing UI tests: format filter/badge, creation from three presets, blank sheet creation, copy, disable and default selection; V2 summary never reads `language`. Existing V1 library cards and actions stay functional.
- [ ] Test `.json` file upload and pasted JSON, cancel preserving original draft, structured path errors and unsupported-version rejection. A legacy JSON stays V1. V2 with purpose mismatch is blocked rather than reclassified with a warning.
- [ ] Implement import/export through the shared strict domain functions. Enable both formats in read requests; direct-open unsupported V2 handled clearly. Add revision conflict UI with reload/copy choices that preserve the user's unsaved draft.
- [ ] Prove round-trip in UI: edit a condition/logo/maxLines/copies, export, import as a new template, save and reload; assert equivalent spec and a new record ID. Disable RAW ZPL/TSPL downloads for V2 with clear Windows-sheet explanation, leaving legacy downloads unchanged.
- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/labels-library.test.tsx test/labels-import-analysis.test.ts test/pallet-sheet-json-ui.test.tsx`; then affected admin lint/typecheck/build after dependency builds.

### Task 5: Визуальный редактор и общий предпросмотр

**Files:** create `apps/admin/src/pages/labels/editor/sheet/SheetEditor.tsx`, `SheetNodeInspector.tsx`, `SheetCanvas.tsx`, `useSheetSpecState.ts`, `sheet-preview.ts`; modify `apps/admin/src/pages/labels/editor/index.tsx`, `PreviewPane.tsx`, `editor.css`; extend `apps/admin/src/labels/rasterizer.ts` only for shared resource decoding as needed. Add `apps/admin/test/pallet-sheet-editor.test.tsx`, `pallet-sheet-preview.test.ts`. Extend `tools/production-browser/product-labels-tests/template.spec.ts` and its harness; add a focused sheet browser spec if isolation is necessary.

**Interfaces:** `SheetEditor` consumes V2 draft and produces V2 spec change events; root editor selects V1/V2 by kind. `useSheetSpecState` owns selection/history/dirty state; import apply is one undoable action. `sheet-preview.ts` calls `renderPalletSheet` with the same mono resource and text adapters as Station.

- [ ] Write failing reducer/DOM tests for add/move/remove nodes; row/stack reordering; canvas positions; inspector text/field/style/condition edits; bounded logo height; page orientation/margins; linked A5 copies; undo/redo and unsaved-navigation protection.
- [ ] Implement a palette for all supported V2 nodes and pointer plus numeric/keyboard editing. Keep footer present and bottom-anchored; its GS1 dimensions/alignment editable, invalid values show element-specific errors. Canvas placement cannot invade footer or quiet zones. No visual-only settings omitted from JSON.
- [ ] Add selectable sample-data states: date absent, ЕГАИС absent/present, 5-line product, logo wide/absent, maximum counters. Preview exactly the same draft spec that will be saved; do not substitute one of the three presets based on orientation.
- [ ] Add browser round-trip and pixel/geometry parity for identical spec/context/font/geometry between admin and Station renderer harnesses. Include physical-paper scale in preview, fit-to-screen only as UI zoom, and explain that actual driver margins are applied on Station.
- [ ] Run focused reducer/DOM tests and Playwright template suite with real bundled fonts/canvas; inspect snapshots for all three layouts and stress cases. Save artifacts with `testInfo.outputPath`. Mock canvas success is not visual validation.

### Task 6: Выбор для смены, immutable версия и capability protocol

**Files:** create `packages/domain/src/labels/pallet-sheet-snapshot.ts`, export it from `packages/domain/src/index.ts`; modify `apps/api/src/modules/shifts/{dto,shifts.controller,shifts.service}.ts`; create `apps/api/src/modules/shifts/pallet-sheet-policy.ts`; modify `apps/admin/src/pages/shifts/{ShiftForm,ShiftDetailsPanel}.tsx`, `apps/admin/src/pages/shifts/api.ts`, `apps/admin/src/pages/settings/OrgProfilePage.tsx`. Modify `apps/station/src/lib/{api-client,mirror,shift-bundle}.ts`, `apps/station/src/pages/NewShift.tsx`, `packages/db/src/sqlite/{schema,migrations}.ts`. Add `apps/api/test/pallet-sheet-capabilities.e2e.test.ts`, `apps/station/test/pallet-sheet-mirror.test.ts`; extend `apps/api/test/shifts-bundle.e2e.test.ts`, `apps/station/test/{mirror,shift-bundle}.test.ts`, Android `feature/shift/ShiftRepositoryTest.kt` contract fixtures if needed.

**Interfaces:** capability `pallet-sheet-v2` in existing `x-station-capabilities`; separate optional shift `palletSheetTemplateId`; server snapshot `{id,name,revision,spec,digest}` captured atomically at selection. New bundle slot `palletSheetTemplate` exists only for compatible Station. Legacy `palletLabelTemplate` remains V1. `PalletSheetTemplateSnapshot` and its strict schema are exported from new `packages/domain/src/labels/pallet-sheet-snapshot.ts` via `packages/domain/src/index.ts`; API and Station use that exact contract.

- [ ] Test cabinet selection/default resolution by format/category; snapshot captures revision 1, later template revision 2 does not change shift bundle. Explicit shift reselection affects future preparation only and observes existing active-shift edit rules. Disable/delete template after selection does not make stored snapshot unreadable.
- [ ] Test capability matrix across list, picker, default, preview by ID, create/start/open/enter/bundle/recovery: new Windows Station, old Station, current handheld, spoofed handheld header, cabinet and old API. No legacy response contains V2 fields/spec where an old parser expects V1.
- [ ] Add direct-ID bypass tests and confirm denial occurs before SSCC allocation or work activation. If shift has V1 fallback, old clients continue normally; if only V2, old/handheld get an explicit unsupported-format admission error. Do not drop required label printing to admit the device.
- [ ] Implement server projection and capability checks using actual device kind plus advertised capability. New Station advertises only when native bridge supports A4. Keep old list/default response shapes; new requests explicitly choose format. Add nullable V2 snapshot/ID fields in PostgreSQL and SQLite with matching migration tests.
- [ ] On download, validate id/revision/digest/spec before atomically replacing the local sheet context. Reuse existing owner/close fencing. Test interrupted mirror write, late response after close/re-pairing, offline restart and old bundle without new slot.
- [ ] Run API admission/bundle tests, Station mirror/NewShift tests and legacy Android shift parser tests against projected old payloads. If Kotlin production types change, run the full scoped Android gates; do not claim parity from TypeScript alone.

### Task 7: Брендинг организации и офлайн-ресурсы

**Files:** create `apps/api/src/modules/org-profile/station-branding.controller.ts`, `apps/api/test/station-branding.e2e.test.ts`, `apps/station/src/lib/organization-branding.ts`, `apps/station/test/organization-branding.test.ts`; modify `apps/api/src/modules/org-profile/{dto,org-profile.service,org-profile.module}.ts`, `apps/station/src/lib/{use-sync-engine,config-transition}.ts`, SQLite schema/new migration. Add `packages/db/test/station-branding-migration.test.ts`; bundle canonical print logo under `apps/station/src/assets/` using `apps/admin/src/assets/markiro-logo-on-light.svg` as source.

**Interfaces:** `GET /station/branding` → name/revision/current logo route; tenant-scoped active WebP endpoint. `loadOrganizationBranding(owner): Promise<BrandingSnapshot|null>` and `refreshOrganizationBranding(owner): Promise<void>` reuse credential ownership tokens. Complete snapshot contains name, tenant, revision/null, bytes, dimensions and digest; rendering resolves the template's organization-logo binding from it.

- [ ] Test tenant/revision isolation, revoked credentials, cabinet/kiosk/handheld denial and subscription read policy. Do not grant Station cabinet CRUD or expose public storage URLs.
- [ ] Test no configured logo → bundled Маркиро; configured logo download fails → keep last complete same-tenant snapshot, not false absence; first preparation requires complete branding; delete logo; offline restart; owner changes while fetch is pending → late result discarded.
- [ ] Implement complete-cache upsert after successful validation, preserving private image/size bounds. Pooled SQLite needs single-statement upsert or a held transaction, not per-call BEGIN/COMMIT. Decode logo against white to a bounded mono raster; preserve natural aspect ratio and use the shared renderer's size policy.
- [ ] Admin preview uses cabinet logo endpoint, Station its own endpoint; both resolve absent logo to the same canonical bundled asset. Portable template JSON never contains resolved tenant branding, but print snapshots do.
- [ ] Run focused API/cache/migration/config-transition tests; rebuild DB before consumers and update route inventory/OpenAPI.

### Task 8: Windows А4 и фактическая печатная область

**Files:** modify `apps/station/src-tauri/src/{printer_windows,printer_windows_commands,printer_raster}.rs`, relevant command registration, `apps/station/src/lib/hardware.ts`, `tools/station-printer-tests/lib.rs`; extend `apps/station/test/windows-printing-flow.test.ts`.

**Interfaces:** optional `WindowsPageOptions={mode:'a4_sheet',orientation:'portrait'|'landscape'}`; absence preserves legacy path. `getWindowsPageGeometry(queue, options)` returns physical page, printable bounds, device DPI and geometry fingerprint. Preflight/send accept frozen page options/fingerprint; source raster stays 300 dpi. `PrinterProfile.paper?: 'a4'` marks Windows sheet capability; no layout/templateId lives in that profile.

- [ ] Add failing portable tests for portrait/landscape A4, 3–7 mm edges/asymmetric offsets, 300/600/1200 dpi, unsupported anisotropic/noninteger scaling, Letter substitution, changed driver fingerprint, bounds/overflow and legacy custom label behavior.
- [ ] Implement `DMPAPER_A4`, requested orientation, dmScale 100, dmCopies 1, simplex, preserving driver-private DEVMODE tail. Requery caps and report real geometry, not requested values.
- [ ] Convert print bounds to source coordinates conservatively plus 0.5 mm guard. Renderer chooses allowed A5 module preset before persistence; never crop/rotate/fit-to-page. Repeat native geometry validation before any StartDoc sending boundary.
- [ ] Draw full-page raster with correct printable-origin offsets and exact integer replication without interpolation. Bound GDI allocations/dimensions separately from the unchanged 2 MiB source limit.
- [ ] Run `cargo test --manifest-path tools/station-printer-tests/Cargo.toml`, `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`, then required Windows compilation/runtime gate. Host Cargo does not prove Windows behavior.

### Task 9: Station UI, журнал и безопасная повторная печать

**Files:** create `apps/station/src/lib/pallet-sheet-printing.ts`, `apps/station/test/pallet-sheet-printing.test.ts`, `pallet-sheet-settings.test.tsx`; modify `apps/station/src/lib/{printer-routing,print-destinations,print-deliveries,box-printing,print-artifact}.ts`, `apps/station/src/pages/{WorkstationSetup,NewShift,WorkScreen}.tsx`, `apps/station/src/ui/setup/{PrinterSetupPanel,PrinterRoutingPanel}.tsx`, `apps/station/src/i18n/{ru,en}.json`, SQLite schema/new migration. Extend routing/delivery/pallet UI tests and `tools/production-browser/station-inventory-tests/station-setup.spec.ts`.

**Interfaces:** `preparePalletSheet` consumes bound Windows A4 profile, `PalletSheetTemplateSnapshot`, immutable business facts, complete branding and actual geometry; returns `{bytes,renderSnapshot}`. New `PalletSheetPrintSnapshotV1` stores full template spec/revision/digest, renderer version, facts, mono logo/provenance and effective geometry. Nullable `printer_deliveries.render_snapshot_json` is inserted atomically with artifact bytes/digest. Legacy null remains supported.

- [ ] Test explicit selection of template and transport, compatible routing, selected sheet preview and no hardcoded layout override. Sheet mode requires a downloaded V2 snapshot; missing template error cannot be bypassed by silently choosing a built-in preset. Ordinary mode keeps V1 validation.
- [ ] Test bind → prepare → persist → sending → transport crash points. No send without matching durable bytes/snapshot; first-writer-wins binding remains. Item count read failure rejects preparation rather than becoming zero. Two copies create no extra production fact/outbox/SSCC.
- [ ] Test template edited/deleted, logo changed, app upgraded and driver changed after preparation: unknown delivery preserves exact bytes/page options, explicit failed-before-send new attempt retains prior history, resolved job after byte tombstone regenerates its saved renderer/spec/resources or reports unsupported snapshot version. Never fetch current templateId to reconstruct historical output.
- [ ] Implement versioned snapshot parsing and atomic prepared persistence. Keep unresolved artifacts/resources pinned in retention; clear current owner cache via existing drain/fencing, not historical pending facts. Update migration/runtime tests together.
- [ ] Implement operator-facing messages for missing compatible sheet template, API/client mismatch, branding loading/error, geometry mismatch and unknown delivery. Updating printer settings cannot retroactively change a pending job's layout. RAW profiles cannot route sheet jobs; box/product duplicates remain on their existing paths.
- [ ] Run Station focused journal/mirror/pallet/UI tests; actual browser checks for template choice, effective preview, old API, offline restart and five-line/ЕГАИС/logo cases. Preserve the distinction between sent and physically verified.

### Task 10: Сквозная проверка, документация и выпуск

**Files:** add `docs/acceptance/validation-pallet-a4-printing.md` and `docs/labels/pallet-sheet-json-v2.md` with exported valid examples; update `docs/architecture.md`, public OpenAPI and Station/admin user docs. Inspect `tools/ci/affected.mjs`, `.github/workflows/ci.yml` and production-browser fixtures for all new routes/consumer jobs.

- [ ] Execute acceptance chain: preset → edit visual layout → export JSON → import as new template → save → assign shift → sync → offline preview/prepare → simulated Windows send → modify template → replay prior attempt. Assert exact spec/digest and no leaked tenant resources in exported JSON.
- [ ] Build shared dependencies (`corepack pnpm turbo run build --filter='@markiro/station^...'` and affected admin/API dependencies). Run test/typecheck/lint/build for domain, DB, API, admin and Station, with real test DB for migration/tenant/CAS tests. Verify OpenAPI and subscription route inventory.
- [ ] Run native portable and Windows gates, production-browser template and Station suites, legacy handheld contract tests; run `git diff --check` and `corepack pnpm format:check`. If any gate cannot run, record the exact missing environment and covered/uncovered surface.
- [ ] Physical Windows acceptance on normal laser/inkjet queues: all three templates, real margins and DPI, ruler measurements, scan SSCC in portrait/landscape and both cut halves, 4:1/10:1 logos, missing dates, full ЕГАИС. Test paper-out, unavailable queue and restart around send. Record model/driver/source SHA/template revision and outcome separately from CI.
- [ ] After implementation/review and separate release authorization: migrate/deploy compatible API plus admin, then Station beta; old clients continue on projected V1 responses. Verify actual affected paths before selecting full/API-only deploy. No new ТСД release unless Kotlin production behavior must change. Stable requires accepted beta and physical print evidence.
- [ ] Do not roll API back to a build that cannot read V2 DB rows while V2 is enabled. A feature-disable path stops new V2 selection without deleting saved snapshots or breaking recovery; test the rollout/rollback order before release.

## Self-review

- All requested actions are represented: create/copy/edit, JSON import/export, three editable presets, common preview, assignment/defaults and Windows print/reprint.
- Template identity/layout resides in server spec and shift snapshot, not printer profile. Preset enums no longer determine renderer behavior.
- V1 parser remains separate; strict V2 can't be silently stripped. Header/query agreement covers library reads and all device admission paths, including direct-ID access and handheld spoofing.
- Historical jobs retain spec/revision/renderer/resources; revision conflict handling protects concurrent admin edits. Defaults and seed migration do not overwrite user choices.
- Five-line/conditional-field/wide-logo browser cases and hardware acceptance remain explicit. Two A5 copies are linked content and one print job, not two independent templates.
- При подготовке исходного плана менялись только документы; последующая реализация и фактические результаты проверок отражены в документе приёмки.
