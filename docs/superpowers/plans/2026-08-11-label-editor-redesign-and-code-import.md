# Label Editor Redesign and Code Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Admin label editor fit ordinary desktop viewports, keep all editable element bounds inside the label, and safely replace a composition by importing a supported ZPL or TSPL source subset with Markiro field placeholders.

**Architecture:** Add deterministic, framework-independent ZPL/TSPL subset parsers to `@markiro/domain`, then apply Admin-only rendered-bounds fitting before editor mutations or import confirmation. Split the Admin work into pure geometry, a bounded CSS Grid shell, and a controlled import dialog whose checked result becomes stale after any source option changes and replaces the spec atomically only after explicit confirmation.

**Tech Stack:** TypeScript 6, React 19, React Router 8, i18next, Vitest 4, Testing Library, vanilla CSS, `@markiro/domain`, `@markiro/ui`.

**Source specification:** `docs/superpowers/specs/2026-08-11-label-editor-redesign-and-code-import-design.md`

## Global Constraints

- Preserve the existing `LabelTemplateSpec` persistence schema, Admin API requests, client-side preview, ZPL/TSPL download path, template name, undo/redo semantics, RU/EN localization, and light/dark themes.
- Keep the page within its route viewport: no page-level horizontal scroll; the workspace may scroll when a physical canvas itself is larger than its available region.
- Use a labelled palette, a `minmax(0, 1fr)` workspace, and a collapsible 320 px properties panel whose controls never overflow horizontally.
- Keep the complete rendered bounds of text, fields, barcodes, lines, and boxes inside the label for drag, keyboard, property, geometry, add, resize, and import entry points.
- Reject a size or geometry change when an element is physically larger than the label; never silently resize content.
- Import replaces the composition only after a fresh successful check and explicit confirmation; cancel and failures preserve the complete current editor state.
- Report every unsupported source line; never preserve unsupported code invisibly. Require explicit acknowledgement before discarding unsupported lines.
- Support only the ZPL/TSPL grammar in the specification; do not add a generic parser, evaluator, code editor package, or dependency.
- Limit import input to 256 KiB, 2,000 parsed commands, and 1,000 resulting elements.
- Treat TSC as the printer family and show the code language as `TSPL (TSC)` where clarification is needed.
- Use the existing IBM Plex fonts, design tokens, `@markiro/ui` controls, visible focus, semantic status/error regions, and matching RU/EN copy.
- Use Node 24 or newer and the repository-declared pnpm 11.10.0 through Corepack. Do not alter `pnpm-lock.yaml`.
- Follow strict test-first RED/GREEN cycles and rebuild `@markiro/domain` before Admin consumer tests.
- Automated DOM tests do not count as real-browser, screen-reader, Zebra printer, or TSC printer verification; report those gates separately.

## File and Responsibility Map

- `packages/domain/src/labels/model.ts`: export the canonical `LABEL_FIELDS` inventory for importer and Admin reuse.
- `packages/domain/src/labels/import.ts`: public import types, limits, placeholder decoding, deterministic element IDs, language dispatch, and shared lexical helpers.
- `packages/domain/src/labels/zpl-import.ts`: bounded supported ZPL document parser with source-line warnings.
- `packages/domain/src/labels/tspl-import.ts`: bounded supported TSPL document parser with quoted-argument parsing and source-line warnings.
- `packages/domain/src/index.ts`: public imports for fields, parser, result, warning, and error types.
- `packages/domain/test/labels-import.test.ts`: public dispatcher, limit, placeholder, ZPL, TSPL, error-location, order, and deterministic-ID contract tests.
- `apps/admin/src/pages/labels/editor/geometry.ts`: rendered-bounds containment, move clamping, atomic spec fitting, and impossible-fit results.
- `apps/admin/src/pages/labels/editor/useEditorState.ts`: route every editor mutation through the geometry boundary and retain an inline geometry error.
- `apps/admin/src/pages/labels/editor/Palette.tsx`: visible icon-plus-text actions using the canonical field-independent button definitions.
- `apps/admin/src/pages/labels/editor/PropertiesPanel.tsx`: contained single-column properties form and inline impossible-geometry feedback.
- `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`: controlled source/options, field reference, clipboard feedback, check summary, unsupported acknowledgement, and replacement confirmation.
- `apps/admin/src/pages/labels/editor/editor.css`: bounded toolbar/grid/workspace/palette/properties/import-dialog styles and responsive collapse behavior.
- `apps/admin/src/pages/labels/editor/index.tsx`: compose bounded shell, collapse state, safe label resize, import dialog, and atomic replacement.
- `apps/admin/src/pages/labels/editor/LabelCanvas.tsx`: keep pointer/keyboard events thin while consuming reducer-enforced movement.
- `apps/admin/src/i18n/ru.json`: Russian palette, containment, import, field-copy, analysis, and warning copy.
- `apps/admin/src/i18n/en.json`: matching English copy.
- `apps/admin/test/labels-canvas.test.tsx`: pure geometry and reducer entry-point regression tests.
- `apps/admin/test/labels-editor.test.tsx`: layout semantics, collapse, property errors, resize, import analysis, replacement, copy, and cancellation tests.

---

### Task 1: Establish the public import contract and canonical field inventory

**Files:**

- Create: `packages/domain/src/labels/import.ts`
- Modify: `packages/domain/src/labels/model.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/labels-import.test.ts`

**Interfaces:**

- Produces:

```ts
export const LABEL_FIELDS = [
  "product.name",
  "product.gtin",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "qty",
  "operator",
  "counterparty.name",
] as const;

export const MAX_LABEL_CODE_BYTES = 256 * 1024;
export const MAX_LABEL_CODE_COMMANDS = 2_000;
export const MAX_LABEL_CODE_ELEMENTS = 1_000;
export type LabelCodeLanguage = "zpl" | "tspl";
export type LabelImportWarningCode = "UNSUPPORTED_COMMAND";
export interface LabelImportWarning {
  line: number;
  source: string;
  code: LabelImportWarningCode;
  message: string;
}
export interface LabelImportResult {
  spec: LabelTemplateSpec;
  warnings: LabelImportWarning[];
  sourceLineByElementId: Record<string, number>;
}
export interface ParseLabelCodeOptions {
  language: LabelCodeLanguage;
  dpi: 203 | 300;
}
```

- Internal helpers consumed by Tasks 2-3:

```ts
export function parseTemplatePayload(
  value: string,
  line: number,
): { kind: "field"; field: LabelField } | { kind: "literal"; value: string };
export function importedElementId(language: LabelCodeLanguage, ordinal: number): string;
export function assertImportInputLimits(input: string): void;
```

- Error contract: throw `DomainError` with codes `LABEL_CODE_TOO_LARGE`, `LABEL_CODE_INVALID`, or `LABEL_CODE_LIMIT`; attach `{ line, source }` in `details` for source-specific failures.

- [ ] **Step 1: Write failing canonical inventory and dispatcher tests**

Add imports that do not yet exist and literal assertions independent of implementation:

```ts
import { LABEL_FIELDS, MAX_LABEL_CODE_BYTES } from "../src/index.js";
import { assertImportInputLimits, parseTemplatePayload } from "../src/labels/import.js";

it("exports one canonical ordered label-field inventory", () => {
  expect(LABEL_FIELDS).toEqual([
    "product.name",
    "product.gtin",
    "km.code",
    "sscc",
    "shift.no",
    "date",
    "qty",
    "operator",
    "counterparty.name",
  ]);
});

it("rejects source larger than 256 KiB before language parsing", () => {
  expect(() => assertImportInputLimits("X".repeat(MAX_LABEL_CODE_BYTES + 1))).toThrow(
    expect.objectContaining({ code: "LABEL_CODE_TOO_LARGE" }),
  );
});

it("recognizes only an exact known field placeholder", () => {
  expect(parseTemplatePayload("{{product.name}}", 7)).toEqual({
    kind: "field",
    field: "product.name",
  });
  expect(parseTemplatePayload("Партия", 8)).toEqual({ kind: "literal", value: "Партия" });
});
```

- [ ] **Step 2: Run the focused domain test and verify RED**

Run: `corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts`

Expected: FAIL because `LABEL_FIELDS`, limits, and shared import helpers do not exist.

- [ ] **Step 3: Export fields and implement shared import helpers**

Export the existing field tuple from `model.ts`. In `import.ts`, count UTF-8 bytes with
`new TextEncoder().encode(input).byteLength`, validate placeholders with an anchored
`/^\{\{([^{}]+)\}\}$/`, and reject any remaining `{{` or `}}` syntax as `LABEL_CODE_INVALID`:

```ts
export function importedElementId(language: LabelCodeLanguage, ordinal: number): string {
  return `import-${language}-${ordinal}`;
}
```

Export the canonical inventory and public import types from the package barrel. Keep lexical helpers
internal to the labels import modules; the public `parseLabelCode` dispatcher is added only after
both concrete parsers exist in Task 3.

- [ ] **Step 4: Run focused tests and package typecheck**

Run:

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts
corepack pnpm --filter @markiro/domain typecheck
```

Expected: PASS for inventory, input byte limit, placeholder decoding, invalid placeholder, and
deterministic ID tests.

- [ ] **Step 5: Commit the public contract**

```bash
git add packages/domain/src/labels/model.ts packages/domain/src/labels/import.ts packages/domain/src/index.ts packages/domain/test/labels-import.test.ts
git commit -m "feat(domain): define label code import contract"
```

---

### Task 2: Parse the supported ZPL subset with exact warnings

**Files:**

- Create: `packages/domain/src/labels/zpl-import.ts`
- Modify: `packages/domain/src/labels/import.ts`
- Modify: `packages/domain/test/labels-import.test.ts`

**Interfaces:**

- Consumes: `parseTemplatePayload`, `importedElementId`, command/element limits, `LabelImportResult`, `mmToDots` inverse arithmetic, and `parseLabelTemplate`.
- Produces:

```ts
export function parseZplLabel(input: string, dpi: 203 | 300): LabelImportResult;
```

- Supported command groups: `^XA`, `^XZ`, `^PW`, `^LL`, `^FO`, `^A0N`, `^FB`, `^FD`, `^FS`, `^FH`, `^BCN`, `^BEN`, `^BXN`, `^BQN`, `^GB`.
- `^GB` imports as `line` when width or height is no greater than thickness; otherwise `box`. Every unsupported command becomes one warning with the one-based source line and trimmed source statement.

- [ ] **Step 1: Add failing ZPL text, field, size, and deterministic-order tests**

```ts
it("imports ZPL native text and a field in draw order", () => {
  const result = parseZplLabel(
    [
      "^XA",
      "^PW799",
      "^LL400",
      "^FO80,40^A0N,34,34^FDПартия^FS",
      "^FO80,100^A0N,34,34^FB320,1,0,C,0^FD{{product.name}}^FS",
      "^XZ",
    ].join("\n"),
    203,
  );

  expect(result.spec.widthMm).toBeCloseTo(100, 1);
  expect(result.spec.heightMm).toBeCloseTo(50, 1);
  expect(result.spec.elements).toEqual([
    expect.objectContaining({ id: "import-zpl-1", kind: "text", text: "Партия" }),
    expect.objectContaining({
      id: "import-zpl-2",
      kind: "field",
      field: "product.name",
      align: "center",
    }),
  ]);
  expect(result.sourceLineByElementId).toEqual({ "import-zpl-1": 4, "import-zpl-2": 5 });
});
```

- [ ] **Step 2: Add failing ZPL barcode, line, box, escaping, and unsupported tests**

Use one source document containing `^BCN`, `^BEN`, `^BXN`, `^BQN`, a thin `^GB`, a rectangular
`^GB`, `^FH_^FDHello_5EWorld`, and `^GFA`. Assert the four exact barcode formats and sources, line
endpoints, box dimensions, decoded `Hello^World`, and exactly one warning pointing to the `^GFA`
line. Add blocking cases for missing `^PW`, missing `^LL`, invalid numeric arguments, two `^XA`
documents, unknown `{{warehouse.bin}}`, and more than 1,000 elements.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts`

Expected: FAIL because ZPL parsing is not implemented.

- [ ] **Step 4: Implement a bounded statement scanner and field accumulator**

Scan the original input while retaining one-based line numbers. Split only at recognized `^` command
boundaries outside `^FD` payload handling; stop after 2,000 commands. Maintain a field accumulator:

```ts
interface ZplFieldState {
  line: number;
  xDots: number;
  yDots: number;
  font?: { heightDots: number };
  block?: { widthDots: number; align: "left" | "center" | "right" };
  barcode?: { format: "code128" | "ean13" | "datamatrix" | "qr"; size: number };
  hexIndicator?: string;
  data?: string;
}
```

Finalize only on `^FS`. Convert dots with `dots * 25.4 / dpi`, convert font dots to points with
`dots * 72 / dpi`, parse placeholders after `^FH` decoding, and validate the final spec through
`parseLabelTemplate`. Record the origin line for every element ID.

- [ ] **Step 5: Implement unsupported-command and ambiguity handling**

Recognize framing/size commands without warnings. Emit warnings for commands that are safe to drop
and not interleaved with a supported field. Reject ambiguous changes such as rotation, unsupported
font, or an unknown command inside an otherwise supported field so the parser never guesses the
field semantics.

- [ ] **Step 6: Run the ZPL tests and full domain label tests**

Run:

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts test/labels-model.test.ts test/labels-zpl.test.ts
corepack pnpm --filter @markiro/domain typecheck
```

Expected: PASS with deterministic IDs, source lines, and no hidden unsupported source.

- [ ] **Step 7: Commit ZPL import**

```bash
git add packages/domain/src/labels/import.ts packages/domain/src/labels/zpl-import.ts packages/domain/test/labels-import.test.ts
git commit -m "feat(domain): import editable ZPL labels"
```

---

### Task 3: Parse the supported TSPL subset with quoted arguments

**Files:**

- Create: `packages/domain/src/labels/tspl-import.ts`
- Modify: `packages/domain/src/labels/import.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/labels-import.test.ts`

**Interfaces:**

- Consumes: Task 1 public types/helpers and Task 2 result conventions.
- Produces:

```ts
export function parseTsplLabel(input: string, dpi: 203 | 300): LabelImportResult;
export function parseLabelCode(input: string, options: ParseLabelCodeOptions): LabelImportResult;
```

- Supported statements: `SIZE`, `GAP`, `DIRECTION`, `REFERENCE`, `CLS`, `PRINT`, `TEXT`, `BARCODE`, `DMATRIX`, `QRCODE`, `BAR`, `BOX`.

- [ ] **Step 1: Add failing TSPL text, field, barcode, line, and box tests**

```ts
it("imports the editable TSPL element subset", () => {
  const result = parseTsplLabel(
    [
      "SIZE 100 mm, 50 mm",
      "GAP 2 mm, 0 mm",
      "DIRECTION 1",
      "CLS",
      'TEXT 80,40,"0",0,12,12,"{{product.name}}"',
      'BARCODE 80,100,"128",80,1,0,2,2,"{{sscc}}"',
      'DMATRIX 300,40,4,4,"{{km.code}}"',
      'QRCODE 400,40,M,4,A,0,"https://markiro.app"',
      "BAR 80,220,160,4",
      "BOX 300,220,480,300,4",
      "PRINT 1",
    ].join("\n"),
    203,
  );

  expect(result.spec).toEqual(
    expect.objectContaining({ widthMm: 100, heightMm: 50, dpi: 203, language: "tspl" }),
  );
  expect(result.spec.elements.map((element) => element.kind)).toEqual([
    "field",
    "barcode",
    "barcode",
    "barcode",
    "line",
    "box",
  ]);
  expect(result.warnings).toEqual([]);
});
```

- [ ] **Step 2: Add failing TSPL quoting and error-location tests**

Assert doubled-quote decoding in a literal, commas inside quoted payloads, optional TEXT alignment,
EAN13 parsing, a `BITMAP` warning with its source line, and blocking failures for absent `SIZE`,
font other than `"0"`, non-zero rotation, malformed quoted input, unknown placeholder, invalid
dimensions, multiple `SIZE` statements, more than 2,000 commands, and more than 1,000 elements.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts`

Expected: FAIL because TSPL parsing is not implemented.

- [ ] **Step 4: Implement the line-oriented TSPL parser**

Ignore blank lines, retain original one-based line numbers, and parse CSV-like arguments with a
small state machine that recognizes doubled quotes and never evaluates escapes. Convert element
coordinates from dots and `SIZE` units from `mm` only. Map exact statement variants to the domain
model and preserve source order.

```ts
function splitTsplArguments(source: string, line: number): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  // Append characters, treat "" inside quotes as one literal quote,
  // split commas only outside quotes, and throw LABEL_CODE_INVALID if quoted remains true.
  return result;
}
```

Treat recognized document controls as no-op metadata. Warn for complete unsupported lines such as
`BITMAP`; reject unsupported variants of a recognized editable statement because dropping only
part of an element would be ambiguous.

After both concrete parsers pass their direct tests, add the public dispatcher to `import.ts` and
the package barrel:

```ts
export function parseLabelCode(input: string, options: ParseLabelCodeOptions): LabelImportResult {
  assertImportInputLimits(input);
  return options.language === "zpl"
    ? parseZplLabel(input, options.dpi)
    : parseTsplLabel(input, options.dpi);
}
```

Add one dispatcher test per language and assert each result carries the selected language and DPI.

- [ ] **Step 5: Run import tests and all domain label tests**

Run:

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/labels-import.test.ts test/labels-model.test.ts test/labels-zpl.test.ts test/labels-tspl.test.ts
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain build
```

Expected: PASS and `dist` consumer exports rebuilt locally but not committed.

- [ ] **Step 6: Commit TSPL import**

```bash
git add packages/domain/src/labels/import.ts packages/domain/src/labels/tspl-import.ts packages/domain/src/index.ts packages/domain/test/labels-import.test.ts
git commit -m "feat(domain): import editable TSPL labels"
```

---

### Task 4: Enforce rendered element bounds in every editor mutation

**Files:**

- Create: `apps/admin/src/pages/labels/editor/geometry.ts`
- Modify: `apps/admin/src/pages/labels/editor/useEditorState.ts`
- Modify: `apps/admin/src/pages/labels/editor/index.tsx`
- Modify: `apps/admin/src/pages/labels/editor/PropertiesPanel.tsx`
- Modify: `apps/admin/test/labels-canvas.test.tsx`
- Modify: `apps/admin/test/labels-editor.test.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`

**Interfaces:**

- Produces:

```ts
export type ElementFitFailure = { ok: false; reason: "ELEMENT_TOO_LARGE" };
export type ElementFitSuccess = { ok: true; element: LabelElement; adjusted: boolean };
export type ElementFitResult = ElementFitFailure | ElementFitSuccess;

export function fitElementWithinLabel(
  element: LabelElement,
  spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">,
  data?: Record<LabelField, string>,
): ElementFitResult;

export function fitSpecElements(
  spec: LabelTemplateSpec,
  data?: Record<LabelField, string>,
): { ok: true; spec: LabelTemplateSpec; adjustedIds: string[] } | ElementFitFailure;
```

- Extends `EditorState` with `geometryError: "ELEMENT_TOO_LARGE" | null` and adds `clearGeometryError`.
- `replaceSpec` remains exact for undo/redo and already-reviewed import replacement. New `resizeLabel(widthMm, heightMm)` performs atomic fitting.

- [ ] **Step 1: Add failing pure geometry tests for every element kind**

Create table-driven literals for text, field, Code128, EAN13, DataMatrix, QR, line, and box. For
each, place the rendered bounds past the right/bottom edge and assert `fitElementWithinLabel`
returns exact adjusted coordinates whose independently calculated bounds satisfy:

```ts
expect(bounds.x).toBeGreaterThanOrEqual(0);
expect(bounds.y).toBeGreaterThanOrEqual(0);
expect(bounds.x + bounds.w).toBeLessThanOrEqual(SPEC.widthMm);
expect(bounds.y + bounds.h).toBeLessThanOrEqual(SPEC.heightMm);
```

Add negative-origin cases, a line whose second endpoint is outside, and a box wider than the label
that returns `{ ok: false, reason: "ELEMENT_TOO_LARGE" }` without mutating the input object.

- [ ] **Step 2: Add failing reducer entry-point tests**

Drive the real reducer and assert pointer-equivalent `moveBy`, keyboard-equivalent integer moves,
`setElement` position patches, size/font/line/box geometry patches, `addElement`, and
`resizeLabel` all finish in bounds. Assert an impossible patch/resize leaves the old spec and
history unchanged and sets `geometryError`.

- [ ] **Step 3: Run canvas/editor tests and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/labels-canvas.test.tsx test/labels-editor.test.tsx
```

Expected: FAIL because geometry helpers, reducer errors, and safe resize do not exist.

- [ ] **Step 4: Implement rendered-bounds translation without resizing**

Use `elementBoundsMm` with `sampleLabelData()` by default. If bounds width/height exceeds label
width/height, fail. Otherwise compute the minimum translation that places all four edges inside.
Apply the same translation to `xMm/yMm` and, for a line, `x2Mm/y2Mm`. Recalculate once after the
translation and fail defensively if floating-point tolerance exceeds `1e-9`.

- [ ] **Step 5: Route reducer mutations through one fitting helper**

After building the candidate element for `moveBy`, `setElement`, and `addElement`, fit it before
`withMutatedSpec`. Preserve snapped whole-millimetre movement before clamping. On failure return the
same spec/history/future with only `geometryError` changed. Clear the error on the next successful
mutation or explicit `clearGeometryError`.

Implement `resizeLabel` by creating the target-size spec, calling `fitSpecElements`, and committing
one `withMutatedSpec` only on success. Update preset/custom size handlers to use it rather than raw
`replaceSpec`.

- [ ] **Step 6: Render persistent geometry feedback and verify GREEN**

Pass `geometryError` to `PropertiesPanel`, render a translated `role="alert"`, and clear it when the
selected element changes or the user dismisses it. Run:

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/labels-canvas.test.tsx test/labels-editor.test.tsx
corepack pnpm --filter @markiro/admin typecheck
```

Expected: PASS for every coordinate and geometry entry point.

- [ ] **Step 7: Commit bounds enforcement**

```bash
git add apps/admin/src/pages/labels/editor/geometry.ts apps/admin/src/pages/labels/editor/useEditorState.ts apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/pages/labels/editor/PropertiesPanel.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-canvas.test.tsx apps/admin/test/labels-editor.test.tsx
git commit -m "fix(admin): keep label elements inside canvas"
```

---

### Task 5: Rebuild the editor shell as a bounded labelled workspace

**Files:**

- Create: `apps/admin/src/pages/labels/editor/editor.css`
- Modify: `apps/admin/src/pages/labels/editor/index.tsx`
- Modify: `apps/admin/src/pages/labels/editor/Palette.tsx`
- Modify: `apps/admin/src/pages/labels/editor/PropertiesPanel.tsx`
- Modify: `apps/admin/src/pages/labels/editor/LabelCanvas.tsx`
- Modify: `apps/admin/test/labels-editor.test.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`

**Interfaces:**

- `Palette` retains its existing props and renders visible text for every action.
- `PropertiesPanel` gains `onCollapse` and `geometryError` props. The parent does not render the
  panel while collapsed, so the closed column is zero width; it renders the reopen action adjacent
  to the workspace instead.
- `LabelEditorContent` owns `propertiesCollapsed`; toggling does not call `markDirty`.

- [ ] **Step 1: Add failing visible-label and collapse-state tests**

Render the real editor and assert every palette control's visible text (`Текст`, `Поле`,
`DataMatrix`, `Code 128`, `EAN-13`, `QR`, `Линия`, `Рамка`) rather than only accessible names.
Select a field, collapse properties, assert the panel is absent and an `Открыть свойства` button is
present, reopen it, and assert the same selected field controls return. Change nothing else, click
Back, and assert no dirty confirmation appears.

- [ ] **Step 2: Add failing bounded-shell semantic tests**

Assert the editor root, toolbar, palette, workspace, and properties regions expose stable class
names; the properties region has an accessible heading and no two-column row class on long
controls. These tests pin structure that drives containment without asserting browser-computed CSS.

- [ ] **Step 3: Run editor tests and verify RED**

Run: `corepack pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx`

Expected: FAIL because palette text, collapse control, and bounded classes are absent.

- [ ] **Step 4: Move editor layout styling into `editor.css`**

Use these core rules and responsive equivalents without hardcoded page width arithmetic:

```css
.label-editor {
  display: flex;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  flex-direction: column;
}

.label-editor__body {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) 320px;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.label-editor__body--properties-collapsed {
  grid-template-columns: max-content minmax(0, 1fr);
}

.label-editor__workspace,
.label-editor__properties {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
```

Make the toolbar wrap, palette buttons use consistent icon cells and visible labels, property
controls use one column by default, and coordinate rows use `repeat(2, minmax(0, 1fr))`. Keep canvas
and preview width intrinsic inside the workspace rather than widening the editor root.

- [ ] **Step 5: Implement collapse and visible labelled controls**

Use existing buttons/components, translated labels, `aria-expanded`, and a properties region
heading. Do not add a dependency or clear selection. Keep tool ordering unchanged so existing
operator muscle memory and tests remain stable.

- [ ] **Step 6: Run focused tests, typecheck, and lint**

Run:

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx test/labels-canvas.test.tsx
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
```

Expected: PASS. DOM tests prove semantics; browser fit remains a later gate.

- [ ] **Step 7: Commit the bounded editor shell**

```bash
git add apps/admin/src/pages/labels/editor/editor.css apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/pages/labels/editor/Palette.tsx apps/admin/src/pages/labels/editor/PropertiesPanel.tsx apps/admin/src/pages/labels/editor/LabelCanvas.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): redesign label editor workspace"
```

---

### Task 6: Add checked code import, field reference, and atomic replacement

**Files:**

- Create: `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`
- Modify: `apps/admin/src/pages/labels/editor/editor.css`
- Modify: `apps/admin/src/pages/labels/editor/index.tsx`
- Modify: `apps/admin/src/pages/labels/editor/PropertiesPanel.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/labels-editor.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface ImportCodeDialogProps {
  open: boolean;
  initialLanguage: "zpl" | "tspl";
  initialDpi: 203 | 300;
  currentDirty: boolean;
  onClose: () => void;
  onReplace: (result: LabelImportResult) => void;
}
```

- Consumes: `LABEL_FIELDS`, `parseLabelCode`, `fitSpecElements`, i18n field labels, `Modal`, `Button`, `Select`, `Checkbox`, and existing toast only for transient copy success; parse/import problems remain in the dialog.

- [ ] **Step 1: Add failing field inventory and clipboard tests**

Open Import code and assert all nine placeholders and translated meanings are visible. Click Copy
for `{{product.name}}`, assert `navigator.clipboard.writeText` receives that exact literal and a
polite status appears. Reject the clipboard promise and assert a persistent local error while the
placeholder text remains selectable.

- [ ] **Step 2: Add failing stale-analysis and unsupported acknowledgement tests**

Paste a valid ZPL document containing one supported text command and one `^GFA`. Click Check code;
assert size/count summary, the exact unsupported source line, and a disabled Replace action. Check
`Discard 1 unsupported line`, assert Replace enables, then change DPI and assert the old analysis
and acknowledgement are cleared and Replace disables again.

- [ ] **Step 3: Add failing atomic replacement and cancellation tests**

Start with one existing selected element and a changed template name. Import a valid two-element
TSPL source, confirm replacement, and assert the old element disappears, both imported elements
render, selection is cleared, language becomes TSPL, name is unchanged, and Back opens the dirty
guard. In separate cases assert Cancel, Escape, close, invalid code, unknown placeholder, and an
element larger than the label leave the original canvas, selection, language, name, dirty state,
and history unchanged.

- [ ] **Step 4: Run focused editor tests and verify RED**

Run: `corepack pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx`

Expected: FAIL because the Import action and dialog do not exist.

- [ ] **Step 5: Implement controlled analysis state**

Keep `source`, `language`, `dpi`, `analysis`, `analysisError`, `acknowledgedUnsupported`, and copy
feedback inside the dialog. On any source/language/DPI change set analysis and acknowledgement to
null/false. Check synchronously calls `parseLabelCode`, then `fitSpecElements`; merge positional
adjustments into a translated analysis list using `sourceLineByElementId`. Block impossible fit.

Use the existing `Modal` at `width="min(1120px, calc(100vw - 32px))"` and an import-specific class
for a bounded two-column code/field-reference layout that becomes one column at narrower widths.
The textarea remains a plain controlled `<textarea spellCheck={false}>` using `var(--font-mono)`.

- [ ] **Step 6: Implement explicit replacement and dirty integration**

Enable Replace only when analysis is current, fitting succeeded, and either there are no
unsupported warnings or acknowledgement is checked. Call `onReplace` once with the fitted spec,
then let the parent call `editor.replaceSpec`, `editor.select(null)`, `markDirty`, and close. Preserve
name. The dialog statement about overwriting unsaved work is conditional on `currentDirty` and the
single Replace action is the confirmation.

- [ ] **Step 7: Run focused and package Admin gates**

Rebuild the domain package before consumer tests:

```bash
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx test/labels-canvas.test.tsx
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
```

Expected: PASS with no unhandled promise rejection, accessibility warning, or new canvas warning beyond the existing jsdom limitation.

- [ ] **Step 8: Commit code import UI**

```bash
git add apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx apps/admin/src/pages/labels/editor/editor.css apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/pages/labels/editor/PropertiesPanel.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): import label code into editor"
```

---

### Task 7: Run package, diff, and real-browser acceptance gates

**Files:**

- Modify only if a gate reveals an in-scope defect: files already listed in Tasks 1-6.
- Update evidence checkboxes in: `docs/superpowers/plans/2026-08-11-label-editor-redesign-and-code-import.md`

**Interfaces:**

- Consumes the complete feature.
- Produces verification evidence only; no new feature scope.

- [ ] **Step 1: Run full changed-package automated gates**

```bash
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/admin test
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
corepack pnpm format:check
git diff --check
```

Expected: every command exits 0. Record exact test counts and any intentional skips or jsdom canvas
diagnostics in the final report.

- [ ] **Step 2: Review the complete branch diff and generated-artifact scope**

Run:

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD -- packages/domain/src packages/domain/test apps/admin/src/pages/labels/editor apps/admin/src/i18n apps/admin/test/labels-canvas.test.tsx apps/admin/test/labels-editor.test.tsx
```

Confirm there are no auth-page changes, `.env`, `.pnpm-store`, `dist`, lockfile changes, secrets,
raw label production data, or unsupported hidden-command storage. Confirm every spec requirement
maps to an implementation or an explicitly reported external gate.

- [ ] **Step 3: Run real-browser desktop acceptance**

Start the Admin using the worktree's safe local environment without replacing an existing `.env`
or stopping an unrelated process. At minimum exercise 1366x768, 1440x900, and 1920x1080 in RU and
EN, light and dark:

- toolbar wraps without covering Save/Download/Import;
- all palette labels are visible and focused controls have visible rings;
- page has no horizontal scrollbar;
- properties content fits 320 px, scrolls vertically, collapses/reopens, and preserves selection;
- canvas/preview stay centered and their own workspace scroll is usable;
- dragging every element against all four edges cannot cross the label;
- direct coordinates, geometry changes, and size reduction follow the same containment/errors;
- valid ZPL and TSPL replace atomically;
- unsupported source requires acknowledgement and displays exact lines;
- field placeholder copy and stale-analysis invalidation are visible and understandable.

Capture viewport screenshots or explicitly report why a browser environment was unavailable.

- [ ] **Step 4: Record printer and assistive-technology limits**

Do not print to Zebra/TSC as part of this parser/UI change unless actual hardware is available. State
that automated import/export tests do not verify physical firmware interpretation. Likewise state
whether screen-reader traversal was exercised separately from keyboard/browser checks.

- [ ] **Step 5: Commit only gate-driven corrections and evidence**

If corrections were necessary, repeat their focused RED/GREEN test and commit exact paths. Then
commit the checked plan evidence separately:

```bash
git add docs/superpowers/plans/2026-08-11-label-editor-redesign-and-code-import.md
git commit -m "docs: record label editor implementation verification"
```

Do not create a PR, push, merge, or modify `main` without a separate user request.
