# DPI-Neutral Label Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One label template prints on both 203 and 300 dpi printers: the station substitutes its printer's resolution at ZPL/TSPL generation time, the stock "(203 dpi)"/"(300 dpi)" twins collapse into one template, and the station's "printer resolution does not match the template" checks disappear.

**Architecture:** `LabelTemplateSpec.dpi` stays in the model as the AUTHORING resolution (admin preview, code import, legacy fallback). A single domain function `withPrinterDpi(spec, printerDpi)` produces the print spec; the station's `renderLabelBytes` is the only place that calls it, fed by the existing `HardwareConfig.printerDpi`. Nothing changes shape in the DB, DTOs or snapshots. The stock set shrinks from 22 to 17 templates with resolution-free names; a data migration (separate PR) renames existing stock rows and disables untouched 300-dpi twins.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), zod, vitest, React (station under Tauri, admin), NestJS API, drizzle-orm migrations on PostgreSQL, react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-10-dpi-neutral-label-templates-design.md`

## Global Constraints

- Two PRs. Tasks 1–12 are **PR 1 (code)** on the current branch `claude/label-templates-dpi-unification-e068d8`. Tasks 13–14 are **PR 2 (data)** on a new branch from `origin/main` and are merged only after the station release from PR 1 is installed on every workstation with a 300 dpi printer (spec, «Совместимость и порядок выката»).
- Stock names, copied verbatim from the spec: `DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40"`, box families `Коробка W×H`, `Коробка W×H без дат`, `Коробка W×H [Назв. для печати]`, `Коробка W×H без дат [Назв. для печати]` for sizes 58×40, 75×120, 100×100, 100×150; duplicate `DUPLICATE_LABEL_TEMPLATE_NAME = "Дубликат Data Matrix 58×40"`. All stock specs are authored at `dpi: 203`.
- Error code rename: `PRODUCT_LABEL_PRINTER_DPI_MISMATCH` → `PRODUCT_LABEL_PRINTER_DPI_REQUIRED`.
- `printerDpi === null` (legacy station settings) means: box labels print at `spec.dpi`; duplicate printing stays blocked until a resolution is configured.
- API DTO fields named `dpi` are KEPT (installed stations parse the lists strictly); only their OpenAPI descriptions change.
- Worktree bootstrap before the first test run: `CI=true pnpm install` (pnpm's deps-status check otherwise prompts and fails), then `pnpm --filter @markiro/db build`. After EVERY change under `packages/domain/src`, run `pnpm --filter @markiro/domain build` before running station/admin/api tests — consumers import the compiled `dist`.
- Run a single test file with `pnpm --filter <pkg> exec vitest run <path-relative-to-package>`; `pnpm --filter <pkg> test -- <name>` does NOT filter.
- API e2e files skip themselves when `DATABASE_URL` is absent; DB migration tests likewise. When you cannot run them, say so in the task's report instead of claiming green.
- Format only touched files: `pnpm exec prettier --write <paths>`. Never `prettier --write .`, never format the markdown plan/spec.
- Never use bare `git stash`. Commit messages: `type(scope): summary`, body optional, last line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

**PR 1 — code**

| File | Responsibility after this plan |
| --- | --- |
| `packages/domain/src/labels/model.ts` | Adds `PrinterDpi` type and `withPrinterDpi(spec, printerDpi)`; documents `dpi` as the authoring resolution. |
| `packages/domain/src/labels/duplicate.ts` | `assertDuplicateTemplate` floor evaluated at 203 dpi; one stock duplicate (`DUPLICATE_LABEL_TEMPLATE_NAME`); `buildLegacyDuplicateLabelTemplates()` for migration guards. |
| `packages/domain/src/labels/defaults.ts` | Four stock sizes, resolution-free names, `DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40"`; `buildLegacy*BoxLabelTemplates()` returning the pre-change rows with `renamedTo`. |
| `packages/domain/src/index.ts` | Exports the new names. |
| `packages/domain/test/labels-printer-dpi.test.ts` (new) | `withPrinterDpi` behaviour. |
| `packages/domain/test/product-labels-render.test.ts` | Resolution floor of `assertDuplicateTemplate`. |
| `packages/domain/test/labels-defaults.test.ts` | New names/sizes, legacy drift guards, 58×40 SSCC at both printer resolutions. |
| `apps/api/src/modules/label-templates/dto.ts`, `apps/api/src/modules/shifts/dto.ts` | OpenAPI descriptions of `dpi`. |
| `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` | Comment only (list comes from domain). |
| `apps/api/test/platform-tenants.e2e.test.ts`, `apps/api/test/provision-tenant-owner.e2e.test.ts` | 17 seeded templates, new names. |
| `apps/station/src/lib/print-label.ts` | `renderLabelBytes(..., options.dpi)` — the single substitution point. |
| `apps/station/src/lib/box-printing.ts` | `printing.dpi` threaded into `render`. |
| `apps/station/src/lib/inventory-box-label.ts`, `apps/station/src/lib/inventory-box-printing.ts` | Transport carries `dpi`; default renderer passes it. |
| `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/App.tsx` | Printing context carries `hardwareConfig.printerDpi`. |
| `apps/station/src/pages/WorkstationSetup.tsx`, `apps/station/src/ui/setup/PrinterSetupPanel.tsx` | Test print at printer dpi; hint under the resolution select. |
| `apps/station/src/lib/product-labels/fields.ts`, `validation.ts`, `apps/station/src/lib/use-product-label-work.ts` | Duplicates render at printer dpi; mismatch checks removed. |
| `apps/station/src/pages/NewShift.tsx`, `apps/station/src/dev/StationScreenGallery.tsx` | No dpi checks; meta line without dpi. |
| `apps/station/src/i18n/ru.json`, `en.json` | `shifts.templateMeta`, `setup.printerDpiHint`; `shifts.printDpiMismatch` removed. |
| `apps/station/test/*` | See tasks 5–9. |
| `apps/admin/src/pages/labels/index.tsx`, `editor/index.tsx`, `apps/admin/src/i18n/*.json` | No dpi badge; "Разрешение предпросмотра" select with hint. |
| `apps/admin/test/labels-library.test.tsx`, `labels-editor.test.tsx` | Updated expectations. |
| `docs/hardware-acceptance-checklist.md` | Resolution items rewritten. |

**PR 2 — data**

| File | Responsibility |
| --- | --- |
| `packages/db/migrations/0123_dpi_neutral_stock_label_templates.sql` | Rename 17 stock names; disable untouched, unreferenced 300-dpi twins. |
| `packages/db/migrations/meta/_journal.json` | Journal entry for 0123. |
| `packages/db/test/dpi-neutral-stock-label-templates-migration.test.ts` (new) | Four migration cases + idempotency. |
| `packages/domain/test/labels-defaults.test.ts` | Drift guard for 0123's literals. |

---

## PR 1 — code

### Task 1: `withPrinterDpi` in the domain model

**Files:**
- Modify: `packages/domain/src/labels/model.ts` (the `dpiSchema` line, the schema doc comment, and after `parseLabelTemplate`)
- Modify: `packages/domain/src/index.ts` (the `export { ... } from "./labels/model.js"` value block and the `export type { ... } from "./labels/model.js"` block)
- Create: `packages/domain/test/labels-printer-dpi.test.ts`

**Interfaces:**
- Produces: `export type PrinterDpi = 203 | 300;` and `export function withPrinterDpi(spec: LabelTemplateSpec, printerDpi: PrinterDpi | null): LabelTemplateSpec` — returns the SAME reference when `printerDpi` is `null` or equals `spec.dpi`, otherwise `{ ...spec, dpi: printerDpi }`. Tasks 5–8 consume both.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/labels-printer-dpi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  generateZpl,
  sampleLabelData,
  withPrinterDpi,
  type LabelTemplateSpec,
  type RasterResult,
} from "../src/index.js";

const SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  // Plain ASCII keeps the ZPL emitter on its native-text branch (no canvas).
  elements: [{ id: "t", kind: "text", text: "MARKIRO", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

const rasterizeText = async (): Promise<RasterResult> => ({
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
});

describe("withPrinterDpi", () => {
  it("returns the same spec when the printer resolution is unknown (legacy fallback)", () => {
    expect(withPrinterDpi(SPEC, null)).toBe(SPEC);
  });

  it("returns the same spec when the printer matches the authoring resolution", () => {
    expect(withPrinterDpi(SPEC, 203)).toBe(SPEC);
  });

  it("substitutes the printer resolution and leaves the millimetre geometry alone", () => {
    const printed = withPrinterDpi(SPEC, 300);
    expect(printed).toEqual({ ...SPEC, dpi: 300 });
    expect(printed).not.toBe(SPEC);
    expect(SPEC.dpi).toBe(203);
  });

  it("makes the emitters convert millimetres into the printer's own dots", async () => {
    const at203 = await generateZpl(withPrinterDpi(SPEC, 203), sampleLabelData(), { rasterizeText });
    const at300 = await generateZpl(withPrinterDpi(SPEC, 300), sampleLabelData(), { rasterizeText });
    // 58 mm is 464 dots at 203 dpi and 685 at 300 dpi.
    expect(at203).toContain("^PW464");
    expect(at300).toContain("^PW685");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run test/labels-printer-dpi.test.ts`
Expected: FAIL — `withPrinterDpi` is not exported from `../src/index.js` (TypeError / SyntaxError on import).

- [ ] **Step 3: Implement `withPrinterDpi`**

In `packages/domain/src/labels/model.ts` replace the line

```ts
const dpiSchema = z.union([z.literal(203), z.literal(300)]);
```

with

```ts
const dpiSchema = z.union([z.literal(203), z.literal(300)]);

/** A printer resolution the emitters support. */
export type PrinterDpi = z.infer<typeof dpiSchema>;
```

In the doc comment above `export const labelTemplateSpecSchema`, replace the first sentence

```
 * A printer-agnostic label layout: physical size, print resolution, target
 * command language, and the positioned elements.
```

with

```
 * A printer-agnostic label layout: physical size, AUTHORING resolution,
 * target command language, and the positioned elements. `dpi` is what the
 * admin preview and the code importer work in; it is NOT a requirement on
 * the printer — the station prints every template at its own printer's
 * resolution through `withPrinterDpi` (spec 2026-09-10), and `language` is
 * likewise overridden by the station's configured printer language.
```

After the `parseLabelTemplate` function add:

```ts
/**
 * The spec to PRINT on a given printer: the same millimetre geometry with
 * the printer's own resolution in `dpi`, so the emitters convert mm into the
 * dots that printer actually has. `spec.dpi` is the AUTHORING resolution and
 * only reaches the printer when the station does not know its printer's
 * resolution (`printerDpi === null` — settings saved before the field
 * existed), which keeps such stations printing exactly as before.
 *
 * Returns the same reference when nothing changes, so callers may key
 * caches on identity.
 */
export function withPrinterDpi(
  spec: LabelTemplateSpec,
  printerDpi: PrinterDpi | null,
): LabelTemplateSpec {
  if (printerDpi === null || printerDpi === spec.dpi) return spec;
  return { ...spec, dpi: printerDpi };
}
```

In `packages/domain/src/index.ts` add `withPrinterDpi,` to the value export block from `"./labels/model.js"` (the one containing `mmToDots`, `parseLabelTemplate`, `ptToDots`), keeping alphabetical order, and add `PrinterDpi,` to the `export type { ... } from "./labels/model.js"` block (between `LabelTextElement` and the closing brace, alphabetical).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run test/labels-printer-dpi.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/labels/model.ts packages/domain/src/index.ts packages/domain/test/labels-printer-dpi.test.ts
git commit -m "feat(domain): withPrinterDpi resolves a template for the attached printer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `assertDuplicateTemplate` judges the module floor at 203 dpi

**Files:**
- Modify: `packages/domain/src/labels/duplicate.ts` (the `assertDuplicateTemplate` function)
- Test: `packages/domain/test/product-labels-render.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `mmToDots` from `./model.js` (already imported).
- Produces: unchanged signature `assertDuplicateTemplate(spec: LabelTemplateSpec): void`; the "≥ 12 dots" rule now uses 203 dpi regardless of `spec.dpi`.

- [ ] **Step 1: Write the failing test**

Append to `packages/domain/test/product-labels-render.test.ts` (top level, after the existing `describe("duplicate template eligibility", ...)`):

```ts
describe("duplicate template resolution floor", () => {
  const base = domain.buildDuplicateLabelTemplate(300);
  const withCodeSize = (sizeMm: number): domain.LabelTemplateSpec => ({
    ...base,
    elements: base.elements.map((element) =>
      element.kind === "barcode" && element.data === "km.code" ? { ...element, sizeMm } : element,
    ),
  });

  it("judges the minimum code size at 203 dpi even for a template authored at 300", () => {
    // 1.4 mm is 17 dots at 300 dpi but only 11 at 203 dpi; the coarsest
    // supported printer decides, because any template may print on any printer.
    expect(() => domain.assertDuplicateTemplate(withCodeSize(1.4))).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_LABEL_TEMPLATE_INVALID" }),
    );
    // 1.6 mm is 13 dots at 203 dpi — accepted.
    expect(() => domain.assertDuplicateTemplate(withCodeSize(1.6))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-labels-render.test.ts`
Expected: FAIL — the 1.4 mm case does not throw (17 dots at the template's own 300 dpi pass the floor).

- [ ] **Step 3: Implement the floor**

In `packages/domain/src/labels/duplicate.ts`, above `export function assertDuplicateTemplate`, add:

```ts
/**
 * A template may print on any supported printer (spec 2026-09-10), so the
 * "at least 12 dots per code" floor is judged at the COARSEST resolution:
 * a code that is big enough at 203 dpi is big enough at 300.
 */
const COARSEST_PRINTER_DPI = 203;
```

and replace the condition line

```ts
    mmToDots(code.sizeMm, parsed.data.dpi) < 12
```

with

```ts
    mmToDots(code.sizeMm, COARSEST_PRINTER_DPI) < 12
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-labels-render.test.ts`
Expected: PASS (all tests in the file, including the existing eligibility cases).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/labels/duplicate.ts packages/domain/test/product-labels-render.test.ts
git commit -m "feat(domain): judge the duplicate code floor at the coarsest printer resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Resolution-free stock set with legacy builders

**Files:**
- Modify: `packages/domain/src/labels/defaults.ts` (line 12 `DEFAULT_BOX_LABEL_TEMPLATE_NAME`; the tail from `/** The five stock sizes ... */` to the end of the file)
- Modify: `packages/domain/src/labels/duplicate.ts` (`buildDuplicateLabelTemplates`)
- Modify: `packages/domain/src/index.ts` (duplicate and defaults export blocks)
- Test: `packages/domain/test/labels-defaults.test.ts`

**Interfaces:**
- Produces (defaults.ts):
  - `export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40";`
  - `buildDatedBoxLabelTemplates()`, `buildDateFreeBoxLabelTemplates()`, `buildPrintNameBoxLabelTemplates()`, `buildDefaultLabelTemplates()` — same signatures, 4 / 4 / 8 / 16 rows, new names, all `dpi: 203`.
  - `export interface LegacyStockLabelTemplate extends DefaultLabelTemplate { renamedTo: string | null }`
  - `buildLegacyDatedBoxLabelTemplates()`, `buildLegacyDateFreeBoxLabelTemplates()`, `buildLegacyPrintNameBoxLabelTemplates()`: `LegacyStockLabelTemplate[]` — the pre-change 5 / 5 / 10 rows in migration order (58×40@203, 58×40@300, 75×120, 100×100, 100×150), `renamedTo` = new name for 203 rows, `null` for the 58×40@300 twins.
- Produces (duplicate.ts):
  - `export const DUPLICATE_LABEL_TEMPLATE_NAME = "Дубликат Data Matrix 58×40";`
  - `buildDuplicateLabelTemplates()` → exactly one `{ name: DUPLICATE_LABEL_TEMPLATE_NAME, spec: buildDuplicateLabelTemplate(203) }`.
  - `buildLegacyDuplicateLabelTemplates(): LegacyStockLabelTemplate[]` — `[{ name: "Дубликат Data Matrix 58×40 (203 dpi)", spec @203, renamedTo: DUPLICATE_LABEL_TEMPLATE_NAME }, { name: "Дубликат Data Matrix 58×40 (300 dpi)", spec @300, renamedTo: null }]`.
- Task 4 (API tests) and Task 13 (migration) consume these.

- [ ] **Step 1: Update the existing tests to the new contract**

In `packages/domain/test/labels-defaults.test.ts`:

Replace the import block (lines 4–24) with:

```ts
import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDateFreeBoxLabelTemplates,
  buildDatedBoxLabelTemplates,
  buildDefaultLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
  buildPrintNameBoxLabelTemplates,
  code128ModuleCount,
  elementBoundsMm,
  estimatedTextWidthMm,
  generateTspl,
  generateZpl,
  GS1_128_QUIET_ZONE_MODULES,
  labelFieldDisplayValue,
  mmToDots,
  parseLabelTemplate,
  ptToMm,
  sampleLabelData,
  withPrinterDpi,
  wrapTextToWidth,
  WRAP_ELLIPSIS,
  type LabelField,
  type RasterResult,
  type RasterizeTextFn,
} from "../src/index.js";
```

Replace the `SIZES` constant (the block starting `/** The five sizes, in the order both families are built in. */`) with:

```ts
/** The four stock sizes, in the order both families are built in — all authored at 203 dpi. */
const SIZES: Array<[number, number, number]> = [
  [58, 40, 203],
  [75, 120, 203],
  [100, 100, 203],
  [100, 150, 203],
];
```

Replace the whole first `it("returns BOTH stock families with the exact seed names", ...)` with:

```ts
  it("returns BOTH stock families with the exact, resolution-free seed names", () => {
    const templates = buildDefaultLabelTemplates();
    // The names are the `(tenant_id, name)` idempotency key of provisioning
    // and of migration 0123's rename table, so they are pinned literally here.
    expect(templates.map((t) => t.name)).toEqual([
      "Коробка 58×40",
      "Коробка 75×120",
      "Коробка 100×100",
      "Коробка 100×150",
      "Коробка 58×40 без дат",
      "Коробка 75×120 без дат",
      "Коробка 100×100 без дат",
      "Коробка 100×150 без дат",
      "Коробка 58×40 [Назв. для печати]",
      "Коробка 75×120 [Назв. для печати]",
      "Коробка 100×100 [Назв. для печати]",
      "Коробка 100×150 [Назв. для печати]",
      "Коробка 58×40 без дат [Назв. для печати]",
      "Коробка 75×120 без дат [Назв. для печати]",
      "Коробка 100×100 без дат [Назв. для печати]",
      "Коробка 100×150 без дат [Назв. для печати]",
    ]);
    // ...and the whole list is exactly the three groups, in that order, so
    // provisioning (which consumes this one function) seeds all sixteen.
    expect(templates).toEqual([
      ...buildDatedBoxLabelTemplates(),
      ...buildDateFreeBoxLabelTemplates(),
      ...buildPrintNameBoxLabelTemplates(),
    ]);
    // The tenant default is still the DATED 58×40 — adding a family must
    // not move it.
    expect(DEFAULT_BOX_LABEL_TEMPLATE_NAME).toBe("Коробка 58×40");
    expect(buildDatedBoxLabelTemplates()[0]!.name).toBe(DEFAULT_BOX_LABEL_TEMPLATE_NAME);
    expect(
      templates.filter((t) => t.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME),
      "the default name must identify exactly one seeded template",
    ).toHaveLength(1);
    // Both families are cut in the same four sizes, all authored at 203 dpi:
    // the station prints them at its own printer's resolution.
    for (const family of [buildDatedBoxLabelTemplates(), buildDateFreeBoxLabelTemplates()]) {
      expect(family.map((t) => [t.spec.widthMm, t.spec.heightMm, t.spec.dpi])).toEqual(SIZES);
    }
  });

  it("keeps the pre-2026-09-10 seed rows reachable for the migration guards", () => {
    const legacy = [
      ...buildLegacyDatedBoxLabelTemplates(),
      ...buildLegacyDateFreeBoxLabelTemplates(),
      ...buildLegacyPrintNameBoxLabelTemplates(),
    ];
    expect(legacy.map((t) => [t.name, t.renamedTo])).toEqual([
      ["Коробка 58×40 (203 dpi)", "Коробка 58×40"],
      ["Коробка 58×40 (300 dpi)", null],
      ["Коробка 75×120 (203 dpi)", "Коробка 75×120"],
      ["Коробка 100×100 (203 dpi)", "Коробка 100×100"],
      ["Коробка 100×150 (203 dpi)", "Коробка 100×150"],
      ["Коробка 58×40 без дат (203 dpi)", "Коробка 58×40 без дат"],
      ["Коробка 58×40 без дат (300 dpi)", null],
      ["Коробка 75×120 без дат (203 dpi)", "Коробка 75×120 без дат"],
      ["Коробка 100×100 без дат (203 dpi)", "Коробка 100×100 без дат"],
      ["Коробка 100×150 без дат (203 dpi)", "Коробка 100×150 без дат"],
      ["Коробка 58×40 (203 dpi) [Назв. для печати]", "Коробка 58×40 [Назв. для печати]"],
      ["Коробка 58×40 (300 dpi) [Назв. для печати]", null],
      ["Коробка 75×120 (203 dpi) [Назв. для печати]", "Коробка 75×120 [Назв. для печати]"],
      ["Коробка 100×100 (203 dpi) [Назв. для печати]", "Коробка 100×100 [Назв. для печати]"],
      ["Коробка 100×150 (203 dpi) [Назв. для печати]", "Коробка 100×150 [Назв. для печати]"],
      [
        "Коробка 58×40 без дат (203 dpi) [Назв. для печати]",
        "Коробка 58×40 без дат [Назв. для печати]",
      ],
      ["Коробка 58×40 без дат (300 dpi) [Назв. для печати]", null],
      [
        "Коробка 75×120 без дат (203 dpi) [Назв. для печати]",
        "Коробка 75×120 без дат [Назв. для печати]",
      ],
      [
        "Коробка 100×100 без дат (203 dpi) [Назв. для печати]",
        "Коробка 100×100 без дат [Назв. для печати]",
      ],
      [
        "Коробка 100×150 без дат (203 dpi) [Назв. для печати]",
        "Коробка 100×150 без дат [Назв. для печати]",
      ],
    ]);
    // A renamed legacy row is byte-for-byte the current stock spec under its
    // new name; the 300 twins are the same layout at the other resolution.
    const current = new Map(buildDefaultLabelTemplates().map((t) => [t.name, t.spec]));
    for (const row of legacy) {
      if (row.renamedTo !== null) expect(row.spec, row.name).toEqual(current.get(row.renamedTo));
      else expect(row.spec.dpi, row.name).toBe(300);
    }
  });

  it("prints the 58×40 SSCC GS1-legal on both printer resolutions", async () => {
    const modules = code128ModuleCount("0".repeat(20), true) + 2 * GS1_128_QUIET_ZONE_MODULES;
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      if (spec.widthMm !== 58) continue;
      const sscc = spec.elements.find((el) => el.kind === "barcode" && el.data === "sscc");
      if (sscc?.kind !== "barcode" || sscc.moduleWidthMm === undefined)
        throw new Error(`${name}: SSCC barcode with an explicit module width expected`);
      for (const [dpi, dots] of [
        [203, 2],
        [300, 3],
      ] as const) {
        const printed = withPrinterDpi(spec, dpi);
        expect(mmToDots(sscc.moduleWidthMm, printed.dpi), `${name} @${dpi}: module dots`).toBe(dots);
        // Symbol plus both quiet zones, at the width the printer will really draw.
        const moduleMm = (25.4 / dpi) * dots;
        const left = sscc.xMm - GS1_128_QUIET_ZONE_MODULES * moduleMm;
        expect(left, `${name} @${dpi}: left quiet zone on the label`).toBeGreaterThanOrEqual(0);
        expect(left + modules * moduleMm, `${name} @${dpi}: right edge`).toBeLessThanOrEqual(58);
        await expect(
          generateZpl(printed, sampleLabelData(), { rasterizeText: boundedRasterizer() }),
        ).resolves.toContain(dpi === 203 ? "^PW464" : "^PW685");
        await expect(
          generateTspl(printed, sampleLabelData(), { rasterizeText: boundedRasterizer() }),
        ).resolves.toContain("PRINT 1");
      }
    }
  });
```

In `it("centres the SSCC barcode at the widest GS1-legal module width", ...)` replace the `expected` map with:

```ts
    const expected: Record<string, { moduleWidthMm: number; xMm: number }> = {
      // 203 dpi authoring: 2 dots = 0.2502 mm, already GS1's MINIMUM
      // X-dimension — a 3-dot module would be 58.6 mm of bars on a 58 mm
      // label. On a 300 dpi printer the same 0.2502 mm rounds to 3 dots
      // (0.254 mm), see "prints the 58×40 SSCC GS1-legal on both printer resolutions".
      "Коробка 58×40": { moduleWidthMm: 0.2502, xMm: 9.5 },
      "Коробка 75×120": { moduleWidthMm: 0.3754, xMm: 8.2 },
      "Коробка 100×100": { moduleWidthMm: 0.5005, xMm: 11 },
      "Коробка 100×150": { moduleWidthMm: 0.5005, xMm: 11 },
      // The date-free family changes the label's vertical budget only, so at
      // each size its symbol is the same WIDTH in the same place — only
      // taller.
      "Коробка 58×40 без дат": { moduleWidthMm: 0.2502, xMm: 9.5 },
      "Коробка 75×120 без дат": { moduleWidthMm: 0.3754, xMm: 8.2 },
      "Коробка 100×100 без дат": { moduleWidthMm: 0.5005, xMm: 11 },
      "Коробка 100×150 без дат": { moduleWidthMm: 0.5005, xMm: 11 },
    };
```

In `it("spends the freed row on the barcode, not on a fourth name line", ...)` replace the `expectedBars` map with:

```ts
    const expectedBars: Record<string, number> = {
      "Коробка 58×40 без дат": 7.6,
      "Коробка 75×120 без дат": 10.3,
      "Коробка 100×100 без дат": 13.5,
      "Коробка 100×150 без дат": 13.5,
    };
```

Replace the three drift-guard tests at the end of the file (`matches the jsonb inlined into db migration 0056/0053/0059`) with:

```ts
  it("matches the jsonb inlined into db migration 0056 (drift guard)", async () => {
    expect(await inlinedRows("0056_align_dated_label_quantity.sql")).toEqual(
      buildLegacyDatedBoxLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });

  /**
   * The DATE-FREE family's own drift guard. Its migration is an
   * insert-if-absent (these names have never existed, so nothing needs
   * overwriting), and like 0052's it must stay in step with this module —
   * whoever changes the layout has to regenerate the SQL.
   */
  it("matches the jsonb inlined into db migration 0053 (drift guard)", async () => {
    expect(await inlinedRows("0053_date_free_label_templates.sql")).toEqual(
      buildLegacyDateFreeBoxLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });

  /**
   * The PRINT-NAME family's drift guard — insert-if-absent like 0053's, and
   * generated the same way: whoever changes the layout regenerates the SQL.
   */
  it("matches the jsonb inlined into db migration 0059 (drift guard)", async () => {
    expect(await inlinedRows("0059_print_name_label_templates.sql")).toEqual(
      buildLegacyPrintNameBoxLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/domain exec vitest run test/labels-defaults.test.ts`
Expected: FAIL — `buildLegacyDatedBoxLabelTemplates` is not exported; name expectations differ.

- [ ] **Step 3: Rewrite the stock builders**

In `packages/domain/src/labels/defaults.ts` replace line 12

```ts
export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40 (203 dpi)";
```

with

```ts
export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40";
```

Replace everything from `/** The five stock sizes both families are cut in. */` to the end of the file with:

```ts
/**
 * Every stock template is AUTHORED at 203 dpi. That is not a printer
 * requirement: the station prints any template at its own printer's
 * resolution (`withPrinterDpi`, spec 2026-09-10). The SSCC module width the
 * 203 dpi build picks (2 dots = 0.2502 mm on the 58×40) rounds to 3 dots
 * (0.254 mm) on a 300 dpi printer — the same modules the former 300 dpi twin
 * carried explicitly.
 */
const STOCK_AUTHORING_DPI = 203;

/** The four stock sizes both families are cut in. */
const BOX_LABEL_SIZES: ReadonlyArray<{ w: number; h: number }> = [
  { w: 58, h: 40 },
  { w: 75, h: 120 },
  { w: 100, h: 100 },
  { w: 100, h: 150 },
];

/** Part of the seed identity of the print-name family (see `buildPrintNameBoxLabelTemplates`). */
const PRINT_NAME_SUFFIX = " [Назв. для печати]";

function stockName(w: number, h: number, dates: DateFields, suffix = ""): string {
  return dates === "with-dates" ? `Коробка ${w}×${h}${suffix}` : `Коробка ${w}×${h} без дат${suffix}`;
}

/**
 * The four DATED stock box labels — the original family, and the one
 * `DEFAULT_BOX_LABEL_TEMPLATE_NAME` points into. Pure and deterministic.
 */
export function buildDatedBoxLabelTemplates(): DefaultLabelTemplate[] {
  return BOX_LABEL_SIZES.map(({ w, h }) => ({
    name: stockName(w, h, "with-dates"),
    spec: buildBoxLabelSpec(w, h, STOCK_AUTHORING_DPI, "with-dates"),
  }));
}

/**
 * The four DATE-FREE stock box labels: same four sizes, same design, minus
 * «Дата производства» and «Годен до». For goods whose packaging already
 * carries the dates (or has none to carry) — and, because the space the two
 * columns used to take goes to the SSCC symbol, with materially taller bars.
 *
 * THE NAMES ARE THE SEED IDENTITY. They are the `(tenant_id, name)`
 * idempotency key of tenant provisioning and of migration 0123's rename
 * table; renaming one here re-seeds it as a second row rather than updating
 * the first.
 */
export function buildDateFreeBoxLabelTemplates(): DefaultLabelTemplate[] {
  return BOX_LABEL_SIZES.map(({ w, h }) => ({
    name: stockName(w, h, "without-dates"),
    spec: buildBoxLabelSpec(w, h, STOCK_AUTHORING_DPI, "without-dates"),
  }));
}

/**
 * PRINT-NAME duplicates of both families: identical geometry, but the
 * headline binds `product.printName` — the catalog's short operator-facing
 * name (the station substitutes the full name when a product has none). The
 * ` [Назв. для печати]` suffix is part of the seed identity, same rules as
 * the families above.
 */
export function buildPrintNameBoxLabelTemplates(): DefaultLabelTemplate[] {
  return [
    ...BOX_LABEL_SIZES.map(({ w, h }) => ({
      name: stockName(w, h, "with-dates", PRINT_NAME_SUFFIX),
      spec: buildBoxLabelSpec(w, h, STOCK_AUTHORING_DPI, "with-dates", "product.printName"),
    })),
    ...BOX_LABEL_SIZES.map(({ w, h }) => ({
      name: stockName(w, h, "without-dates", PRINT_NAME_SUFFIX),
      spec: buildBoxLabelSpec(w, h, STOCK_AUTHORING_DPI, "without-dates", "product.printName"),
    })),
  ];
}

/**
 * Every stock box label a tenant is seeded with: the dated four, the
 * date-free four, then their eight print-name duplicates. Provisioning
 * inserts exactly this list.
 */
export function buildDefaultLabelTemplates(): DefaultLabelTemplate[] {
  return [
    ...buildDatedBoxLabelTemplates(),
    ...buildDateFreeBoxLabelTemplates(),
    ...buildPrintNameBoxLabelTemplates(),
  ];
}

/**
 * One row of the seed set AS IT WAS before templates became
 * resolution-neutral (spec 2026-09-10): the dpi-suffixed name and, for the
 * 203 dpi rows, the resolution-free name migration 0123 renames it to.
 * `renamedTo` is null for the 58×40 @300 twins — the migration disables
 * those instead of renaming them.
 */
export interface LegacyStockLabelTemplate extends DefaultLabelTemplate {
  renamedTo: string | null;
}

/**
 * The pre-2026-09-10 seed sizes: the same four plus a 58×40 twin authored at
 * 300 dpi, in the order migrations 0053/0056/0059 inline them. Read only by
 * the legacy builders below.
 */
const LEGACY_BOX_LABEL_SIZES: ReadonlyArray<{ w: number; h: number; dpi: 203 | 300 }> = [
  { w: 58, h: 40, dpi: 203 },
  { w: 58, h: 40, dpi: 300 },
  { w: 75, h: 120, dpi: 203 },
  { w: 100, h: 100, dpi: 203 },
  { w: 100, h: 150, dpi: 203 },
];

function legacyRows(
  dates: DateFields,
  nameField?: "product.printName",
): LegacyStockLabelTemplate[] {
  const suffix = nameField === undefined ? "" : PRINT_NAME_SUFFIX;
  return LEGACY_BOX_LABEL_SIZES.map(({ w, h, dpi }) => ({
    name: stockName(w, h, dates, ` (${dpi} dpi)${suffix}`),
    spec: buildBoxLabelSpec(w, h, dpi, dates, nameField ?? "product.name"),
    renamedTo: dpi === 300 ? null : stockName(w, h, dates, suffix),
  }));
}

/**
 * The legacy seed rows, family by family. Provisioning does NOT use these:
 * they exist for the migration drift guards (0053, 0056, 0059) and for
 * migration 0123, which renames the 203 rows and disables the untouched
 * 300 twins. Pure and deterministic like everything above.
 */
export function buildLegacyDatedBoxLabelTemplates(): LegacyStockLabelTemplate[] {
  return legacyRows("with-dates");
}

export function buildLegacyDateFreeBoxLabelTemplates(): LegacyStockLabelTemplate[] {
  return legacyRows("without-dates");
}

export function buildLegacyPrintNameBoxLabelTemplates(): LegacyStockLabelTemplate[] {
  return [
    ...legacyRows("with-dates", "product.printName"),
    ...legacyRows("without-dates", "product.printName"),
  ];
}
```

In `packages/domain/src/labels/duplicate.ts` add the import

```ts
import type { LegacyStockLabelTemplate } from "./defaults.js";
```

and replace the `buildDuplicateLabelTemplates` function (with its `/** Separate stock presets ... */` comment) with:

```ts
/** The seed identity of the one stock duplicate preset (spec 2026-09-10). */
export const DUPLICATE_LABEL_TEMPLATE_NAME = "Дубликат Data Matrix 58×40";

/**
 * The stock duplicate preset new tenants get — one, authored at 203 dpi; the
 * station prints it at its own printer's resolution (`withPrinterDpi`).
 */
export function buildDuplicateLabelTemplates(): { name: string; spec: LabelTemplateSpec }[] {
  return [{ name: DUPLICATE_LABEL_TEMPLATE_NAME, spec: buildDuplicateLabelTemplate(203) }];
}

/**
 * The pre-2026-09-10 presets, one per resolution, as migrations 0114/0115
 * seeded them: for migration 0123 (rename the 203 row, disable the untouched
 * 300 twin) and its drift guard. Provisioning does not use this.
 */
export function buildLegacyDuplicateLabelTemplates(): LegacyStockLabelTemplate[] {
  return ([203, 300] as const).map((dpi) => ({
    name: `Дубликат Data Matrix 58×40 (${dpi} dpi)`,
    spec: buildDuplicateLabelTemplate(dpi),
    renamedTo: dpi === 203 ? DUPLICATE_LABEL_TEMPLATE_NAME : null,
  }));
}
```

In `packages/domain/src/index.ts` replace

```ts
export {
  assertDuplicateTemplate,
  buildDuplicateLabelTemplate,
  buildDuplicateLabelTemplates,
} from "./labels/duplicate.js";
```

with

```ts
export {
  assertDuplicateTemplate,
  buildDuplicateLabelTemplate,
  buildDuplicateLabelTemplates,
  buildLegacyDuplicateLabelTemplates,
  DUPLICATE_LABEL_TEMPLATE_NAME,
} from "./labels/duplicate.js";
```

and replace

```ts
export {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDateFreeBoxLabelTemplates,
  buildDatedBoxLabelTemplates,
  buildDefaultLabelTemplates,
  buildPrintNameBoxLabelTemplates,
} from "./labels/defaults.js";
export type { DefaultLabelTemplate } from "./labels/defaults.js";
```

with

```ts
export {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDateFreeBoxLabelTemplates,
  buildDatedBoxLabelTemplates,
  buildDefaultLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
  buildPrintNameBoxLabelTemplates,
} from "./labels/defaults.js";
export type { DefaultLabelTemplate, LegacyStockLabelTemplate } from "./labels/defaults.js";
```

- [ ] **Step 4: Run the domain suite to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run test/labels-defaults.test.ts test/product-labels-render.test.ts test/product-labels-contracts.test.ts test/product-labels-state.test.ts`
Expected: PASS. Then run the whole package: `pnpm --filter @markiro/domain test` — PASS.

- [ ] **Step 5: Rebuild the package and commit**

```bash
pnpm --filter @markiro/domain build
git add packages/domain/src/labels/defaults.ts packages/domain/src/labels/duplicate.ts packages/domain/src/index.ts packages/domain/test/labels-defaults.test.ts
git commit -m "feat(domain): resolution-free stock label set with legacy builders for migrations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API — seeded set, OpenAPI descriptions

**Files:**
- Modify: `apps/api/src/modules/label-templates/dto.ts` (the `dpi` property in `labelTemplateSummaryOpenApiSchema`)
- Modify: `apps/api/src/modules/shifts/dto.ts` (the `dpi` property inside `shiftBoxLabelTemplatesOpenApiSchema.properties.items.items.properties`)
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (comment lines 114–120 only)
- Test: `apps/api/test/platform-tenants.e2e.test.ts` (imports lines 7–11; the `it("seeds both duplicate resolutions ...")` test)
- Test: `apps/api/test/provision-tenant-owner.e2e.test.ts` (import line 5; the names list, the default lookup, the `toHaveLength(22)`, the duplicates expectation)

**Interfaces:**
- Consumes: `buildDefaultLabelTemplates`, `buildDuplicateLabelTemplate`, `DEFAULT_BOX_LABEL_TEMPLATE_NAME`, `DUPLICATE_LABEL_TEMPLATE_NAME` from Task 3.
- Produces: no runtime API change; provisioning seeds 16 + 1 rows because it reads the domain lists.

- [ ] **Step 1: Update the provisioning tests**

In `apps/api/test/platform-tenants.e2e.test.ts` change the domain import to

```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplate,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  DUPLICATE_LABEL_TEMPLATE_NAME,
} from "@markiro/domain";
```

and replace the test `it("seeds both duplicate resolutions and preserves all box presets and the box default", ...)` with:

```ts
  it("seeds the resolution-free stock set: one duplicate preset, all box presets and the box default", async () => {
    await ensureTenant();
    const templates = await setup.db
      .select()
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.tenantId, tenantId));
    const boxes = templates.filter((template) => template.purpose === "box");
    expect(
      boxes.map(({ name, spec }) => ({ name, spec })).sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(buildDefaultLabelTemplates().sort((a, b) => a.name.localeCompare(b.name)));
    expect(templates.filter((template) => template.purpose === "product_duplicate")).toEqual([
      expect.objectContaining({
        name: DUPLICATE_LABEL_TEMPLATE_NAME,
        spec: buildDuplicateLabelTemplate(),
        enabled: true,
        chzProductGroupCodes: null,
      }),
    ]);
    const [profile] = await setup.db
      .select()
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    expect(profile?.defaultBoxLabelTemplateId).toBe(
      boxes.find((template) => template.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME)?.id,
    );
  });
```

In `apps/api/test/provision-tenant-owner.e2e.test.ts` change line 5 to

```ts
import { buildDuplicateLabelTemplate, DUPLICATE_LABEL_TEMPLATE_NAME } from "@markiro/domain";
```

replace the 20-name array inside `.toEqual([...].sort())` with

```ts
      [
        "Коробка 58×40",
        "Коробка 75×120",
        "Коробка 100×100",
        "Коробка 100×150",
        "Коробка 58×40 без дат",
        "Коробка 75×120 без дат",
        "Коробка 100×100 без дат",
        "Коробка 100×150 без дат",
        "Коробка 58×40 [Назв. для печати]",
        "Коробка 75×120 [Назв. для печати]",
        "Коробка 100×100 [Назв. для печати]",
        "Коробка 100×150 [Назв. для печати]",
        "Коробка 58×40 без дат [Назв. для печати]",
        "Коробка 75×120 без дат [Назв. для печати]",
        "Коробка 100×100 без дат [Назв. для печати]",
        "Коробка 100×150 без дат [Назв. для печати]",
      ].sort(),
```

replace

```ts
    const expected = templates.find((t) => t.name === "Коробка 58×40 (203 dpi)");
```

with

```ts
    const expected = templates.find((t) => t.name === "Коробка 58×40");
```

replace `expect(after).toHaveLength(22);` with `expect(after).toHaveLength(17);`, and replace the duplicates expectation (the `expect(templates.filter((t) => t.purpose === "product_duplicate").sort(...)).toEqual([...two objects...])`) with:

```ts
    expect(templates.filter((t) => t.purpose === "product_duplicate")).toEqual([
      expect.objectContaining({
        name: DUPLICATE_LABEL_TEMPLATE_NAME,
        spec: buildDuplicateLabelTemplate(),
      }),
    ]);
```

- [ ] **Step 2: Run the two e2e files**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/api exec vitest run test/platform-tenants.e2e.test.ts test/provision-tenant-owner.e2e.test.ts`
Expected: PASS when `DATABASE_URL` points at a freshly migrated throwaway database. Recipe: in the running dev Postgres container (`docker ps --filter name=postgres`) run `docker exec <container> psql -U markiro -d postgres -c 'CREATE DATABASE markiro_dpi_neutral'`, then `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_dpi_neutral pnpm --filter @markiro/db db:migrate`, and export the same `DATABASE_URL` for the vitest run (the other API env values come from `.env.example`). Without a database the two files report as skipped — state that explicitly in the task report.

- [ ] **Step 3: OpenAPI descriptions and the provisioning comment**

In `apps/api/src/modules/label-templates/dto.ts` replace

```ts
    dpi: { type: "integer", enum: [203, 300] },
```

with

```ts
    dpi: {
      type: "integer",
      enum: [203, 300],
      description:
        "Authoring resolution used by the admin preview and code import. The station prints every template at its own printer's resolution.",
    },
```

In `apps/api/src/modules/shifts/dto.ts` replace the `dpi: { type: "integer", enum: [203, 300] },` line inside `shiftBoxLabelTemplatesOpenApiSchema` with

```ts
          dpi: {
            type: "integer",
            enum: [203, 300],
            description:
              "Authoring resolution. Informational only: the station prints at its own printer's resolution.",
          },
```

In `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` replace the comment block

```ts
      // Stock box-label templates (spec: 2026-08-20 label editor simplification).
      // Both families — the dated five and the date-free five — come from the
      // single `buildDefaultLabelTemplates()` list, so a family added there is
      // seeded here without touching this loop. The tenant's DEFAULT stays the
      // dated 58×40 @203 (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) regardless.
```

with

```ts
      // Stock box-label templates (specs 2026-08-20 and 2026-09-10). All
      // families come from the single `buildDefaultLabelTemplates()` list, so
      // a family added there is seeded here without touching this loop. The
      // templates are resolution-neutral — the station prints them at its own
      // printer's dpi — and the tenant's DEFAULT stays the dated 58×40
      // (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) regardless.
```

- [ ] **Step 4: Run the OpenAPI test**

Run: `pnpm --filter @markiro/api exec vitest run test/openapi-docs.test.ts`
Expected: PASS (the gate compares field sets, not descriptions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/label-templates/dto.ts apps/api/src/modules/shifts/dto.ts apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts apps/api/test/platform-tenants.e2e.test.ts apps/api/test/provision-tenant-owner.e2e.test.ts
git commit -m "feat(api): seed the resolution-free stock label set

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Station render substitutes the printer resolution

**Files:**
- Modify: `apps/station/src/lib/print-label.ts`
- Test: `apps/station/test/print-label.test.ts`

**Interfaces:**
- Consumes: `withPrinterDpi`, `PrinterDpi` from `@markiro/domain` (Task 1).
- Produces:

```ts
export interface RenderLabelOptions {
  kmDataMatrix?: "native" | "raster";
  /** The attached printer's resolution; null (legacy settings) prints at the template's authoring dpi. */
  dpi?: PrinterDpi | null;
}
export async function renderLabelBytes(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
  options?: RenderLabelOptions,
): Promise<Uint8Array>;
```

- [ ] **Step 1: Write the failing tests**

Append inside `describe("renderLabelBytes", ...)` in `apps/station/test/print-label.test.ts`:

```ts
  it("prints at the attached printer's resolution, not the template's authoring dpi", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "zpl", fakeRasterize, {
      dpi: 300,
    });
    expect(new TextDecoder().decode(bytes)).toContain("^PW685");
  });

  it("falls back to the authoring dpi when the printer resolution is unknown", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "zpl", fakeRasterize, {
      dpi: null,
    });
    expect(new TextDecoder().decode(bytes)).toContain("^PW464");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run test/print-label.test.ts`
Expected: FAIL — the first new test finds `^PW464` instead of `^PW685` (a type error on `dpi` is also acceptable evidence).

- [ ] **Step 3: Implement**

Replace `apps/station/src/lib/print-label.ts` entirely with:

```ts
import {
  generateTspl,
  generateZpl,
  withPrinterDpi,
  type LabelField,
  type LabelTemplateSpec,
  type PrinterDpi,
  type RasterizeTextFn,
} from "@markiro/domain";
import type { PrinterLanguage } from "./hardware-config.js";

/**
 * Converts an emitter's output to exact bytes, one code unit per byte.
 *
 * The TSPL emitter carries its binary `BITMAP` payload as a latin1 string
 * (pinned in plan 04). `TextEncoder` would UTF-8-encode every byte above
 * 0x7F into two bytes and corrupt the bitmap, so the conversion must be a
 * plain `charCodeAt` walk. ZPL is printable ASCII, where both agree.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export interface RenderLabelOptions {
  kmDataMatrix?: "native" | "raster";
  /**
   * The attached printer's resolution. `null` (or omitted) means the
   * workstation was configured before the resolution setting existed: the
   * label then prints at the template's authoring dpi, exactly as before.
   */
  dpi?: PrinterDpi | null;
}

/**
 * Renders a label for the printer actually attached to this workstation.
 *
 * The template's own `language` and `dpi` are deliberately overridden: a spec
 * is printer-neutral millimetre geometry and both emitters consume it, so a
 * plant can run mixed printers against one set of templates. The configured
 * printer language decides the command set and the configured printer
 * resolution decides the dot conversion (spec 2026-09-10).
 */
export async function renderLabelBytes(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
  options: RenderLabelOptions = {},
): Promise<Uint8Array> {
  const { dpi = null, ...emitterOptions } = options;
  const printSpec = withPrinterDpi(spec, dpi);
  const text =
    language === "tspl"
      ? await generateTspl(printSpec, data, { rasterizeText, ...emitterOptions })
      : await generateZpl(printSpec, data, { rasterizeText, ...emitterOptions });
  return latin1ToBytes(text);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run test/print-label.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/print-label.ts apps/station/test/print-label.test.ts
git commit -m "feat(station): render labels at the attached printer's resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Box printing carries the printer resolution

**Files:**
- Modify: `apps/station/src/lib/box-printing.ts`
- Modify: `apps/station/src/lib/inventory-box-label.ts` (`renderInventoryBoxLabel`)
- Modify: `apps/station/src/lib/inventory-box-printing.ts` (`InventoryBoxPrintingTransport`, the `render?` member of `AttemptInventoryBoxPrintInput`, the default `render` in `attemptInventoryBoxPrint`)
- Modify: `apps/station/src/pages/WorkScreen.tsx` (the `printing?:` prop type at lines 131–136; the `render:` arrow at lines 948–949)
- Modify: `apps/station/src/App.tsx` (both `printing={ hardwareConfig.printer ? {...} : null }` blocks, lines 1629–1637 and 1662–1670)
- Test: `apps/station/test/box-printing.test.ts`, `apps/station/test/inventory-box-label.test.ts`

**Interfaces:**
- Consumes: `renderLabelBytes(..., { dpi })` from Task 5; `PrinterDpi` from Task 1.
- Produces:

```ts
// box-printing.ts
export interface BoxPrintInput {
  template: LabelTemplateSpec | null;
  fields: Record<string, string>;
  printing: {
    target: PrintTarget;
    language: PrinterLanguage;
    /** Omitted or null = legacy settings: the label prints at its authoring dpi. */
    dpi?: PrinterDpi | null;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  render: (
    template: LabelTemplateSpec,
    fields: Record<string, string>,
    language: PrinterLanguage,
    dpi: PrinterDpi | null,
  ) => Promise<Uint8Array>;
}
// inventory-box-label.ts
export function renderInventoryBoxLabel(template, input, language, rasterizeText, dpi: PrinterDpi | null = null): Promise<Uint8Array>;
// inventory-box-printing.ts
export interface InventoryBoxPrintingTransport { target; language; dpi?: PrinterDpi | null; print }
```

`dpi` is OPTIONAL on the transport objects so the 29 existing test fixtures that build `{ target, language, print }` keep compiling; production callers (App.tsx) always pass it.

- [ ] **Step 1: Write the failing tests**

In `apps/station/test/box-printing.test.ts` change `configuredInput()` to include the resolution:

```ts
function configuredInput(): BoxPrintInput {
  return {
    template: BOX_TEMPLATE,
    fields: { sscc: "046012345600007778" },
    printing: {
      target: PRINT_TARGET,
      language: "zpl",
      dpi: 300,
      print: vi.fn(async () => {}),
    },
    render: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
}
```

and append inside `describe("attemptBoxPrint", ...)`:

```ts
  it("hands the printer's resolution to the renderer", async () => {
    const input = configuredInput();

    await attemptBoxPrint(input);
    expect(input.render).toHaveBeenCalledWith(
      BOX_TEMPLATE,
      { sscc: "046012345600007778" },
      "zpl",
      300,
    );
  });

  it("passes null through for legacy settings without a resolution", async () => {
    const input = configuredInput();
    // A transport saved before the resolution setting existed carries no `dpi`.
    const legacyPrinting = { target: PRINT_TARGET, language: "zpl" as const, print: vi.fn(async () => {}) };

    await attemptBoxPrint({ ...input, printing: legacyPrinting });
    expect(input.render).toHaveBeenCalledWith(
      BOX_TEMPLATE,
      { sscc: "046012345600007778" },
      "zpl",
      null,
    );
  });
```

In `apps/station/test/inventory-box-label.test.ts` append inside `describe("inventory box label", ...)`:

```ts
  it("prints at the attached printer's resolution when one is configured", async () => {
    const rasterize = vi.fn(async () => raster);
    const zpl = await renderInventoryBoxLabel(SPEC, INPUT, "zpl", rasterize, 300);
    const text = new TextDecoder("latin1").decode(zpl);
    // 58×40 mm at 300 dpi; the same spec at 203 dpi opens with ^PW464/^LL320.
    expect(text).toContain("^PW685");
    expect(text).toContain("^LL472");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run test/box-printing.test.ts test/inventory-box-label.test.ts`
Expected: FAIL — `render` is called with three arguments; `renderInventoryBoxLabel` ignores the fifth argument and emits `^PW464`.

- [ ] **Step 3: Implement**

Replace `apps/station/src/lib/box-printing.ts` entirely with:

```ts
import type { LabelTemplateSpec, PrinterDpi } from "@markiro/domain";
import type { BoxPrintErrorCode } from "./boxes.js";
import type { PrintTarget } from "./hardware.js";
import type { PrinterLanguage } from "./hardware-config.js";

export type BoxPrintAttempt =
  { kind: "printed"; bytes: Uint8Array } | { kind: "failed"; code: BoxPrintErrorCode };

export interface BoxPrintInput {
  template: LabelTemplateSpec | null;
  fields: Record<string, string>;
  printing: {
    target: PrintTarget;
    language: PrinterLanguage;
    /**
     * The attached printer's resolution. Omitted or null = the workstation
     * was configured before the setting existed: the label prints at its
     * authoring dpi, exactly as before (spec 2026-09-10).
     */
    dpi?: PrinterDpi | null;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  render: (
    template: LabelTemplateSpec,
    fields: Record<string, string>,
    language: PrinterLanguage,
    dpi: PrinterDpi | null,
  ) => Promise<Uint8Array>;
}

export async function attemptBoxPrint(input: BoxPrintInput): Promise<BoxPrintAttempt> {
  if (!input.template) return { kind: "failed", code: "template_missing" };
  if (!input.printing) return { kind: "failed", code: "printer_unconfigured" };

  let bytes: Uint8Array;
  try {
    bytes = await input.render(
      input.template,
      input.fields,
      input.printing.language,
      input.printing.dpi ?? null,
    );
  } catch {
    console.error("station: box label render failed");
    return { kind: "failed", code: "render_failed" };
  }

  try {
    await input.printing.print(input.printing.target, bytes);
  } catch {
    console.error("station: box label transport failed");
    return { kind: "failed", code: "transport_failed" };
  }

  return { kind: "printed", bytes };
}
```

In `apps/station/src/lib/inventory-box-label.ts` add `type PrinterDpi,` to the `@markiro/domain` import (alphabetical, after `type LabelTemplateSpec,`) and replace `renderInventoryBoxLabel` with:

```ts
export function renderInventoryBoxLabel(
  template: LabelTemplateSpec,
  input: InventoryBoxLabelInput,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
  dpi: PrinterDpi | null = null,
): Promise<Uint8Array> {
  return renderLabelBytes(template, inventoryBoxLabelFields(input), language, rasterizeText, {
    dpi,
  });
}
```

In `apps/station/src/lib/inventory-box-printing.ts`:
- add `type PrinterDpi,` to the `@markiro/domain` import (after `type LabelTemplateSpec,`);
- replace `InventoryBoxPrintingTransport` with

```ts
export interface InventoryBoxPrintingTransport {
  target: PrintTarget;
  language: PrinterLanguage;
  /** Omitted or null = legacy settings: labels print at their authoring dpi. */
  dpi?: PrinterDpi | null;
  print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
}
```

- replace the `render?:` member of `AttemptInventoryBoxPrintInput` with

```ts
  render?: (
    template: LabelTemplateSpec,
    fields: Record<LabelField, string>,
    language: PrinterLanguage,
    dpi: PrinterDpi | null,
  ) => Promise<Uint8Array>;
```

- replace the default renderer inside `attemptInventoryBoxPrint`

```ts
  const render =
    input.render ??
    ((
      template: LabelTemplateSpec,
      _fields: Record<LabelField, string>,
      language: PrinterLanguage,
    ) =>
      renderInventoryBoxLabel(
        template,
        labelInput(input.manifest, row),
        language,
        input.rasterizeText ?? rasterizeText,
      ));
```

with

```ts
  const render =
    input.render ??
    ((
      template: LabelTemplateSpec,
      _fields: Record<LabelField, string>,
      language: PrinterLanguage,
      dpi: PrinterDpi | null,
    ) =>
      renderInventoryBoxLabel(
        template,
        labelInput(input.manifest, row),
        language,
        input.rasterizeText ?? rasterizeText,
        dpi,
      ));
```

In `apps/station/src/pages/WorkScreen.tsx` add `type PrinterDpi` to the existing `@markiro/domain` type imports, replace the `printing?:` prop with

```ts
  /** Where and how to render + send a box label. Omit to skip printing (e.g. no printer configured). */
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    /** The attached printer's resolution; null for settings saved before the field existed. */
    dpi?: PrinterDpi | null;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
```

and replace

```ts
      render: (template, fields, language) =>
        renderLabelBytes(template, fields, language, rasterizeText),
```

with

```ts
      render: (template, fields, language, dpi) =>
        renderLabelBytes(template, fields, language, rasterizeText, { dpi }),
```

In `apps/station/src/App.tsx` replace BOTH occurrences of

```tsx
                      target: hardwareConfig.printer,
                      language: hardwareConfig.printerLanguage,
                      print: (target, bytes) => tauriHardware.print(target, bytes),
```

(one indented two levels deeper than the other) with the same lines plus the resolution:

```tsx
                      target: hardwareConfig.printer,
                      language: hardwareConfig.printerLanguage,
                      dpi: hardwareConfig.printerDpi ?? null,
                      print: (target, bytes) => tauriHardware.print(target, bytes),
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @markiro/station exec vitest run test/box-printing.test.ts test/inventory-box-label.test.ts test/inventory-box-printing.test.ts test/work-screen.test.tsx test/inventory-repack-print-recovery.test.tsx`
Expected: PASS.
Run: `pnpm --filter @markiro/station typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/box-printing.ts apps/station/src/lib/inventory-box-label.ts apps/station/src/lib/inventory-box-printing.ts apps/station/src/pages/WorkScreen.tsx apps/station/src/App.tsx apps/station/test/box-printing.test.ts apps/station/test/inventory-box-label.test.ts
git commit -m "feat(station): print box labels at the configured printer resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Workstation setup — test print at printer dpi, hint under the resolution select

**Files:**
- Modify: `apps/station/src/pages/WorkstationSetup.tsx` (the `renderLabelBytes(...)` call in `testPrint`, lines 289–294)
- Modify: `apps/station/src/ui/setup/PrinterSetupPanel.tsx` (the `<Select ... label={t("setup.printerResolution")} .../>` block, lines 201–214)
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (the `setup` object, after `printerResolutionUnknown`)
- Test: `apps/station/test/workstation-setup.test.tsx`

**Interfaces:**
- Consumes: `renderLabelBytes(..., { dpi })` (Task 5).
- Produces: i18n key `setup.printerDpiHint`.

- [ ] **Step 1: Write the failing test**

Append to the `describe` in `apps/station/test/workstation-setup.test.tsx` that contains `it("prints a barcode test label and verifies the scanned label against it", ...)` (same helpers `hardware`, `noopExec`, `selectSetupTab` are in scope):

```ts
  it("prints the test label at the configured printer resolution", async () => {
    const printed: Uint8Array[] = [];
    const hw = hardware({
      print: async (_target, bytes) => {
        printed.push(bytes);
      },
    });
    render(
      <WorkstationSetup
        hw={hw}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM9" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Printer resolution" }), {
      target: { value: "300" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() => expect(printed).toHaveLength(1));
    // 58×40 mm at 300 dpi; a 203 dpi print would open with ^PW464.
    expect(new TextDecoder().decode(printed[0])).toContain("^PW685");
    expect(
      screen.getByText(
        "Every label prints at this resolution. Until it is set, box labels print at the template's resolution and duplicate printing is unavailable.",
      ),
    ).toBeDefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run test/workstation-setup.test.tsx -t "configured printer resolution"`
Expected: FAIL — bytes contain `^PW464`; the hint text is not found.

- [ ] **Step 3: Implement**

In `apps/station/src/pages/WorkstationSetup.tsx` replace

```ts
      const bytes = await renderLabelBytes(
        spec,
        sampleLabelData(),
        result.config.printerLanguage,
        rasterizeText,
      );
```

with

```ts
      // The test label prints at the resolution the working labels will use.
      const bytes = await renderLabelBytes(
        spec,
        sampleLabelData(),
        result.config.printerLanguage,
        rasterizeText,
        { dpi: result.config.printerDpi ?? null },
      );
```

In `apps/station/src/ui/setup/PrinterSetupPanel.tsx` add `hint={t("setup.printerDpiHint")}` to the resolution select:

```tsx
          <Select
            size="floor"
            label={t("setup.printerResolution")}
            hint={t("setup.printerDpiHint")}
            value={printerDpi?.toString() ?? ""}
            disabled={disabled || transport === "none"}
            options={[
              { value: "", label: t("setup.printerResolutionUnknown") },
              { value: "203", label: "203 dpi" },
              { value: "300", label: "300 dpi" },
            ]}
            onValueChange={(value) =>
              onPrinterDpiChange?.(value === "203" ? 203 : value === "300" ? 300 : null)
            }
          />
```

In `apps/station/src/i18n/ru.json` replace

```json
    "printerResolution": "Разрешение принтера",
    "printerResolutionUnknown": "Не указано"
```

with

```json
    "printerResolution": "Разрешение принтера",
    "printerResolutionUnknown": "Не указано",
    "printerDpiHint": "Все этикетки печатаются в этом разрешении. Пока оно не указано, коробочные этикетки печатаются в разрешении шаблона, а печать дубликатов недоступна."
```

In `apps/station/src/i18n/en.json` replace

```json
    "printerResolution": "Printer resolution",
    "printerResolutionUnknown": "Not configured"
```

with

```json
    "printerResolution": "Printer resolution",
    "printerResolutionUnknown": "Not configured",
    "printerDpiHint": "Every label prints at this resolution. Until it is set, box labels print at the template's resolution and duplicate printing is unavailable."
```

- [ ] **Step 4: Run the setup tests**

Run: `pnpm --filter @markiro/station exec vitest run test/workstation-setup.test.tsx`
Expected: PASS (all, including the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/pages/WorkstationSetup.tsx apps/station/src/ui/setup/PrinterSetupPanel.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/workstation-setup.test.tsx
git commit -m "feat(station): test print at the printer resolution and explain the setting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Duplicates render at the printer resolution; mismatch checks removed

**Files:**
- Modify: `apps/station/src/lib/product-labels/fields.ts` (`prepareProductLabelAcceptance`)
- Modify: `apps/station/src/lib/product-labels/validation.ts` (the big `if (...)` in `parseProductLabelAcceptance`)
- Modify: `apps/station/src/lib/use-product-label-work.ts` (`canPrint`)
- Test: `apps/station/test/product-labels-fields.test.ts`, `apps/station/test/product-labels-acceptance.test.ts`

**Interfaces:**
- Consumes: `renderLabelBytes(..., { kmDataMatrix, dpi })` (Task 5).
- Produces: `prepareProductLabelAcceptance` throws `DomainError("PRODUCT_LABEL_PRINTER_DPI_REQUIRED")` when `input.printerDpi === null`; otherwise `preparedEvent.dpi === input.printerDpi` and the bytes are rendered at that resolution. `parseProductLabelAcceptance` no longer compares `preparedEvent.dpi` with `policy.snapshot.spec.dpi`.

- [ ] **Step 1: Write the failing tests**

In `apps/station/test/product-labels-fields.test.ts` replace the test

```ts
  it.each([null, 300] as const)(
    "rejects unknown or mismatching printer DPI before rendering: %s",
    ...
  );
```

with:

```ts
  it("requires a configured printer resolution before rendering", async () => {
    const value = { ...input(), printerDpi: null };
    await expect(prepareProductLabelAcceptance(value)).rejects.toMatchObject({
      code: "PRODUCT_LABEL_PRINTER_DPI_REQUIRED",
    });
    expect(value.rasterizeText).not.toHaveBeenCalled();
  });

  it("renders a template authored at 203 dpi at the printer's 300 dpi and records that resolution", async () => {
    const value = { ...input(203), printerDpi: 300 as const };
    const result = await prepareProductLabelAcceptance(value);
    expect(result.policy.snapshot.spec.dpi).toBe(203);
    expect(result.preparedEvent.dpi).toBe(300);
    // 58×40 mm at 300 dpi; the same template on a 203 dpi printer opens with ^PW464.
    expect(Buffer.from(result.bytesBase64, "base64").toString("latin1")).toContain("^PW685");
  });
```

In `apps/station/test/product-labels-acceptance.test.ts` replace the test `it("rejects prepared DPI that differs from the frozen template before writing", ...)` with:

```ts
  it("accepts a prepared resolution that differs from the template's authoring dpi", async () => {
    const input = productLabelAcceptanceFixture();
    // The template snapshot is authored at 203 dpi; the printer is 300.
    const prepared = { ...input, preparedEvent: { ...input.preparedEvent, dpi: 300 as const } };
    await expect(acceptFixture(exec, prepared)).resolves.toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    const stored = await readProductLabelJob(exec, input.credentialOwnership, input.jobId);
    expect(stored?.policy.snapshot.spec.dpi).toBe(203);
    expect(stored?.projection.dpi).toBe(300);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run test/product-labels-fields.test.ts test/product-labels-acceptance.test.ts`
Expected: FAIL — `PRODUCT_LABEL_PRINTER_DPI_MISMATCH` is thrown for both the null and the 300 case; the acceptance is rejected with `PRODUCT_LABEL_ACCEPTANCE_INVALID`.

- [ ] **Step 3: Implement**

In `apps/station/src/lib/product-labels/fields.ts` replace

```ts
  assertDuplicateTemplate(policy.snapshot.spec);
  if (input.printerDpi !== policy.snapshot.spec.dpi)
    throw new DomainError(
      "PRODUCT_LABEL_PRINTER_DPI_MISMATCH",
      "Configure the printer resolution to match the duplicate template",
    );
  const language = z.enum(["zpl", "tspl"]).parse(input.language);
  const km = parseDuplicateKm(input.raw);
  const fields = duplicateLabelFields({
    ...input.labelContext,
    canonicalRaw: km.raw,
    acceptedAt: input.acceptedAt,
  });
  const bytes = await renderLabelBytes(
    policy.snapshot.spec,
    fields,
    language,
    input.rasterizeText,
    { kmDataMatrix: "raster" },
  );
```

with

```ts
  assertDuplicateTemplate(policy.snapshot.spec);
  // A template is resolution-neutral (spec 2026-09-10); what must be known is
  // the PRINTER's resolution, because the bytes below are rendered for it and
  // a reprint replays them only on the same language and dpi.
  const printerDpi = input.printerDpi;
  if (printerDpi === null)
    throw new DomainError(
      "PRODUCT_LABEL_PRINTER_DPI_REQUIRED",
      "Configure the printer resolution before printing duplicates",
    );
  const language = z.enum(["zpl", "tspl"]).parse(input.language);
  const km = parseDuplicateKm(input.raw);
  const fields = duplicateLabelFields({
    ...input.labelContext,
    canonicalRaw: km.raw,
    acceptedAt: input.acceptedAt,
  });
  const bytes = await renderLabelBytes(
    policy.snapshot.spec,
    fields,
    language,
    input.rasterizeText,
    { kmDataMatrix: "raster", dpi: printerDpi },
  );
```

and, in the same function's `preparedEvent`, replace

```ts
      language,
      dpi: policy.snapshot.spec.dpi,
      bytesDigest: productLabelBytesDigest(bytes),
```

with

```ts
      language,
      dpi: printerDpi,
      bytesDigest: productLabelBytesDigest(bytes),
```

In `apps/station/src/lib/product-labels/validation.ts` delete the line

```ts
    preparedEvent.dpi !== policy.snapshot.spec.dpi ||
```

from the `if (...)` chain in `parseProductLabelAcceptance` (the schema already pins `dpi` to 203 or 300; the prepared event records the PRINTER resolution, which may legitimately differ from the template's authoring dpi).

In `apps/station/src/lib/use-product-label-work.ts` replace

```ts
          canPrint: () => {
            const deps = getPrinting();
            return deps.target !== null && deps.dpi === context.policy.snapshot.spec.dpi;
          },
```

with

```ts
          canPrint: () => {
            const deps = getPrinting();
            // Any template prints on any printer; only the printer's own
            // resolution must be known (spec 2026-09-10).
            return deps.target !== null && deps.dpi !== null;
          },
```

- [ ] **Step 4: Run the duplicate suites**

Run: `pnpm --filter @markiro/station exec vitest run test/product-labels-fields.test.ts test/product-labels-acceptance.test.ts test/product-labels-printing.test.ts test/product-label-work-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/product-labels/fields.ts apps/station/src/lib/product-labels/validation.ts apps/station/src/lib/use-product-label-work.ts apps/station/test/product-labels-fields.test.ts apps/station/test/product-labels-acceptance.test.ts
git commit -m "feat(station): print duplicates at the printer resolution instead of matching the template

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Shift start without resolution checks

**Files:**
- Modify: `apps/station/src/pages/NewShift.tsx` (the two `printDpiMismatch` blocks at lines 355–359 and 419–423; the `templateMeta` call at lines 679–683)
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (`shifts.templateMeta`; remove `shifts.printDpiMismatch`)
- Modify: `apps/station/src/dev/StationScreenGallery.tsx` (the two template cards at lines 1275–1292)
- Test: `apps/station/test/new-shift-product-labels.test.tsx`, `apps/station/test/new-shift.test.tsx` (lines 762 and 1007)

**Interfaces:**
- Consumes: nothing new; `hardwareConfig.printerDpi` stays required for duplicates via `shifts.printHardwareRequired`.

- [ ] **Step 1: Write the failing tests**

In `apps/station/test/new-shift-product-labels.test.tsx` replace `it("refuses a mismatched printer DPI before creating the shift", ...)` with:

```ts
it("starts duplicate printing on a 300 dpi printer with a template authored at 203 dpi", async () => {
  const h = await setup({ hardware: { ...hardware, printerDpi: 300 } });
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toEqual([
    {
      path: "/shifts",
      body: expect.objectContaining({
        validationPrint: {
          mode: "duplicate_dm",
          verification: "required",
          templateId: h.fixture.policy.templateId,
        },
      }),
    },
  ]);
  expect(screen.queryByText(/printer resolution does not match/)).toBeNull();
});
```

In `apps/station/test/new-shift.test.tsx` replace

```ts
    expect(screen.getByText("58×40 mm · 203 dpi")).toBeDefined();
```

with

```ts
    expect(screen.getByText("58×40 mm")).toBeDefined();
```

and

```ts
    expect(screen.getByText("58×40 мм · 203 dpi")).toBeDefined();
```

with

```ts
    expect(screen.getByText("58×40 мм")).toBeDefined();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run test/new-shift-product-labels.test.tsx test/new-shift.test.tsx`
Expected: FAIL — the mismatch message blocks the start; the meta line still reads `58×40 mm · 203 dpi`.

- [ ] **Step 3: Implement**

In `apps/station/src/pages/NewShift.tsx` delete this block (inside the duplicate branch of the start handler):

```ts
        if (hardwareConfig.printerDpi !== selected.dpi) {
          setPrinterError(true);
          setError(t("shifts.printDpiMismatch"));
          return;
        }
```

and delete this block (after the authoritative policy check):

```ts
        if (authoritative.data.snapshot.spec.dpi !== hardwareConfig.printerDpi) {
          setPrinterError(true);
          setError(t("shifts.printDpiMismatch"));
          return;
        }
```

Replace

```tsx
                        {t("shifts.templateMeta", {
                          width: option.widthMm,
                          height: option.heightMm,
                          dpi: option.dpi,
                        })}
```

with

```tsx
                        {t("shifts.templateMeta", {
                          width: option.widthMm,
                          height: option.heightMm,
                        })}
```

If, after these deletions, `selected.dpi` / `option.dpi` were the only readers of the `dpi` member on the local `BoxLabelTemplateOption` interface, keep the member (the API still sends it and the strict product-template zod schema requires it) but add the comment `/** Authoring resolution; informational only (spec 2026-09-10). */` above `dpi: number;`.

In `apps/station/src/i18n/ru.json` replace

```json
    "templateMeta": "{{width}}×{{height}} мм · {{dpi}} dpi",
```

with

```json
    "templateMeta": "{{width}}×{{height}} мм",
```

and delete the line

```json
    "printDpiMismatch": "Разрешение принтера не совпадает с шаблоном. Выберите другой шаблон или проверьте настройки принтера.",
```

In `apps/station/src/i18n/en.json` replace

```json
    "templateMeta": "{{width}}×{{height}} mm · {{dpi}} dpi",
```

with

```json
    "templateMeta": "{{width}}×{{height}} mm",
```

and delete the line

```json
    "printDpiMismatch": "The printer resolution does not match the template. Choose another template or check printer settings.",
```

In `apps/station/src/dev/StationScreenGallery.tsx` replace the two card texts:

```tsx
                  {ru ? "Коробка 58×40 (203 dpi)" : "Box 58×40 (203 dpi)"}
```
→
```tsx
                  {ru ? "Коробка 58×40" : "Box 58×40"}
```

```tsx
                  {ru ? "58×40 мм · 203 dpi" : "58×40 mm · 203 dpi"}
```
→
```tsx
                  {ru ? "58×40 мм" : "58×40 mm"}
```

```tsx
                  {ru ? "Паллета 100×80 (300 dpi)" : "Pallet 100×80 (300 dpi)"}
```
→
```tsx
                  {ru ? "Паллета 100×80" : "Pallet 100×80"}
```

```tsx
                  {ru ? "100×80 мм · 300 dpi" : "100×80 mm · 300 dpi"}
```
→
```tsx
                  {ru ? "100×80 мм" : "100×80 mm"}
```

- [ ] **Step 4: Run the shift-start suites and the i18n parity check**

Run: `pnpm --filter @markiro/station exec vitest run test/new-shift-product-labels.test.tsx test/new-shift.test.tsx test/App.test.tsx`
Expected: PASS. Then `grep -rn "printDpiMismatch" apps/station/src apps/station/test` — no output.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/pages/NewShift.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/dev/StationScreenGallery.tsx apps/station/test/new-shift-product-labels.test.tsx apps/station/test/new-shift.test.tsx
git commit -m "feat(station): drop the template resolution checks at shift start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Admin — no resolution badge, preview-resolution select

**Files:**
- Modify: `apps/admin/src/pages/labels/index.tsx` (the badges block: comment at lines 137–139 and the `<Badge>{t("pages.labels.dpiBadge", ...)}</Badge>` at line 147)
- Modify: `apps/admin/src/pages/labels/editor/index.tsx` (the `<Select label={t("pages.labels.editor.dpiLabel")} .../>` at lines 594–601)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/labels-library.test.tsx` (the `it("renders cards from the mocked GET response with name and size/DPI badges", ...)` test), `apps/admin/test/labels-editor.test.tsx` (`chooseOption(user, "DPI", "300")` at line 279 and `chooseOption(userEvent.setup(), "DPI", "300")` at line 1116)

**Interfaces:**
- Produces: i18n keys `pages.labels.editor.previewDpiLabel`, `pages.labels.editor.previewDpiHint`; removes `pages.labels.dpiBadge` and `pages.labels.editor.dpiLabel`. `pages.labels.editor.import.dpiLabel` ("DPI импорта") stays.

- [ ] **Step 1: Update the tests**

In `apps/admin/test/labels-library.test.tsx` replace the badge test with:

```tsx
  it("renders cards from the mocked GET response with name and size badges only", async () => {
    stubFetch([BOX_SUMMARY, UNIT_SUMMARY]);

    renderPage();

    expect(await screen.findByText("Короб 100×100 v3")).toBeDefined();
    expect(screen.getByText("Единица 58×40")).toBeDefined();
    expect(screen.getByText("100.0×100.0 мм")).toBeDefined();
    expect(screen.getByText("58.0×40.0 мм")).toBeDefined();
    // A template is printer-neutral -- it prints on Zebra and TSC alike, at
    // 203 and 300 dpi alike; the station picks both from its own printer
    // (specs 2026-08-20 and 2026-09-10). `language` and `dpi` are still on
    // the summary DTO -- they just must not reach the screen.
    expect(screen.queryByText("203 dpi")).toBeNull();
    expect(screen.queryByText("ZPL")).toBeNull();
    expect(screen.queryByText("TSPL")).toBeNull();
  });
```

In `apps/admin/test/labels-editor.test.tsx` replace both `"DPI"` select labels:

```ts
    await chooseOption(user, "Разрешение предпросмотра", "300");
```

and

```ts
    if (dpi === 300) await chooseOption(userEvent.setup(), "Разрешение предпросмотра", "300");
```

Also rename the test title `"a dpi change round-trips into the spec Save POSTs"` to `"a preview-resolution change round-trips into the spec Save POSTs"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-library.test.tsx test/labels-editor.test.tsx`
Expected: FAIL — `203 dpi` badges are rendered; no select labelled «Разрешение предпросмотра».

- [ ] **Step 3: Implement**

In `apps/admin/src/pages/labels/index.tsx` replace

```tsx
      {/* Size and DPI only: a template has no language of its own -- it
          prints on Zebra and TSC alike and the station picks the language
          from its own printer (spec 2026-08-20), so no card badges one. */}
```

with

```tsx
      {/* Size only: a template has neither a language nor a resolution of
          its own -- it prints on Zebra and TSC, at 203 and 300 dpi alike,
          and the station picks both from its own printer (specs 2026-08-20
          and 2026-09-10), so no card badges either. */}
```

and delete the line

```tsx
        <Badge>{t("pages.labels.dpiBadge", { dpi: item.dpi })}</Badge>
```

In `apps/admin/src/pages/labels/editor/index.tsx` replace

```tsx
          <Select
            label={t("pages.labels.editor.dpiLabel")}
            options={DPI_OPTIONS}
            value={String(spec.dpi)}
            onValueChange={(value) =>
              handleReplaceSpec({ ...spec, dpi: value === "300" ? 300 : 203 })
            }
          />
```

with

```tsx
          <Select
            label={t("pages.labels.editor.previewDpiLabel")}
            hint={t("pages.labels.editor.previewDpiHint")}
            options={DPI_OPTIONS}
            value={String(spec.dpi)}
            onValueChange={(value) =>
              handleReplaceSpec({ ...spec, dpi: value === "300" ? 300 : 203 })
            }
          />
```

In `apps/admin/src/i18n/ru.json`: delete the line `"dpiBadge": "{{dpi}} dpi",` under `pages.labels`; under `pages.labels.editor` replace `"dpiLabel": "DPI",` with

```json
        "previewDpiLabel": "Разрешение предпросмотра",
        "previewDpiHint": "Станция печатает в разрешении своего принтера. Это значение влияет только на предпросмотр и импорт кода.",
```

In `apps/admin/src/i18n/en.json`: delete `"dpiBadge": "{{dpi}} dpi",`; replace `"dpiLabel": "DPI",` (the one directly under `editor`, NOT `editor.import.dpiLabel`) with

```json
        "previewDpiLabel": "Preview resolution",
        "previewDpiHint": "The station prints at its own printer's resolution. This value only affects the preview and code import.",
```

- [ ] **Step 4: Run the admin label suites**

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-library.test.tsx test/labels-editor.test.tsx test/product-label-settings.test.tsx test/org-profile.test.tsx`
Expected: PASS. Then `grep -rn "dpiBadge\|editor.dpiLabel" apps/admin/src` — no output.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/labels/index.tsx apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-library.test.tsx apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): treat template dpi as the preview resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Hardware acceptance checklist

**Files:**
- Modify: `docs/hardware-acceptance-checklist.md` (the "Label output" section, items between "Long product name on the stock 58×40 template" and "All five stock templates, printed once each")

- [ ] **Step 1: Rewrite the resolution items**

Replace the item

```
- [ ] **Long product name on the stock 58×40 template.** Print the seeded
      "Коробка 58×40 (203 dpi)" template with a 40+ character Cyrillic product
      name, on both a Zebra (ZPL) and a TSC (TSPL) printer. Confirm the name
      wraps within the label — nothing runs off the physical edge, and no
      character is silently dropped.
```

with

```
- [ ] **Long product name on the stock 58×40 template.** Print the seeded
      "Коробка 58×40" template with a 40+ character Cyrillic product name, on
      both a Zebra (ZPL) and a TSC (TSPL) printer. Confirm the name wraps
      within the label — nothing runs off the physical edge, and no character
      is silently dropped.
```

Replace the item `**SSCC barcode module width at 300 dpi.**` (all of it) with

```
- [ ] **Printer resolution set on the station; SSCC module at both
      resolutions.** Templates are resolution-neutral (spec 2026-09-10): the
      station prints every template at the resolution configured in its
      printer settings. Set it on a 203 dpi and on a 300 dpi station, print
      the same seeded "Коробка 58×40" on each, and confirm the SSCC module is
      2 dots (0.25 mm) on the 203 and 3 dots (0.254 mm) on the 300 — measure
      with the scanner's decode report, not by eye — and that the whole label
      sits inside the stock. Also print a label at a different module width
      first, then this template, to confirm the emitter is not inheriting a
      stale module-width setting from the previous job.
```

Replace `Print "Коробка 58×40 без дат (203 dpi)" alongside` with `Print "Коробка 58×40 без дат" alongside`.

Replace `On both 58×40 templates (203 and 300 dpi),` with `On the 58×40 template printed at 203 and at 300 dpi,`.

Replace the item `**DPI mismatch has no warning.**` (all of it) with

```
- [ ] **Unset printer resolution falls back to the template.** On a station
      whose printer resolution is "Не указано", close a box and confirm the
      label prints at the template's own (203 dpi) geometry and the setup
      screen shows the hint under the resolution select. Then set the
      resolution and confirm the next label prints at the printer's dpi.
- [ ] **Duplicate Data Matrix at both resolutions.** With a shift printing
      duplicates from the seeded "Дубликат Data Matrix 58×40", accept one
      unit on a 203 dpi and one on a 300 dpi station and scan both labels
      back: the full code must decode on each, and the station must have
      refused to accept a unit while the resolution was unset.
```

Replace `**All five stock templates, printed once each.**` with `**All four stock sizes, printed once each.**`.

- [ ] **Step 2: Check there is no stale name left**

Run: `grep -n "(203 dpi)\|(300 dpi)" docs/hardware-acceptance-checklist.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/hardware-acceptance-checklist.md
git commit -m "docs: hardware acceptance items for resolution-neutral templates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Full verification and PR 1

- [ ] **Step 1: Format touched files**

```bash
pnpm exec prettier --write packages/domain/src packages/domain/test apps/station/src apps/station/test apps/admin/src apps/admin/test apps/api/src apps/api/test
```

Commit only if it changed something: `git add -A packages/domain apps/station apps/admin apps/api && git commit -m "style: prettier"` (with the Co-Authored-By trailer).

- [ ] **Step 2: Repository gate**

```bash
pnpm turbo lint typecheck test build --concurrency=1
pnpm format:check
```

Expected: all green. If an API or DB e2e file skips for lack of `DATABASE_URL`, report which files skipped.

- [ ] **Step 3: Rebase and push**

```bash
git fetch origin && git rebase origin/main
git push -u origin claude/label-templates-dpi-unification-e068d8
```

- [ ] **Step 4: Open PR 1**

Title: `feat(labels): one template for 203 and 300 dpi — the station prints at its printer's resolution`

Body (fenced so the Run button does not swallow it):

```
## Что
Шаблон этикетки становится нейтральным к разрешению: `spec.dpi` — разрешение авторинга (предпросмотр, импорт), станция печатает любой шаблон в разрешении своего принтера (`withPrinterDpi`). Стоковый набор новых тенантов: 16 коробочных + 1 дубликат без суффикса dpi. Проверки «разрешение принтера не совпадает с шаблоном» удалены; у коробок закрыт латентный дефект печати не в том масштабе.

## Совместимость
Схема БД, DTO и снимки не меняются. Станции без указанного DPI печатают коробки как раньше. Миграция существующих стоковых пар — отдельный PR после обновления станций (spec, «Совместимость и порядок выката»).

Spec: docs/superpowers/specs/2026-09-10-dpi-neutral-label-templates-design.md
Plan: docs/superpowers/plans/2026-09-10-dpi-neutral-label-templates.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

After pushing, confirm CI actually started for the new SHA (`gh api repos/{owner}/{repo}/commits/<sha>/check-runs`); a PR that shows old green checks is not verified.

---

## PR 2 — data (after PR 1's station release is installed on every 300 dpi workstation)

### Task 13: Migration 0123 — rename stock rows, disable untouched 300 twins

**Files:**
- Create: `packages/db/migrations/0123_dpi_neutral_stock_label_templates.sql` (generated — see Step 3)
- Modify: `packages/db/migrations/meta/_journal.json` (append an entry)
- Create: `packages/db/test/dpi-neutral-stock-label-templates-migration.test.ts`
- Modify: `packages/domain/test/labels-defaults.test.ts` (append a drift guard)

**Interfaces:**
- Consumes: `buildLegacyDatedBoxLabelTemplates`, `buildLegacyDateFreeBoxLabelTemplates`, `buildLegacyPrintNameBoxLabelTemplates`, `buildLegacyDuplicateLabelTemplates` (Task 3), `inlinedRows` helper already present in `labels-defaults.test.ts`.
- Produces: migration 0123 with two statements — rename table (17 triples `(old_name, new_name, purpose)`) and twin-disable table (5 pairs `(name, '<compact json>')`, cast to jsonb in the `WHERE`, exactly the row format of 0053/0056/0059 so the existing `inlinedRows` parser reads it).

Preconditions: branch from `origin/main` AFTER PR 1 is merged (`git checkout -b claude/label-templates-dpi-migration origin/main`), `CI=true pnpm install`, `pnpm --filter @markiro/domain build`. If `origin/main` already contains a migration with index 0123, use the next free index everywhere below (file name, journal `idx`/`tag`, test file and drift-guard file name) and a `when` greater than the last journal entry's.

- [ ] **Step 1: Write the failing DB test**

Create `packages/db/test/dpi-neutral-stock-label-templates-migration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyDuplicateLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
} from "@markiro/domain";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION = "0123_dpi_neutral_stock_label_templates.sql";

function legacySpec(name: string): unknown {
  const row = [
    ...buildLegacyDatedBoxLabelTemplates(),
    ...buildLegacyDateFreeBoxLabelTemplates(),
    ...buildLegacyPrintNameBoxLabelTemplates(),
    ...buildLegacyDuplicateLabelTemplates(),
  ].find((t) => t.name === name);
  if (!row) throw new Error(`no legacy stock template named ${name}`);
  return row.spec;
}

describe.skipIf(!databaseUrl)("dpi-neutral stock label templates migration", () => {
  const name = `markiro_dpi_neutral_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
  });

  it("renames the 203 stock rows, disables only untouched and unreferenced 300 twins, and is idempotent", async () => {
    const tenant = randomUUID();
    await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
      tenant,
    ]);
    const ids = {
      dated203: randomUUID(),
      dated300: randomUUID(),
      dateFree300OrgDefault: randomUUID(),
      printName300ProductDefault: randomUUID(),
      printNameDateFree300CategoryDefault: randomUUID(),
      duplicate203: randomUUID(),
      duplicate300Custom: randomUUID(),
      custom: randomUUID(),
    };
    const rows: Array<[string, string, string, unknown]> = [
      [ids.dated203, "Коробка 58×40 (203 dpi)", "box", { edited: true }],
      [ids.dated300, "Коробка 58×40 (300 dpi)", "box", legacySpec("Коробка 58×40 (300 dpi)")],
      [
        ids.dateFree300OrgDefault,
        "Коробка 58×40 без дат (300 dpi)",
        "box",
        legacySpec("Коробка 58×40 без дат (300 dpi)"),
      ],
      [
        ids.printName300ProductDefault,
        "Коробка 58×40 (300 dpi) [Назв. для печати]",
        "box",
        legacySpec("Коробка 58×40 (300 dpi) [Назв. для печати]"),
      ],
      [
        ids.printNameDateFree300CategoryDefault,
        "Коробка 58×40 без дат (300 dpi) [Назв. для печати]",
        "box",
        legacySpec("Коробка 58×40 без дат (300 dpi) [Назв. для печати]"),
      ],
      [
        ids.duplicate203,
        "Дубликат Data Matrix 58×40 (203 dpi)",
        "product_duplicate",
        legacySpec("Дубликат Data Matrix 58×40 (203 dpi)"),
      ],
      [
        ids.duplicate300Custom,
        "Дубликат Data Matrix 58×40 (300 dpi)",
        "product_duplicate",
        { ...(legacySpec("Дубликат Data Matrix 58×40 (300 dpi)") as object), widthMm: 60 },
      ],
      [ids.custom, "Своя этикетка", "box", { custom: true }],
    ];
    for (const [id, rowName, purpose, spec] of rows) {
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,$4,$5::jsonb,true)",
        [id, tenant, rowName, purpose, JSON.stringify(spec)],
      );
    }
    await pool.query(
      "INSERT INTO org_profiles(tenant_id,default_box_label_template_id) VALUES($1,$2)",
      [tenant, ids.dateFree300OrgDefault],
    );
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name,default_label_template_id) VALUES($1,$2,'04600000000015','Пиво',$3)",
      [randomUUID(), tenant, ids.printName300ProductDefault],
    );
    await pool.query(
      "INSERT INTO org_box_label_template_defaults(tenant_id,chz_product_group_code,template_id) VALUES($1,15,$2)",
      [tenant, ids.printNameDateFree300CategoryDefault],
    );

    const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    await pool.query(sql);
    const snapshot = async () =>
      (
        await pool.query<{ id: string; name: string; enabled: boolean; spec: unknown }>(
          "SELECT id,name,enabled,spec FROM label_templates WHERE tenant_id=$1 ORDER BY name",
          [tenant],
        )
      ).rows;
    const first = await snapshot();
    const byId = new Map(first.map((row) => [row.id, row]));

    expect(byId.get(ids.dated203)).toMatchObject({
      name: "Коробка 58×40",
      enabled: true,
      spec: { edited: true },
    });
    expect(byId.get(ids.duplicate203)).toMatchObject({
      name: "Дубликат Data Matrix 58×40",
      enabled: true,
    });
    expect(byId.get(ids.dated300)).toMatchObject({
      name: "Коробка 58×40 (300 dpi)",
      enabled: false,
    });
    expect(byId.get(ids.dateFree300OrgDefault)).toMatchObject({
      name: "Коробка 58×40 без дат (300 dpi)",
      enabled: true,
    });
    expect(byId.get(ids.printName300ProductDefault)).toMatchObject({
      name: "Коробка 58×40 (300 dpi) [Назв. для печати]",
      enabled: true,
    });
    expect(byId.get(ids.printNameDateFree300CategoryDefault)).toMatchObject({
      name: "Коробка 58×40 без дат (300 dpi) [Назв. для печати]",
      enabled: true,
    });
    expect(byId.get(ids.duplicate300Custom)).toMatchObject({
      name: "Дубликат Data Matrix 58×40 (300 dpi)",
      enabled: true,
      spec: expect.objectContaining({ widthMm: 60 }),
    });
    expect(byId.get(ids.custom)).toMatchObject({
      name: "Своя этикетка",
      enabled: true,
      spec: { custom: true },
    });

    await pool.query(sql);
    expect(await snapshot()).toEqual(first);
  });
});
```

- [ ] **Step 2: Write the failing domain drift guard**

Append inside the `describe` that holds the other drift guards in `packages/domain/test/labels-defaults.test.ts` (add `buildLegacyDuplicateLabelTemplates` to the import list first):

```ts
  /**
   * Migration 0123 (spec 2026-09-10) renames the 203 stock rows and disables
   * the untouched 300 twins by exact jsonb match. Both tables are generated
   * from the legacy builders; whoever changes them regenerates the SQL.
   */
  it("matches the rename table and the twin jsonb inlined into db migration 0123 (drift guard)", async () => {
    const legacy = [
      ...buildLegacyDatedBoxLabelTemplates(),
      ...buildLegacyDateFreeBoxLabelTemplates(),
      ...buildLegacyPrintNameBoxLabelTemplates(),
      ...buildLegacyDuplicateLabelTemplates(),
    ];
    const file = "0123_dpi_neutral_stock_label_templates.sql";
    expect(await inlinedRows(file)).toEqual(
      legacy.filter((t) => t.renamedTo === null).map((t) => ({ name: t.name, spec: t.spec })),
    );
    const sql = await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8");
    const renames = [...sql.matchAll(/\('([^']+)', '([^']+)', '(box|product_duplicate)'\)/g)].map(
      (m) => [m[1], m[2], m[3]],
    );
    expect(renames).toEqual(
      legacy
        .filter((t) => t.renamedTo !== null)
        .map((t) => [
          t.name,
          t.renamedTo,
          t.name.startsWith("Дубликат") ? "product_duplicate" : "box",
        ]),
    );
  });
```

- [ ] **Step 3: Generate the migration and register it**

Write the generator to a temp file and run it (heredoc with a quoted delimiter so nothing is interpolated):

```bash
cat > "$TMPDIR/gen-0123.mjs" <<'EOF'
import { writeFileSync } from "node:fs";
import {
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyDuplicateLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
} from "./packages/domain/dist/index.js";

const boxes = [
  ...buildLegacyDatedBoxLabelTemplates(),
  ...buildLegacyDateFreeBoxLabelTemplates(),
  ...buildLegacyPrintNameBoxLabelTemplates(),
].map((t) => ({ ...t, purpose: "box" }));
const duplicates = buildLegacyDuplicateLabelTemplates().map((t) => ({
  ...t,
  purpose: "product_duplicate",
}));
const all = [...boxes, ...duplicates];

const renames = all
  .filter((t) => t.renamedTo !== null)
  .map((t) => `  ('${t.name}', '${t.renamedTo}', '${t.purpose}')`)
  .join(",\n");
// Compact JSON on one line per row, like 0053/0056/0059: the domain drift
// guard's `inlinedRows` parser expects exactly `('name', '{...}')`.
const twins = all
  .filter((t) => t.renamedTo === null)
  .map((t) => `  ('${t.name}', '${JSON.stringify(t.spec)}')`)
  .join(",\n");

const sql = `-- Label templates are resolution-neutral since spec 2026-09-10: the station
-- prints every template at its own printer's dpi. Stock names drop the dpi
-- suffix, and the untouched 58×40 @300 twins are disabled — never deleted,
-- because shift and inventory snapshots reference them. A twin that is an
-- organisation, category or product default stays enabled under its old name,
-- exactly as the API refuses to disable a default. Custom layouts (spec differs
-- from the seed) are left alone. Idempotent: a second run matches nothing.
-- Generated from the legacy builders in @markiro/domain (drift guard in
-- packages/domain/test/labels-defaults.test.ts).
UPDATE "label_templates" AS t
SET "name" = renamed.new_name, "updated_at" = now()
FROM (VALUES
${renames}
) AS renamed(old_name, new_name, purpose)
WHERE t."name" = renamed.old_name
  AND t."purpose" = renamed.purpose;
--> statement-breakpoint
UPDATE "label_templates" AS t
SET "enabled" = false, "updated_at" = now()
FROM (VALUES
${twins}
) AS twin(name, spec)
WHERE t."name" = twin.name
  AND t."spec" = twin.spec::jsonb
  AND t."enabled"
  AND NOT EXISTS (
    SELECT 1 FROM "org_profiles" p
    WHERE p."tenant_id" = t."tenant_id" AND p."default_box_label_template_id" = t."id")
  AND NOT EXISTS (
    SELECT 1 FROM "org_box_label_template_defaults" d
    WHERE d."tenant_id" = t."tenant_id" AND d."template_id" = t."id")
  AND NOT EXISTS (
    SELECT 1 FROM "products" pr
    WHERE pr."tenant_id" = t."tenant_id" AND pr."default_label_template_id" = t."id");
`;
writeFileSync("packages/db/migrations/0123_dpi_neutral_stock_label_templates.sql", sql);
console.log("wrote 0123:", all.filter((t) => t.renamedTo !== null).length, "renames,", all.filter((t) => t.renamedTo === null).length, "twins");
EOF
node "$TMPDIR/gen-0123.mjs"
```

Expected output: `wrote 0123: 17 renames, 5 twins`.

Append to the `entries` array in `packages/db/migrations/meta/_journal.json` (after the `0122_watery_molten_man` entry, comma-separated):

```json
    {
      "idx": 123,
      "version": "7",
      "when": 1789000000000,
      "tag": "0123_dpi_neutral_stock_label_templates",
      "breakpoints": true
    }
```

(`when` must exceed the previous entry's `1788925596383`; data-only migrations in this repo carry no `meta/0123_snapshot.json`, like 0114 and 0115.)

- [ ] **Step 4: Run the guard and the migration test**

Run: `pnpm --filter @markiro/domain exec vitest run test/labels-defaults.test.ts`
Expected: PASS, including the 0123 drift guard.

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/db exec vitest run test/dpi-neutral-stock-label-templates-migration.test.ts`
Expected: PASS with `DATABASE_URL` set (skipped otherwise — report it).

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0123_dpi_neutral_stock_label_templates.sql packages/db/migrations/meta/_journal.json packages/db/test/dpi-neutral-stock-label-templates-migration.test.ts packages/domain/test/labels-defaults.test.ts
git commit -m "feat(db): collapse the stock 203/300 dpi label template pairs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Verification and PR 2

- [ ] **Step 1: Repository gate**

```bash
pnpm turbo lint typecheck test build --concurrency=1
pnpm format:check
```

Expected: green (DB test needs `DATABASE_URL`).

- [ ] **Step 2: Push and open PR 2**

```bash
git push -u origin claude/label-templates-dpi-migration
```

Title: `feat(db): collapse the stock 203/300 dpi label template pairs`

Body:

```
## Что
Миграция 0123: стоковые шаблоны получают имена без суффикса dpi (17 переименований), нетронутые 58×40 @300-близнецы отключаются (5), кроме назначенных дефолтом организации, категории или товара. Ничего не удаляется. Идемпотентна.

## Условие мержа
Только после того, как релиз станции из PR 1 установлен на всех рабочих местах с 300 dpi принтером: старая станция после отключения близнецов печатала бы коробки в 203 точках.

Spec: docs/superpowers/specs/2026-09-10-dpi-neutral-label-templates-design.md
Plan: docs/superpowers/plans/2026-09-10-dpi-neutral-label-templates.md, tasks 13–14

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Record the rollout condition**

In the PR 2 description keep the merge condition at the top; when merging, note in the PR which station release version was confirmed installed.
