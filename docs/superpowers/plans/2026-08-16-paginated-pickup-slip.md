# Paginated Pickup Slip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, numbered A4 pickup slip with repeated page furniture, organization branding, corrected price/signature copy, and a per-kiosk employee-QR print setting.

**Architecture:** Keep the existing `GET /pickup-orders/:id/slip` static-HTML boundary. Extend the kiosk row with one default-off setting, feed the setting and organization logo into `PickupSlipData`, and render an explicit array of fixed-size A4 sections so the server knows `N` and `M` before returning HTML.

**Tech Stack:** TypeScript 6, NestJS 11, Drizzle/Postgres migrations, React 19, React Hook Form/Zod, Vitest/Testing Library, static HTML/CSS print layout.

**Spec:** `docs/superpowers/specs/2026-08-16-pickup-slip-paginated-document-design.md`

## Global Constraints

- Each printed section is exactly A4 and owns its repeated header and footer.
- Page numbering is literal `стр. N из M`, computed by the server; do not depend on CSS `counter(pages)`.
- Product names occupy at most two printed lines and item rows are never split.
- `organization.logo` is used only when it is a safe HTTP(S) or `data:image/` source; otherwise render the built-in Markiro SVG.
- Price values contain no ruble symbol; `₽` appears only in the price column heading.
- The exact price disclaimer is `Цена является информационной. Окончательная цена будет указана в чеке.`
- `printEmployeeQrOnSlip` defaults to `false` and prints the employee QR block only when enabled and an active badge exists.
- Do not modify or stage unrelated changes from the original checkout.

---

### Task 1: Persist and expose the kiosk print setting

**Files:**

- Modify: `packages/db/src/schema/pickup.ts`
- Create: `packages/db/migrations/0035_kiosk_slip_qr_setting.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/migrations/meta/0035_snapshot.json`
- Modify: `packages/db/test/pickup-schema.test.ts`
- Create: `packages/db/test/kiosk-slip-setting-migration.test.ts`
- Modify: `apps/api/src/modules/kiosks/dto.ts`
- Modify: `apps/api/src/modules/kiosks/kiosks.service.ts`
- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/device-pairing/secret-response.openapi.ts`
- Modify: `apps/api/test/kiosks.e2e.test.ts`
- Modify: `apps/api/test/kiosk-orders.e2e.test.ts`
- Modify: `apps/api/test/openapi-docs.test.ts`

**Interfaces:**

- Produces: `schema.kiosks.printEmployeeQrOnSlip: boolean`, DB column `print_employee_qr_on_slip boolean not null default false`.
- Produces: `CreateKioskDto`, `UpdateKioskDto`, and `KioskDto` field `printEmployeeQrOnSlip`.
- Produces: `KioskBootstrapDto.config.printEmployeeQrOnSlip: boolean`.

- [ ] **Step 1: Write failing schema and API contract tests**

Add a database assertion after inserting a kiosk without the field:

```ts
const [savedKiosk] = await db
  .select({ printEmployeeQrOnSlip: schema.kiosks.printEmployeeQrOnSlip })
  .from(schema.kiosks)
  .where(eq(schema.kiosks.id, kioskId));
expect(savedKiosk?.printEmployeeQrOnSlip).toBe(false);
```

Add a non-database migration test that locates journal tag
`0035_kiosk_slip_qr_setting`, reads its SQL file, and expects the exact column
definition `"print_employee_qr_on_slip" boolean DEFAULT false NOT NULL`.

Extend the kiosk update e2e test to PATCH `{ printEmployeeQrOnSlip: true }` and expect the returned DTO to contain `true`. Extend bootstrap/OpenAPI expectations with the same field.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node_modules/.bin/vitest run test/pickup-schema.test.ts test/kiosk-slip-setting-migration.test.ts
node_modules/.bin/vitest run test/kiosks.e2e.test.ts test/kiosk-orders.e2e.test.ts test/openapi-docs.test.ts
```

Run the first command from `packages/db` and the second from `apps/api`.
Expected: TypeScript/Vitest failures because `printEmployeeQrOnSlip` is absent from the schema and DTOs.

- [ ] **Step 3: Add the schema field and generate the migration**

Add beside `showPrices`:

```ts
printEmployeeQrOnSlip: boolean("print_employee_qr_on_slip").notNull().default(false),
```

Run `node_modules/.bin/drizzle-kit generate --name kiosk_slip_qr_setting` from
`packages/db`, inspect the generated SQL, and require exactly:

```sql
ALTER TABLE "kiosks" ADD COLUMN "print_employee_qr_on_slip" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 4: Thread the field through API write/read/bootstrap contracts**

Add default `false` to `createKioskSchema`, optional boolean to `updateKioskSchema`, and required boolean to `KioskDto`. Persist it in `createKiosk`, copy it into PATCH `set`, and return it from `toDto`.

Extend bootstrap to select and return:

```ts
config: {
  dayLimitPerEmployee: kiosk?.dayLimitPerEmployee ?? 0,
  showPrices: kiosk?.showPrices ?? true,
  printEmployeeQrOnSlip: kiosk?.printEmployeeQrOnSlip ?? false,
}
```

Update the handwritten pairing OpenAPI response schema and exact-field test.

- [ ] **Step 5: Build DB and verify GREEN**

Run:

```bash
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/vitest run test/pickup-schema.test.ts test/kiosk-slip-setting-migration.test.ts
node_modules/.bin/vitest run test/kiosks.e2e.test.ts test/kiosk-orders.e2e.test.ts test/openapi-docs.test.ts
```

Run the first two commands from `packages/db` and the third from `apps/api`.
Database-backed tests may skip without `DATABASE_URL`; report skips explicitly.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/pickup.ts packages/db/migrations/0035_kiosk_slip_qr_setting.sql packages/db/migrations/meta/_journal.json packages/db/migrations/meta/0035_snapshot.json packages/db/test/pickup-schema.test.ts packages/db/test/kiosk-slip-setting-migration.test.ts apps/api/src/modules/kiosks/dto.ts apps/api/src/modules/kiosks/kiosks.service.ts apps/api/src/modules/pickup-orders/dto.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/src/modules/device-pairing/secret-response.openapi.ts apps/api/test/kiosks.e2e.test.ts apps/api/test/kiosk-orders.e2e.test.ts apps/api/test/openapi-docs.test.ts
git commit -m "feat(kiosk): configure employee QR on slips"
```

### Task 2: Add the print setting to the admin kiosk form

**Files:**

- Modify: `apps/admin/src/pages/kiosks/api.ts`
- Modify: `apps/admin/src/pages/kiosks/KioskProfileForm.tsx`
- Modify: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/kiosks-routing.test.tsx`
- Update fixture DTOs in other failing admin tests only where strict typing requires the new required response field.

**Interfaces:**

- Consumes: `KioskDto.printEmployeeQrOnSlip` from Task 1.
- Produces: form value and create/update payload field `printEmployeeQrOnSlip: boolean`.

- [ ] **Step 1: Write the failing form behavior test**

Update the kiosk fixture with `printEmployeeQrOnSlip: false`. In the edit test, click the Russian checkbox label `Печатать QR-код сотрудника в ведомости` and assert the exact PATCH body includes:

```ts
printEmployeeQrOnSlip: true,
```

Also assert the create request sends the default `false`.

- [ ] **Step 2: Run the focused admin test and verify RED**

Run:

```bash
node_modules/.bin/vitest run test/kiosks-routing.test.tsx
```

Run from `apps/admin`.
Expected: FAIL because the checkbox does not exist and payloads omit the field.

- [ ] **Step 3: Implement the field in types, form, route values, and translations**

Add `printEmployeeQrOnSlip` to admin `KioskDto`, `CreateKioskInput`, and `UpdateKioskInput`. Add it to the Zod form, `EMPTY_VALUES`, `toKioskInput`, and edit `initialValues`. Render a second controlled checkbox with:

```tsx
<Checkbox
  label={t("pages.kiosks.form.printEmployeeQrOnSlipLabel")}
  checked={field.value}
  onCheckedChange={field.onChange}
/>
```

Use Russian copy `Печатать QR-код сотрудника в ведомости` and English copy `Print employee QR code on pickup slip`.

- [ ] **Step 4: Verify GREEN and admin typecheck**

Run:

```bash
node_modules/.bin/vitest run test/kiosks-routing.test.tsx
node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Run from `apps/admin`.
Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/kiosks/api.ts apps/admin/src/pages/kiosks/KioskProfileForm.tsx apps/admin/src/pages/kiosks/KioskPanelRoute.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test
git commit -m "feat(admin): configure kiosk slip QR block"
```

### Task 3: Enrich slip data with branding and the print decision

**Files:**

- Modify: `apps/api/src/pickup/slip.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/test/pickup-slip.e2e.test.ts`
- Modify: `apps/api/test/slip.test.ts`

**Interfaces:**

- Consumes: `schema.organization.logo` and `schema.kiosks.printEmployeeQrOnSlip`.
- Produces: `PickupSlipData.org: { name: string; inn: string | null; logo: string | null } | null`.
- Produces: `PickupSlipData.printEmployeeQrOnSlip: boolean`.

- [ ] **Step 1: Write failing data-contract tests**

Extend the unit fixture with `logo: null` and `printEmployeeQrOnSlip: false`. Add assertions that the default fixture contains no employee lookup copy and that enabling the flag produces one QR plus the lookup copy.

Extend the e2e setup to set `organization.logo` to `https://assets.example.test/org-logo.svg` and the kiosk flag to true, then assert the slip HTML contains the escaped URL and employee QR copy.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node_modules/.bin/vitest run test/slip.test.ts test/pickup-slip.e2e.test.ts
```

Run from `apps/api`.
Expected: unit compile/assertion failures because the new fields and conditional behavior do not exist; e2e may skip without DB environment.

- [ ] **Step 3: Populate the new fields in `slipData`**

Include `kioskPrintEmployeeQrOnSlip` in the order query and `logo` in the organization query, then return:

```ts
org: org ? { name: org.name, inn: org.inn, logo: org.logo } : null,
printEmployeeQrOnSlip: row.kioskPrintEmployeeQrOnSlip ?? false,
```

Keep all joins and lookups tenant-scoped as they are today.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node_modules/.bin/vitest run test/slip.test.ts test/pickup-slip.e2e.test.ts
```

Run from `apps/api`.
Expected: unit tests pass; report whether DB e2e ran or skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pickup/slip.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-slip.e2e.test.ts apps/api/test/slip.test.ts
git commit -m "feat(api): provide pickup slip branding settings"
```

### Task 4: Render a numbered explicit-page A4 document

**Files:**

- Modify: `packages/domain/src/barcodes/svg.ts`
- Modify: `packages/domain/test/barcodes.test.ts`
- Modify: `apps/api/src/pickup/slip.ts`
- Modify: `apps/api/test/slip.test.ts`

**Interfaces:**

- Produces: unchanged public function `renderPickupSlipHtml(data: PickupSlipData): string`.
- Produces: backward-compatible `renderCode128Svg(text: string, options?: { includeText?: boolean }): string`; omitted option preserves the current human-readable caption.
- Internal helper: `paginatePickupSlipItems(items: PickupSlipItem[]): PickupSlipItem[][]`, with regular-page capacity 10 and final-page capacity 8, validated against the rendered A4 geometry.

- [ ] **Step 1: Write failing pagination and content tests**

Build 17 literal item fixtures and assert the rendered HTML has two `data-slip-page` sections and exactly these footer labels:

```ts
expect(pageLabels).toEqual(["стр. 1 из 2", "стр. 2 из 2"]);
```

Add behavior assertions for:

```ts
expect(html).toContain("Цена является информационной. Окончательная цена будет указана в чеке.");
expect(html).not.toMatch(/(?:52\.00|74\.00)\s*₽/);
expect(html).not.toContain("Платформа маркировки «Честный ЗНАК»");
expect(html).not.toMatch(/<text[^>]*>[^<]*ORD-26-0042/);
```

In the domain test, assert the default Code128 SVG contains the escaped order
text while `{ includeText: false }` contains no `<text` element. Assert the slip
title contains a dedicated element for the order number, the employee name
follows the signature-line element, and every page repeats the order
Code128/footer.

- [ ] **Step 2: Run unit tests and verify RED**

Run:

```bash
node_modules/.bin/vitest run test/barcodes.test.ts
node_modules/.bin/vitest run test/slip.test.ts
```

Run the first command from `packages/domain` and the second from `apps/api`.
Expected: FAIL on missing explicit pages, numbering, copy, and corrected price rendering.

- [ ] **Step 3: Implement deterministic pagination**

Compute total page count so every non-final page contains at most 10 rows and the final page at most 8 rows. Balance rows across the known page count to avoid a one-row first page while preserving both capacity limits. Return `[[]]` for an empty item list.

Render each page as:

```html
<section class="slip-page" data-slip-page="N">
  <header class="slip-header">…</header>
  <main class="slip-content">…fixed-row table…final blocks when last…</main>
  <footer class="slip-footer">…Code128…<span>стр. N из M</span></footer>
</section>
```

Use `@page { size: A4; margin: 0 }`, `.slip-page { width: 210mm; height: 297mm; break-after: page; overflow: hidden; }`, and remove the break after the last page. Clamp names to two lines and mark item/final blocks `break-inside: avoid`.

- [ ] **Step 4: Implement branding and corrected document copy**

Extend `renderCode128Svg` with the optional `includeText` flag and pass
`includeText: false` for the slip footer only. Use a `safeLogoSrc` helper
allowing only `https:`, `http:`, or `data:image/`; unsafe/empty values render an
inline Markiro SVG. Put the order number on its own title line, remove the
platform tagline, remove ruble symbols from `money()`, place employee FIO below
the signature line, and render the QR block only when both inputs allow it.

- [ ] **Step 5: Run unit tests and verify GREEN**

Run:

```bash
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/vitest run test/barcodes.test.ts
node_modules/.bin/vitest run test/slip.test.ts
```

Run the first two commands from `packages/domain`, then the third from
`apps/api` after rebuilding domain.
Expected: all slip unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/barcodes/svg.ts packages/domain/test/barcodes.test.ts apps/api/src/pickup/slip.ts apps/api/test/slip.test.ts
git commit -m "feat(api): render paginated pickup slips"
```

### Task 5: Verify packages and rendered PDF behavior

**Files:**

- Modify only files required to fix failures caused by Tasks 1–4.

**Interfaces:**

- Consumes: final schema, API, admin, and renderer contracts from prior tasks.
- Produces: verification evidence and a visually inspectable temporary PDF/image outside Git.

- [ ] **Step 1: Run focused and package test suites**

Run direct package binaries because this checkout's `pnpm exec` currently rejects the existing package-manager lockfile entry:

```bash
node_modules/.bin/vitest run
```

Run once from each of `packages/domain`, `packages/db`, `apps/api`, and
`apps/admin`.
Record passed, failed, and skipped counts separately.

- [ ] **Step 2: Run typecheck, lint, and build for affected packages**

Run package-local `tsc`/`eslint` binaries and build DB before API consumer checks:

```bash
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/tsc -p tsconfig.test.json
node_modules/.bin/eslint .
```

Run the three commands from each affected package (`packages/domain`,
`packages/db`, `apps/api`, `apps/admin`); omit `--noEmit` only for the domain/DB
build that consumers require.

- [ ] **Step 3: Render a 17-item fixture through headless Chromium**

Generate a temporary HTML file from `renderPickupSlipHtml`, print it to PDF with Chromium, and inspect page count with `pdfinfo`. Expected: exactly 2 A4 pages. Render the PDF pages to PNG and visually inspect page boundaries, repeated header/footer, DataMatrix cells, final blocks, signatures, and `стр. N из 2`.

- [ ] **Step 4: Run repository hygiene checks**

```bash
git diff --check
node_modules/.bin/prettier --check packages/domain/src/barcodes/svg.ts packages/domain/test/barcodes.test.ts apps/api/src/pickup/slip.ts apps/api/test/slip.test.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/src/modules/pickup-orders/dto.ts apps/api/src/modules/kiosks/dto.ts apps/api/src/modules/kiosks/kiosks.service.ts apps/api/src/modules/device-pairing/secret-response.openapi.ts apps/admin/src/pages/kiosks/api.ts apps/admin/src/pages/kiosks/KioskProfileForm.tsx apps/admin/src/pages/kiosks/KioskPanelRoute.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json packages/db/src/schema/pickup.ts
git status --short
```

- [ ] **Step 5: Review the final diff against the spec and commit verification fixes**

Confirm every spec section has implementation evidence. If verification required code corrections, stage only those explicit files and commit:

```bash
git commit -m "fix: harden paginated pickup slip"
```

Do not claim browser, physical-printer, or database coverage that did not actually run.
