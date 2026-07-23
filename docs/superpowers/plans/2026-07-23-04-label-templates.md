# Plan 04: Label Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the label-template subsystem: a pure domain model with ZPL/TSPL generation and Cyrillic-rasterization primitives (ported with parity from the Idento reference), tenant-scoped template CRUD, product/shift template binding, and the admin WYSIWYG editor with library, preview and font-coverage warning — per design brief 03 §4 and the accepted handoff's admin prototype (Этикетки screen).

**Architecture:** Generation is CLIENT-side only (admin webview now, station webview in Plan 05) — the server never rasterizes (no canvas) and only stores/validates templates. `@markiro/domain` gains pure, DOM-free primitives (template zod model, mm↔dots, ZPL/TSPL emitters, monochrome+hex packing with an injectable `RasterizeTextFn`); the browser-only canvas rasterizer and opentype.js font-coverage check live in `apps/admin`. Reference implementation for parity: `/Users/thevladbog/PRSOME/idento/panel/src/features/badge/zpl/*` (zplImage, generateZpl, canvasRasterizer, fontCoverage) — port concepts and exact raster math, adapt naming to Markiro conventions.

**Tech Stack additions:** opentype.js@2.0.0 (admin devDep? runtime dep — font parsing in browser). No other new deps: barcodes in the EDITOR PREVIEW are schematic placeholders (bars/matrix pattern per the handoff prototype); true barcode output is the printer's job (ZPL/TSPL commands) and gets hardware-verified in Plan 05.

## Global Constraints

- All Plan 03 conventions hold: tenant scoping in the statement, zod pipe, handleWriteError (23505→409, 23503→400/409 per semantics), i18n RU/EN lockstep, no new deps beyond opentype.js@2.0.0, quarantine exclusions = BLOCKED, conventional commits, TDD, e2e EXECUTED with env (DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173). Never docker compose down.
- `packages/domain` stays zero-dependency and DOM-free — anything needing canvas/fonts lives in apps/admin.
- Raster parity with Idento: grayscale 0.299R+0.587G+0.114B, threshold >127 = white, no dithering; ^GFA uncompressed, 8px/byte MSB-first, uppercase hex. TSPL `BITMAP` mode 0 — VERIFY bit polarity against the TSPL manual (TSPL prints where bit = 0; confirm and pin with a golden test + comment; if reality differs from this note, follow reality and document).
- Dots math: `dots = round(mm * dpi / 25.4)`; supported dpi: 203, 300.
- Label sizes (presets): 58×40, 100×100, 100×150 mm + custom; portrait/landscape via width/height swap (no rotation field in MVP).

---

### Task 1: Domain — template model & units

**Files:** Create `packages/domain/src/labels/model.ts`; extend `src/index.ts`. Test `packages/domain/test/labels-model.test.ts`.

**Interfaces (produces):**

- zod schemas + inferred types: `LabelTemplateSpec { widthMm, heightMm (10..300), dpi (203|300), language ("zpl"|"tspl"), elements: LabelElement[] }`.
- `LabelElement` union (all with `id: string`, `xMm`, `yMm`):
  - `{ kind: "text", text, fontSizePt (4..72), bold?, align? ("left"|"center"|"right"), maxWidthMm? }`
  - `{ kind: "field", field: LabelField, fontSizePt, bold?, align?, maxWidthMm? }` where `LabelField = "product.name"|"product.gtin"|"km.code"|"sscc"|"shift.no"|"date"|"qty"|"operator"|"counterparty.name"`
  - `{ kind: "barcode", format: "datamatrix"|"code128"|"ean13"|"qr", data: LabelField | { literal: string }, sizeMm }` (for code128/ean13 `sizeMm` = height, width auto; for matrix codes = module square side)
  - `{ kind: "line", x2Mm, y2Mm, thicknessMm }`, `{ kind: "box", widthMm, heightMm, thicknessMm }`
- `mmToDots(mm, dpi)`, `ptToDots(pt, dpi)` (1pt = 1/72"), `parseLabelTemplate(json: unknown): LabelTemplateSpec` (zod parse → DomainError("LABEL_INVALID") on failure).
- `sampleLabelData(): Record<LabelField, string>` — deterministic sample values for previews/goldens (e.g. sscc `"346006820000000014"`, gtin `"04600682000013"`).

TDD: schema accepts a full valid spec; rejects out-of-range dpi/size; mm/pt math vectors (58mm@203 → 463 dots; 12pt@203 → 34 dots — verify by hand); element out of label bounds is ALLOWED by schema (editor concern, not model).

Commit: `feat(domain): label template model and unit math`.

---

### Task 2: Domain — ZPL emitter

**Files:** Create `packages/domain/src/labels/zpl.ts`; barrel. Test `packages/domain/test/labels-zpl.test.ts`.

**Interfaces:**

- `generateZpl(spec, data: Record<LabelField,string>, deps: { rasterizeText?: RasterizeTextFn }): Promise<string>` — full `^XA ^PW ^LL ... ^XZ` document.
- Native path (latin-only text): `^FO<x>,<y> ^A0N,<h>,<w> ^FD...^FS` (escape `^`,`~` in data via `^FH` hex or char substitution — document choice); `^FB` for align/maxWidth.
- Barcodes: code128 `^BCN,<h>,N,N,N` (+`^FD`), ean13 `^BEN,<h>` , datamatrix `^BXN,<module>,200`, qr `^BQN,2,<mag>`; KM data (field km.code) in datamatrix must carry FNC1: use `^FD_1...` convention with `^FH_` — VERIFY exact ZPL FNC1 escape against Zebra docs and pin in a golden.
- Shapes: `^GB<w>,<h>,<t>`.
- Text needing rasterization (`needsImageRendering(text)` — any char outside latin-1 printable): requires `deps.rasterizeText`; emits `^FO + buildGfaCommand(raster)`. Without the dep → DomainError("RASTER_REQUIRED").
- `needsImageRendering(text: string): boolean` exported.

TDD: golden full-document tests with sampleLabelData (latin-only spec → exact ZPL string); cyrillic text without rasterizer → RASTER_REQUIRED; with a FAKE rasterizer (returns fixed 16×8 checkerboard RasterResult) → golden containing the expected `^GFA` payload (hand-compute the checkerboard hex once).

Commit: `feat(domain): ZPL document generation with raster fallback`.

---

### Task 3: Domain — TSPL emitter

**Files:** Create `packages/domain/src/labels/tspl.ts`; barrel. Test `packages/domain/test/labels-tspl.test.ts`.

Same contract as Task 2: `generateTspl(spec, data, deps)`. Document: `SIZE <w> mm, <h> mm`, `GAP 2 mm, 0 mm`, `DIRECTION 1`, `CLS`, elements, `PRINT 1`. Text native: `TEXT x,y,"0",0,<xmul>,<ymul>,"..."` (font "0" scalable; escape `"` by doubling). Barcodes: `BARCODE x,y,"128",h,1,0,2,2,"..."`, `"EAN13"`, `DMATRIX x,y,w,h,"..."`, `QRCODE`. Shapes: `BAR`, `BOX`. Raster: `BITMAP x,y,widthBytes,height,0,<binary-as-hex-or-bytes>` — polarity per Global Constraints (verify+pin). Goldens as in Task 2.

Commit: `feat(domain): TSPL document generation with raster fallback`.

---

### Task 4: Domain — raster primitives (Idento-parity port)

**Files:** Create `packages/domain/src/labels/raster.ts`; barrel. Test `packages/domain/test/labels-raster.test.ts`.

**Interfaces:**

- `interface RasterResult { hex: string; totalBytes: number; bytesPerRow: number; width: number; height: number }`
- `type RasterizeTextFn = (text: string, opts: { fontFamily: string; fontSizePx: number; bold: boolean }) => Promise<RasterResult>`
- `convertToMonochrome(rgba: Uint8ClampedArray, width, height): Uint8Array` — port EXACTLY from idento `zplImage.ts` (grayscale coefficients, threshold semantics 1=black).
- `bitmapToZplHex(mono: Uint8Array, width, height): { hex, totalBytes, bytesPerRow }` — 8px/byte MSB-first uppercase, byte-padded rows.
- `buildGfaCommand(r: RasterResult): string` — `^GFA,<totalBytes>,<totalBytes>,<bytesPerRow>,<hex>`.
- `bitmapToTsplBytes(mono, width, height): { hexBytes, widthBytes }` — TSPL polarity applied here (single source of truth).

TDD: hand-computed vectors — 8×2 all-black → ZPL hex "FFFF" (2 bytes, 1/row); 10×1 all-black → "FFC0" (padding bits white/0? NB: padding bits must be 0 in ZPL=white; verify idento parity) ; checkerboard 8×2 → "AA55"; monochrome conversion: pure red (255,0,0) → gray 76.245 → ≤127 → black=1; TSPL polarity inversion vector.

Commit: `feat(domain): raster primitives with Idento parity`.

---

### Task 5: Admin — canvas rasterizer & font coverage

**Files:** Create `apps/admin/src/labels/{rasterizer.ts,fontCoverage.ts}`. Test `apps/admin/test/labels-raster.test.ts` (coverage logic only — jsdom has no canvas: the rasterizer throws a typed `RasterUnavailableError` there, per Idento's pattern; pin THAT).

- `rasterizeText: RasterizeTextFn` — canvas 2D: `ctx.font = "${bold?700:400} ${sizePx}px ${family}"`, measureText width, height = ceil(sizePx*1.5), white bg, black fillText baseline middle, getImageData → domain convertToMonochrome/bitmapToZplHex. jsdom → RasterUnavailableError.
- `checkCyrillicCoverage(fontBytes: ArrayBuffer): boolean` via opentype.js@2.0.0 — sample "АЯЁЖЩыёя" (Idento's set): every char must resolve to a real glyph (index > 0). For MVP the editor offers the two bundled families (IBM Plex Sans / IBM Plex Mono via @fontsource — both cover Cyrillic); coverage check runs anyway and drives the warning Alert so future custom fonts are safe. Load font bytes for the check from the fontsource package files via Vite `?url` import + fetch — document.
- Add dep to apps/admin: opentype.js@2.0.0 (runtime).

Commit: `feat(admin): browser text rasterizer and Cyrillic font coverage check`.

---

### Task 6: DB + API — label templates CRUD

**Files:** `packages/db/src/schema/labels.ts` (+barrel+drizzle config list), migration; `apps/api/src/modules/label-templates/{module,controller,service,dto}.ts`; test `apps/api/test/label-templates.e2e.test.ts`.

- Table `label_templates`: id uuid pk, tenantId (NOT NULL → organization, + UNIQUE(tenant_id,id) per convention), name text, spec jsonb NOT NULL, createdAt, updatedAt.
- CRUD: GET list `{items: {id,name,widthMm,heightMm,dpi,language,updatedAt}[]}` (summary projected from spec), GET /:id (full spec), POST {name, spec} — spec validated with domain `parseLabelTemplate` inside the zod pipe (LABEL_INVALID → 400 with issues), PATCH /:id {name?, spec?}, DELETE 204 (409 when referenced by products/shifts — after Task 7 FKs).
- e2e: CRUD + invalid spec 400 + tenant isolation + (after T7 lands, extended there) referenced-delete.

Commit: `feat(api): label templates CRUD with domain-validated specs`.

---

### Task 7: DB + API — template binding to products & shifts

**Files:** migration (products.default_label_template_id, shifts.label_template_id — composite FKs `(tenant_id, X) REFERENCES label_templates (tenant_id, id)` per convention); dto/service updates in products + shifts modules; e2e extensions.

- Product: optional defaultLabelTemplateId (PATCH/POST; FK 23503 → 400 like counterparty).
- Shift create: labelTemplateId optional — prefill from product default when omitted (undefined), explicit null = none; include labelTemplateId + labelTemplateName in Shift DTO/joins.
- Shifts in "aggregation" mode with NO effective template: ALLOWED in this plan (station will fall back / Plan 05 decides UX), but the list DTO exposes it so admin can badge it.
- e2e: prefill semantics (mirror counterparty tests), referenced-delete 409 on label_templates.

Commit: `feat(api): bind label templates to products and shifts`.

---

### Task 8: Admin — template library screen

**Files:** `apps/admin/src/pages/labels/{index.tsx,api.ts}`; route+sidebar item «Этикетки» (i18n both); test `apps/admin/test/labels-library.test.tsx`.

Per handoff admin prototype: grid of cards — thumbnail preview (client-rendered mini-canvas of the spec via the Task 9 renderer at small scale — reuse; until T9 merges, a placeholder box with size/DPI text is acceptable ONLY if T9 lands later in your execution order; ideally implement after T9 — execution order note: do T9 before T8 if convenient, or wire the real thumbnail in T10's polish), name, size/DPI/language badges, «+ Новый шаблон» card → editor route. List/loading/error/empty states per Plan 03 pattern.

Commit: `feat(admin): label template library`.

---

### Task 9: Admin — editor canvas core

**Files:** `apps/admin/src/pages/labels/editor/{LabelCanvas.tsx,renderer.ts,useEditorState.ts}`; route `/labels/:id` + `/labels/new`; test `apps/admin/test/labels-canvas.test.tsx`.

- `renderer.ts`: pure(ish) draw of a LabelTemplateSpec onto a canvas 2D at a given scale with sample data — text/fields (real canvas text), barcodes as SCHEMATIC placeholders (code128/ean13: bar stripes + caption; datamatrix/qr: deterministic module pattern + quiet zone), lines/boxes. Shared by editor, preview and library thumbnails.
- `LabelCanvas`: renders spec, hit-testing for select (topmost), drag to move (grid snap 1mm), selected element outline + label. Keyboard: arrows nudge 1mm (shift=5mm), Delete removes.
- `useEditorState`: spec + selectedId + history (undo/redo, cap 50) — plain reducer, fully unit-testable (test the reducer, not canvas pixels: move/select/delete/undo actions).

Commit: `feat(admin): label editor canvas with selection and drag`.

---

### Task 10: Admin — editor chrome: palette, properties, preview, save

**Files:** `apps/admin/src/pages/labels/editor/{index.tsx,Palette.tsx,PropertiesPanel.tsx,PreviewPane.tsx}`; i18n; test `apps/admin/test/labels-editor.test.tsx`.

- Palette per handoff (Текст, Поле, DataMatrix, Code128, EAN-13, QR, Линия, Рамка) — click adds element at center with sane defaults.
- PropertiesPanel: numeric X/Y/size inputs (mm), text/font-size/bold/align, field select (LabelField options with i18n labels), barcode data source (field vs literal), label-level: name, size preset + custom, dpi, language ZPL/TSPL.
- PreviewPane («предпросмотр = печать»): renders via renderer with sample data; when any text/field sample value `needsImageRendering` → run REAL rasterizer path and composite the returned bitmap into the preview (this is the what-you-see-is-what-prints guarantee) + coverage warning Alert when checkCyrillicCoverage fails for the chosen family (per design: «В выбранном шрифте нет кириллицы — текст напечатается растром. Возможна потеря чёткости.» — reword per current dictionaries, both languages).
- «Скачать ZPL/TSPL» button: client-side generateZpl/generateTspl with sample data + real rasterizer → Blob download `.zpl`/`.tspl`. (Test print via hardware lands in Plan 05.)
- Save/create via Task 6 API; dirty-guard on navigation (confirm modal).
- Tests: reducer-level + palette adds element + properties round-trip to spec + download button produces a blob whose text contains ^XA (mock rasterizer via injected dep — design the generate call site to accept the rasterizer, defaulting to the real one).

Commit: `feat(admin): label editor chrome with live preview and export`.

---

### Task 11: Wiring, i18n sweep, docs

**Files:** ProductForm (default template select), ShiftForm (template override select with prefill display like counterparty), README (labels section), roadmap mark, ledger notes.

- Product/Shift forms: selects fed by templates list; payload semantics identical to counterparty pattern (undefined=prefill/keep, null=clear).
- Full verification: format + turbo (all suites executed with env, state totals); browser smoke of the editor happy path (create template → add text+datamatrix → preview shows rasterized cyrillic → save → appears in library → set as product default → shift prefills it) — controller may take this on.
- Commit: `feat(admin): template selection in product and shift forms; docs`.

---

## Self-review notes

- Scope cuts (explicit): no test-print (Plan 05 hardware), no custom font upload (post-MVP; coverage check ships ready for it), no image/logo element (design lists it — deferred to Plan 05/06 when station bundling is settled; add to ledger), barcodes schematic in preview.
- Execution-order freedom: T8 may follow T9 to reuse the real thumbnail renderer.
- Parity anchors: idento zplImage.ts (raster math), canvasRasterizer.ts (canvas text), fontCoverage.ts (opentype sample set), generateZpl.ts (raster-branch structure). TSPL is new ground — polarity verify pinned in Global Constraints.
